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
const CACHE_KEY = "quality:scores:v2";
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
  ttmCount: number;             // filers that got a real TTM figure
  annualCount: number;          // filers that fell back to the annual figure
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
  period: string;         // which fiscal year the numbers are from
  asOf: string;           // ISO date the scores were computed
}

async function secGet(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return res.json();
}

async function frame(concept: string, period: string): Promise<Record<number, number>> {
  const d = await secGet(`https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/USD/${period}.json`);
  const out: Record<number, number> = {};
  for (const row of (d?.data ?? [])) if (typeof row?.val === "number") out[row.cik] = row.val;
  return out;
}

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

/**
 * Net income over the freshest computable twelve-month window, anchored on fiscal year `A`.
 *
 * Adds year-to-date quarters of A+1 and subtracts the same quarters of A, so no Q4 duration frame
 * is needed (see the IncomeFrames doc for why that matters). Returns null when the anchor annual
 * frame itself is not published yet, so the caller can try an older year.
 *
 * FAILS SAFE PER COMPANY. A filer missing ANY stub component keeps its ANNUAL figure rather than a
 * partial sum. Treating an absent quarter as zero would fabricate a TTM that is wrong by a whole
 * quarter of earnings — and it would be wrong in an unpredictable direction, understating a
 * profitable name and flattering a loss-making one. A known-stale number beats an invented one.
 */
async function buildIncomeFrames(A: number): Promise<IncomeFrames | null> {
  const annual = await frame("NetIncomeLoss", `CY${A}`);
  if (Object.keys(annual).length <= MIN_FILERS) return null;

  // How many quarters of A+1 are published? Walk forward from Q1 and stop at the first gap: the
  // window must be CONTIGUOUS, since a hole would drop a quarter of earnings from the sum.
  const cur: Array<Record<number, number>> = [];
  const prior: Array<Record<number, number>> = [];
  for (let q = 1; q <= 3; q++) {
    const [c, p] = await Promise.all([
      frame("NetIncomeLoss", `CY${A + 1}Q${q}`).catch(() => ({})),
      frame("NetIncomeLoss", `CY${A}Q${q}`).catch(() => ({})),
    ]);
    if (Object.keys(c).length <= MIN_FILERS || Object.keys(p).length <= MIN_FILERS) break;
    cur.push(c); prior.push(p);
  }

  const k = cur.length;
  if (k === 0) {
    // Nothing newer than the annual is published — this is exactly the old behaviour, and in Q1 of
    // any year it is the expected state rather than a failure.
    return { ni: annual, instant: `CY${A}Q4I`, label: `CY${A} (annual — no newer quarter published)`, ttmCount: 0, annualCount: Object.keys(annual).length };
  }

  const { ni, ttmCount, annualCount } = combineTtm(annual, cur, prior);
  return {
    ni,
    instant: `CY${A + 1}Q${k}I`,
    label: `TTM through CY${A + 1}Q${k} (CY${A} + ${k}Q stub)`,
    ttmCount, annualCount,
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
  annual: Record<number, number>,
  cur: Array<Record<number, number>>,
  prior: Array<Record<number, number>>,
): { ni: Record<number, number>; ttmCount: number; annualCount: number } {
  const k = Math.min(cur.length, prior.length);
  const ni: Record<number, number> = {};
  let ttmCount = 0, annualCount = 0;
  for (const cikStr of Object.keys(annual)) {
    const cik = Number(cikStr);
    let stub = 0, complete = k > 0;
    for (let i = 0; i < k; i++) {
      const c = cur[i][cik], p = prior[i][cik];
      if (typeof c !== "number" || !Number.isFinite(c) || typeof p !== "number" || !Number.isFinite(p)) {
        complete = false; break;
      }
      stub += c - p;
    }
    if (complete) { ni[cik] = annual[cik] + stub; ttmCount++; }
    else { ni[cik] = annual[cik]; annualCount++; }
  }
  return { ni, ttmCount, annualCount };
}

// Fetch fundamentals from SEC and compute quality scores for the whole tradable universe.
export async function fetchQualityFromSEC(): Promise<QualityData> {
  const tickersJson = await secGet("https://www.sec.gov/files/company_tickers.json");
  const tk2cik: Record<string, number> = {};
  for (const k of Object.keys(tickersJson)) {
    const v = tickersJson[k];
    if (v?.ticker && typeof v?.cik_str === "number") tk2cik[v.ticker] = v.cik_str;
  }

  // Try the most recent fiscal year that has data, newest first, derived from the clock.
  let eq: Record<number, number> = {}, ast: Record<number, number> = {}, lia: Record<number, number> = {}, ni: Record<number, number> = {};
  let usedPeriod = "";
  const thisYear = new Date().getUTCFullYear();
  for (const A of [thisYear - 1, thisYear - 2]) {
    try {
      const inc = await buildIncomeFrames(A);
      if (!inc) continue;
      const [e, a, l] = await Promise.all([
        frame("StockholdersEquity", inc.instant), frame("Assets", inc.instant), frame("Liabilities", inc.instant),
      ]);
      // Require Equity, Assets AND NetIncome to be well-populated — frames publish per-concept and can
      // lag independently. Accepting a period with a sparse Assets frame would collapse ROA/leverage for
      // the whole universe (every name hits a==null) → empty eligible set. Fall back to the prior year.
      if (Object.keys(e).length > MIN_FILERS && Object.keys(a).length > MIN_FILERS && Object.keys(inc.ni).length > MIN_FILERS) {
        eq = e; ast = a; lia = l; ni = inc.ni; usedPeriod = inc.label;
        console.log("QUALITY_PERIOD", {
          income: inc.label, balanceSheet: inc.instant,
          ttmFilers: inc.ttmCount, annualFallbackFilers: inc.annualCount,
        });
        break;
      }
    } catch { /* try older period */ }
  }
  if (!usedPeriod) throw new Error("SEC frames unavailable for all periods");

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

  return { scores, median, period: usedPeriod, asOf: new Date().toISOString().slice(0, 10) };
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
export async function getQualityScores(force = false): Promise<QualityData | null> {
  try {
    if (!force) {
      const cached = await redisGet(CACHE_KEY);
      if (cached) return JSON.parse(cached) as QualityData;
    }
    const data = await fetchQualityFromSEC();
    await redisSetEx(CACHE_KEY, JSON.stringify(data), CACHE_TTL_SEC).catch(() => {});
    return data;
  } catch (e) {
    console.warn("QUALITY_SCORES_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    return null;
  }
}
