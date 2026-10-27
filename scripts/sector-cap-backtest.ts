/**
 * SECTOR-CAP EXPERIMENT — how should the main book's sector concentration be bounded?
 *
 *   bun scripts/sector-cap-backtest.ts
 *
 * Asked 2026-10-23, after the live book reached 44% energy (40% of total value, cap-compliant)
 * against SPY's 3.7%. Compares, on IDENTICAL data, rules, rebalance, stops and costs — only the
 * per-sector limit differs:
 *
 *   count-2       the registered baseline: at most 2 of 6 names per sector (≈33%; the live 40%
 *                 dollar cap at 7 names also admits exactly 2)
 *   spy+15pp      a sector may hold up to its S&P weight + 15 points (min 1 name)
 *   3x-spy        a sector may hold up to 3× its S&P weight (min 1 name)
 *   spy-matched   slots allocated to sectors in proportion to S&P weight (largest remainder) —
 *                 the closest a 6-name equal-weight book gets to mimicking SPY's sector mix
 *
 * ADDED 2026-10-27 (owner questions), both ON TOP of the live rule (3x SPY, max 3), 7 names:
 *   3x3-corr<rho>  a name whose 60d return correlation with an already-picked name exceeds rho is
 *                  skipped (one slot per correlated cluster — e.g. MU/WDC/STX/SNDK).
 *                  1999-2026: live +11.43% / Sharpe 0.52 / maxDD -77.5%; rho 0.8 +10.73% / 0.50 /
 *                  -78.2%; 0.7 +9.84% / 0.47 / -80.2%; 0.6 +9.20% / 0.46 / -74.2%. Costs return at
 *                  every threshold, no reliable drawdown benefit. NOT adopted.
 *   3x3-earn3      skip non-held names reporting within 3 days (8-K Item 2.02 dates, Sharadar EVENTS,
 *                  only from 2004-08 — run with --from 2004-09-01). 2004-2026: live +7.39% / -79.0%;
 *                  earn3 +7.34% / -78.8%. 72 skips; their 20d return vs SPY -0.56% ±1.13 (47% beat
 *                  SPY). No measurable effect either way.
 *
 * Research only: reads the local Sharadar cache, writes nothing, touches no live code path.
 *
 * SECTORS ARE HISTORICAL, for every variant including the baseline. The registered baseline reads
 * lib/market-data STOCK_SECTOR — TODAY's S&P map — so every past constituent not in it fell into
 * one shared "?" bucket, itself capped at 2 names. That is a real bias in the published baseline
 * (it throttles 1999-2015 picks of now-delisted names), so here STOCK_SECTOR is overwritten
 * in-process with Sharadar's per-ticker sector, which covers delisted names. This process only.
 *
 * S&P SECTOR WEIGHTS are rebuilt cap-weighted from Sharadar `marketcap` (ART filings, latest on or
 * before the date), recomputed monthly over that month's members. Quarterly-stale caps; a proxy for
 * the index's published weights, checked against SPY's 2026-10-22 breakdown at the end.
 *
 * Caveats inherited from scripts/full-period.ts: no LLM layer, stops on closes, close-to-close
 * execution, Sharadar's sector taxonomy (11 sectors, Morningstar-style names) rather than GICS.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { buildCaptureDayFromHistory, buildDateIndex, type Series } from "../lib/sharadar-features";
import { runBacktest, DEFAULT_BACKTEST, maxDrawdown } from "../lib/backtest";
import { LIVE_PROXY, type StrategyVariant, type VariantPick } from "../lib/strategy-variant";
import { parseFundamentalsCsv, buildFundamentalIndex, qualityAsOf } from "../lib/sharadar-quality";
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
    if (month !== qMonth) { const r = qualityAsOf(members, fundIndex, date, "netinc"); qCache = r.quality; peCache = r.pe; qMonth = month; }
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
function matched(ranked: VariantPick[], w: Map<string, number>): VariantPick[] {
  const raw = [...w.entries()].map(([s, x]) => ({ s, q: x * N }));
  const slots = new Map(raw.map(r => [r.s, Math.floor(r.q)]));
  let left = N - [...slots.values()].reduce((a, b) => a + b, 0);
  for (const r of [...raw].sort((a, b) => (b.q % 1) - (a.q % 1))) { if (left <= 0) break; slots.set(r.s, (slots.get(r.s) ?? 0) + 1); left--; }
  const out: VariantPick[] = [], taken = new Set<string>(), used = new Map<string, number>();
  for (const p of ranked) {
    const s = sectorOf(p.symbol);
    if ((used.get(s) ?? 0) < (slots.get(s) ?? 0)) { out.push(p); taken.add(p.symbol); used.set(s, (used.get(s) ?? 0) + 1); }
    if (out.length >= N) break;
  }
  for (const p of ranked) { if (out.length >= N) break; if (!taken.has(p.symbol)) { out.push(p); taken.add(p.symbol); } }
  return out;
}

/** Trailing daily-return correlation of two names over the CORR_DAYS bars ending at `date` (adjusted
 *  closes, aligned by date). null when they share too few days to say. Cached per (date, symbol). */
const CORR_DAYS = 60;
const retCache = new Map<string, Map<string, number> | null>();
function trailingReturns(date: string, sym: string): Map<string, number> | null {
  const k = `${date}|${sym}`;
  if (retCache.has(k)) return retCache.get(k)!;
  const i = dateIdx.get(date)?.get(sym), bars = series.get(sym);
  let out: Map<string, number> | null = null;
  if (i != null && bars && i >= CORR_DAYS) {
    out = new Map();
    for (let j = i - CORR_DAYS + 1; j <= i; j++) out.set(bars[j].date, bars[j].closeadj / bars[j - 1].closeadj - 1);
  }
  retCache.set(k, out);
  return out;
}
function corrOf(date: string, a: string, b: string): number | null {
  const ra = trailingReturns(date, a), rb = trailingReturns(date, b);
  if (!ra || !rb) return null;
  const xs: number[] = [], ys: number[] = [];
  for (const [d, x] of ra) { const y = rb.get(d); if (y != null) { xs.push(x); ys.push(y); } }
  if (xs.length < CORR_DAYS * 0.8) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let t = 0; t < xs.length; t++) { sxy += (xs[t] - mx) * (ys[t] - my); sxx += (xs[t] - mx) ** 2; syy += (ys[t] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const corrStats = new Map<string, { rebalances: number; binding: number; skipped: number; examples: string[] }>();
/** The live sector rule, plus: a name whose trailing correlation with an ALREADY-PICKED name exceeds
 *  `rho` shares that name's slot (is skipped; the next-ranked name moves up). Unknown correlation
 *  never skips (fail-open, like the earnings backfill). */
function limitedCorr(id: string, date: string, ranked: VariantPick[], limit: (s: string) => number, rho: number): VariantPick[] {
  const st = corrStats.get(id) ?? { rebalances: 0, binding: 0, skipped: 0, examples: [] };
  corrStats.set(id, st);
  const used = new Map<string, number>(), out: VariantPick[] = [];
  let skippedToday = 0;
  for (const p of ranked) {
    if (out.length >= N) break;
    const s = sectorOf(p.symbol);
    if ((used.get(s) ?? 0) >= limit(s)) continue;
    const twin = out.find(q => (corrOf(date, p.symbol, q.symbol) ?? -1) > rho);
    if (twin) {
      skippedToday++;
      if (date >= "2025-01-01" && st.examples.length < 400) st.examples.push(`${date} ${p.symbol}~${twin.symbol} ${corrOf(date, p.symbol, twin.symbol)!.toFixed(2)}`);
      continue;
    }
    out.push(p); used.set(s, (used.get(s) ?? 0) + 1);
  }
  st.rebalances++; if (skippedToday) st.binding++; st.skipped += skippedToday;
  return out;
}

// ── historical earnings dates: 8-K Item 2.02 "Results of Operations" (Sharadar EVENTS code 22) ──
// The filing date, which is almost always the announcement day (the release is furnished with the
// 8-K). Exists only from 2004-08. The live rule knows the date in advance from a calendar; here the
// realised date stands in for it.
const EARN = new Map<string, string[]>();
{
  const f = Bun.file(`${CACHE}/events.csv`);
  const wantEarn = !only || only.some(id => id.includes("earn"));
  if (wantEarn && !(await f.exists())) throw new Error(`${CACHE}/events.csv missing — the earnings variant would silently equal the baseline. Fetch Sharadar EVENTS first.`);
  if (await f.exists()) {
    for (const l of (await f.text()).split("\n").slice(1)) {
      const [t, d, codes] = l.split(",");
      if (!codes || !codes.split("|").includes("22")) continue;
      let a = EARN.get(t); if (!a) { a = []; EARN.set(t, a); } a.push(d);
    }
    for (const a of EARN.values()) a.sort();
  }
}
/** A report dated 0..3 calendar days after `date` — the live screenImminentEarningsBuys window. */
const IMMINENT_DAYS = 3;
function reportsWithin(sym: string, date: string): string | null {
  const a = EARN.get(sym); if (!a) return null;
  const t0 = Date.parse(`${date}T00:00:00Z`);
  for (const d of a) {
    const dte = Math.floor((Date.parse(`${d}T00:00:00Z`) - t0) / 86_400_000);
    if (dte > IMMINENT_DAYS) break;
    if (dte >= 0) return d;
  }
  return null;
}
/** Skipped names, for the event study below (forward return vs SPY from the skip day's close). */
const earnSkips: Array<{ date: string; symbol: string }> = [];
/** The live rule + the earnings backfill: a name reporting within the window is skipped and the next
 *  eligible name moves up — EXCEPT a name already held (live never skips held names: dropping one off
 *  the list would sell it). The engine does not tell pick() its holdings, so "held" is the last
 *  rebalance target (stop-outs since then still count as held: a slight under-count of skips). */
function earnVariant(id: string) {
  // The engine calls pick() DAILY but trades only on rebalance days: the first call, then every
  // rebalanceEveryDays-th (lib/backtest — sinceRebalance starts at MAX, increments daily, resets on a
  // rebalance, and a rebalance needs non-empty picks). Mirrored exactly below.
  // Skips are recorded only on those calls, and "held" is the last REBALANCE target, so the study
  // measures what the rule actually declined, from the close it was declined at. (Assumes no
  // excluded-SPY days, which tradingDays already filters out.)
  let since = Number.MAX_SAFE_INTEGER, held = new Set<string>();
  return mk(id, `live rule + skip non-held names reporting within ${IMMINENT_DAYS}d`, (d) => {
    const w = indexWeights(d.date);
    const lim = (s: string) => Math.min(3, Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9)));
    since++;                                   // engine: sinceRebalance++ BEFORE its check
    const rebalance = since >= DEFAULT_BACKTEST.rebalanceEveryDays;
    const used = new Map<string, number>(), out: VariantPick[] = [], daySkips: typeof earnSkips = [];
    for (const p of LIVE_PROXY.pick(d, LIVE_PROXY.config)) {
      if (out.length >= N) break;
      const s = sectorOf(p.symbol);
      if ((used.get(s) ?? 0) >= lim(s)) continue;
      if (!held.has(p.symbol) && reportsWithin(p.symbol, d.date)) { if (rebalance) daySkips.push({ date: d.date, symbol: p.symbol }); continue; }
      out.push(p); used.set(s, (used.get(s) ?? 0) + 1);
    }
    // The engine's own condition (lib/backtest): it rebalances only when picks are non-empty, and
    // only then resets its counter — so an empty day is not a rebalance and its skips do not count.
    // The engine buys only what it can price that day; a name it could not buy is not held. (Its
    // applyVariantCaps sector pass reads STOCK_SECTOR, which this script overwrote with the same
    // historical map `out` was built on, so that pass drops nothing here.)
    if (rebalance && out.length) { held = new Set(out.filter(p => priceOf(d.date, p.symbol) != null).map(p => p.symbol)); earnSkips.push(...daySkips); since = 0; }
    return out;
  }, 3);
}

const mk = (id: string, description: string, pick: StrategyVariant["pick"], maxPerSector: number): StrategyVariant =>
  ({ ...LIVE_PROXY, id, description, config: { maxPositions: N, maxPerSector }, pick });

const VARIANTS: StrategyVariant[] = [
  mk("count-2", "baseline: ≤2 of 6 names per sector", (d) => LIVE_PROXY.pick(d, LIVE_PROXY.config), 2),
  mk("spy+15pp", "≤ S&P weight + 15pp (min 1 name)", (d) => {
    const w = indexWeights(d.date);
    return limited(LIVE_PROXY.pick(d, LIVE_PROXY.config), s => Math.max(1, Math.floor(((w.get(s) ?? 0) + 0.15) * N + 1e-9)));
  }, 4),
  mk("3x-spy", "≤ 3× S&P weight (min 1 name)", (d) => {
    const w = indexWeights(d.date);
    return limited(LIVE_PROXY.pick(d, LIVE_PROXY.config), s => Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9)));
  }, 4),
  mk("3x-spy-max3", "≤ 3× S&P weight, max 3 names/sector (Tech 60%)", (d) => {
    const w = indexWeights(d.date);
    return limited(LIVE_PROXY.pick(d, LIVE_PROXY.config), s => Math.min(3, Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9))));
  }, 3),
  ...[0.8, 0.7, 0.6].map(rho => mk(`3x3-corr${rho}`, `live rule + one slot per ${CORR_DAYS}d-correlated cluster (rho>${rho})`, (d) => {
    const w = indexWeights(d.date);
    return limitedCorr(`3x3-corr${rho}`, d.date, LIVE_PROXY.pick(d, LIVE_PROXY.config), s => Math.min(3, Math.max(1, Math.floor(3 * (w.get(s) ?? 0) * N + 1e-9))), rho);
  }, 3)),
  earnVariant("3x3-earn3"),
  mk("spy-matched", "slots ∝ S&P sector weight", (d) => matched(LIVE_PROXY.pick(d, LIVE_PROXY.config), indexWeights(d.date)), 4),
];

// ── run ─────────────────────────────────────────────────────────────────────
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const dr = (v: Array<number | null>) => { const o: number[] = []; for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i]; if (a != null && b != null && a > 0) o.push(b / a - 1); } return o; };
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length || 1)); };

console.log(`\nSECTOR-CAP EXPERIMENT — ${N} names, rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d, stop ${DEFAULT_BACKTEST.stopLossPct}% ${DEFAULT_BACKTEST.stopMode}, cost ${DEFAULT_BACKTEST.costBps}bps, quality ARY`);
console.log(`Historical sectors for every variant (see header). Only the sector limit differs.\n`);
console.log(`  ${"variant".padEnd(13)}${"CAGR".padStart(9)}${"Sharpe".padStart(8)}${"IR".padStart(7)}${"TE".padStart(8)}${"maxDD".padStart(9)}${"yrs>SPY".padStart(9)}${"trades".padStart(8)}`);
console.log("  " + "─".repeat(71));
let spyLine = "";
const halves: string[] = []; let spyHalves = "";
for (const v of VARIANTS.filter(v => !only || only.includes(v.id))) {
  console.error(`running ${v.id}`);
  const r = runBacktest(v, dayStream(), priceOf, (d) => spy.get(d) ?? null, DEFAULT_BACKTEST);
  const yrs = (Date.parse(r.to) - Date.parse(r.from)) / (365.25 * 86_400_000);
  const e = r.marks.map(m => m.equity), s = r.marks.map(m => m.spy);
  const rs = dr(e), rb = dr(s);
  const act: number[] = []; for (let i = 0; i < Math.min(rs.length, rb.length); i++) act.push(rs[i] - rb[i]);
  const cagr = (Math.pow(e[e.length - 1] / e[0], 1 / yrs) - 1) * 100;
  const sharpe = sd(rs) > 0 ? mean(rs) / sd(rs) * Math.sqrt(252) : 0;
  const ir = sd(act) > 0 ? mean(act) / sd(act) * Math.sqrt(252) : 0;
  const te = sd(act) * Math.sqrt(252) * 100;
  const byYear = new Map<string, typeof r.marks>();
  for (const m of r.marks) { const y = m.date.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y)!.push(m); }
  let win = 0, tot = 0;
  for (const ms of byYear.values()) {
    if (ms.length < 20) continue;
    const s0 = ms.find(m => m.spy != null)?.spy, s1 = [...ms].reverse().find(m => m.spy != null)?.spy;
    if (!s0 || !s1) continue;
    tot++; if (ms[ms.length - 1].equity / ms[0].equity > s1 / s0) win++;
  }
  // Sub-period split: a rule that is genuinely better should win in BOTH halves, not only the
  // tech-led one. CAGR per half on the same equity path, vs SPY's over the same dates.
  const half = (from: string, to: string) => {
    const ms = r.marks.filter(m => m.date >= from && m.date <= to);
    const y = (Date.parse(ms[ms.length - 1].date) - Date.parse(ms[0].date)) / (365.25 * 86_400_000);
    const s0 = ms.find(m => m.spy != null)!.spy!, s1 = [...ms].reverse().find(m => m.spy != null)!.spy!;
    return { st: (Math.pow(ms[ms.length - 1].equity / ms[0].equity, 1 / y) - 1) * 100, sp: (Math.pow(s1 / s0, 1 / y) - 1) * 100 };
  };
  const h1 = TEST_FROM < "2013-01-01" ? half(TEST_FROM, "2012-12-31") : { st: NaN, sp: NaN }, h2 = half("2013-01-01", "2026-12-31");
  halves.push(`  ${v.id.padEnd(13)}${pct(h1.st).padStart(9)}${pct(h1.st - h1.sp).padStart(10)}${pct(h2.st).padStart(11)}${pct(h2.st - h2.sp).padStart(10)}`);
  if (!spyHalves) spyHalves = `  ${"SPY".padEnd(13)}${pct(h1.sp).padStart(9)}${"".padStart(10)}${pct(h2.sp).padStart(11)}`;
  console.log(`  ${v.id.padEnd(13)}${pct(cagr).padStart(9)}${sharpe.toFixed(2).padStart(8)}${ir.toFixed(2).padStart(7)}${(te.toFixed(1) + "%").padStart(8)}${pct(r.maxDrawdownPct, 1).padStart(9)}${`${win}/${tot}`.padStart(9)}${String(r.trades).padStart(8)}${r.usable ? "" : "  ⛔ NOT USABLE"}`);
  if (!spyLine) {
    const sF = s.find(x => x != null) as number, sL = [...s].reverse().find(x => x != null) as number;
    const spyCagr = (Math.pow(sL / sF, 1 / yrs) - 1) * 100;
    const spySharpe = sd(rb) > 0 ? mean(rb) / sd(rb) * Math.sqrt(252) : 0;
    spyLine = `  ${"SPY".padEnd(13)}${pct(spyCagr).padStart(9)}${spySharpe.toFixed(2).padStart(8)}${"—".padStart(7)}${"—".padStart(8)}${pct(r.spyMaxDrawdownPct ?? NaN, 1).padStart(9)}`;
  }
}
console.log(spyLine);
console.log(`\nBY HALF — CAGR and excess over SPY`);
console.log(`  ${"variant".padEnd(13)}${`${TEST_FROM.slice(0, 4)}-2012`.padStart(9)}${"vs SPY".padStart(10)}${"2013-2026".padStart(11)}${"vs SPY".padStart(10)}`);
for (const l of halves) console.log(l);
console.log(spyHalves);
console.log(`\n  TE = tracking error vs SPY (annualised). yrs>SPY = calendar years the variant beat SPY.`);

// Sanity check on the rebuilt index weights vs SPY's published breakdown (2026-10-22, State Street).
const w = indexWeights("2026-09-29");
console.log(`\nREBUILT S&P SECTOR WEIGHTS, 2026-09 (Sharadar taxonomy) — compare to SPY's published GICS mix`);
for (const [s, x] of [...w.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(24)}${(x * 100).toFixed(1).padStart(6)}%`);
for (const [id, st] of corrStats) {
  console.log(`\n${id}: binding on ${st.binding}/${st.rebalances} pick-days (${(100 * st.binding / Math.max(1, st.rebalances)).toFixed(0)}%), ${st.skipped} skips; 2025+ examples (first 25 distinct pairs):`);
  const seen = new Set<string>();
  for (const e of st.examples) { const pair = e.split(" ")[1].split(" ")[0]; if (seen.has(pair)) continue; seen.add(pair); console.log(`  ${e}`); if (seen.size >= 25) break; }
}
const last = tradingDays[tradingDays.length - 1];
const SEMI = ["MU", "WDC", "STX", "SNDK", "DELL", "NVDA", "AVGO", "AMD", "MRVL", "LRCX", "AAPL", "MSFT"].filter(t => series.has(t));
console.log(`\n${CORR_DAYS}d CORRELATION as of ${last}:`);
console.log("        " + SEMI.map(t => t.padStart(6)).join(""));
for (const a of SEMI) console.log(`  ${a.padEnd(6)}` + SEMI.map(b => { const c = a === b ? 1 : corrOf(last, a, b); return (c == null ? "—" : c.toFixed(2)).padStart(6); }).join(""));
if (earnSkips.length) {
  // EVENT STUDY on what the rule declined: forward return of each skipped name from the skip day's
  // close, minus SPY's. Positive = the rule cost money (the name beat SPY after we passed on it).
  // Deduped per (symbol, report): a name skipped on several days before one print counts once, at
  // its first skip.
  const seen = new Set<string>(), rows: Array<{ year: string; r5: number; r20: number }> = [];
  for (const k of earnSkips) {
    const rep = reportsWithin(k.symbol, k.date)!, key = `${k.symbol}|${rep}`;
    if (seen.has(key)) continue; seen.add(key);
    const i = tradingDays.indexOf(k.date);
    const fwd = (h: number) => {
      const d1 = tradingDays[i + h]; if (!d1) return null;
      const a = priceOf(k.date, k.symbol), b = priceOf(d1, k.symbol), s0 = spy.get(k.date), s1 = spy.get(d1);
      return a && b && s0 && s1 ? (b / a - s1 / s0) * 100 : null;
    };
    const r5 = fwd(5), r20 = fwd(20);
    if (r5 != null && r20 != null) rows.push({ year: k.date.slice(0, 4), r5, r20 });
  }
  const med = (x: number[]) => { const y = [...x].sort((a, b) => a - b); return y[Math.floor(y.length / 2)]; };
  const se = (x: number[]) => sd(x) / Math.sqrt(x.length);
  const line = (lab: string, rs: typeof rows) => rs.length === 0 ? console.log(`  ${lab.padEnd(11)}     0  (no skips)`) : console.log(`  ${lab.padEnd(11)}${String(rs.length).padStart(6)}${pct(mean(rs.map(r => r.r5))).padStart(10)} ±${se(rs.map(r => r.r5)).toFixed(2)}${pct(med(rs.map(r => r.r5))).padStart(9)}${pct(mean(rs.map(r => r.r20))).padStart(10)} ±${se(rs.map(r => r.r20)).toFixed(2)}${pct(med(rs.map(r => r.r20))).padStart(9)}${(100 * rs.filter(r => r.r20 > 0).length / rs.length).toFixed(0).padStart(7)}%`);
  console.log(`\nSKIPPED NAMES — forward return vs SPY from the skip-day close (positive = the skip COST money)`);
  console.log(`  ${"period".padEnd(11)}${"n".padStart(6)}${"5d mean".padStart(10)}${"".padStart(6)}${"median".padStart(9)}${"20d mean".padStart(10)}${"".padStart(6)}${"median".padStart(9)}${"20d>0".padStart(8)}`);
  line("all", rows);
  line("2004-2012", rows.filter(r => r.year <= "2012"));
  line("2013-2026", rows.filter(r => r.year >= "2013"));
}
void maxDrawdown;
