import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice } from "@/lib/market-data";
import { saveRun, getLatestRun, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";

export const maxDuration = 300;

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const priceMap = new Map<string, number>(marketData.stocks.map((s) => [s.symbol, s.price]));

    const portfolioCtx = previousRun?.portfolioAfter ? {
      buyingPower: `$${previousRun.portfolioAfter.cash} (cash on hand)`,
      totalValue: `$${previousRun.portfolioAfter.totalValue} (estimated)`,
      positions: heldPositions.map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })),
    } : undefined;

    const basePrompt = buildSystemPrompt(today, formatMarketDataForPrompt(marketData), portfolioCtx);

    // Prepend the urgent earnings exit instruction
    const urgentHeader = `⚠️⚠️ EARNINGS EXIT RUN — ${today} ⚠️⚠️
This is a targeted mid-day run triggered because the following held positions have earnings in ≤3 days:
  ${imminentNames}

INSTRUCTIONS — deviate from standard process:
1. SELL the positions listed above IMMEDIATELY. No exceptions regardless of momentum.
2. Keep ALL other positions UNCHANGED — do not sell or add to them.
3. With the freed cash, buy ONE high-conviction alternative: best sharpe, no imminent earnings, price ≤ $400.
4. Emit PORTFOLIO_SNAPSHOT as usual.
Do NOT do a full portfolio rebalance. Only exit the earnings risk and redeploy into one name.

`;

    const systemPrompt = urgentHeader + basePrompt;
    const runTimestamp = new Date().toISOString();

    const response = await (anthropic.beta.messages as any).create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `EARNINGS EXIT: Sell ${imminentPositions.map((p) => p.symbol).join(", ")} immediately — earnings ≤3 days away. Keep all other positions. Redeploy proceeds into one alternative. Place orders now.`,
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
        console.log("EARNINGS_EXIT_SNAPSHOT_PARSED", { cash, sold: imminentPositions.map((p) => p.symbol) });
      } catch (e) {
        console.warn("EARNINGS_EXIT_SNAPSHOT_PARSE_FAILED", e instanceof Error ? e.message : String(e));
      }
    }

    await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[EARNINGS EXIT] Sold: ${imminentNames}\n\n${textContent}`,
      portfolioAfter,
      positions,
      trades,
      personal: previousRun?.personal ?? null,
      market: { stocksLoaded: marketData.stocks.length, headlinesLoaded: marketData.headlines.length },
      ...(spyPrice != null ? { spyPrice } : {}),
    });

    await sendAlert(
      `📋 Earnings Exit Triggered — ${today}`,
      `Sold ${imminentNames} before earnings.\n\nCheck the dashboard for details:\n${process.env.APP_URL ?? ""}/?key=${process.env.CRON_SECRET ?? ""}`
    );

    console.log("EARNINGS_EXIT_COMPLETE", { sold: imminentPositions.map((p) => p.symbol) });
    return Response.json({ success: true, sold: imminentPositions.map((p) => p.symbol), date: today });
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
