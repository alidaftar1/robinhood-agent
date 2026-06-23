import Anthropic from "@anthropic-ai/sdk";
import { getRuns, hasAutopilotSentToday, markAutopilotSent } from "@/lib/run-store";
import { isMarketHoliday } from "@/lib/holidays";
import { reviewRun, type ReviewConcern } from "@/lib/autopilot-review";

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
      from: "onboarding@resend.dev",
      to: [process.env.ALERT_EMAIL ?? ""],
      subject,
      html,
    }),
  });
  return res.ok;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = todayPT();

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
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

  // Intent-vs-execution: the agent DECIDED to sell something but it's still held.
  // Catches a silently dropped sell order (the BAX case) that data-consistency
  // checks miss. Flag only — the next scheduled run re-attempts the sell.
  if (todayRun?.summary && todayRun.positions.length > 0) {
    const m = todayRun.summary.match(/TRADE_DECISION:(\{.*\})/);
    if (m) {
      try {
        const decided = JSON.parse(m[1]) as { sells?: Array<{ symbol: string }> };
        const heldSyms = new Set(todayRun.positions.map((p) => p.symbol));
        const notExecuted = (decided.sells ?? [])
          .map((s) => String(s.symbol))
          .filter((sym) => heldSyms.has(sym));
        if (notExecuted.length > 0) {
          issues.push(
            `Decided to sell ${notExecuted.join(", ")} but still held — sell order(s) dropped. Next run should re-attempt; place manually if it persists.`,
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
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const review = await reviewRun(anthropic, todayRun, runs);
    reviewConcerns = review.concerns;
    if (review.error) {
      autoFixed.push(`Skeptical-reviewer pass could not run (${review.error}).`);
    }
  }
  // high/medium concerns are actionable → they flip the status; low are FYI only.
  const seriousConcerns = reviewConcerns.filter((c) => c.severity !== "low");

  // ─── Email ────────────────────────────────────────────────────────────────────

  const needsAttention = issues.length > 0 || seriousConcerns.length > 0;
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
    <a href="${host}/?key=${process.env.CRON_SECRET ?? ""}">Open dashboard</a>
  </p>
</div>`;

  const force = new URL(request.url).searchParams.get("force") === "true";
  const alreadySent = !force && await hasAutopilotSentToday(today);
  let emailSent = false;
  if (!alreadySent) {
    const subject = `Robinhood Agent — ${today} ${needsAttention ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY"}`;
    emailSent = await sendEmail(subject, html);
    if (emailSent && !force) await markAutopilotSent(today);
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
  });
}
