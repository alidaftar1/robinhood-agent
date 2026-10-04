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

  // (The old assertion that the budget sat between 30s and 120s belonged to the version where this
  // covered the COLD SEC path. That path moved to /api/quality-refresh; the budget invariant now
  // lives in the "sized for a CACHE READ" block below.)
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

// The trade run now reads the cache only; the cold SEC path moved to /api/quality-refresh. No
// budget was correct for the cold path inside /api/trade: large enough to let it finish endangered
// the risk SELLS against maxDuration, small enough to be safe discarded slow-but-correct results —
// and with the screen failing closed, discarding one stops main-book buying. It also could not
// self-heal, because one failed SEC fetch among ~130 marks the result degraded and a degraded
// result is never cached, so every following run started cold again.
describe("quality budget is sized for a CACHE READ, not an SEC crawl", () => {
  test("the budget is far below the module's own internal ceilings — it is not a cold-path budget", () => {
    // FRAMES 75s + RECOVERY 45s = 120s of legitimate cold work. A budget anywhere near that would
    // mean the cold path still ran here.
    expect(QUALITY_CALL_BUDGET_MS).toBeLessThan(30_000);
  });

  test("but long enough that an ordinary Redis round-trip cannot trip it", () => {
    expect(QUALITY_CALL_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("the quality-refresh cron is scheduled ahead of the trade run", () => {
  test("it exists, and lands before /api/trade so a slow refresh cannot delay the sells", async () => {
    const cfg = JSON.parse(await Bun.file("vercel.json").text()) as { crons: Array<{ path: string; schedule: string }> };
    const refresh = cfg.crons.find(c => c.path.startsWith("/api/quality-refresh"));
    const trade = cfg.crons.find(c => c.path.startsWith("/api/trade"));
    expect(refresh, "quality-refresh cron must be scheduled — without it the cache expires and the fail-closed screen stops buys").toBeDefined();
    expect(trade).toBeDefined();
    const mins = (s: string) => { const [m, h] = s.split(" "); return Number(h) * 60 + Number(m); };
    expect(mins(refresh!.schedule)).toBeLessThan(mins(trade!.schedule));
  });

  test("it runs on weekdays, matching the trade cadence", async () => {
    const cfg = JSON.parse(await Bun.file("vercel.json").text()) as { crons: Array<{ path: string; schedule: string }> };
    const refresh = cfg.crons.find(c => c.path.startsWith("/api/quality-refresh"))!;
    expect(refresh.schedule.trim().split(" ")[4]).toBe("1-5");
  });
});
