import { describe, it, expect } from "bun:test";
import { mergeRunsByDate, findUnpriceableTrades, type TradeRun, type TradeSnapshot } from "@/lib/run-store";

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
    // A previous day is supplied because production always has one (getRuns(60/90)). A snapshot
    // that EXISTS and omits SMCI is the evidence it was bought fresh today; with NO previous
    // snapshot at all, reconciliation deliberately does nothing (see the dedicated test below).
    const prevDay = run({
      date: "2026-06-23", timestamp: "2026-06-23T14:30:00.000Z", positions: [pos("DAL")],
    });
    const merged = mergeRunsByDate([stopLoss, main, prevDay]).filter((r) => r.date === "2026-06-24");
    expect(merged.length).toBe(1);
    expect(merged[0].positions.map((p) => p.symbol).sort()).toEqual(["DAL"]);
    // the influencer sub-portfolio is reconciled too
    expect((merged[0].influencerPositions ?? []).map((p) => p.symbol).sort()).toEqual(["MSFT"]);
    // even after the thin run is gone, a re-merge of the canonical record alone
    // (which now carries the unioned SMCI sell) stays reconciled — idempotent.
    const remerged = mergeRunsByDate([...merged, prevDay]).filter((r) => r.date === "2026-06-24");
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

// ── Partial sells (trims): the 50% boundary that deleted TRGP on 2026-09-15 ──────────────────
// Snapshots are taken AFTER trades execute, so `quantity` is the REMAINDER. Reconciliation is
// decided by arithmetic against the previous day's holding, never by comparing sold-vs-remainder.
describe("mergeRunsByDate: trims", () => {
  const prevDay = (qty: string) => run({
    date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
    positions: [{ symbol: "TRGP", quantity: qty, avgCost: "293.21", price: "292.00" }],
  });
  const trimDay = (remaining: string, sold: string) => run({
    date: "2026-09-15", timestamp: "2026-09-15T14:30:29.000Z",
    positions: [{ symbol: "TRGP", quantity: remaining, avgCost: "293.21", price: "286.25" }],
    trades: [trade("TRGP", "sell", sold, "286.25")],
  });
  const mergedToday = (remaining: string, sold: string, start = "1.000000") =>
    mergeRunsByDate([trimDay(remaining, sold), prevDay(start)]).find(r => r.date === "2026-09-15")!;

  for (const pct of [0.25, 0.40, 0.50, 0.51, 0.75, 0.90]) {
    it(`a ${(pct * 100).toFixed(0)}% trim keeps the remaining lot at full quantity`, () => {
      const sold = pct, remaining = 1 - pct;
      const m = mergedToday(remaining.toFixed(6), sold.toFixed(6));
      const p = (m.positions ?? []).find(x => x.symbol === "TRGP");
      expect(p).toBeDefined();
      expect(parseFloat(p!.quantity)).toBeCloseTo(remaining, 6);
    });
  }

  it("a re-reported trim (the same fill recorded twice) still does not delete the lot", () => {
    // The exact regression a timestamp-based rule reintroduced: a later run carrying a copy of the
    // morning fill made the trim look post-snapshot. Deduping by trade key defeats it.
    const copy = run({
      date: "2026-09-15", timestamp: "2026-09-15T19:00:00.000Z",
      positions: [],
      trades: [trade("TRGP", "sell", "0.500000", "286.25")],
    });
    const merged = mergeRunsByDate([copy, trimDay("0.500000", "0.500000"), prevDay("1.000000")])
      .find(r => r.date === "2026-09-15")!;
    const p = (merged.positions ?? []).find(x => x.symbol === "TRGP");
    expect(p).toBeDefined();
    expect(parseFloat(p!.quantity)).toBeCloseTo(0.5, 6);
  });

  it("with no previous-day baseline the snapshot is trusted, not guessed at", () => {
    const merged = mergeRunsByDate([trimDay("0.500000", "0.500000")]).find(r => r.date === "2026-09-15")!;
    expect(parseFloat((merged.positions ?? []).find(x => x.symbol === "TRGP")!.quantity)).toBeCloseTo(0.5, 6);
  });
});

// The case the reconciler exists for: an EARLIER snapshot that hasn't seen a LATER sell.
describe("mergeRunsByDate: stale snapshot vs a later sell", () => {
  const prevDay = run({
    date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
    positions: [pos("SMCI", "2.000000"), pos("APA", "3.000000")],
  });
  const morning = run({
    date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
    positions: [pos("SMCI", "2.000000"), pos("APA", "3.000000")], // stale: pre-sale
    agenticDailyReturn: 0.01,
  });
  const noonFullExit = run({
    date: "2026-09-15", timestamp: "2026-09-15T19:00:00.000Z",
    positions: [], trades: [trade("SMCI", "sell", "2.000000", "47")],
  });

  it("a fully-sold name is dropped from the stale snapshot", () => {
    const m = mergeRunsByDate([noonFullExit, morning, prevDay]).find(r => r.date === "2026-09-15")!;
    const syms = (m.positions ?? []).map(p => p.symbol);
    expect(syms).not.toContain("SMCI");
    expect(syms).toContain("APA");
  });

  it("a later PARTIAL sell SUBTRACTS — the stale full quantity must not survive", () => {
    const noonTrim = run({
      date: "2026-09-15", timestamp: "2026-09-15T19:00:00.000Z",
      positions: [], trades: [trade("SMCI", "sell", "1.000000", "47")],
    });
    const m = mergeRunsByDate([noonTrim, morning, prevDay]).find(r => r.date === "2026-09-15")!;
    const p = (m.positions ?? []).find(x => x.symbol === "SMCI");
    expect(p).toBeDefined();
    // 2.0 held - 1.0 sold = 1.0. Leaving 2.0 would carry phantom equity into tomorrow's baseline.
    expect(parseFloat(p!.quantity)).toBeCloseTo(1.0, 6);
  });

  it("re-merging an already-merged run is stable", () => {
    const once = mergeRunsByDate([noonFullExit, morning, prevDay]);
    const twice = mergeRunsByDate(once);
    const q = (rs: TradeRun[]) => (rs.find(r => r.date === "2026-09-15")!.positions ?? []).map(p => `${p.symbol}:${p.quantity}`);
    expect(q(twice)).toEqual(q(once));
  });
});

// ── Findings the pre-deploy review REPRODUCED against earlier versions of this fix ────────────
describe("mergeRunsByDate: reconciliation cannot delete a still-held lot", () => {
  it("a re-recorded twin at a DIFFERENT price does not double-count the sale", () => {
    // tradeKey includes avgPrice, so a twin (the same fill recorded by two runs at different price
    // estimates — see findReRecordedSells / TER 07-27) is not collapsed by key. Deriving the day's
    // sold quantity from raw runs counted it twice and deleted the remaining lot.
    const prev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
      positions: [pos("X", "2.000000")] });
    const morning = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("X", "0.500000")], trades: [trade("X", "sell", "1.500000", "50.00")] });
    const twin = run({ date: "2026-09-15", timestamp: "2026-09-15T19:00:00.000Z",
      positions: [], trades: [trade("X", "sell", "1.500000", "50.90")] });
    const m = mergeRunsByDate([twin, morning, prev]).find(r => r.date === "2026-09-15")!;
    const p = (m.positions ?? []).find(x => x.symbol === "X");
    expect(p).toBeDefined();
    expect(parseFloat(p!.quantity)).toBeCloseTo(0.5, 6);
  });

  it("an EMPTY previous-day snapshot is unknown, not a baseline of zero", () => {
    // A thin intraday stop/drop-check run legitimately carries no positions. Reading that as
    // "held nothing yesterday" made expected = 0 - sold and deleted a trimmed position.
    const thinPrev = run({ date: "2026-09-14", timestamp: "2026-09-14T19:00:00.000Z", positions: [] });
    const trimDay = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:29.000Z",
      positions: [pos("TRGP", "0.376076")], trades: [trade("TRGP", "sell", "0.376076", "286.25")] });
    const m = mergeRunsByDate([trimDay, thinPrev]).find(r => r.date === "2026-09-15")!;
    expect((m.positions ?? []).some(x => x.symbol === "TRGP")).toBe(true);
  });

  it("reconciliation never RAISES a quantity above the broker's snapshot", () => {
    // `expected` derives from the previous snapshot, which can itself be overstated. Trusting it
    // upward invents equity that becomes the next day's return baseline.
    const stalePrev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
      positions: [pos("Z", "2.000000")] });
    const today = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("Z", "0.500000")], trades: [trade("Z", "sell", "0.500000", "10")] });
    const m = mergeRunsByDate([today, stalePrev]).find(r => r.date === "2026-09-15")!;
    // expected would be 2.0 - 0.5 = 1.5; the snapshot says 0.5 and must win.
    expect(parseFloat((m.positions ?? []).find(x => x.symbol === "Z")!.quantity)).toBeCloseTo(0.5, 6);
  });
});

// ── Both HIGHs from the 4th review pass, reproduced then fixed ────────────────────────────────
describe("mergeRunsByDate: never delete a lot on incomplete or corrupt evidence", () => {
  it("a >=50% trim of a symbol MISSING from the previous snapshot is NOT deleted", () => {
    // The unknown-baseline fallback briefly compared sells against the post-trade REMAINDER — the
    // exact pre-2026-09-15 comparison this function exists to remove. A 10->5 trim whose prior lot
    // the previous snapshot missed was erased outright.
    const prev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
      positions: [pos("Z", "1.000000")] }); // note: no "A"
    const today = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("A", "5.000000"), pos("Z", "1.000000")],
      trades: [trade("A", "sell", "5.000000", "10")] });
    const m = mergeRunsByDate([today, prev]).find(r => r.date === "2026-09-15")!;
    const syms = (m.positions ?? []).map(p => p.symbol).sort();
    expect(syms).toEqual(["A", "Z"]);
    expect(parseFloat((m.positions ?? []).find(p => p.symbol === "A")!.quantity)).toBeCloseTo(5, 6);
  });

  it("over-recorded sells that findReRecordedSells cannot collapse do not delete a held lot", () => {
    // Two sells of DIFFERENT quantities at the same price are not twins by that detector's rule,
    // so the corrupt-record guard is the only thing standing between them and a deletion. It must
    // run AFTER the unknown-baseline check, not be short-circuited by it.
    const prev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
      positions: [pos("A", "8.000000"), pos("Z", "1.000000")] });
    const today = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("A", "8.000000"), pos("Z", "1.000000")],
      trades: [trade("A", "sell", "4.000000", "10"), trade("A", "sell", "5.000000", "10")] });
    const m = mergeRunsByDate([today, prev]).find(r => r.date === "2026-09-15")!;
    expect((m.positions ?? []).some(p => p.symbol === "A")).toBe(true);
    expect(parseFloat((m.positions ?? []).find(p => p.symbol === "A")!.quantity)).toBeCloseTo(8, 6);
  });
});

describe("mergeRunsByDate: absence of evidence is not evidence of absence", () => {
  it("with NO previous snapshot, even a same-day round trip is left alone", () => {
    // A carve-out for this shape was tried and removed. `snapshotQty <= bought` tests a POST-SELL
    // snapshot, so a hidden prior holding H passes whenever H <= sold and is then erased; and the
    // evidence-only form cannot tell a STALE 4 from a genuine 4. Deciding that ambiguity by
    // deletion is exactly what this function must not do. The cost is a one-day stale holding,
    // cleared by the next broker snapshot — strictly better than erasing a real position.
    const today = run({
      date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("SMCI", "4.000000"), pos("DAL", "4.000000")],
      trades: [trade("SMCI", "buy", "4", "50"), trade("SMCI", "sell", "4", "47")],
    });
    const m = mergeRunsByDate([today]).find(r => r.date === "2026-09-15")!;
    expect((m.positions ?? []).map(p => p.symbol).sort()).toEqual(["DAL", "SMCI"]);
  });

  it("but WITH a previous snapshot that omits it, the same round trip IS reconciled", () => {
    // Production always has a previous date (getRuns(60/90)), which is where registry #72 is
    // actually protected — an existing snapshot omitting SMCI is evidence it was bought today.
    const prev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z", positions: [pos("DAL", "4.000000")] });
    const today = run({
      date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("SMCI", "4.000000"), pos("DAL", "4.000000")],
      trades: [trade("SMCI", "buy", "4", "50"), trade("SMCI", "sell", "4", "47")],
    });
    const m = mergeRunsByDate([today, prev]).find(r => r.date === "2026-09-15")!;
    expect((m.positions ?? []).map(p => p.symbol)).toEqual(["DAL"]);
  });

  it("a hidden prior holding is never erased when sold >= that holding", () => {
    // The reproduced HIGH: prev thin -> null, 10 unseen shares, buy 5, sell 12, snapshot 3.
    const thinPrev = run({ date: "2026-09-14", timestamp: "2026-09-14T19:00:00.000Z", positions: [] });
    const today = run({
      date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("X", "3.000000")],
      trades: [trade("X", "buy", "5", "10"), trade("X", "sell", "12", "10")],
    });
    const m = mergeRunsByDate([today, thinPrev]).find(r => r.date === "2026-09-15")!;
    expect(parseFloat((m.positions ?? []).find(p => p.symbol === "X")!.quantity)).toBeCloseTo(3, 6);
  });

  it("with NO previous snapshot, a holding larger than today's buys is left alone", () => {
    // A thin positions-less intraday run as the previous day yields prev = null. Treating that as
    // "held nothing yesterday" computed expected = 0 + bought - sold and erased 10 of 12 held
    // shares. The documented residual: a fully-sold position may linger for ONE day, cleared by the
    // next broker snapshot, which is strictly better than deleting a real holding.
    const thinPrev = run({ date: "2026-09-14", timestamp: "2026-09-14T19:00:00.000Z", positions: [] });
    const today = run({
      date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("TSLA", "12.000000")],
      trades: [trade("TSLA", "buy", "5.000000", "300"), trade("TSLA", "sell", "3.000000", "310")],
    });
    const m = mergeRunsByDate([today, thinPrev]).find(r => r.date === "2026-09-15")!;
    expect(parseFloat((m.positions ?? []).find(p => p.symbol === "TSLA")!.quantity)).toBeCloseTo(12, 6);
  });

  it("a previous snapshot that OMITS the symbol is evidence it was bought fresh today", () => {
    const prev = run({ date: "2026-09-14", timestamp: "2026-09-14T14:30:00.000Z",
      positions: [pos("APA", "17")] }); // no NEW
    const today = run({ date: "2026-09-15", timestamp: "2026-09-15T14:30:00.000Z",
      positions: [pos("APA", "17"), pos("NEW", "1")], // stale: still lists the round-tripped name
      trades: [trade("NEW", "buy", "1", "100"), trade("NEW", "sell", "1", "101")] });
    const m = mergeRunsByDate([today, prev]).find(r => r.date === "2026-09-15")!;
    expect((m.positions ?? []).map(p => p.symbol)).toEqual(["APA"]);
  });
});

// The distinction that decides whether a missing fill price is recoverable (8th review pass).
describe("findUnpriceableTrades", () => {
  const held = [pos("KEPT", "5")];
  it("a PARTIAL sell is priceable — the position is still in today's snapshot", () => {
    // Contribution works out to fullQty*(todayP - yestP): correct mark-to-market, not zero.
    const t = [{ symbol: "KEPT", side: "sell", quantity: "5", avgPrice: "0", state: "filled" } as TradeSnapshot];
    expect(findUnpriceableTrades(held, t)).toEqual([]);
  });

  it("a sell that CLOSED the position is not priceable", () => {
    // Only yesterday's price is available, and qty*(fill - yesterday) collapses to exactly zero —
    // booking neither gain nor loss, which would erase stop-out losses from the record.
    const t = [{ symbol: "GONE", side: "sell", quantity: "5", avgPrice: "0", state: "filled" } as TradeSnapshot];
    expect(findUnpriceableTrades(held, t).map(x => x.symbol)).toEqual(["GONE"]);
  });

  it("a buy of a still-held name is priceable; a priced trade is never listed", () => {
    const t = [
      { symbol: "KEPT", side: "buy", quantity: "1", avgPrice: "0", state: "filled" } as TradeSnapshot,
      { symbol: "GONE", side: "sell", quantity: "1", avgPrice: "47.50", state: "filled" } as TradeSnapshot,
    ];
    expect(findUnpriceableTrades(held, t)).toEqual([]);
  });
});
