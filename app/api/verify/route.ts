import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { getRuns } from "@/lib/run-store";

export const maxDuration = 90;

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";
const MCP_URL = "https://agent.robinhood.com/mcp/trading";

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

async function haiku(
  anthropic: Anthropic,
  accessToken: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await (anthropic.beta.messages as any).create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        mcp_servers: [{ type: "url", url: MCP_URL, name: "robinhood", authorization_token: accessToken }],
        betas: ["mcp-client-2025-04-04"],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);
    return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = todayPT();

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch {
    return Response.json({ error: "Failed to get Robinhood access token" }, { status: 503 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Three read-only Haiku+MCP calls in parallel
  const [balanceText, positionsText, ordersText] = await Promise.all([
    haiku(
      anthropic, accessToken,
      `Call get_portfolio for account ${ACCOUNT}. Output exactly one line:
LIVE_BALANCE:{"buyingPower":"XX.XX","totalValue":"XX.XX"}
Use buying_power.buying_power for buyingPower and total_value for totalValue. Output nothing else.`,
      `Fetch live balance for account ${ACCOUNT}.`,
      256, 25_000
    ),
    haiku(
      anthropic, accessToken,
      `Call get_equity_positions for account ${ACCOUNT}. Output exactly one line:
LIVE_POSITIONS:[{"symbol":"XX","quantity":"X.XX","avgCost":"XX.XX"}]
Use instrument_symbol, quantity, average_buy_price. If none, output LIVE_POSITIONS:[]. Output nothing else.`,
      `Fetch live positions for account ${ACCOUNT}.`,
      1024, 30_000
    ),
    haiku(
      anthropic, accessToken,
      `Call get_equity_orders for account ${ACCOUNT} to get the most recent orders. Output exactly one line:
LIVE_ORDERS:[{"symbol":"XX","side":"buy|sell","quantity":"X.XX","avgPrice":"XX.XX","state":"filled|cancelled|pending","createdAt":"YYYY-MM-DD"}]
Include only the 20 most recent orders. Use instrument_symbol, side, quantity, average_price, state fields. For createdAt, use the date portion of created_at (first 10 chars). Output nothing else.`,
      `Fetch recent orders for account ${ACCOUNT}.`,
      1024, 30_000
    ),
  ]);

  // Parse MCP responses
  const liveBalance = (() => {
    const m = balanceText?.match(/^LIVE_BALANCE:(.+)$/m);
    if (!m) return null;
    try { return JSON.parse(m[1]) as { buyingPower: string; totalValue: string }; } catch { return null; }
  })();

  const livePositions = (() => {
    const m = positionsText?.match(/^LIVE_POSITIONS:(.+)$/m);
    if (!m) return null;
    try { return JSON.parse(m[1]) as Array<{ symbol: string; quantity: string; avgCost: string }>; } catch { return null; }
  })();

  const liveOrders = (() => {
    const m = ordersText?.match(/^LIVE_ORDERS:(.+)$/m);
    if (!m) return null;
    try { return JSON.parse(m[1]) as Array<{ symbol: string; side: string; quantity: string; avgPrice: string; state: string; createdAt?: string }>; } catch { return null; }
  })();

  // Fetch stored run data
  const runs = await getRuns(5);
  const storedRun = runs.find(r => r.date === today) ?? runs[0] ?? null;

  // ─── Compare live vs stored ───────────────────────────────────────────────────

  const discrepancies: string[] = [];

  // Cash discrepancy
  let cashDiff: number | null = null;
  if (liveBalance && storedRun?.portfolioAfter) {
    const liveCash = parseFloat(liveBalance.buyingPower);
    const storedCash = parseFloat(storedRun.portfolioAfter.cash);
    cashDiff = liveCash - storedCash;
    if (Math.abs(cashDiff) > 10) {
      discrepancies.push(`Cash mismatch: live $${liveCash.toFixed(2)} vs stored $${storedCash.toFixed(2)} (diff $${cashDiff.toFixed(2)})`);
    }
  }

  // Total value diff — informational only (stored is a 10:30am snapshot; live price is current market)
  let valueDiff: number | null = null;
  if (liveBalance && storedRun?.portfolioAfter) {
    const liveValue = parseFloat(liveBalance.totalValue);
    const storedValue = parseFloat(storedRun.portfolioAfter.totalValue);
    valueDiff = liveValue - storedValue;
    // Not flagged as a discrepancy — market price drift since snapshot is expected
  }

  // Position discrepancies
  const positionIssues: Array<{ type: string; symbol: string; liveQty?: string; storedQty?: string }> = [];
  if (livePositions && storedRun) {
    const liveMap = new Map(livePositions.map(p => [p.symbol, p.quantity]));
    const storedMap = new Map(storedRun.positions.map(p => [p.symbol, p.quantity]));
    const storedTrades = storedRun.trades ?? [];
    const recordedSells = new Set(storedTrades.filter(t => t.side === "sell").map(t => t.symbol));

    // In stored but not in live
    for (const [sym, qty] of storedMap) {
      if (!liveMap.has(sym)) {
        if (!recordedSells.has(sym)) {
          positionIssues.push({ type: "missing_from_live_no_sell_record", symbol: sym, storedQty: qty });
          discrepancies.push(`${sym}: in stored positions (qty ${qty}) but not in Robinhood — no sell record. Possible unrecorded sell.`);
        }
        // If there IS a sell record, it's expected to be gone — no issue
      }
    }

    // In live but not in stored
    for (const [sym, qty] of liveMap) {
      if (!storedMap.has(sym)) {
        const recordedBuys = storedTrades.filter(t => t.side === "buy" && t.symbol === sym);
        if (recordedBuys.length === 0) {
          positionIssues.push({ type: "in_live_not_stored_no_buy_record", symbol: sym, liveQty: qty });
          discrepancies.push(`${sym}: live position (qty ${qty}) not in stored run — no buy record. Possible unrecorded buy.`);
        }
        // If buy was recorded, just wasn't in positions yet — no issue
      }
    }

    // Quantity mismatch
    for (const [sym, storedQty] of storedMap) {
      const liveQty = liveMap.get(sym);
      if (liveQty !== undefined) {
        const diff = Math.abs(parseFloat(liveQty) - parseFloat(storedQty));
        if (diff > 0.01) {
          positionIssues.push({ type: "quantity_mismatch", symbol: sym, liveQty, storedQty });
          discrepancies.push(`${sym}: quantity mismatch — live ${liveQty} vs stored ${storedQty}`);
        }
      }
    }
  }

  // Order reconciliation: filled orders from today that aren't in stored trades
  const uncapturedOrders: typeof liveOrders = [];
  if (liveOrders && storedRun) {
    const storedTrades = storedRun.trades ?? [];
    // Only check orders placed today (filter by createdAt if present, otherwise skip date check)
    const todayFilled = liveOrders.filter(o =>
      o.state === "filled" && (!o.createdAt || o.createdAt === today)
    );
    for (const order of todayFilled) {
      const matched = storedTrades.some(
        t => t.symbol === order.symbol && t.side === order.side &&
             Math.abs(parseFloat(t.quantity) - parseFloat(order.quantity)) < 0.01
      );
      if (!matched) {
        uncapturedOrders.push(order);
        discrepancies.push(`Uncaptured order: ${order.side} ${order.symbol} ×${order.quantity} @$${order.avgPrice} (${order.state})`);
      }
    }
  }

  const status = discrepancies.length === 0 ? "ok"
    : (liveBalance === null || livePositions === null) ? "partial"
    : "discrepancy";

  return Response.json({
    date: today,
    status,
    live: {
      balance: liveBalance,
      positions: livePositions,
      recentOrders: liveOrders,
    },
    stored: storedRun ? {
      date: storedRun.date,
      cash: storedRun.portfolioAfter?.cash ?? null,
      totalValue: storedRun.portfolioAfter?.totalValue ?? null,
      positions: storedRun.positions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
      trades: storedRun.trades ?? [],
    } : null,
    diff: {
      cashDiff,
      valueDiff,
      positionIssues,
      uncapturedOrders,
    },
    discrepancies,
    mcpAvailable: {
      balance: liveBalance !== null,
      positions: livePositions !== null,
      orders: liveOrders !== null,
    },
  });
}
