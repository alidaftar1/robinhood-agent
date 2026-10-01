import { describe, test, expect } from "bun:test";
import { buildV1Shortlist, STOCK_SECTOR, type StockData } from "@/lib/market-data";

// DIFFERENTIAL TEST for a rewrite in the LIVE trade path.
//
// buildV1Shortlist's `retained` used to be derived from `ranked` — already momentum-filtered,
// eligibility-filtered and sorted — as `ranked.filter(held && !buySet)`. It now re-filters `stocks`
// from scratch so it can also admit held-but-quality-UNKNOWN names.
//
// I claimed that rewrite is equivalent except for the intended case. I made a structurally identical
// "this preserves behaviour" claim about the annual-fallback denominator earlier in this work and it
// was FACTUALLY WRONG, so the claim is tested rather than asserted: randomised inputs, the old
// derivation recomputed from the new function's own `buy` output, and an exact comparison.

/** Deterministic PRNG — a flaky differential test is worse than none. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const SYMBOLS = Object.keys(STOCK_SECTOR).slice(0, 120);

const mk = (symbol: string, mom: number): StockData => ({
  symbol, price: 100, change1d: 0, change5d: 0, change14d: 0, change30d: 0,
  distFrom52wHigh: -10, volatility30d: 25, sharpe5d: 1, sharpe14d: 1, sharpe30d: 1,
  mom12_1: mom, beta: 1, earningsDate: null,
  relStrength1d: 0, relStrength5d: 0, relStrength14d: 0, relStrength30d: 0,
} as StockData);

/** The PRE-REWRITE derivation, verbatim in shape: filter+sort `ranked`, then held && !buySet. */
function oldRetained(stocks: StockData[], eligible: Set<string>, held: Set<string>, buy: StockData[]): string[] {
  const buySet = new Set(buy.map(s => s.symbol));
  return stocks
    .filter(s => typeof s.mom12_1 === "number" && (s.mom12_1 as number) > 0 && eligible.has(s.symbol))
    .sort((a, b) => (b.mom12_1 as number) - (a.mom12_1 as number))
    .filter(s => held.has(s.symbol) && !buySet.has(s.symbol))
    .map(s => s.symbol);
}

describe("retained is equivalent to the pre-rewrite derivation when no quality is unknown", () => {
  test("300 randomised universes agree EXACTLY, and the comparison is not vacuous", () => {
    const rnd = lcg(20260930);
    let compared = 0, nonEmpty = 0, multi = 0;
    for (let iter = 0; iter < 300; iter++) {
      const n = 8 + Math.floor(rnd() * 40);
      const syms = [...SYMBOLS].sort(() => rnd() - 0.5).slice(0, n);
      // Deliberately include NEGATIVE and zero momentum so the mom > 0 gate is exercised.
      const stocks = syms.map(s => mk(s, Math.round((rnd() * 80 - 20) * 10) / 10));
      const eligible = new Set(syms.filter(() => rnd() < 0.6));
      const held = new Set(syms.filter(() => rnd() < 0.3));
      // A SMALL shortlistSize is essential: with the default the buy list absorbs everything and
      // `retained` is always empty, which is how the original sort assertion came to prove nothing.
      const shortlistSize = 1 + Math.floor(rnd() * 5);

      const got = buildV1Shortlist(stocks, eligible, { held, shortlistSize });
      const expected = oldRetained(stocks, eligible, held, got.buy);
      expect(got.retained.map(s => s.symbol)).toEqual(expected);
      compared++;
      if (expected.length > 0) nonEmpty++;
      if (expected.length > 1) multi++;
    }
    expect(compared).toBe(300);
    // Guard against the vacuity that bit the earlier test: the comparison must actually have had
    // non-empty, multi-element retained lists to compare.
    expect(nonEmpty).toBeGreaterThan(50);
    expect(multi).toBeGreaterThan(20);
  });

  test("an explicit non-empty case keeps momentum-descending order", () => {
    const stocks = [mk("AAPL", 40), mk("MSFT", 35), mk("NVDA", 30), mk("JPM", 25), mk("KO", 20)];
    const r = buildV1Shortlist(stocks, new Set(["AAPL", "MSFT", "NVDA", "JPM", "KO"]), {
      held: new Set(["MSFT", "JPM", "KO"]), shortlistSize: 1,
    });
    expect(r.buy.map(s => s.symbol)).toEqual(["AAPL"]);
    expect(r.retained.map(s => s.symbol)).toEqual(["MSFT", "JPM", "KO"]);   // 35 > 25 > 20
    expect(r.retained.length).toBeGreaterThan(1);                           // not vacuous
  });
});

describe("adding quality-unknown names changes ONLY held-and-unknown", () => {
  test("across randomised universes the delta is exactly the held ∩ unknown set with positive momentum", () => {
    const rnd = lcg(777);
    let sawDelta = 0;
    for (let iter = 0; iter < 300; iter++) {
      const n = 8 + Math.floor(rnd() * 40);
      const syms = [...SYMBOLS].sort(() => rnd() - 0.5).slice(0, n);
      const stocks = syms.map(s => mk(s, Math.round((rnd() * 80 - 20) * 10) / 10));
      const eligible = new Set(syms.filter(() => rnd() < 0.5));
      const held = new Set(syms.filter(() => rnd() < 0.35));
      // Unknown names are, by construction, NOT eligible — they were never measured.
      const unknown = new Set(syms.filter(s => !eligible.has(s) && rnd() < 0.5));
      const shortlistSize = 1 + Math.floor(rnd() * 5);

      const base = buildV1Shortlist(stocks, eligible, { held, shortlistSize });
      const withU = buildV1Shortlist(stocks, eligible, { held, shortlistSize, qualityUnknown: unknown });

      // BUY must be untouched — an unmeasurable name can never be bought.
      expect(withU.buy.map(s => s.symbol)).toEqual(base.buy.map(s => s.symbol));

      const added = withU.retained.map(s => s.symbol).filter(x => !base.retained.some(b => b.symbol === x));
      const removed = base.retained.map(s => s.symbol).filter(x => !withU.retained.some(b => b.symbol === x));
      const expectedAdded = stocks
        .filter(s => (s.mom12_1 as number) > 0 && held.has(s.symbol) && unknown.has(s.symbol))
        .map(s => s.symbol);
      expect(new Set(added)).toEqual(new Set(expectedAdded));
      expect(removed).toEqual([]);                 // nothing is ever LOST by passing the set
      if (added.length > 0) sawDelta++;
    }
    expect(sawDelta).toBeGreaterThan(30);          // the delta case actually occurred
  });
});
