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
    portfolioAfter: { totalValue: "2452", cash: "43.55", equity: "1668", ...pa },
    positions: [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 },
    trades,
  } as TradeRun;
}

describe("computeT1Settling", () => {
  it("uses the complete live unsettled snapshot, not the recorded sells", () => {
    // Every run now stores the live unsettled (cash − buying power) via fetchAgenticBalance,
    // so the latest run (e.g. the MSFT stop) reflects ALL of today's unsettled — incl. the
    // morning rebalance's sells — not just its own. Prefer that over the placeholder-priced
    // sell-sum (here the MSFT sell is recorded at its $374.50 buy-price placeholder).
    const r = computeT1Settling(run({ unsettledCash: "740.35", trades: [sell("MSFT", "1", "374.50")] }))!;
    expect(r.amount).toBeCloseTo(740.35, 2);
  });

  it("falls back to summed sells only when no stored unsettled (old run)", () => {
    const r = computeT1Settling(run({ unsettledCash: "", trades: [sell("BAC", "3", "58.97"), sell("C", "1", "147.51"), sell("MRNA", "1", "60.52")] }))!;
    expect(r.amount).toBeCloseTo(58.97 * 3 + 147.51 + 60.52, 1); // 384.94
  });

  it("returns null when nothing is settling", () => {
    expect(computeT1Settling(run({ unsettledCash: "0", trades: [] }))).toBeNull();
  });
});
