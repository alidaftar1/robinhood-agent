import { requireCronAuth } from "@/lib/auth";
import { buildDashboardLoginUrl } from "@/lib/dashboard-auth";
import { createAnthropic } from "@/lib/anthropic";
import { getRuns, hasAutopilotSentToday, markAutopilotSent, storeAutopilotConcerns, getStoredAutopilotConcerns } from "@/lib/run-store";
import { isMarketHoliday } from "@/lib/holidays";
import { reviewRun, type ReviewConcern } from "@/lib/autopilot-review";
import { reconcileDashboard, type ReconcileFinding } from "@/lib/dashboard-reconcile";
import { computeAttribution, type ChannelStats } from "@/lib/influencer-ledger";
import { computeSignalAttribution, type SignalStat } from "@/lib/signal-ledger";
import { getInfluencerSignals } from "@/lib/influencer-signals";
import { logReviewResult } from "@/lib/braintrust-trace";
import { sendAlert } from "@/lib/alert";

interface VerifyResult {
  status: string;
  discrepancies: string[];
  diff: {
    cashDiff: number | null;
    valueDiff: number | null;
    positionIssues: Array<{ type: string; symbol: string }>;
    uncapturedOrders: unknown[];
  };
  mcpAvailable: { balance: boolean; positions: boolean; orders: boolean };
}

// verify (up to 60s) + the skeptical-reviewer Sonnet pass (up to 45s) run
// sequentially, plus several debug self-fetches — give the function headroom so
// the reviewer can't push the whole autopilot over the limit (Pro allows it).
export const maxDuration = 200;

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

async function sendEmail(subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Robinhood Agent <alerts@agent.dencredible.com>",
      to: [process.env.ALERT_EMAIL ?? ""],
      subject,
      html,
    }),
  });
  return res.ok;
}

// Fire the GitHub Actions cloud autopilot NOW instead of waiting for its own
// schedule. GitHub delays cron-triggered runs by up to ~1.5h; triggering it here
// — right after today's report email goes out — makes the code-fixer run as soon
// as the data is ready (~8:01am PT). The 8:45am workflow cron stays as a fallback.
// Non-fatal: a dispatch failure never breaks the autopilot response. Retries on TRANSIENT errors
// (5xx / network) — GitHub's dispatch endpoint occasionally 503s — so a brief GitHub blip doesn't
// silently skip the cloud autopilot for the day. A 4xx (esp. 401/403) is a real token/perms problem
// and is NOT retried. Returns the final HTTP status so the caller can tell transient from token.
async function dispatchCloudAgent(): Promise<{ ok: boolean; detail: string; status: number }> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return { ok: false, detail: "no GH_DISPATCH_TOKEN", status: 0 };
  let status = -1, detail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        "https://api.github.com/repos/alidaftar1/robinhood-agent/actions/workflows/autopilot.yml/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "robinhood-agent-autopilot",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      status = res.status;
      if (res.status === 204) return { ok: true, detail: "HTTP 204", status: 204 }; // dispatched
      if (res.status < 500) return { ok: false, detail: `HTTP ${res.status}`, status: res.status }; // client/token error — don't retry
      detail = `HTTP ${res.status}`; // 5xx — transient, retry
    } catch (e) {
      status = -1;
      detail = e instanceof Error ? e.message : String(e); // network — transient, retry
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return { ok: false, detail: `${detail} (after 3 tries)`, status };
}

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = todayPT();

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
  }

  // Idempotency guard FIRST — the cron can retry, and everything below (auto-repair, live verify, the
  // Sonnet skeptical-reviewer + its Braintrust trace, reconcile) is expensive. If today's report
  // already went out, short-circuit before doing any of it. The "sent" mark is only set AFTER a
  // successful email, so a retry following a genuine pre-email failure still falls through and runs
  // fully. force=true bypasses the guard for a deliberate manual re-run.
  const force = new URL(request.url).searchParams.get("force") === "true";
  if (!force && await hasAutopilotSentToday(today)) {
    // Return the STORED concerns from this morning's run — the cloud fixer calls this endpoint after
    // the email already sent, and it needs the reviewConcerns/issues as its work list (not a bare skip).
    const stored = await getStoredAutopilotConcerns(today);
    return Response.json({ skipped: true, reason: "autopilot already sent today", date: today, ...(stored ?? {}) });
  }

  // Use the stable public alias for internal self-fetches. Under the Vercel cron,
  // request.url is the internal deployment URL and self-fetches to it fail (which
  // silently broke auto-repair + live verify). APP_URL/alias resolves correctly.
  const host = process.env.APP_URL || "https://robinhood-agent.vercel.app";
  const secret = process.env.CRON_SECRET ?? "";

  async function callDebug(param: string): Promise<Record<string, string> | null> {
    try {
      const res = await fetch(`${host}/api/debug?${param}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) return null;
      return res.json() as Promise<Record<string, string>>;
    } catch {
      return null;
    }
  }

  let runs = await getRuns(30);
  let todayRun = runs.find((r) => r.date === today) ?? null;

  const issues: string[] = [];
  const autoFixed: string[] = [];
  let selfHealed = false;

  // ─── Self-heal: trigger trade cron if today's run is missing ─────────────────

  if (!todayRun) {
    let triggerOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, 15_000));
      try {
        const tradeRes = await fetch(`${host}/api/trade`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (tradeRes.ok) { triggerOk = true; break; }
        if (attempt === 2)
          issues.push(`Trade cron missing — auto-trigger failed after 2 attempts (${tradeRes.status}).`);
      } catch {
        if (attempt === 2)
          issues.push("Trade cron missing — auto-trigger threw an error after 2 attempts.");
      }
    }
    if (triggerOk) {
      selfHealed = true;
      runs = await getRuns(30);
      todayRun = runs.find((r) => r.date === today) ?? null;
    }
    if (!todayRun) {
      issues.push("Trade cron missing and auto-trigger failed — manual intervention needed.");
    }
  }

  // ─── Auto-repair phase ────────────────────────────────────────────────────────
  // Fix issues mechanically before deciding what to alert on.

  if (todayRun) {
    // Fix 1: Positions that disappeared without a recorded sell.
    // Happens when the sell session times out after orders already landed on Robinhood.
    const prevRun = runs.find(r => r.date < today);
    if (prevRun?.positions?.length) {
      const todaySyms = new Set(todayRun.positions.map(p => p.symbol));
      // Treat existing inferred sells as unconfirmed — patchTrades will re-derive them correctly
      const confirmedSells = new Set(
        (todayRun.trades ?? []).filter(t => t.side === "sell" && t.state !== "inferred").map(t => t.symbol)
      );
      const orphaned = prevRun.positions.filter(p => !todaySyms.has(p.symbol) && !confirmedSells.has(p.symbol));
      if (orphaned.length > 0) {
        const result = await callDebug("patchTrades=1");
        const msg = result?.patchTrades ?? "";
        if (msg && !msg.startsWith("error") && !msg.includes("no missing")) {
          autoFixed.push(`Inferred missing sells: ${msg}`);
          runs = await getRuns(30);
          todayRun = runs.find(r => r.date === today) ?? todayRun;
        } else {
          issues.push(
            `Positions disappeared without sell records: ${orphaned.map(p => p.symbol).join(", ")}. Auto-patch: ${msg || "failed"}.`,
          );
        }
      }
    }

    // Fix 2: Today's return is null but all data needed to compute it is present.
    if (todayRun.agenticDailyReturn == null && todayRun.portfolioAfter) {
      const prevRun2 = runs.find(r => r.date < today);
      if (prevRun2?.portfolioAfter) {
        const result = await callDebug(`patchDate=${today}`);
        const msg = result?.patchDate ?? "";
        if (msg && !msg.startsWith("error") && !msg.includes("not found")) {
          autoFixed.push(`Computed missing return: ${msg}`);
          runs = await getRuns(30);
          todayRun = runs.find(r => r.date === today) ?? todayRun;
        }
      }
    }
  }

  // Fix 3: Bogus 0% return on the oldest run (first-ever run had same-day baseline).
  {
    const chronological = [...runs].reverse();
    const oldest = chronological[0];
    if (oldest && oldest.agenticDailyReturn === 0) {
      const hasPrior = runs.some(r => r.date < oldest.date);
      if (!hasPrior) {
        const result = await callDebug(`clearReturnForDate=${oldest.date}`);
        const msg = result?.clearReturnForDate ?? "";
        if (msg && !msg.startsWith("error")) {
          autoFixed.push(`Cleared bogus 0% inception return on ${oldest.date}`);
        }
      }
    }
  }

  // ─── Live Robinhood verification ─────────────────────────────────────────────
  // /api/verify runs Haiku+MCP server-side — compares live state to stored run.

  let verifyResult: VerifyResult | null = null;

  try {
    const verifyRes = await fetch(`${host}/api/verify`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (verifyRes.ok) {
      verifyResult = await verifyRes.json() as VerifyResult;
    }
  } catch {
    // Verification failed — non-fatal, note in email
  }

  if (verifyResult) {
    if (verifyResult.status === "discrepancy") {
      // Auto-fix: if position issues include missing-sell, run patchTrades
      const posIssues = verifyResult.diff?.positionIssues ?? [];
      const hasMissingSell = posIssues.some((p: any) => p.type === "missing_from_live_no_sell_record");
      if (hasMissingSell) {
        const result = await callDebug("patchTrades=1");
        const msg = result?.patchTrades ?? "";
        if (msg && !msg.startsWith("error")) {
          autoFixed.push(`Live verify found missing sells — re-patched: ${msg}`);
          runs = await getRuns(30);
          todayRun = runs.find(r => r.date === today) ?? todayRun;
        }
      }
      // Surface remaining discrepancies as issues
      const remaining = verifyResult.discrepancies.filter((d: string) => {
        if (hasMissingSell && d.includes("no sell record")) return false;
        return true;
      });
      for (const d of remaining) {
        issues.push(`Live verify: ${d}`);
      }
    } else if (verifyResult.status === "partial") {
      const missing = Object.entries(verifyResult.mcpAvailable ?? {})
        .filter(([, v]) => !v).map(([k]) => k).join(", ");
      autoFixed.push(`Live verify partial (MCP timeout on: ${missing || "unknown"}) — comparison incomplete.`);
    }
  } else {
    autoFixed.push("Live verify skipped — /api/verify unavailable.");
  }

  // ─── Derive display data from (possibly repaired) run ────────────────────────

  const trades = todayRun?.trades ?? [];
  const buyingPower = todayRun?.portfolioAfter?.cash ?? null;
  const totalValue = todayRun?.portfolioAfter?.totalValue ?? null;
  const positions = todayRun?.positions ?? [];
  const agenticReturn = todayRun?.agenticDailyReturn;
  const personalReturn = todayRun?.personalDailyReturn;
  const impliedTransfer = todayRun?.agenticImpliedTransfer;

  // ─── Validation phase (post-repair) ──────────────────────────────────────────

  if (trades.length === 0 && buyingPower && parseFloat(buyingPower) > 50) {
    issues.push(
      `No trades executed but buying power is $${parseFloat(buyingPower).toFixed(2)} — possible analysis issue.`,
    );
  }

  if (agenticReturn != null && Math.abs(agenticReturn) > 0.30) {
    issues.push(
      `Extreme return (${(agenticReturn * 100).toFixed(1)}%) — likely a data error. Check implied transfer and sell records.`,
    );
  }

  if (impliedTransfer != null && Math.abs(impliedTransfer) > 300) {
    const direction = impliedTransfer > 0 ? "deposit" : "withdrawal";
    autoFixed.push(
      `Detected large ${direction} (~$${Math.abs(impliedTransfer).toFixed(0)}) — return is transfer-adjusted.`,
    );
  }

  // Intent-vs-execution: the agent DECIDED to trade something but it didn't happen.
  // Catches a silently dropped/rejected order that data-consistency checks miss —
  // the BAX case on the SELL side, the GPN case on the BUY side. Flag only; the next
  // run re-attempts (sells auto-retry in the pipeline; buys retry + shrink-to-fit).
  if (todayRun?.summary) {
    const m = todayRun.summary.match(/TRADE_DECISION:(\{.*\})/);
    if (m) {
      try {
        const decided = JSON.parse(m[1]) as { sells?: Array<{ symbol: string }>; buys?: Array<{ symbol: string }> };
        const heldSyms = new Set(todayRun.positions.map((p) => p.symbol));
        const boughtSyms = new Set((todayRun.trades ?? []).filter((t) => t.side === "buy").map((t) => t.symbol));
        const notSold = (decided.sells ?? []).map((s) => String(s.symbol)).filter((sym) => heldSyms.has(sym));
        if (notSold.length > 0) {
          issues.push(
            `Decided to sell ${notSold.join(", ")} but still held — sell order(s) dropped. Next run should re-attempt; place manually if it persists.`,
          );
        }
        const notBought = (decided.buys ?? []).map((b) => String(b.symbol)).filter((sym) => !boughtSyms.has(sym));
        if (notBought.length > 0) {
          issues.push(
            `Decided to buy ${notBought.join(", ")} but no confirmed buy — likely insufficient buying power (sells settle T+1) or a dropped order. Buy-sizing + retry should limit this; flag if it persists.`,
          );
        }
      } catch { /* unparseable decision line — skip */ }
    }
  }

  // ─── Skeptical-reviewer pass ───────────────────────────────────────────────
  // The deterministic checks above verify the END STATE. This Sonnet pass forms a
  // JUDGMENT on the (recovered) run — falling-knife buys, derived metrics that
  // don't add up, silent self-heals, sector drift — reading a registry of things
  // the owner has caught before. Non-fatal: a failure just notes itself.

  let reviewConcerns: ReviewConcern[] = [];
  if (todayRun) {
    const anthropic = createAnthropic();
    // Hand the reviewer verify's reconciliation so it doesn't re-flag (or hallucinate)
    // cash/position/composition mismatches the deterministic layer already confirmed.
    const verifyContext = verifyResult
      ? {
          status: verifyResult.status,
          cashDiff: verifyResult.diff?.cashDiff ?? null,
          valueDiff: verifyResult.diff?.valueDiff ?? null,
          positionIssues: (verifyResult.diff?.positionIssues ?? []).length,
          uncapturedOrders: (verifyResult.diff?.uncapturedOrders ?? []).length,
        }
      : null;
    const review = await reviewRun(anthropic, todayRun, runs, verifyContext);
    reviewConcerns = review.concerns;
    if (review.error) {
      autoFixed.push(`Skeptical-reviewer pass could not run (${review.error}).`);
    }
    // Surface the reviewer's verdict + scores in Braintrust (fail-safe, never blocks the report).
    await logReviewResult({ run: todayRun, result: review }).catch(() => {});
  }
  // high/medium concerns are actionable → they flip the status; low are FYI only.
  const seriousConcerns = reviewConcerns.filter((c) => c.severity !== "low");

  // Deterministic audit of the dashboard's derived numbers — the presentation layer no other
  // reviewer checks (sleeve-return artifacts, stale sleeve membership, gaps, the influencer squat).
  // Wrapped so a bad record can never break the daily report.
  let reconcileFindings: ReconcileFinding[] = [];
  try { reconcileFindings = reconcileDashboard(runs); }
  catch (e) { autoFixed.push(`Dashboard reconciliation could not run (${e}).`); }
  const seriousReconcile = reconcileFindings.filter((f) => f.severity !== "low");

  // Influencer-pick attribution: which YouTubers' picks are actually working. Read-only,
  // fail-safe (an observability aid — must never break the report). Meaningful only once
  // picks have some age; day-0 picks read ~0% by construction.
  let ledgerChannels: ChannelStats[] = [];
  try { ({ channels: ledgerChannels } = await computeAttribution(today)); }
  catch { /* ledger is best-effort; skip the section if it can't compute */ }
  const agedChannels = ledgerChannels.filter((c) => c.avgReturnPct !== 0 || c.hitRatePct !== 0);

  // Signal-attribution ledger: which entry signals (★INS, ⚡NEWS, ↓FIRM, earnings record, …) have
  // predicted, from our own buys. Best-effort; empty until buys accumulate.
  let signalStats: SignalStat[] = [];
  let signalBuysLogged = 0;
  try { const a = await computeSignalAttribution(today); signalStats = a.signals; signalBuysLogged = a.picks.length; }
  catch { /* best-effort */ }

  // This week's raw influencer signals (buys / avoids / insights) from the 6am cache refresh —
  // informational visibility into what the creators are actually saying. Fail-safe.
  const influencerCache = await getInfluencerSignals().catch(() => null);
  const buyScores = influencerCache?.tickerCounts ?? {};
  const avoidScores = influencerCache?.avoidCounts ?? {};
  const topBuys = Object.entries(buyScores)
    .sort(([, a], [, b]) => b - a).slice(0, 8);
  // A ticker can be BOTH bought and avoided across DIFFERENT creators (legit disagreement — the
  // per-video extractor already bars a single video from listing it in both). Show it in Avoid ONLY
  // when the bearish signal is NET dominant (avoid count > buy score) — otherwise a strong buy with
  // one lone dissenter (MU 10-buy/1-avoid) reads as a contradictory "buy AND avoid".
  const topAvoids = Object.entries(avoidScores)
    .filter(([t, a]) => a > (buyScores[t] ?? 0))
    .sort(([, a], [, b]) => b - a).slice(0, 6);
  const insights = (influencerCache?.signals ?? [])
    .filter((s) => s.insight && s.insight.length > 0)
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
    .slice(0, 5)
    .map((s) => ({ channel: s.channelName, text: s.insight as string }));
  const hasInfluencerDigest = topBuys.length > 0 || topAvoids.length > 0 || insights.length > 0;
  // When the digest is empty, say WHY — a silently-omitted section can't distinguish "creators said
  // nothing actionable" from "the transcript pipeline is down/quota-exhausted" (they both render as
  // nothing). Coverage is the tell: 0 candidate videos = upstream YouTube fetch problem; LOW coverage
  // (transcripts on < half the videos — normally ~all, since Supadata auto-Whispers captionless ones)
  // = the transcript source is down or over quota, whether it fails from the start or trips mid-run.
  const cov = influencerCache?.transcriptCoverage;
  const influencerEmptyReason = !influencerCache
    ? "the weekly cache is unavailable — the 6am refresh may have failed"
    : cov && cov.videos === 0
      ? "no candidate videos were found this week — verify the upstream YouTube fetch isn't failing"
      : cov && cov.withTranscript < cov.videos / 2
        ? `low transcript coverage (${cov.withTranscript}/${cov.videos} videos) — the transcript source (Supadata) looks down or over its plan quota, so the sleeve ran mostly blind on titles only`
        : "creators named no qualifying picks this week — an empty sleeve is a valid outcome";

  // ─── Email ────────────────────────────────────────────────────────────────────

  const needsAttention = issues.length > 0 || seriousConcerns.length > 0 || seriousReconcile.length > 0;
  const statusLabel = needsAttention ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY";
  const statusColor = needsAttention ? "#f59e0b" : "#10b981";

  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");

  const fmt = (r: number | null | undefined) =>
    r != null ? `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%` : "—";

  const row = (label: string, value: string, bg = "transparent") =>
    `<tr style="background:${bg}">
      <td style="padding:5px 10px;color:#6b7280;white-space:nowrap">${label}</td>
      <td style="padding:5px 10px">${value}</td>
    </tr>`;

  const dashboardUrl = await buildDashboardLoginUrl(host);

  const html = `
<div style="font-family:monospace;max-width:600px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 4px">Robinhood Agent — ${today} Report</h2>
  <p style="color:${statusColor};font-size:18px;font-weight:bold;margin:8px 0">${statusLabel}</p>
  ${selfHealed ? `<p style="color:#6b7280;font-size:13px;margin:4px 0">⚡ Trade cron was missing — auto-triggered and recovered.</p>` : ""}
  <hr style="border:1px solid #e5e7eb;margin:16px 0"/>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    ${row("Portfolio value", totalValue ? `$${parseFloat(totalValue).toFixed(2)}` : "—")}
    ${row("Buying power", buyingPower ? `$${parseFloat(buyingPower).toFixed(2)}` : "—", "#f9fafb")}
    ${row("Agentic return", fmt(agenticReturn))}
    ${row("Personal return", fmt(personalReturn), "#f9fafb")}
    ${row("Buys", buys.length > 0 ? buys.map((t) => `${t.symbol} ×${t.quantity} @$${t.avgPrice}`).join(", ") : "none")}
    ${row("Sells", sells.length > 0 ? sells.map((t) => `${t.symbol} ×${t.quantity} @$${t.avgPrice}${t.state === "inferred" ? " (inferred)" : ""}`).join(", ") : "none", "#f9fafb")}
    ${row("Positions", positions.length > 0 ? positions.map((p) => p.symbol).join(", ") : "none")}
  </table>

  ${autoFixed.length > 0
    ? `<div style="background:#ecfdf5;border-left:4px solid #10b981;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔧 Auto-repaired:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${autoFixed.map((f) => `<li>${f}</li>`).join("")}</ul>
  </div>`
    : ""}

  ${issues.length > 0
    ? `<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>⚠️ Needs attention:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${issues.map((i) => `<li>${i}</li>`).join("")}</ul>
  </div>`
    : ""}

  ${reviewConcerns.length > 0
    ? `<div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔍 Skeptical-reviewer concerns:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${reviewConcerns
      .map((c) => {
        const tag = c.severity === "high" ? "🔴" : c.severity === "medium" ? "🟠" : "⚪";
        return `<li><strong>${tag} ${c.title}</strong> — ${c.detail}</li>`;
      })
      .join("")}</ul>
  </div>`
    : ""}

  ${reconcileFindings.length > 0
    ? `<div style="background:#f5f3ff;border-left:4px solid #8b5cf6;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>📊 Dashboard reconciliation:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${reconcileFindings
      .map((f) => {
        const tag = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟠" : "⚪";
        return `<li><strong>${tag} ${f.title}</strong> — ${f.detail}</li>`;
      })
      .join("")}</ul>
  </div>`
    : ""}

  ${hasInfluencerDigest
    ? `<div style="background:#fefce8;border-left:4px solid #eab308;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer signals this week:</strong>
    ${topBuys.length > 0 ? `<p style="margin:6px 0 0;font-size:13px"><strong style="color:#059669">Buys:</strong> ${topBuys.map(([t, s]) => `${t} (${s})`).join(", ")}</p>` : ""}
    ${topAvoids.length > 0 ? `<p style="margin:6px 0 0;font-size:13px"><strong style="color:#dc2626">Avoid:</strong> ${topAvoids.map(([t, s]) => `${t} (${s})`).join(", ")}</p>` : ""}
    ${insights.length > 0 ? `<p style="margin:8px 0 2px;font-size:13px"><strong>Insights:</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${insights.map((i) => `<li><span style="color:#6b7280">[${i.channel}]</span> ${i.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("")}</ul>` : ""}
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af">Informational — buys feed the sleeve (score ≥ 3); avoids/insights are visibility only, not wired into trades.</p>
  </div>`
    : `<div style="background:#f9fafb;border-left:4px solid #9ca3af;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer signals this week:</strong>
    <p style="margin:6px 0 0;font-size:13px;color:#6b7280">None — ${influencerEmptyReason}.</p>
  </div>`}

  ${ledgerChannels.length > 0
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer-pick ledger — which channels' picks work:</strong>
    ${agedChannels.length === 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">Tracking ${ledgerChannels.length} channels — picks logged recently still read ~0%; forward returns accumulate over the coming days.</p>`
      : `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
      <tr style="color:#6b7280"><td style="padding:3px 8px">Channel</td><td style="padding:3px 8px;text-align:right">Picks</td><td style="padding:3px 8px;text-align:right">Hit</td><td style="padding:3px 8px;text-align:right">Avg ret</td><td style="padding:3px 8px;text-align:right">vs SPY</td></tr>
      ${agedChannels.slice(0, 8).map((c) =>
        `<tr><td style="padding:3px 8px">${c.channel}${c.picks < 4 ? ` <span style="color:#9ca3af;font-size:11px">thin</span>` : ""}</td><td style="padding:3px 8px;text-align:right">${c.picks}</td><td style="padding:3px 8px;text-align:right">${c.hitRatePct.toFixed(0)}%</td><td style="padding:3px 8px;text-align:right;color:${c.avgReturnPct >= 0 ? "#059669" : "#dc2626"}">${c.avgReturnPct >= 0 ? "+" : ""}${c.avgReturnPct.toFixed(1)}%</td><td style="padding:3px 8px;text-align:right;font-weight:bold;color:${c.avgAlphaPct == null ? "#9ca3af" : c.avgAlphaPct >= 0 ? "#059669" : "#dc2626"}">${c.avgAlphaPct != null ? `${c.avgAlphaPct >= 0 ? "+" : ""}${c.avgAlphaPct.toFixed(1)}%` : "—"}</td></tr>`
      ).join("")}
    </table>
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af"><strong>vs SPY</strong> = average return above/below the S&amp;P over each pick's own window — the real edge, stripped of the market's move (channels are ranked by it). Small, correlated samples — a ranking hint, not a verdict; "thin" = very few picks.</p>`}
  </div>`
    : ""}

  ${signalBuysLogged > 0
    ? `<div style="background:#f0fdf4;border-left:4px solid #10b981;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔬 Signal ledger — which entry signals work:</strong>
    ${signalStats.length === 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">Logged ${signalBuysLogged} buy${signalBuysLogged === 1 ? "" : "s"} — forward returns accumulate over the coming days.</p>`
      : `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
      <tr style="color:#6b7280"><td style="padding:3px 8px">Signal at buy</td><td style="padding:3px 8px;text-align:right">Buys</td><td style="padding:3px 8px;text-align:right">Hit</td><td style="padding:3px 8px;text-align:right">Avg ret</td><td style="padding:3px 8px;text-align:right">vs avg pick</td></tr>
      ${signalStats.slice(0, 8).map((s) =>
        `<tr><td style="padding:3px 8px">${s.signal}${s.picks < 4 ? ` <span style="color:#9ca3af;font-size:11px">thin</span>` : ""}</td><td style="padding:3px 8px;text-align:right">${s.picks}</td><td style="padding:3px 8px;text-align:right">${s.hitRatePct.toFixed(0)}%</td><td style="padding:3px 8px;text-align:right;color:${s.avgReturnPct >= 0 ? "#059669" : "#dc2626"}">${s.avgReturnPct >= 0 ? "+" : ""}${s.avgReturnPct.toFixed(1)}%</td><td style="padding:3px 8px;text-align:right;font-weight:bold;color:${s.vsBaselinePct >= 0 ? "#059669" : "#dc2626"}">${s.vsBaselinePct >= 0 ? "+" : ""}${s.vsBaselinePct.toFixed(1)}%</td></tr>`
      ).join("")}
    </table>
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af"><strong>vs avg pick</strong> = a signal's buys' average forward return minus the average over ALL buys (positive = the signal beat the typical pick; ranked by it). From our own trades, measured forward — small, mixed-horizon samples early, so a hint not a verdict.</p>`}
  </div>`
    : ""}

  ${verifyResult ? `<div style="background:${verifyResult.status === "ok" ? "#ecfdf5" : verifyResult.status === "discrepancy" ? "#fef3c7" : "#f3f4f6"};border-left:4px solid ${verifyResult.status === "ok" ? "#10b981" : verifyResult.status === "discrepancy" ? "#f59e0b" : "#9ca3af"};padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>Live Robinhood verify: ${verifyResult.status.toUpperCase()}</strong>
    ${verifyResult.diff?.cashDiff != null ? `<p style="margin:6px 0 0;font-size:13px">Cash diff: ${verifyResult.diff.cashDiff >= 0 ? "+" : ""}$${verifyResult.diff.cashDiff.toFixed(2)} | Value diff: ${verifyResult.diff.valueDiff != null ? `${verifyResult.diff.valueDiff >= 0 ? "+" : ""}$${verifyResult.diff.valueDiff.toFixed(2)}` : "—"}</p>` : ""}
    ${verifyResult.status !== "ok" && verifyResult.discrepancies.length > 0 ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:13px">${verifyResult.discrepancies.map(d => `<li>${d}</li>`).join("")}</ul>` : ""}
    <p style="margin:6px 0 0;font-size:11px;color:#6b7280">MCP: balance=${verifyResult.mcpAvailable?.balance} positions=${verifyResult.mcpAvailable?.positions} orders=${verifyResult.mcpAvailable?.orders}</p>
  </div>` : `<div style="background:#f3f4f6;border-left:4px solid #9ca3af;padding:12px 16px;margin-bottom:16px;border-radius:4px"><strong>Live verify:</strong> skipped — endpoint unavailable</div>`}

  ${todayRun?.summary
    ? `<div style="background:#f3f4f6;padding:12px 16px;border-radius:4px;margin-bottom:16px">
    <strong>Run summary:</strong>
    <p style="margin:8px 0 0;white-space:pre-wrap;font-size:13px">${todayRun.summary.slice(0, 800)}</p>
  </div>`
    : ""}

  <p style="font-size:12px;color:#9ca3af;margin-top:24px">
    Sent by Vercel cron at 8am PT — no Mac required.<br/>
    <a href="${dashboardUrl}">Open dashboard</a>
  </p>
</div>`;

  // The already-sent short-circuit + force are handled at the top of the handler. If we reach here we
  // either haven't emailed today or force=true — so always send.
  const subject = `Robinhood Agent — ${today} ${needsAttention ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY"}`;
  const emailSent = await sendEmail(subject, html);
  if (emailSent && !force) await markAutopilotSent(today);
  // Persist the reviewer output as the cloud fixer's work list (it reads this endpoint AFTER the
  // email sent → the skip path returns these). Store regardless of email success so it's never lost.
  await storeAutopilotConcerns(today, { date: today, status: statusLabel, reviewConcerns, issues, autoFixed, verifyStatus: verifyResult?.status ?? "skipped" });

  // Trigger the cloud code-fixer immediately, but ONLY on the scheduled cron run
  // (vercel.json sets ?cloudDispatch=1) and ONLY when a fresh email just went out.
  // The once-per-day email dedup makes this fire at most once/day, and the cloud
  // agent's own bare-path reads of this endpoint never re-trigger it (no loop).
  // Cost gate: the cloud agent is a full (Sonnet) Claude Code run, ~5x the cost of the whole
  // in-app pipeline. On a clean HEALTHY day the deterministic checks + skeptical reviewer +
  // verify + reconcile have already done the work and there is nothing for it to fix, so skip
  // it. Only spin it up when something actionable surfaced — a needs-attention flag (issues /
  // high|medium reviewer or reconcile concern), a live-data discrepancy, or a self-healed
  // morning. This cuts the biggest line on the Anthropic bill (~1-in-5 days fire) while keeping
  // the self-heal safety net for exactly the days that need it.
  const cloudWorthDispatching =
    needsAttention ||
    (verifyResult != null && verifyResult.status !== "ok") ||
    selfHealed;
  const cloudDispatch = new URL(request.url).searchParams.get("cloudDispatch") === "1";
  let cloudDispatched: { ok: boolean; detail: string; status: number } | null = null;
  if (cloudDispatch && emailSent && cloudWorthDispatching) {
    cloudDispatched = await dispatchCloudAgent();
    console.log("CLOUD_DISPATCH", cloudDispatched);
    // Make a dispatch failure LOUD. It's otherwise swallowed (non-fatal by design) and there's
    // no schedule fallback, so an expired/revoked GH_DISPATCH_TOKEN would silently kill the cloud
    // autopilot with no warning (the "silent self-heal masks a failure" class). Alert instead.
    if (!cloudDispatched.ok) {
      // Distinguish a TRANSIENT GitHub blip (5xx / network — already retried 3×) from a real TOKEN
      // problem (401/403), so a GitHub hiccup doesn't cry "regenerate the PAT".
      const transient = cloudDispatched.status >= 500 || cloudDispatched.status < 0;
      await sendAlert(
        transient
          ? "ℹ️ Autopilot cloud-dispatch skipped (transient GitHub error)"
          : "⚠️ Autopilot cloud-dispatch FAILED — check GH_DISPATCH_TOKEN",
        transient
          ? `GitHub's workflow-dispatch API returned a transient error (${cloudDispatched.detail}) even after 3 retries — GitHub Actions was briefly unavailable. Today's cloud autopilot (deep verification, skeptical reviewer, Autopilot Journal, propose-mode PRs) did NOT run; it resumes automatically on the next weekday cron. NO ACTION NEEDED unless this recurs across multiple days — then check https://www.githubstatus.com and the GH_DISPATCH_TOKEN.`
          : `The Vercel /api/autopilot cron could not trigger the GitHub autopilot workflow (dispatch result: ${cloudDispatched.detail}). Until fixed, the cloud autopilot — deep verification, skeptical reviewer, Autopilot Journal, and propose-mode PRs — will NOT run, and there is no schedule fallback. A 4xx here is a token/perms problem: most likely GH_DISPATCH_TOKEN expired/revoked (HTTP 401/403) or the env var is missing. Fix: regenerate the PAT with the 'repo' scope, update GH_DISPATCH_TOKEN in the Vercel project env (Production) + .env.local, then redeploy.`,
      );
    }
  } else if (cloudDispatch && emailSent) {
    // Clean HEALTHY run — deliberately skipped the cloud agent to save cost. Logged so the
    // skip is visible (not a silent dispatch failure) and distinguishable in the logs.
    console.log("CLOUD_DISPATCH_SKIPPED", { reason: "clean run, nothing actionable for the cloud agent" });
  }

  return Response.json({
    date: today,
    status: statusLabel,
    ranToday: todayRun !== null,
    selfHealed,
    autoFixed,
    trades: trades.length,
    buys: buys.length,
    sells: sells.length,
    totalValue,
    issues,
    reviewConcerns,
    verifyStatus: verifyResult?.status ?? "skipped",
    emailSent,
    cloudDispatched,
    cloudDispatchSkipped: cloudDispatch && emailSent && !cloudWorthDispatching,
  });
}
