// Best-effort email alerts via Resend. Never throws — alerting must not break the main flow.
// Requires RESEND_API_KEY env var. From address uses the verified agent.dencredible.com domain
// (Resend) for reliable deliverability — the shared onboarding@resend.dev sandbox sender was spam-prone.

export async function sendAlert(subject: string, body: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Robinhood Agent <alerts@agent.dencredible.com>",
        to: [process.env.ALERT_EMAIL ?? ""],
        subject,
        text: body,
      }),
    });
  } catch {
    // intentionally swallowed
  }
}
