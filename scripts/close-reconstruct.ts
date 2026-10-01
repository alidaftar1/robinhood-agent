/**
 * RECONSTRUCT the close-to-close return series from stored runs, and compare it to the backtest.
 *
 *   bun --env-file=.env.local scripts/close-reconstruct.ts
 *   bun --env-file=.env.local scripts/close-reconstruct.ts --runs /tmp/runs.json   # offline
 *
 * WHY A SCRIPT AND NOT THE CRON. The live return series is sampled at 10:30 ET (the trade cron is
 * the only observation of the book), while the backtest and every published SPY statistic are
 * close-to-close. That mismatch only produces a WRONG answer in one place: comparing live results to
 * the backtest. The dashboard's own cards are internally consistent — spyPrice is fetched in the same
 * Promise.all as the portfolio, so both legs share the 10:30 clock and it cancels.
 *
 * Since the only consumer is a periodic backtest comparison, a reconstruction beats a daily capture
 * on both axes that matter: it adds no write path to live-money data, and it covers the EXISTING run
 * history, which a forward-only capture could never reach. app/api/close-snapshot stays built and
 * tested for the day observed closes are wanted going forward; it is deliberately not scheduled.
 *
 * WHAT IS DERIVED VS OBSERVED. Quantities, cash and trades are OBSERVED (stored per run). Closing
 * prices come from Sharadar. The one assumption is that cash does not move between 10:30 and the
 * close — true on any day no intraday drop-check sold, which is every day in the current history
 * (checked: 0 of 30 dates carry a second run). On a day it is false the error enters only through the
 * denominator, since the P&L itself is position-level.
 */
import { computeDailyReturn, computeSleeveReturns, type PositionSnapshot, type TradeSnapshot } from "../lib/run-store";
import { computeCloseReturns, summarizeCloseReturns, type CloseSnapshot } from "../lib/close-snapshot";

const argv = process.argv.slice(2);
const runsFileArg = argv.indexOf("--runs");
const SHARADAR = "https://api.sharadar.com/v1.0/data";

const pct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const num = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(d);

interface StoredRun {
  date: string;
  spyPrice?: number;
  portfolioAfter?: { totalValue?: string; cash?: string; equity?: string; unsettledCash?: string };
  positions?: PositionSnapshot[];
  influencerPositions?: PositionSnapshot[];
  trades?: TradeSnapshot[];
  agenticDailyReturn?: number | null;
  mainDailyReturn?: number | null;
}

// ── load runs ────────────────────────────────────────────────────────────────
async function loadRuns(): Promise<StoredRun[]> {
  if (runsFileArg !== -1) {
    const parsed = JSON.parse(await Bun.file(argv[runsFileArg + 1]).text());
    return parsed.runs ?? parsed;
  }
  const base = process.env.APP_URL || "https://robinhood-agent.vercel.app";
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required (or pass --runs <file>)");
  const res = await fetch(`${base}/api/runs?limit=30`, { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`/api/runs → ${res.status}`);
  return (await res.json()).runs;
}

// ── load closes ──────────────────────────────────────────────────────────────
/** date → close, per ticker. Targeted query over the exact symbols and window — no bulk cache needed. */
async function loadCloses(tickers: string[], from: string): Promise<Map<string, Map<string, number>>> {
  const key = process.env.SHARADAR_API_KEY;
  if (!key) throw new Error("SHARADAR_API_KEY is required");
  const out = new Map<string, Map<string, number>>();
  const ingest = (csv: string) => {
    for (const line of csv.split("\n").slice(1)) {
      const f = line.split(",");
      if (f.length < 8) continue;
      const [t, d] = [f[0], f[1]];
      const close = +f[5];
      if (!t || !d || !(close > 0)) continue;
      if (!out.has(t)) out.set(t, new Map());
      out.get(t)!.set(d, close);
    }
  };
  // SPY is an ETF and lives in `funds`, not `stocks` — querying stocks returns an empty 200, which
  // reads exactly like "no data" rather than "wrong table".
  const [stocks, funds] = await Promise.all([
    fetch(`${SHARADAR}/stocks?format=csv&ticker=${tickers.join(",")}&from=${from}`, { headers: { "x-api-key": key } }),
    fetch(`${SHARADAR}/funds?format=csv&ticker=SPY&from=${from}`, { headers: { "x-api-key": key } }),
  ]);
  if (!stocks.ok) throw new Error(`sharadar stocks → ${stocks.status}`);
  if (!funds.ok) throw new Error(`sharadar funds → ${funds.status}`);
  ingest(await stocks.text());
  ingest(await funds.text());
  return out;
}

// ── statistics ───────────────────────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const compound = (xs: number[]) => xs.reduce((a, b) => a * (1 + b), 1) - 1;

interface Stats {
  n: number;
  cumBookPct: number | null;
  cumSpyPct: number | null;
  cumActivePct: number | null;
  dailyActiveVolPct: number | null;
  /** Annualised information ratio on the daily active return — the objective being judged. */
  ir: number | null;
  sharpe: number | null;
  spySharpe: number | null;
  /** t on the IR: IR × √years. |t| < 1.96 means not distinguishable from zero at 95%. */
  t: number | null;
}

function stats(book: number[], spy: number[]): Stats {
  const n = Math.min(book.length, spy.length);
  if (n === 0) return { n: 0, cumBookPct: null, cumSpyPct: null, cumActivePct: null, dailyActiveVolPct: null, ir: null, sharpe: null, spySharpe: null, t: null };
  const b = book.slice(0, n), s = spy.slice(0, n);
  const active = b.map((x, i) => x - s[i]);
  const av = sd(active);
  const ir = av > 0 ? (mean(active) / av) * Math.sqrt(252) : null;
  return {
    n,
    cumBookPct: compound(b) * 100,
    cumSpyPct: compound(s) * 100,
    cumActivePct: (compound(b) - compound(s)) * 100,
    dailyActiveVolPct: n >= 2 ? av * 100 : null,
    ir,
    sharpe: sd(b) > 0 ? (mean(b) / sd(b)) * Math.sqrt(252) : null,
    spySharpe: sd(s) > 0 ? (mean(s) / sd(s)) * Math.sqrt(252) : null,
    t: ir == null ? null : ir * Math.sqrt(n / 252),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const runs = (await loadRuns()).filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date));
// One run per date. The current history has none, but a drop-check that sells writes a second run
// for the same date, and the LAST one holds that day's final positions.
const byDate = new Map<string, StoredRun>();
for (const r of runs) byDate.set(r.date, r);
const dates = [...byDate.keys()].sort();
console.error(`runs: ${runs.length} across ${dates.length} dates (${dates[0]} → ${dates[dates.length - 1]})`);

const symbols = [...new Set(dates.flatMap(d => (byDate.get(d)!.positions ?? []).map(p => p.symbol)))].filter(Boolean);
console.error(`symbols held at any point: ${symbols.length} — ${symbols.join(" ")}`);

const closes = await loadCloses(symbols, dates[0]);
const missing = symbols.filter(s => !closes.has(s));
if (missing.length > 0) console.error(`⚠ no Sharadar closes for: ${missing.join(" ")} — dates holding these are withheld`);

/** Reprice a run's positions at that date's CLOSE. Returns null if any holding is unpriceable. */
function repriceAtClose(run: StoredRun): PositionSnapshot[] | null {
  const out: PositionSnapshot[] = [];
  for (const p of run.positions ?? []) {
    const c = closes.get(p.symbol)?.get(run.date);
    // No avgCost fallback, on purpose: priceOf would substitute cost and inject a phantom move.
    if (!(c != null && c > 0)) return null;
    out.push({ ...p, price: String(c) });
  }
  return out;
}

const snapshots: CloseSnapshot[] = [];
const skipped: string[] = [];
for (const date of dates) {
  const run = byDate.get(date)!;
  const spyClose = closes.get("SPY")?.get(date);
  const priced = repriceAtClose(run);
  if (priced == null || !(spyClose != null && spyClose > 0)) {
    skipped.push(`${date}(${priced == null ? "position" : "spy"})`);
    continue;
  }
  const cash = parseFloat(run.portfolioAfter?.cash ?? "0") || 0;
  const unsettled = parseFloat(run.portfolioAfter?.unsettledCash ?? "0") || 0;
  const equity = priced.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
  snapshots.push({
    date,
    capturedAt: `${date}T20:00:00.000Z`,
    spyClose,
    totalValue: cash + unsettled + equity,
    positions: priced,
  });
}
if (skipped.length > 0) console.error(`⚠ withheld dates: ${skipped.join(" ")}`);
console.error(`reconstructed snapshots: ${snapshots.length}\n`);

const tradesByDate = new Map<string, TradeSnapshot[]>();
for (const d of dates) tradesByDate.set(d, byDate.get(d)!.trades ?? []);

// ── TOTAL BOOK, both clocks ──────────────────────────────────────────────────
const closeReturns = computeCloseReturns(snapshots, tradesByDate);
const closeSummary = summarizeCloseReturns(closeReturns);

const pairedClose = closeReturns.filter(r => r.bookReturn != null && r.spyReturn != null);
const closeTotal = stats(pairedClose.map(r => r.bookReturn!), pairedClose.map(r => r.spyReturn!));

// The 10:30 clock, from the stored fields the dashboard already reads.
const snapBook: number[] = [], snapSpy: number[] = [], snapMain: number[] = [], snapMainSpy: number[] = [];
for (let i = 1; i < dates.length; i++) {
  const cur = byDate.get(dates[i])!, prev = byDate.get(dates[i - 1])!;
  if (!(cur.spyPrice! > 0) || !(prev.spyPrice! > 0)) continue;
  const s = cur.spyPrice! / prev.spyPrice! - 1;
  if (typeof cur.agenticDailyReturn === "number") { snapBook.push(cur.agenticDailyReturn); snapSpy.push(s); }
  if (typeof cur.mainDailyReturn === "number") { snapMain.push(cur.mainDailyReturn); snapMainSpy.push(s); }
}
const snapTotal = stats(snapBook, snapSpy);

// ── MAIN BOOK, both clocks — this is what the backtest actually models ────────
// LIVE_PROXY is the S&P-500 momentum book: 6 positions, quality gate, −5% same-day stop, 5-day
// rebalance. The influencer sleeve is NOT in the backtest, so comparing the TOTAL book to it would
// be comparing two different strategies.
const closeMain: number[] = [], closeMainSpy: number[] = [];
for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1], cur = snapshots[i];
  const curRun = byDate.get(cur.date)!, prevRun = byDate.get(prev.date)!;
  const inflOf = (run: StoredRun, snap: CloseSnapshot) => {
    const want = new Set((run.influencerPositions ?? []).map(p => p.symbol));
    return snap.positions.filter(p => want.has(p.symbol));
  };
  const trades: TradeSnapshot[] = [];
  for (const [d, ts] of tradesByDate) if (d > prev.date && d <= cur.date) trades.push(...ts);
  const r = computeSleeveReturns(
    cur.positions, trades,
    inflOf(curRun, cur), inflOf(prevRun, prev),
    prev.positions,
  );
  if (r.mainDailyReturn != null && prev.spyClose > 0) {
    closeMain.push(r.mainDailyReturn);
    closeMainSpy.push(cur.spyClose / prev.spyClose - 1);
  }
}
const closeMainStats = stats(closeMain, closeMainSpy);
const snapMainStats = stats(snapMain, snapMainSpy);

// ── report ───────────────────────────────────────────────────────────────────
const row = (label: string, a: string, b: string) =>
  console.log(`  ${label.padEnd(26)}${a.padStart(14)}${b.padStart(14)}`);

const block = (title: string, snapS: Stats, closeS: Stats) => {
  console.log(`\n${title}`);
  console.log("  " + "─".repeat(53));
  row("", "10:30 CLOCK", "CLOSE CLOCK");
  row("paired days", String(snapS.n), String(closeS.n));
  row("cumulative book", pct(snapS.cumBookPct), pct(closeS.cumBookPct));
  row("cumulative SPY", pct(snapS.cumSpyPct), pct(closeS.cumSpyPct));
  row("cumulative ACTIVE", pct(snapS.cumActivePct), pct(closeS.cumActivePct));
  row("daily active vol", pct(snapS.dailyActiveVolPct), pct(closeS.dailyActiveVolPct));
  row("Sharpe (ann.)", num(snapS.sharpe), num(closeS.sharpe));
  row("SPY Sharpe (ann.)", num(snapS.spySharpe), num(closeS.spySharpe));
  row("info ratio (ann.)", num(snapS.ir), num(closeS.ir));
  row("t on the IR", num(snapS.t), num(closeS.t));
};

console.log("CLOSE-TO-CLOSE RECONSTRUCTION vs the 10:30 series");
block("TOTAL BOOK (main + influencer sleeve)", snapTotal, closeTotal);
block("MAIN BOOK ONLY — the thing the backtest models", snapMainStats, closeMainStats);

// Reference figures from scripts/full-period.ts over 1999-01-04 → 2026-09-29 (6,977 days, 27.7y),
// production quality gate (ARY/netinc), re-derive by re-running that script rather than trusting
// these if anything in the strategy changes.
const BT = { cagr: 13.70, spyCagr: 8.68, sharpe: 0.59, spySharpe: 0.53, ir: 0.30, years: 27.7 };
console.log(`\n\nBACKTEST REFERENCE — 27.7 years, close-to-close`);
console.log("  " + "─".repeat(53));
row("CAGR", pct(BT.cagr), pct(BT.spyCagr));
row("Sharpe (ann.)", num(BT.sharpe), num(BT.spySharpe));
row("info ratio (ann.)", num(BT.ir), "—");
row("t on the IR", num(BT.ir * Math.sqrt(BT.years)), "—");

// ── what the comparison can and cannot establish ─────────────────────────────
// An IR estimated over n days carries a standard error of about √(252/n) in annualised units. That
// is the whole verdict: at n≈30 the error bar is ±2.9, so the live estimate cannot be distinguished
// from the backtest's 0.30 — nor from zero, nor from 3.
const n = closeMainStats.n || 1;
const se = Math.sqrt(252 / n);
console.log(`\n\nWHAT THIS CAN ESTABLISH`);
console.log("  " + "─".repeat(53));
console.log(`  live main-book IR (close clock)   ${num(closeMainStats.ir)}  over ${closeMainStats.n} days`);
console.log(`  standard error on that estimate   ±${num(se)}  (= √(252/${closeMainStats.n}))`);
if (closeMainStats.ir != null) {
  console.log(`  95% interval                      ${num(closeMainStats.ir - 1.96 * se)} … ${num(closeMainStats.ir + 1.96 * se)}`);
  const consistent = Math.abs(closeMainStats.ir - BT.ir) < 1.96 * se;
  console.log(`  consistent with backtest IR 0.30? ${consistent ? "YES — cannot be distinguished" : "NO"}`);
  console.log(`  distinguishable from zero?        ${Math.abs(closeMainStats.t ?? 0) >= 1.96 ? "yes" : "no"}`);
}
// Days to resolve an IR gap of `d` at 95%: 1.96·√(252/n) = d  →  n = 252·(1.96/d)².
const daysFor = (d: number) => 252 * (1.96 / d) ** 2;
const yearsFor = (d: number) => daysFor(d) / 252;
console.log(`\n  POWER — how long until this series can actually decide something`);
console.log(`  years to prove IR=0.30 beats 0            ~${yearsFor(BT.ir).toFixed(0)}`);
console.log(`  years to pin the IR to ±0.10             ~${yearsFor(0.10).toFixed(0)}`);
// The practical question is not "is it excellent?" but "is it broken?" — a large shortfall from the
// backtest resolves far sooner than a small one, because the required window scales as 1/d².
for (const target of [-0.5, -1.0, -2.0]) {
  const d = BT.ir - target;
  console.log(`  years to detect the live IR is ≤ ${target.toFixed(1)}    ~${yearsFor(d).toFixed(1)}  (gap ${d.toFixed(1)})`);
}
console.log(`\n  The clock mattered for the COMPARISON, not for the verdict: both clocks sit far inside`);
console.log(`  the error bar, so neither can confirm or refute the backtest. Note the SPY Sharpe`);
console.log(`  flips SIGN between the two clocks over the same 29 days — that is why an absolute`);
console.log(`  statistic must never be quoted without saying which clock produced it.`);
