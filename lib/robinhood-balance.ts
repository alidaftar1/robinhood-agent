import Anthropic from "@anthropic-ai/sdk";

const MCP_URL = "https://agent.robinhood.com/mcp/trading";

// Live Robinhood balance via Haiku+MCP. unsettled = total cash − settled buying power
// (Robinhood has no clean unsettled_funds field; `cash` includes unsettled sell proceeds,
// `buying_power` is settled only). Shared by /api/trade, /api/drop-check, and
// /api/earnings-exit so EVERY run's snapshot stores the same accurate live figure —
// otherwise a thin intraday run undercounts unsettled cash (it only sees its own sells).
export async function fetchAgenticBalance(
  anthropic: Anthropic,
  accessToken: string,
): Promise<{ buyingPower: number; totalValue: number; unsettled: number } | null> {
  const account = process.env.AGENTIC_ACCOUNT_ID ?? "";
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `Call get_portfolio for account ${account}. Output exactly one line:
AGENTIC_BALANCE:{"buyingPower":"XX.XX","totalValue":"XX.XX","cash":"XX.XX"}
Use buying_power.buying_power for buyingPower, total_value for totalValue, and the top-level cash field for cash (total cash incl. unsettled). Output nothing else.`,
      messages: [{ role: "user", content: `Fetch live balance for account ${account}.` }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "robinhood", authorization_token: accessToken }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    clearTimeout(killTimer);
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^AGENTIC_BALANCE:(.+)$/m);
    if (!match) return null;
    const p = JSON.parse(match[1]);
    const bp = parseFloat(String(p.buyingPower ?? "0"));
    const tv = parseFloat(String(p.totalValue ?? "0"));
    const cash = parseFloat(String(p.cash ?? "0"));
    const unsettled = isFinite(cash) && cash > bp ? cash - bp : 0;
    return (bp > 0 || tv > 0) ? { buyingPower: bp, totalValue: tv, unsettled } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}
