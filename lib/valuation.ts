import { SEC_UA, getCIKMap } from "@/lib/insider";
import { redisCommand, redisPost } from "@/lib/run-store";

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

/** Fetch the raw EPS datapoints for a symbol. Separated so callers can CACHE them — they change
 *  only on a filing, while the price they are divided by changes continuously. */
export async function fetchEpsPoints(symbol: string, signal?: AbortSignal): Promise<XbrlPoint[]> {
  try {
    const cikMap = await getCIKMap(signal ?? AbortSignal.timeout(30_000));
    const cik = cikMap.get(symbol.toUpperCase());
    // NOTE getCIKMap is filtered to SP500_UNIVERSE, so every non-S&P name (the influencer sleeve's
    // SPCX/CAKE/IMAX, and any stale ticker from an acquisition) resolves to nothing here
    // PERMANENTLY — a universe constraint, not missing data. Widen the map before relying on this.
    if (!cik) return [];
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
    return points;
  } catch { return []; }
}

/** Fetch + compute for one symbol. Fail-safe: returns null rather than throwing. */
export async function fetchValuation(symbol: string, price: number, signal?: AbortSignal): Promise<Valuation | null> {
  const points = await fetchEpsPoints(symbol, signal);
  if (points.length === 0) return null;
  const v = buildValuation(symbol, price, points);
  return v.headline === "none" ? null : v;
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

// ─── Batch access with caching ───────────────────────────────────────────────
//
// Caches the EXPENSIVE, SLOW-MOVING half (EPS from XBRL, which changes quarterly) and recomputes
// the cheap half (price / EPS) from a live quote every call. Caching a P/E directly would go stale
// the moment the price moved, which is the whole point of the number.

const EPS_CACHE_PREFIX = "valuation:eps:";
const EPS_TTL_SECONDS = 7 * 24 * 60 * 60;   // EPS only changes on a filing

interface CachedEps { v: 1; points: XbrlPoint[]; cachedAt: string }

/** Keep only the fields the maths reads. XBRL points carry accn/frame/etc — dead weight that
 *  roughly doubles a blob already large enough to break the cache write. `filed` is load-bearing:
 *  it is how we tell whether the cached data already contains a company's latest print. */
const slimPoint = (p: XbrlPoint): XbrlPoint =>
  ({ start: p.start, end: p.end, val: p.val, form: p.form, fy: p.fy, fp: p.fp, filed: p.filed });

/**
 * Do these EPS datapoints already INCLUDE a given earnings report?
 *
 * Keying on cache WRITE TIME does not work, and is worse than nothing. The XBRL 10-Q lags the press
 * release — same day for some mega-caps, weeks for many filers — so a refetch triggered by "cached
 * before the print" returns the SAME pre-print points and re-stamps the timestamp. Two runs later
 * the write-time test passes and the entry is trusted, serving pre-print EPS against a post-print
 * price for the rest of the TTL: the exact failure, reintroduced by its own fix.
 *
 * So ask the data, not the clock: has anything been FILED on or after the report date?
 */
export function pointsIncludeReport(points: XbrlPoint[], reportDate: string | undefined): boolean {
  if (!reportDate) return true;                       // nothing reported in the window — nothing to miss
  const r = Date.parse(reportDate);
  if (!Number.isFinite(r)) return false;              // unparseable — assume NOT covered, fail safe
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const target = day(r);
  return points.some(p => {
    const f = Date.parse(p.filed ?? "");
    return Number.isFinite(f) && day(f) >= target;    // a filing at/after the print carries it
  });
}

export async function getValuations(
  symbols: string[],
  priceOf: (symbol: string) => number | undefined,
  signal: AbortSignal,
  opts: {
    maxFresh?: number;
    /** symbol -> most recent earnings report date. Cached EPS predating a report is discarded. */
    reportedOn?: Map<string, string>;
  } = {},
): Promise<{ valuations: Map<string, Valuation>; notes: string[] }> {
  const maxFresh = opts.maxFresh ?? 25;
  const valuations = new Map<string, Valuation>();
  const notes: string[] = [];
  let fresh = 0;
  const skipped: string[] = [];
  const noData: string[] = [];
  const prePrint: string[] = [];
  const timedOut: string[] = [];

  // Order matters under a time budget: names that just reported are the ones whose cached figure is
  // unusable, so give them the fetch slots before names that already have a good cached value.
  const ordered = [...new Set(symbols)].sort((a, b) =>
    Number(!!opts.reportedOn?.get(b.toUpperCase())) - Number(!!opts.reportedOn?.get(a.toUpperCase())));
  for (const symbol of ordered) {
    const price = priceOf(symbol);
    if (!price || price <= 0) continue;          // no price, no P/E — nothing to say
    const key = `${EPS_CACHE_PREFIX}${symbol.toUpperCase()}`;   // match the uppercase CIK lookup
    let points: XbrlPoint[] | null = null;

    try {
      const raw = await redisCommand("GET", key) as string | null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CachedEps>;
        // VALIDATE on read: an older-schema or truncated blob would otherwise reach
        // stitchTtmEps().filter and throw OUTSIDE any per-symbol try, discarding every valuation
        // computed so far. Same precedent as lib/earnings-release's re-normalise-on-read.
        if (parsed?.v === 1 && Array.isArray(parsed.points) && parsed.points.length > 0) points = parsed.points;
      }
    } catch { /* cache unavailable or unparseable — fall through to a live read */ }

    if (points === null) {   // explicit: an empty ARRAY is truthy and must not count as a hit
      if (fresh >= maxFresh) { skipped.push(symbol); continue; }
      fresh++;
      points = await fetchEpsPoints(symbol, signal);
      if (points.length === 0) {
        // fetchEpsPoints swallows AbortError and returns [], so a blown time budget is otherwise
        // indistinguishable from "this company has no EPS" — one is about us, the other about them.
        (signal.aborted ? timedOut : noData).push(symbol);
        continue;
      }
      try {
        // POST/pipeline, NOT redisCommand: that helper encodes the value into the URL PATH, which a
        // ~45KB EPS blob blows past (~75KB encoded) — and it does not check res.ok, so the failure
        // was invisible. Same reason lib/influencer-signals caches transcripts this way.
        const payload: CachedEps = { v: 1, points: points.map(slimPoint), cachedAt: new Date().toISOString() };
        await redisPost("pipeline", [["SET", key, JSON.stringify(payload), "EX", EPS_TTL_SECONDS]]);
      } catch (e) {
        console.warn("VALUATION_EPS_CACHE_WRITE_FAILED", { symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // SUPPRESS rather than mislead: if this name has reported and the filings do not yet carry the
    // print, any P/E divides a POST-print price by PRE-print earnings. Refetching cannot fix that —
    // the 10-Q simply is not filed yet — so show nothing and say so. Decided from the points
    // themselves, so it costs no extra fetch and cannot be re-stamped away by a rewrite.
    if (!pointsIncludeReport(points, opts.reportedOn?.get(symbol.toUpperCase()))) {
      prePrint.push(symbol);
      continue;
    }
    const v = buildValuation(symbol, price, points);
    if (v.headline !== "none") valuations.set(symbol, v);
  }

  if (skipped.length) {
    notes.push(`CONTEXT — P/E not fetched this run for: ${skipped.join(", ")} (hit the ${maxFresh}-per-run cap, or the run's valuation time budget expired). No order was affected.`);
  }
  if (timedOut.length) {
    notes.push(`CONTEXT — P/E lookup timed out for: ${timedOut.join(", ")} (valuation time budget expired; the trade run takes priority). Absent from the block; says nothing about the companies. No order was affected.`);
  }
  if (noData.length) {
    // Distinct from the cap: these were ATTEMPTED and SEC returned nothing usable — a non-S&P CIK
    // miss, a filer with no us-gaap EPS tag, or a 403/429. Previously dropped with no trace at all.
    notes.push(`CONTEXT — no SEC EPS data for: ${noData.join(", ")}. Absent from the valuation block; this does NOT mean cheap. No order was affected.`);
  }
  if (prePrint.length) {
    notes.push(`CONTEXT — P/E SUPPRESSED for: ${prePrint.join(", ")} — these reported recently and SEC filings do not yet carry the print, so any multiple would divide a post-print price by pre-print earnings. Absent from the valuation block; this does NOT mean cheap or expensive. No order was affected.`);
  }
  if (symbols.length > 0 && (opts.reportedOn?.size ?? 0) === 0) {
    // The earnings map is fail-safe upstream (a missing key or a 403 yields an empty map), so with
    // no entries EVERY name looks "not recently reported" and pre-print suppression silently never
    // runs. Say so rather than letting the check fail open without a trace.
    console.warn("VALUATION_NO_EARNINGS_MAP — pre-print suppression inactive this run", { considered: symbols.length });
  }
  if (valuations.size === 0 && symbols.length > 0) {
    // Whole-block failure (empty CIK map, SEC outage) renders an EMPTY STRING into the prompt,
    // indistinguishable from "valuation deliberately off" — the silent-degradation shape this file
    // warns about at the top.
    notes.push(`CONTEXT — the VALUATION block is EMPTY this run: no P/E could be computed for any of ${symbols.length} names. Treat its absence as missing data, not as a signal.`);
    console.warn("VALUATION_BLOCK_EMPTY", { considered: symbols.length });
  }
  return { valuations, notes };
}

/** Compact block for the analysis prompt. Empty when there is nothing to say. */
export function formatValuations(vals: Map<string, Valuation>): string {
  if (vals.size === 0) return "";
  const rows = [...vals.values()]
    .sort((a, b) => (a.headline === "peTTM" ? a.peTTM! : a.peFY!) - (b.headline === "peTTM" ? b.peTTM! : b.peFY!))
    .map(v => "  " + formatValuation(v));
  return `\nVALUATION (P/E computed from SEC filings — the ONLY price-based check in this system):
Everything else you are shown is either PROFITABILITY (the quality score is ROE/ROA/leverage, no price
term) or TREND (12-1 momentum asks whether a name went UP, never whether it is EXPENSIVE). This block
is the only input that can tell you what you are PAYING for the earnings.
Use it to DISCRIMINATE BETWEEN names already on the shortlist — a cheaper name with comparable momentum
and quality is the better buy, and a high multiple on decelerating growth deserves a smaller position
or none. It does NOT change eligibility and does NOT override the shortlist or any cap. A missing name
means no reliable figure, NOT that it is cheap. Where a name shows "⚠ depressed by charges", the
full-year figure is the real one — do not quote the trailing number.
BUY-SIDE ONLY. Valuation is never on its own a reason to SELL a name you already hold: a rich
multiple is not a thesis break, and main-book sells are not shortlist-gated in code, so the model is
the only check. Do not trim or exit a holding because of its P/E.
${rows.join("\n")}`;
}
