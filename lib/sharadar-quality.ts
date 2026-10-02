// ─────────────────────────────────────────────────────────────────────────────
// POINT-IN-TIME QUALITY — the backtest-safe counterpart to lib/quality.ts.
//
// lib/quality.ts cannot be reused here, and says so itself: "these are the LATEST available fiscal
// year's numbers. For LIVE/forward trading that is correct (you screen today on what's known
// today). It is only a problem for BACKTESTS (look-ahead)." So this module recomputes the SAME
// composite from Sharadar SF1, keyed on the FILING date rather than the period end.
//
// THREE WAYS TO GET THIS WRONG, all of which look like alpha:
//
// 1. USING reportperiod INSTEAD OF date. Apple's FY2008 ended 2008-09-27 but was not filed until
//    2008-11-05 — a 39-day lag, the same lag behind the stale-EPS bug in lib/valuation. Screening
//    on 2008-10-01 using FY2008 numbers means trading on a report nobody had yet.
//
// 2. USING RESTATED FIGURES. Sharadar exposes AR* (as-reported) and MR* (most-recent, restated)
//    dimensions for the same period. MR* embeds revisions made LATER, so a restatement that
//    corrected a fraud would retroactively improve the quality score on dates before anyone knew.
//    ARY only, always.
//
// 3. SCORING A PERCENTILE AGAINST THE WRONG COHORT. Quality here is CROSS-SECTIONAL — a percentile
//    against the universe on that date. Computing it against today's universe, or against all
//    filings ever, changes what "above median" means. The cohort must be the point-in-time index
//    membership for that date, nothing else.
//
// The composite itself is copied term-for-term from lib/quality.ts: ROA percentile, plus ROE
// percentile when equity is positive, plus inverted leverage percentile when the leverage term is
// meaningful; averaged; eligible = quality >= that cohort's median.
// ─────────────────────────────────────────────────────────────────────────────

import { STOCK_SECTOR } from "./market-data";

/** One as-reported annual filing, reduced to what the quality gate needs. */
export interface FundamentalRow {
  ticker: string;
  /** FILING date (Sharadar `date`) — when this became public. NOT the period end. */
  filed: string;
  /** Period the figures describe (Sharadar `calendardate`). Kept for diagnostics only; using it to
   *  decide availability is trap #1 above. */
  period: string;
  assets: number | null;
  equity: number | null;
  liabilities: number | null;
  netinc: number | null;
  /** Operating cash flow. The alternative numerator — see QualityBasis. */
  ncfo: number | null;
}

/**
 * Which earnings measure the quality composite divides by assets and equity.
 *
 * "netinc" mirrors production. "ncfo" is the hypothesis: a gate built on NET INCOME is structurally
 * vulnerable to large NON-CASH charges, so any company taking an acquisition write-off or impairment
 * reads as low-quality for four quarters regardless of its economics — hardest on acquisitive sectors,
 * pharma especially.
 *
 * The live case that prompted this: MRK was sold 2026-10-01 after its TTM net income fell 18.25B →
 * 3.17B, while its TTM operating cash flow ROSE to an all-time-high 19.97B. A ~15B non-cash gap in
 * one half-year. The quality gate was not wrong — net income genuinely collapsed — but it could not
 * distinguish "earnings deteriorated" from "took a write-off".
 */
export type QualityBasis = "netinc" | "ncfo";

export interface QualityAsOf {
  /** symbol → composite percentile (0–1). */
  quality: Map<string, number>;
  median: number;
  /** How many names had usable fundamentals. A thin cohort makes the percentile meaningless. */
  cohortSize: number;
}

/** Filing rows per ticker, ASCENDING by filing date. */
export type FundamentalIndex = Map<string, FundamentalRow[]>;

export function buildFundamentalIndex(rows: FundamentalRow[]): FundamentalIndex {
  const out: FundamentalIndex = new Map();
  for (const r of rows) {
    if (!r.ticker || !r.filed) continue;
    let list = out.get(r.ticker);
    if (!list) { list = []; out.set(r.ticker, list); }
    list.push(r);
  }
  for (const list of out.values()) list.sort((a, b) => a.filed.localeCompare(b.filed));
  return out;
}

/**
 * The most recent filing PUBLIC on or before `asOf`. Binary search over ascending filing dates.
 * Returns null when nothing had been filed yet — never the earliest row, which would be the
 * forward-reaching mistake.
 */
export function latestFilingAsOf(list: FundamentalRow[] | undefined, asOf: string): FundamentalRow | null {
  if (!list || list.length === 0) return null;
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].filed <= asOf) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best < 0 ? null : list[best];
}

function percentileFn(vals: number[]): (x: number) => number {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length || 1;
  return (x: number) => {
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m + 1; else hi = m; }
    return lo / n;
  };
}

/**
 * Cross-sectional quality for one date, over one cohort.
 *
 * `cohort` MUST be the point-in-time index membership for `asOf` (trap #3). The terms and their
 * exclusions mirror lib/quality.ts exactly:
 *   · ROA = netinc / assets, required (assets > 0 and netinc present, else the name is skipped)
 *   · ROE = netinc / equity, included ONLY when equity > 0 (meaningless when negative)
 *   · leverage = liabilities / assets, DROPPED for Financials/Real Estate (structurally levered)
 *     and for known-negative-equity names (where liabilities exceed assets by construction, so the
 *     ratio balloons and reads as "over-levered" for an elite buyback-heavy business)
 */
export function qualityAsOf(
  cohort: Iterable<string>,
  index: FundamentalIndex,
  asOf: string,
  basis: QualityBasis = "netinc",
): QualityAsOf {
  const raw = new Map<string, { roe: number | null; roa: number; lev: number | null }>();
  for (const sym of cohort) {
    const f = latestFilingAsOf(index.get(sym), asOf);
    if (!f) continue;
    const a = f.assets, e = f.equity, l = f.liabilities;
    // The ONE substitution under test. Everything downstream — the ROE/leverage exclusions, the
    // percentile composite, the median split — is identical, so any difference in results is
    // attributable to the numerator and nothing else.
    const n = basis === "ncfo" ? f.ncfo : f.netinc;
    if (a == null || n == null || a <= 0) continue;
    const sec = STOCK_SECTOR[sym];
    const isFin = sec === "XLF" || sec === "XLRE";
    const negEq = e != null && e <= 0;
    raw.set(sym, {
      roe: e != null && e > 0 ? n / e : null,
      roa: n / a,
      lev: !isFin && !negEq && l != null ? l / a : null,
    });
  }

  const vals = [...raw.values()];
  const roeP = percentileFn(vals.filter(r => r.roe != null).map(r => r.roe as number));
  const roaP = percentileFn(vals.map(r => r.roa));
  const levP = percentileFn(vals.filter(r => r.lev != null).map(r => r.lev as number));

  const quality = new Map<string, number>();
  for (const [sym, r] of raw) {
    const parts = [roaP(r.roa)];
    if (r.roe != null) parts.push(roeP(r.roe));
    if (r.lev != null) parts.push(1 - levP(r.lev));     // lower leverage = better
    quality.set(sym, parts.reduce((s, x) => s + x, 0) / parts.length);
  }
  const sorted = [...quality.values()].sort((a, b) => a - b);
  return {
    quality,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0.5,
    cohortSize: quality.size,
  };
}

/** Parse the SF1 bulk CSV, keeping ONLY as-reported annual rows. See trap #2. */
export function parseFundamentalsCsv(
  csv: string,
  opts: { dimension?: string; tickers?: Set<string>; basis?: QualityBasis } = {},
): FundamentalRow[] {
  const dim = opts.dimension ?? "ARY";
  const lines = csv.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(s => s.trim());
  const ix = (name: string) => header.indexOf(name);
  const iTicker = ix("ticker"), iDim = ix("dimension"), iDate = ix("date"),
    iCal = ix("calendardate"), iAssets = ix("assets"), iEquity = ix("equity"),
    iLiab = ix("liabilities"), iNet = ix("netinc"), iNcfo = ix("ncfo");
  // A missing required column means the file is not what we think it is. Returning [] here would
  // read downstream as "no fundamentals", i.e. the screen silently degrades to momentum-only and
  // the whole point of this module evaporates without an error. Fail loudly instead.
  if ([iTicker, iDim, iDate, iAssets, iEquity, iLiab, iNet].some(i => i < 0)) {
    throw new Error(`SF1 CSV missing required columns; header had: ${header.slice(0, 12).join(",")}…`);
  }
  // `ncfo` is required ONLY when it is the basis being measured — and then it is just as required
  // as netinc. Omitting it from the guard was the same silent-degradation hole the guard exists to
  // close, one basis over: with basis "ncfo" and no column, every row's ncfo is null, qualityAsOf
  // returns an EMPTY quality map, LIVE_PROXY reads a null median as "no quality data → momentum
  // only" for every name, and full-period.ts still prints "Quality: ARY/ncfo". A cash-flow-quality
  // verdict would then be an unlabelled momentum-only run. The whole-row extract supplies ncfo
  // today, so this is latent — until someone trims the extract or upstream renames the field.
  if (opts.basis === "ncfo" && iNcfo < 0) {
    throw new Error(`SF1 CSV missing the "ncfo" column, which basis "ncfo" measures; header had: ${header.slice(0, 12).join(",")}…`);
  }
  const num = (s: string | undefined) => {
    if (s == null || s === "") return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const out: FundamentalRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(",");
    if (f.length <= iNet) continue;
    if (f[iDim] !== dim) continue;
    const ticker = f[iTicker];
    if (!ticker) continue;
    if (opts.tickers && !opts.tickers.has(ticker)) continue;
    const filed = f[iDate];
    if (!filed) continue;                 // no filing date → unusable point-in-time
    out.push({
      ticker, filed, period: iCal >= 0 ? f[iCal] : "",
      assets: num(f[iAssets]), equity: num(f[iEquity]),
      liabilities: num(f[iLiab]), netinc: num(f[iNet]),
      // Absent column -> null, never 0. Zero operating cash flow is a real and terrible value.
      ncfo: iNcfo >= 0 ? num(f[iNcfo]) : null,
    });
  }
  return out;
}
