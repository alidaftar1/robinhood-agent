/**
 * BEAR-MARKET RISK TEST — the one pre-specified question this Sharadar purchase was for.
 *
 *   bun scripts/bear-test.ts                 # all windows
 *   bun scripts/bear-test.ts gfc covid       # named windows only
 *   bun scripts/bear-test.ts --no-quality    # momentum-only, for the A/B
 *   bun scripts/bear-test.ts --ttm           # quality from TTM (ART) instead of annual (ARY)
 *
 * The live book is a bull/chop strategy with ZERO bear data: the regime signal is advisory-only,
 * the sympathy heuristic inverts in a downturn, there is no hedge and no cash trigger, and
 * de-risking is reactive via serial stop-outs. This runs the CURRENT screen, unmodified, through
 * four historical bears and reports the drawdown.
 *
 * WHY THIS IS NOT AN OVERFITTING EXERCISE: one strategy, four pre-specified windows, no variant
 * search, no parameter tuning. Nothing is being selected, so there is no multiple-comparisons cost.
 * The moment this is used to CHOOSE among variants that protection is gone.
 *
 * WHAT IT DOES NOT MODEL (repeated here because a number without its caveats gets quoted alone):
 *   · The LLM layer — this tests THE SCREEN, not the agent.
 *   · Quality — ON by default (point-in-time, keyed on filing date). Pass --no-quality to
 *     reproduce the momentum-only run, so quality's contribution reads as a DIFFERENCE on
 *     identical windows rather than a comparison across two separate reports.
 *   · Intraday stops — evaluated on closes, which UNDERSTATES stop-outs in a fast crash.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { buildCaptureDayFromHistory, buildDateIndex, type Bar, type Series } from "../lib/sharadar-features";
import { runBacktest, DEFAULT_BACKTEST } from "../lib/backtest";
import { LIVE_PROXY } from "../lib/strategy-variant";
import { parseFundamentalsCsv, buildFundamentalIndex, qualityAsOf } from "../lib/sharadar-quality";

// NOT hardcoded to one machine. scripts/sharadar-extract.sh already honours SHARADAR_CACHE_DIR and
// falls back to $HOME, but these runners did not — so on GitHub Actions the extract wrote to
// /home/runner/.cache/sharadar while the backtest read /Users/ali/..., and died instantly.
const CACHE = process.env.SHARADAR_CACHE_DIR
  ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.cache/sharadar`;

interface Window { key: string; label: string; from: string; to: string; }

// Test windows are PRE-SPECIFIED, with a ~1.5y data lead-in so 12-1 momentum (253 bars) is defined
// on the first test day rather than ramping up inside the window.
const WINDOWS: Window[] = [
  { key: "dotcom", label: "Dot-com bust", from: "2000-03-01", to: "2002-12-31" },
  { key: "gfc", label: "Global financial crisis", from: "2007-10-01", to: "2009-06-30" },
  { key: "covid", label: "COVID crash + recovery", from: "2020-01-02", to: "2020-12-31" },
  { key: "y2022", label: "2022 grind", from: "2022-01-03", to: "2022-12-30" },
];
const LEADIN_DAYS = 560;   // calendar days of history before `from`, for the 253-bar formation

const pct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Stream the filtered price CSV, keeping only rows inside [from, to]. Bounds memory: loading all
 *  5.5M rows at once is ~2GB of objects, and one window needs a fraction of that. */
async function loadSeries(from: string, to: string): Promise<{ series: Series; adj: Map<string, Map<string, number>> }> {
  // STREAMED, deliberately. Reading this 385MB file with .text() materialises one giant JS string
  // per call; across four windows in a single process that exhausted memory and later windows
  // silently produced ZERO usable rows, which the harness then printed as "-100.05% return" as if
  // it were a finding. Streaming keeps peak memory to one chunk.
  const series: Series = new Map();
  const adj = new Map<string, Map<string, number>>();   // date -> symbol -> closeadj (for P&L)
  const stream = Bun.file(`${CACHE}/sp500_prices.csv`).stream();
  const decoder = new TextDecoder();
  let carry = "";
  let seenHeader = false;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    carry += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      if (!seenHeader) { seenHeader = true; continue; }
      ingest(line);
    }
  }
  if (carry) ingest(carry);
  function ingest(line: string) {
    if (!line) return;
    // ticker,date,open,high,low,close,volume,closeadj,closeunadj,lastupdated
    const f = line.split(",");
    if (f.length < 8) return;
    const date = f[1];
    if (date < from || date > to) return;
    const ticker = f[0];
    const high = +f[3], close = +f[5], closeadj = +f[7];
    if (!Number.isFinite(close) || close <= 0) return;
    let bars = series.get(ticker);
    if (!bars) { bars = []; series.set(ticker, bars); }
    bars.push({ date, close, high, closeadj: Number.isFinite(closeadj) && closeadj > 0 ? closeadj : close });
    let m = adj.get(date);
    if (!m) { m = new Map(); adj.set(date, m); }
    m.set(ticker, Number.isFinite(closeadj) && closeadj > 0 ? closeadj : close);
  }
  // The CSV is newest-first per ticker; every index formula assumes ASCENDING. Getting this wrong
  // reverses momentum entirely (a crash would rank as the strongest possible trend).
  for (const bars of series.values()) bars.sort((a, b) => a.date.localeCompare(b.date));
  return { series, adj };
}

async function loadSpy(): Promise<Map<string, number>> {
  const text = await Bun.file(`${CACHE}/spy.csv`).text();
  const out = new Map<string, number>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.split(",");
    if (f.length < 8) continue;
    const v = +f[7];   // closeadj — total return, the honest benchmark
    if (f[1] && Number.isFinite(v) && v > 0) out.set(f[1], v);
  }
  return out;
}

const argv = process.argv.slice(2);
// --no-quality reproduces the pre-Bundle momentum-only run, so the quality contribution can be
// read as a DIFFERENCE on identical windows rather than compared across two separate reports.
const useQuality = !argv.includes("--no-quality");
// ARY = as-reported ANNUAL (what lib/quality.ts mirrors today; refreshes once a year, so the gate
// runs 12-15 months stale every Q1). ART = as-reported TRAILING TWELVE MONTHS, refreshed each
// quarter — income items are TTM sums, balance-sheet items the latest quarter-end. The hypothesis
// this flag exists to test: TTM removes the staleness that cost 22 points in 2022 WITHOUT giving
// back quality's +10.4 in the GFC.
const dimension = argv.includes("--ttm") ? "ART" : "ARY";
// The numerator under test: net income (production) vs operating cash flow.
const qualityBasis: "netinc" | "ncfo" = argv.includes("--cashflow") ? "ncfo" : "netinc";
const wanted = argv.filter(a => !a.startsWith("--"));
const runWindows = wanted.length ? WINDOWS.filter(w => wanted.includes(w.key)) : WINDOWS;

const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const spy = await loadSpy();

// Point-in-time quality, keyed on FILING dates. Parsed once; ARY (as-reported annual) only.
let fundIndex: ReturnType<typeof buildFundamentalIndex> | null = null;
if (useQuality) {
  const tickers = new Set(sp500Rows.map(r => r.ticker));
  const rows = parseFundamentalsCsv(await Bun.file(`${CACHE}/sp500_fund_all.csv`).text(), { dimension, tickers });
  fundIndex = buildFundamentalIndex(rows);
  const label = dimension === "ART" ? "as-reported TTM (quarterly refresh)" : "as-reported ANNUAL (yearly refresh)";
  console.log(`Quality: ${rows.length} ${label} filings across ${fundIndex.size} tickers (point-in-time, keyed on filing date).`);
}

console.log(`\nBEAR-MARKET RISK TEST — ${LIVE_PROXY.id}`);
console.log(`Screen: ${LIVE_PROXY.description}`);
console.log(`Config: rebalance every ${DEFAULT_BACKTEST.rebalanceEveryDays}d, stop ${DEFAULT_BACKTEST.stopLossPct}%, cost ${DEFAULT_BACKTEST.costBps}bps, ${LIVE_PROXY.config.maxPositions} positions / ${LIVE_PROXY.config.maxPerSector} per sector`);
console.log(`Quality gate: ${useQuality ? `ON — ${dimension}/${qualityBasis} (point-in-time, keyed on FILING date)` : "OFF — momentum-only"}; stops on closes, not intraday.\n`);

const rows: string[] = [];
for (const w of runWindows) {
  const dataFrom = shiftDays(w.from, -LEADIN_DAYS);
  const { series, adj } = await loadSeries(dataFrom, w.to);
  const dateIdx = buildDateIndex(series);

  // Trading days inside the window: dates SPY traded (the market calendar) that we also have data for.
  const tradingDays = [...new Set([...adj.keys()])].filter(d => d >= w.from && d <= w.to).sort();

  // Recomputing the cross-sectional percentile every day over ~500 names is wasteful and the
  // cohort barely moves between filings, so it is refreshed monthly. That is a deliberate
  // approximation of a gate whose inputs only change when someone files.
  let qCache: Map<string, number> | null = null;
  let qMonth = "";
  const days = tradingDays.map(date => {
    const members = membersAsOfPrecise(universe, sp500Rows, date) ?? new Set<string>();
    let q: Map<string, number> | undefined;
    if (fundIndex) {
      const month = date.slice(0, 7);
      if (month !== qMonth) { qCache = qualityAsOf(members, fundIndex, date, qualityBasis).quality; qMonth = month; }
      q = qCache ?? undefined;
    }
    return buildCaptureDayFromHistory(date, members, series, dateIdx, spy.get(date) ?? null, q);
  });

  const priceOf = (date: string, symbol: string) => adj.get(date)?.get(symbol) ?? null;
  const r = runBacktest(LIVE_PROXY, days, priceOf, (d) => spy.get(d) ?? null, DEFAULT_BACKTEST);

  console.log(`── ${w.label} (${r.from} → ${r.to}, ${r.days} trading days)`);
  console.log(`   Strategy return      ${pct(r.totalReturnPct)}`);
  console.log(`   SPY return           ${pct(r.spyReturnPct)}`);
  console.log(`   Strategy MAX DD      ${pct(r.maxDrawdownPct)}   ${r.drawdownFrom ?? "?"} → ${r.drawdownTo ?? "?"}`);
  console.log(`   SPY MAX DD           ${pct(r.spyMaxDrawdownPct)}`);
  console.log(`   Trades / stop-outs   ${r.trades} / ${r.stopOuts}`);
  console.log(`   Days flat (in cash)  ${r.daysFlat} of ${r.days} (${((r.daysFlat / r.days) * 100).toFixed(0)}%)`);
  if (r.notes.length) console.log(`   Notes: ${r.notes.join("; ")}`);
  if (!r.usable) console.log(`   ⛔ THIS WINDOW IS NOT A RESULT — do not quote it.`);
  console.log("");

  rows.push([
    w.label.padEnd(26),
    pct(r.totalReturnPct).padStart(9),
    pct(r.spyReturnPct).padStart(9),
    pct(r.maxDrawdownPct).padStart(9),
    pct(r.spyMaxDrawdownPct).padStart(9),
    String(r.stopOuts).padStart(6),
    r.usable ? "" : "  ⛔ UNUSABLE",
  ].join(" "));
}

console.log("=".repeat(80));
console.log("SUMMARY".padEnd(26) + "   return".padStart(9) + "   SPY".padStart(9) + "  MAX DD".padStart(9) + "  SPY DD".padStart(9) + " stops".padStart(7));
for (const r of rows) console.log(r);
console.log("=".repeat(80));
console.log("A strategy MAX DD worse than SPY's in a bear means the reactive stop-out design did not");
console.log("protect — it participated. That is the question this test exists to answer.\n");
