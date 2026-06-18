import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice, fetchQuoteLite } from "@/lib/market-data";
import { saveRun, getLatestRun, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";

export const maxDuration = 300;

const DROP_THRESHOLD_PCT = -5; // sell if intraday change < -5%

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().split("T")[0];

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
  }

  // scope=influencer → only check influencer positions (hourly tight leash).
  // No scope → check ALL positions (the original once-daily full stop check).
  const scope = new URL(request.url).searchParams.get("scope");
  const influencerOnly = scope === "influencer";

  const previousRun = await getLatestRun();
  const heldPositions = previousRun?.positions ?? [];

  if (heldPositions.length === 0) {
    return Response.json({ skipped: true, reason: "no positions held" });
  }

  // Influencer picks: use tighter stop-loss vs buy price (not prev close)
  // A position is an influencer pick if it appears in the latest run's influencerPositions
  const influencerSymbols = new Set((previousRun?.influencerPositions ?? []).map(p => p.symbol));

  // Detection set: influencer-only runs check just those names; full runs check everything.
  // (Holdings context for redeployment below always uses the complete position list.)
  const positionsToCheck = influencerOnly
    ? heldPositions.filter((p) => influencerSymbols.has(p.symbol))
    : heldPositions;

  if (positionsToCheck.length === 0) {
    return Response.json({ skipped: true, reason: influencerOnly ? "no influencer positions" : "no positions held" });
  }

  // CHEAP DETECTION PASS — fetch only the to-check position quotes (≤10), not the full universe.
  // Lets this run hourly without hammering Yahoo. Full market data is only loaded below
  // if a drop is actually detected (needed for the redeployment prompt).
  const liteQuotes = await Promise.all(
    positionsToCheck.map((p) => fetchQuoteLite(p.symbol).then((q) => ({ symbol: p.symbol, q })))
  );
  const liteMap = new Map(liteQuotes.map((r) => [r.symbol, r.q]));

  // Find positions with a severe drop
  const droppedPositions = positionsToCheck
    .map((p) => {
      const q = liteMap.get(p.symbol);
      const currentPrice = q?.price ?? 0;
      const isInfluencer = influencerSymbols.has(p.symbol);

      let change1d: number;
      if (isInfluencer && currentPrice > 0 && parseFloat(p.avgCost) > 0) {
        // For influencer picks: measure drop from buy price, not previous close
        change1d = ((currentPrice - parseFloat(p.avgCost)) / parseFloat(p.avgCost)) * 100;
      } else {
        change1d = q?.change1d ?? 0;
      }

      return { position: p, change1d, isInfluencer };
    })
    .filter(({ change1d }) => change1d <= DROP_THRESHOLD_PCT);

  if (droppedPositions.length === 0) {
    const worst = positionsToCheck
      .map((p) => `${p.symbol}(${(liteMap.get(p.symbol)?.change1d ?? 0).toFixed(1)}%)`)
      .join(", ");
    console.log("DROP_CHECK_SKIP — no severe drops", { scope: scope ?? "all", held: worst });
    return Response.json({ skipped: true, reason: "no severe drops", scope: scope ?? "all", held: worst });
  }

  const droppedNames = droppedPositions
    .map(({ position, change1d }) => `${position.symbol} (${change1d.toFixed(1)}% today)`)
    .join(", ");

  console.log("DROP_CHECK_TRIGGERED", { droppedPositions: droppedPositions.map(({ position }) => position.symbol) });

  try {
    const accessToken = await getValidAccessToken();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // A drop was detected — NOW load full market data for the redeployment decision.
    const [marketData, spyPrice] = await Promise.all([
      getMarketData(),
      fetchCurrentPrice("SPY"),
    ]);

    const priceMap = new Map<string, number>(marketData.stocks.map((s) => [s.symbol, s.price]));

    const portfolioCtx = previousRun?.portfolioAfter ? {
      buyingPower: `$${previousRun.portfolioAfter.cash} (cash on hand)`,
      totalValue: `$${previousRun.portfolioAfter.totalValue} (estimated)`,
      positions: heldPositions.map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })),
    } : undefined;

    const basePrompt = buildSystemPrompt(today, formatMarketDataForPrompt(marketData), portfolioCtx);

    const urgentHeader = `🔴 STOP-LOSS RUN — ${today} 🔴
The following held positions have dropped ≥${Math.abs(DROP_THRESHOLD_PCT)}% intraday — thesis breakdown signal — must be evaluated for exit:
  ${droppedNames}

INSTRUCTIONS — deviate from standard process:
1. SELL the positions listed above immediately — the drop signals a breakdown in thesis.
2. Keep ALL other positions UNCHANGED.
3. With the freed cash, either:
   a. Buy ONE high-conviction alternative (best sharpe, no imminent earnings, price ≤ $400), OR
   b. Hold cash if SPY is also broadly down (>1.5% today) — capital preservation takes priority.
   c. If the drop is clearly sympathy selling (broad market down, stock fundamentals unchanged), use your judgment — you may hold rather than sell.
4. Emit PORTFOLIO_SNAPSHOT as usual.
Do NOT do a full portfolio rebalance. Only exit the damaged positions.

`;

    const systemPrompt = urgentHeader + basePrompt;
    const runTimestamp = new Date().toISOString();

    const response = await (anthropic.beta.messages as any).create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `STOP-LOSS: ${droppedPositions.map(({ position, change1d }) => `${position.symbol} is down ${change1d.toFixed(1)}% today`).join(", ")}. Sell and assess redeployment. Place orders now.`,
      }],
      mcp_servers: [{
        type: "url",
        url: "https://agent.robinhood.com/mcp/trading",
        name: "robinhood",
        authorization_token: accessToken,
      }],
      betas: ["mcp-client-2025-04-04"],
    });

    const textContent = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    let portfolioAfter: { totalValue: string; cash: string; equity: string } | null = null;
    let positions: PositionSnapshot[] = [];
    let trades: TradeSnapshot[] = [];

    const snapshotMatch = textContent.match(/^PORTFOLIO_SNAPSHOT:(.+)$/m);
    if (snapshotMatch) {
      try {
        const snap = JSON.parse(snapshotMatch[1]);
        const cash = parseFloat(snap.cash ?? "0");
        positions = (snap.positions ?? []).map((p: any) => ({
          symbol: String(p.symbol ?? ""),
          quantity: String(p.quantity ?? "0"),
          avgCost: String(p.avgCost ?? "0"),
          price: String(priceMap.get(String(p.symbol ?? "")) ?? p.price ?? 0),
        }));
        trades = (snap.trades ?? []).map((t: any) => ({
          symbol: String(t.symbol ?? ""),
          side: String(t.side ?? ""),
          quantity: String(t.quantity ?? "0"),
          avgPrice: String(t.avgPrice ?? "0"),
          state: String(t.state ?? "submitted"),
        }));
        const equity = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
        portfolioAfter = {
          totalValue: (cash + equity).toFixed(2),
          cash: cash.toFixed(2),
          equity: equity.toFixed(2),
        };
        console.log("DROP_CHECK_SNAPSHOT_PARSED", { cash, sold: droppedPositions.map(({ position }) => position.symbol) });
      } catch (e) {
        console.warn("DROP_CHECK_SNAPSHOT_PARSE_FAILED", e instanceof Error ? e.message : String(e));
      }
    }

    // Carry forward influencer tracking: surviving influencer positions only (sold ones drop out).
    const influencerPositions = positions.filter((p) => influencerSymbols.has(p.symbol));

    await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[STOP-LOSS] Sold: ${droppedNames}\n\n${textContent}`,
      portfolioAfter,
      positions,
      trades,
      personal: previousRun?.personal ?? null,
      influencerPositions,
      market: { stocksLoaded: marketData.stocks.length, headlinesLoaded: marketData.headlines.length },
      ...(spyPrice != null ? { spyPrice } : {}),
    });

    await sendAlert(
      `🔴 Stop-Loss Triggered — ${today}`,
      `Sold ${droppedNames}.\n\nCheck the dashboard:\n${process.env.APP_URL ?? ""}/?key=${process.env.CRON_SECRET ?? ""}`
    );

    console.log("DROP_CHECK_COMPLETE", { sold: droppedPositions.map(({ position }) => position.symbol) });
    return Response.json({ success: true, sold: droppedPositions.map(({ position }) => position.symbol), date: today });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DROP_CHECK_ERROR", message);
    await sendAlert(
      `🚨 Stop-Loss check failed — ${today}`,
      `Failed to exit dropped positions (${droppedNames}).\n\nError: ${message}\n\nLogs: https://vercel.com/ali-daftarians-projects/robinhood-agent/logs`
    );
    return Response.json({ error: message }, { status: 500 });
  }
}
