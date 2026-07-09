import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice, fetchQuoteLite, enrichPriceMap } from "@/lib/market-data";
import { saveRun, getLatestRun, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";
import { fetchAgenticBalance } from "@/lib/robinhood-balance";

export const maxDuration = 300;

const DROP_THRESHOLD_PCT = -5; // sell if down ≥5% (intraday for main; from buy for influencer)
const TAKE_PROFIT_PCT = 40;    // influencer winners: let winners run — lock the gain at +40% from buy price

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
  // (The sell-decision prompt below always gets the complete held-position list for context.)
  const positionsToCheck = influencerOnly
    ? heldPositions.filter((p) => influencerSymbols.has(p.symbol))
    : heldPositions;

  if (positionsToCheck.length === 0) {
    return Response.json({ skipped: true, reason: influencerOnly ? "no influencer positions" : "no positions held" });
  }

  // CHEAP DETECTION PASS — fetch only the to-check position quotes (≤10), not the full universe.
  // Lets this run hourly without hammering Yahoo. Full market data is only loaded below
  // if a drop is actually detected (to price the surviving positions + give the sell decision context).
  const liteQuotes = await Promise.all(
    positionsToCheck.map((p) => fetchQuoteLite(p.symbol).then((q) => ({ symbol: p.symbol, q })))
  );
  const liteMap = new Map(liteQuotes.map((r) => [r.symbol, r.q]));

  // Find positions to exit: a severe drop (stop-loss) OR an influencer winner up
  // ≥ TAKE_PROFIT_PCT from buy (take-profit — lock the gain before it round-trips).
  const droppedPositions = positionsToCheck
    .map((p) => {
      const q = liteMap.get(p.symbol);
      const currentPrice = q?.price ?? 0;
      const isInfluencer = influencerSymbols.has(p.symbol);

      let change1d: number;
      if (isInfluencer && currentPrice > 0 && parseFloat(p.avgCost) > 0) {
        // For influencer picks: measure from BUY price (covers both the −5% stop and +20% target)
        change1d = ((currentPrice - parseFloat(p.avgCost)) / parseFloat(p.avgCost)) * 100;
      } else {
        change1d = q?.change1d ?? 0;
      }

      let reason: "stop" | "profit" | null = null;
      if (change1d <= DROP_THRESHOLD_PCT) reason = "stop";
      else if (isInfluencer && change1d >= TAKE_PROFIT_PCT) reason = "profit";

      return { position: p, change1d, isInfluencer, reason };
    })
    .filter((e) => e.reason !== null);

  if (droppedPositions.length === 0) {
    const worst = positionsToCheck
      .map((p) => `${p.symbol}(${(liteMap.get(p.symbol)?.change1d ?? 0).toFixed(1)}%)`)
      .join(", ");
    console.log("DROP_CHECK_SKIP — no exits", { scope: scope ?? "all", held: worst });
    return Response.json({ skipped: true, reason: "no exits triggered", scope: scope ?? "all", held: worst });
  }

  const droppedNames = droppedPositions
    .map(({ position, change1d, reason }) => `${position.symbol} (${change1d >= 0 ? "+" : ""}${change1d.toFixed(1)}%, ${reason === "profit" ? "TAKE-PROFIT" : "stop-loss"})`)
    .join(", ");

  console.log("DROP_CHECK_TRIGGERED", { exits: droppedPositions.map(({ position, reason }) => `${position.symbol}:${reason}`) });

  try {
    const accessToken = await getValidAccessToken();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // A drop was detected — NOW load full market data to price surviving positions + give the
    // sell decision market context (this run is sell-only; it does not redeploy into new names).
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

    const hasProfit = droppedPositions.some((e) => e.reason === "profit");
    const hasStop = droppedPositions.some((e) => e.reason === "stop");
    const urgentHeader = `🔴 RISK-EXIT RUN — ${today} 🔴
These held positions hit an exit trigger and must be SOLD:
  ${droppedNames}
${hasStop ? `• stop-loss = down ≥${Math.abs(DROP_THRESHOLD_PCT)}% (thesis breakdown — cut it).\n` : ""}${hasProfit ? `• TAKE-PROFIT = an influencer pick up ≥${TAKE_PROFIT_PCT}% from buy. Lock the gain — these are hype names that round-trip; do NOT let it ride.\n` : ""}
INSTRUCTIONS — deviate from standard process. This is a SELL-ONLY capital-preservation run:
1. SELL every position listed above — both stop-loss and take-profit exits.
   - Exception (STOP-LOSS only): if it's clearly sympathy selling (broad market down, fundamentals unchanged), you may use judgment and HOLD the position. A TAKE-PROFIT exit is NOT optional — always lock the gain.
2. Keep ALL other positions UNCHANGED.
3. Do NOT BUY anything. Do NOT place any buy order or call place_equity_order with side=buy. Hold the freed cash as-is — the NEXT MORNING rebalance redeploys SETTLED cash under the full ruleset (sector cap, book context). This run is one uncoordinated decision-maker; redeploying here would bypass the morning run's sector cap and could spend same-day sale proceeds that are still unsettled.
4. Emit PORTFOLIO_SNAPSHOT as usual (trades should contain ONLY sells).
Do NOT rebalance and do NOT open any new position. Only exit the listed positions.

`;

    const systemPrompt = urgentHeader + basePrompt;
    const runTimestamp = new Date().toISOString();

    const response = await (anthropic.beta.messages as any).create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `RISK-EXIT: ${droppedPositions.map(({ position, change1d, reason }) => `${position.symbol} ${reason === "profit" ? `is up +${change1d.toFixed(1)}% from buy (take-profit)` : `is down ${change1d.toFixed(1)}% (stop-loss)`}`).join(", ")}. SELL these now and HOLD the freed cash — do NOT buy anything. Place the sell orders now.`,
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

    let portfolioAfter: { totalValue: string; cash: string; equity: string; unsettledCash?: string } | null = null;
    let positions: PositionSnapshot[] = [];
    let trades: TradeSnapshot[] = [];

    const snapshotMatch = textContent.match(/^PORTFOLIO_SNAPSHOT:(.+)$/m);
    if (snapshotMatch) {
      try {
        const snap = JSON.parse(snapshotMatch[1]);
        const cash = parseFloat(snap.cash ?? "0");
        // Seed the fresh detection-pass quotes, then fetch a live MARKET price for any surviving
        // held symbol still missing from the map. Prevents the snapshot from falling back to the
        // model's self-reported `p.price` (which it sometimes echoes as the position's cost basis),
        // which would inject a phantom day-over-day move into the sleeve-return series.
        for (const [sym, q] of liteMap) if (q && q.price > 0) priceMap.set(sym, q.price);
        const snapPositions = (snap.positions ?? []) as any[];
        const unresolved = await enrichPriceMap(snapPositions.map((p) => String(p.symbol ?? "")), priceMap);
        if (unresolved.length > 0) console.warn("POSITION_PRICE_UNRESOLVED — drop-check snapshot falling back to reported price", { symbols: unresolved });
        positions = snapPositions.map((p: any) => ({
          symbol: String(p.symbol ?? ""),
          quantity: String(p.quantity ?? "0"),
          avgCost: String(p.avgCost ?? "0"),
          price: String(priceMap.get(String(p.symbol ?? "")) ?? p.price ?? 0),
        }));
        trades = (snap.trades ?? []).map((t: any) => {
          const sym = String(t.symbol ?? "");
          const side = String(t.side ?? "");
          // Sell-price capture: the model reports its PORTFOLIO_SNAPSHOT before the market order
          // actually fills, and sometimes echoes the position's cost basis (e.g. 2026-07-08 recorded
          // MSTR sold at its $98.54 buy price when it filled ~$92.93 — a real loss shown as flat).
          // A market sell fills at ~the live price we quoted the instant the exit triggered, so for
          // SELLS prefer that quote over the model's self-report. Falls back to the reported price
          // if we have no live quote for the symbol.
          const quoted = liteMap.get(sym)?.price;
          const avgPrice = side === "sell" && typeof quoted === "number" && quoted > 0
            ? String(quoted)
            : String(t.avgPrice ?? "0");
          return { symbol: sym, side, quantity: String(t.quantity ?? "0"), avgPrice, state: String(t.state ?? "submitted") };
        });
        const equity = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
        const sellProceeds = trades.filter(t => t.side === "sell").reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
        // Prefer the LIVE balance (settled cash + true unsettled = cash − buying power) so this
        // thin stop-loss run records ALL of today's unsettled proceeds — including the morning
        // rebalance's sells — not just its own. Otherwise the dashboard's "Cash Clearing"
        // undercounts on days with both a rebalance and a stop. Fall back to the model snapshot.
        const live = await fetchAgenticBalance(anthropic, accessToken);
        if (live) {
          portfolioAfter = {
            totalValue: (live.buyingPower + live.unsettled + equity).toFixed(2),
            cash: live.buyingPower.toFixed(2),
            equity: equity.toFixed(2),
            unsettledCash: live.unsettled.toFixed(2),
          };
        } else {
          portfolioAfter = {
            totalValue: (cash + equity).toFixed(2),
            cash: cash.toFixed(2),
            equity: equity.toFixed(2),
            unsettledCash: (isFinite(sellProceeds) && sellProceeds > 0 ? sellProceeds : 0).toFixed(2),
          };
        }
        console.log("DROP_CHECK_SNAPSHOT_PARSED", { cash, sold: droppedPositions.map(({ position }) => position.symbol) });
      } catch (e) {
        console.warn("DROP_CHECK_SNAPSHOT_PARSE_FAILED", e instanceof Error ? e.message : String(e));
      }
    }

    // Carry forward influencer tracking: surviving influencer positions only (sold ones drop out).
    const influencerPositions = positions.filter((p) => influencerSymbols.has(p.symbol));

    // SELL-ONLY invariant backstop: this run must never buy. We can't un-place an order (no
    // off-process cancels), so if the model disobeyed and placed a buy, surface it LOUDLY —
    // in the log, the saved summary, and the alert — so it's never silent.
    const unexpectedBuys = trades.filter((t) => t.side === "buy");
    const buyWarn = unexpectedBuys.length > 0
      ? `\n\n⚠️ SELL-ONLY VIOLATION — drop-check placed ${unexpectedBuys.length} unexpected BUY(s): ${unexpectedBuys.map((t) => `${t.symbol} x${t.quantity} @ ${t.avgPrice}`).join(", ")}. Investigate — this run is not supposed to buy.`
      : "";
    if (unexpectedBuys.length > 0) {
      console.error("DROP_CHECK_UNEXPECTED_BUY", unexpectedBuys.map((t) => `${t.symbol} x${t.quantity} @ ${t.avgPrice}`));
    }

    await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[RISK-EXIT] Sold: ${droppedNames}${buyWarn}\n\n${textContent}`,
      portfolioAfter,
      positions,
      trades,
      personal: previousRun?.personal ?? null,
      influencerPositions,
      market: { stocksLoaded: marketData.stocks.length, headlinesLoaded: marketData.headlines.length },
      ...(spyPrice != null ? { spyPrice } : {}),
    });

    await sendAlert(
      `${unexpectedBuys.length > 0 ? "⚠️ Risk-Exit + UNEXPECTED BUY" : hasProfit && !hasStop ? "🟢 Take-Profit" : "🔴 Risk-Exit"} Triggered — ${today}`,
      `Sold ${droppedNames}.${buyWarn}\n\nCheck the dashboard:\n${process.env.APP_URL ?? ""}/?key=${process.env.CRON_SECRET ?? ""}`
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
