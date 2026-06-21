import React from "react";
import { getRuns, type TradeRun } from "@/lib/run-store";
import { computeCashPct, computeSectorBreakdown, computeBeta, betaDescription } from "@/lib/risk-metrics";

// ─── Return series + chart ────────────────────────────────────────────────────

interface ReturnPoint {
  date: string;
  agentic: number | null;
  spy: number | null;
  influencer: number | null;
}

function buildReturnSeries(runs: TradeRun[]): ReturnPoint[] {
  const chronological = [...runs].reverse();
  let agentIdx = 100;
  let influencerIdx = 100;
  let hasReturn = false;
  let hasInfluencer = false;
  const points: ReturnPoint[] = [];

  // Anchor SPY to the run just before the first agent return so both series
  // share the same start point and the comparison is fair.
  const firstReturnIdx = chronological.findIndex(r => r.agenticDailyReturn != null);
  const spyBase: number | null = firstReturnIdx > 0
    ? (chronological[firstReturnIdx - 1].spyPrice ?? null)
    : firstReturnIdx === 0
      ? (chronological[0].spyPrice ?? null)
      : null;

  for (const run of chronological) {
    if (run.agenticDailyReturn != null) {
      agentIdx *= (1 + run.agenticDailyReturn);
      hasReturn = true;
    }
    if (run.influencerDailyReturn != null) {
      influencerIdx *= (1 + run.influencerDailyReturn);
      hasInfluencer = true;
    }
    const spy = run.spyPrice && spyBase != null
      ? (run.spyPrice / spyBase) * 100
      : null;
    points.push({
      date: run.date,
      agentic: hasReturn ? agentIdx : null,
      spy,
      influencer: hasInfluencer ? influencerIdx : null,
    });
  }
  return points;
}

function ReturnChart({ points }: { points: ReturnPoint[] }) {
  const valid = points.filter(p => p.agentic != null);
  if (valid.length < 2) return null;

  const W = 760, H = 140, PL = 44, PR = 12, PT = 8, PB = 28;
  const cw = W - PL - PR, ch = H - PT - PB;

  const allVals = valid.flatMap(p => [p.agentic, p.spy, p.influencer].filter(v => v != null) as number[]);
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
      {polyline(p => p.agentic, "#7dba7d")}
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

function isAuthed(key: string | null): boolean {
  return key === process.env.CRON_SECRET;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const params = await searchParams;
  const key = params.key ?? null;

  if (!isAuthed(key)) {
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

  const allRuns = await getRuns(90);
  // Deduplicate same-day runs — keep only the latest timestamp per date
  const seen = new Map<string, typeof allRuns[0]>();
  for (const run of allRuns) {
    const ex = seen.get(run.date);
    if (!ex || run.timestamp > ex.timestamp) seen.set(run.date, run);
  }
  const runs = [...seen.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const latest = runs[0] ?? null;
  const inception = runs[runs.length - 1] ?? null;

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
  const returnSeries = buildReturnSeries(runs);
  const latestSeries = returnSeries[returnSeries.length - 1];
  const agenticCumReturn = latestSeries?.agentic != null ? latestSeries.agentic - 100 : null;

  const agentReturn = agenticCumReturn;
  const alpha = agentReturn != null && spyReturn != null ? agentReturn - spyReturn : null;
  const hasComparison = returnSeries.some(p => p.agentic != null);

  const latestInfluencer = returnSeries[returnSeries.length - 1]?.influencer;
  const influencerCumReturn = latestInfluencer != null ? latestInfluencer - 100 : null;
  const influencerAlpha = influencerCumReturn != null && spyReturn != null ? influencerCumReturn - spyReturn : null;
  const hasInfluencerData = returnSeries.some(p => p.influencer != null);

  // Influencer positions in latest run
  const influencerPositions = latest?.influencerPositions ?? [];

  // Risk & attribution — why the agent is behind, not just that it is
  const cashPct = latest ? computeCashPct(latest) : null;
  const sectorBreakdown = latest ? computeSectorBreakdown(latest) : [];
  const beta = computeBeta(runs);

  const runsWithReturn = runs.filter(r => r.agenticDailyReturn != null);
  const winRate = runsWithReturn.length >= 3
    ? runsWithReturn.filter(r => r.agenticDailyReturn! > 0).length / runsWithReturn.length
    : null;

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const returnColor = (v: number | null) => v == null ? "#888" : v >= 0 ? "#7dba7d" : "#e06c6c";

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={s.title}>Robinhood Agent</div>
        <div style={s.subtitle}>
          Agentic account ••••4256
          {latest?.portfolioAfter && ` · $${parseFloat(latest.portfolioAfter.totalValue).toFixed(0)} portfolio`}
          {` · Daily 7:30am PT`}
          {latest && ` · Last run ${latest.date}`}
        </div>
      </div>

      {runs.length >= 2 && (
        <div style={s.perfCard}>
          <div style={s.perfStat}>
            <span style={s.perfLabel}>Agent Return</span>
            <span style={{ ...s.perfValue, color: returnColor(agentReturn) }}>
              {agentReturn != null ? fmtPct(agentReturn) : "—"}
            </span>
            <span style={s.perfSince}>since {perfBaseline?.date ?? inception!.date}</span>
          </div>
          <div style={s.perfStat}>
            <span style={s.perfLabel}>SPY Return</span>
            <span style={{ ...s.perfValue, color: returnColor(spyReturn) }}>
              {spyReturn != null ? fmtPct(spyReturn) : "—"}
            </span>
            <span style={s.perfSince}>same period</span>
          </div>
          <div style={s.perfStat}>
            <span style={s.perfLabel}>Alpha</span>
            <span style={{ ...s.perfValue, color: returnColor(alpha) }}>
              {alpha != null ? fmtPct(alpha) : "—"}
            </span>
            <span style={s.perfSince}>agent vs SPY</span>
          </div>
          {latest?.portfolioAfter && (
            <div style={s.perfStat}>
              <span style={s.perfLabel}>Agentic Value</span>
              <span style={{ ...s.perfValue, color: "#e5e5e5" }}>
                ${parseFloat(latest.portfolioAfter.totalValue).toFixed(2)}
              </span>
              <span style={s.perfSince}>{runs.length} runs tracked</span>
            </div>
          )}
          {winRate != null && (
            <div style={s.perfStat}>
              <span style={s.perfLabel}>Win Rate</span>
              <span style={{ ...s.perfValue, color: returnColor(winRate * 100 - 50) }}>
                {(winRate * 100).toFixed(0)}%
              </span>
              <span style={s.perfSince}>{runsWithReturn.length} trading days</span>
            </div>
          )}
        </div>
      )}

      {/* Influencer sub-portfolio card */}
      {(hasInfluencerData || influencerPositions.length > 0) && (
        <div style={{ ...s.perfCard, borderColor: "#2a1f0d" }}>
          <div style={{ ...s.perfStat }}>
            <span style={{ ...s.perfLabel, color: "#7a5a2a" }}>📺 Influencer Return</span>
            <span style={{ ...s.perfValue, color: returnColor(influencerCumReturn) }}>
              {influencerCumReturn != null ? fmtPct(influencerCumReturn) : "—"}
            </span>
            <span style={s.perfSince}>YouTube picks sub-portfolio</span>
          </div>
          <div style={s.perfStat}>
            <span style={{ ...s.perfLabel, color: "#7a5a2a" }}>vs SPY</span>
            <span style={{ ...s.perfValue, color: returnColor(influencerAlpha) }}>
              {influencerAlpha != null ? fmtPct(influencerAlpha) : "—"}
            </span>
            <span style={s.perfSince}>influencer alpha</span>
          </div>
          {influencerPositions.length > 0 && (
            <div style={s.perfStat}>
              <span style={{ ...s.perfLabel, color: "#7a5a2a" }}>Positions</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#e8943a", marginTop: 4 }}>
                {influencerPositions.map(p => p.symbol).join(", ")}
              </span>
              <span style={s.perfSince}>~25% of budget</span>
            </div>
          )}
        </div>
      )}

      {hasComparison && (
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Performance Comparison (indexed to 100)</div>
          <ReturnChart points={returnSeries} />
          <div style={s.chartLegend}>
            <div style={s.legendItem}>
              <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#7dba7d" strokeWidth="2" /></svg>
              Agentic {agenticCumReturn != null ? `(${fmtPct(agenticCumReturn)})` : ""}
            </div>
            {hasInfluencerData && (
              <div style={s.legendItem}>
                <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#e8943a" strokeWidth="2" /></svg>
                Influencer {influencerCumReturn != null ? `(${fmtPct(influencerCumReturn)})` : ""}
              </div>
            )}
            <div style={s.legendItem}>
              <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="#444" strokeWidth="2" /></svg>
              SPY
            </div>
          </div>
          {runs.slice(0, 10).some(r => (r.agenticImpliedTransfer ?? 0) !== 0) && (
            <div style={{ marginTop: 12, fontSize: 11, color: "#555" }}>
              {runs.slice(0, 10).filter(r => Math.abs(r.agenticImpliedTransfer ?? 0) > 10).map((r, i) => (
                <div key={i}>⟳ {r.date}: agentic transfer detected ${(r.agenticImpliedTransfer!).toFixed(0)} (excluded from return)</div>
              ))}
            </div>
          )}
        </div>
      )}

      {latest && (cashPct != null || sectorBreakdown.length > 0 || beta) && (
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Risk & Attribution — why, not just whether</div>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: sectorBreakdown.length > 0 ? 20 : 0 }}>
            <div style={{ ...s.perfStat, minWidth: 150 }}>
              <span style={s.perfLabel}>Cash (uninvested)</span>
              <span style={{ ...s.perfValue, color: cashPct != null && cashPct > 10 ? "#e8943a" : "#e5e5e5" }}>
                {cashPct != null ? `${cashPct.toFixed(1)}%` : "—"}
              </span>
              <span style={s.perfSince}>idle cash drags vs SPY in up weeks</span>
            </div>
            <div style={{ ...s.perfStat, minWidth: 170 }}>
              <span style={s.perfLabel}>Beta vs SPY</span>
              <span style={{ ...s.perfValue, color: "#e5e5e5" }}>
                {beta ? beta.beta.toFixed(2) : "—"}
              </span>
              <span style={s.perfSince}>
                {beta ? `${betaDescription(beta.beta)} · n=${beta.n}${beta.n < 5 ? " (early)" : ""}` : "need a few more trading days"}
              </span>
            </div>
          </div>
          {sectorBreakdown.length > 0 && (
            <div>
              <div style={{ ...s.perfLabel, marginBottom: 10 }}>Sector exposure</div>
              {sectorBreakdown.map((sec) => (
                <div key={sec.etf} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 110, fontSize: 12, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sec.name}</span>
                  <div style={{ flex: 1, background: "#1a1a1a", borderRadius: 4, height: 14, overflow: "hidden" }}>
                    <div style={{ width: `${sec.pct}%`, background: sec.pct >= 50 ? "#e8943a" : "#7dba7d", height: "100%" }} />
                  </div>
                  <span style={{ width: 40, textAlign: "right", fontSize: 12, color: "#888" }}>{sec.pct.toFixed(0)}%</span>
                </div>
              ))}
              <div style={{ ...s.perfSince, marginTop: 8 }}>heavy weight in one sector = a bet on that sector, not stock-picking</div>
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
