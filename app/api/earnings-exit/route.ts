import { requireCronAuth } from "@/lib/auth";
import { dashboardPublicUrl } from "@/lib/dashboard-auth";
import { createAnthropic } from "@/lib/anthropic";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { getMarketData, fetchCurrentPrice, enrichPriceMap } from "@/lib/market-data";
import { saveRun, getLatestRun, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";
import { fetchAgenticBalance } from "@/lib/robinhood-balance";

export const maxDuration = 300;

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = new Date().toISOString().split("T")[0];

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
  }

  const previousRun = await getLatestRun();
  const heldPositions = previousRun?.positions ?? [];

  if (heldPositions.length === 0) {
    console.log("EARNINGS_EXIT_SKIP — no positions held");
    return Response.json({ skipped: true, reason: "no positions held" });
  }

  const [marketData, spyPrice] = await Promise.all([
    getMarketData(),
    fetchCurrentPrice("SPY"),
  ]);

  const now = Date.now();
  const imminentPositions = heldPositions.filter((p) => {
    const stock = marketData.stocks.find((s) => s.symbol === p.symbol);
    if (!stock?.earningsDate) return false;
    const daysOut = (new Date(stock.earningsDate).getTime() - now) / 86_400_000;
    return daysOut >= 0 && daysOut <= 3;
  });

  if (imminentPositions.length === 0) {
    console.log("EARNINGS_EXIT_SKIP — no imminent earnings on held positions", {
      held: heldPositions.map((p) => p.symbol),
    });
    return Response.json({
      skipped: true,
      reason: "no imminent earnings on held positions",
      held: heldPositions.map((p) => p.symbol),
    });
  }

  const imminentNames = imminentPositions.map((p) => {
    const stock = marketData.stocks.find((s) => s.symbol === p.symbol);
    const daysOut = stock?.earningsDate
      ? Math.ceil((new Date(stock.earningsDate).getTime() - now) / 86_400_000)
      : "?";
    return `${p.symbol} (earnings in ${daysOut}d)`;
  }).join(", ");

  console.log("EARNINGS_EXIT_TRIGGERED", { imminentPositions: imminentPositions.map((p) => p.symbol) });

  try {
    const accessToken = await getValidAccessToken();
    const anthropic = createAnthropic();
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const runTimestamp = new Date().toISOString();

    const priceMap = new Map<string, number>(marketData.stocks.map((s) => [s.symbol, s.price]));
    const influencerSymbols = new Set((previousRun?.influencerPositions ?? []).map((p) => p.symbol));

    // ── Sell-only (audit finding [2]) — no reasoning model, no discretionary buy ──────
    // Selling every imminent-earnings name is mechanical (no judgment call), so code builds the
    // sell set directly and a constrained executor places it — no reasoning model ever holds the
    // trade token here. The freed cash is HELD; the next morning's /api/trade redeploys it under
    // the full ruleset (universe filter, per-position cap, sector cap, budget). The prior design
    // let a token-holding Sonnet "buy ONE alternative" with none of those guardrails.
    const sellsToExecute = imminentPositions
      .map((p) => ({ symbol: p.symbol, quantity: p.quantity }))
      .filter((s) => (parseFloat(s.quantity) || 0) > 0);

    let portfolioAfter: { totalValue: string; cash: string; equity: string; unsettledCash?: string } | null = null;
    let positions: PositionSnapshot[] = [];
    const trades: TradeSnapshot[] = [];

    // DRY RUN: report what we WOULD sell, place nothing, save nothing.
    if (dryRun) {
      return Response.json({ dryRun: true, today, wouldSell: sellsToExecute });
    }

    // ── Constrained executor (Haiku, MCP) — handed ONLY the sell list; cannot buy ─────
    // Same pattern as /api/trade + /api/drop-check: place one at a time, verify via
    // get_equity_orders, retry any that didn't ONCE, record only confirmed fills.
    const mcpServer = { type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken };

    async function runSellSession(sells: Array<{ symbol: string; quantity: string }>, timeoutMs: number): Promise<boolean> {
      if (sells.length === 0) return true;
      const lines = sells.map((s) => `- sell ${s.quantity} shares of ${s.symbol}`).join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market sell orders one at a time for account ${ACCOUNT} using place_equity_order. Use type=market, time_in_force=gfd, market_hours=regular_hours. Quantities may be fractional (e.g. 2.37) — pass the exact quantity given. Place each order sequentially and wait for confirmation before the next. Do not skip any. Do not analyze — just execute.\n${lines}\nOutput: SELLS_DONE`,
          messages: [{ role: "user", content: "Execute the sells now, one at a time." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log("EARNINGS_EXIT_SELLS_DONE", { count: sells.length, result: txt.slice(0, 100) });
        return true;
      } catch (e) {
        console.warn("EARNINGS_EXIT_SELLS_FAILED", e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        clearTimeout(timer);
      }
    }

    type VerifiedSell = { symbol: string; quantity: string; avgPrice: string; state: string };
    async function verifySells(): Promise<Map<string, VerifiedSell>> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_SELLS:[{"symbol":"XX","quantity":"X","avgPrice":"XX.XX","state":"XX"}]
Include only SELL orders placed today that are filled or pending (not cancelled/rejected). If none, output VERIFIED_SELLS:[]. Output nothing else.`,
          messages: [{ role: "user", content: "Verify today's sell orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        // Tolerate multiline JSON: take the first complete [...] after the marker. verifySells is
        // the sole source of truth for fills, so a parse miss = a real sell recorded as still-held.
        const idx = txt.indexOf("VERIFIED_SELLS:");
        if (idx === -1) return new Map();
        const arr = txt.slice(idx).match(/\[[\s\S]*\]/);
        if (!arr) return new Map();
        return new Map((JSON.parse(arr[0]) as VerifiedSell[]).map((o) => [o.symbol, o]));
      } catch {
        return new Map();
      } finally {
        clearTimeout(timer);
      }
    }

    if (sellsToExecute.length > 0) {
      const ok = await runSellSession(sellsToExecute, 120_000);
      if (!ok) console.warn("EARNINGS_EXIT_SELL_SESSION_ABORTED — verifying anyway (an order may have filled before the abort)");
      // Verify REGARDLESS of ok: an aborted place session can still have filled orders.
      let verified = await verifySells();
      let missing = sellsToExecute.filter((s) => !verified.has(s.symbol));
      if (missing.length > 0) {
        console.warn("EARNINGS_EXIT_SELL_VERIFY_MISSING — retrying", { missing: missing.map((s) => s.symbol) });
        await runSellSession(missing, 90_000);
        verified = await verifySells();
        missing = sellsToExecute.filter((s) => !verified.has(s.symbol));
      }
      // Record ONLY confirmed sells; prefer the real fill price from get_equity_orders.
      for (const s of sellsToExecute) {
        const v = verified.get(s.symbol);
        if (!v) continue;
        const fill = parseFloat(v.avgPrice) > 0 ? v.avgPrice : String(priceMap.get(s.symbol) ?? 0);
        trades.push({ symbol: s.symbol, side: "sell", quantity: v.quantity, avgPrice: fill, state: v.state, strategy: influencerSymbols.has(s.symbol) ? "influencer" : undefined });
      }
      if (missing.length > 0) {
        console.warn("EARNINGS_EXIT_SELL_STILL_MISSING", { missing: missing.map((s) => s.symbol) });
        await sendAlert(
          `⚠️ Earnings-exit sells not confirmed — ${today}`,
          `These earnings exits did NOT execute even after a retry: ${missing.map((s) => s.symbol).join(", ")}.\nThey are still held INTO earnings — sell them manually in Robinhood.`,
        );
      }
    }

    // Surviving positions = held minus confirmed sells. Live-price survivors to avoid a
    // cost-basis phantom-flat in the return series.
    const soldSymbols = new Set(trades.filter((t) => t.side === "sell").map((t) => t.symbol));
    const survivors = heldPositions.filter((p) => !soldSymbols.has(p.symbol));
    await enrichPriceMap(survivors.map((p) => p.symbol), priceMap);
    positions = survivors.map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost, price: String(priceMap.get(p.symbol) ?? p.avgCost) }));
    const equity = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
    const sellProceeds = trades.filter((t) => t.side === "sell").reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
    const live = await fetchAgenticBalance(anthropic, accessToken);
    if (live) {
      portfolioAfter = { totalValue: (live.buyingPower + live.unsettled + equity).toFixed(2), cash: live.buyingPower.toFixed(2), equity: equity.toFixed(2), unsettledCash: live.unsettled.toFixed(2) };
    } else {
      const cash = parseFloat(previousRun?.portfolioAfter?.cash ?? "0");
      portfolioAfter = { totalValue: (cash + equity).toFixed(2), cash: cash.toFixed(2), equity: equity.toFixed(2), unsettledCash: (isFinite(sellProceeds) && sellProceeds > 0 ? sellProceeds : 0).toFixed(2) };
    }
    const influencerPositions = positions.filter((p) => influencerSymbols.has(p.symbol));
    const soldList = trades.filter((t) => t.side === "sell").map((t) => `${t.symbol} x${t.quantity} @ ${t.avgPrice}`).join(", ") || "none confirmed";

    await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[EARNINGS EXIT] Sold before earnings: ${soldList}. Freed cash held for the morning rebalance.`,
      portfolioAfter,
      positions,
      trades,
      personal: previousRun?.personal ?? null,
      influencerPositions,
      market: { stocksLoaded: marketData.stocks.length, headlinesLoaded: marketData.headlines.length },
      ...(spyPrice != null ? { spyPrice } : {}),
    });

    const dashboardUrl = dashboardPublicUrl(process.env.APP_URL);
    await sendAlert(
      `📋 Earnings Exit Triggered — ${today}`,
      `Sold before earnings: ${soldList}.\nFreed cash held — the morning rebalance redeploys it under the full ruleset.\n\nCheck the dashboard:\n${dashboardUrl}`,
    );

    console.log("EARNINGS_EXIT_COMPLETE", { sold: [...soldSymbols] });
    return Response.json({ success: true, sold: [...soldSymbols], date: today });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("EARNINGS_EXIT_ERROR", message);
    await sendAlert(
      `🚨 Earnings Exit failed — ${today}`,
      `Failed to exit earnings positions (${imminentNames}).\n\nError: ${message}\n\nCheck Vercel logs:\nhttps://vercel.com/ali-daftarians-projects/robinhood-agent/logs`
    );
    return Response.json({ error: message }, { status: 500 });
  }
}
