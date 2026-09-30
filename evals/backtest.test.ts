import { describe, test, expect } from "bun:test";
import { maxDrawdown, runBacktest, DEFAULT_BACKTEST, type BacktestConfig } from "@/lib/backtest";
import { CAPTURE_COLUMNS, type CaptureDay } from "@/lib/feature-capture";
import type { StrategyVariant } from "@/lib/strategy-variant";

const col = (n: string) => CAPTURE_COLUMNS.indexOf(n as never);

function mkDay(date: string, syms: Array<{ s: string; px: number }>, spy: number | null = 100): CaptureDay {
  return {
    v: 1, date, capturedAt: `${date}T21:00:00Z`,
    spyAvailable: spy != null, spyPrice: spy,
    columns: CAPTURE_COLUMNS,
    rows: syms.map(({ s, px }) => {
      const r: Array<string | number | null> = CAPTURE_COLUMNS.map(() => null);
      r[col("symbol")] = s;
      r[col("price")] = px;
      r[col("volatility30d")] = 20;     // non-null so the row is usable
      r[col("mom12_1")] = 10;
      return r;
    }),
  };
}

/** Always buys the named symbols, in order. */
const fixedVariant = (syms: string[]): StrategyVariant => ({
  id: "fixed", description: "buys a fixed list",
  registeredAt: "1990-01-01",
  criteria: { minExcessReturnPct: 0, minSymbolsScored: 1, minHitRatePct: 0 },
  config: { maxPositions: syms.length, maxPerSector: 4 },
  pick: (d) => d.rows.filter(r => syms.includes(r.symbol)).map(r => ({ symbol: r.symbol })),
});

describe("maxDrawdown", () => {
  test("a monotonically rising series has zero drawdown", () => {
    expect(maxDrawdown([100, 101, 102, 103]).pct).toBe(0);
  });

  test("reports the worst PEAK-TO-TROUGH decline, not first-to-last", () => {
    // Ends higher than it started, but fell 50% along the way.
    const r = maxDrawdown([100, 200, 100, 250]);
    expect(r.pct).toBeCloseTo(-50, 6);
    expect(r.fromIdx).toBe(1);
    expect(r.toIdx).toBe(2);
  });

  test("measures from the PEAK, not from the start", () => {
    // Rises to 200 then falls to 150: −25% from peak, not −(150−100)/100.
    expect(maxDrawdown([100, 200, 150]).pct).toBeCloseTo(-25, 6);
  });

  test("keeps the DEEPEST of several drawdowns", () => {
    expect(maxDrawdown([100, 90, 100, 60, 100]).pct).toBeCloseTo(-40, 6);
  });
});

describe("the engine measures what it claims", () => {
  const cfg: BacktestConfig = { rebalanceEveryDays: 1000, stopLossPct: null, stopMode: "same-day" as const, costBps: 0, startingCapital: 1000 };

  test("a name that halves halves the book, and the drawdown says so", () => {
    const days = [
      mkDay("2008-01-02", [{ s: "AAPL", px: 100 }], 100),
      mkDay("2008-01-03", [{ s: "AAPL", px: 50 }], 100),
    ];
    const priceOf = (d: string, s: string) => (d === "2008-01-02" ? 100 : 50);
    const r = runBacktest(fixedVariant(["AAPL"]), days, priceOf, () => 100, cfg);
    expect(r.totalReturnPct).toBeCloseTo(-50, 4);
    expect(r.maxDrawdownPct).toBeCloseTo(-50, 4);
  });

  test("SPY drawdown is computed independently of the book", () => {
    const days = [
      mkDay("2020-02-19", [{ s: "AAPL", px: 100 }], 337),
      mkDay("2020-03-23", [{ s: "AAPL", px: 100 }], 222),
    ];
    const r = runBacktest(fixedVariant(["AAPL"]), days, () => 100, (d) => (d === "2020-02-19" ? 337 : 222), cfg);
    expect(r.maxDrawdownPct).toBeCloseTo(0, 4);          // book flat
    expect(r.spyMaxDrawdownPct!).toBeCloseTo(-34.12, 1); // SPY fell ~34%
  });

  test("a missing SPY yields NULL, never 0 — 0 would read as 'matched the market'", () => {
    const days = [mkDay("2008-01-02", [{ s: "AAPL", px: 100 }], null)];
    const r = runBacktest(fixedVariant(["AAPL"]), days, () => 100, () => null, cfg);
    expect(r.spyReturnPct).toBeNull();
    expect(r.spyMaxDrawdownPct).toBeNull();
  });
});

describe("stops behave as the live book's do", () => {
  test("a position past the stop exits, and is counted", () => {
    const cfg: BacktestConfig = { rebalanceEveryDays: 1000, stopLossPct: -5, stopMode: "from-entry" as const, costBps: 0, startingCapital: 1000 };
    const days = [
      mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]),
      mkDay("2008-01-03", [{ s: "AAPL", px: 90 }]),     // −10% → stop
      mkDay("2008-01-04", [{ s: "AAPL", px: 50 }]),     // further collapse, already out
    ];
    const px: Record<string, number> = { "2008-01-02": 100, "2008-01-03": 90, "2008-01-04": 50 };
    const r = runBacktest(fixedVariant(["AAPL"]), days, (d) => px[d], () => 100, cfg);
    expect(r.stopOuts).toBe(1);
    // Stopped at 90, so the book keeps ~−10% and does NOT ride to −50%.
    expect(r.totalReturnPct).toBeCloseTo(-10, 1);
    expect(r.daysFlat).toBeGreaterThan(0);              // to cash — the only de-risking there is
  });

  test("with stops DISABLED the same book rides all the way down", () => {
    // Control: proves the stop test above is measuring the stop, not the price path.
    const cfg: BacktestConfig = { rebalanceEveryDays: 1000, stopLossPct: null, stopMode: "same-day" as const, costBps: 0, startingCapital: 1000 };
    const days = [
      mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]),
      mkDay("2008-01-03", [{ s: "AAPL", px: 90 }]),
      mkDay("2008-01-04", [{ s: "AAPL", px: 50 }]),
    ];
    const px: Record<string, number> = { "2008-01-02": 100, "2008-01-03": 90, "2008-01-04": 50 };
    const r = runBacktest(fixedVariant(["AAPL"]), days, (d) => px[d], () => 100, cfg);
    expect(r.stopOuts).toBe(0);
    expect(r.totalReturnPct).toBeCloseTo(-50, 1);
  });

  test("stops are evaluated on CLOSES — an intraday dip that recovers does NOT trigger", () => {
    // Documented limitation, asserted so it stays a known property rather than a surprise: this
    // UNDERSTATES stop-outs and flatters fast crashes.
    const cfg: BacktestConfig = { rebalanceEveryDays: 1000, stopLossPct: -5, stopMode: "from-entry" as const, costBps: 0, startingCapital: 1000 };
    const days = [mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]), mkDay("2008-01-03", [{ s: "AAPL", px: 99 }])];
    const px: Record<string, number> = { "2008-01-02": 100, "2008-01-03": 99 };
    const r = runBacktest(fixedVariant(["AAPL"]), days, (d) => px[d], () => 100, cfg);
    expect(r.stopOuts).toBe(0);
  });
});

describe("costs and unpriceable names", () => {
  test("costs reduce the return — a zero-cost run must beat a costly one", () => {
    const days = [
      mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]),
      mkDay("2008-01-03", [{ s: "AAPL", px: 100 }]),
    ];
    const free = runBacktest(fixedVariant(["AAPL"]), days, () => 100, () => 100,
      { rebalanceEveryDays: 1, stopLossPct: null, stopMode: "same-day" as const, costBps: 0, startingCapital: 1000 });
    const costly = runBacktest(fixedVariant(["AAPL"]), days, () => 100, () => 100,
      { rebalanceEveryDays: 1, stopLossPct: null, stopMode: "same-day" as const, costBps: 100, startingCapital: 1000 });
    expect(costly.totalReturnPct).toBeLessThan(free.totalReturnPct);
  });

  test("a name with NO price is held at cost, not liquidated at an invented price", () => {
    const cfg: BacktestConfig = { rebalanceEveryDays: 1000, stopLossPct: -5, stopMode: "from-entry" as const, costBps: 0, startingCapital: 1000 };
    const days = [
      mkDay("2008-09-12", [{ s: "LEHMQ", px: 100 }]),
      mkDay("2008-09-15", [{ s: "LEHMQ", px: 100 }]),
    ];
    const priceOf = (d: string) => (d === "2008-09-12" ? 100 : null);   // stops trading
    const r = runBacktest(fixedVariant(["LEHMQ"]), days, priceOf, () => 100, cfg);
    expect(r.stopOuts).toBe(0);
    expect(Number.isFinite(r.totalReturnPct)).toBe(true);   // no NaN leaking into equity
  });

  test("an empty range reports no usable days rather than dividing by zero", () => {
    const r = runBacktest(fixedVariant(["AAPL"]), [], () => 100, () => 100, DEFAULT_BACKTEST);
    expect(r.days).toBe(0);
    expect(r.notes.join(" ")).toContain("no usable days");
  });
});

// The two stop modes are DIFFERENT STRATEGIES, not a config detail. The live main book uses
// same-day (MAIN_DROP_THRESHOLD_PCT = -5, "same-day move, from prev close"); the influencer sleeve
// uses from-entry. The first bear-test run defaulted to from-entry by mistake and reported a GFC
// drawdown materially worse than the live rules would produce.
describe("stopMode: same-day vs from-entry are provably different", () => {
  // A slow bleed: −2%/day for four days. Cumulative −8% (trips from-entry at −5%), but no single
  // day is worse than −2% (never trips same-day at −5%).
  const bleed = [
    mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]),
    mkDay("2008-01-03", [{ s: "AAPL", px: 98 }]),
    mkDay("2008-01-04", [{ s: "AAPL", px: 96 }]),
    mkDay("2008-01-05", [{ s: "AAPL", px: 94 }]),
    mkDay("2008-01-06", [{ s: "AAPL", px: 92 }]),
  ];
  const px: Record<string, number> = {
    "2008-01-02": 100, "2008-01-03": 98, "2008-01-04": 96, "2008-01-05": 94, "2008-01-06": 92,
  };
  const base = { rebalanceEveryDays: 1000, stopLossPct: -5, costBps: 0, startingCapital: 1000 };

  test("a SLOW BLEED trips from-entry but NOT same-day", () => {
    const fromEntry = runBacktest(fixedVariant(["AAPL"]), bleed, (d) => px[d], () => 100,
      { ...base, stopMode: "from-entry" });
    const sameDay = runBacktest(fixedVariant(["AAPL"]), bleed, (d) => px[d], () => 100,
      { ...base, stopMode: "same-day" });
    expect(fromEntry.stopOuts).toBe(1);
    expect(sameDay.stopOuts).toBe(0);      // this is the live main-book behaviour
  });

  test("a ONE-DAY CRASH trips same-day", () => {
    const crash = [
      mkDay("2008-01-02", [{ s: "AAPL", px: 100 }]),
      mkDay("2008-01-03", [{ s: "AAPL", px: 100 }]),
      mkDay("2008-01-04", [{ s: "AAPL", px: 90 }]),   // −10% in one day
    ];
    const cpx: Record<string, number> = { "2008-01-02": 100, "2008-01-03": 100, "2008-01-04": 90 };
    const r = runBacktest(fixedVariant(["AAPL"]), crash, (d) => cpx[d], () => 100,
      { ...base, stopMode: "same-day" });
    expect(r.stopOuts).toBe(1);
  });

  test("with no previous close the same-day stop does NOT fall back to entry", () => {
    // Falling back would silently convert the live stop into the tighter cumulative one — which is
    // exactly the bug this mode exists to prevent.
    const one = [mkDay("2008-01-02", [{ s: "AAPL", px: 100 }])];
    const r = runBacktest(fixedVariant(["AAPL"]), one, () => 50, () => 100,   // "price" far below
      { ...base, stopMode: "same-day" });
    expect(r.stopOuts).toBe(0);
  });
});
