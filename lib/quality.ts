import { STOCK_SECTOR } from "./market-data";

// ── Quality factor (SEC EDGAR fundamentals) ──────────────────────────────────
// Rough quality score for the V1 quality-momentum strategy (docs/strategy-quality-momentum.md).
// Pulls a few fundamentals from the SEC EDGAR "frames" API (free, one call returns a metric across all
// filers), computes ROE / ROA / leverage, and produces a cross-sectional quality percentile per name.
//
// HONEST CAVEAT: these are the LATEST available fiscal year's numbers. For LIVE/forward trading that is
// correct (you screen today on what's known today). It is only a problem for BACKTESTS (look-ahead), and
// this module is for live use. Financials/REITs are structurally levered → the leverage term is dropped
// for them so they aren't mis-flagged low-quality.

// SEC's fair-access policy asks for a contact email in the User-Agent (www.sec.gov 403s without one).
// Uses a generic contact; overridable via env. No personal data.
const SEC_UA = process.env.SEC_CONTACT_UA || "robinhood-agent-research research@example.com";
// v2: the composite now uses TRAILING-TWELVE-MONTH net income instead of the latest fiscal year.
// The key MUST change with the output — otherwise the switch looks inert for a full TTL while
// serving annual-based scores from the old key.
// v3: three commits changed this output while the key stayed v2 (coverage 385 -> 410, new withheld/
// degraded/basis fields, and now the contiguity guard). A surviving v2 entry would be served for up
// to 8 days with `withheld` absent — making the buy/hold split silently inert while looking deployed.
const CACHE_KEY = "quality:scores:v3";
const CACHE_TTL_SEC = 8 * 24 * 3600; // ~weekly refresh
// A frame with fewer filers than this is treated as not yet published. Frames fill in per concept
// and per period, so a sparse one would collapse the metric for the whole universe.
const MIN_FILERS = 500;

/**
 * WHY TRAILING TWELVE MONTHS, AND WHY IT IS BUILT THIS WAY.
 *
 * Screening on the latest fiscal YEAR means that every Q1 this gate runs on 12-15 month old
 * fundamentals: on 2 Jan 2022 it was still using FY2020, because FY2021 annuals were not filed
 * until Feb-Mar 2022. Measured over 1999-2026 (docs/findings-bear-market-risk.md) that staleness
 * cost 2.4 points of CAGR and 0.07 of Sharpe, and in 2022 specifically it excluded energy on its
 * COVID-year losses in the January before energy became the year's only winning sector.
 *
 * The obvious construction — sum four quarterly frames — does NOT work. Companies file a 10-K for
 * the year rather than a 10-Q for Q4, so the `CY{Y}Q4` DURATION frame is structurally sparse and
 * would fail MIN_FILERS. Instead this uses the standard rolling construction, which needs no Q4
 * quarter at all because Q4 is implicit in the annual:
 *
 *   TTM = annual{A} + Σ Q{i}{A+1} − Σ Q{i}{A}        for i = 1..k
 *
 * i.e. take the last full fiscal year, add the year-to-date quarters, and subtract the SAME
 * quarters a year earlier. With k=2 the window ends at Q2 of the current year — about six months
 * fresher than the annual it replaces.
 *
 * Periods are derived from the clock rather than hard-coded: the previous constant listed CY2025
 * and CY2024 literally, which silently stops being current every January.
 *
 * FISCAL ALIGNMENT is SEC's, not ours. The frames API maps each filer's period into the nearest
 * calendar frame, so a September-year-end company lands in the calendar quarter it best matches.
 * That introduces some imprecision for off-calendar filers and is the price of one free call per
 * concept instead of per-company requests across ~500 names.
 */
interface IncomeFrames {
  ni: Record<number, number>;   // net income: TTM where computable, else the annual fallback
  instant: string;              // which balance-sheet instant the equity/assets/liabilities come from
  label: string;                // human-readable description of the income window
  ttmCount: number;             // filers with a complete TTM window
  withheldCount: number;        // filers DROPPED for an incomplete window — never scored
  /** A stub fetch FAILED (not merely sparse), so the window is shorter than the data allows. */
  degraded: boolean;
}

export interface QualityScore {
  quality: number;        // 0–1 cross-sectional percentile composite (higher = better)
  roe: number | null;     // null when equity is non-positive (ROE undefined; scored on ROA + leverage)
  roa: number;
  lev: number | null;     // null for Financials/Real Estate AND known-negative-equity names (leverage term dropped — it's a buyback artifact there)
  eligible: boolean;      // quality >= universe median
}
export interface QualityData {
  scores: Record<string, QualityScore>;
  median: number;
  period: string;         // which window the income numbers cover
  asOf: string;           // ISO date the scores were computed
  /** Universe symbols whose quality could NOT be established. These must be excluded from the BUY
   *  allowlist but must NOT read as "fell off the shortlist" for a name already held — that string
   *  authorises a sell (lib/sell-rail justifiedReason), so conflating "we could not measure it" with
   *  "it failed the measurement" would turn a data gap into a liquidation. */
  withheld: string[];
  /** True when a FETCH failed rather than a frame being genuinely unpublished. A degraded result is
   *  never cached: "we could not ask" must not be frozen for a TTL as "SEC has not published". */
  degraded: boolean;
  basis: { ttmFromFrames: number; recoveredPerCompany: number; withheld: number; withheldNoCik: number };
  /** The symbols behind basis.withheldNoCik: universe entries with NO CIK in SEC's ticker file, i.e.
   *  companies that have LEFT the market (acquired/renamed/delisted) rather than data gaps. Carried
   *  as a LIST, not just a count, because pruning the universe requires owner approval and nobody
   *  could approve a prune of 20 symbols that only existed as a number in a log line Vercel no
   *  longer retains. Each one also burns a Yahoo quote every run. Harmless to carry: a dead ticker
   *  cannot be held, so there is no behaviour attached to it.
   *
   *  Measured against Object.keys(STOCK_SECTOR), which is NOT identical to SP500_UNIVERSE (they
   *  differ by PLTR) — a prune must be applied to the list it was measured against. */
  staleUniverse: string[];
  /** True when staleUniverse is implausibly large — read it as "investigate the ticker map", NOT as
   *  a prune list. isUsableTickerMap only requires 1000 entries against a real SEC file of ~10k, so
   *  a TRUNCATED-but-"usable" map makes hundreds of LIVE tickers look CIK-less. Since this list
   *  exists to drive a manual DELETION from the tradable universe, a false entry gets a live name
   *  removed — so an implausible count is reported as a suspected map problem, not as candidates. */
  staleUniverseSuspect: boolean;
}

/** Per-request ceiling. Was 25s, which stacked: ~11 sequential waits put the worst case at 275s
 *  against the trade route's maxDuration of 300. */
const SEC_REQUEST_TIMEOUT_MS = 10_000;
/** Whole-refresh ceiling for the frames phase, checked between steps. The route already gives
 *  valuation an explicit budget for exactly this reason (app/api/trade/route.ts) — this call had
 *  none while becoming several times longer. */
export const QUALITY_FRAMES_BUDGET_MS = 75_000;

/** 404 from a companyconcept URL means the filer has never tagged that concept — a STABLE fact about
 *  the company, not a failure to reach SEC. Distinguished so it can be cached rather than poisoning
 *  the whole run as "could not ask". */
const SEC_NOT_FOUND = Symbol("sec-404");

/**
 * `notFoundOk` is OPT-IN, deliberately. Returning the sentinel unconditionally re-claimed meaning for
 * every caller: the tickers fetch does not test for it, and `Object.keys(Symbol())` is `[]` rather
 * than a throw — so a 404 on company_tickers.json produced an empty CIK map, every name withheld,
 * `degraded` still FALSE, and that empty result CACHED for 8 days. The trade route would then trip its
 * shortlist floor and self-skip every run for a week while blaming "a Yahoo/SEC hiccup". Widening a
 * condition without renaming it re-claims it for consumers who never asked.
 */
/**
 * How an HTTP status should be read, split out as a PURE function so the OPT-IN is testable. The
 * guards that matter here sit in network-bound code that no test reaches, which is exactly how the
 * unconditional-sentinel bug survived into a commit.
 */
export function resolveSecStatus(status: number, notFoundOk: boolean): "ok" | "not-found" | "error" {
  if (status === 404) return notFoundOk ? "not-found" : "error";
  return status >= 200 && status < 300 ? "ok" : "error";
}

async function secGet(url: string, opts: { notFoundOk?: boolean } = {}): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(SEC_REQUEST_TIMEOUT_MS) });
  const verdict = resolveSecStatus(res.status, opts.notFoundOk === true);
  if (verdict === "not-found") return SEC_NOT_FOUND;
  if (verdict === "error") throw new Error(`SEC ${res.status} for ${url}`);
  return res.json();
}

/** A frame fetch that distinguishes COULD-NOT-ASK from genuinely-sparse. Collapsing the two is how a
 *  403 becomes the claim "SEC has not published this quarter" — a fact about us stated as a fact
 *  about SEC — and then gets cached for the full TTL. */
const FRAME_FAILED = Symbol("frame-fetch-failed");
async function frameOrFailed(concept: string, period: string): Promise<Record<number, DatedValue> | typeof FRAME_FAILED> {
  try { return await frame(concept, period); } catch { return FRAME_FAILED; }
}

/** A dated frame value. The DATES are load-bearing: without them a caller cannot tell whether an
 *  annual period and a quarter actually abut, and the TTM construction silently produces a
 *  twelve-month-DURATION sum with a hole in it for every off-calendar filer. */
export interface DatedValue { val: number; start: string; end: string }

async function frame(concept: string, period: string): Promise<Record<number, DatedValue>> {
  // 404 on a FRAME genuinely means "that period is not published yet" — verified against SEC.
  const d = await secGet(`https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/USD/${period}.json`, { notFoundOk: true });
  // A 404 on a FRAME means that period is not published — genuinely sparse, which the caller's
  // MIN_FILERS gate already handles. Return empty rather than letting the sentinel leak into data.
  if (d === SEC_NOT_FOUND) return {};
  const out: Record<number, DatedValue> = {};
  for (const row of (d?.data ?? [])) {
    if (typeof row?.val !== "number") continue;
    out[row.cik] = {
      val: row.val,
      start: typeof row.start === "string" ? row.start : "",
      end: typeof row.end === "string" ? row.end : "",
    };
  }
  return out;
}

/** Instants (balance-sheet concepts) need only the value. */
const valuesOnly = (m: Record<number, DatedValue>): Record<number, number> => {
  const out: Record<number, number> = {};
  for (const k of Object.keys(m)) out[Number(k)] = m[Number(k)].val;
  return out;
};

function percentileFn(vals: number[]): (x: number) => number {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length || 1;
  return (x: number) => {
    // fraction of values <= x
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m + 1; else hi = m; }
    return lo / n;
  };
}

/** A company's own reported facts for one concept, reduced to what a TTM needs. */
export interface ConceptFact {
  start: string;   // period start, YYYY-MM-DD ("" for an instant)
  end: string;     // period end
  val: number;
  filed: string;   // when this figure became public
  form: string;    // the filing it came from — see FINANCIAL_STATEMENT_FORMS
}

/**
 * Only forms that carry audited/reviewed FINANCIAL STATEMENTS are usable.
 *
 * A proxy statement (DEF 14A) is filed AFTER the 10-K and restates the same figures — frequently
 * SCALED, in millions or thousands, because it is prose for shareholders rather than XBRL financial
 * data. Keeping "the latest filed value" therefore let proxies override annual reports. Verified on
 * FedEx: the SAME period 2025-06-01 → 2026-05-31 appears as 10-K `4433000000` (filed 2026-07-20) and
 * DEF 14A `4433` (filed 2026-08-17). The proxy won, and FDX's net income resolved to $4,433 — a
 * factor of a million out. 39 of 131 recovery candidates were anchored on a proxy fact; FDX, MDT and
 * ED were scale-corrupted.
 *
 * The direction was understatement, so those names were wrongly EXCLUDED from buying, which is the
 * safe side of the buy decision. But they were still SCORED, which makes them "measured and failed"
 * rather than quality-unknown — so a HELD one drops out of `retained`, reads as "fell off the
 * shortlist", and lib/sell-rail accepts that as a code-verifiable exit. A units error could
 * authorise a liquidation.
 */
export const FINANCIAL_STATEMENT_FORMS = new Set([
  "10-K", "10-K/A", "10-KT", "10-Q", "10-Q/A", "10-QT",
  "20-F", "20-F/A", "40-F", "40-F/A",
]);

/** Days between two YYYY-MM-DD dates; NaN when either is unparseable. */
const dayspan = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

const ANNUAL_MIN = 330, ANNUAL_MAX = 400;   // a "fiscal year" duration
const QTR_MIN = 80, QTR_MAX = 100;          // a "fiscal quarter" duration
/** A twelve-month window ending longer ago than this is genuinely stale — withhold rather than use it. */
export const MAX_WINDOW_AGE_DAYS = 400;

/**
 * The freshest sound twelve-month net-income window from a company's OWN reported facts.
 *
 * WHY THIS EXISTS. Calendar frames cannot serve off-calendar filers: SEC maps Microsoft's
 * July-to-June fiscal year into `CY2025` and then has no calendar-Q1/Q2-2026 stub for it, so the
 * frames path withheld MSFT entirely — excluding it for an accounting-calendar reason rather than
 * anything to do with quality. Its own 10-K meanwhile covers 2025-07-01 → 2026-06-30 and is three
 * months old. The data was never missing; the calendar-shaped lookup could not see it.
 *
 * Construction, same shape as the frames path but on the company's REAL periods:
 *   window = latest fiscal year, then rolled forward by each contiguous quarter filed since,
 *            netting off the same quarter a year earlier.
 *
 * Returns null — WITHHOLD — when no sound window exists, including when the freshest one ends more
 * than MAX_WINDOW_AGE_DAYS ago. An annual by itself is NOT a stale fallback: it is a genuine
 * twelve-month measurement, and the only question is whether it ended recently enough to describe
 * the company now.
 */
export function ttmFromFacts(facts: ConceptFact[], asOf: string): { val: number; windowEnd: string; quartersAdded: number } | null {
  // Dedupe by period, keeping the LATEST FILED value. The same quarter is re-presented in later
  // filings; for a LIVE screen the most recently filed figure is what is actually known today.
  // (A backtest would want the original — see lib/sharadar-quality, which uses as-reported data.)
  const byPeriod = new Map<string, ConceptFact>();
  for (const f of facts) {
    if (!f.start || !f.end || typeof f.val !== "number" || !Number.isFinite(f.val)) continue;
    if (f.end > asOf) continue;                       // not yet a closed period as of asOf
    // Proxies and other non-financial-statement forms are DROPPED, not merely out-ranked. A period
    // reported only by a proxy is not usable: the scale cannot be trusted, and a silently 10^6-wrong
    // figure is worse than withholding the name. See FINANCIAL_STATEMENT_FORMS.
    if (!FINANCIAL_STATEMENT_FORMS.has(f.form)) continue;
    const k = `${f.start}|${f.end}`;
    const prev = byPeriod.get(k);
    if (!prev || f.filed > prev.filed) byPeriod.set(k, f);
  }
  const all = [...byPeriod.values()];
  const annuals = all.filter(f => { const d = dayspan(f.start, f.end); return d >= ANNUAL_MIN && d <= ANNUAL_MAX; })
    .sort((a, b) => a.end.localeCompare(b.end));
  const quarters = all.filter(f => { const d = dayspan(f.start, f.end); return d >= QTR_MIN && d <= QTR_MAX; })
    .sort((a, b) => a.end.localeCompare(b.end));
  const base = annuals[annuals.length - 1];
  if (!base) return null;

  // Roll forward through quarters filed since the fiscal year end, requiring CONTIGUITY (a gap would
  // silently drop a quarter of earnings) and a matching quarter a year earlier to net off.
  let val = base.val, windowEnd = base.end, added = 0, cursor = base.end;
  for (const q of quarters) {
    if (dayspan(cursor, q.start) > 5 || dayspan(cursor, q.start) < -5) continue;   // must abut the cursor
    const prior = quarters.find(p => Math.abs(dayspan(p.end, q.end) - 365) <= 12);
    if (!prior) break;                              // cannot net off — stop rolling, keep what we have
    val += q.val - prior.val;
    windowEnd = q.end;
    cursor = q.end;
    added++;
  }

  if (dayspan(windowEnd, asOf) > MAX_WINDOW_AGE_DAYS) return null;   // genuinely stale -> withhold
  return { val, windowEnd, quartersAdded: added };
}

/**
 * Net income over the freshest computable twelve-month window, anchored on fiscal year `A`.
 *
 * Adds year-to-date quarters of A+1 and subtracts the same quarters of A, so no Q4 duration frame
 * is needed (see the IncomeFrames doc for why that matters). Returns null when the anchor annual
 * frame itself is not published yet, so the caller can try an older year.
 *
 * WITHHOLDS PER COMPANY. A filer missing ANY stub component is DROPPED — not scored on its annual
 * figure, and not scored on a partial sum.
 *
 * Why dropping, when the annual figure is real and is what the system used before TTM: the error of
 * falling back is ASYMMETRIC. A stale annual can wrongly EXCLUDE a company that has since recovered
 * — a missed opportunity, the safe direction — but it can equally wrongly INCLUDE one that has since
 * DETERIORATED, whose year-old numbers still look strong while recent quarters collapsed. That
 * second branch puts real money into a name for a reason that is no longer true, which is exactly
 * what CLAUDE.md's "withhold rather than publish" rule exists to prevent. Withholding costs only
 * opportunity.
 *
 * It also keeps the percentile cohort internally comparable: a cross-sectional median is only
 * meaningful if every member is measured over the same window.
 *
 * NOTE the k === 0 case is NOT a fallback and is handled before this function: when NO company has a
 * newer quarter published (the normal state in Q1), the annual is simply the freshest data that
 * exists, applied uniformly, so there is nothing to withhold relative to.
 */
async function buildIncomeFrames(A: number): Promise<IncomeFrames | null> {
  // frameOrFailed, not frame: a THROW here was previously swallowed by the caller's bare catch, which
  // fell through to the previous year with `degraded` still false — caching a year-stale window for
  // 8 days with no signal. The one path finding 5's fix had not converted.
  const annualRaw = await frameOrFailed("NetIncomeLoss", `CY${A}`);
  if (annualRaw === FRAME_FAILED) return { ni: {}, instant: `CY${A}Q4I`, label: `CY${A} (annual frame FETCH FAILED)`, ttmCount: 0, withheldCount: 0, degraded: true };
  const annual = annualRaw;
  if (Object.keys(annual).length <= MIN_FILERS) return null;

  // How many quarters of A+1 are published? Walk forward from Q1 and stop at the first gap: the
  // window must be CONTIGUOUS, since a hole would drop a quarter of earnings from the sum.
  const cur: Array<Record<number, DatedValue>> = [];
  const prior: Array<Record<number, DatedValue>> = [];
  let degraded = false;
  for (let q = 1; q <= 3; q++) {
    const [c, p] = await Promise.all([
      frameOrFailed("NetIncomeLoss", `CY${A + 1}Q${q}`),
      frameOrFailed("NetIncomeLoss", `CY${A}Q${q}`),
    ]);
    // A FAILED fetch is not "unpublished". Mark it, stop rolling, and let the caller refuse to cache
    // — otherwise our own network flake redefines the tradable universe for the whole TTL.
    if (c === FRAME_FAILED || p === FRAME_FAILED) { degraded = true; break; }
    if (Object.keys(c).length <= MIN_FILERS || Object.keys(p).length <= MIN_FILERS) break;
    cur.push(c); prior.push(p);
  }

  const k = cur.length;
  if (k === 0) {
    // Nothing newer than the annual is published — this is exactly the old behaviour, and in Q1 of
    // any year it is the expected state rather than a failure.
    // Uniform annual: nothing is withheld because no company has anything fresher. This is the
    // expected state in Q1 of any year, and it is identical to the pre-TTM behaviour.
    return {
      ni: valuesOnly(annual), instant: `CY${A}Q4I`, ttmCount: 0, withheldCount: 0, degraded,
      label: degraded
        ? `CY${A} (annual — a quarterly frame FETCH FAILED, so this window is short of what SEC has)`
        : `CY${A} (annual — no newer quarter published)`,
    };
  }

  const { ni, ttmCount, withheldCount, misalignedCount } = combineTtm(annual, cur, prior);
  if (misalignedCount > 0) {
    // Off-calendar filers, withheld here on purpose. The per-company recovery pass reads their real
    // fiscal periods and computes a correct window for them.
    console.log("QUALITY_MISALIGNED_WITHHELD", { count: misalignedCount, note: "off-calendar filers -> per-company recovery" });
  }
  return {
    ni,
    instant: `CY${A + 1}Q${k}I`,
    label: `TTM through CY${A + 1}Q${k} (CY${A} + ${k}Q stub)${degraded ? " — a later quarterly FETCH FAILED, window may be short" : ""}`,
    ttmCount, withheldCount, degraded,
  };
}

/**
 * The TTM arithmetic, split out as a PURE function so it can be tested without hitting SEC.
 *
 *   ttm(company) = annual + Σ (currentQ − priorQ)
 *
 * Exported for tests. The fail-safe is the part worth guarding: a company missing ANY quarter on
 * either side keeps its ANNUAL figure. Summing the quarters that DO exist would be wrong by a whole
 * quarter of earnings in an unpredictable direction — understating a profitable name, flattering a
 * loss-making one — and nothing downstream could detect it.
 */
export function combineTtm(
  annual: Record<number, DatedValue>,
  cur: Array<Record<number, DatedValue>>,
  prior: Array<Record<number, DatedValue>>,
): { ni: Record<number, number>; ttmCount: number; withheldCount: number; misalignedCount: number } {
  const k = Math.min(cur.length, prior.length);
  const ni: Record<number, number> = {};
  let ttmCount = 0, withheldCount = 0, misalignedCount = 0;
  for (const cikStr of Object.keys(annual)) {
    const cik = Number(cikStr);
    const base = annual[cik];
    let stub = 0, complete = k > 0, aligned = true;
    let cursor = base.end;
    for (let i = 0; i < k; i++) {
      const c = cur[i][cik], p = prior[i][cik];
      if (!c || !Number.isFinite(c.val) || !p || !Number.isFinite(p.val)) { complete = false; break; }
      // CONTIGUITY, per name. The formula is only a trailing twelve months when each added quarter
      // begins where the previous period ended. SEC assigns AAPL's FY2025 (2024-09-29 → 2025-09-27)
      // to frame CY2025 and its NEXT quarter to CY2025Q4, which this loop never reads — so adding
      // CY2026Q1/Q2 and subtracting CY2025Q1/Q2 operates INSIDE the base annual and yields a
      // twelve-month-duration sum with a HOLE. Measured over live frames: 35 of 334 names, errors to
      // 47.7%, 16 of them OVERSTATING earnings, and two (GIS, STZ) with negative gaps where the added
      // quarter OVERLAPS the annual and double-counts. Those names are withheld here and picked up by
      // the per-company recovery pass, which reads their real fiscal periods.
      const gap = (Date.parse(c.start) - Date.parse(cursor)) / 86_400_000;
      if (!Number.isFinite(gap) || gap < -2 || gap > 5) { aligned = false; break; }
      stub += c.val - p.val;
      cursor = c.end;
    }
    if (!aligned) { misalignedCount++; withheldCount++; continue; }
    // WITHHELD, not defaulted. An absent entry means the name is never scored, so it can never be
    // bought on a quality reading we could not establish.
    if (complete) { ni[cik] = base.val + stub; ttmCount++; }
    else { withheldCount++; }
  }
  return { ni, ttmCount, withheldCount, misalignedCount };
}

/**
 * One company's NetIncomeLoss facts.
 *
 * null = COULD NOT FETCH (network, 403/429, timeout, unparseable). [] = fetched fine, this company
 * genuinely reports no NetIncomeLoss facts — confirmed real for CDNS, CTSH, ENPH, NXPI, which return
 * `units: {}` with a 200.
 *
 * COLLAPSING THE TWO IS A BUG I HAVE NOW SHIPPED THREE TIMES TODAY (lib/news.ts fetchCompanyNews,
 * lib/news.ts extractMaterialNews, and here). Both directions are wrong: treat a failure as empty and
 * a transient outage silently shrinks the tradable universe; treat genuinely-empty as a failure and
 * four always-empty companies mark every run degraded, so nothing is ever cached and the whole sweep
 * repeats on every trade run forever.
 */
/**
 * The shape decision, split out so it can be TESTED. null = could not establish (a fact about US);
 * [] = established that there is nothing (a fact about the COMPANY, and therefore cacheable).
 * Exported because I collapsed these two three times in one day and a comment was not enough.
 *
 * MEASURED SHAPES, checked directly against live SEC on 2026-09-30 rather than assumed — an earlier
 * version of this comment asserted a shape I had not verified and got the discrimination BACKWARDS,
 * which made every healthy run report `degraded` and silently disabled the entire cache:
 *   · V, VFC, CDNS → HTTP 200 with `units.USD` PRESENT as an empty OBJECT `{}`
 *   · SPG          → HTTP 404 (never tags us-gaap:NetIncomeLoss)
 * Both are stable properties of those filers. Neither is a failure.
 */
export function parseConceptResponse(usd: unknown, notFound: boolean): ConceptFact[] | null {
  // 404 = this filer has never tagged the concept. A stable fact about the company, so [] (and
  // therefore cacheable), NOT null. SPG does this live for us-gaap:NetIncomeLoss.
  if (notFound) return [];
  return parseConceptUnits(usd);
}

export function parseConceptUnits(usd: unknown): ConceptFact[] | null {
  // Absent key, or present-but-not-an-array (the live `{}` case): the filer reports nothing under
  // this concept. That is an ANSWER, and caching it is correct.
  if (usd == null) return [];
  if (!Array.isArray(usd)) return [];
  return usd.map((f: any) => ({
    start: typeof f?.start === "string" ? f.start : "",
    end: typeof f?.end === "string" ? f.end : "",
    val: typeof f?.val === "number" ? f.val : NaN,
    filed: typeof f?.filed === "string" ? f.filed : "",
    form: typeof f?.form === "string" ? f.form : "",
  }));
}

/**
 * Net income attributable to the PARENT, derived from a ProfitLoss series.
 *
 * WHY THIS EXISTS. conceptFacts asked only for us-gaap:NetIncomeLoss, and roughly a quarter of
 * utilities and REITs never tag it — they tag ProfitLoss instead. The withheld set was therefore
 * SECTOR-SHAPED: XLU 24%, XLB 21%, XLRE 19%, XLE 13%, and zero in XLK/XLV/XLP.
 *
 * WHY THE OBVIOUS FIX IS WORSE THAN THE BUG. NetIncomeLoss is attributable to the PARENT; ProfitLoss
 * INCLUDES noncontrolling interests. Substituting one for the other inflates earnings for exactly the
 * sectors it is meant to rescue — measured live: FCX's NCI is 46.9% of its ProfitLoss and SPG's is
 * 13.7%, so a drop-in would nearly double Freeport. Fail-OPEN, on the names the bias already
 * disadvantages, which is the worse direction.
 *
 *   parent = ProfitLoss − NCI
 *
 * NCI can be NEGATIVE (DOW: −7.3%, a loss attributable to minorities), where subtracting correctly
 * RAISES parent income. The subtraction handles both signs; special-casing would not.
 *
 * WHEN THE SAME-PERIOD NCI IS MISSING the rule is explicit rather than convenient:
 *   · no NCI fact anywhere → the filer has no minority interests → 0
 *   · a stale NCI that is IMMATERIAL (<1% of that period's ProfitLoss) → 0 (V's is 0.00)
 *   · a stale NCI that is MATERIAL → DROP THAT PERIOD. An adjustment we cannot size is not an
 *     adjustment, and the unadjusted figure would overstate by exactly the amount that matters.
 *
 * DROPPING THE PERIOD, NOT THE FILER. The first version returned null for the whole company on any
 * unsizable period, which withheld Visa — 210 ProfitLoss facts back to 2008, where one ancient
 * small-value period failed the ratio against the all-time max NCI, despite every recent period
 * being cleanly adjustable. Dropping is safe because ttmFromFacts requires CONTIGUITY: a missing
 * period cannot be silently substituted, it just stops the roll or forces an older base.
 */
export const NCI_IMMATERIAL_FRACTION = 0.01;

export function adjustForNci(profitLoss: ConceptFact[], nci: ConceptFact[]): ConceptFact[] | null {
  if (profitLoss.length === 0) return null;
  const byPeriod = new Map<string, ConceptFact>();
  for (const n of nci) {
    if (!n.start || !n.end || !Number.isFinite(n.val)) continue;
    const k = `${n.start}|${n.end}`;
    const prev = byPeriod.get(k);
    if (!prev || n.filed > prev.filed) byPeriod.set(k, n);
  }
  // The largest |NCI| the filer has EVER reported — the yardstick for "does this company have
  // minority interests at all", used only when the matching period is absent.
  const everMaterial = nci.reduce((m, n) => (Number.isFinite(n.val) ? Math.max(m, Math.abs(n.val)) : m), 0);

  const out: ConceptFact[] = [];
  for (const pl of profitLoss) {
    if (!pl.start || !pl.end || !Number.isFinite(pl.val)) continue;
    const match = byPeriod.get(`${pl.start}|${pl.end}`);
    if (match) { out.push({ ...pl, val: pl.val - match.val }); continue; }
    if (everMaterial === 0) { out.push(pl); continue; }
    const scale = Math.abs(pl.val);
    if (scale > 0 && everMaterial / scale < NCI_IMMATERIAL_FRACTION) { out.push(pl); continue; }
    continue;                                      // material but unsized → this PERIOD is unusable
  }
  return out.length > 0 ? out : null;
}

async function conceptFacts(cik: number, concept = "NetIncomeLoss"): Promise<ConceptFact[] | null> {
  const padded = String(cik).padStart(10, "0");
  try {
    // 404 here means the filer has never tagged the concept (SPG does this) — a fact about them.
    const d = await secGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`, { notFoundOk: true });
    return parseConceptResponse(d === SEC_NOT_FOUND ? undefined : d?.units?.USD, d === SEC_NOT_FOUND);
  } catch { return null; }   // network, timeout, non-404 HTTP — a fact about US
}

/**
 * Parent-attributable income facts for one filer, preferring the directly-reported concept and
 * falling back to the NCI-adjusted derivation. Returns null only when we COULD NOT ASK; an empty
 * result means we asked and the filer reports nothing usable.
 */
async function parentIncomeFacts(cik: number, asOf: string): Promise<ConceptFact[] | null> {
  const direct = await conceptFacts(cik, "NetIncomeLoss");
  if (direct === null) return null;
  // THE TEST IS "DOES THIS YIELD A USABLE WINDOW", NOT "ARE THERE ANY FACTS". The first version
  // short-circuited on `direct.length > 0`, so a filer with a handful of unusable NetIncomeLoss facts
  // never reached the ProfitLoss ladder at all — which is why the sector-bias fix barely moved the
  // numbers. Measured: FCX has 11 such facts whose newest annual is a DEF 14A (correctly rejected by
  // the form allowlist), and AEP has 67 whose newest 10-K annual is from 2013 (4,657 days old,
  // correctly rejected by MAX_WINDOW_AGE_DAYS). Both then derived cleanly from ProfitLoss − NCI.
  if (direct.length > 0 && ttmFromFacts(direct, asOf)) return direct;
  // Only now pay for the extra two requests, and only for the filers that need them.
  const pl = await conceptFacts(cik, "ProfitLoss");
  if (pl === null) return null;
  if (pl.length === 0) return direct;     // nothing better available; let the caller withhold
  const nci = await conceptFacts(cik, "NetIncomeLossAttributableToNoncontrollingInterest");
  if (nci === null) return null;
  const derived = adjustForNci(pl, nci);
  // Prefer the DERIVED series only if it actually produces a window. Otherwise hand back `direct` so
  // the outcome is unchanged rather than worse — the ladder must never lose ground.
  if (derived && ttmFromFacts(derived, asOf)) return derived;
  return direct;
}

/** Hard ceiling on the recovery pass. SEC asks for <10 requests/second, and this runs inside the
 *  trade route — an unbounded sweep over a wide universe could both breach fair-access and delay a
 *  live run. Anything past the cap simply stays withheld, which is the safe direction. */
// Raised from 140: the contiguity guard now withholds ~35 off-calendar filers that the frames path
// used to (wrongly) publish, and they all arrive here. Live candidate count is ~131.
export const MAX_RECOVERY_FETCHES = 220;
// 2, not 4, plus an explicit inter-batch pause. Concurrency alone is NOT a rate limit — the rate is
// whatever latency allows, and measured from a laptop that was 18.6 req/sec against SEC's ~10/sec
// fair-access guidance. A 403 here is swallowed into silent withholding, and an IP-level throttle
// would also degrade lib/insider's EDGAR calls.
const RECOVERY_CONCURRENCY = 2;
const RECOVERY_MIN_BATCH_MS = 220;
const RECOVERY_BUDGET_MS = 45_000;

/**
 * Second pass for names the calendar frames could not serve. Fetches each company's own reported
 * facts and derives a twelve-month window from its REAL fiscal periods.
 *
 * This is the root-cause fix for a systematic bias, not a convenience: the frames path withheld
 * ~54 S&P names — essentially the off-calendar fiscal-year cohort, including MSFT — for a reason
 * that has nothing to do with quality. Withholding them was correct given what that path could
 * see; this makes it see further.
 *
 * Bounded three ways (count, concurrency, wall-clock) and failure-tolerant: a name that cannot be
 * recovered stays withheld.
 */
async function recoverWithheld(
  symbols: string[],
  tk2cik: Record<string, number>,
  asOf: string,
): Promise<{ ni: Record<number, number>; recovered: number; attempted: number; truncated: boolean; fetchFailures: number }> {
  const ni: Record<number, number> = {};
  const all = symbols.map(s => tk2cik[s]).filter((c): c is number => c != null);
  const targets = all.slice(0, MAX_RECOVERY_FETCHES);
  const deadline = Date.now() + RECOVERY_BUDGET_MS;
  let recovered = 0, attempted = 0, fetchFailures = 0;
  // Capped BY COUNT counts as truncation too, not just by clock.
  let truncated = all.length > targets.length;
  for (let i = 0; i < targets.length; i += RECOVERY_CONCURRENCY) {
    // Checked BEFORE the batch, so a batch starting just inside the deadline still runs to
    // completion — the overrun is bounded by one request timeout, which is accounted for in the
    // caller's worst case rather than hidden.
    if (Date.now() > deadline) { truncated = true; break; }
    const batchStart = Date.now();
    await Promise.all(targets.slice(i, i + RECOVERY_CONCURRENCY).map(async cik => {
      attempted++;
      const facts = await parentIncomeFacts(cik, asOf);
      // null = could not ASK. That must mark the result degraded so it is never cached, otherwise a
      // slow SEC morning silently makes a slice of the universe unbuyable for the full 8-day TTL.
      // An EMPTY array is a different thing — the company reports no such concept, which is a stable
      // fact about it and perfectly cacheable.
      if (facts === null) { fetchFailures++; return; }
      const ttm = ttmFromFacts(facts, asOf);
      if (ttm) { ni[cik] = ttm.val; recovered++; }
    }));
    const elapsed = Date.now() - batchStart;
    if (elapsed < RECOVERY_MIN_BATCH_MS && i + RECOVERY_CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, RECOVERY_MIN_BATCH_MS - elapsed));
    }
  }
  return { ni, recovered, attempted, truncated, fetchFailures };
}

// Fetch fundamentals from SEC and compute quality scores for the whole tradable universe.
/** SEC lists ~10,000 filers. Anything near-empty is a broken read, not a small market — and without
 *  this check ANY future way of producing an empty map scores nobody while looking perfectly healthy.
 *  Pure so the floor is pinned by a test rather than only by a comment. */
export const MIN_TICKER_MAP = 1000;
export function isUsableTickerMap(m: Record<string, number>): boolean {
  return Object.keys(m).length >= MIN_TICKER_MAP;
}

/** A handful of dead tickers is normal attrition; a large fraction means a broken ticker map.
 *  isUsableTickerMap's floor (1000 of SEC's ~10k) is far too loose to catch a truncated read, and
 *  this list drives DELETIONS from the tradable universe, so the expensive mistake is believing a
 *  truncated map. 5% of ~450 is ~22 — above the ~20 genuinely-dead names observed, far below what a
 *  real truncation produces (a stubbed map printed 449, the whole universe). Pure, so it is tested. */
export const NO_CIK_SUSPECT_FRACTION = 0.05;
export function isNoCikImplausible(noCikCount: number, universeSize: number): boolean {
  if (universeSize <= 0) return true; // nothing to measure against — never claim "stale"
  return noCikCount / universeSize > NO_CIK_SUSPECT_FRACTION;
}

export async function fetchQualityFromSEC(): Promise<QualityData> {
  // No notFoundOk: a 404 here must THROW, so getQualityScores returns null, the real alert fires, and
  // the book keeps trading momentum-only — the behaviour before the sentinel existed.
  const tickersJson = await secGet("https://www.sec.gov/files/company_tickers.json");
  const tk2cik: Record<string, number> = {};
  for (const k of Object.keys(tickersJson ?? {})) {
    const v = tickersJson[k];
    if (v?.ticker && typeof v?.cik_str === "number") tk2cik[v.ticker] = v.cik_str;
  }
  if (!isUsableTickerMap(tk2cik)) {
    throw new Error(`SEC ticker map implausibly small (${Object.keys(tk2cik).length}) — refusing to score an empty universe`);
  }

  // Try the most recent fiscal year that has data, newest first, derived from the clock.
  let eq: Record<number, number> = {}, ast: Record<number, number> = {}, lia: Record<number, number> = {}, ni: Record<number, number> = {};
  let usedPeriod = "";
  let degraded = false, ttmFromFrames = 0, recoveredPerCompany = 0;
  const started = Date.now();
  const thisYear = new Date().getUTCFullYear();
  for (const A of [thisYear - 1, thisYear - 2]) {
    if (Date.now() - started > QUALITY_FRAMES_BUDGET_MS) {
      console.warn("QUALITY_FRAMES_BUDGET_EXCEEDED", { ms: Date.now() - started });
      break;
    }
    try {
      const inc = await buildIncomeFrames(A);
      if (!inc) continue;
      // Hoisted ABOVE the population gate on purpose. The previous version assigned `degraded` only
      // inside the success branch below, so an annual-frame FETCH FAILURE — which returns ni:{} and
      // therefore fails that gate — fell through to the prior year with degraded still FALSE and got
      // cached for 8 days on a window ~9 months staler than available. The fix was inert: it moved
      // the throw into a return value that the caller discarded.
      if (inc.degraded) degraded = true;
      // BOTH instants, newer preferred PER NAME.
      //
      // Moving the balance sheet from CY{A}Q4I to the newer CY{A+1}Q{k}I to match the TTM window was
      // conceptually right but silently dropped 25 names — 15 utilities and 4 REITs (AEP DUK SO NEE D
      // PLD DLR …) that report Assets at the older instant and not the newer one. That removed XLU
      // and XLRE from the buyable set entirely, on a strategy with no defensive rotation, and for a
      // HELD name it would have read as "lost quality-eligibility" and authorised a sell.
      //
      // So: prefer the instant that matches the income window, fall back per name to the previous
      // year-end. The residual is a <=2-quarter mismatch between numerator and denominator for those
      // names, which mildly overstates ROA (assets usually grow) — bounded, disclosed, and far
      // cheaper than deleting two sectors from the universe.
      const older = `CY${A}Q4I`;
      const [eN, aN, lN, eO, aO, lO] = await Promise.all([
        frameOrFailed("StockholdersEquity", inc.instant), frameOrFailed("Assets", inc.instant), frameOrFailed("Liabilities", inc.instant),
        frameOrFailed("StockholdersEquity", older), frameOrFailed("Assets", older), frameOrFailed("Liabilities", older),
      ]);
      const ok = (x: Record<number, DatedValue> | typeof FRAME_FAILED): Record<number, number> => (x === FRAME_FAILED ? {} : valuesOnly(x));
      const anyInstantFailed = [eN, aN, lN, eO, aO, lO].some(x => x === FRAME_FAILED);
      // Spread order matters: the NEWER instant wins where both have the name.
      const e = { ...ok(eO), ...ok(eN) };
      const a = { ...ok(aO), ...ok(aN) };
      const l = { ...ok(lO), ...ok(lN) };
      // Require Equity, Assets AND NetIncome to be well-populated — frames publish per-concept and can
      // lag independently. Accepting a period with a sparse Assets frame would collapse ROA/leverage for
      // the whole universe (every name hits a==null) → empty eligible set. Fall back to the prior year.
      if (Object.keys(e).length > MIN_FILERS && Object.keys(a).length > MIN_FILERS && Object.keys(inc.ni).length > MIN_FILERS) {
        eq = e; ast = a; lia = l; ni = inc.ni; usedPeriod = inc.label;
        degraded = degraded || inc.degraded || anyInstantFailed;
        ttmFromFrames = inc.ttmCount;
        console.log("QUALITY_PERIOD", {
          income: inc.label, balanceSheet: `${inc.instant} (falling back per name to ${older})`,
          ttmFilers: inc.ttmCount, withheldByFrames: inc.withheldCount, degraded,
        });
        break;
      }
    } catch { /* try older period */ }
  }
  if (!usedPeriod) throw new Error("SEC frames unavailable for all periods");

  // RECOVERY PASS. The frames are calendar-shaped and cannot serve off-calendar fiscal years, so
  // names still missing net income get a per-company lookup against their real reported periods.
  const asOfDate = new Date().toISOString().slice(0, 10);
  const stillMissing = Object.keys(STOCK_SECTOR).filter(sym => {
    const cik = tk2cik[sym];
    return cik != null && ni[cik] == null && ast[cik] != null;   // only worth recovering if we have assets
  });
  if (stillMissing.length > 0) {
    const rec = await recoverWithheld(stillMissing, tk2cik, asOfDate);
    Object.assign(ni, rec.ni);
    recoveredPerCompany = rec.recovered;
    // A truncated or partly-failed recovery is NOT a result: which names end up unbuyable would
    // depend on how far the sweep got. Mark degraded so getQualityScores refuses to cache it.
    if (rec.truncated || rec.fetchFailures > 0) degraded = true;
    console.log("QUALITY_RECOVERY", {
      candidates: stillMissing.length, attempted: rec.attempted, recovered: rec.recovered,
      stillWithheld: stillMissing.length - rec.recovered,
      truncated: rec.truncated, fetchFailures: rec.fetchFailures,
    });
  }

  // Raw metrics per symbol (only names in our sector map, i.e. the tradable universe).
  const raw: Record<string, { roe: number | null; roa: number; lev: number | null }> = {};
  for (const sym of Object.keys(STOCK_SECTOR)) {
    const cik = tk2cik[sym];
    if (cik == null) continue;
    const e = eq[cik], a = ast[cik], l = lia[cik], n = ni[cik];
    // Need Assets (>0) + NetIncome. NEGATIVE stockholders' equity is common in strong buyback-heavy
    // names (DPZ, PM, YUM, BKNG, LOW, HD, MCD, ABBV…) — do NOT penalize them; both equity-based terms
    // are artifacts there. ROE is meaningless (drop it). AND book leverage (liabilities/assets) is
    // ALSO an artifact: when equity is negative, liabilities EXCEED assets by construction, so l/a
    // balloons past 100% and reads as "over-levered" even for an elite, shareholder-friendly business
    // (measured 2026-08-28: DPZ ROA 35% — one of the S&P's most profitable names — was excluded on
    // this). So for KNOWN-negative-equity names, drop the leverage term too and score on ROA alone (the
    // robust quality signal there). NOTE: only when equity is KNOWN negative (e ≤ 0) — an UNREPORTED
    // equity (e == null) leaves l/a meaningful, so we keep leverage then.
    if (a == null || n == null || a <= 0) continue;
    const sec = STOCK_SECTOR[sym];
    const isFin = sec === "XLF" || sec === "XLRE";       // banks/REITs: drop the leverage term
    const negEq = e != null && e <= 0;                   // buyback-driven negative book equity
    raw[sym] = { roe: e != null && e > 0 ? n / e : null, roa: n / a, lev: (!isFin && !negEq && l != null) ? l / a : null };
  }

  // Cross-sectional percentiles.
  const roeP = percentileFn(Object.values(raw).filter(r => r.roe != null).map(r => r.roe as number));
  const roaP = percentileFn(Object.values(raw).map(r => r.roa));
  const levP = percentileFn(Object.values(raw).filter(r => r.lev != null).map(r => r.lev as number));
  const scores: Record<string, QualityScore> = {};
  for (const [sym, r] of Object.entries(raw)) {
    const parts = [roaP(r.roa)];
    if (r.roe != null) parts.push(roeP(r.roe));
    if (r.lev != null) parts.push(1 - levP(r.lev)); // lower leverage = better
    scores[sym] = { quality: parts.reduce((s, x) => s + x, 0) / parts.length, roe: r.roe, roa: r.roa, lev: r.lev, eligible: false };
  }
  const qs = Object.values(scores).map(s => s.quality).sort((a, b) => a - b);
  const median = qs.length ? qs[Math.floor(qs.length / 2)] : 0.5;
  for (const s of Object.values(scores)) s.eligible = s.quality >= median;

  // Universe names we could NOT establish quality for. Reported so the caller can keep them out of
  // the BUY allowlist WITHOUT making a held one look like it fell off the shortlist.
  const withheld = Object.keys(STOCK_SECTOR).filter(sym => scores[sym] == null);
  // SPLIT THE REPORTING, because these are different problems wearing the same symptom. A name with
  // no CIK in SEC's ticker file is not "unmeasurable" — it has LEFT the market (ANSS acquired by
  // Synopsys, CDAY renamed Dayforce, JNPR acquired by HPE, IPG merged into Omnicom), and its presence
  // means the hardcoded STOCK_SECTOR universe is stale. Lumping it in with genuine data gaps hides
  // that and inflates the withheld count. Both still go into `withheld` — a dead ticker cannot be
  // held, so there is no behaviour to change, and keeping it there preserves the safe direction.
  const noCik = withheld.filter(sym => tk2cik[sym] == null);
  const universeSize = Object.keys(STOCK_SECTOR).length;
  const noCikSuspect = isNoCikImplausible(noCik.length, universeSize);
  if (noCik.length > 0) {
    console.log("QUALITY_STALE_UNIVERSE", {
      count: noCik.length, universeSize, symbols: noCik.slice(0, 30), suspect: noCikSuspect,
      note: noCikSuspect
        ? "IMPLAUSIBLY MANY missing CIKs — suspect a TRUNCATED ticker map, NOT a stale universe. Do NOT prune on this."
        : "no CIK in SEC's ticker file — delisted/renamed/acquired, not a data gap. STOCK_SECTOR needs pruning.",
    });
  }
  return {
    scores, median, period: usedPeriod, asOf: new Date().toISOString().slice(0, 10),
    withheld, degraded,
    staleUniverse: noCik,
    staleUniverseSuspect: noCikSuspect,
    basis: {
      ttmFromFrames, recoveredPerCompany,
      withheld: withheld.length,
      // Of those, how many are simply gone from the market rather than unmeasurable.
      withheldNoCik: noCik.length,
    },
  };
}

// ── Redis-cached accessor (self-contained Upstash REST, same env as run-store) ───────────────────────
async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json() as { result: string | null };
  return j.result;
}
async function redisSetEx(key: string, value: string, ttl: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["set", key, value, "EX", ttl]]),
  });
}

// Returns cached quality scores, refreshing from SEC if missing/expired. `force` bypasses the cache.
// Fail-safe: on any SEC/Redis error returns null so callers can fall back to "no quality filter".
/**
 * Is this result fit to persist for CACHE_TTL_SEC? Pure and exported so the invariant is testable.
 *
 * Two refusals. `degraded` means some fetch failed rather than returning a real answer — caching that
 * freezes a transient fault for 8 days, and because WHICH names are withheld depends on how much data
 * arrived, it would redefine the tradable universe for the whole window. An EMPTY score set means we
 * scored nobody, which is never a legitimate steady state and is what a broken ticker map looks like.
 */
export function shouldCache(data: QualityData): boolean {
  if (data.degraded) return false;
  if (Object.keys(data.scores).length === 0) return false;
  return true;
}

export async function getQualityScores(force = false): Promise<QualityData | null> {
  try {
    if (!force) {
      const cached = await redisGet(CACHE_KEY);
      if (cached) {
        const hit = JSON.parse(cached) as QualityData;
        // A cache entry written BEFORE staleUniverse existed has no such field, and the TTL is 8
        // days — so for over a week every consumer would see `undefined` where the type promises an
        // array. `q.staleUniverse.length` in /api/debug would throw on a cache HIT, i.e. the common
        // path, and only on the common path. Normalising on read is the whole fix; the alternative
        // (reaching for `?.` at each call site) re-opens the same hole for the next consumer.
        if (!Array.isArray(hit.staleUniverse)) hit.staleUniverse = [];
        if (typeof hit.staleUniverseSuspect !== "boolean") hit.staleUniverseSuspect = false;
        return hit;
      }
    }
    const data = await fetchQualityFromSEC();
    // NEVER cache a degraded result. A failed fetch cached for 8 days is the documented
    // transient-becomes-persistent trap, and here it is worse than usual: which names are withheld
    // depends on how many quarters were retrieved, so one network flake would redefine the tradable
    // universe for the whole TTL. Recompute next run instead.
    //
    // The decision is `shouldCache`, a PURE function, because a review mutation-swept this module and
    // found this `if` could be deleted outright with the whole suite still green — the single
    // highest-stakes invariant here, unpinned after three rounds. CLAUDE.md requires breaking a guard
    // and watching the test fail; that is only possible if the guard is reachable from a test.
    if (!shouldCache(data)) {
      // SEPARATE NAMES for the two refusals. The DECISION became !shouldCache(...) but this CLAIM did
      // not follow it, so a run refused for an EMPTY SCORE SET still announced "degraded" — pointing
      // the next investigation at SEC connectivity when the real cause is a broken ticker map. Exactly
      // CLAUDE.md's "a predicate consumed by BOTH a machine decision and a human message: widening it
      // for the decision silently widens the CLAIM". One extra branch keeps them independent.
      if (data.degraded) {
        console.warn("QUALITY_DEGRADED_NOT_CACHED", { period: data.period, withheld: data.withheld.length });
      } else {
        console.error("QUALITY_EMPTY_NOT_CACHED", {
          period: data.period, scored: Object.keys(data.scores).length, withheld: data.withheld.length,
          note: "scored NOBODY — a broken ticker map or universe lookup, NOT a SEC connectivity problem",
        });
      }
    } else {
      await redisSetEx(CACHE_KEY, JSON.stringify(data), CACHE_TTL_SEC).catch(() => {});
    }
    return data;
  } catch (e) {
    console.warn("QUALITY_SCORES_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    return null;
  }
}
