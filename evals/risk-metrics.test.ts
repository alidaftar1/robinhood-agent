import { describe, it, expect } from "bun:test";
import { computeT1Settling } from "@/lib/risk-metrics";
import type { TradeRun, TradeSnapshot } from "@/lib/run-store";

function sell(symbol: string, qty: string, price: string): TradeSnapshot {
  return { symbol, side: "sell", quantity: qty, avgPrice: price, state: "filled" };
}

function run(partial: Partial<TradeRun["portfolioAfter"]> & { trades: TradeSnapshot[] }): TradeRun {
  const { trades, ...pa } = partial;
  return {
    timestamp: "2026-06-25T15:00:00.000Z",
    date: "2026-06-25",
    summary: "",
    portfolioAfter: { totalValue: "2462.33", cash: "115.65", equity: "1962", ...pa },
    positions: [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 },
    trades,
  } as TradeRun;
}

describe("computeT1Settling", () => {
  it("sums today's sells across a merged two-run day (the 06-25 MSFT-stop undercount)", () => {
    // mergeRunsByDate keeps the 14:30 snapshot (unsettled 384.94 = BAC+C+MRNA) but
    // UNIONS in the 15:00 MSFT stop sell. The figure must reflect BOTH batches, not
    // just the snapshot — true unsettled ≈ 759, not 385.
    const merged = run({
      unsettledCash: "384.94",
      trades: [sell("BAC", "3", "58.97"), sell("C", "1", "147.51"), sell("MRNA", "1", "60.52"), sell("MSFT", "1", "374.50")],
    });
    const r = computeT1Settling(merged)!;
    expect(r.amount).toBeCloseTo(384.94 + 374.50, 1); // 759.44
  });

  it("keeps the stored live snapshot when it exceeds recorded sells (the 06-23 queued-fill case)", () => {
    // A queued stop filled at open and is in live unsettled (cash−bp) but not in today's
    // recorded trades, so the sell-sum undercounts; the stored snapshot must win.
    const r = computeT1Settling(run({ unsettledCash: "505.61", trades: [sell("SPCX", "1", "354.00")] }))!;
    expect(r.amount).toBeCloseTo(505.61, 2);
  });

  it("returns null when nothing is settling", () => {
    expect(computeT1Settling(run({ unsettledCash: "0", trades: [] }))).toBeNull();
  });
});
