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

/**
 * Symbols with a FILLED BUY the OWNER placed (not the agent) on or after `since` (YYYY-MM-DD).
 *
 * The evidence lib/owner-buys requires before code sells an owner buy as a misfit: a holding that is
 * merely NEW (a spin-off, merger stock, a row the previous snapshot dropped, an agent buy that
 * filled late) is not proof the owner bought it. Orders carry `placed_agent` — "user" for the
 * owner's own, "agentic" for this agent's. Read-only: the model is restricted to get_equity_orders.
 * null on ANY failure, which callers must treat as "no evidence" — never as a sell signal.
 */
export async function fetchOwnerBuyEvidence(
  anthropic: Anthropic,
  accessToken: string,
  symbols: string[],
  since: string,
): Promise<Set<string> | null> {
  if (symbols.length === 0) return new Set();
  const account = process.env.AGENTIC_ACCOUNT_ID ?? "";
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `Call get_equity_orders for account ${account} to get its recent orders. Output exactly one line:
OWNER_ORDERS:[{"symbol":"XX","side":"buy|sell","state":"XX","createdAtTs":"<created_at exactly as returned>","placedBy":"XX"}]
Include only orders for these symbols: ${symbols.join(", ")}. Use instrument_symbol, side, state, created_at copied unchanged, and the placed_agent field copied exactly as returned (empty string if absent). If none, output OWNER_ORDERS:[]. Output nothing else.`,
      messages: [{ role: "user", content: `Fetch recent orders for account ${account}.` }],
      mcp_servers: [{
        type: "url", url: MCP_URL, name: "robinhood", authorization_token: accessToken,
        tool_configuration: { enabled: true, allowed_tools: ["get_equity_orders"] },
      }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^OWNER_ORDERS:(.+)$/m);
    if (!match) return null;
    const rows = JSON.parse(match[1]);
    if (!Array.isArray(rows)) return null;
    return ownerBuysFromOrders(rows, symbols, since);
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

/** Pure half of fetchOwnerBuyEvidence: which symbols have a filled, owner-placed buy since `since`. */
export function ownerBuysFromOrders(
  rows: Array<{ symbol?: unknown; side?: unknown; state?: unknown; createdAtTs?: unknown; placedBy?: unknown }>,
  symbols: string[],
  since: string,
): Set<string> {
  const wanted = new Set(symbols);
  const out = new Set<string>();
  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    if (!wanted.has(sym)) continue;
    if (String(r.side).toLowerCase() !== "buy" || String(r.state).toLowerCase() !== "filled") continue;
    if (String(r.placedBy).toLowerCase() !== "user") continue;
    // The full broker timestamp must parse: a row an LLM made up rarely carries a real one, and a
    // sale rests on this. Compared as a UTC date, which is never earlier than the US date of the fill.
    const raw = String(r.createdAtTs ?? "");
    const ts = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ts) || !(new Date(ts).toISOString().slice(0, 10) >= since)) continue;
    out.add(sym);
  }
  return out;
}
