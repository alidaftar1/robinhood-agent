import { describe, expect, test } from "bun:test";
import {
  classifyExit, stopThresholdFor, buildExitContext, symbolsWithMainOwnership, type ExitContext,
  MAIN_DROP_THRESHOLD_PCT, INFLUENCER_DROP_THRESHOLD_PCT, TAKE_PROFIT_PCT,
} from "@/lib/stopouts";

const ctx = (o: Partial<ExitContext> = {}): ExitContext =>
  ({ isInfluencer: false, measuredFromBuy: false, mixedWithMain: false, ...o });
const MAIN = ctx();
const INFL = ctx({ isInfluencer: true, measuredFromBuy: true });

describe("stop thresholds", () => {
  test("the two sleeves are on different bars", () => {
    expect(MAIN_DROP_THRESHOLD_PCT).toBe(-5);
    expect(INFLUENCER_DROP_THRESHOLD_PCT).toBe(-10);
    expect(stopThresholdFor(MAIN)).toBe(-5);
    expect(stopThresholdFor(INFL)).toBe(-10);
  });

  test("the influencer range that USED to stop on noise no longer does", () => {
    // The 3 observed stop-outs were -5.17% (CRM), -5.62% (CAKE), -5.66% (IMAX); 2 of 3 recovered.
    for (const pct of [-5.17, -5.62, -5.66, -6, -8, -9.99]) expect(classifyExit(pct, INFL)).toBeNull();
  });

  test("the influencer stop still fires past -10%", () => {
    expect(classifyExit(-10, INFL)).toBe("stop");    // inclusive boundary
    expect(classifyExit(-12.7, INFL)).toBe("stop");  // the PYPL-style overnight gap
  });

  test("the main book is UNCHANGED at -5% — widening the sleeve must not leak", () => {
    expect(classifyExit(-5, MAIN)).toBe("stop");     // inclusive boundary
    expect(classifyExit(-4.99, MAIN)).toBeNull();
    expect(classifyExit(-9, MAIN)).toBe("stop");     // would NOT stop on the sleeve's bar
  });

  test("a MIXED lot (influencer tag + main-book shares) keeps the TIGHTER main bar", () => {
    const mixed = ctx({ isInfluencer: true, measuredFromBuy: true, mixedWithMain: true });
    expect(stopThresholdFor(mixed)).toBe(-5);
    expect(classifyExit(-7, mixed)).toBe("stop");
    expect(classifyExit(-7, INFL)).toBeNull();       // same move, pure sleeve: held
  });

  test("an influencer row with an unusable cost basis falls back to the tighter bar", () => {
    // change1d is then an intraday move from prev close, which the from-cost bar doesn't describe.
    const noBasis = ctx({ isInfluencer: true, measuredFromBuy: false });
    expect(stopThresholdFor(noBasis)).toBe(-5);
    expect(classifyExit(-8, noBasis)).toBe("stop");
    expect(classifyExit(-8, INFL)).toBeNull();
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
    // mark every symbol and silently collapse the sleeve back to -5% forever.
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
    expect(stopThresholdFor(c)).toBe(-5);
  });

  test("a repeat sleeve pick the main book never bought stays on -10%", () => {
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
    expect(stopThresholdFor(c)).toBe(-5);
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
    expect(stopThresholdFor(c)).toBe(-5);
    expect(classifyExit(60, c)).toBeNull();  // sleeve-only TP must not liquidate the merged lot
  });

  test("a pure sleeve position IS measured from buy", () => {
    const c = buildExitContext({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: true });
    expect(c.measuredFromBuy).toBe(true);
    expect(stopThresholdFor(c)).toBe(-10);
  });

  test("a same-day BUY still measures from buy price even when merged", () => {
    // The pre-purchase-decline guard is not a sleeve rule and must survive.
    const c = buildExitContext({ isInfluencer: true, mainOwned: true, boughtToday: true, canMeasureFromBuy: true });
    expect(c.measuredFromBuy).toBe(true);
    expect(stopThresholdFor(c)).toBe(-5);
  });

  test("an unusable cost basis forces the intraday reading and the tighter bar", () => {
    const c = buildExitContext({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: false });
    expect(c.measuredFromBuy).toBe(false);
    expect(stopThresholdFor(c)).toBe(-5);
  });

  test("a plain main-book hold is unaffected", () => {
    const c = buildExitContext({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: true });
    expect(c.mixedWithMain).toBe(false);
    expect(c.measuredFromBuy).toBe(false);
    expect(stopThresholdFor(c)).toBe(-5);
  });
});
