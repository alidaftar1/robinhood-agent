/**
 * FREE-CASH-FLOW EXPERIMENT — does a cash-flow test improve the main book's quality screen?
 *
 *   bun scripts/fcf-backtest.ts [--only id,id] [--from YYYY-MM-DD] [--n 7]
 *
 * Asked 2026-11-02 after BE's Q3 2026 FCF came in at about −$181M (OCF −$27M, capex $154M) while
 * the live quality composite (ROE / ROA / leverage) passed it at 0.68: the screen has no cash-flow term.
 *
 * All variants sit ON TOP of the live rule as scripts/sector-cap-backtest.ts models it ("3x-spy-max3":
 * ≤ 3× S&P sector weight, max 3 names/sector, 7 names, quality ARY / netinc, historical sectors).
 * Same engine, data, rebalance, stops and costs; only the FCF rule differs:
 *
 *   base        the live rule (reproduces sector-cap-backtest's 3x-spy-max3 at --n 7)
 *   fcfpos      drop a name whose trailing-12-month FCF ≤ 0 (latest ART filing public on the date)
 *   fcfq        FCF / assets (ART) as a 4th equal-weight component of the quality composite; the
 *               above-median eligibility cut is then taken on that composite
 *   fcfpos-q    drop only when TTM FCF ≤ 0 AND the latest quarter's operating cash flow < 0 (ARQ) —
 *               the BE-style warning
 *
 * Missing FCF never excludes a name (fail-open; ~1-4% of filings) — counted and reported.
 *
 * DATA: ART/ARQ cash-flow rows extracted locally from ~/.cache/sharadar/fundamentals.csv.zip into
 * $FCF_CSV (ticker,dimension,calendardate,date,assets,capex,fcf,ncfo,revenue). Keyed on the FILING
 * date (`date`), as-reported dimensions only, so no look-ahead or restatement (see
 * lib/sharadar-quality's three traps).
 *
 * Research only: reads local files, writes nothing, touches no live code path.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { buildCaptureDayFromHistory, buildDateIndex, type Series } from "../lib/sharadar-features";
import { runBacktest, DEFAULT_BACKTEST } from "../lib/backtest";
import { LIVE_PROXY, toVariantDay, type StrategyVariant, type VariantPick } from "../lib/strategy-variant";
import { parseFundamentalsCsv, buildFundamentalIndex, qualityAsOf, latestFilingAsOf, type FundamentalIndex } from "../lib/sharadar-quality";
import { STOCK_SECTOR } from "../lib/market-data";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const FCF_CSV = process.env.FCF_CSV;
if (!FCF_CSV) throw new Error("set FCF_CSV to the extracted ART/ARQ cash-flow CSV");
const DATA_FROM = "1997-12-31", TEST_TO = "2026-09-29";
const arg = (k: string) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null;
const TEST_FROM = arg("--from") ?? "1999-01-04";
const only = arg("--only")?.split(",") ?? null;
const N = parseInt(arg("--n") ?? "7", 10);

// ── historical sectors (as sector-cap-backtest) ─────────────────────────────
function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}
const metaLines = (await Bun.file(`${CACHE}/sp500_tickers_meta.csv`).text()).split("\n").filter(Boolean);
const mh = parseCsvLine(metaLines[0]);
const iTk = mh.indexOf("ticker"), iSec = mh.indexOf("sector");
const HIST_SECTOR = new Map<string, string>();
for (const l of metaLines.slice(1)) { const f = parseCsvLine(l); if (f[iSec]) HIST_SECTOR.set(f[iTk], f[iSec]); }
for (const k of Object.keys(STOCK_SECTOR)) delete (STOCK_SECTOR as Record<string, string>)[k];
for (const [t, s] of HIST_SECTOR) (STOCK_SECTOR as Record<string, string>)[t] = s;
const sectorOf = (t: string) => HIST_SECTOR.get(t) ?? "?";

// ── market caps (ART) for index sector weights ──────────────────────────────
const CAPS = new Map<string, Array<{ date: string; cap: number }>>();
{
  const lines = (await Bun.file(`${CACHE}/sp500_fund_all.csv`).text()).split("\n");
  const h = lines[0].split(",");
  const iT = h.indexOf("ticker"), iD = h.indexOf("dimension"), iDt = h.indexOf("date"), iC = h.indexOf("marketcap");
  for (const l of lines.slice(1)) {
    const f = l.split(",");
    if (f[iD] !== "ART") continue;
    const cap = +f[iC]; if (!Number.isFinite(cap) || cap <= 0) continue;
    let a = CAPS.get(f[iT]); if (!a) { a = []; CAPS.set(f[iT], a); } a.push({ date: f[iDt], cap });
  }
  for (const a of CAPS.values()) a.sort((x, y) => x.date.localeCompare(y.date));
}
const capAsOf = (t: string, date: string): number | null => {
  const a = CAPS.get(t); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].date <= date) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? a[best].cap : null;
};

// ── cash flow (ART = TTM, ARQ = quarter), keyed on filing date ──────────────
type CF = { filed: string; fcf: number | null; ncfo: number | null; assets: number | null };
const ART = new Map<string, CF[]>(), ARQ = new Map<string, CF[]>();
{
  const lines = (await Bun.file(FCF_CSV).text()).split("\n");
  const h = lines[0].split(",");
  const ix = (k: string) => { const i = h.indexOf(k); if (i < 0) throw new Error(`FCF_CSV missing ${k}`); return i; };
  const iT = ix("ticker"), iD = ix("dimension"), iF = ix("date"), iA = ix("assets"), iFcf = ix("fcf"), iO = ix("ncfo");
  const num = (s: string) => s === "" || s == null ? null : (Number.isFinite(+s) ? +s : null);
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const f = l.split(",");
    const m = f[iD] === "ART" ? ART : f[iD] === "ARQ" ? ARQ : null;
    if (!m || !f[iF]) continue;
    let a = m.get(f[iT]); if (!a) { a = []; m.set(f[iT], a); }
    a.push({ filed: f[iF], fcf: num(f[iFcf]), ncfo: num(f[iO]), assets: num(f[iA]) });
  }
  for (const m of [ART, ARQ]) for (const a of m.values()) a.sort((x, y) => x.filed.localeCompare(y.filed));
}
const cfAsOf = (m: Map<string, CF[]>, t: string, date: string): CF | null => {
  const a = m.get(t); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid].filed <= date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  // Stale guard: a filing older than ~15 months is not "the latest TTM" for a live company.
  return Date.parse(date) - Date.parse(a[best].filed) > 460 * 86_400_000 ? null : a[best];
};

// ── prices / universe / quality (as sector-cap-backtest) ────────────────────
async function loadAll(): Promise<Series> {
  const series: Series = new Map();
  const dec = new TextDecoder(); let carry = "", seenHeader = false;
  const ingest = (line: string) => {
    if (!line) return;
    const f = line.split(","); if (f.length < 8) return;
    const date = f[1]; if (date < DATA_FROM || date > TEST_TO) return;
    const close = +f[5]; if (!Number.isFinite(close) || close <= 0) return;
    const ca = +f[7];
    let bars = series.get(f[0]); if (!bars) { bars = []; series.set(f[0], bars); }
    bars.push({ date, close, high: +f[3], closeadj: Number.isFinite(ca) && ca > 0 ? ca : close });
  };
  for await (const chunk of Bun.file(`${CACHE}/sp500_prices.csv`).stream() as unknown as AsyncIterable<Uint8Array>) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
      if (!seenHeader) { seenHeader = true; continue; }
      ingest(line);
    }
  }
  if (carry) ingest(carry);
  for (const bars of series.values()) bars.sort((a, b) => a.date.localeCompare(b.date));
  return series;
}
const series = await loadAll();
const dateIdx = buildDateIndex(series);
const spy = new Map<string, number>();
for (const line of (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)) {
  const f = line.split(","); if (f.length < 8) continue;
  const v = +f[7]; if (f[1] && Number.isFinite(v) && v > 0) spy.set(f[1], v);
}
const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const fundRows = parseFundamentalsCsv(await Bun.file(`${CACHE}/sp500_fund_all.csv`).text(),
  { dimension: "ARY", tickers: new Set(sp500Rows.map(r => r.ticker)), basis: "netinc" });
const fundIndex = buildFundamentalIndex(fundRows);
// TTM quality, as production computes it (lib/quality.ts: TTM net income over the latest balance
// sheet). Sharadar ART = as-reported trailing twelve months, keyed on the filing date like ARY.
const fundIndexTTM = buildFundamentalIndex(parseFundamentalsCsv(await Bun.file(`${CACHE}/sp500_fund_all.csv`).text(),
  { dimension: "ART", tickers: new Set(sp500Rows.map(r => r.ticker)), basis: "netinc" }));
/** Production's Financials/Real Estate test (lib/quality isFin) reads ETF codes; the backtest's
 *  historical map holds Sharadar sector NAMES, so lib/sharadar-quality's isFin never fires there. */
const FIN_SECTORS = new Set(["Financial Services", "Real Estate"]);
const tradingDays = [...dateIdx.keys()].filter(d => d >= TEST_FROM && d <= TEST_TO && spy.has(d)).sort();

const weightCache = new Map<string, Map<string, number>>();
function indexWeights(date: string): Map<string, number> {
  const month = date.slice(0, 7);
  const hit = weightCache.get(month); if (hit) return hit;
  const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
  const by = new Map<string, number>(); let tot = 0;
  for (const t of members) { const c = capAsOf(t, date); if (c == null) continue; const s = sectorOf(t); by.set(s, (by.get(s) ?? 0) + c); tot += c; }
  const w = new Map<string, number>(); if (tot > 0) for (const [s, v] of by) w.set(s, v / tot);
  weightCache.set(month, w); return w;
}

/** lib/sharadar-quality qualityAsOf, term for term, plus FCF/assets (ART) as a 4th percentile part. */
function quality4(cohort: Iterable<string>, index: FundamentalIndex, asOf: string, opts: { fcf?: boolean; finFix?: boolean } = { fcf: true }): Map<string, number> {
  const percentileFn = (vals: number[]) => { const s = [...vals].sort((a, b) => a - b); const n = s.length || 1;
    return (x: number) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m + 1; else hi = m; } return lo / n; }; };
  const raw = new Map<string, { roe: number | null; roa: number; lev: number | null; fcfa: number | null }>();
  for (const sym of cohort) {
    const f = latestFilingAsOf(index.get(sym), asOf); if (!f) continue;
    const a = f.assets, e = f.equity, l = f.liabilities, n = f.netinc;
    if (a == null || n == null || a <= 0) continue;
    const sec = STOCK_SECTOR[sym]; const isFin = sec === "XLF" || sec === "XLRE" || (opts.finFix === true && FIN_SECTORS.has(sec)); const negEq = e != null && e <= 0;
    const cf = cfAsOf(ART, sym, asOf);
    raw.set(sym, { roe: e != null && e > 0 ? n / e : null, roa: n / a, lev: !isFin && !negEq && l != null ? l / a : null,
      fcfa: opts.fcf !== false && cf && cf.fcf != null && cf.assets != null && cf.assets > 0 ? cf.fcf / cf.assets : null });
  }
  const vals = [...raw.values()];
  const roeP = percentileFn(vals.filter(r => r.roe != null).map(r => r.roe as number));
  const roaP = percentileFn(vals.map(r => r.roa));
  const levP = percentileFn(vals.filter(r => r.lev != null).map(r => r.lev as number));
  const fcfP = percentileFn(vals.filter(r => r.fcfa != null).map(r => r.fcfa as number));
  const q = new Map<string, number>();
  for (const [sym, r] of raw) {
    const parts = [roaP(r.roa)];
    if (r.roe != null) parts.push(roeP(r.roe));
    if (r.lev != null) parts.push(1 - levP(r.lev));
    if (r.fcfa != null) parts.push(fcfP(r.fcfa));
    q.set(sym, parts.reduce((s, x) => s + x, 0) / parts.length);
  }
  return q;
}

type QMode = "ary" | "ary4" | "art" | "art-fin" | "art4";
function qualityFor(mode: QMode, members: Set<string>, date: string): Map<string, number> {
  if (mode === "ary") return qualityAsOf(members, fundIndex, date, "netinc").quality;
  if (mode === "ary4") return quality4(members, fundIndex, date);
  if (mode === "art") return qualityAsOf(members, fundIndexTTM, date, "netinc").quality;
  if (mode === "art-fin") return quality4(members, fundIndexTTM, date, { fcf: false, finFix: true });
  return quality4(members, fundIndexTTM, date, { fcf: true });
}
function* dayStream(mode: QMode) {
  let qCache: Map<string, number> | null = null, peCache: Map<string, number> | null = null, qMonth = "";
  for (const date of tradingDays) {
    const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
    const month = date.slice(0, 7);
    if (month !== qMonth) {
      const r = qualityAsOf(members, fundIndex, date, "netinc");
      qCache = mode === "ary" ? r.quality : qualityFor(mode, members, date); peCache = r.pe; qMonth = month;
    }
    yield buildCaptureDayFromHistory(date, members, series, dateIdx, spy.get(date) ?? null, qCache ?? undefined, peCache ?? undefined);
  }
}
const priceOf = (date: string, symbol: string): number | null => {
  const i = dateIdx.get(date)?.get(symbol);
  return i == null ? null : series.get(symbol)?.[i]?.closeadj ?? null;
};

// ── variants ─────────────────────────────────────────────────────────────────
const lim = (d: { date: string }) => { const w = indexWeights(d.date); return (s: string) => Math.min(3, Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9))); };
const sampledMonth = new Map<string, string>();
const stats = new Map<string, { removedByYear: Map<string, Set<string>>; missing: number; checked: number; eligibleRemovedPct: Map<string, number[]> }>();
/** Sector-limited walk of the ranked list; `drop` names are skipped (and counted) BEFORE they take a slot. */
function pickWith(id: string, d: { date: string; rows: unknown }, ranked: VariantPick[], drop: ((sym: string) => boolean | null) | null): VariantPick[] {
  const L = lim(d);
  const st = stats.get(id) ?? { removedByYear: new Map(), missing: 0, checked: 0, eligibleRemovedPct: new Map() };
  stats.set(id, st);
  const yr = d.date.slice(0, 4);
  if (drop) {
    // Share of the whole eligible list the rule removes (sampled monthly, first trading day).
    if (sampledMonth.get(id) !== d.date.slice(0, 7)) {
      sampledMonth.set(id, d.date.slice(0, 7));
      let rem = 0; for (const p of ranked) if (drop(p.symbol) === true) rem++;
      const a = st.eligibleRemovedPct.get(yr) ?? []; a.push(ranked.length ? rem / ranked.length : 0); st.eligibleRemovedPct.set(yr, a);
    }
  }
  const used = new Map<string, number>(), out: VariantPick[] = [];
  for (const p of ranked) {
    if (out.length >= N) break;
    const s = sectorOf(p.symbol);
    if ((used.get(s) ?? 0) >= L(s)) continue;
    if (drop) {
      const v = drop(p.symbol); st.checked++;
      if (v == null) st.missing++;
      if (v === true) { let set = st.removedByYear.get(yr); if (!set) { set = new Set(); st.removedByYear.set(yr, set); } set.add(p.symbol); continue; }
    }
    out.push(p); used.set(s, (used.get(s) ?? 0) + 1);
  }
  return out;
}
const fcfNonPos = (date: string) => (sym: string): boolean | null => { const c = cfAsOf(ART, sym, date); return c?.fcf == null ? null : c.fcf <= 0; };
const fcfAndOcf = (date: string) => (sym: string): boolean | null => {
  const t = cfAsOf(ART, sym, date), q = cfAsOf(ARQ, sym, date);
  if (t?.fcf == null || q?.ncfo == null) return null;
  return t.fcf <= 0 && q.ncfo < 0;
};
const mk = (id: string, description: string, pick: StrategyVariant["pick"]): StrategyVariant =>
  ({ ...LIVE_PROXY, id, description, config: { maxPositions: N, maxPerSector: 3 }, pick });
const P = (id: string, drop: ((date: string) => (sym: string) => boolean | null) | null) =>
  (d: Parameters<StrategyVariant["pick"]>[0]) => pickWith(id, d, LIVE_PROXY.pick(d, LIVE_PROXY.config), drop ? drop(d.date) : null);
const VARIANTS: Array<{ v: StrategyVariant; q: QMode }> = [
  { v: mk("base", "live rule, ANNUAL (ARY) quality", P("base", null)), q: "ary" },
  { v: mk("fcfpos", "live rule + drop TTM FCF ≤ 0", P("fcfpos", fcfNonPos)), q: "ary" },
  { v: mk("fcfq", "live rule, quality = 4-part composite incl. FCF/assets", P("fcfq", null)), q: "ary4" },
  { v: mk("fcfpos-q", "live rule + drop TTM FCF ≤ 0 AND last-quarter OCF < 0", P("fcfpos-q", fcfAndOcf)), q: "ary" },
  { v: mk("base-ttm", "live rule, TTM (ART) quality — production's basis", P("base-ttm", null)), q: "art" },
  { v: mk("base-ttm-fin", "TTM quality + Financials/Real Estate leverage term dropped (production's isFin)", P("base-ttm-fin", null)), q: "art-fin" },
  { v: mk("fcfpos-ttm", "TTM quality + drop TTM FCF ≤ 0", P("fcfpos-ttm", fcfNonPos)), q: "art" },
  { v: mk("fcfq-ttm", "TTM quality, 4-part incl. FCF/assets", P("fcfq-ttm", null)), q: "art4" },
  { v: mk("fcfpos-q-ttm", "TTM quality + drop TTM FCF ≤ 0 AND last-quarter OCF < 0", P("fcfpos-q-ttm", fcfAndOcf)), q: "art" },
];

// ── run ─────────────────────────────────────────────────────────────────────
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const dr = (v: Array<number | null>) => { const o: number[] = []; for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i]; if (a != null && b != null && a > 0) o.push(b / a - 1); } return o; };
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length || 1)); };
const yrs0 = (Date.parse(TEST_TO) - Date.parse(TEST_FROM)) / (365.25 * 86_400_000);

const rows: string[] = [], halves: string[] = [];
const dailyByVariant = new Map<string, Map<string, number>>();
let spyLine = "", spyHalves = "";
for (const { v, q } of VARIANTS.filter(x => !only || only.includes(x.v.id))) {
  console.error(`running ${v.id} (${new Date().toISOString().slice(11, 19)})`);
  const r = runBacktest(v, dayStream(q), priceOf, (d) => spy.get(d) ?? null, DEFAULT_BACKTEST);
  const yrs = (Date.parse(r.to) - Date.parse(r.from)) / (365.25 * 86_400_000);
  const e = r.marks.map(m => m.equity), s = r.marks.map(m => m.spy);
  const rs = dr(e);
  const dm = new Map<string, number>(); for (let i = 1; i < r.marks.length; i++) dm.set(r.marks[i].date, r.marks[i].equity / r.marks[i - 1].equity - 1);
  dailyByVariant.set(v.id, dm);
  const cagr = (Math.pow(e[e.length - 1] / e[0], 1 / yrs) - 1) * 100;
  const sharpe = sd(rs) > 0 ? mean(rs) / sd(rs) * Math.sqrt(252) : 0;
  const half = (from: string, to: string) => {
    const ms = r.marks.filter(m => m.date >= from && m.date <= to);
    const y = (Date.parse(ms[ms.length - 1].date) - Date.parse(ms[0].date)) / (365.25 * 86_400_000);
    const s0 = ms.find(m => m.spy != null)!.spy!, s1 = [...ms].reverse().find(m => m.spy != null)!.spy!;
    const eq = ms.map(m => m.equity); const peak = { v: eq[0], dd: 0 }; for (const x of eq) { peak.v = Math.max(peak.v, x); peak.dd = Math.min(peak.dd, x / peak.v - 1); }
    return { st: (Math.pow(ms[ms.length - 1].equity / ms[0].equity, 1 / y) - 1) * 100, sp: (Math.pow(s1 / s0, 1 / y) - 1) * 100, dd: peak.dd * 100 };
  };
  const h1 = half(TEST_FROM, "2012-12-31"), h2 = half("2013-01-01", "2026-12-31");
  rows.push(`  ${v.id.padEnd(14)}${pct(cagr).padStart(9)}${sharpe.toFixed(2).padStart(8)}${pct(r.maxDrawdownPct, 1).padStart(9)}${String(r.trades).padStart(8)}${(r.trades / yrs).toFixed(0).padStart(9)}`);
  halves.push(`  ${v.id.padEnd(14)}${pct(h1.st).padStart(9)}${pct(h1.st - h1.sp).padStart(9)}${pct(h1.dd, 1).padStart(9)}${pct(h2.st).padStart(11)}${pct(h2.st - h2.sp).padStart(9)}${pct(h2.dd, 1).padStart(9)}`);
  if (!spyLine) {
    const sF = s.find(x => x != null) as number, sL = [...s].reverse().find(x => x != null) as number;
    spyLine = `  ${"SPY".padEnd(14)}${pct((Math.pow(sL / sF, 1 / yrs) - 1) * 100).padStart(9)}${(sd(dr(s)) > 0 ? mean(dr(s)) / sd(dr(s)) * Math.sqrt(252) : 0).toFixed(2).padStart(8)}${pct(r.spyMaxDrawdownPct ?? NaN, 1).padStart(9)}`;
    spyHalves = `  ${"SPY".padEnd(14)}${pct(h1.sp).padStart(9)}${"".padStart(18)}${pct(h2.sp).padStart(11)}`;
  }
}
console.log(`\nFCF EXPERIMENT — ${N} names, ${TEST_FROM}..${TEST_TO}, rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d, stop ${DEFAULT_BACKTEST.stopLossPct}% ${DEFAULT_BACKTEST.stopMode}, cost ${DEFAULT_BACKTEST.costBps}bps, quality ARY/netinc, live sector rule`);
console.log(`  ${"variant".padEnd(14)}${"CAGR".padStart(9)}${"Sharpe".padStart(8)}${"maxDD".padStart(9)}${"trades".padStart(8)}${"trades/yr".padStart(9)}`);
for (const l of rows) console.log(l);
console.log(spyLine);
console.log(`\nBY ERA — CAGR, excess vs SPY, max drawdown within the era`);
console.log(`  ${"variant".padEnd(14)}${"→2012".padStart(9)}${"vs SPY".padStart(9)}${"maxDD".padStart(9)}${"2013→".padStart(11)}${"vs SPY".padStart(9)}${"maxDD".padStart(9)}`);
for (const l of halves) console.log(l);
console.log(spyHalves);

// Paired difference vs base: annualised mean of daily (variant − base) and its t-stat — is the gap noise?
const base = dailyByVariant.get("base");
if (base) {
  console.log(`\nPAIRED vs base — annualised mean daily return difference, t-stat (|t|<2 ≈ noise)`);
  for (const [id, m] of dailyByVariant) {
    if (id === "base") continue;
    const ref = id.endsWith("-ttm") && id !== "base-ttm" && dailyByVariant.has("base-ttm") ? dailyByVariant.get("base-ttm")! : base;
    console.log(`  (${id} vs ${ref === base ? "base" : "base-ttm"})`);
    for (const [lab, from, to] of [["all", "0000", "9999"], ["→2012", "0000", "2012-12-31"], ["2013→", "2013-01-01", "9999"]] as const) {
      const diffs: number[] = []; for (const [d, x] of m) { const b = ref.get(d); if (b != null && d >= from && d <= to) diffs.push(x - b); }
      const t = sd(diffs) > 0 ? mean(diffs) / (sd(diffs) / Math.sqrt(diffs.length)) : 0;
      console.log(`  ${id.padEnd(14)} ${lab.padEnd(6)} ${pct(mean(diffs) * 252 * 100).padStart(8)}/yr  t=${t.toFixed(2)}  days different: ${(100 * diffs.filter(x => Math.abs(x) > 1e-12).length / Math.max(1, diffs.length)).toFixed(0)}%`);
    }
  }
}

for (const [id, st] of stats) {
  if (id.startsWith("base") || id.startsWith("fcfq") || id.startsWith("_")) continue;
  console.log(`\n${id}: FCF unknown for ${(100 * st.missing / Math.max(1, st.checked)).toFixed(1)}% of slot checks (kept). Distinct would-be picks removed, and avg share of the eligible list removed, by year:`);
  const yrsList = [...new Set([...st.removedByYear.keys(), ...st.eligibleRemovedPct.keys()])].sort();
  console.log("  " + yrsList.map(y => `${y}:${st.removedByYear.get(y)?.size ?? 0}/${(100 * mean(st.eligibleRemovedPct.get(y) ?? [0])).toFixed(0)}%`).join("  "));
  const recent = [...(st.removedByYear.get("2025") ?? []), ...(st.removedByYear.get("2026") ?? [])];
  if (recent.length) console.log(`  2025-26 names removed: ${[...new Set(recent)].join(", ")}`);
}

// BE as of the last cached date.
const last = tradingDays[tradingDays.length - 1];
const be = cfAsOf(ART, "BE", last), beq = cfAsOf(ARQ, "BE", last);
const members = membersAsOfPrecise(universe, sp500Rows, last) ?? new Set<string>();
const q3 = qualityAsOf(members, fundIndex, last, "netinc"), q4m = quality4(members, fundIndex, last);
const med = (m: Map<string, number>) => { const s = [...m.values()].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nBE as of ${last}: TTM FCF ${be?.fcf != null ? (be.fcf / 1e6).toFixed(0) + "M" : "n/a"} (filed ${be?.filed}), last-quarter OCF ${beq?.ncfo != null ? (beq.ncfo / 1e6).toFixed(0) + "M" : "n/a"} (filed ${beq?.filed}), member: ${members.has("BE")}`);
console.log(`  quality 3-part ${q3.quality.get("BE")?.toFixed(2) ?? "n/a"} (median ${q3.median.toFixed(2)}); 4-part incl. FCF ${q4m.get("BE")?.toFixed(2) ?? "n/a"} (median ${med(q4m).toFixed(2)})`);

// ── ANNUAL vs TTM quality: how different are the selections? (monthly lockstep, first trading day) ──
if (!only || only.includes("overlap")) {
  const firstOfMonth = tradingDays.filter((d, i) => i === 0 || d.slice(0, 7) !== tradingDays[i - 1].slice(0, 7));
  type O = { y: string; qElig: number; elig: number; picks: number; qEligFin: number; picksFin: number };
  const obs: O[] = [];
  const diffShare = <T,>(a: Set<T>, b: Set<T>) => a.size ? [...a].filter(x => !b.has(x)).length / a.size : 0;
  for (const date of firstOfMonth) {
    const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
    const qa = qualityFor("ary", members, date), qt = qualityFor("art", members, date), qf = qualityFor("art-fin", members, date);
    const above = (m: Map<string, number>) => { const v = [...m.values()].sort((a, b) => a - b); const md = v[Math.floor(v.length / 2)]; return new Set([...m].filter(([, x]) => x >= md).map(([k]) => k)); };
    const sel = (q: Map<string, number>) => {
      const day = toVariantDay(buildCaptureDayFromHistory(date, members, series, dateIdx, spy.get(date) ?? null, q));
      const ranked = LIVE_PROXY.pick(day, LIVE_PROXY.config);
      return { elig: new Set(ranked.map(p => p.symbol)), picks: new Set(pickWith("_ov", day, ranked, null).map(p => p.symbol)) };
    };
    const A = sel(qa), T = sel(qt), F = sel(qf);
    obs.push({ y: date.slice(0, 4), qElig: diffShare(above(qa), above(qt)), elig: diffShare(A.elig, T.elig), picks: diffShare(A.picks, T.picks),
      qEligFin: diffShare(above(qa), above(qf)), picksFin: diffShare(A.picks, F.picks) });
  }
  const avg = (xs: O[], k: keyof O) => (100 * mean(xs.map(o => o[k] as number))).toFixed(0) + "%";
  console.log(`\nANNUAL vs TTM QUALITY — share of the ANNUAL selection that the TTM version does not contain (monthly)`);
  console.log(`  ${"period".padEnd(11)}${"q≥median".padStart(10)}${"eligible".padStart(10)}${"7 picks".padStart(10)}   |  TTM+fin fix: ${"q≥median".padStart(9)}${"7 picks".padStart(9)}`);
  for (const [lab, f] of [["all", () => true], ["1999-2012", (o: O) => o.y <= "2012"], ["2013-2026", (o: O) => o.y >= "2013"], ["2024-2026", (o: O) => o.y >= "2024"]] as const) {
    const xs = obs.filter(f as (o: O) => boolean);
    console.log(`  ${lab.padEnd(11)}${avg(xs, "qElig").padStart(10)}${avg(xs, "elig").padStart(10)}${avg(xs, "picks").padStart(10)}   |  ${"".padStart(13)}${avg(xs, "qEligFin").padStart(9)}${avg(xs, "picksFin").padStart(9)}`);
  }

  // Today's shortlist under each basis (last cached date — fundamentals predate the Q3 2026 filings).
  const date = tradingDays[tradingDays.length - 1];
  const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
  const qa = qualityFor("ary", members, date), qt = qualityFor("art", members, date), qf = qualityFor("art-fin", members, date);
  const md = (m: Map<string, number>) => { const v = [...m.values()].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const [ma, mt, mf] = [md(qa), md(qt), md(qf)];
  console.log(`\nSHORTLIST NAMES as of ${date} — quality (✓ = above that basis's median: annual ${ma.toFixed(2)}, TTM ${mt.toFixed(2)}, TTM+fin ${mf.toFixed(2)})`);
  const SL = ["SNDK", "MU", "DELL", "ILMN", "BE", "APA", "FCX", "TGT", "MRK", "MNST", "GOOGL", "ALL", "SPG", "CBOE"];
  for (const t of SL) {
    const f = (m: Map<string, number>, med: number) => m.has(t) ? `${m.get(t)!.toFixed(2)}${m.get(t)! >= med ? "✓" : "✗"}` : "n/a ";
    const a = latestFilingAsOf(fundIndex.get(t), date), tt = latestFilingAsOf(fundIndexTTM.get(t), date);
    console.log(`  ${t.padEnd(6)} member:${members.has(t) ? "y" : "n"}  annual ${f(qa, ma).padStart(6)} (FY filed ${a?.filed ?? "—"})   TTM ${f(qt, mt).padStart(6)} (filed ${tt?.filed ?? "—"})   TTM+fin ${f(qf, mf).padStart(6)}`);
  }
}
