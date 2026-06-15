import { getRuns, hasAutopilotSentToday, markAutopilotSent } from "@/lib/run-store";
import { isMarketHoliday } from "@/lib/holidays";

export const maxDuration = 60;

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

  let runs = await getRuns(5);
  let todayRun = runs.find((r) => r.date === today) ?? null;

  const issues: string[] = [];
  let selfHealed = false;

  if (!todayRun) {
    // Attempt self-heal: trigger the trade cron and re-fetch.
    try {
      const host = new URL(request.url).origin;
      const tradeRes = await fetch(`${host}/api/trade`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      if (tradeRes.ok) {
        selfHealed = true;
        runs = await getRuns(5);
        todayRun = runs.find((r) => r.date === today) ?? null;
      } else {
        issues.push(`Trade cron missing — auto-trigger failed (${tradeRes.status}).`);
      }
    } catch {
      issues.push("Trade cron missing — auto-trigger threw an error.");
    }

    if (!todayRun) {
      issues.push("Trade cron missing and auto-trigger failed — manual intervention needed.");
    }
  }

  const trades = todayRun?.trades ?? [];
  const buyingPower = todayRun?.portfolioAfter?.cash ?? null;
  const totalValue = todayRun?.portfolioAfter?.totalValue ?? null;
  const positions = todayRun?.positions ?? [];
  const agenticReturn = todayRun?.agenticDailyReturn;
  const personalReturn = todayRun?.personalDailyReturn;

  if (trades.length === 0 && buyingPower && parseFloat(buyingPower) > 50) {
    issues.push(
      `No trades executed but buying power is $${parseFloat(buyingPower).toFixed(2)} — possible analysis issue.`,
    );
  }

  const statusLabel = issues.length > 0 ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY";
  const statusColor = issues.length > 0 ? "#f59e0b" : "#10b981";

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
    ${row("Sells", sells.length > 0 ? sells.map((t) => `${t.symbol} ×${t.quantity} @$${t.avgPrice}`).join(", ") : "none", "#f9fafb")}
    ${row("Positions", positions.length > 0 ? positions.map((p) => p.symbol).join(", ") : "none")}
  </table>

  ${
    issues.length > 0
      ? `<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>Issues to investigate:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${issues.map((i) => `<li>${i}</li>`).join("")}</ul>
  </div>`
      : ""
  }

  ${
    todayRun?.summary
      ? `<div style="background:#f3f4f6;padding:12px 16px;border-radius:4px;margin-bottom:16px">
    <strong>Run summary:</strong>
    <p style="margin:8px 0 0;white-space:pre-wrap;font-size:13px">${todayRun.summary.slice(0, 800)}</p>
  </div>`
      : ""
  }

  <p style="font-size:12px;color:#9ca3af;margin-top:24px">
    Sent by Vercel cron at 8am PT — no Mac required.<br/>
    <a href="${process.env.APP_URL ?? ""}/?key=${process.env.CRON_SECRET ?? ""}">Open dashboard</a>
  </p>
</div>`;

  const force = new URL(request.url).searchParams.get("force") === "true";
  const alreadySent = !force && await hasAutopilotSentToday(today);
  let emailSent = false;
  if (!alreadySent) {
    const subject = `Robinhood Agent — ${today} ${issues.length > 0 ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY"}`;
    emailSent = await sendEmail(subject, html);
    // Don't mark as sent on forced calls — lets the scheduled cron still fire.
    if (emailSent && !force) await markAutopilotSent(today);
  }

  return Response.json({
    date: today,
    status: statusLabel,
    ranToday: todayRun !== null,
    selfHealed,
    trades: trades.length,
    buys: buys.length,
    sells: sells.length,
    totalValue,
    issues,
    emailSent,
  });
}
