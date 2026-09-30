import { describe, test, expect } from "bun:test";
import { featuresAt, annualizedVol, buildDateIndex, buildCaptureDayFromHistory, type Bar } from "@/lib/sharadar-features";
import { toVariantDay, runVariantDay, LIVE_PROXY } from "@/lib/strategy-variant";
import { CAPTURE_COLUMNS } from "@/lib/feature-capture";

// The whole risk in this module is INDEXING. lib/market-data computes against a series whose LAST
// element is today, so one index in the wrong direction either leaks a day of future information
// or silently shortens the formation window — and neither shows up as an error, only as a
// backtest that looks better than reality.

/** n ascending bars at a constant daily growth rate, so every window has a known answer. */
function ramp(n: number, start = 100, growth = 0.001): Bar[] {
  const out: Bar[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, close: c, high: c, closeadj: c });
    c *= 1 + growth;
  }
  return out;
}

/**
 * Ramp plus a deterministic zigzag. PERFECTLY constant growth has EXACTLY zero volatility, which
 * is annualizedVol's "series too short / broken" sentinel — so such rows are dropped as suspect by
 * lib/strategy-variant, and a fixture built on `ramp` alone produces a variant that sees nothing.
 * Deterministic (no Math.random) so the test cannot flake.
 */
function wiggle(n: number, start = 100, growth = 0.001, amp = 0.004): Bar[] {
  const out: Bar[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const w = c * (1 + (i % 2 === 0 ? amp : -amp));
    out.push({ date, close: w, high: w * 1.002, closeadj: w });
    c *= 1 + growth;
  }
  return out;
}

describe("NO LOOK-AHEAD: features at index i depend only on bars 0..i", () => {
  test("appending wildly different FUTURE bars does not change features at i", () => {
    const base = ramp(300);
    const i = 260;
    const before = featuresAt(base, i);

    // Same history, then a catastrophic future. If any formula reached forward, this would move.
    const withFuture = [...base];
    for (let k = 0; k < 40; k++) {
      const d = new Date(Date.UTC(2000, 0, 1) + (300 + k) * 86_400_000).toISOString().slice(0, 10);
      withFuture.push({ date: d, close: 1, high: 1, closeadj: 1 });   // −99%
    }
    const after = featuresAt(withFuture, i);
    expect(after).toEqual(before);
  });

  test("the 52-week high never sees a future peak", () => {
    const bars = ramp(300);
    const i = 260;
    const before = featuresAt(bars, i)!.distFrom52wHigh;
    const withSpike = [...bars];
    withSpike[i + 5] = { ...withSpike[i + 5], high: 100000 };   // enormous future high
    expect(featuresAt(withSpike, i)!.distFrom52wHigh).toBe(before);
  });
});

describe("indexing matches lib/market-data index-for-index", () => {
  test("mom12_1 is closes[i-21] / closes[i-252] − 1, the 12-month formation skipping a month", () => {
    const bars = ramp(400);
    const i = 300;
    const expected = (bars[i - 21].close / bars[i - 252].close - 1) * 100;
    expect(featuresAt(bars, i)!.mom12_1).toBeCloseTo(expected, 9);
  });

  test("mom12_1 is NULL below 253 bars of history — never 0, which is a rankable value", () => {
    expect(featuresAt(ramp(300), 251)!.mom12_1).toBeNull();
    expect(featuresAt(ramp(300), 252)!.mom12_1).not.toBeNull();   // boundary: exactly enough
  });

  test("change5d / change14d / change30d anchor at i-5, i-10, i-21", () => {
    const bars = ramp(300);
    const i = 280;
    const f = featuresAt(bars, i)!;
    expect(f.change5d).toBeCloseTo((bars[i].close / bars[i - 5].close - 1) * 100, 9);
    expect(f.change14d).toBeCloseTo((bars[i].close / bars[i - 10].close - 1) * 100, 9);
    expect(f.change30d).toBeCloseTo((bars[i].close / bars[i - 21].close - 1) * 100, 9);
  });

  test("insufficient history yields NULL, never a zero-filled row", () => {
    // A zero-filled row reads as "flat and sitting at its 52-week high" — the strongest possible
    // momentum signal, manufactured out of missing data.
    expect(featuresAt(ramp(300), 5)).toBeNull();
    expect(featuresAt(ramp(300), 20)).toBeNull();
    expect(featuresAt(ramp(300), 21)).not.toBeNull();   // boundary
  });
});

describe("annualizedVol mirrors lib/market-data's definition", () => {
  test("a perfectly constant-growth series has ~zero volatility", () => {
    expect(annualizedVol(ramp(30).map(b => b.close))).toBeCloseTo(0, 6);
  });

  test("returns the <3-close sentinel of 0 rather than throwing", () => {
    expect(annualizedVol([100, 101])).toBe(0);
    expect(annualizedVol([])).toBe(0);
  });

  test("uses POPULATION variance (÷n), matching production", () => {
    const closes = [100, 110, 100, 110];   // alternating ±10%
    const r = [0.1, -1 / 11, 0.1];
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const pop = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
    expect(annualizedVol(closes)).toBeCloseTo(Math.sqrt(pop) * Math.sqrt(252) * 100, 6);
  });
});

describe("the historical CaptureDay is shape-compatible with the live capture", () => {
  // wiggle(), not ramp(): constant growth gives EXACTLY zero vol, which is the broken-series
  // sentinel, and lib/strategy-variant correctly drops those rows — leaving the variant nothing
  // to pick from. The guard was right; the first fixture was wrong.
  const series = new Map([
    ["AAPL", wiggle(300, 100, 0.002)],
    ["JPM", wiggle(300, 50, 0.0005)],
    ["KO", wiggle(300, 60, 0.001)],
  ]);
  const dateIdx = buildDateIndex(series);
  const date = series.get("AAPL")![260].date;

  test("a variant replays over history through the SAME code path as live", () => {
    const day = buildCaptureDayFromHistory(date, new Set(["AAPL", "JPM", "KO"]), series, dateIdx, 400);
    expect(day.columns).toEqual(CAPTURE_COLUMNS);
    const res = runVariantDay(LIVE_PROXY, day);
    expect(res.error).toBeUndefined();
    // Highest 12-1 momentum wins: AAPL grows fastest.
    expect(res.picks[0].symbol).toBe("AAPL");
  });

  test("columns the Prices plan cannot fill are NULL, not a neutral default", () => {
    const day = buildCaptureDayFromHistory(date, new Set(["AAPL"]), series, dateIdx, 400);
    const vd = toVariantDay(day);
    expect(vd.rows[0].get("qualityPct")).toBeNull();
    expect(vd.rows[0].get("peTTM")).toBeNull();
    expect(vd.rows[0].get("daysToEarnings")).toBeNull();
    // And momentum IS present — so this can't pass by nulling everything.
    expect(vd.rows[0].get("mom12_1")).not.toBeNull();
  });

  test("a symbol NOT in the point-in-time universe is excluded, however good its data", () => {
    // Passing today's index members instead of the as-of members is the survivorship bug.
    const day = buildCaptureDayFromHistory(date, new Set(["JPM"]), series, dateIdx, 400);
    expect(day.rows.length).toBe(1);
    expect(runVariantDay(LIVE_PROXY, day).picks.map(p => p.symbol)).toEqual(["JPM"]);
  });

  test("a missing SPY marks the day unusable, matching the live capture's contract", () => {
    const day = buildCaptureDayFromHistory(date, new Set(["AAPL"]), series, dateIdx, null);
    expect(day.spyAvailable).toBe(false);
    expect(runVariantDay(LIVE_PROXY, day).error).toContain("SPY unavailable");
  });

  test("a ZERO-VOL series is emitted as null vol and dropped, not ranked as fabricated strength", () => {
    // annualizedVol returns 0 for a broken/too-short series, and on such a row the change and
    // distance columns are sentinels that read as "flat and sitting at its 52-week high" — the
    // strongest possible momentum signal, manufactured out of missing data. Mapping 0 -> null is
    // what makes lib/strategy-variant's suspect-row guard actually fire on historical data.
    // (A mutation that removed the mapping initially went UNCAUGHT: the main fixture uses wiggle(),
    // which has real volatility, so nothing exercised the sentinel path.)
    const flat = new Map([["FLAT", ramp(300, 100, 0.002)]]);   // constant growth -> vol exactly 0
    const fIdx = buildDateIndex(flat);
    const d = flat.get("FLAT")![260].date;
    const day = buildCaptureDayFromHistory(d, new Set(["FLAT"]), flat, fIdx, 400);
    expect(day.rows.length).toBe(1);
    expect(day.rows[0][CAPTURE_COLUMNS.indexOf("volatility30d")]).toBeNull();
    expect(toVariantDay(day).rows.length).toBe(0);                 // dropped as suspect
    expect(runVariantDay(LIVE_PROXY, day).picks).toEqual([]);
  });

  test("a symbol with no bar THAT day is omitted rather than carried forward", () => {
    // A halted or not-yet-listed name must not silently reuse a stale price.
    const day = buildCaptureDayFromHistory(date, new Set(["AAPL", "NOTLISTED"]), series, dateIdx, 400);
    expect(day.rows.map(r => r[0])).toEqual(["AAPL"]);
  });
});
