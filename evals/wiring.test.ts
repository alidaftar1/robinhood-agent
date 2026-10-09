import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// WIRING TESTS — does the code CALL the thing, and in the right ORDER?
//
// Why this file exists. Over 2026-10-05→08 the suite had ~1,080 tests and caught ZERO of roughly
// thirteen real defects; every one shipped green, and the tests that now cover them were written
// BY the commits that fixed them. The reason is structural: 2 of 52 eval files touch a route and
// 20 test pure functions, while every one of those defects lived in the WIRING — ordering between
// components, contracts with external state, who-calls-what.
//
// Twice the bug was literally "the library is correct and nothing calls it":
//   · planCapture shipped complete and the autopilot never passed ?capture=1, so it sat inert.
//   · The autopilot gated patchTrades on its OWN symbol-membership rule, so the partial-exit
//     repair it was meant to trigger could never run.
// A unit test cannot see either. These can.
//
// THESE ASSERT SOURCE STRUCTURE, deliberately. That makes them sensitive to refactors — which is
// the point: each one pins a property that a refactor must consciously preserve, and every test
// below says which real incident it is guarding so the next person can tell "I moved this
// legitimately" from "I just re-broke it". If one fails, read the comment before editing the test.
// ─────────────────────────────────────────────────────────────────────────────
const src = (p: string) => readFileSync(`${import.meta.dir}/../${p}`, "utf8");

/** Index of the first match, or -1. Anchors are function names and literals, not whitespace. */
const at = (text: string, needle: string) => text.indexOf(needle);

describe("wiring: ORDER of operations between components", () => {
  test("the autopilot captures broker fills BEFORE patchTrades estimates", () => {
    // 2026-10-07: patchTrades ran first, found the owner's unrecorded buys, withheld the day's
    // return and LOCKED it — and capture then correctly declined on a locked run. The repair that
    // could fix the day was shut out by the one that could not. Ground truth before reconstruction.
    const s = src("app/api/autopilot/route.ts");
    const capture = at(s, "/api/verify?capture=1");
    const patch = at(s, 'callDebug("patchTrades=1")');
    expect(capture).toBeGreaterThan(-1);
    expect(patch).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(patch);
  });

  test("drop-check re-reads the live book BEFORE placing any sell", () => {
    // 2026-10-06: exits were decided from the 07:30 snapshot, so the stop placed an order for an
    // ILMN position the owner had already closed, then recorded the owner's fill as its own.
    const s = src("app/api/drop-check/route.ts");
    expect(at(s, "await fetchLiveState()")).toBeGreaterThan(-1);
    expect(at(s, "await fetchLiveState()")).toBeLessThan(at(s, "runSellSession(sellsToExecute"));
  });

  test("patchTrades recomputes the SLEEVE split from the trades it persists", () => {
    // 2026-10-06: the repair fixed the headline return and left mainDailyReturn computed against
    // the UNREPAIRED trade list — -27.65% for the main sleeve beside a correct +1.12% account.
    // computeSleeveReturns was unit-tested; the route wiring was not, which is why the registry
    // replay still caught this at 70% after the fix shipped.
    const s = src("app/api/debug/route.ts");
    expect(s).toContain("sleevesFor(patchedTrades)");
    expect(s).toMatch(/influencerDailyReturn: null, mainDailyReturn: null/);   // withheld branch too
  });

  test("the trade route checks the book reconciles BEFORE computing a return", () => {
    // 2026-10-08: published +12.63% account / +23.93% main with a -$316 implied transfer, because
    // an unrecorded manual buy made the agent's own sale look like proceeds from nowhere.
    const s = src("app/api/trade/route.ts");
    expect(at(s, "const unreconciled")).toBeLessThan(at(s, "const agenticResult = !unreconciled"));
  });
});

describe("wiring: every capability has a CALLER", () => {
  const routes = readdirSync(`${import.meta.dir}/../app/api`, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => `app/api/${d.name}/route.ts`);
  const allRoutes = routes.map(r => { try { return src(r); } catch { return ""; } }).join("\n");
  const allLib = readdirSync(`${import.meta.dir}/../lib`)
    .filter(f => f.endsWith(".ts"))
    .map(f => src(`lib/${f}`)).join("\n");
  const everywhere = allRoutes + allLib;

  // Each entry is a capability that EXISTS to change production behaviour. A capability with no
  // caller is not "unused code" here — it is a feature the owner believes is running.
  const mustBeCalled: Array<[string, string]> = [
    ["planCapture", "records the owner's manual fills from the broker"],
    ["buildInferredSells", "reconstructs sells the agent never saw"],
    ["recordExits", "the exit-attribution ledger"],
    ["recordSignalPicks", "the entry-signal ledger"],
    ["applyConcentrationTrim", "trims a position that drifted past its cap"],
    ["applyPerPositionCap", "the per-position dollar cap"],
    ["applyRebuyCooldown", "blocks a re-buy of a name just sold"],
    ["computeExitAttribution", "surfaces the exit ledger"],
    ["computeSignalAttribution", "surfaces the signal ledger"],
    ["computeAttribution", "surfaces the influencer ledger"],
  ];

  for (const [fn, why] of mustBeCalled) {
    test(`${fn} is actually called — ${why}`, () => {
      // Count every `name(` then subtract the declaration sites. A lookbehind would read better
      // but needs an es2018 target, which this repo does not set.
      const occurrences = (everywhere.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length;
      const declarations = (everywhere.match(new RegExp(`function\\s+${fn}\\s*\\(`, "g")) ?? []).length;
      expect(occurrences - declarations).toBeGreaterThan(0);
    });
  }

  test("every sell path feeds the exit ledger", () => {
    // Otherwise a whole class of exit is silently missing from the measurement, and the per-trigger
    // averages are computed over a biased subset without anything saying so.
    for (const r of ["app/api/trade/route.ts", "app/api/drop-check/route.ts", "app/api/earnings-exit/route.ts"]) {
      expect(src(r)).toContain("recordExits(");
    }
  });
});

describe("wiring: contracts a writer must honour", () => {
  test("every path that places an order stamps actor:\"agent\"", () => {
    // Provenance cannot be recovered afterwards — a human fill and an agent fill are both
    // state:"filled" with no refPrice — so a path that forgets this is unfixable later.
    for (const r of ["app/api/trade/route.ts", "app/api/drop-check/route.ts", "app/api/earnings-exit/route.ts"]) {
      expect(src(r)).toContain('actor: "agent"');
    }
  });

  test("every caller that CLAIMS a run was saved checks saveRun's result", () => {
    // 2026-10-06: saveRun returned void and swallowed failures, so drop-check emailed
    // "🔴 Risk-Exit Triggered" for a run that was never persisted.
    for (const r of ["app/api/trade/route.ts", "app/api/drop-check/route.ts", "app/api/earnings-exit/route.ts"]) {
      const s = src(r);
      if (!s.includes("saveRun(")) continue;
      expect(s).toMatch(/const saved = await saveRun\(/);
    }
  });

  test("saveRun reports failure rather than returning void", () => {
    expect(src("lib/run-store.ts")).toMatch(/export async function saveRun\([\s\S]*?\): Promise<boolean>/);
  });

  test("the ledgers never treat an unreadable store as empty", () => {
    // read-modify-write on one blob: `[]` on a transient error overwrites the accumulated history.
    for (const f of ["lib/exit-ledger.ts", "lib/signal-ledger.ts"]) {
      expect(src(f)).toMatch(/if \(!res\.ok\) return null;/);
    }
  });

  test("ledger writes use POST /pipeline, never a GET URL", () => {
    // redisCommand encodes the whole blob into the request PATH: past 8KB at ~53 records.
    for (const f of ["lib/exit-ledger.ts", "lib/signal-ledger.ts"]) {
      const s = src(f);
      // Match the CALL, not prose. `toContain("/pipeline")` passed on the comment that explains
      // why /pipeline is used, so the assertion survived the code being changed to a GET URL —
      // found by the registry replay, which is exactly the kind of test it exists to expose.
      expect(s).toMatch(/fetch\(`\$\{url\}\/pipeline`/);
      expect(s).not.toMatch(/redisCommand\(\s*"set"/);
    }
  });
});

describe("wiring: CONTROL — these assertions can fail", () => {
  test("a capability that does not exist is not reported as called", () => {
    // Guards the has-a-caller suite against passing vacuously on a typo'd function name.
    const everywhere = readdirSync(`${import.meta.dir}/../lib`).filter(f => f.endsWith(".ts"))
      .map(f => src(`lib/${f}`)).join("\n");
    const occurrences = (everywhere.match(/\bthisFunctionDoesNotExist\s*\(/g) ?? []).length;
    const declarations = (everywhere.match(/function\s+thisFunctionDoesNotExist\s*\(/g) ?? []).length;
    expect(occurrences - declarations).toBe(0);
  });

  test("the ordering assertions compare real positions, not -1 sentinels", () => {
    const s = src("app/api/autopilot/route.ts");
    expect(at(s, "a-string-that-is-definitely-not-in-this-file")).toBe(-1);
  });
});

// ── Braintrust: does the trace still describe the system? ───────────────────
// The four original scores are all about the BUY decision, written when the agent's decisions were
// mostly buys. It has since grown a position cap, an exit path, a reconciliation layer and trade
// provenance — and a week of work on exits and accounting was invisible in the traces while they
// still looked complete. These pin the scores that cover the rest, so the trace cannot silently
// fall behind the system again without a test saying so.
import { computeDecisionScores } from "../lib/braintrust-trace";

describe("braintrust trace covers more than the buy decision", () => {
  const run = (over: any = {}) => ({
    date: "2026-10-08", timestamp: "2026-10-08T14:30:00Z", summary: "",
    positions: [], trades: [], market: { stocksLoaded: 1, headlinesLoaded: 1 },
    portfolioAfter: { totalValue: "2000", cash: "100", equity: "1900", unsettledCash: "0" },
    agenticDailyReturn: 0.01, ...over,
  }) as any;
  const decision = { thesis: "momentum and quality", buys: [], sells: [] };

  test("a WITHHELD return scores book_reconciled = 0", () => {
    // 2026-10-08 published +12.63% (true -0.25%) from a book that did not add up, and nothing
    // alarmed. The run withholds now, so a null return WITH trades is the signal.
    const s = computeDecisionScores(
      run({ agenticDailyReturn: null, trades: [{ symbol: "MU", side: "sell", quantity: "1", avgPrice: "10", state: "filled", actor: "agent", strategy: "main" }] }),
      decision, "100");
    expect(s.book_reconciled).toBe(0);
  });

  test("a reconciled run scores book_reconciled = 1", () => {
    expect(computeDecisionScores(run(), decision, "100").book_reconciled).toBe(1);
  });

  test("an untagged sell is caught", () => {
    const s = computeDecisionScores(
      run({ trades: [{ symbol: "MU", side: "sell", quantity: "1", avgPrice: "10", state: "filled", actor: "agent" }] }),
      decision, "100");
    expect(s.sells_tagged).toBe(0);
  });

  test("an unattributed trade is caught, but an INFERRED one is exempt", () => {
    // A reconstruction legitimately has no actor — it does not know who placed the order.
    const bad = computeDecisionScores(
      run({ trades: [{ symbol: "MU", side: "sell", quantity: "1", avgPrice: "10", state: "filled", strategy: "main" }] }),
      decision, "100");
    expect(bad.trades_attributed).toBe(0);
    const ok = computeDecisionScores(
      run({ trades: [{ symbol: "MU", side: "sell", quantity: "1", avgPrice: "10", state: "inferred", strategy: "main" }] }),
      decision, "100");
    expect(ok.trades_attributed).toBe(1);
  });

  test("fills_observed is the share of sells that were OBSERVED, not reconstructed", () => {
    const s = computeDecisionScores(
      run({ trades: [
        { symbol: "A", side: "sell", quantity: "1", avgPrice: "10", state: "filled", actor: "agent", strategy: "main" },
        { symbol: "B", side: "sell", quantity: "1", avgPrice: "10", state: "inferred", strategy: "main" },
      ] }), decision, "100");
    expect(s.fills_observed).toBe(0.5);
  });

  test("CONTROL — a run with no sells gets no exit scores, rather than a misleading 1", () => {
    const s = computeDecisionScores(run(), decision, "100");
    expect(s.sells_tagged).toBeUndefined();
    expect(s.fills_observed).toBeUndefined();
  });
});
