import { describe, expect, test } from "bun:test";
import { withBudget, QUALITY_CALL_BUDGET_MS } from "../lib/quality";
import { buildV1Shortlist, type StockData } from "../lib/market-data";

// A failed quality screen used to WIDEN the buyable universe to every stock, so the main book
// bought on momentum alone — a different and measurably worse strategy. It now withholds BUYS.
describe("withBudget", () => {
  test("returns the value inside the budget and does not time out", async () => {
    let fired = false;
    expect(await withBudget(Promise.resolve("ok"), 1000, () => { fired = true; })).toBe("ok");
    expect(fired).toBe(false);
  });

  test("returns null and REPORTS past the budget", async () => {
    let fired = false;
    const slow = new Promise<string>(r => setTimeout(() => r("late"), 200));
    expect(await withBudget(slow, 20, () => { fired = true; })).toBeNull();
    expect(fired).toBe(true);
  });

  test("a rejection propagates — a real error is not laundered into a timeout", async () => {
    await expect(withBudget(Promise.reject(new Error("boom")), 1000, () => {})).rejects.toThrow("boom");
  });

  test("a falsy-but-valid value is preserved, not confused with the timeout's null", async () => {
    expect(await withBudget(Promise.resolve(0), 1000, () => {})).toBe(0);
  });

  test("the budget sits BELOW the module's internal ceilings — safe only because it fails closed", () => {
    // FRAMES 75s + RECOVERY 45s = 120s. Cutting a slow run short now costs a delayed buy on a
    // weekly-rebalanced book, not a momentum-only purchase, so the cheap side is cutting short.
    expect(QUALITY_CALL_BUDGET_MS).toBeLessThan(120_000);
    expect(QUALITY_CALL_BUDGET_MS).toBeGreaterThan(30_000);
  });
});

// The reason the withhold is applied to BUYS at the execution boundary rather than by emptying
// `eligible`: these two assertions are what made the "obvious" implementation dangerous.
describe("why fail-closed must NOT be implemented by emptying `eligible`", () => {
  const stock = (symbol: string, mom: number): StockData =>
    ({ symbol, price: 100, changePercent: 0, mom12_1: mom } as unknown as StockData);
  const stocks = [stock("AAA", 0.5), stock("BBB", 0.4)];

  test("with an empty eligible AND empty qualityUnknown, every HELD name drops out of retained", () => {
    // `retained` admits a held name only if eligible OR quality-unknown. A null quality empties
    // both — and "fell off the shortlist" is a reason lib/sell-rail accepts for SELLING, so this
    // would have turned a data outage into a liquidation.
    const { buy, retained } = buildV1Shortlist(stocks, new Set(), {
      held: new Set(["AAA", "BBB"]), qualityUnknown: new Set(),
    });
    expect(buy).toEqual([]);
    expect(retained).toEqual([]);   // ← the liquidation trap
  });

  test("whereas the shipped path keeps held names ON the shortlist, because eligible is left alone", () => {
    // The invariant that matters is "not DROPPED" — a held name must appear in buy OR retained.
    // Absent from both is what reads as "fell off the shortlist" and authorises a sell.
    const { buy, retained } = buildV1Shortlist(stocks, new Set(["AAA", "BBB"]), {
      held: new Set(["AAA", "BBB"]), qualityUnknown: new Set(),
    });
    const onList = new Set([...buy, ...retained].map(s => s.symbol));
    expect([...onList].sort()).toEqual(["AAA", "BBB"]);
  });

  test("an empty buy-allowlist would also relabel every main buy as an influencer pick", () => {
    // Sleeve classification infers "influencer" from !v1ShortlistSet.has(sym).
    const { buy } = buildV1Shortlist(stocks, new Set(), { held: new Set() });
    const v1ShortlistSet = new Set(buy.map(s => s.symbol));
    expect(v1ShortlistSet.size).toBe(0);
    expect(v1ShortlistSet.has("AAA")).toBe(false);  // → would classify a MAIN buy as influencer
  });
});
