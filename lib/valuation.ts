import { SEC_UA, getCIKMap } from "@/lib/insider";

// ─── Valuation from PRIMARY filings data ─────────────────────────────────────
//
// The system had NO valuation input anywhere: the quality score is ROE + leverage (profitability,
// not price) and the shortlist ranks 12-1 momentum. With the equity risk premium near zero that is
// the single most decision-relevant number missing, and its absence produced a bad call on
// 2026-09-21 (a name recommended partly on "upside to target" that was already trading above it).
//
// Computed from SEC XBRL — the same source the filings come from — rather than a vendor ratio, so
// every figure is traceable to an as-reported number and needs no API key.
//
// THE DESIGN RULE, learned the hard way: never return a single P/E. MRK's trailing P/E is ~119x and
// that is ARITHMETICALLY CORRECT — two quarters of acquisition write-offs pushed TTM EPS to $1.26 —
// while its last full fiscal year says ~20x. Both are true; one alone is badly misleading. So this
// returns TTM *and* full-year, and flags the divergence rather than picking a winner.

const XBRL = "https://data.sec.gov/api/xbrl/companyconcept";

export interface XbrlPoint { start: string; end: string; val: number; form: string; fy: number; fp: string; }

export interface Valuation {
  symbol: string;
  price: number;
  /** Sum of the last four discrete quarters, or null if they cannot be assembled. */
  ttmEps: number | null;
  /** Latest reported full fiscal year EPS — the charge-insensitive reference. */
  fyEps: number | null;
  fyEnd: string | null;
  peTTM: number | null;          // null when TTM EPS <= 0 — a negative P/E is not a valuation
  peFY: number | null;
  /** TTM contains a loss-making quarter, so trailing earnings understate the run-rate. */
  hasNegativeQuarter: boolean;
  /** peTTM and peFY disagree by >2x — trailing earnings are distorted; do NOT quote peTTM alone. */
  distorted: boolean;
  /** Which figure to lead with, given the above. */
  headline: "peTTM" | "peFY" | "none";
}

/** EPS tags in preference order — filers do not all use the same one. */
const EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"];

/** Pull filed datapoints out of an XBRL `units` blob.
 *
 *  MUST use Array.isArray, not `?? []`: when a concept has no data SEC returns an empty OBJECT
 *  `{}`, which is not null, so `??` passes it straight through and the caller's `.filter` throws.
 *  That failure was swallowed by a catch and surfaced only as a silent "unavailable". */
export function filedPoints(units: unknown): XbrlPoint[] {
  const u = units as Record<string, unknown> | undefined;
  const arr = u?.["USD/shares"] ?? u?.USD;
  if (!Array.isArray(arr)) return [];
  return (arr as XbrlPoint[]).filter(x => x?.form === "10-Q" || x?.form === "10-K");
}

async function concept(cik: string, tag: string, signal?: AbortSignal): Promise<XbrlPoint[]> {
  try {
    const r = await fetch(`${XBRL}/CIK${cik}/us-gaap/${tag}.json`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!r.ok) return [];
    return filedPoints(((await r.json()) as { units?: unknown }).units);
  } catch { return []; }
}

/** Fallback: companyfacts returns the whole company in one payload.
 *
 *  Needed because companyconcept is INCONSISTENT — verified 2026-09-21: it returned an empty blob
 *  for KO's EarningsPerShareDiluted while companyfacts held 213 filed datapoints for that exact
 *  tag. Bigger payload, so it is only used when the targeted endpoint comes back empty. */
async function factsEps(cik: string, signal?: AbortSignal): Promise<XbrlPoint[]> {
  try {
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!r.ok) return [];
    const j = await r.json() as { facts?: { "us-gaap"?: Record<string, { units?: unknown }> } };
    const gaap = j.facts?.["us-gaap"] ?? {};
    for (const tag of EPS_TAGS) {
      const pts = filedPoints(gaap[tag]?.units);
      if (pts.length) return pts;
    }
    return [];
  } catch { return []; }
}

const months = (p: { start: string; end: string }) =>
  Math.round((Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 / 30.4);

/**
 * Assemble trailing-twelve-month EPS from XBRL periods.
 *
 * Filers report OVERLAPPING windows — a 10-Q carries both the discrete quarter and the cumulative
 * year-to-date — and Q4 is usually never reported discretely at all. So discrete quarters are taken
 * where present, and the missing fourth is DERIVED as (full year − nine months). Summing raw
 * datapoints without this would double-count badly.
 */
export function stitchTtmEps(points: XbrlPoint[]): { ttm: number | null; quarters: number[]; negative: boolean } {
  const q = points.filter(p => months(p) === 3);
  const byEnd = new Map<string, number>();
  for (const p of q) byEnd.set(p.end, p.val);

  // Derive each missing Q4 from (FY − 9mo) sharing the same fiscal year.
  for (const fy of points.filter(p => months(p) === 12)) {
    if (byEnd.has(fy.end)) continue;
    const nine = points.find(p => months(p) === 9 && p.start === fy.start);
    if (nine) byEnd.set(fy.end, Number((fy.val - nine.val).toFixed(4)));
  }

  const ordered = [...byEnd.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]);
  const last4 = ordered.slice(-4);
  if (last4.length < 4) return { ttm: null, quarters: last4, negative: last4.some(v => v < 0) };
  return {
    ttm: Number(last4.reduce((a, b) => a + b, 0).toFixed(4)),
    quarters: last4,
    negative: last4.some(v => v < 0),
  };
}

/** Latest reported full fiscal year EPS. */
export function latestFyEps(points: XbrlPoint[]): { eps: number | null; end: string | null } {
  const fy = points.filter(p => months(p) === 12).sort((a, b) => a.end.localeCompare(b.end)).pop();
  return fy ? { eps: fy.val, end: fy.end } : { eps: null, end: null };
}

/** Assemble the full picture for one symbol. `price` comes from the caller (live quote). */
export function buildValuation(symbol: string, price: number, points: XbrlPoint[]): Valuation {
  const { ttm, negative } = stitchTtmEps(points);
  const { eps: fyEps, end: fyEnd } = latestFyEps(points);
  // A negative P/E is not a cheap stock, it is an absent one — return null rather than a number
  // that sorts as "very cheap" in any downstream ranking.
  const peTTM = ttm != null && ttm > 0 && price > 0 ? Number((price / ttm).toFixed(2)) : null;
  const peFY = fyEps != null && fyEps > 0 && price > 0 ? Number((price / fyEps).toFixed(2)) : null;
  const distorted = peTTM != null && peFY != null && (peTTM / peFY > 2 || peFY / peTTM > 2);
  const headline: Valuation["headline"] =
    peTTM != null && !distorted ? "peTTM" : peFY != null ? "peFY" : peTTM != null ? "peTTM" : "none";
  return { symbol, price, ttmEps: ttm, fyEps, fyEnd, peTTM, peFY, hasNegativeQuarter: negative, distorted, headline };
}

/** Fetch + compute for one symbol. Fail-safe: returns null rather than throwing. */
export async function fetchValuation(symbol: string, price: number, signal?: AbortSignal): Promise<Valuation | null> {
  try {
    const cikMap = await getCIKMap(signal!);
    const cik = cikMap.get(symbol.toUpperCase());
    if (!cik) return null;
    let points: XbrlPoint[] = [];
    for (const tag of EPS_TAGS) {
      points = await concept(cik, tag, signal);
      if (points.length) break;
    }
    if (points.length === 0) points = await factsEps(cik, signal);   // companyconcept can be empty
    if (points.length === 0) return null;
    return buildValuation(symbol, price, points);
  } catch { return null; }
}

/** One-line rendering that can never quote a distorted figure on its own. */
export function formatValuation(v: Valuation): string {
  if (v.headline === "none") return `${v.symbol}: P/E n/a (no usable EPS)`;
  if (v.distorted || v.hasNegativeQuarter) {
    const ttm = v.peTTM != null ? `${v.peTTM}x` : "NM (loss-making TTM)";
    return `${v.symbol}: P/E ${ttm} trailing BUT ${v.peFY ?? "n/a"}x on FY${v.fyEnd?.slice(0, 4) ?? "?"} — ⚠ trailing earnings distorted${v.hasNegativeQuarter ? " (loss-making quarter in TTM)" : ""}; use the full-year figure`;
  }
  return `${v.symbol}: P/E ${v.peTTM}x trailing (FY ${v.peFY ?? "n/a"}x)`;
}
