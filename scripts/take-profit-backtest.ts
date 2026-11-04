/**
 * MAIN-BOOK TAKE-PROFIT EXPERIMENT — should the main book sell a winner at +X% like the sleeve?
 *
 *   bun scripts/take-profit-backtest.ts --n 7 [--quality art-fin] [--from YYYY-MM-DD]
 *
 * Asked 2026-11-03 (owner): the influencer sleeve sells at +40% from buy (lib/stopouts
 * TAKE_PROFIT_PCT); does the same rule make sense for the main book? Every variant runs the LIVE
 * main-book rule (quality-momentum shortlist, ≤3× S&P sector weight, max 3 names/sector, −10%
 * same-day stop, weekly equal-weight rebalance). Only the take-profit differs:
 *
 *   live            no take-profit (production)
 *   tp<X>           sell the whole position at ≥ +X% from entry; it may be re-bought at the next
 *                   rebalance if still a pick (so it mostly measures a few days in cash)
 *   tp<X>-cool<D>   same, and the name is barred from the picks for D trading days after
 *
 * Also prints what each take-profit's name did NEXT (20d / 60d return vs SPY from the exit close):
 * positive = selling it cost money.
 *
 * CAVEAT, specific to this question: the engine re-levels every holding to equal weight at each
 * weekly rebalance, which already sells a winner's gains down to one slot every week. The live
 * book only trims a name above 25% of the book (lib/buy-sizing applyConcentrationTrim). So the
 * baseline here already locks profits harder than live does; a take-profit's marginal effect is
 * measured against that.
 *
 * Research only: reads the local Sharadar cache, writes nothing, touches no live code path.
 * Loaders, historical sectors and quality bases are copied from scripts/sector-cap-backtest.ts.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { buildCaptureDayFromHistory, buildDateIndex, type Series } from "../lib/sharadar-features";
import { runBacktest, DEFAULT_BACKTEST, type BacktestConfig } from "../lib/backtest";
import { LIVE_PROXY, type StrategyVariant, type VariantPick } from "../lib/strategy-variant";
import { parseFundamentalsCsv, buildFundamentalIndex, qualityAsOf, latestFilingAsOf } from "../lib/sharadar-quality";
import { STOCK_SECTOR } from "../lib/market-data";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const DATA_FROM = "1997-12-31", TEST_TO = "2026-09-29";
// --from: the earnings variants need 8-K Item 2.02 dates, which exist only since 2004-08 (SEC rule).
const TEST_FROM = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : "1999-01-04";
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg !== -1 ? process.argv[onlyArg + 1].split(",") : null;
const N = process.argv.includes("--n") ? parseInt(process.argv[process.argv.indexOf("--n") + 1], 10) : 6;

// ── historical sectors ──────────────────────────────────────────────────────
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
if (iTk < 0 || iSec < 0) throw new Error("sp500_tickers_meta.csv: ticker/sector columns missing");
const HIST_SECTOR = new Map<string, string>();
for (const l of metaLines.slice(1)) {
  const f = parseCsvLine(l);
  if (f[iSec]) HIST_SECTOR.set(f[iTk], f[iSec]);
}
for (const k of Object.keys(STOCK_SECTOR)) delete (STOCK_SECTOR as Record<string, string>)[k];
for (const [t, s] of HIST_SECTOR) (STOCK_SECTOR as Record<string, string>)[t] = s;
const sectorOf = (t: string) => HIST_SECTOR.get(t) ?? "?";
console.error(`historical sectors: ${HIST_SECTOR.size} tickers`);

// ── market caps (ART) for cap-weighted index sector weights ─────────────────
const CAPS = new Map<string, Array<{ date: string; cap: number }>>();
{
  const lines = (await Bun.file(`${CACHE}/sp500_fund_all.csv`).text()).split("\n");
  const h = lines[0].split(",");
  const iT = h.indexOf("ticker"), iD = h.indexOf("dimension"), iDt = h.indexOf("date"), iC = h.indexOf("marketcap");
  if ([iT, iD, iDt, iC].some(i => i < 0)) throw new Error("sp500_fund_all.csv: expected columns missing");
  for (const l of lines.slice(1)) {
    const f = l.split(",");
    if (f[iD] !== "ART") continue;
    const cap = +f[iC];
    if (!Number.isFinite(cap) || cap <= 0) continue;
    let a = CAPS.get(f[iT]); if (!a) { a = []; CAPS.set(f[iT], a); }
    a.push({ date: f[iDt], cap });
  }
  for (const a of CAPS.values()) a.sort((x, y) => x.date.localeCompare(y.date));
}
const capAsOf = (t: string, date: string): number | null => {
  const a = CAPS.get(t); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].date <= date) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? a[best].cap : null;
};

// ── data (same loaders as scripts/full-period.ts) ───────────────────────────
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
// --quality ary (default, as published) | art-fin: TTM (ART) quality with production's Financials /
// Real Estate no-leverage rule. The historical sector map holds Sharadar NAMES, so lib/sharadar-
// quality's isFin (ETF codes) never fires; art-fin applies it by name. Added 2026-11-02 to re-check
// the 10-27 Tech-limit verdicts on the production-closest basis (scripts/fcf-backtest.ts measured
// the basis gap: ary flatters 2013+ by ~3pp/yr, ~1 in 7 picks differ).
const QUALITY = process.argv.includes("--quality") ? process.argv[process.argv.indexOf("--quality") + 1] : "ary";
if (QUALITY !== "ary" && QUALITY !== "art-fin") throw new Error(`--quality must be ary or art-fin, got ${QUALITY}`);
const fundIndexTTM = QUALITY === "art-fin" ? buildFundamentalIndex(parseFundamentalsCsv(await Bun.file(`${CACHE}/sp500_fund_all.csv`).text(),
  { dimension: "ART", tickers: new Set(sp500Rows.map(r => r.ticker)), basis: "netinc" })) : null;
const FIN_SECTORS = new Set(["Financial Services", "Real Estate"]);
/** lib/sharadar-quality qualityAsOf term for term, on TTM rows, with the Financials/RE rule by name. */
function qualityTTMFin(cohort: Iterable<string>, asOf: string): Map<string, number> {
  const percentileFn = (vals: number[]) => { const s = [...vals].sort((a, b) => a - b); const n = s.length || 1;
    return (x: number) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m + 1; else hi = m; } return lo / n; }; };
  const raw = new Map<string, { roe: number | null; roa: number; lev: number | null }>();
  for (const sym of cohort) {
    const f = latestFilingAsOf(fundIndexTTM!.get(sym), asOf); if (!f) continue;
    const a = f.assets, e = f.equity, l = f.liabilities, n = f.netinc;
    if (a == null || n == null || a <= 0) continue;
    const isFin = FIN_SECTORS.has(sectorOf(sym)); const negEq = e != null && e <= 0;
    raw.set(sym, { roe: e != null && e > 0 ? n / e : null, roa: n / a, lev: !isFin && !negEq && l != null ? l / a : null });
  }
  const vals = [...raw.values()];
  const roeP = percentileFn(vals.filter(r => r.roe != null).map(r => r.roe as number));
  const roaP = percentileFn(vals.map(r => r.roa));
  const levP = percentileFn(vals.filter(r => r.lev != null).map(r => r.lev as number));
  const q = new Map<string, number>();
  for (const [sym, r] of raw) {
    const parts = [roaP(r.roa)];
    if (r.roe != null) parts.push(roeP(r.roe));
    if (r.lev != null) parts.push(1 - levP(r.lev));
    q.set(sym, parts.reduce((s2, x) => s2 + x, 0) / parts.length);
  }
  return q;
}
const tradingDays = [...dateIdx.keys()].filter(d => d >= TEST_FROM && d <= TEST_TO && spy.has(d)).sort();

// Index sector weights, monthly.
const weightCache = new Map<string, Map<string, number>>();
function indexWeights(date: string): Map<string, number> {
  const month = date.slice(0, 7);
  const hit = weightCache.get(month); if (hit) return hit;
  const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
  const by = new Map<string, number>(); let tot = 0;
  for (const t of members) {
    const c = capAsOf(t, date); if (c == null) continue;
    const s = sectorOf(t); by.set(s, (by.get(s) ?? 0) + c); tot += c;
  }
  const w = new Map<string, number>();
  if (tot > 0) for (const [s, v] of by) w.set(s, v / tot);
  weightCache.set(month, w);
  return w;
}

function* dayStream() {
  let lastYear = "";
  let qCache: Map<string, number> | null = null, peCache: Map<string, number> | null = null, qMonth = "";
  for (const date of tradingDays) {
    const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
    if (date.slice(0, 4) !== lastYear) { lastYear = date.slice(0, 4); console.error(`  … ${lastYear} (${new Date().toISOString().slice(11, 19)})`); }
    const month = date.slice(0, 7);
    if (month !== qMonth) { const r = qualityAsOf(members, fundIndex, date, "netinc"); qCache = QUALITY === "art-fin" ? qualityTTMFin(members, date) : r.quality; peCache = r.pe; qMonth = month; }
    yield buildCaptureDayFromHistory(date, members, series, dateIdx, spy.get(date) ?? null, qCache ?? undefined, peCache ?? undefined);
  }
}
const priceOf = (date: string, symbol: string): number | null => {
  const i = dateIdx.get(date)?.get(symbol);
  return i == null ? null : series.get(symbol)?.[i]?.closeadj ?? null;
};

// ── variants: same eligibility + ranking as the baseline; only the sector limit differs ───────
/** Walk the baseline's ranked list, taking a name while its sector is under `limit(sector)`. */
function limited(ranked: VariantPick[], limit: (s: string) => number): VariantPick[] {
  const used = new Map<string, number>(), out: VariantPick[] = [];
  for (const p of ranked) {
    if (out.length >= N) break;
    const s = sectorOf(p.symbol);
    if ((used.get(s) ?? 0) >= limit(s)) continue;
    out.push(p); used.set(s, (used.get(s) ?? 0) + 1);
  }
  return out;
}
/** Slots per sector ∝ index weight (largest remainder), filled with each sector's top-ranked
 *  eligible names; a slot its sector cannot fill goes to the best remaining name anywhere, so the
 *  book stays fully invested. */

// ── variants: the live sector rule; only the take-profit differs ─────────────────────────────
const dayNo = new Map(tradingDays.map((d, i) => [d, i]));
const liveLimit = (date: string) => { const w = indexWeights(date); return (s: string) => Math.min(3, Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9))); };
type Exit = { date: string; symbol: string };
type Run = { v: StrategyVariant; cfg: BacktestConfig; exits: Exit[] };
function mkRun(id: string, tp: number | null, coolDays: number, over: Partial<BacktestConfig> = {}): Run {
  const exits: Exit[] = [], barredAt = new Map<string, number>();
  const v: StrategyVariant = {
    ...LIVE_PROXY, id, description: id, config: { maxPositions: N, maxPerSector: 3 },
    pick: (d) => {
      const today = dayNo.get(d.date) ?? 0;
      const ranked = LIVE_PROXY.pick(d, LIVE_PROXY.config).filter(p => {
        const at = barredAt.get(p.symbol);
        return at == null || today - at >= coolDays;
      });
      return limited(ranked, liveLimit(d.date));
    },
  };
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST, ...over, takeProfitPct: tp, onTakeProfit: (date, symbol) => { exits.push({ date, symbol }); barredAt.set(symbol, dayNo.get(date) ?? 0); } };
  return { v, cfg, exits };
}
const RUNS: Run[] = [
  mkRun("live", null, 0),
  mkRun("tp40", 40, 0),
  mkRun("tp25-cool60", 25, 60),
  mkRun("tp40-cool20", 40, 20),
  mkRun("tp40-cool60", 40, 60),
  mkRun("tp60-cool60", 60, 60),
  mkRun("tp100-cool60", 100, 60),
  // ADDED 2026-11-03 (owner: "buy and hold 60 days, no stops, on the main book?"): the live rule
  // with no −10% same-day stop, and/or rebalanced every 20 / 60 trading days instead of weekly.
  mkRun("no-stop", null, 0, { stopLossPct: null }),
  mkRun("reb20", null, 0, { rebalanceEveryDays: 20 }),
  mkRun("reb60", null, 0, { rebalanceEveryDays: 60 }),
  mkRun("reb60-no-stop", null, 0, { rebalanceEveryDays: 60, stopLossPct: null }),
];

// ── run ─────────────────────────────────────────────────────────────────────
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const dr = (v: Array<number | null>) => { const o: number[] = []; for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i]; if (a != null && b != null && a > 0) o.push(b / a - 1); } return o; };
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length || 1)); };
const half = (marks: Array<{ date: string; equity: number; spy: number | null }>, from: string, to: string) => {
  const ms = marks.filter(m => m.date >= from && m.date <= to);
  const y = (Date.parse(ms[ms.length - 1].date) - Date.parse(ms[0].date)) / (365.25 * 86_400_000);
  const s0 = ms.find(m => m.spy != null)!.spy!, s1 = [...ms].reverse().find(m => m.spy != null)!.spy!;
  let pk = ms[0].equity, dd = 0; for (const m of ms) { pk = Math.max(pk, m.equity); dd = Math.min(dd, m.equity / pk - 1); }
  return { st: (Math.pow(ms[ms.length - 1].equity / ms[0].equity, 1 / y) - 1) * 100, sp: (Math.pow(s1 / s0, 1 / y) - 1) * 100, dd: dd * 100 };
};
const fwd = (date: string, sym: string, h: number) => {
  const i = dayNo.get(date); if (i == null) return null;
  const d1 = tradingDays[i + h]; if (!d1) return null;
  const a = priceOf(date, sym), b = priceOf(d1, sym), s0 = spy.get(date), s1 = spy.get(d1);
  return a && b && s0 && s1 ? (b / a - s1 / s0) * 100 : null;
};

console.log(`\nMAIN-BOOK TAKE-PROFIT — ${N} names, live sector rule, rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d, stop ${DEFAULT_BACKTEST.stopLossPct}% ${DEFAULT_BACKTEST.stopMode}, cost ${DEFAULT_BACKTEST.costBps}bps, quality ${QUALITY}, from ${TEST_FROM}\n`);
console.log(`  ${"variant".padEnd(14)}${"CAGR".padStart(9)}${"Sharpe".padStart(8)}${"maxDD".padStart(9)}${"trades".padStart(8)}${"TPs".padStart(6)}${"→2012".padStart(9)}${"2013→".padStart(9)}${"DD→2012".padStart(9)}${"DD2013→".padStart(9)}`);
const dailyOf = new Map<string, Map<string, number>>();
let spyLine = "";
for (const run of RUNS.filter(r => !only || only.includes(r.v.id))) {
  console.error(`running ${run.v.id}`);
  const r = runBacktest(run.v, dayStream(), priceOf, (d) => spy.get(d) ?? null, run.cfg);
  const yrs = (Date.parse(r.to) - Date.parse(r.from)) / (365.25 * 86_400_000);
  const e = r.marks.map(m => m.equity), rs = dr(e);
  { const dm = new Map<string, number>(); for (let i = 1; i < r.marks.length; i++) dm.set(r.marks[i].date, r.marks[i].equity / r.marks[i - 1].equity - 1); dailyOf.set(run.v.id, dm); }
  const cagr = (Math.pow(e[e.length - 1] / e[0], 1 / yrs) - 1) * 100;
  const sharpe = sd(rs) > 0 ? mean(rs) / sd(rs) * Math.sqrt(252) : 0;
  const h1 = TEST_FROM < "2013-01-01" ? half(r.marks, TEST_FROM, "2012-12-31") : { st: NaN, sp: NaN, dd: NaN }, h2 = half(r.marks, "2013-01-01", "2026-12-31");
  console.log(`  ${run.v.id.padEnd(14)}${pct(cagr).padStart(9)}${sharpe.toFixed(2).padStart(8)}${pct(r.maxDrawdownPct, 1).padStart(9)}${String(r.trades).padStart(8)}${String(run.exits.length).padStart(6)}${pct(h1.st).padStart(9)}${pct(h2.st).padStart(9)}${pct(h1.dd, 1).padStart(9)}${pct(h2.dd, 1).padStart(9)}${r.usable ? "" : "  ⛔ NOT USABLE"}${r.notes.length ? "  " + r.notes.join("; ") : ""}`);
  if (!spyLine) {
    const s = r.marks.map(m => m.spy), sF = s.find(x => x != null) as number, sL = [...s].reverse().find(x => x != null) as number;
    spyLine = `  ${"SPY".padEnd(14)}${pct((Math.pow(sL / sF, 1 / yrs) - 1) * 100).padStart(9)}${"".padStart(8)}${pct(r.spyMaxDrawdownPct ?? NaN, 1).padStart(9)}${"".padStart(14)}${pct(h1.sp).padStart(9)}${pct(h2.sp).padStart(9)}`;
  }
}
console.log(spyLine);

const ref = dailyOf.get("live");
if (ref) {
  console.log(`\nPAIRED vs live — annualised mean daily return difference, t-stat`);
  for (const [id, m] of dailyOf) {
    if (id === "live") continue;
    const cells: string[] = [];
    for (const [from, to] of [["0000", "9999"], ["0000", "2012-12-31"], ["2013-01-01", "9999"]] as const) {
      const d: number[] = []; for (const [k, x] of m) { const b = ref.get(k); if (b != null && k >= from && k <= to) d.push(x - b); }
      const t = sd(d) > 0 ? mean(d) / (sd(d) / Math.sqrt(d.length)) : 0;
      cells.push(`${pct(mean(d) * 252 * 100)} t=${t.toFixed(2)}`);
    }
    console.log(`  ${id.padEnd(14)} all ${cells[0].padEnd(18)} →2012 ${cells[1].padEnd(18)} 2013→ ${cells[2]}`);
  }
}

console.log(`\nWHAT THE TAKE-PROFIT SOLD DID NEXT — return vs SPY from the exit close (positive = selling cost money)`);
console.log(`  ${"variant".padEnd(14)}${"n".padStart(6)}${"20d mean".padStart(10)}${"±se".padStart(7)}${"20d>0".padStart(7)}${"60d mean".padStart(10)}${"±se".padStart(7)}${"60d>0".padStart(7)}`);
for (const run of RUNS.filter(r => r.exits.length > 0)) {
  const r20 = run.exits.map(x => fwd(x.date, x.symbol, 20)).filter((x): x is number => x != null);
  const r60 = run.exits.map(x => fwd(x.date, x.symbol, 60)).filter((x): x is number => x != null);
  const se = (x: number[]) => sd(x) / Math.sqrt(x.length || 1);
  console.log(`  ${run.v.id.padEnd(14)}${String(run.exits.length).padStart(6)}${pct(mean(r20)).padStart(10)}${se(r20).toFixed(2).padStart(7)}${(100 * r20.filter(x => x > 0).length / (r20.length || 1)).toFixed(0).padStart(6)}%${pct(mean(r60)).padStart(10)}${se(r60).toFixed(2).padStart(7)}${(100 * r60.filter(x => x > 0).length / (r60.length || 1)).toFixed(0).padStart(6)}%`);
}
