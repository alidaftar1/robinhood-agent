import { describe, it, expect } from "bun:test";
import { mergeRunsByDate, type TradeRun, type TradeSnapshot } from "@/lib/run-store";

function trade(symbol: string, side: string, qty = "1", price = "10"): TradeSnapshot {
  return { symbol, side, quantity: qty, avgPrice: price, state: "filled" };
}

function run(partial: Partial<TradeRun> & { date: string; timestamp: string }): TradeRun {
  return {
    summary: "",
    portfolioAfter: { totalValue: "1000", cash: "10", equity: "990" },
    positions: [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 },
    trades: [],
    ...partial,
  };
}

function pos(symbol: string, qty = "4"): { symbol: string; quantity: string; avgCost: string; price: string } {
  return { symbol, quantity: qty, avgCost: "10", price: "10" };
}

describe("mergeRunsByDate", () => {
  it("keeps the main run over a later thin stop-loss run on the same date", () => {
    // Reproduces the 2026-06-22 regression: a stop-loss run fired AFTER the main
    // run, and the old dedup kept it (latest timestamp) — nuking the main run's
    // correct return. The richer run must win.
    const main = run({
      date: "2026-06-22",
      timestamp: "2026-06-22T14:30:00.000Z",
      agenticDailyReturn: 0.0036,
      trades: [trade("CFG", "sell"), trade("CVS", "sell"), trade("WAB", "buy")],
    });
    const stopLoss = run({
      date: "2026-06-22",
      timestamp: "2026-06-22T20:01:00.000Z",
      agenticDailyReturn: null,
      trades: [trade("SPCX", "sell")],
    });
    const merged = mergeRunsByDate([stopLoss, main]);
    expect(merged.length).toBe(1);
    expect(merged[0].agenticDailyReturn).toBe(0.0036);
    // and the stop-loss fill is preserved, not lost
    const symbols = (merged[0].trades ?? []).map(t => t.symbol).sort();
    expect(symbols).toEqual(["CFG", "CVS", "SPCX", "WAB"]);
  });

  it("unions trades without duplicating shared fills", () => {
    const a = run({ date: "2026-06-23", timestamp: "2026-06-23T15:00:00.000Z", trades: [trade("AAA", "buy"), trade("BBB", "sell")] });
    const b = run({ date: "2026-06-23", timestamp: "2026-06-23T16:00:00.000Z", trades: [trade("BBB", "sell"), trade("CCC", "buy")] });
    const merged = mergeRunsByDate([a, b]);
    expect(merged.length).toBe(1);
    expect((merged[0].trades ?? []).length).toBe(3); // AAA, BBB(once), CCC
  });

  it("falls back to more trades, then latest timestamp, when neither has a return", () => {
    const fewer = run({ date: "2026-06-20", timestamp: "2026-06-20T20:00:00.000Z", agenticDailyReturn: null, trades: [trade("X", "sell")] });
    const more = run({ date: "2026-06-20", timestamp: "2026-06-20T14:00:00.000Z", agenticDailyReturn: null, trades: [trade("Y", "buy"), trade("Z", "buy")] });
    const merged = mergeRunsByDate([fewer, more]);
    expect(merged[0].timestamp).toBe("2026-06-20T14:00:00.000Z"); // the richer (more trades) run
  });

  it("drops a holding an intraday stop-loss sold after the main run's snapshot", () => {
    // Reproduces 2026-06-24: the main run bought SMCI and snapshotted it as held;
    // a noon stop-loss run sold all 4. After merge, SMCI must NOT remain in the
    // canonical positions — otherwise it becomes phantom equity in the next day's
    // return baseline.
    const main = run({
      date: "2026-06-24",
      timestamp: "2026-06-24T14:30:00.000Z",
      agenticDailyReturn: -0.0009,
      positions: [pos("DAL"), pos("SMCI")],
      influencerPositions: [pos("MSFT", "1"), pos("SMCI")],
      trades: [trade("DAL", "buy", "4"), trade("SMCI", "buy", "4")],
    });
    const stopLoss = run({
      date: "2026-06-24",
      timestamp: "2026-06-24T19:00:00.000Z",
      agenticDailyReturn: null,
      trades: [trade("SMCI", "sell", "4")],
    });
    const merged = mergeRunsByDate([stopLoss, main]);
    expect(merged.length).toBe(1);
    expect(merged[0].positions.map((p) => p.symbol).sort()).toEqual(["DAL"]);
    // the influencer sub-portfolio is reconciled too
    expect((merged[0].influencerPositions ?? []).map((p) => p.symbol).sort()).toEqual(["MSFT"]);
    // even after the thin run is gone, a re-merge of the canonical record alone
    // (which now carries the unioned SMCI sell) stays reconciled — idempotent.
    const remerged = mergeRunsByDate(merged);
    expect(remerged[0].positions.map((p) => p.symbol)).toEqual(["DAL"]);
  });

  it("keeps a partially-sold holding", () => {
    const r = run({
      date: "2026-06-25",
      timestamp: "2026-06-25T14:30:00.000Z",
      positions: [pos("AAPL", "10")],
      trades: [trade("AAPL", "sell", "3")],
    });
    const merged = mergeRunsByDate([r]);
    expect(merged[0].positions.map((p) => p.symbol)).toEqual(["AAPL"]);
  });

  it("leaves distinct dates untouched and sorts newest first", () => {
    const d1 = run({ date: "2026-06-21", timestamp: "2026-06-21T14:00:00.000Z" });
    const d2 = run({ date: "2026-06-22", timestamp: "2026-06-22T14:00:00.000Z" });
    const merged = mergeRunsByDate([d1, d2]);
    expect(merged.length).toBe(2);
    expect(merged[0].date).toBe("2026-06-22");
    expect(merged[1].date).toBe("2026-06-21");
  });
});
