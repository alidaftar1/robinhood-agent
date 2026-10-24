import Anthropic from "@anthropic-ai/sdk";

const MCP_URL = "https://agent.robinhood.com/mcp/trading";

/**
 * Turn the raw get_portfolio figures into two DIFFERENT numbers — keep them apart:
 *
 *  spendable    what the agent may BUY with. NEVER BORROW: the account moved to limited margin on
 *               2026-10-24, and on a margin account `buying_power.buying_power` can include
 *               borrowing capacity — a leveraged book, margin interest, and (FINRA intraday
 *               standards, 2026) a $2,000 equity minimum the ~$2.4K account sits just above. So it
 *               is the SMALLEST of buying_power, unleveraged_buying_power and cash. If NEITHER of the
 *               latter two can be read it is 0 — raw buying_power alone may be borrowed money, and
 *               not buying is the safe failure.
 *  buyingPower  the SNAPSHOT cash figure (stored as portfolioAfter.cash; total = it + unsettled +
 *               equity). min(buying_power, cash): never margin capacity, and never lowered to the
 *               spend limit, which would understate stored value and feed the return baseline.
 *  unsettled    cash − buyingPower. ~0 on limited margin (unsettled proceeds are spendable); real on
 *               a cash account. `cashKnown` says whether it was MEASURED — callers must not mistake
 *               a measured 0 for "unknown" and substitute their own estimate (double-counting).
 *
 * Pure and exported so the invariant is tested, not just stated.
 */
export function spendableFromPortfolio(p: { buyingPower?: unknown; unleveragedBuyingPower?: unknown; totalValue?: unknown; cash?: unknown }):
  { buyingPower: number; spendable: number; totalValue: number; unsettled: number; cashKnown: boolean; capped: boolean } | null {
  const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
  const bp = num(p.buyingPower) ?? 0;
  const tv = num(p.totalValue) ?? 0;
  const cash = num(p.cash);
  const unlev = num(p.unleveragedBuyingPower);
  const limits = [...(unlev != null ? [unlev] : []), ...(cash != null ? [cash] : [])];
  const spendable = limits.length === 0 ? 0 : Math.max(0, Math.min(bp, ...limits));
  const snapshotCash = cash != null ? Math.min(bp, cash) : bp;
  const unsettled = cash != null && cash > snapshotCash ? cash - snapshotCash : 0;
  return (bp > 0 || tv > 0)
    ? { buyingPower: snapshotCash, spendable, totalValue: tv, unsettled, cashKnown: cash != null, capped: spendable < bp }
    : null;
}

// Live Robinhood balance via Haiku+MCP. unsettled = total cash − settled buying power
// (Robinhood has no clean unsettled_funds field; `cash` includes unsettled sell proceeds,
// `buying_power` is settled only). Shared by /api/trade, /api/drop-check, and
// /api/earnings-exit so EVERY run's snapshot stores the same accurate live figure —
// otherwise a thin intraday run undercounts unsettled cash (it only sees its own sells).
export async function fetchAgenticBalance(
  anthropic: Anthropic,
  accessToken: string,
): Promise<{ buyingPower: number; spendable: number; totalValue: number; unsettled: number; cashKnown: boolean } | null> {
  const account = process.env.AGENTIC_ACCOUNT_ID ?? "";
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `Call get_portfolio for account ${account}. Output exactly one line:
AGENTIC_BALANCE:{"buyingPower":"XX.XX","unleveragedBuyingPower":"XX.XX","totalValue":"XX.XX","cash":"XX.XX"}
Use buying_power.buying_power for buyingPower, buying_power.unleveraged_buying_power for unleveragedBuyingPower, total_value for totalValue, and the top-level cash field for cash (total cash incl. unsettled). Output nothing else.`,
      messages: [{ role: "user", content: `Fetch live balance for account ${account}.` }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "robinhood", authorization_token: accessToken }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    clearTimeout(killTimer);
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^AGENTIC_BALANCE:(.+)$/m);
    if (!match) return null;
    const r = spendableFromPortfolio(JSON.parse(match[1]));
    if (r?.capped) console.warn("AGENTIC_BALANCE_CAPPED_NO_BORROW", { reason: "spend limit is below buying_power (margin capacity, or unleveraged/cash unreadable) — spending the smaller figure" });
    return r ? { buyingPower: r.buyingPower, spendable: r.spendable, totalValue: r.totalValue, unsettled: r.unsettled, cashKnown: r.cashKnown } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

// Live Robinhood equity positions via Haiku+MCP. Moved here from app/api/trade/route.ts when the
// close snapshot needed the same call: two copies of an MCP prompt-parser is exactly how
// fetchQuoteLite drifted from getPriceData and false-stopped for weeks. One definition, two callers.
//
// Read-only (`get_equity_positions`). This model holds the trade token but is given no instruction
// or ability to order — it is the CONSTRAINED executor pattern inverted: no untrusted input reaches
// it at all, so there is nothing to inject. Do not add reasoning or market data to this prompt.
export async function fetchAgenticPositions(
  anthropic: Anthropic,
  accessToken: string,
): Promise<Array<{ symbol: string; quantity: string; avgCost: string }> | null> {
  const account = process.env.AGENTIC_ACCOUNT_ID ?? "";
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: `Call get_equity_positions for account ${account}. Output exactly one line:
AGENTIC_POSITIONS:[{"symbol":"XX","quantity":"X","avgCost":"XX.XX"}]
Use instrument_symbol for symbol, quantity for quantity, average_buy_price for avgCost. If no positions, output AGENTIC_POSITIONS:[]. Output nothing else.`,
      messages: [{ role: "user", content: `Fetch live positions for account ${account}.` }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "robinhood", authorization_token: accessToken }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    clearTimeout(killTimer);
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^AGENTIC_POSITIONS:(.+)$/m);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}
