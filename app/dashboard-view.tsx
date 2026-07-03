import React from "react";
import { getRuns, mergeRunsByDate, type TradeRun } from "@/lib/run-store";
import { computeCashPct, computeSectorBreakdown, computeBeta, betaDescription, computeT1Settling, computeMaxDrawdown, computeConcentration, computeBeatRate, computeBenchmarkVerdict } from "@/lib/risk-metrics";

// ─── Plain-language tooltip ─────────────────────────────────────────────────────
// Native `title` tooltips are slow and don't show on tap. This is a pure-CSS
// tooltip (no JS, works in a server component): the box shows on hover, and on
// tap/focus too (the wrapper is focusable), so it works on mobile.
const TIP_CSS = `
.tip{position:relative;cursor:help;border-bottom:1px dotted #4a4a4a;outline:none}
.tip .tipbox{position:absolute;bottom:150%;left:0;z-index:100;width:max-content;max-width:240px;
  background:#1d1d1d;color:#dcdcdc;border:1px solid #383838;padding:8px 11px;border-radius:6px;
  font-size:12px;line-height:1.45;text-transform:none;letter-spacing:normal;font-weight:400;
  opacity:0;visibility:hidden;transition:opacity .12s ease;box-shadow:0 6px 18px rgba(0,0,0,.55)}
.tip:hover .tipbox,.tip:focus .tipbox,.tip:focus-within .tipbox{opacity:1;visibility:visible}
`;

function Tip({ label, def, style }: { label: string; def: string; style?: React.CSSProperties }) {
  return (
    <span className="tip" tabIndex={0} style={style}>
      {label} <span style={{ opacity: 0.55 }}>ⓘ</span>
      <span className="tipbox">{def}</span>
    </span>
  );
}

// ─── Return series + chart ────────────────────────────────────────────────────

interface ReturnPoint {
  date: string;
  agentic: number | null;
  spy: number | null;
  influencer: number | null;
  main: number | null;
}

interface ReturnSeries {
  points: ReturnPoint[];
  // The 100-anchor (baseline) date for each series — the day BEFORE its first daily
  // return. Each sleeve starts on a different day (agentic from inception, influencer
  // only once the sleeve existed, main from its first tracked day), so each cumulative
  // covers a DIFFERENT window. Surfacing the per-series since-date stops the cards from
  // being read as one shared window (the "AI flat vs influencer −13%" confusion).
  since: { agentic: string | null; influencer: string | null; main: string | null };
}

function buildReturnSeries(runs: TradeRun[]): ReturnSeries {
  const chronological = [...runs].reverse();
  let agentIdx = 100;
  let influencerIdx = 100;
  let mainIdx = 100;
  const points: ReturnPoint[] = [];

  // The 100-anchor for a series is the run just before its first daily return (or that
  // run itself if it's the very first). Used both to co-index SPY to the AI window and
  // to label each card's real start date.
  const anchorDate = (firstIdx: number): string | null =>
    firstIdx < 0 ? null : (chronological[firstIdx - 1]?.date ?? chronological[firstIdx]?.date ?? null);
  const firstReturnIdx = chronological.findIndex(r => r.agenticDailyReturn != null);
  const firstInfluencerIdx = chronological.findIndex(r => r.influencerDailyReturn != null);
  const firstMainIdx = chronological.findIndex(r => r.mainDailyReturn != null);

  // Anchor SPY to the run just before the first agent return so both series
  // share the same start point and the comparison is fair.
  const spyBase: number | null = firstReturnIdx > 0
    ? (chronological[firstReturnIdx - 1].spyPrice ?? null)
    : firstReturnIdx === 0
      ? (chronological[0].spyPrice ?? null)
      : null;

  // Each series is indexed to 100 at its BASELINE — the run just before its first daily return —
  // so every line genuinely starts at 100 and its first day's move shows as the first segment
  // (previously the first plotted point was already one day off 100, which was invisible for the
  // low-move AI/main lines but landed the volatile influencer line at ~93, contradicting the label).
  const startEmit = (firstIdx: number) => firstIdx < 0 ? Infinity : Math.max(0, firstIdx - 1);
  const aStart = startEmit(firstReturnIdx), iStart = startEmit(firstInfluencerIdx), mStart = startEmit(firstMainIdx);

  chronological.forEach((run, i) => {
    if (run.agenticDailyReturn != null) agentIdx *= (1 + run.agenticDailyReturn);
    if (run.influencerDailyReturn != null) influencerIdx *= (1 + run.influencerDailyReturn);
    if (run.mainDailyReturn != null) mainIdx *= (1 + run.mainDailyReturn); // core S&P sleeve; null on older runs
    const spy = run.spyPrice && spyBase != null ? (run.spyPrice / spyBase) * 100 : null;
    points.push({
      date: run.date,
      agentic: i >= aStart ? agentIdx : null,
      spy,
      influencer: i >= iStart ? influencerIdx : null,
      main: i >= mStart ? mainIdx : null,
    });
  });
  return {
    points,
    since: {
      agentic: anchorDate(firstReturnIdx),
      influencer: anchorDate(firstInfluencerIdx),
      main: anchorDate(firstMainIdx),
    },
  };
}

function ReturnChart({ points }: { points: ReturnPoint[] }) {
  const valid = points.filter(p => p.agentic != null);
  if (valid.length < 2) return null;

  const W = 760, H = 140, PL = 44, PR = 12, PT = 8, PB = 28;
  const cw = W - PL - PR, ch = H - PT - PB;

  const allVals = valid.flatMap(p => [p.main, p.spy, p.influencer].filter(v => v != null) as number[]);
  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const pad = Math.max((maxV - minV) * 0.1, 1);
  const lo = minV - pad, hi = maxV + pad;

  const xOf = (i: number) => PL + (i / (valid.length - 1)) * cw;
  const yOf = (v: number) => PT + ch - ((v - lo) / (hi - lo)) * ch;

  const polyline = (getter: (p: ReturnPoint) => number | null, color: string) => {
    const pts = valid
      .map((p, i) => { const v = getter(p); return v != null ? `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}` : null; })
      .filter(Boolean).join(" ");
    return pts ? <polyline key={color} points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" /> : null;
  };

  // Y-axis ticks
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount }, (_, i) => lo + (i / (tickCount - 1)) * (hi - lo));

  // X-axis labels (show ~5 evenly spaced)
  const labelStep = Math.max(1, Math.floor(valid.length / 5));
  const xLabels = valid.filter((_, i) => i % labelStep === 0 || i === valid.length - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      {/* Gridlines */}
      {ticks.map((t, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={yOf(t)} y2={yOf(t)} stroke="#1e1e1e" strokeWidth="1" />
      ))}
      {/* Baseline at 100 */}
      <line x1={PL} x2={W - PR} y1={yOf(100)} y2={yOf(100)} stroke="#333" strokeWidth="1" strokeDasharray="4 3" />
      {/* Lines */}
      {polyline(p => p.spy, "#444")}
      {polyline(p => p.main, "#7dba7d")}
      {polyline(p => p.influencer, "#e8943a")}
      {/* Y-axis labels */}
      {ticks.map((t, i) => (
        <text key={i} x={PL - 4} y={yOf(t) + 4} textAnchor="end" fill="#555" fontSize="10">
          {t.toFixed(0)}
        </text>
      ))}
      {/* X-axis labels */}
      {xLabels.map((p, i) => {
        const idx = valid.indexOf(p);
        return (
          <text key={i} x={xOf(idx)} y={H - 4} textAnchor="middle" fill="#555" fontSize="10">
            {p.date.slice(5)}
          </text>
        );
      })}
    </svg>
  );
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p
  );
}

function MarkdownSummary({ text }: { text: string }) {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let bulletBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    nodes.push(
      <ul key={nodes.length} style={{ margin: "4px 0 4px 16px", padding: 0 }}>
        {bulletBuffer.map((b, i) => (
          <li key={i} style={{ marginBottom: 2 }}>{renderInline(b)}</li>
        ))}
      </ul>
    );
    bulletBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("### ")) {
      flushBullets();
      nodes.push(<div key={nodes.length} style={{ fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.5px", color: "#666", marginTop: 14, marginBottom: 4 }}>{line.slice(4)}</div>);
    } else if (line.startsWith("## ")) {
      flushBullets();
      nodes.push(<div key={nodes.length} style={{ fontWeight: 700, fontSize: 13, color: "#999", marginTop: 16, marginBottom: 6 }}>{line.slice(3)}</div>);
    } else if (line.startsWith("- ")) {
      bulletBuffer.push(line.slice(2));
    } else if (line.trim() === "") {
      flushBullets();
    } else {
      flushBullets();
      nodes.push(<div key={nodes.length} style={{ marginBottom: 4 }}>{renderInline(line)}</div>);
    }
  }
  flushBullets();
  return <>{nodes}</>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: { maxWidth: 900, margin: "0 auto", padding: "32px 20px" },
  header: { marginBottom: 32 },
  title: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.3px" },
  subtitle: { color: "#888", marginTop: 4, fontSize: 13 },
  emptyState: { color: "#555", padding: "48px 0", textAlign: "center" as const },
  perfCard: { background: "#111", border: "1px solid #222", borderRadius: 10, padding: "20px 24px", marginBottom: 28, display: "flex", gap: 32, flexWrap: "wrap" as const },
  perfStat: { display: "flex", flexDirection: "column" as const, gap: 2 },
  perfLabel: { color: "#555", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  perfValue: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" },
  perfSince: { color: "#555", fontSize: 11, marginTop: 2 },
  run: { background: "#111", border: "1px solid #222", borderRadius: 10, padding: "20px 24px", marginBottom: 16 },
  runHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12 },
  date: { fontWeight: 600, fontSize: 15 },
  meta: { color: "#555", fontSize: 12, marginTop: 2 },
  badges: { display: "flex", gap: 8, flexWrap: "wrap" as const },
  badge: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 6, padding: "3px 10px", fontSize: 12 },
  posRow: { display: "flex", gap: 10, flexWrap: "wrap" as const, marginBottom: 14 },
  pos: { background: "#0d1f0d", border: "1px solid #1a3a1a", borderRadius: 6, padding: "3px 10px", fontSize: 12, color: "#7dba7d" },
  tradesSection: { marginBottom: 14 },
  tradesLabel: { fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px", color: "#555", marginBottom: 6 },
  tradeRow: { display: "flex", gap: 8, flexWrap: "wrap" as const },
  tradeBuy: { background: "#0d2b0d", border: "1px solid #1f4a1f", borderRadius: 7, padding: "5px 12px", fontSize: 13, fontWeight: 600, color: "#6fcf6f", display: "flex", alignItems: "center", gap: 5 },
  tradeSell: { background: "#2b0d0d", border: "1px solid #4a1f1f", borderRadius: 7, padding: "5px 12px", fontSize: 13, fontWeight: 600, color: "#cf6f6f", display: "flex", alignItems: "center", gap: 5 },
  divider: { border: "none", borderTop: "1px solid #1e1e1e", margin: "14px 0" },
  summary: { color: "#bbb", fontSize: 13, whiteSpace: "pre-wrap" as const, lineHeight: 1.7, maxHeight: 320, overflowY: "auto" as const },
  chartCard: { background: "#111", border: "1px solid #222", borderRadius: 10, padding: "20px 24px", marginBottom: 28 },
  chartTitle: { fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.5px", color: "#555", marginBottom: 12 },
  chartLegend: { display: "flex", gap: 20, marginTop: 10 },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#888" },
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" },
  loginBox: { background: "#111", border: "1px solid #222", borderRadius: 12, padding: "36px 40px", width: "100%", maxWidth: 360 },
  loginTitle: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  loginSub: { color: "#666", fontSize: 13, marginBottom: 24 },
  input: { width: "100%", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: 7, padding: "10px 14px", color: "#e5e5e5", fontSize: 14, marginBottom: 12 },
  btn: { width: "100%", background: "#fff", color: "#000", border: "none", borderRadius: 7, padding: "10px 14px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
} as const;

export function isAuthed(key: string | null): boolean {
  return key === process.env.CRON_SECRET;
}

export function LoginScreen() {
  return (
    <div style={s.loginWrap}>
      <div style={s.loginBox}>
        <div style={s.loginTitle}>Robinhood Agent</div>
        <div style={s.loginSub}>Enter your dashboard key to continue</div>
        <form method="GET">
          <input style={s.input} name="key" type="password" placeholder="Dashboard key" autoFocus />
          <button style={s.btn} type="submit">View Dashboard</button>
        </form>
      </div>
    </div>
  );
}

// Shared dashboard body. `isPublic` renders the keyless public view: it hides the
// account number and adds a public tagline. Everything else (returns, $ values,
// positions, thesis) is shown in both — the page output contains no secrets.
export async function DashboardView({ isPublic = false }: { isPublic?: boolean }) {
  const allRuns = await getRuns(90);
  // Collapse same-day runs with the canonical merge. The OLD naive "latest
  // timestamp per date" dedup silently dropped the richer run's correct return
  // AND — on days with two FULL runs (e.g. the 7:30 rotation plus an 8am
  // stop-loss exit that also opened a new position) — kept a stale positions
  // snapshot. mergeRunsByDate keeps the run with the computed return, unions all
  // fills, and carries the latest non-empty positions. Already used by dedupeRuns
  // and covered by unit tests.
  const runs = mergeRunsByDate(allRuns);
  const latest = runs[0] ?? null;
  const inception = runs[runs.length - 1] ?? null;

  // For "current cash state" metrics (Cash Clearing), use the most-recent run by
  // timestamp — an intraday stop-loss run is newer than the merged daily run and holds
  // the up-to-date live unsettled-cash snapshot. (Performance/return metrics keep using
  // the merged `latest`, which carries the day's computed return.)
  // Newest run that actually has a portfolioAfter — a thin intraday run whose snapshot
  // parse failed is saved with portfolioAfter:null, and using it would zero out Cash
  // Clearing. Skip those; fall back to the merged latest if none qualify.
  const current = [...allRuns].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).find(r => r.portfolioAfter) ?? latest;

  // Use the run just before the first agent return as the perf baseline so
  // SPY return covers the same window as the agent cumulative return.
  const runsChronological = [...runs].reverse();
  const firstReturnIdx = runsChronological.findIndex(r => r.agenticDailyReturn != null);
  const perfBaseline = firstReturnIdx > 0
    ? runsChronological[firstReturnIdx - 1]
    : (firstReturnIdx === 0 ? runsChronological[0] : inception);

  const spyReturn = (() => {
    const ls = latest?.spyPrice;
    const bs = perfBaseline?.spyPrice;
    if (!ls || !bs) return null;
    return ((ls - bs) / bs) * 100;
  })();

  // Transfer-adjusted cumulative return from stored daily returns (null until enough data)
  const { points: returnSeries, since: seriesSince } = buildReturnSeries(runs);
  const latestSeries = returnSeries[returnSeries.length - 1];
  const mainCumReturn = latestSeries?.main != null ? latestSeries.main - 100 : null;

  // Top section reports the MAIN book (core S&P strategy) on its own — the influencer sleeve is a
  // different strategy shown separately below, so blending them into one "AI return" hid how the
  // core book actually tracks the market. Main and agentic share the same inception baseline, so
  // spyReturn already covers the main window; the alpha is main − SPY over that period.
  const mainAlpha = mainCumReturn != null && spyReturn != null ? mainCumReturn - spyReturn : null;
  const hasComparison = returnSeries.some(p => p.agentic != null);

  const latestInfluencer = returnSeries[returnSeries.length - 1]?.influencer;
  const influencerCumReturn = latestInfluencer != null ? latestInfluencer - 100 : null;
  // Influencer alpha must use SPY over the INFLUENCER window, not the AI-window spyReturn —
  // otherwise it compares mismatched periods. Match BOTH ends: start at the sleeve's baseline
  // and end on the last day the sleeve return actually moved (once fully exited the influencer
  // cumulative freezes there, so ending SPY at `latest` would skew the alpha).
  const influencerBaselineRun = runsChronological.find(r => r.date === seriesSince.influencer);
  const lastInfluencerReturnRun = [...runsChronological].reverse().find(r => r.influencerDailyReturn != null);
  const spyReturnInfluencerWindow = (() => {
    const ls = lastInfluencerReturnRun?.spyPrice;
    const bs = influencerBaselineRun?.spyPrice;
    if (!ls || !bs) return null;
    return ((ls - bs) / bs) * 100;
  })();
  const influencerAlpha = influencerCumReturn != null && spyReturnInfluencerWindow != null
    ? influencerCumReturn - spyReturnInfluencerWindow : null;
  const hasInfluencerData = returnSeries.some(p => p.influencer != null);

  // Current-state snapshot metrics read `current` (the latest self-consistent run a
  // route stored atomically), NOT the merged `latest` — a merged two-run day can carry
  // the morning run's stale cash/equity alongside reconciled positions. beta uses the
  // full series (it's historical, not a snapshot).
  const influencerPositions = current?.influencerPositions ?? [];

  // Split the account value into the two strategies. The influencer sleeve is exactly its held
  // positions' market value; the main book is everything else (core holdings + ALL cash, settled
  // and unsettled) — i.e. the remainder — so the two always sum to the account total and we avoid
  // any per-sleeve cash / T+1 accounting. main + influencer = total, by construction.
  const accountTotal = current?.portfolioAfter ? parseFloat(current.portfolioAfter.totalValue) : null;
  const influencerValue = influencerPositions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
  const mainBookValue = accountTotal != null ? accountTotal - influencerValue : null;
  const usd = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const cashPct = current ? computeCashPct(current) : null;
  const sectorBreakdown = current ? computeSectorBreakdown(current) : [];
  const beta = computeBeta(runs);
  const t1Settling = current ? computeT1Settling(current) : null;
  const concentration = current ? computeConcentration(current) : null;
  // Max drawdown over the same co-indexed window for both series
  const ddPoints = returnSeries.filter(p => p.agentic != null);
  const agentDrawdown = computeMaxDrawdown(ddPoints.map(p => p.agentic!) as number[]);
  const spyDrawdown = computeMaxDrawdown(ddPoints.filter(p => p.spy != null).map(p => p.spy!) as number[]);

  // "% of days the MAIN book beat SPY" — daily alpha win rate for the core strategy (not the
  // blended book). Isolates skill instead of measuring the market's own up-day frequency.
  const mainBeatRate = computeBeatRate(runs, r => r.mainDailyReturn);

  // Honest "is the active book beating just-holding-SPY, and for how long has it trailed?" verdict.
  const benchmarkVerdict = computeBenchmarkVerdict(runs);

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const returnColor = (v: number | null) => v == null ? "#888" : v >= 0 ? "#7dba7d" : "#e06c6c";

  return (
    <div style={s.page}>
      <style dangerouslySetInnerHTML={{ __html: TIP_CSS }} />
      <div style={s.header}>
        <div style={s.title}>Robinhood Agent</div>
        {isPublic && (
          <div style={{ ...s.subtitle, marginTop: 6, maxWidth: 620 }}>
            A real-money experiment: an AI agent (Claude) autonomously trades a Robinhood account every weekday and benchmarks itself against the S&P 500.
          </div>
        )}
        <div style={s.subtitle}>
          {isPublic ? "Autonomous AI trading agent" : "AI trading account ••••4256"}
          {current?.portfolioAfter && ` · $${parseFloat(current.portfolioAfter.totalValue).toFixed(0)} total`}
          {` · Trades daily at 7:30am PT`}
          {latest && ` · Last run ${latest.date}`}
        </div>
      </div>

      {runs.length >= 2 && (
        <div style={s.perfCard}>
          <div style={s.perfStat}>
            <Tip style={s.perfLabel} label="Main Book Return" def="The core S&P 500 momentum strategy on its own, since it started — the higher-risk YouTube-influencer sleeve is a separate strategy, tracked in its own card below." />
            <span style={{ ...s.perfValue, color: returnColor(mainCumReturn) }}>
              {mainCumReturn != null ? fmtPct(mainCumReturn) : "—"}
            </span>
            <span style={s.perfSince}>core S&P strategy · since {seriesSince.main ?? "—"}</span>
          </div>
          <div style={s.perfStat}>
            <Tip style={s.perfLabel} label="S&P 500 Return" def="SPY is the fund that tracks the S&P 500 — the standard stand-in for 'the U.S. stock market.'" />
            <span style={{ ...s.perfValue, color: returnColor(spyReturn) }}>
              {spyReturn != null ? fmtPct(spyReturn) : "—"}
            </span>
            <span style={s.perfSince}>the market, same period</span>
          </div>
          <div style={s.perfStat}>
            <Tip style={s.perfLabel} label="Main Book vs S&P 500" def="Alpha: the core strategy's return minus the S&P 500's over the same period. Positive = the core book is beating the market. A 'trailing N days' flag warns when the book has stayed behind buy-and-hold SPY for a sustained stretch — a nudge to reconsider whether active trading is earning its risk." />
            <span style={{ ...s.perfValue, color: returnColor(mainAlpha) }}>
              {mainAlpha != null ? fmtPct(mainAlpha) : "—"}
            </span>
            {benchmarkVerdict && benchmarkVerdict.daysTrailing > 0 ? (
              <span style={{ ...s.perfSince, color: benchmarkVerdict.sustained ? "#e8a04a" : "#888" }}>
                {benchmarkVerdict.sustained ? "⚠ " : ""}trailing SPY {benchmarkVerdict.daysTrailing} day{benchmarkVerdict.daysTrailing === 1 ? "" : "s"}
              </span>
            ) : (
              <span style={s.perfSince}>core book vs. the S&P 500 (alpha)</span>
            )}
          </div>
          {mainBookValue != null && (
            <div style={s.perfStat}>
              <Tip style={s.perfLabel} label="Main Book Value" def="Dollars in the core S&P strategy: its holdings plus all cash (settled and unsettled). It's the account total minus the influencer sleeve, so the two sleeves sum to the whole account." />
              <span style={{ ...s.perfValue, color: "#e5e5e5" }}>
                ${usd(mainBookValue)}
              </span>
              <span style={s.perfSince}>core holdings + cash{accountTotal != null ? ` · $${accountTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} total` : ""}</span>
            </div>
          )}
          {mainBeatRate != null && (
            <div style={s.perfStat}>
              <Tip style={s.perfLabel} label="Days Main Book Beat S&P" def="The share of trading days the core strategy's daily return was higher than the S&P 500's." />
              <span style={{ ...s.perfValue, color: returnColor(mainBeatRate.rate * 100 - 50) }}>
                {(mainBeatRate.rate * 100).toFixed(0)}%
              </span>
              <span style={s.perfSince}>of {mainBeatRate.n} trading days</span>
            </div>
          )}
        </div>
      )}

      {/* Influencer sub-portfolio card */}
      {(hasInfluencerData || influencerPositions.length > 0) && (
        <div style={{ ...s.perfCard, borderColor: "#2a1f0d" }}>
          <div style={{ ...s.perfStat }}>
            <Tip style={{ ...s.perfLabel, color: "#7a5a2a" }} label="📺 YouTube-Picks Return" def="A separate ~25% slice of the account that buys stocks talked up by YouTube finance creators — higher risk, higher reward." />
            <span style={{ ...s.perfValue, color: returnColor(influencerCumReturn) }}>
              {influencerCumReturn != null ? fmtPct(influencerCumReturn) : "—"}
            </span>
            <span style={s.perfSince}>the influencer slice · since {seriesSince.influencer ?? "—"}</span>
          </div>
          <div style={s.perfStat}>
            <Tip style={{ ...s.perfLabel, color: "#7a5a2a" }} label="vs. the Market" def="How much better (or worse) the YouTube-picks slice did than the S&P 500 over the same period." />
            <span style={{ ...s.perfValue, color: returnColor(influencerAlpha) }}>
              {influencerAlpha != null ? fmtPct(influencerAlpha) : "—"}
            </span>
            <span style={s.perfSince}>YouTube picks vs. S&P 500</span>
          </div>
          {influencerPositions.length > 0 && (
            <div style={s.perfStat}>
              <Tip style={{ ...s.perfLabel, color: "#7a5a2a" }} label="Influencer Value" def="Current market value of the YouTube-picks holdings. The rest of the account (core holdings + cash) sits in the main book." />
              <span style={{ ...s.perfValue, color: "#e5e5e5" }}>
                ${usd(influencerValue)}
              </span>
              <span style={s.perfSince}>{accountTotal ? `${(influencerValue / accountTotal * 100).toFixed(0)}% of the account` : "held positions"}</span>
            </div>
          )}
          {influencerPositions.length > 0 && (
            <div style={s.perfStat}>
              <span style={{ ...s.perfLabel, color: "#7a5a2a" }}>Holding Now</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#e8943a", marginTop: 4 }}>
                {influencerPositions.map(p => p.symbol).join(", ")}
              </span>
              <span style={s.perfSince}>YouTube-creator picks</span>
            </div>
          )}
        </div>
      )}

      {hasComparison && (
        <div style={s.chartCard}>
          <div style={s.chartTitle}>AI vs. the Market over time <span style={{ color: "#666", fontWeight: 400, fontSize: 12 }}>· each line starts at 100</span></div>
          <ReturnChart points={returnSeries} />
          <div style={s.chartLegend}>
            <div style={s.legendItem}>
              <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#7dba7d" strokeWidth="2" /></svg>
              Main book {mainCumReturn != null ? `(${fmtPct(mainCumReturn)})` : ""}
            </div>
            {hasInfluencerData && (
              <div style={s.legendItem}>
                <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#e8943a" strokeWidth="2" /></svg>
                YouTube picks {influencerCumReturn != null ? `(${fmtPct(influencerCumReturn)})` : ""}
              </div>
            )}
            <div style={s.legendItem}>
              <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#444" strokeWidth="2" /></svg>
              S&P 500 (the market)
            </div>
          </div>
          {runs.slice(0, 10).some(r => (r.agenticImpliedTransfer ?? 0) !== 0) && (
            <div style={{ marginTop: 12, fontSize: 11, color: "#555" }}>
              {runs.slice(0, 10).filter(r => Math.abs(r.agenticImpliedTransfer ?? 0) > 10).map((r, i) => (
                <div key={i}>⟳ {r.date}: deposit/withdrawal of ${(r.agenticImpliedTransfer!).toFixed(0)} detected (not counted as gain or loss)</div>
              ))}
            </div>
          )}
        </div>
      )}

      {latest && (cashPct != null || sectorBreakdown.length > 0 || beta) && (
        <div style={s.chartCard}>
          <div style={s.chartTitle}>How risky is it? — a look under the hood</div>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: sectorBreakdown.length > 0 ? 20 : 0 }}>
            <div style={{ ...s.perfStat, minWidth: 160 }}>
              <Tip style={s.perfLabel} label="Cash on Hand" def="Cash that's settled and ready to trade right now, as a % of the account. Does not include money from recent sales that hasn't cleared yet." />
              <span style={{ ...s.perfValue, color: cashPct != null && cashPct > 10 ? "#e8943a" : "#e5e5e5" }}>
                {cashPct != null ? `${cashPct.toFixed(1)}%` : "—"}
              </span>
              <span style={s.perfSince}>ready to trade now (idle if high)</span>
            </div>
            <div style={{ ...s.perfStat, minWidth: 185 }}>
              <Tip style={s.perfLabel} label="Cash Clearing" def="When the AI sells a stock, the cash takes one business day to clear before it can be reused (called 'T+1 settlement'). This is how much is waiting to clear." />
              <span style={{ ...s.perfValue, color: t1Settling && t1Settling.pct > 10 ? "#e8943a" : "#e5e5e5" }}>
                {t1Settling ? `$${t1Settling.amount.toFixed(0)}` : "$0"}
              </span>
              <span style={s.perfSince}>
                {t1Settling
                  ? `${t1Settling.pct.toFixed(0)}% of the account · frees up next business day`
                  : "no sale money waiting to clear"}
              </span>
            </div>
            <div style={{ ...s.perfStat, minWidth: 170 }}>
              <Tip style={s.perfLabel} label="Swings vs. Market" def="Beta: how much the account moves compared to the market. 1.0 = moves with the market; above 1 = bigger swings; below 1 = smaller swings." />
              <span style={{ ...s.perfValue, color: "#e5e5e5" }}>
                {beta ? `${beta.beta.toFixed(2)}×` : "—"}
              </span>
              <span style={s.perfSince}>
                {beta ? `${betaDescription(beta.beta)}${beta.n < 5 ? " · still early" : ""}` : "need a few more trading days"}
              </span>
            </div>
            <div style={{ ...s.perfStat, minWidth: 175 }}>
              <Tip style={s.perfLabel} label="Worst Drop" def="Max drawdown: the biggest drop from a high point to a low point over the period tracked. Lower is better." />
              <span style={{ ...s.perfValue, color: agentDrawdown != null && spyDrawdown != null && agentDrawdown > spyDrawdown ? "#e8943a" : "#e5e5e5" }}>
                {agentDrawdown != null ? `−${agentDrawdown.toFixed(2)}%` : "—"}
              </span>
              <span style={s.perfSince}>
                {spyDrawdown != null ? `biggest fall from a high · market −${spyDrawdown.toFixed(2)}%` : "biggest fall from a high point"}
              </span>
            </div>
            <div style={{ ...s.perfStat, minWidth: 175 }}>
              <Tip style={s.perfLabel} label="Biggest Bet" def="How much of the account sits in its single biggest stock. A high number means more risk if that one stock drops." />
              <span style={{ ...s.perfValue, color: concentration && concentration.largestPct > 25 ? "#e8943a" : "#e5e5e5" }}>
                {concentration ? `${concentration.largestPct.toFixed(0)}%` : "—"}
              </span>
              <span style={s.perfSince}>
                {concentration ? `in ${concentration.largestSymbol} · ${concentration.count} stocks held · top 3 = ${concentration.topThreePct.toFixed(0)}%` : "—"}
              </span>
            </div>
          </div>
          {sectorBreakdown.length > 0 && (
            <div>
              <div style={{ ...s.perfLabel, marginBottom: 10 }}><Tip label="Industry Mix" def="How the money is split across industries (technology, finance, healthcare, etc.)." /></div>
              {sectorBreakdown.map((sec) => (
                <div key={sec.etf} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 110, fontSize: 12, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sec.name}</span>
                  <div style={{ flex: 1, background: "#1a1a1a", borderRadius: 4, height: 14, overflow: "hidden" }}>
                    <div style={{ width: `${sec.pct}%`, background: sec.pct >= 50 ? "#e8943a" : "#7dba7d", height: "100%" }} />
                  </div>
                  <span style={{ width: 40, textAlign: "right", fontSize: 12, color: "#888" }}>{sec.pct.toFixed(0)}%</span>
                </div>
              ))}
              <div style={{ ...s.perfSince, marginTop: 8 }}>a lot in one industry means it's betting on that industry, not picking individual winners</div>
            </div>
          )}
        </div>
      )}

      {runs.slice(0, 30).length === 0 ? (
        <div style={s.emptyState}>No runs yet. The agent fires weekdays at 7:30am PT.</div>
      ) : (
        runs.slice(0, 30).map((run, i) => {
          const pv = run.portfolioAfter;
          return (
            <div key={i} style={s.run}>
              <div style={s.runHeader}>
                <div>
                  <div style={s.date}>{run.date}</div>
                  <div style={s.meta}>
                    {new Date(run.timestamp).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })} PT ·{" "}
                    {run.market.stocksLoaded} stocks · {run.market.headlinesLoaded} headlines
                  </div>
                </div>
                <div style={s.badges}>
                  {pv && (
                    <>
                      <span style={s.badge}>Portfolio ${parseFloat(pv.totalValue).toFixed(2)}</span>
                      <span style={s.badge}>Cash ${parseFloat(pv.cash || "0").toFixed(2)}</span>
                    </>
                  )}
                  {pv && (run.trades ?? []).length === 0 && (
                    <span style={{ ...s.badge, color: "#888", borderColor: "#2a2a2a" }}>HOLD</span>
                  )}
                  {run.spyPrice && (
                    <span style={s.badge}>SPY ${run.spyPrice.toFixed(2)}</span>
                  )}
                </div>
              </div>

              {(run.trades ?? []).length > 0 && (
                <div style={s.tradesSection}>
                  <div style={s.tradesLabel}>Trades executed</div>
                  <div style={s.tradeRow}>
                    {(run.trades ?? []).map((t, j) => (
                      <span key={j} style={t.side === "buy" ? s.tradeBuy : s.tradeSell}>
                        <span>{t.side === "buy" ? "▲ BUY" : "▼ SELL"}</span>
                        <span>{t.symbol} ×{parseFloat(t.quantity).toFixed(0)} @ ${parseFloat(t.avgPrice || "0").toFixed(2)}</span>
                        {t.strategy === "influencer" && <span style={{ fontSize: 10, opacity: 0.7 }}>📺</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {run.positions.length > 0 && (
                <div>
                  <div style={{ ...s.tradesLabel, marginBottom: 6 }}>Holdings after</div>
                  <div style={{ ...s.posRow, marginBottom: 14 }}>
                    {run.positions.map((p) => (
                      <span key={p.symbol} style={s.pos}>
                        {p.symbol} × {parseFloat(p.quantity).toFixed(0)} @ ${parseFloat(p.avgCost).toFixed(2)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <hr style={s.divider} />
              <div style={s.summary}><MarkdownSummary text={run.summary} /></div>
            </div>
          );
        })
      )}
    </div>
  );
}
