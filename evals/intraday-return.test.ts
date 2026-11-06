/**
 * INTRADAY-EXIT RETURN WINDOW — an exit after the 07:30 run must not open a hole in the record.
 *
 * 2026-11-05: the 07:30 run stored the day's return, then the 11:00 drop-check sold MU and BE.
 * mergeRunsByDate took the holdings from the drop-check but the TOTAL from the 07:30 run, and the
 * day's return was never recomputed. MU/BE's 07:30→sale loss belonged to no day: 11-06 booked it
 * as a −$33.72 "transfer" and published +0.88% for a day the account fell 0.71%.
 *
 * The invariant: chained day returns equal the account's real change when no money moved.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { mergeRunsByDate, dayReturnFromMerged, computeDailyReturn, runsToRecompute, type TradeRun } from "@/lib/run-store";

const pos = (symbol: string, quantity: number, price: number) =>
  ({ symbol, quantity: String(quantity), avgCost: "10.00", price: String(price) });
const run = (date: string, time: string, o: Partial<TradeRun>): TradeRun => ({
  timestamp: `${date}T${time}:00.000Z`, date, summary: "", positions: [], trades: [],
  market: { stocksLoaded: 0, headlinesLoaded: 0 }, portfolioAfter: null, influencerPositions: [], ...o,
} as TradeRun);
const pa = (total: number, cash: number) => ({ totalValue: total.toFixed(2), cash: cash.toFixed(2), equity: (total - cash).toFixed(2) });

// D1 07:30 300 total. D2 07:30: unchanged at 300 (A up, M down). D2 11:00 drop-check sells M at 7,
// A has risen to 12: total 290. D3 07:30: flat at 290. Real change D1→D3: −10 (−3.33%), no transfer.
const d1 = run("2026-11-04", "15:30", { positions: [pos("A", 10, 10), pos("M", 10, 10)], portfolioAfter: pa(300, 100), agenticDailyReturn: 0 });
const d2am = run("2026-11-05", "15:30", { positions: [pos("A", 10, 11), pos("M", 10, 9)], portfolioAfter: pa(300, 100), agenticDailyReturn: 0, spyPrice: 600 });
const d2stop = run("2026-11-05", "19:00", {
  positions: [pos("A", 10, 12)], portfolioAfter: pa(290, 170), spyPrice: 594,
  trades: [{ symbol: "M", side: "sell", quantity: "10", avgPrice: "7", state: "filled", actor: "agent" }],
});
const d3 = run("2026-11-06", "15:30", { positions: [pos("A", 10, 12)], portfolioAfter: pa(290, 170) });

describe("intraday exit: the day's snapshot is one snapshot", () => {
  const merged = mergeRunsByDate([d3, d2stop, d2am, d1]);
  const day2 = merged.find(r => r.date === "2026-11-05")!;

  it("the merged day takes the total and SPY mark from the same run as its holdings", () => {
    expect(day2.positions.map(p => p.symbol)).toEqual(["A"]);
    expect(day2.portfolioAfter?.totalValue).toBe("290.00");
    expect(day2.spyPrice).toBe(594);
    expect(day2.trades?.length).toBe(1);
  });

  it("recomputed from the merged day, the exit day carries the 07:30→exit move", () => {
    const r = dayReturnFromMerged(merged, "2026-11-05", true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentic!.dailyReturn).toBeCloseTo(-10 / 300, 10);
    expect(Math.abs(r.agentic!.impliedTransfer)).toBeLessThan(1e-9);
    expect(r.sleeves.mainDailyReturn).toBeCloseTo(-10 / 200, 10); // the sleeve is measured on invested value, not cash
  });

  it("chained with the next day it equals the real account change, with no phantom transfer", () => {
    const r2 = dayReturnFromMerged(merged, "2026-11-05", true);
    const r3 = dayReturnFromMerged(merged, "2026-11-06", true);
    if (!r2.ok || !r3.ok) throw new Error("expected both days to compute");
    expect((1 + r2.agentic!.dailyReturn) * (1 + r3.agentic!.dailyReturn) - 1).toBeCloseTo(290 / 300 - 1, 10);
    expect(Math.abs(r3.agentic!.impliedTransfer)).toBeLessThan(1e-9);
  });

  it("the old pairing (07:30 total beside the exit's holdings) is what produced the phantom transfer", () => {
    // Pins the failure mode: if the overlay is removed, this is the number the next day reads.
    const mixed = computeDailyReturn(290, 300, d3.positions, d2stop.positions, []);
    expect(mixed!.dailyReturn).toBe(0);
    expect(mixed!.impliedTransfer).toBeCloseTo(-10, 10);
  });

  it("refuses a book that does not reconcile (an unrecorded owner buy) when asked to", () => {
    const owner = run("2026-11-05", "20:00", { positions: [pos("A", 10, 12), pos("B", 5, 10)], portfolioAfter: pa(290, 120) });
    const m = mergeRunsByDate([d3, owner, d2stop, d2am, d1]);
    const r = dayReturnFromMerged(m, "2026-11-05", true);
    expect(r.ok).toBe(false);
    expect(dayReturnFromMerged(m, "2026-11-05", false).ok).toBe(true);
  });

  it("a run with holdings but no total does not blank the day's total", () => {
    const noTotal = run("2026-11-05", "20:00", { positions: [pos("A", 10, 12)], portfolioAfter: null });
    const m = mergeRunsByDate([noTotal, d2stop, d2am, d1]);
    expect(m.find(r => r.date === "2026-11-05")!.portfolioAfter?.totalValue).toBe("300.00");
  });
});

describe("intraday exit writers recompute the day after saving", () => {
  for (const route of ["drop-check", "earnings-exit"]) {
    it(`/api/${route} calls recomputeDayReturn with requireReconciled after saveRun, gated on the save not on a sale`, () => {
      const src = readFileSync(join(import.meta.dir, "..", "app", "api", route, "route.ts"), "utf8");
      const save = src.indexOf("await saveRun(");
      const recompute = src.indexOf("recomputeDayReturn(today, { requireReconciled: true })");
      expect(save).toBeGreaterThan(-1);
      expect(recompute).toBeGreaterThan(save);
    });
  }
});

describe("which runs a recompute writes", () => {
  it("only runs that already carry a return — a thin exit run stays null", () => {
    const w = runsToRecompute([d2stop, d2am], false);
    expect([...w]).toEqual([d2am]);
  });
  it("an exit BEFORE the trade run (no return-bearing run yet) writes nothing, so the trade run's own return wins", () => {
    expect(runsToRecompute([d2stop], false).size).toBe(0);
  });
  it("a withheld day (07:30 run null) is not filled by an intraday run", () => {
    const withheld = { ...d2am, agenticDailyReturn: null };
    expect(runsToRecompute([d2stop, withheld], false).size).toBe(0);
  });
  it("patchDate (writeIfNone) still fills an all-null day, on its newest run", () => {
    const withheld = { ...d2am, agenticDailyReturn: null };
    expect([...runsToRecompute([d2stop, withheld], true)]).toEqual([d2stop]);
  });
});
