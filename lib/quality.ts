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
const CACHE_KEY = "quality:scores:v1";
const CACHE_TTL_SEC = 8 * 24 * 3600; // ~weekly refresh
// Calendar periods to try, most-recent first: [balance-sheet instant, income duration].
const PERIODS: Array<[string, string]> = [["CY2025Q4I", "CY2025"], ["CY2024Q4I", "CY2024"]];

export interface QualityScore {
  quality: number;        // 0–1 cross-sectional percentile composite (higher = better)
  roe: number | null;     // null when equity is non-positive (ROE undefined; scored on ROA + leverage)
  roa: number;
  lev: number | null;     // null for Financials/Real Estate (leverage term dropped)
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

// Fetch fundamentals from SEC and compute quality scores for the whole tradable universe.
export async function fetchQualityFromSEC(): Promise<QualityData> {
  const tickersJson = await secGet("https://www.sec.gov/files/company_tickers.json");
  const tk2cik: Record<string, number> = {};
  for (const k of Object.keys(tickersJson)) {
    const v = tickersJson[k];
    if (v?.ticker && typeof v?.cik_str === "number") tk2cik[v.ticker] = v.cik_str;
  }

  // Try the most recent fiscal year that has data.
  let eq: Record<number, number> = {}, ast: Record<number, number> = {}, lia: Record<number, number> = {}, ni: Record<number, number> = {};
  let usedPeriod = "";
  for (const [inst, dur] of PERIODS) {
    try {
      const [e, a, l, n] = await Promise.all([
        frame("StockholdersEquity", inst), frame("Assets", inst), frame("Liabilities", inst), frame("NetIncomeLoss", dur),
      ]);
      // Require Equity, Assets AND NetIncome to be well-populated — frames publish per-concept and can
      // lag independently. Accepting a period with a sparse Assets frame would collapse ROA/leverage for
      // the whole universe (every name hits a==null) → empty eligible set. Fall back to the prior year.
      if (Object.keys(e).length > 500 && Object.keys(a).length > 500 && Object.keys(n).length > 500) {
        eq = e; ast = a; lia = l; ni = n; usedPeriod = dur; break;
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
    // names (HD, MCD, ABBV, PM, AZO…) — do NOT exclude them; ROE is just meaningless there, so drop the
    // ROE term and score on ROA + leverage. (Excluding them would blacklist them from the whole book.)
    if (a == null || n == null || a <= 0) continue;
    const sec = STOCK_SECTOR[sym];
    const isFin = sec === "XLF" || sec === "XLRE";       // banks/REITs: drop the leverage term
    raw[sym] = { roe: e != null && e > 0 ? n / e : null, roa: n / a, lev: !isFin && l != null ? l / a : null };
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
