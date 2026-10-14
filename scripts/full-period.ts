/**
 * FULL-CYCLE BACKTEST — 1999 to 2026, continuous.
 *
 *   bun scripts/full-period.ts            # quality from annual filings (matches production)
 *   bun scripts/full-period.ts --ttm      # quality from trailing-twelve-months
 *   bun scripts/full-period.ts --no-quality
 *   bun scripts/full-period.ts --ttm --cashflow   # quality on OPERATING CASH FLOW, not net income
 *
 * WHY THIS EXISTS, and it is a correction to how the bear test was being read. That test measured
 * four windows chosen FOR BEING THE WORST in 28 years, so "loses in 3 of 4" is true by construction
 * — a momentum strategy losing in bear markets is the expected, documented behaviour, not a finding.
 * The question it cannot answer is whether the strategy makes that back across the other ~24 years.
 * This runs the whole span so the bear losses can be priced against everything else.
 *
 * Still ONE pre-specified test of one unmodified strategy: no variant search, no parameter tuning.
 *
 * Unchanged caveats: no LLM layer (this is the screen and the rails, not the agent); stops on
 * closes, so intraday stop-outs are undercounted; close-to-close execution.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { buildCaptureDayFromHistory, buildDateIndex, type Bar, type Series } from "../lib/sharadar-features";
import { runBacktest, DEFAULT_BACKTEST, maxDrawdown, type DayMark } from "../lib/backtest";
import { LIVE_PROXY, LIVE_PROXY_PE, type StrategyVariant } from "../lib/strategy-variant";
import { parseFundamentalsCsv, buildFundamentalIndex, qualityAsOf } from "../lib/sharadar-quality";
import { MAIN_DROP_THRESHOLD_PCT } from "../lib/stopouts";

// NOT hardcoded to one machine. scripts/sharadar-extract.sh already honours SHARADAR_CACHE_DIR and
// falls back to $HOME, but these runners did not — so on GitHub Actions the extract wrote to
// /home/runner/.cache/sharadar while the backtest read /Users/ali/..., and died instantly.
const CACHE = process.env.SHARADAR_CACHE_DIR
  ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.cache/sharadar`;
const DATA_FROM = "1997-12-31";   // earliest price bar available
const TEST_FROM = "1999-01-04";   // ~253 bars later, so 12-1 momentum is defined on day one
const TEST_TO = "2026-09-29";

const argv = process.argv.slice(2);
const MAIN_BAR = MAIN_DROP_THRESHOLD_PCT;   // the live main-book same-day bar
const useQuality = !argv.includes("--no-quality");
const dimension = argv.includes("--ttm") ? "ART" : "ARY";
// The numerator under test: net income (production) vs operating cash flow.
const qualityBasis: "netinc" | "ncfo" = argv.includes("--cashflow") ? "ncfo" : "netinc";

const pct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;

/**
 * Stream every bar into per-symbol series. No separate date→price map: prices are reachable through
 * the date index already needed for features, which avoids a second 5.5M-entry structure.
 */
async function loadAll(): Promise<Series> {
  const series: Series = new Map();
  const stream = Bun.file(`${CACHE}/sp500_prices.csv`).stream();
  const dec = new TextDecoder();
  let carry = "", seenHeader = false, kept = 0;
  const ingest = (line: string) => {
    if (!line) return;
    const f = line.split(",");
    if (f.length < 8) return;
    const date = f[1];
    if (date < DATA_FROM || date > TEST_TO) return;
    const close = +f[5];
    if (!Number.isFinite(close) || close <= 0) return;
    const ca = +f[7];
    let bars = series.get(f[0]);
    if (!bars) { bars = []; series.set(f[0], bars); }
    bars.push({ date, close, high: +f[3], closeadj: Number.isFinite(ca) && ca > 0 ? ca : close });
    kept++;
  };
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
      if (!seenHeader) { seenHeader = true; continue; }
      ingest(line);
    }
  }
  if (carry) ingest(carry);
  // Every index formula assumes ASCENDING dates. The source is newest-first per ticker, and getting
  // this backwards would invert momentum entirely — a crash would rank as the strongest trend.
  for (const bars of series.values()) bars.sort((a, b) => a.date.localeCompare(b.date));
  console.error(`loaded ${kept.toLocaleString()} bars across ${series.size} tickers`);
  return series;
}

async function loadSpy(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const line of (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)) {
    const f = line.split(",");
    if (f.length < 8) continue;
    const v = +f[7];                       // closeadj — total return
    if (f[1] && Number.isFinite(v) && v > 0) out.set(f[1], v);
  }
  return out;
}

const series = await loadAll();
const dateIdx = buildDateIndex(series);
const spy = await loadSpy();
const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);

let fundIndex: ReturnType<typeof buildFundamentalIndex> | null = null;
if (useQuality) {
  const tickers = new Set(sp500Rows.map(r => r.ticker));
  const rows = parseFundamentalsCsv(await Bun.file(`${CACHE}/sp500_fund_all.csv`).text(), { dimension, tickers, basis: qualityBasis });
  fundIndex = buildFundamentalIndex(rows);
  console.error(`quality: ${rows.length.toLocaleString()} ${dimension} filings / ${fundIndex.size} tickers`);
}

// Market calendar = the dates SPY traded, intersected with dates we hold bars for.
const tradingDays = [...dateIdx.keys()].filter(d => d >= TEST_FROM && d <= TEST_TO && spy.has(d)).sort();
console.error(`trading days: ${tradingDays.length}`);

/** LAZY. Each CaptureDay is built on demand and collected after use — see runBacktest's `days`. */
function* dayStream(): Generator<import("../lib/feature-capture").CaptureDay> {
  let qCache: Map<string, number> | null = null, peCache: Map<string, number> | null = null, qMonth = "";
  for (const date of tradingDays) {
    const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
    let q: Map<string, number> | undefined, pe: Map<string, number> | undefined;
    if (fundIndex) {
      const month = date.slice(0, 7);
      if (month !== qMonth) { const r = qualityAsOf(members, fundIndex, date, qualityBasis); qCache = r.quality; peCache = r.pe; qMonth = month; }
      q = qCache ?? undefined; pe = peCache ?? undefined;
    }
    yield buildCaptureDayFromHistory(date, members, series, dateIdx, spy.get(date) ?? null, q, pe);
  }
}

const priceOf = (date: string, symbol: string): number | null => {
  const i = dateIdx.get(date)?.get(symbol);
  if (i == null) return null;
  return series.get(symbol)?.[i]?.closeadj ?? null;
};

// POSITION SWEEP. `--positions 6,8,10,12` runs the same 28 years at each concentration level and
// prints a comparison instead of a single report.
//
// This is the question docs/experiment-main-book-position-cap.md parked: the live book targets ~6
// names and holds 12, and capping is right only if DILUTION is the cause rather than a symptom of
// no selection edge. That doc proposed answering it with weeks of live picked-vs-passed-over
// capture. The backtest answers the MECHANICAL half now, over 28 survivorship-free years: holding
// the same rules and varying only maxPositions. It cannot tell us whether THIS model picks well —
// but it can say whether the strategy's own design rewards concentration at all, which is the
// premise the cap rests on.
//
// One pass per level: the day stream is lazy on purpose (materialising 28 years is several GB), so
// each level rebuilds days. The expensive I/O — prices, fundamentals, membership — happens once.
// --variant live-proxy-pe runs the valuation-gated clone instead of the baseline. Same data, same
// rebalance, same costs — only the eligibility rule differs, so the two runs are comparable.
const VARIANT: StrategyVariant = argv.includes("--variant")
  && argv[argv.indexOf("--variant") + 1] === "live-proxy-pe" ? LIVE_PROXY_PE : LIVE_PROXY;

// --stops -5,-7,-10,off — sweep the SAME-DAY crash bar (lib/stopouts MAIN_DROP_THRESHOLD_PCT).
// Asked 2026-10-14: is -5% in a single session too tight for the main book? The bar is not a
// stop-loss from entry — it fires on a -5% DAY — so the question is empirical: does a one-day
// crater of that size predict further decline, or mean-revert? Reports stopOuts alongside the
// return metrics, because "how often does it fire" is half the answer.
//
// CAVEATS, unchanged from the header and load-bearing here: stops are evaluated on CLOSES, so a
// day that dipped through the bar and recovered never triggers — this UNDERSTATES stop-outs at
// every level, and understates them MORE at tighter levels. And the live system puts a
// sympathy-hold judgment between the trigger and the order, which this has no model of. So these
// rows bound the mechanical bar, not the live behaviour.
// --stop-mode from-entry  sweeps the CUMULATIVE bar instead of the same-day one.
// --entry-stops -15,-20   keeps the live same-day bar AND adds a cumulative one, to price running
//                         both. Asked 2026-10-14: the main book automates only the same-day axis
//                         and the sleeve only the cumulative one, so each is blind where the other
//                         guards — a main name can sit 25% under entry for a week untouched.
const stopModeArg = argv.indexOf("--stop-mode");
const STOP_MODE: "same-day" | "from-entry" =
  stopModeArg !== -1 && argv[stopModeArg + 1] === "from-entry" ? "from-entry" : "same-day";

const entryStopsArg = argv.indexOf("--entry-stops");
const entryStopSweep: Array<number | null> | null = entryStopsArg !== -1
  ? argv[entryStopsArg + 1].split(",").map(t => t.trim()).map(t => t === "off" ? null : parseFloat(t))
      .filter(v => v === null || Number.isFinite(v))
  : null;

const stopsArg = argv.indexOf("--stops");
const stopSweep: Array<number | null> | null = stopsArg !== -1
  ? argv[stopsArg + 1].split(",").map(t => t.trim()).map(t => t === "off" ? null : parseFloat(t))
      .filter(v => v === null || Number.isFinite(v))
  : null;

const sweepArg = argv.indexOf("--positions");
const sweep = sweepArg !== -1
  ? argv[sweepArg + 1].split(",").map(n => parseInt(n.trim(), 10)).filter(Number.isFinite)
  : [VARIANT.config.maxPositions];

type StopRow = { label: string; cfg: Parameters<typeof runBacktest>[4] };
const stopRows: StopRow[] | null =
  entryStopSweep
    ? entryStopSweep.map(e => ({
        label: e === null ? `${MAIN_BAR}% only` : `${MAIN_BAR}%d + ${e}%e`,
        cfg: { ...DEFAULT_BACKTEST, stopLossPct: MAIN_BAR, stopMode: "same-day" as const, entryStopPct: e },
      }))
    : stopSweep
    ? stopSweep.map(v => ({
        label: v === null ? "none" : `${v}%`,
        cfg: { ...DEFAULT_BACKTEST, stopLossPct: v, stopMode: STOP_MODE },
      }))
    : null;

if (stopRows && stopRows.length > 0) {
  const what = entryStopSweep ? `live same-day ${MAIN_BAR}% PLUS a cumulative bar` : `${STOP_MODE} bar`;
  console.log(`\nSTOP SWEEP — ${VARIANT.id}, ${what}, ${VARIANT.config.maxPositions} positions, same rules otherwise`);
  console.log(`Quality: ${useQuality ? `${dimension}/${qualityBasis}` : "OFF"} · rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d · cost ${DEFAULT_BACKTEST.costBps}bps`);
  console.log(`Stops evaluated on CLOSES — intraday round-trips never fire, so every stopOut count below is a FLOOR.\n`);
  console.log(`  ${"stop".padEnd(16)}${"CAGR".padStart(9)}${"Sharpe".padStart(9)}${"IR".padStart(8)}${"maxDD".padStart(9)}${"trades".padStart(9)}${"stopOuts".padStart(10)}${"flat days".padStart(11)}`);
  console.log("  " + "─".repeat(81));
  for (const row of stopRows) {
    const rr = runBacktest(VARIANT, dayStream(), priceOf, (d) => spy.get(d) ?? null, row.cfg);
    const yrs = (Date.parse(rr.to) - Date.parse(rr.from)) / (365.25 * 86_400_000);
    const e = rr.marks.map(m => m.equity), sps = rr.marks.map(m => m.spy);
    const dr = (v: Array<number | null>) => { const o: number[] = []; for (let i=1;i<v.length;i++){const a=v[i-1],b=v[i]; if(a!=null&&b!=null&&a>0)o.push(b/a-1);} return o; };
    const mn = (x: number[]) => x.reduce((a,b)=>a+b,0)/(x.length||1);
    const sdv = (x: number[]) => { const m=mn(x); return Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/(x.length||1)); };
    const rsv = dr(e), rbv = dr(sps);
    const act: number[] = []; for (let i=0;i<Math.min(rsv.length,rbv.length);i++) act.push(rsv[i]-rbv[i]);
    const cg = (Math.pow(e[e.length-1]/e[0], 1/yrs) - 1) * 100;
    const sh = sdv(rsv) > 0 ? (mn(rsv)/sdv(rsv))*Math.sqrt(252) : 0;
    const irv = sdv(act) > 0 ? (mn(act)/sdv(act))*Math.sqrt(252) : 0;
    const label = row.label;
    const flag = rr.usable ? "" : "  ⛔ NOT USABLE";
    console.log(`  ${label.padEnd(16)}${pct(cg,2).padStart(9)}${sh.toFixed(2).padStart(9)}${irv.toFixed(2).padStart(8)}${pct(rr.maxDrawdownPct,1).padStart(9)}${String(rr.trades ?? "—").padStart(9)}${String(rr.stopOuts ?? "—").padStart(10)}${String(rr.daysFlat ?? "—").padStart(11)}${flag}`);
  }
  console.log(`\n  The live main book uses -5%. A LOOSER bar that wins here is evidence the crash stop is`);
  console.log(`  too tight; a tighter one winning would mean the opposite. Neither is a tuning licence —`);
  console.log(`  this is one sweep over one 28-year path, and the whole curve matters more than its best row.`);
  process.exit(0);
}

if (sweep.length > 1) {
  console.log(`\nPOSITION SWEEP — ${VARIANT.id}, ${sweep.join("/")} positions, same rules otherwise`);
  console.log(`Quality: ${useQuality ? `${dimension}/${qualityBasis}` : "OFF"} · rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d · stop ${DEFAULT_BACKTEST.stopLossPct}% · cost ${DEFAULT_BACKTEST.costBps}bps\n`);
  console.log(`  ${"positions".padEnd(10)}${"CAGR".padStart(9)}${"Sharpe".padStart(9)}${"IR".padStart(8)}${"maxDD".padStart(9)}${"trades".padStart(10)}`);
  console.log("  " + "─".repeat(55));
  for (const n of sweep) {
    const variant = { ...VARIANT, config: { ...VARIANT.config, maxPositions: n } };
    const rr = runBacktest(variant, dayStream(), priceOf, (d) => spy.get(d) ?? null, DEFAULT_BACKTEST);
    const yrs = (Date.parse(rr.to) - Date.parse(rr.from)) / (365.25 * 86_400_000);
    const e = rr.marks.map(m => m.equity), sps = rr.marks.map(m => m.spy);
    const dr = (v: Array<number | null>) => { const o: number[] = []; for (let i=1;i<v.length;i++){const a=v[i-1],b=v[i]; if(a!=null&&b!=null&&a>0)o.push(b/a-1);} return o; };
    const mn = (x: number[]) => x.reduce((a,b)=>a+b,0)/(x.length||1);
    const sdv = (x: number[]) => { const m=mn(x); return Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/(x.length||1)); };
    const rsv = dr(e), rbv = dr(sps);
    const act: number[] = []; for (let i=0;i<Math.min(rsv.length,rbv.length);i++) act.push(rsv[i]-rbv[i]);
    const cg = (Math.pow(e[e.length-1]/e[0], 1/yrs) - 1) * 100;
    const sh = sdv(rsv) > 0 ? (mn(rsv)/sdv(rsv))*Math.sqrt(252) : 0;
    const irv = sdv(act) > 0 ? (mn(act)/sdv(act))*Math.sqrt(252) : 0;
    const flag = rr.usable ? "" : "  ⛔ NOT USABLE";
    console.log(`  ${String(n).padEnd(10)}${pct(cg,2).padStart(9)}${sh.toFixed(2).padStart(9)}${irv.toFixed(2).padStart(8)}${pct(rr.maxDrawdownPct,1).padStart(9)}${String(rr.trades ?? "—").padStart(10)}${flag}`);
  }
  console.log(`\n  SPY over the same window is the baseline printed by a normal (non-sweep) run.`);
  process.exit(0);
}

const r = runBacktest(VARIANT, dayStream(), priceOf, (d) => spy.get(d) ?? null, DEFAULT_BACKTEST);

// ── metrics ──────────────────────────────────────────────────────────────────
const years = (Date.parse(r.to) - Date.parse(r.from)) / (365.25 * 86_400_000);
const cagr = (first: number, last: number) => (Math.pow(last / first, 1 / years) - 1) * 100;
const dailyRets = (vals: Array<number | null>) => {
  const out: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if (a != null && b != null && a > 0) out.push(b / a - 1);
  }
  return out;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1));
};
const eq = r.marks.map(m => m.equity);
const sp = r.marks.map(m => m.spy);
const rs = dailyRets(eq), rb = dailyRets(sp);
const sharpe = sd(rs) > 0 ? (mean(rs) / sd(rs)) * Math.sqrt(252) : 0;
const spySharpe = sd(rb) > 0 ? (mean(rb) / sd(rb)) * Math.sqrt(252) : 0;
// Information ratio on the daily active return — the objective the strategy is actually judged on.
const active: number[] = [];
for (let i = 0; i < Math.min(rs.length, rb.length); i++) active.push(rs[i] - rb[i]);
const ir = sd(active) > 0 ? (mean(active) / sd(active)) * Math.sqrt(252) : 0;

const spyFirst = sp.find(v => v != null) as number;
const spyLast = [...sp].reverse().find(v => v != null) as number;

console.log(`\nFULL-CYCLE BACKTEST — ${VARIANT.id}`);
console.log(`Quality: ${useQuality ? `${dimension}/${qualityBasis}` : "OFF (momentum-only)"} · rebalance ${DEFAULT_BACKTEST.rebalanceEveryDays}d · stop ${DEFAULT_BACKTEST.stopLossPct}% ${DEFAULT_BACKTEST.stopMode} · cost ${DEFAULT_BACKTEST.costBps}bps · ${VARIANT.config.maxPositions} positions`);
console.log(`${r.from} → ${r.to}  (${r.days.toLocaleString()} trading days, ${years.toFixed(1)} years)\n`);
if (!r.usable) console.log("⛔ NOT A RESULT — see notes below.\n");

const row = (k: string, a: string, b: string) => console.log(`  ${k.padEnd(26)}${a.padStart(13)}${b.padStart(13)}`);
row("", "STRATEGY", "SPY");
console.log("  " + "─".repeat(52));
row("Total return", pct(r.totalReturnPct, 1), pct(r.spyReturnPct, 1));
row("CAGR", pct(cagr(eq[0], eq[eq.length - 1]), 2), pct(cagr(spyFirst, spyLast), 2));
row("Max drawdown", pct(r.maxDrawdownPct, 1), pct(r.spyMaxDrawdownPct, 1));
row("Sharpe (annualised)", sharpe.toFixed(2), spySharpe.toFixed(2));
row("Information ratio", ir.toFixed(2), "—");
row("Trades", r.trades.toLocaleString(), "—");
row("Stop-outs", r.stopOuts.toLocaleString(), "—");
row("Days in cash", `${r.daysFlat} (${((r.daysFlat / r.days) * 100).toFixed(1)}%)`, "—");
console.log(`\n  Worst drawdown ran ${r.drawdownFrom} → ${r.drawdownTo}`);
if (r.notes.length) console.log(`  Notes: ${r.notes.join("; ")}`);

// ── year by year ─────────────────────────────────────────────────────────────
console.log(`\nYEAR BY YEAR\n  year      strategy        SPY      diff    maxDD`);
const byYear = new Map<string, DayMark[]>();
for (const m of r.marks) {
  const y = m.date.slice(0, 4);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y)!.push(m);
}
let win = 0, tot = 0;
for (const [y, ms] of [...byYear.entries()].sort()) {
  if (ms.length < 20) continue;
  const sr = (ms[ms.length - 1].equity / ms[0].equity - 1) * 100;
  const s0 = ms.find(m => m.spy != null)?.spy, s1 = [...ms].reverse().find(m => m.spy != null)?.spy;
  const br = s0 && s1 ? (s1 / s0 - 1) * 100 : null;
  const dd = maxDrawdown(ms.map(m => m.equity)).pct;
  const diff = br != null ? sr - br : null;
  if (diff != null) { tot++; if (diff > 0) win++; }
  const mark = diff == null ? " " : diff > 0 ? "▲" : "▼";
  console.log(`  ${y}  ${pct(sr, 1).padStart(11)}${pct(br, 1).padStart(11)}${(diff == null ? "—" : pct(diff, 1)).padStart(10)} ${mark}${pct(dd, 1).padStart(9)}`);
}
console.log(`\n  Beat SPY in ${win} of ${tot} calendar years (${((win / tot) * 100).toFixed(0)}%).`);
