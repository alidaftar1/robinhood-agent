import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt, buildAnalysisPrompt, SP500_UNIVERSE, type PortfolioContext } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice } from "@/lib/market-data";
import { saveRun, updateLatestRun, getLatestRun, getRuns, getPreviousDayRun, computeDailyReturn, type PositionSnapshot, type TradeSnapshot, type PersonalSnapshot } from "@/lib/run-store";
import { getInfluencerSignals, formatInfluencerSignals } from "@/lib/influencer-signals";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";

export const maxDuration = 300;

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";
const PERSONAL_ACCOUNT = process.env.PERSONAL_ACCOUNT_ID ?? "";
const sp500Set = new Set(SP500_UNIVERSE);

async function fetchAgenticBuyingPower(
  anthropic: Anthropic,
  accessToken: string
): Promise<{ buyingPower: number; totalValue: number } | null> {
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `Call get_portfolio for account ${ACCOUNT}. Output exactly one line:
AGENTIC_BALANCE:{"buyingPower":"XX.XX","totalValue":"XX.XX"}
Use buying_power.buying_power for buyingPower and total_value for totalValue. Output nothing else.`,
      messages: [{ role: "user", content: `Fetch live balance for account ${ACCOUNT}.` }],
      mcp_servers: [{ type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    clearTimeout(killTimer);
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^AGENTIC_BALANCE:(.+)$/m);
    if (!match) return null;
    const p = JSON.parse(match[1]);
    const bp = parseFloat(String(p.buyingPower ?? "0"));
    const tv = parseFloat(String(p.totalValue ?? "0"));
    return (bp > 0 || tv > 0) ? { buyingPower: bp, totalValue: tv } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

async function fetchAgenticPositions(
  anthropic: Anthropic,
  accessToken: string
): Promise<Array<{ symbol: string; quantity: string; avgCost: string }> | null> {
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: `Call get_equity_positions for account ${ACCOUNT}. Output exactly one line:
AGENTIC_POSITIONS:[{"symbol":"XX","quantity":"X","avgCost":"XX.XX"}]
Use instrument_symbol for symbol, quantity for quantity, average_buy_price for avgCost. If no positions, output AGENTIC_POSITIONS:[]. Output nothing else.`,
      messages: [{ role: "user", content: `Fetch live positions for account ${ACCOUNT}.` }],
      mcp_servers: [{ type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken }],
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

async function fetchPersonalSnapshot(
  anthropic: Anthropic,
  accessToken: string,
  priceMap: Map<string, number>
): Promise<PersonalSnapshot | null> {
  const controller = new AbortController();
  // Hard-kill the Anthropic API call after 25s — Robinhood MCP hangs indefinitely
  // when called with a non-agentic account ID, so we can't rely on Promise.race
  const killTimer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await (anthropic.beta.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are a data fetching assistant. Call get_portfolio(account=${PERSONAL_ACCOUNT}) and get_equity_positions(account=${PERSONAL_ACCOUNT}) simultaneously. Then output exactly one line:
PERSONAL_SNAPSHOT:{"totalValue":"XX.XX","cash":"XX.XX","positions":[{"symbol":"XX","quantity":"X","price":"XX.XX"}]}
Where totalValue = equity value + buying_power from get_portfolio, cash = buying_power, positions = from get_equity_positions with each position's last_trade_price. Output nothing else.`,
      messages: [{ role: "user", content: `Fetch account ${PERSONAL_ACCOUNT} snapshot now.` }],
      mcp_servers: [{
        type: "url",
        url: "https://agent.robinhood.com/mcp/trading",
        name: "robinhood",
        authorization_token: accessToken,
      }],
      betas: ["mcp-client-2025-04-04"],
    }, { signal: controller.signal });
    clearTimeout(killTimer);
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const match = text.match(/^PERSONAL_SNAPSHOT:(.+)$/m);
    if (!match) return null;
    const p = JSON.parse(match[1]);
    const positions: PositionSnapshot[] = (p.positions ?? []).map((pos: any) => ({
      symbol: String(pos.symbol ?? ""),
      quantity: String(pos.quantity ?? "0"),
      avgCost: "0",
      price: String(priceMap.get(String(pos.symbol ?? "")) ?? pos.price ?? 0),
    }));
    const cash = parseFloat(String(p.cash ?? "0"));
    const equity = positions.reduce((s, pos) => s + parseFloat(pos.quantity) * parseFloat(pos.price), 0);
    return {
      totalValue: (cash + equity).toFixed(2),
      cash: cash.toFixed(2),
      positions,
      trades: [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    if (isMarketHoliday(today)) {
      console.log("MARKET_HOLIDAY_SKIP", { date: today });
      return Response.json({ skipped: true, reason: "market holiday", date: today });
    }

    console.log("TRADE_START");
    // Fetch market data and previous run in parallel — no Robinhood REST calls
    // (the Claude MCP client token only works for the MCP endpoint, not direct REST API)
    const accessToken = await getValidAccessToken();
    console.log("TOKEN_OK");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const [marketData, spyPrice, previousRun, previousDayRun, agenticBalance, livePositions, influencerCache] = await Promise.all([
      getMarketData(),
      fetchCurrentPrice("SPY"),
      getLatestRun(),
      getPreviousDayRun(today),
      fetchAgenticBuyingPower(anthropic, accessToken),
      fetchAgenticPositions(anthropic, accessToken),
      getInfluencerSignals(),
    ]);
    console.log("MARKET_DATA_OK", { stocks: marketData.stocks.length });
    if (agenticBalance) {
      console.log("AGENTIC_BALANCE_OK", { buyingPower: agenticBalance.buyingPower, totalValue: agenticBalance.totalValue });
    } else {
      // MCP token likely expired — balance fetch timed out. Alert and abort rather than hanging 5min.
      console.error("AGENTIC_BALANCE_MISSING — MCP token may be expired, aborting to avoid 5min hang");
      await sendAlert("Trade cron aborted: MCP token expired", "Balance fetch returned nothing — Robinhood MCP token appears expired. Re-authenticate and update Vercel env vars.");
      return Response.json({ skipped: true, reason: "mcp_token_expired" });
    }
    const tradingStart = Date.now();

    const priceMap = new Map<string, number>(marketData.stocks.map(s => [s.symbol, s.price]));

    // Fetch live prices for top influencer tickers (those outside the SP500 universe)
    let influencerSection = "";
    if (influencerCache && Object.keys(influencerCache.tickerCounts).length > 0) {
      const topInfluencerTickers = Object.entries(influencerCache.tickerCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12)
        .map(([t]) => t)
        .filter(t => !priceMap.has(t)); // only fetch those not already in market data
      if (topInfluencerTickers.length > 0) {
        const extraPrices = await Promise.allSettled(topInfluencerTickers.map(t => fetchCurrentPrice(t).then(p => ({ t, p }))));
        for (const r of extraPrices) {
          if (r.status === "fulfilled" && r.value.p != null) {
            priceMap.set(r.value.t, r.value.p);
          }
        }
      }
      influencerSection = formatInfluencerSignals(influencerCache, priceMap);
    }

    // Always inject portfolio state so Claude never needs to call get_portfolio or get_equity_positions.
    // Use live Haiku-fetched data when available; fall back to previous run estimate.
    let portfolioCtx: PortfolioContext | undefined;
    if (agenticBalance) {
      let positions: Array<{ symbol: string; quantity: string; avgCost: string }>;
      if (livePositions !== null) {
        positions = livePositions;
        console.log("LIVE_POSITIONS_OK", { count: positions.length });
      } else {
        // Fall back to estimating from previous run
        const prevTrades = previousRun?.trades ?? [];
        const soldSymbols = new Set(prevTrades.filter(t => t.side === "sell").map(t => t.symbol));
        positions = (previousRun?.positions ?? []).filter(p => !soldSymbols.has(p.symbol));
        console.log("LIVE_POSITIONS_MISSING — using previous run estimate", { count: positions.length });
      }
      portfolioCtx = {
        buyingPower: `$${agenticBalance.buyingPower.toFixed(2)} (live from Robinhood)`,
        totalValue: `$${agenticBalance.totalValue.toFixed(2)} (live from Robinhood)`,
        positions: positions.map(p => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })),
      };
    }

    const runTimestamp = new Date().toISOString();
    let textContent = "";
    let trades: TradeSnapshot[] = [];
    let personal: PersonalSnapshot | null = null;

    // ── SESSION 1: Analysis (Sonnet, no MCP) ────────────────────────────────
    // Pure reasoning — no tool calls. Should complete in ~30-60s.
    const analysisController = new AbortController();
    const analysisKillTimer = setTimeout(() => analysisController.abort(), 150_000);
    let analysisText = "";
    try {
      const analysisResp = await (anthropic.beta.messages as any).create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: buildAnalysisPrompt(today, formatMarketDataForPrompt(marketData), portfolioCtx!, influencerSection),
        messages: [{ role: "user", content: "Analyze and decide. Output your thesis then the TRADE_DECISION line." }],
      }, { signal: analysisController.signal });
      analysisText = analysisResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      console.log("ANALYSIS_DONE", { length: analysisText.length });
    } finally {
      clearTimeout(analysisKillTimer);
    }
    textContent = analysisText;

    // Parse TRADE_DECISION
    type TradeDecision = { thesis: string; sells: Array<{ symbol: string; quantity: number }>; buys: Array<{ symbol: string; quantity: number; price: number; strategy?: string }> };
    let decision: TradeDecision = { thesis: "", sells: [], buys: [] };
    const decisionMatch = analysisText.match(/^TRADE_DECISION:(.+)$/m);
    if (decisionMatch) {
      try {
        decision = JSON.parse(decisionMatch[1]);
        console.log("DECISION_PARSED", { sells: decision.sells.length, buys: decision.buys.length });
      } catch (e) {
        console.warn("DECISION_PARSE_FAILED", e instanceof Error ? e.message : String(e));
      }
    } else {
      console.warn("DECISION_MISSING — no TRADE_DECISION found in analysis output");
    }

    const mcpServer = { type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken };

    // ── SESSION 2: Execute sells (Haiku, MCP) ────────────────────────────────
    if (decision.sells.length > 0) {
      const sellLines = decision.sells.map(s => `- sell ${s.symbol} ${s.quantity} shares`).join("\n");
      const sellController = new AbortController();
      const sellKillTimer = setTimeout(() => sellController.abort(), 120_000);
      try {
        const sellResp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market sell orders for account ${ACCOUNT} simultaneously using place_equity_order. Use type=market, time_in_force=gfd. Do not analyze — just execute.\n${sellLines}\nOutput: SELLS_DONE`,
          messages: [{ role: "user", content: "Execute the sells now." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: sellController.signal });
        const sellText = sellResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log("SELLS_DONE", { result: sellText.slice(0, 100) });
        // Inherit strategy tag from the previous run's buy trade for this position
        const prevTrades = previousRun?.trades ?? [];
        for (const s of decision.sells) {
          const origBuy = prevTrades.find(t => t.side === "buy" && t.symbol === s.symbol);
          trades.push({ symbol: s.symbol, side: "sell", quantity: String(s.quantity), avgPrice: String(priceMap.get(s.symbol) ?? 0), state: "filled", strategy: origBuy?.strategy });
        }
      } catch (e) {
        console.warn("SELLS_FAILED", e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(sellKillTimer);
      }
    }

    // ── SESSION 3: Execute buys (Haiku, MCP) ─────────────────────────────────
    let buysAttempted = false;
    let buysSessionSucceeded = false;
    if (decision.buys.length > 0) {
      buysAttempted = true;
      const buyLines = decision.buys.map(b => `- buy ${b.symbol} ${b.quantity} shares`).join("\n");
      const buyController = new AbortController();
      const buyKillTimer = setTimeout(() => buyController.abort(), 120_000);
      try {
        const buyResp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market buy orders one at a time for account ${ACCOUNT} using place_equity_order. Use type=market, time_in_force=gfd. Place each order sequentially and wait for confirmation before the next. Do not analyze — just execute.\n${buyLines}\nOutput: BUYS_DONE`,
          messages: [{ role: "user", content: "Execute the buys now." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: buyController.signal });
        const buyText = buyResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log("BUYS_DONE", { result: buyText.slice(0, 100) });
        buysSessionSucceeded = true;
        // Temporarily populate with planned prices — verification step below overwrites with real fill data.
        // Guard: any non-S&P 500 ticker (expanded universe) can ONLY belong to the influencer bucket.
        for (const b of decision.buys) {
          const isSP500 = sp500Set.has(b.symbol);
          const strategy: "main" | "influencer" =
            (b.strategy === "influencer" || !isSP500) ? "influencer" : "main";
          trades.push({ symbol: b.symbol, side: "buy", quantity: String(b.quantity), avgPrice: String(b.price), state: "unconfirmed", strategy });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("BUYS_FAILED", msg);
        await sendAlert(
          `⚠️ Buy session failed — ${today}`,
          `The buy execution session threw an error and no orders were placed.\n\nError: ${msg}\n\nPlanned buys:\n${buyLines}\n\nPlace these manually in Robinhood if needed.`
        );
      } finally {
        clearTimeout(buyKillTimer);
      }
    }

    // ── SESSION 4: Verify buys (Haiku, MCP) ──────────────────────────────────
    // Confirms orders actually exist in Robinhood and replaces planned prices with real fill prices.
    // Non-blocking: on timeout or parse failure, keeps unconfirmed placeholder data and logs a warning.
    if (buysAttempted && buysSessionSucceeded) {
      const verifyController = new AbortController();
      const verifyKillTimer = setTimeout(() => verifyController.abort(), 25_000);
      try {
        const verifyResp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_ORDERS:[{"symbol":"XX","side":"buy","quantity":"X","avgPrice":"XX.XX","state":"XX"}]
Include only buy orders placed today. If none found, output VERIFIED_ORDERS:[]. Output nothing else.`,
          messages: [{ role: "user", content: "Verify today's buy orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: verifyController.signal });
        clearTimeout(verifyKillTimer);

        const verifyText = verifyResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const verifyMatch = verifyText.match(/^VERIFIED_ORDERS:(.+)$/m);
        if (verifyMatch) {
          type VerifiedOrder = { symbol: string; side: string; quantity: string; avgPrice: string; state: string };
          const verifiedOrders = JSON.parse(verifyMatch[1]) as VerifiedOrder[];
          const verifiedMap = new Map(verifiedOrders.map(o => [o.symbol, o]));
          console.log("VERIFY_OK", { verified: verifiedOrders.length, planned: decision.buys.length });

          // Replace unconfirmed placeholders with real fill data (preserve strategy tag).
          const strategyBySymbol = new Map(trades.filter(t => t.side === "buy").map(t => [t.symbol, t.strategy]));
          trades = trades.filter(t => t.side !== "buy");
          const missing: string[] = [];
          for (const b of decision.buys) {
            const real = verifiedMap.get(b.symbol);
            if (real) {
              trades.push({ symbol: b.symbol, side: "buy", quantity: real.quantity, avgPrice: real.avgPrice, state: real.state, strategy: strategyBySymbol.get(b.symbol) });
            } else {
              missing.push(b.symbol);
            }
          }

          if (missing.length > 0) {
            console.warn("BUY_VERIFY_MISSING", { missing });
            const buyLines = decision.buys.map(b => `- buy ${b.symbol} ${b.quantity} shares`).join("\n");
            await sendAlert(
              `⚠️ Buy orders not confirmed — ${today}`,
              `Verification found these planned buys missing from Robinhood:\n\nMissing: ${missing.join(", ")}\nAll planned:\n${buyLines}\n\nPlace missing orders manually if needed.`
            );
          }
        } else {
          console.warn("VERIFY_PARSE_FAILED — keeping unconfirmed placeholder data");
        }
      } catch {
        console.warn("VERIFY_TIMED_OUT — keeping unconfirmed placeholder data");
      } finally {
        clearTimeout(verifyKillTimer);
      }
    }

    // Build portfolio snapshot — prefer a live re-fetch from Robinhood so the saved
    // record can never silently drift from the real account (e.g. if a trade was
    // missed by verification, or the account was touched outside this run). Only
    // fall back to reconstructing from the decision delta if the live fetch fails.
    const [liveBalanceAfter, livePositionsAfter] = await Promise.all([
      fetchAgenticBuyingPower(anthropic, accessToken),
      fetchAgenticPositions(anthropic, accessToken),
    ]);

    let positions: PositionSnapshot[];
    let cashAfter: number;

    if (liveBalanceAfter !== null && livePositionsAfter !== null) {
      positions = livePositionsAfter.map(p => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.avgCost,
        price: String(priceMap.get(p.symbol) ?? parseFloat(p.avgCost)),
      }));
      cashAfter = liveBalanceAfter.buyingPower;

      // Infer sells that executed on Robinhood but weren't recorded (e.g. sell session
      // timed out after orders were already placed). Compare pre-trade vs post-trade positions.
      if (livePositions !== null) {
        const afterSymbols = new Set(livePositionsAfter.map(p => p.symbol));
        const recordedSells = new Set(trades.filter(t => t.side === "sell").map(t => t.symbol));
        const missingSells = livePositions.filter(p => !afterSymbols.has(p.symbol) && !recordedSells.has(p.symbol));

        if (missingSells.length > 0) {
          // Use current market price as best estimate of the fill price.
          // The cash-flow identity (cashAfter - cashBefore + buyCost) is unreliable
          // here because cashAfter includes T+1 settlement from the previous day's
          // sells, which has nothing to do with today's inferred sell proceeds.
          for (const pos of missingSells) {
            const avgPrice = priceMap.get(pos.symbol) ?? parseFloat(pos.avgCost);
            trades.push({ symbol: pos.symbol, side: "sell", quantity: pos.quantity, avgPrice: avgPrice.toFixed(2), state: "inferred" });
            console.log("INFERRED_SELL", { symbol: pos.symbol, quantity: pos.quantity, avgPrice: avgPrice.toFixed(2) });
          }
        }
      }

      console.log("POST_TRADE_LIVE_SNAPSHOT_OK", { positions: positions.length, cash: cashAfter });
    } else {
      console.warn("POST_TRADE_LIVE_SNAPSHOT_MISSING — falling back to reconstructed snapshot");
      const soldSymbols = new Set(trades.filter(t => t.side === "sell").map(t => t.symbol));
      const startingPositions = portfolioCtx?.positions ?? [];
      const keptPositions = startingPositions.filter(p => !soldSymbols.has(p.symbol));
      const boughtPositions = trades.filter(t => t.side === "buy").map(t => ({
        symbol: t.symbol, quantity: t.quantity, avgCost: t.avgPrice,
      }));
      positions = [...keptPositions, ...boughtPositions].map(p => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.avgCost,
        price: String(priceMap.get(p.symbol) ?? parseFloat(p.avgCost)),
      }));
      const startingCash = agenticBalance.buyingPower;
      const buyCost = trades.filter(t => t.side === "buy").reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
      cashAfter = Math.max(0, startingCash - buyCost);
    }

    const equityAfter = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
    const portfolioAfter = {
      totalValue: (cashAfter + equityAfter).toFixed(2),
      cash: cashAfter.toFixed(2),
      equity: equityAfter.toFixed(2),
    };
    console.log("SNAPSHOT_BUILT", { cash: cashAfter, positions: positions.length, trades: trades.length });

    const baseRun = {
      timestamp: runTimestamp,
      date: today,
      summary: textContent,
      market: {
        stocksLoaded: marketData.stocks.length,
        headlinesLoaded: marketData.headlines.length,
      },
      ...(spyPrice != null ? { spyPrice } : {}),
    };

    // Save core run immediately — before personal snapshot — so orders + positions
    // are persisted even if the function times out during the slower personal fetch.
    await saveRun({ ...baseRun, portfolioAfter, positions, trades, personal: null });
    console.log("CORE_RUN_SAVED");

    // Fetch personal snapshot after main session (sequential — no MCP interference)
    // AbortController inside fetchPersonalSnapshot kills the call after 25s
    const elapsedMs = Date.now() - tradingStart;
    console.log("PERSONAL_SNAPSHOT_START", { elapsedMs });
    personal = await fetchPersonalSnapshot(anthropic, accessToken, priceMap);
    if (personal) {
      console.log("PERSONAL_SNAPSHOT_PARSED", { totalValue: personal.totalValue, positionCount: personal.positions.length });
    } else {
      console.warn("PERSONAL_SNAPSHOT_MISSING — fetch timed out or returned null");
    }

    // Compute transfer-adjusted daily returns for both accounts.
    // Gather ALL of today's trades (from any earlier same-day runs + this run) so that
    // when multiple cron firings happen on one day, portfolio rotations don't look like transfers.
    const earlierTodayRuns = (await getRuns(20)).filter(
      (r) => r.date === today && r.timestamp < runTimestamp
    );
    const allTradesToday: TradeSnapshot[] = [
      ...earlierTodayRuns.flatMap((r) => r.trades ?? []),
      ...trades,
    ];

    const agenticResult = portfolioAfter && previousDayRun?.portfolioAfter
      ? computeDailyReturn(
          parseFloat(portfolioAfter.totalValue),
          parseFloat(previousDayRun.portfolioAfter.totalValue),
          positions,
          previousDayRun.positions,
          allTradesToday
        )
      : null;

    const personalResult = personal && previousDayRun?.personal
      ? computeDailyReturn(
          parseFloat(personal.totalValue),
          parseFloat(previousDayRun.personal.totalValue),
          personal.positions,
          previousDayRun.personal.positions,
          []
        )
      : null;

    // Derive influencer sub-portfolio: positions that had a buy trade tagged "influencer"
    const influencerBoughtSymbols = new Set(
      trades.filter(t => t.side === "buy" && t.strategy === "influencer").map(t => t.symbol)
    );
    // Also carry forward influencer positions from previous run that weren't sold today
    const prevInfluencerSymbols = new Set(
      (previousRun?.influencerPositions ?? []).map(p => p.symbol)
    );
    const soldSymbolsSet = new Set(trades.filter(t => t.side === "sell").map(t => t.symbol));
    const influencerSymbols = new Set([
      ...influencerBoughtSymbols,
      ...[...prevInfluencerSymbols].filter(s => !soldSymbolsSet.has(s)),
    ]);
    const influencerPositions = positions.filter(p => influencerSymbols.has(p.symbol));

    // Influencer daily return: P&L of influencer positions vs previous day
    const prevInfluencerPositions = previousDayRun?.influencerPositions ?? [];
    const influencerResult = influencerPositions.length > 0 && prevInfluencerPositions.length > 0
      ? computeDailyReturn(
          influencerPositions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0),
          prevInfluencerPositions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0),
          influencerPositions,
          prevInfluencerPositions,
          trades.filter(t => influencerSymbols.has(t.symbol))
        )
      : null;

    // Patch the run already saved at index 0 with personal snapshot + return metrics.
    await updateLatestRun({
      ...baseRun,
      portfolioAfter,
      positions,
      trades,
      personal,
      influencerPositions,
      agenticDailyReturn: agenticResult?.dailyReturn ?? null,
      personalDailyReturn: personalResult?.dailyReturn ?? null,
      agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null,
      personalImpliedTransfer: personalResult?.impliedTransfer ?? null,
      influencerDailyReturn: influencerResult?.dailyReturn ?? null,
    });

    console.log("TRADE_RUN_COMPLETE", { date: today, summary: textContent.slice(0, 300) });
    return Response.json({ success: true, date: today, summary: textContent });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("TRADE_RUN_ERROR", message);
    await sendAlert(
      `🚨 Robinhood Agent failed — ${new Date().toISOString().split("T")[0]}`,
      `The daily trade run failed with the following error:\n\n${message}\n\nCheck Vercel logs for details:\nhttps://vercel.com/ali-daftarians-projects/robinhood-agent/logs`
    );
    return Response.json({ error: message }, { status: 500 });
  }
}
