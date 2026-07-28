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

  it("carries the later full run's positions when two full runs share a date", () => {
    // Reproduces 2026-06-25: the 7:30 rotation (run with the computed return) was
    // followed by an 8am stop-loss exit that ALSO opened a new position (ES). The
    // richer run wins for its return, but its positions are now stale — they still
    // list the sold name (MSFT) and lack the newly bought one (ES). The canonical
    // snapshot must reflect the LATER full run's holdings, or ES vanishes and
    // resurfaces as phantom equity in the next day's return baseline.
    const rotation = run({
      date: "2026-06-25",
      timestamp: "2026-06-25T14:30:00.000Z",
      agenticDailyReturn: 0.0108,
      positions: [pos("GL"), pos("MSFT"), pos("DAL")],
      trades: [trade("BAC", "sell"), trade("TRV", "buy")],
    });
    const stopLossPlusBuy = run({
      date: "2026-06-25",
      timestamp: "2026-06-25T15:00:00.000Z",
      agenticDailyReturn: null,
      positions: [pos("GL"), pos("DAL"), pos("ES")],
      trades: [trade("MSFT", "sell"), trade("ES", "buy")],
    });
    const merged = mergeRunsByDate([stopLossPlusBuy, rotation]);
    expect(merged.length).toBe(1);
    // Keeps the richer run's return...
    expect(merged[0].agenticDailyReturn).toBe(0.0108);
    // ...but the LATER full run's current holdings (ES present, MSFT gone).
    expect(merged[0].positions.map((p) => p.symbol).sort()).toEqual(["DAL", "ES", "GL"]);
    // ...and every fill across both runs is preserved.
    expect((merged[0].trades ?? []).map((t) => t.symbol).sort()).toEqual(["BAC", "ES", "MSFT", "TRV"]);
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

  it("does not mutate the caller's input run objects", () => {
    // mergeRunsByDate promises to be pure. Guard against writing back into inputs
    // (the merge picks one run as the canonical base — it must clone, not mutate).
    const rotation = run({
      date: "2026-06-25",
      timestamp: "2026-06-25T14:30:00.000Z",
      agenticDailyReturn: 0.0108,
      positions: [pos("GL"), pos("MSFT")],
      trades: [trade("TRV", "buy")],
    });
    const exit = run({
      date: "2026-06-25",
      timestamp: "2026-06-25T15:00:00.000Z",
      positions: [pos("GL"), pos("ES")],
      trades: [trade("MSFT", "sell"), trade("ES", "buy")],
    });
    mergeRunsByDate([exit, rotation]);
    expect(rotation.trades?.map((t) => t.symbol)).toEqual(["TRV"]);
    expect(rotation.positions.map((p) => p.symbol)).toEqual(["GL", "MSFT"]);
    expect(exit.trades?.map((t) => t.symbol)).toEqual(["MSFT", "ES"]);
    expect(exit.positions.map((p) => p.symbol)).toEqual(["GL", "ES"]);
  });

  it("drops a re-recorded sell that exceeds what the day could possibly sell", () => {
    // The real TER 2026-07-27 case: nothing held at the open, bought 1 share that morning,
    // then ONE intraday stop-loss fill recorded twice — @$327.94 "filled" by the exit run and
    // @$328.73 "submitted" by a second run. Ceiling = 0 held + 1 bought = 1, so the second
    // record is provably phantom: it would add $328.73 to the day's tradeNetCash.
    const prevDay = run({
      date: "2026-07-24", timestamp: "2026-07-24T14:30:00.000Z",
      positions: [pos("APA", "17"), pos("ROST", "2")],
    });
    const morning = run({
      date: "2026-07-27", timestamp: "2026-07-27T14:30:00.000Z",
      positions: [pos("APA", "17"), pos("ROST", "2"), pos("TER", "1")],
      trades: [trade("GOOGL", "buy", "1", "326.37"), trade("TER", "buy", "1", "326.20")],
    });
    const exit = run({
      date: "2026-07-27", timestamp: "2026-07-27T17:05:00.000Z",
      trades: [{ symbol: "TER", side: "sell", quantity: "1", avgPrice: "327.94", state: "filled" }],
    });
    const reReport = run({
      date: "2026-07-27", timestamp: "2026-07-27T18:05:00.000Z",
      trades: [{ symbol: "TER", side: "sell", quantity: "1", avgPrice: "328.73", state: "submitted" }],
    });
    const merged = mergeRunsByDate([reReport, exit, morning, prevDay]);
    const day = merged.find(r => r.date === "2026-07-27")!;
    const terSells = (day.trades ?? []).filter(t => t.symbol === "TER" && t.side === "sell");
    expect(terSells.length).toBe(1);
    expect(terSells[0].avgPrice).toBe("327.94"); // keeps the "filled" record, drops "submitted"
    // the real buys survive, and the sold-out position is still reconciled away
    expect((day.trades ?? []).filter(t => t.side === "buy").map(t => t.symbol).sort()).toEqual(["GOOGL", "TER"]);
    expect((day.positions ?? []).some(p => p.symbol === "TER")).toBe(false);
  });

  it("keeps genuine partial fills that stay within the sellable ceiling", () => {
    // 17 APA held at the open, sold as 10 + 7 by two runs. Same symbol, same side, two
    // records — but the total is exactly what was held, so nothing is phantom.
    const prevDay = run({
      date: "2026-07-24", timestamp: "2026-07-24T14:30:00.000Z", positions: [pos("APA", "17")],
    });
    const morning = run({
      date: "2026-07-27", timestamp: "2026-07-27T14:30:00.000Z",
      positions: [pos("APA", "17")],
      trades: [trade("APA", "sell", "10", "35.40")],
    });
    const later = run({
      date: "2026-07-27", timestamp: "2026-07-27T17:05:00.000Z",
      trades: [trade("APA", "sell", "7", "35.55")],
    });
    const merged = mergeRunsByDate([later, morning, prevDay]);
    const day = merged.find(r => r.date === "2026-07-27")!;
    expect((day.trades ?? []).filter(t => t.symbol === "APA").length).toBe(2);
  });

  it("never drops a lone sell just because the prior snapshot is missing the name", () => {
    // A stale/incomplete previous snapshot makes the ceiling wrong (0). With only ONE
    // record there is no twin to fall back on, so real history must survive untouched.
    const prevDay = run({
      date: "2026-07-24", timestamp: "2026-07-24T14:30:00.000Z", positions: [pos("APA", "17")],
    });
    const today = run({
      date: "2026-07-27", timestamp: "2026-07-27T14:30:00.000Z",
      positions: [pos("APA", "17")],
      trades: [trade("ILMN", "sell", "2", "191.49")],
    });
    const merged = mergeRunsByDate([today, prevDay]);
    const day = merged.find(r => r.date === "2026-07-27")!;
    expect((day.trades ?? []).length).toBe(1);
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
