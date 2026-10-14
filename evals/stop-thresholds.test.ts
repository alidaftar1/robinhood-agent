import { describe, expect, test } from "bun:test";
import {
  classifyExit, stopThresholdFor, stopBarFor, buildExitContext, symbolsWithMainOwnership, type ExitContext,
  MAIN_DROP_THRESHOLD_PCT, INFLUENCER_DROP_THRESHOLD_PCT, TAKE_PROFIT_PCT,
} from "@/lib/stopouts";

const ctx = (o: Partial<ExitContext> = {}): ExitContext =>
  ({ isInfluencer: false, measuredFromBuy: false, mixedWithMain: false, ...o });
const MAIN = ctx();
const INFL = ctx({ isInfluencer: true, measuredFromBuy: true });

describe("stop thresholds", () => {
  test("both bars are -10, on DIFFERENT baselines", () => {
    // -5 -> -10 on 2026-10-14 (docs/experiment-stop-threshold.md). The two numbers now coincide,
    // so the number alone no longer identifies which bar was applied — that is why every routing
    // assertion below reads stopBarFor, not stopThresholdFor. The baselines still differ: main is
    // a SAME-DAY move from prev close, sleeve is CUMULATIVE from buy.
    expect(MAIN_DROP_THRESHOLD_PCT).toBe(-10);
    expect(INFLUENCER_DROP_THRESHOLD_PCT).toBe(-10);
    expect(stopBarFor(MAIN)).toBe("main");
    expect(stopBarFor(INFL)).toBe("sleeve");
  });

  test("GUARD: if the two numbers ever diverge again, routing is still asserted by NAME", () => {
    // A tripwire for the reverse of the 2026-10-14 mistake. Were these tests to go back to
    // asserting raw numbers, equal constants would make them pass regardless of routing. This
    // states the dependency out loud so the next person changing a constant sees it.
    expect(stopThresholdFor(MAIN)).toBe(MAIN_DROP_THRESHOLD_PCT);
    expect(stopThresholdFor(INFL)).toBe(INFLUENCER_DROP_THRESHOLD_PCT);
  });

  test("the influencer range that USED to stop on noise no longer does", () => {
    // The 3 observed stop-outs were -5.17% (CRM), -5.62% (CAKE), -5.66% (IMAX); 2 of 3 recovered.
    for (const pct of [-5.17, -5.62, -5.66, -6, -8, -9.99]) expect(classifyExit(pct, INFL)).toBeNull();
    // Since 2026-10-14 the MAIN book holds through that range too — on a same-day basis, which is
    // a different and much rarer event than the same number measured from cost.
    for (const pct of [-5.17, -6, -9.99]) expect(classifyExit(pct, MAIN)).toBeNull();
  });

  test("the influencer stop still fires past -10%", () => {
    expect(classifyExit(-10, INFL)).toBe("stop");    // inclusive boundary
    expect(classifyExit(-12.7, INFL)).toBe("stop");  // the PYPL-style overnight gap
  });

  test("the main book fires at -10% in a DAY, and no longer at -5%", () => {
    // The 28-year sweep: -5% cost ~1.3-1.5pp CAGR/yr and moved maxDD not at all (-77.8% vs -79.0%
    // at -10%), i.e. it was paid for in returns and bought no drawdown protection. 1,194 stop-outs
    // over the path, ~43/yr on a 6-name book.
    expect(classifyExit(-10, MAIN)).toBe("stop");    // inclusive boundary
    expect(classifyExit(-9.99, MAIN)).toBeNull();
    expect(classifyExit(-5, MAIN)).toBeNull();       // the whole point of the change
    expect(classifyExit(-30, MAIN)).toBe("stop");    // a genuine collapse still exits
  });

  test("a MIXED lot (influencer tag + main-book shares) is routed to the MAIN bar", () => {
    // Main-book capital follows the main book's rule. Asserted by NAME: both numbers are -10, so
    // a value check here would pass even if the sleeve bar were wrongly applied.
    const mixed = ctx({ isInfluencer: true, measuredFromBuy: true, mixedWithMain: true });
    expect(stopBarFor(mixed)).toBe("main");
    expect(stopBarFor(INFL)).toBe("sleeve");
  });

  test("an influencer row with an unusable cost basis is routed to the MAIN bar", () => {
    // change1d is then an intraday move from prev close, which the from-cost bar doesn't describe.
    // NOTE what changed on 2026-10-14: this fallback used to be TIGHTER than the sleeve's own rule
    // (-5 same-day vs -10 from buy) and is now the RARER trigger, i.e. a loosening of this path.
    // Recorded rather than silently inherited — if it matters it needs its own constant.
    const noBasis = ctx({ isInfluencer: true, measuredFromBuy: false });
    expect(stopBarFor(noBasis)).toBe("main");
    expect(classifyExit(-8, noBasis)).toBeNull();    // was "stop" under the -5 bar
    expect(classifyExit(-11, noBasis)).toBe("stop");
  });

  test("take-profit is influencer-only, from-buy-only, and unchanged", () => {
    expect(classifyExit(TAKE_PROFIT_PCT, INFL)).toBe("profit");
    expect(classifyExit(39.99, INFL)).toBeNull();
    expect(classifyExit(60, MAIN)).toBeNull();                                  // main never takes profit
    expect(classifyExit(60, ctx({ isInfluencer: true }))).toBeNull();            // not measured from buy
  });

  test("a flat or winning position is never an exit", () => {
    for (const pct of [0, 1, 12]) {
      expect(classifyExit(pct, MAIN)).toBeNull();
      expect(classifyExit(pct, INFL)).toBeNull();
    }
  });
});

// These drive the DERIVATION, not a hand-written context.
//
// Three earlier designs failed here. (a) Comparing position.quantity to influencerPositions[].quantity
// was inert: every writer builds the latter as positions.filter(...), so they are the same object.
// (b) Netting influencer-tagged buys against influencer-tagged SELLS over-counted sleeve ownership,
// because sells frequently lose the tag (PLTR and CAKE, both sold 2026-08-19, strategy=undefined) —
// over-counting is the DANGEROUS direction, granting main capital the looser bar. (c) Buy tags alone
// missed a long-held main position whose original buy had aged out of the LTRIM'd run window.
describe("main-ownership detection", () => {
  const buy  = (symbol: string, strategy?: string) => ({ symbol, side: "buy",  quantity: "1", strategy });
  const sell = (symbol: string, strategy?: string) => ({ symbol, side: "sell", quantity: "1", strategy });
  const pos  = (symbol: string) => ({ symbol, quantity: "1", avgCost: "10", price: "10" });
  /** A run that HAS sleeve tracking (influencerPositions present, possibly empty). */
  const run = (o: any) => ({ trades: [], positions: [], influencerPositions: [], ...o });

  test("an explicitly main-tagged buy is detected", () => {
    // Production writes strategy:"main" explicitly — a predicate keyed on `undefined` would miss it.
    const m = symbolsWithMainOwnership([run({ trades: [buy("XOM", "main")] as any })]);
    expect(m.has("XOM")).toBe(true);
  });

  test("untagged buys count as main; influencer buys and all sells do not", () => {
    const m = symbolsWithMainOwnership([
      run({ trades: [buy("NVDA", "influencer"), buy("TGT")] as any }),
      run({ trades: [sell("LLY"), sell("SPCX", "influencer")] as any }),
    ]);
    expect(m.has("TGT")).toBe(true);
    expect(m.has("NVDA")).toBe(false);
    expect(m.has("LLY")).toBe(false);
    expect(m.has("SPCX")).toBe(false);
  });

  test("a long-held main position is detected from SNAPSHOTS after its buy ages out", () => {
    // The (c) failure: no buy record survives, but the position is in every snapshot.
    const m = symbolsWithMainOwnership([run({ positions: [pos("APA")] as any })]);
    expect(m.has("APA")).toBe(true);
  });

  test("a sleeve-only holding is NOT marked by the snapshot signal", () => {
    const m = symbolsWithMainOwnership([
      run({ positions: [pos("SPCX")] as any, influencerPositions: [pos("SPCX")] as any }),
    ]);
    expect(m.has("SPCX")).toBe(false);
  });

  test("a run with NO sleeve tracking is ignored, not read as all-main", () => {
    // influencerPositions === undefined predates tracking. Treating its positions as main would
    // mark every symbol and silently collapse the sleeve onto the main bar forever.
    const m = symbolsWithMainOwnership([{ positions: [pos("SPCX"), pos("NVDA")] } as any]);
    expect(m.size).toBe(0);
    // An empty ARRAY is real evidence: the sleeve held nothing, so those positions are main.
    const m2 = symbolsWithMainOwnership([run({ positions: [pos("SPCX")] as any })]);
    expect(m2.has("SPCX")).toBe(true);
  });

  test("an UNTAGGED sleeve exit cannot later grant a merged lot the looser bar", () => {
    const m = symbolsWithMainOwnership([
      run({ trades: [buy("CAKE", "influencer")] as any }),
      run({ trades: [sell("CAKE")] as any }),                     // untagged exit — credits nothing
      run({ trades: [buy("CAKE", "influencer"), buy("CAKE", "main")] as any }),
    ]);
    const c = buildExitContext({ isInfluencer: true, mainOwned: m.has("CAKE"), boughtToday: false, canMeasureFromBuy: true });
    expect(c.mixedWithMain).toBe(true);
    expect(stopBarFor(c)).toBe("main");
  });

  test("a repeat sleeve pick the main book never bought stays on the SLEEVE bar", () => {
    const m = symbolsWithMainOwnership([
      run({ trades: [buy("IMAX", "influencer")] as any, positions: [pos("IMAX")] as any, influencerPositions: [pos("IMAX")] as any }),
      run({ trades: [sell("IMAX")] as any }),
      run({ trades: [buy("IMAX", "influencer")] as any, positions: [pos("IMAX")] as any, influencerPositions: [pos("IMAX")] as any }),
    ]);
    expect(buildExitContext({ isInfluencer: true, mainOwned: m.has("IMAX"), boughtToday: false, canMeasureFromBuy: true }).mixedWithMain).toBe(false);
  });

  test("an influencer buy that LOST its tag tightens the stop, never loosens it", () => {
    const m = symbolsWithMainOwnership([run({ trades: [buy("NVDA")] as any })]);
    const c = buildExitContext({ isInfluencer: true, mainOwned: m.has("NVDA"), boughtToday: false, canMeasureFromBuy: true });
    expect(stopBarFor(c)).toBe("main");
  });

  test("empty / malformed runs are handled", () => {
    expect(symbolsWithMainOwnership([]).size).toBe(0);
    expect(symbolsWithMainOwnership([{ trades: null, positions: null, influencerPositions: [] }] as any).size).toBe(0);
  });
});

describe("merged lots are judged exactly like a main-book hold", () => {
  test("a merged lot is measured SAME-DAY, not from blended cost", () => {
    const c = buildExitContext({ isInfluencer: true, mainOwned: true, boughtToday: false, canMeasureFromBuy: true });
    expect(c.measuredFromBuy).toBe(false);   // would otherwise apply a cumulative reading to a same-day bar
    expect(c.mixedWithMain).toBe(true);
    expect(stopBarFor(c)).toBe("main");
    expect(classifyExit(60, c)).toBeNull();  // sleeve-only TP must not liquidate the merged lot
  });

  test("a pure sleeve position IS measured from buy", () => {
    const c = buildExitContext({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: true });
    expect(c.measuredFromBuy).toBe(true);
    expect(stopBarFor(c)).toBe("sleeve");
  });

  test("a same-day BUY still measures from buy price even when merged", () => {
    // The pre-purchase-decline guard is not a sleeve rule and must survive.
    const c = buildExitContext({ isInfluencer: true, mainOwned: true, boughtToday: true, canMeasureFromBuy: true });
    expect(c.measuredFromBuy).toBe(true);
    expect(stopBarFor(c)).toBe("main");
  });

  test("an unusable cost basis forces the intraday reading and the MAIN bar", () => {
    const c = buildExitContext({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: false });
    expect(c.measuredFromBuy).toBe(false);
    expect(stopBarFor(c)).toBe("main");
  });

  test("a plain main-book hold is unaffected", () => {
    const c = buildExitContext({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: true });
    expect(c.mixedWithMain).toBe(false);
    expect(c.measuredFromBuy).toBe(false);
    expect(stopBarFor(c)).toBe("main");
  });
});
