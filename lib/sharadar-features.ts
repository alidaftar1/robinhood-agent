// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL FEATURE RECONSTRUCTION — turns Sharadar daily bars into the SAME CaptureDay shape
// lib/feature-capture writes live, so a StrategyVariant replays over history through the exact
// code path it uses on live data (runVariantDay → toVariantDay → pick).
//
// WHY SHAPE-COMPATIBILITY IS THE POINT: if the backtest fed variants a bespoke structure, the
// thing under test would be "the variant plus a second, differently-computed feature pipeline" —
// and a divergence between the two would look like alpha. Emitting CaptureDay means history and
// live go through one pipeline.
//
// FORMULAS ARE COPIED FROM lib/market-data DELIBERATELY, index-for-index, and momentumScore is
// IMPORTED rather than reimplemented. A backtest whose features are computed even slightly
// differently from production is a backtest of a different strategy — the most common way a
// promising result fails to reproduce live.
//
// TWO PRICE SERIES, ON PURPOSE:
//   · FEATURES use `close` (split-adjusted, NOT dividend-adjusted) because that is what the live
//     path gets from Yahoo's chart endpoint. Using a dividend-adjusted series would shift every
//     momentum reading by roughly the trailing yield and silently re-rank high-yield names.
//   · P&L uses `closeadj` (split AND dividend adjusted), because a portfolio actually receives
//     dividends and ignoring them understates returns — materially so across 2000-2008.
// Mixing these up in either direction is a real error, so they are separate fields here.
// ─────────────────────────────────────────────────────────────────────────────

import { momentumScore } from "./market-data";
import { CAPTURE_COLUMNS, type CaptureDay } from "./feature-capture";

export interface Bar {
  date: string;
  close: number;      // split-adjusted — FEATURES
  high: number;       // split-adjusted — 52-week high
  closeadj: number;   // split + dividend adjusted — P&L
}

/** One symbol's full history, ascending by date. */
export type Series = Map<string, Bar[]>;

/** Population stdev of daily returns, annualized, in percent. Mirrors annualizedVol in
 *  lib/market-data — including its ÷n (population, not sample) variance and its <3 sentinel. */
export function annualizedVol(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) r.push(closes[i] / closes[i - 1] - 1);
  }
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

export interface HistoricalFeatures {
  symbol: string;
  price: number;
  mom12_1: number | null;
  change5d: number;
  change14d: number;
  change30d: number;
  volatility30d: number;
  distFrom52wHigh: number;
}

/**
 * Features for one symbol as of index `i` in its own bar series.
 *
 * INDEXING IS THE WHOLE RISK HERE. lib/market-data computes against `validCloses` where the LAST
 * element is today, so `validCloses[n-22]` is ~21 trading days back and `validCloses[n-253]` is
 * ~252 back. With `i` as today, those become closes[i-21] and closes[i-252]. An off-by-one in
 * either direction leaks a day of future information or silently shortens the formation window.
 *
 * Returns null when there is not enough history — NEVER a zero-filled row. lib/feature-capture's
 * own comment explains why: a row whose change/distance columns fall back to 0 reads as "flat and
 * sitting at its 52-week high", the strongest possible momentum signal, manufactured out of
 * missing data.
 */
export function featuresAt(bars: Bar[], i: number): HistoricalFeatures | null {
  if (i < 0 || i >= bars.length) return null;
  const price = bars[i].close;
  if (!Number.isFinite(price) || price <= 0) return null;

  // Need at least 22 bars of trailing window for vol / 30d; below that the row is unusable.
  if (i < 21) return null;
  const closeAt = (k: number) => (k >= 0 && k < bars.length ? bars[k].close : null);

  const monthAgo = closeAt(i - 21);
  if (monthAgo == null || monthAgo <= 0) return null;
  const fiveAgo = closeAt(i - 5) ?? monthAgo;
  const fourteenAgo = closeAt(i - 10) ?? monthAgo;

  const window = bars.slice(i - 21, i + 1).map(b => b.close);   // 22 bars, matching slice(-22)
  const vol = annualizedVol(window);

  // 12-1: return from ~252 trading days ago to ~21 trading days ago. Needs 253 bars of history.
  const back252 = closeAt(i - 252);
  const mom12_1 = i >= 252 && back252 != null && back252 > 0 && monthAgo > 0
    ? (monthAgo / back252 - 1) * 100
    : null;

  // 52-week high from trailing intraday HIGHS (what Yahoo's fiftyTwoWeekHigh reports), not closes.
  let high52 = 0;
  for (let k = Math.max(0, i - 251); k <= i; k++) if (bars[k].high > high52) high52 = bars[k].high;

  return {
    symbol: "",
    price,
    mom12_1,
    change5d: fiveAgo > 0 ? ((price - fiveAgo) / fiveAgo) * 100 : 0,
    change14d: fourteenAgo > 0 ? ((price - fourteenAgo) / fourteenAgo) * 100 : 0,
    change30d: ((price - monthAgo) / monthAgo) * 100,
    volatility30d: vol,
    distFrom52wHigh: high52 > 0 ? ((price - high52) / high52) * 100 : 0,
  };
}

const idxOf = (c: string) => CAPTURE_COLUMNS.indexOf(c as never);

/**
 * Build a CaptureDay for one date from per-symbol series.
 *
 * `members` MUST come from the point-in-time universe resolver — passing today's S&P 500 is the
 * survivorship bug this whole exercise exists to avoid.
 *
 * qualityPct is supplied by the caller from lib/sharadar-quality (point-in-time, keyed on FILING
 * dates). When omitted the column is NULL and LIVE_PROXY degrades to momentum-only — a REAL
 * fidelity gap that must be reported with any result rather than quietly absorbed.
 *
 * Remaining unfillable columns (peTTM, peFY, daysToEarnings) stay NULL rather than taking a neutral
 * default: 0 is a real, rankable value for every one of them.
 */
export function buildCaptureDayFromHistory(
  date: string,
  members: Set<string>,
  series: Series,
  indexByDate: Map<string, Map<string, number>>,
  spyClose: number | null,
  /** symbol -> cross-sectional quality percentile for THIS date, from lib/sharadar-quality.
   *  Omit to run momentum-only (the pre-Bundle behaviour) — the column then reads null and
   *  LIVE_PROXY degrades, which is a REAL fidelity gap and must be reported, not absorbed. */
  qualityPct?: Map<string, number>,
): CaptureDay {
  const rows: CaptureDay["rows"] = [];
  const posForDate = indexByDate.get(date);
  if (posForDate) {
    for (const symbol of members) {
      const bars = series.get(symbol);
      const i = posForDate.get(symbol);
      if (!bars || i == null) continue;          // no bar THAT day (halted, pre-listing) → omit
      const f = featuresAt(bars, i);
      if (!f) continue;                          // insufficient history → omit, never zero-fill
      const row: Array<string | number | null> = CAPTURE_COLUMNS.map(() => null);
      row[idxOf("symbol")] = symbol;
      row[idxOf("price")] = r4(f.price);
      row[idxOf("mom12_1")] = r4(f.mom12_1);
      row[idxOf("change5d")] = r4(f.change5d);
      row[idxOf("change14d")] = r4(f.change14d);
      row[idxOf("change30d")] = r4(f.change30d);
      // 0 is annualizedVol's "series too short" sentinel and lib/strategy-variant DROPS null-vol
      // rows as suspect. Map the sentinel to null so that guard actually fires here too.
      row[idxOf("volatility30d")] = f.volatility30d === 0 ? null : r4(f.volatility30d);
      row[idxOf("distFrom52wHigh")] = r4(f.distFrom52wHigh);
      row[idxOf("sharpe5d")] = r4(momentumScore(f.change5d, 5, f.volatility30d));
      row[idxOf("sharpe14d")] = r4(momentumScore(f.change14d, 10, f.volatility30d));
      row[idxOf("sharpe30d")] = r4(momentumScore(f.change30d, 21, f.volatility30d));
      // null when this name had no filing public by `date` — NOT 0, which is a real (worst)
      // percentile and would rank an unknown name as definitively low-quality.
      const q = qualityPct?.get(symbol);
      row[idxOf("qualityPct")] = q == null ? null : r4(q);
      rows.push(row);
    }
  }
  return {
    v: 1,
    date,
    capturedAt: `${date}T21:00:00Z`,
    // Historical SPY is either present or the day is unusable — same contract as the live capture,
    // where a missing SPY poisons every relative column.
    spyAvailable: spyClose != null && spyClose > 0,
    spyPrice: spyClose,
    columns: CAPTURE_COLUMNS,
    rows,
  };
}

const r4 = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(4));

/** date → (symbol → index into that symbol's bar array). Built once; makes per-day lookup O(1). */
export function buildDateIndex(series: Series): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [symbol, bars] of series) {
    for (let i = 0; i < bars.length; i++) {
      let m = out.get(bars[i].date);
      if (!m) { m = new Map(); out.set(bars[i].date, m); }
      m.set(symbol, i);
    }
  }
  return out;
}
