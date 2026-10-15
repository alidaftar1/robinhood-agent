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

  test("the imminent-earnings screen is CALLED, and runs BEFORE the position cap", () => {
    // 2026-10-13: "HARD RULE: Never buy a stock marked ⚠⚠ IMMINENT ... No exceptions regardless of
    // momentum" had lived only in prompt strings for as long as the earnings flags existed — the one
    // rule written as absolute was the only one with no enforcement behind it. The skeptical reviewer
    // then credited the non-existent screen, which is how it surfaced. A library alone would not have
    // fixed it (see planCapture above), so pin the CALL.
    //
    // ORDER matters: a buy that cannot execute must not consume one of the 6 main slots on its way to
    // being dropped, which would silently cost the next name its slot.
    const s = src("app/api/trade/route.ts");
    const screen = at(s, "screenImminentEarningsBuys(decision.buys");
    const cap = at(s, "MAIN-BOOK POSITION CAP (buy-side)");
    expect(screen).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(-1);
    expect(screen).toBeLessThan(cap);
    // And it must be fed the ASKED set, not just the date map — passing only dates is the fail-open
    // version that looks identical in a diff.
    expect(s).toContain("earningsDatesMap, earningsAsked");
  });

  test("the autopilot asks lib/no-trade-cause rather than re-deriving it inline", () => {
    // 2026-10-13: GOOGL and TGT were dropped at the position cap with both notes present, and the
    // "No trades executed but buying power is $..." soft issue still flipped the whole report to
    // NEEDS ATTENTION — the banner desensitisation its own comment warns about, caused from inside.
    // The per-SYMBOL check already had this logic; the whole-LIST check did not.
    //
    // The ORDERING inside it (a missing input outranks a guard decision) is pinned BEHAVIOURALLY in
    // evals/no-trade-cause.test.ts, not here: a structural assertion cannot see an `if (false && ...)`,
    // which is exactly how a first draft of this test passed a disabled branch.
    const s = src("app/api/autopilot/route.ts");
    expect(s).toContain('classifyNoTradeState(todayRun?.buySizingAdjustments ?? [])');
    const call = at(s, "const noTrade = classifyNoTradeState");
    const issue = at(s, "possible analysis issue (main-book buys were OPEN today)");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(issue);
    // The inline copy must be GONE — two definitions of "a guard dropped this" drift apart, and the
    // case-sensitivity rules that keep "may be rejected" from matching are the kind lost in a re-type.
    expect(s).not.toMatch(/const unestablished = notes\.filter/);
    // Both checks — per symbol and whole list — share ONE pattern, imported, defined nowhere here.
    expect(s).toContain('classifyNoTradeState, GUARD_DROP } from "@/lib/no-trade-cause"');
    expect(s).not.toMatch(/const GUARD_DROP(_RE)? = \//);
  });

  test("verify re-asks for uncaptured orders AFTER the capture writes", () => {
    // 2026-10-14: discrepancies were built before ?capture=1 ran and `status` was computed after
    // it, so the same email reported a fill as recorded (autoFixed) and as uncaptured (issues), and
    // the stale one set the banner. Pin the second call and its position: before the capture block
    // it is the pre-state, after it is the answer.
    const s = src("app/api/verify/route.ts");
    const first = at(s, "let uncapturedOrders: LiveOrder[] = storedRun");
    const capture = at(s, "const plan = planCapture(");
    const reask = at(s, "const after = findUncapturedOrders(liveOrders, [...(storedRun.trades ?? []), ...plan.record], today)");
    const status = at(s, 'const status = discrepancies.length === 0 ? "ok"');
    expect(first).toBeGreaterThan(-1);
    expect(reask).toBeGreaterThan(-1);
    expect(first).toBeLessThan(capture);
    expect(capture).toBeLessThan(reask);
    expect(reask).toBeLessThan(status);
    // Only when something was actually WRITTEN — a planned-but-unwritten capture must keep reporting.
    expect(s).toContain("if (written && plan.record.length > 0) {");
  });

  test("a capture that recorded NOTHING does not claim the book matches the broker", () => {
    // 2026-10-14: the owner bought 0.69 and sold 0.28 MRVL after the 07:30 snapshot. /api/verify
    // returned status "discrepancy" with "MRVL: quantity mismatch - live 1.523460 vs stored
    // 1.111172" AND capture.reconciles true in the same payload. `reconciles` asks only whether the
    // STORED records are self-consistent (planCapture compares two snapshots; live never enters the
    // identity), which is the meaning the withholding lock needs — so the SEMANTICS stay and the
    // CLAIM gets bounded. Third instance of the same shape in three days: a response contradicting
    // itself because two parts answer different questions in the same words.
    const s = src("app/api/verify/route.ts");
    expect(s).toContain('scope: "stored-records-only"');
    expect(s).toContain("liveVsStoredDiscrepancies");
    expect(s).toMatch(/does NOT mean the book matches the broker/);
    // The lock must still key on the UNCHANGED flag, not on the new bounded wording.
    expect(s).toMatch(/plan\.reconciles/);
  });

  test("the sector budget is CALLED, sees both sleeves, and runs after the per-position cap", () => {
    // 2026-10-14: XLK hit 44.5% with no guard breached — the only sector control was a NAME count
    // inside the MAIN shortlist, blind to held value and to the sleeve. A library alone would not
    // have fixed it (see planCapture above), so pin the call and the inputs that make it
    // cross-sleeve: it iterates portfolioCtx.positions, which is EVERY holding, not a main subset.
    const s = src("app/api/trade/route.ts");
    const perPos = at(s, "applyPerPositionCap(decision.buys");
    const sector = at(s, "applySectorBudget(decision.buys");
    const mainCap = at(s, "MAIN-BOOK POSITION CAP (buy-side)");
    expect(sector).toBeGreaterThan(-1);
    // After the per-position cap, so it budgets the dollars that will actually be spent.
    expect(perPos).toBeLessThan(sector);
    // Before the slot cap, so a sector-blocked buy never consumes a position slot.
    expect(sector).toBeLessThan(mainCap);
    // Built from EVERY held position — a main-only subset would reinstate the original blind spot.
    expect(s).toContain("for (const p of portfolioCtx?.positions ?? []) {");
    // ONE definition of where the line is: the soft-cap warning in risk-metrics and this hard gate
    // must not disagree, so the percentage is imported, never re-typed.
    expect(s).toContain("capPct: SECTOR_CAP_PCT / 100");
    expect(s).not.toMatch(/capPct: 0\.4\b/);
  });

  test("a WITHHELD return is not alerted as an uncomputable one", () => {
    // 2026-10-15: the agent sold 1.190290 MRVL against a stored baseline of 1.111172 because the
    // owner's 10-14 fills were not captured yet, so the return was deliberately WITHHELD. The run
    // then carried both "Return WITHHELD ... computed [at 8am] rather than published now" and
    // "DAILY RETURN NOT COMPUTED — an unknown condition ... a permanent gap unless the prior run's
    // total value is corrected", and emailed the owner the second one. Nothing was wrong with the
    // prior run's total value; withholding is self-healing.
    //
    // `agenticResult === null` has TWO causes and these alerts describe only one of them, so the
    // withholding case must be handled FIRST and must not reach sendAlert.
    const s = src("app/api/trade/route.ts");
    const guard = at(s, "if (unreconciled) {\n      // Already explained by the withholding note");
    const priceAlert = at(s, "Daily return could not be computed — permanent track-record gap");
    const baselineAlert = at(s, "Daily return could not be computed — no usable baseline");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(priceAlert);
    expect(guard).toBeLessThan(baselineAlert);
    // Chained, not parallel: an independent `if` would let the withholding case fall into the
    // next branch and alert anyway. Asserted by COUNTING the chained forms and forbidding a bare
    // one — a "does the chained form appear somewhere" regex passes on the un-chained code,
    // because the SECOND branch still carries `} else if` and a lazy wildcard reaches it. That
    // version of this test let the mutation through.
    const chained = (s.match(/\n    \} else if \(agenticResult === null/g) ?? []).length;
    const bare = (s.match(/\n    if \(agenticResult === null/g) ?? []).length;
    expect(chained).toBe(2);     // both alert branches hang off the withholding guard
    expect(bare).toBe(0);        // none of them is independently reachable
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
  test("a captured OWNER sell arms the re-buy cooldown", () => {
    // recordSell was called only from the trade route's own sell loop, so the registry held one
    // entry — the agent's MU exit — while five owner exits were invisible to the guard built to
    // stop whipsaw re-buys. On 2026-10-12 the agent decided to re-buy KO, sold by the owner seven
    // days earlier. The exit that matters to a re-buy is the exit, not who placed it.
    const s = src("app/api/verify/route.ts");
    expect(s).toContain("recordSell(");
    expect(s).toMatch(/plan\.record[\s\S]{0,300}recordSell\(/);   // fed from the CAPTURED fills
  });

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
