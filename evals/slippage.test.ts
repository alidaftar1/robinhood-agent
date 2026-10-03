import { describe, expect, test } from "bun:test";
import { slippageBps, collectFills, computeSlippage } from "../lib/slippage";
import type { TradeRun, TradeSnapshot } from "../lib/run-store";

// CONVENTION: positive bps = WORSE execution on BOTH sides. Getting the sell sign backwards would
// make a real cost look like a gain — the one error here that would actually be acted on.
const t = (over: Partial<TradeSnapshot> = {}): TradeSnapshot => ({
  symbol: "AAA", side: "buy", quantity: "1", avgPrice: "101", state: "filled", refPrice: "100", ...over,
});
const run = (date: string, trades: TradeSnapshot[]): TradeRun => ({
  timestamp: `${date}T14:30:00Z`, date, summary: "", portfolioAfter: null, positions: [],
  market: { stocksLoaded: 0, headlinesLoaded: 0 }, trades,
});

describe("slippageBps — sign convention", () => {
  test("a BUY filled ABOVE the decision price is a cost (positive)", () => {
    expect(slippageBps(t({ side: "buy", refPrice: "100", avgPrice: "101" }))).toBeCloseTo(100, 6);
  });

  test("a BUY filled BELOW the decision price is a gain (negative)", () => {
    expect(slippageBps(t({ side: "buy", refPrice: "100", avgPrice: "99" }))).toBeCloseTo(-100, 6);
  });

  test("a SELL filled BELOW the decision price is a cost (positive) — the sign flips", () => {
    expect(slippageBps(t({ side: "sell", refPrice: "100", avgPrice: "99" }))).toBeCloseTo(100, 6);
  });

  test("a SELL filled ABOVE the decision price is a gain (negative)", () => {
    expect(slippageBps(t({ side: "sell", refPrice: "100", avgPrice: "101" }))).toBeCloseTo(-100, 6);
  });

  test("a missing or zero reference yields null, never 0 — 0 would read as free execution", () => {
    expect(slippageBps(t({ refPrice: undefined }))).toBeNull();
    expect(slippageBps(t({ refPrice: "0" }))).toBeNull();
    expect(slippageBps(t({ avgPrice: "0" }))).toBeNull();
  });
});

describe("collectFills", () => {
  test("skips INFERRED sells — their price is our arithmetic, not the broker's", () => {
    const fills = collectFills([run("2026-10-01", [
      t({ symbol: "AAA", state: "filled" }),
      t({ symbol: "BBB", side: "sell", state: "inferred", refPrice: "100", avgPrice: "90" }),
    ])]);
    expect(fills.map(f => f.symbol)).toEqual(["AAA"]);
  });

  test("skips trades with no reference price rather than dropping the whole run", () => {
    const fills = collectFills([run("2026-10-01", [t({ symbol: "AAA" }), t({ symbol: "OLD", refPrice: undefined })])]);
    expect(fills.map(f => f.symbol)).toEqual(["AAA"]);
  });
});

describe("computeSlippage", () => {
  test("reports buy and sell separately — they do not face the same spread", () => {
    const s = computeSlippage([run("2026-10-01", [
      t({ side: "buy", refPrice: "100", avgPrice: "101" }),
      t({ side: "sell", refPrice: "100", avgPrice: "99" }),
    ])]);
    expect(s.map(x => x.side)).toEqual(["buy", "sell", "all"]);
    expect(s.find(x => x.side === "buy")!.meanBps).toBeCloseTo(100, 6);
    expect(s.find(x => x.side === "sell")!.meanBps).toBeCloseTo(100, 6);
  });

  test("a single fill is never 'significant' — n=1 has no standard error", () => {
    const s = computeSlippage([run("2026-10-01", [t({ refPrice: "100", avgPrice: "150" })])]);
    expect(s[0].fills).toBe(1);
    expect(s[0].significant).toBe(false);
  });

  test("a consistent cost across many fills IS significant", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      t({ symbol: `S${i}`, refPrice: "100", avgPrice: String(100 * (1 + (10 + (i % 3)) / 10_000)) }));
    const s = computeSlippage([run("2026-10-01", trades)]);
    expect(s[0].meanBps).toBeGreaterThan(9);
    expect(s[0].significant).toBe(true);
  });

  test("noise around zero is NOT significant, however many fills", () => {
    const trades = Array.from({ length: 40 }, (_, i) =>
      t({ symbol: `S${i}`, refPrice: "100", avgPrice: String(100 * (1 + (i % 2 === 0 ? 50 : -50) / 10_000)) }));
    const s = computeSlippage([run("2026-10-01", trades)]);
    expect(Math.abs(s[0].meanBps)).toBeLessThan(1);
    expect(s[0].significant).toBe(false);
  });

  test("returns nothing at all when no fill is priceable", () => {
    expect(computeSlippage([run("2026-10-01", [t({ refPrice: undefined })])])).toEqual([]);
  });
});
