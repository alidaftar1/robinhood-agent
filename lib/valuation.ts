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

export interface XbrlPoint { start: string; end: string; val: number; form: string; fy: number; fp: string; filed?: string; }

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
  /** Full-year P/E is >2x the trailing one — earnings GREW, so the full-year figure is stale. */
  grew: boolean;
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
  if (!u) return [];
  // Pick the first key holding a NON-EMPTY array. `?? ` is wrong here for the same reason it was
  // wrong above: SEC can return {"USD/shares": {}, "USD": [...real data...]}, and `{}` is not
  // nullish, so a nullish-coalescing chain binds to the empty object and never reaches the data.
  for (const key of ["USD/shares", "USD"]) {
    const arr = u[key];
    if (Array.isArray(arr) && arr.length) {
      return (arr as XbrlPoint[]).filter(x => x?.form === "10-Q" || x?.form === "10-K" || x?.form === "10-K/A" || x?.form === "10-Q/A");
    }
  }
  return [];
}

async function concept(cik: string, tag: string, signal?: AbortSignal): Promise<XbrlPoint[]> {
  try {
    const r = await fetch(`${XBRL}/CIK${cik}/us-gaap/${tag}.json`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!r.ok) { warnIfThrottled(r.status, cik, tag); return []; }
    return filedPoints(((await r.json()) as { units?: unknown }).units);
  } catch { return []; }
}

/** 404 means the concept genuinely does not exist for this filer. 403/429/5xx mean WE failed —
 *  collapsing both into an empty array makes valuation vanish from the prompt with no signal, the
 *  same silent-degradation shape that hid the SEC contact-header bug for weeks. */
function warnIfThrottled(status: number, cik: string, tag: string): void {
  if (status !== 404) {
    console.warn("XBRL_REQUEST_FAILED — valuation will be ABSENT, not 'no data'", { status, cik, tag });
  }
}

/** Fallback: companyfacts returns the whole company in one payload.
 *
 *  Needed because companyconcept is INCONSISTENT — verified 2026-09-21: it returned an empty blob
 *  for KO's EarningsPerShareDiluted while companyfacts held 213 filed datapoints for that exact
 *  tag. Bigger payload, so it is only used when the targeted endpoint comes back empty. */
async function factsEps(cik: string, signal?: AbortSignal): Promise<XbrlPoint[]> {
  try {
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!r.ok) { warnIfThrottled(r.status, cik, "companyfacts"); return []; }
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
  // Sort by FILED date so a restatement deterministically wins over the superseded original,
  // rather than relying on SEC's array ordering, which nothing here controls.
  const q = points.filter(p => months(p) === 3)
    .sort((a, b) => String(a.filed ?? "").localeCompare(String(b.filed ?? "")));
  const byEnd = new Map<string, number>();
  for (const p of q) byEnd.set(p.end, p.val);   // last (latest filed) wins

  const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

  // Derive each missing Q4 from (FY − 9mo) sharing the same fiscal year. The "already known" test
  // is PROXIMITY, not an exact key: a 52/53-week filer can tag the discrete Q4 as ending 12-30
  // while the FY says 12-31, and an exact-match guard then derives a SECOND Q4 and double-counts
  // it — verified to overstate TTM by 30% while silently dropping Q1.
  for (const fy of points.filter(p => months(p) === 12)) {
    if ([...byEnd.keys()].some(k => daysApart(k, fy.end) <= 7)) continue;
    const nine = points.find(p => months(p) === 9 && p.start === fy.start);
    if (nine) byEnd.set(fy.end, Number((fy.val - nine.val).toFixed(4)));
  }

  const ends = [...byEnd.keys()].sort();
  const last4Ends = ends.slice(-4);
  const last4 = last4Ends.map(e => byEnd.get(e)!);
  if (last4.length < 4) return { ttm: null, quarters: last4, negative: false };

  // CONTIGUITY. slice(-4) alone just takes "the four most recent quarters I could resolve", so a
  // gap (a filer that tagged only cumulative YTD, or a fiscal-year change breaking the Q4
  // derivation) silently yields a TTM spanning 18 months. Silent-wrong is far worse than null here.
  const span = daysApart(last4Ends[0], last4Ends[3]);
  const contiguous = span >= 240 && span <= 310 &&
    last4Ends.every((e, i) => i === 0 || (() => { const d = daysApart(last4Ends[i - 1], e); return d >= 60 && d <= 130; })());
  if (!contiguous) return { ttm: null, quarters: last4, negative: false };

  return {
    ttm: Number(last4.reduce((a, b) => a + b, 0).toFixed(4)),
    quarters: last4,
    negative: last4.some(v => v < 0),
  };
}

/** Latest reported full fiscal year EPS. */
export function latestFyEps(points: XbrlPoint[]): { eps: number | null; end: string | null } {
  const fy = points.filter(p => months(p) === 12)
    .sort((a, b) => a.end.localeCompare(b.end) || String(a.filed ?? "").localeCompare(String(b.filed ?? "")))
    .pop();
  return fy ? { eps: fy.val, end: fy.end } : { eps: null, end: null };
}

/** Assemble the full picture for one symbol. `price` comes from the caller (live quote). */
export const MAX_STALENESS_DAYS = 200;   // ~2 missed quarters

export function buildValuation(symbol: string, price: number, points: XbrlPoint[], asOf = Date.now()): Valuation {
  // RECENCY. Nothing else checks that the filings are current, so an acquired or delinquent filer
  // (or a tag the filer abandoned years ago) produces a clean-looking P/E against today's price.
  const newest = points.map(p => Date.parse(p.end)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const stale = newest == null || (asOf - newest) / 86_400_000 > MAX_STALENESS_DAYS;
  if (stale) {
    return { symbol, price, ttmEps: null, fyEps: null, fyEnd: null, peTTM: null, peFY: null,
             hasNegativeQuarter: false, distorted: false, grew: false, headline: "none" };
  }
  const { ttm, negative } = stitchTtmEps(points);
  const { eps: fyEps, end: fyEnd } = latestFyEps(points);
  // A negative P/E is not a cheap stock, it is an absent one — return null rather than a number
  // that sorts as "very cheap" in any downstream ranking.
  const peTTM = ttm != null && ttm > 0 && price > 0 ? Number((price / ttm).toFixed(2)) : null;
  const peFY = fyEps != null && fyEps > 0 && price > 0 ? Number((price / fyEps).toFixed(2)) : null;
  // DIRECTIONAL. peTTM >> peFY means trailing EARNINGS are depressed (a charge) -> the full-year
  // figure is the usable one. peFY >> peTTM means earnings GREW -> trailing is the usable one and
  // the full year is stale. A symmetric test called both "distorted" and pushed the reader to the
  // full year in both, which tells a tripling company to use a 100x figure over the correct 40x —
  // and tells a halving company to use the flattering stale one, hiding a real deterioration.
  const distorted = peTTM != null && peFY != null && peTTM / peFY > 2;
  const grew = peTTM != null && peFY != null && peFY / peTTM > 2;
  const headline: Valuation["headline"] =
    peTTM != null && !distorted ? "peTTM" : peFY != null ? "peFY" : peTTM != null ? "peTTM" : "none";
  return { symbol, price, ttmEps: ttm, fyEps, fyEnd, peTTM, peFY, hasNegativeQuarter: negative, distorted, grew, headline };
}

/** Fetch + compute for one symbol. Fail-safe: returns null rather than throwing. */
export async function fetchValuation(symbol: string, price: number, signal?: AbortSignal): Promise<Valuation | null> {
  try {
    const cikMap = await getCIKMap(signal ?? AbortSignal.timeout(30_000));
    const cik = cikMap.get(symbol.toUpperCase());
    // NOTE getCIKMap is filtered to SP500_UNIVERSE, so every non-S&P name (the influencer sleeve's
    // SPCX/CAKE/IMAX, and any stale ticker from an acquisition) returns null here PERMANENTLY —
    // a universe constraint, not missing data. Widen the map before relying on this off-index.
    if (!cik) return null;
    // Prefer the tag with the MOST RECENT data, not merely the first with any: filers migrate tags
    // and abandon the old one mid-history, leaving a short stale series that would otherwise win.
    let points: XbrlPoint[] = [];
    let newest = -Infinity;
    for (const tag of EPS_TAGS) {
      const got = await concept(cik, tag, signal);
      if (!got.length) continue;
      const end = Math.max(...got.map(p => Date.parse(p.end)).filter(Number.isFinite));
      if (end > newest) { newest = end; points = got; }
    }
    if (points.length === 0) points = await factsEps(cik, signal);   // companyconcept can be empty
    if (points.length === 0) return null;
    return buildValuation(symbol, price, points);
  } catch { return null; }
}

/** One-line rendering that can never quote a distorted figure on its own. */
export function formatValuation(v: Valuation): string {
  const fyLabel = `FY${v.fyEnd?.slice(0, 4) ?? "?"}`;
  if (v.headline === "none") return `${v.symbol}: P/E n/a (no usable EPS)`;
  // Branch on HEADLINE, not on the flags: when TTM cannot be assembled but a full year exists,
  // the old final branch printed `P/E nullx trailing`.
  if (v.headline === "peFY") {
    const why = v.peTTM == null
      ? (v.hasNegativeQuarter ? "trailing is loss-making" : "trailing could not be assembled")
      : `trailing shows ${v.peTTM}x but is depressed by charges`;
    return `${v.symbol}: P/E ${v.peFY}x on ${fyLabel} — ⚠ ${why}; use the full-year figure`;
  }
  if (v.grew) {
    return `${v.symbol}: P/E ${v.peTTM}x trailing (${fyLabel} ${v.peFY}x — earnings grew, the full-year figure is stale)`;
  }
  return `${v.symbol}: P/E ${v.peTTM}x trailing (${fyLabel} ${v.peFY ?? "n/a"}x)`;
}
