import Anthropic from "@anthropic-ai/sdk";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt, buildAnalysisPrompt, SP500_UNIVERSE, type PortfolioContext } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice, fetchMomentum } from "@/lib/market-data";
import { saveRun, updateLatestRun, getLatestRun, getRuns, getPreviousDayRun, computeDailyReturn, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { getInfluencerSignals, formatInfluencerSignals, isInfluencerDowntrend, type MomentumSignal } from "@/lib/influencer-signals";
import { computeSectorSlices, formatSectorExposure, computeBookBeta, formatBookBeta } from "@/lib/risk-metrics";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";
import { fetchAgenticBalance } from "@/lib/robinhood-balance";

export const maxDuration = 300;

// Risk section injected into the buy prompt: current book β vs SPY + sector exposure.
// Gives the agent the "how much beta / sector risk am I already carrying" baseline so
// it can weigh each new buy's MARGINAL impact (see buildAnalysisPrompt) instead of
// picking names in isolation. Beta per holding is looked up from today's market data.
function buildRiskSection(
  positions: Array<{ symbol: string; quantity: string; avgCost: string }>,
  priceMap: Map<string, number>,
  stocks: Array<{ symbol: string; beta: number | null }>,
): string {
  const betaMap = new Map<string, number | null>(stocks.map(s => [s.symbol, s.beta]));
  const valued = positions.map(p => ({
    symbol: p.symbol,
    value: parseFloat(p.quantity) * (priceMap.get(p.symbol) ?? parseFloat(p.avgCost)),
  }));
  return formatBookBeta(computeBookBeta(valued, (s) => betaMap.get(s))) + formatSectorExposure(computeSectorSlices(valued));
}

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";
const sp500Set = new Set(SP500_UNIVERSE);

// Live balance (settled buying power, total value, unsettled = cash − buying power) —
// shared with drop-check/earnings-exit via lib/robinhood-balance.
const fetchAgenticBuyingPower = fetchAgenticBalance;

// ── Pre-flight buy sizing ────────────────────────────────────────────────────
// The model sizes buys against an estimated budget, but (a) today's sells settle T+1
// so they DON'T add to today's buying power, (b) the live price ticks above the 7:30am
// thesis estimate, and (c) the broker keeps a small buffer — so a marginal buy gets
// REJECTED and its cash sits idle (GPN squeezed out 07-01, ~$302 left unspent).
// Fix deterministically BEFORE placing orders: reserve a BUFFER, cost each buy with a
// price CUSHION, keep what fits in priority order, and SHRINK the marginal buy's qty to
// fit rather than losing it — so settled cash deploys fully and nothing gets rejected.
const BUY_BUFFER_PCT = 0.03;   // leave 3% of settled buying power unspent (broker buffer)
const BUY_PRICE_CUSHION = 1.02; // budget each buy 2% above the thesis price (live tick)
function fitBuysToBudget<T extends { symbol: string; quantity: number; price: number }>(
  buys: T[],
  settledBuyingPower: number,
): { sized: T[]; adjustments: string[] } {
  let budget = settledBuyingPower * (1 - BUY_BUFFER_PCT);
  const sized: T[] = [];
  const adjustments: string[] = [];
  for (const b of buys) {
    const unit = b.price * BUY_PRICE_CUSHION;
    if (!(unit > 0)) { sized.push(b); continue; } // no price → let the session try as-is
    const maxQty = Math.floor(budget / unit);
    if (maxQty >= b.quantity) {
      sized.push(b);
      budget -= b.quantity * unit;
    } else if (maxQty >= 1) {
      sized.push({ ...b, quantity: maxQty });
      adjustments.push(`${b.symbol} ${b.quantity}→${maxQty} (fit budget)`);
      budget -= maxQty * unit;
    } else {
      adjustments.push(`${b.symbol} dropped (needs ~$${Math.round(b.quantity * unit)}, $${Math.round(budget)} left)`);
    }
  }
  return { sized, adjustments };
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

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const simulateCash = url.searchParams.get("simulateCash");

  try {
    const today = new Date().toISOString().split("T")[0];

    if (isMarketHoliday(today)) {
      console.log("MARKET_HOLIDAY_SKIP", { date: today });
      return Response.json({ skipped: true, reason: "market holiday", date: today });
    }

    // ── DRY RUN ───────────────────────────────────────────────────────────────
    // Analysis only: no MCP, no orders, no saveRun. Lets us validate that influencer
    // signals flow into Sonnet's decision (and the influencer cap) without real trades.
    if (dryRun) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const [marketData, previousRun, influencerCache] = await Promise.all([
        getMarketData(),
        getLatestRun(),
        getInfluencerSignals(),
      ]);
      const priceMap = new Map<string, number>(marketData.stocks.map(s => [s.symbol, s.price]));

      // Price + 5d momentum for influencer tickers (downtrend screen)
      let influencerSection = "";
      const influencerMomentum = new Map<string, MomentumSignal>();
      if (influencerCache && Object.keys(influencerCache.tickerCounts).length > 0) {
        const topTickers = Object.entries(influencerCache.tickerCounts)
          .sort(([, a], [, b]) => b - a).slice(0, 12).map(([t]) => t);
        const moms = await Promise.allSettled(topTickers.map(t => fetchMomentum(t).then(m => ({ t, m }))));
        for (const r of moms) if (r.status === "fulfilled" && r.value.m) { priceMap.set(r.value.t, r.value.m.price); influencerMomentum.set(r.value.t, { change5d: r.value.m.change5d, distFromHigh: r.value.m.distFromHigh, aboveShortMA: r.value.m.aboveShortMA }); }
        influencerSection = formatInfluencerSignals(influencerCache, priceMap, influencerMomentum);
      }

      const buyingPower = simulateCash ? parseFloat(simulateCash) : parseFloat(previousRun?.portfolioAfter?.cash ?? "0");
      const portfolioCtx: PortfolioContext = {
        buyingPower: `$${buyingPower.toFixed(2)} (SIMULATED — dry run)`,
        totalValue: `$${previousRun?.portfolioAfter?.totalValue ?? "0"} (estimated)`,
        positions: (previousRun?.positions ?? []).map(p => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })),
      };
      const sectorSection = buildRiskSection(previousRun?.positions ?? [], priceMap, marketData.stocks);

      const analysisResp = await (anthropic.beta.messages as any).create({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system: buildAnalysisPrompt(today, formatMarketDataForPrompt(marketData), portfolioCtx, influencerSection, sectorSection),
        messages: [{ role: "user", content: "Analyze and decide. Output your thesis then the TRADE_DECISION line." }],
      });
      const analysisText = analysisResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

      type DryDecision = { thesis: string; sells: Array<{ symbol: string; quantity: number }>; buys: Array<{ symbol: string; quantity: number; price: number; strategy?: string }> };
      let decision: DryDecision = { thesis: "", sells: [], buys: [] };
      const m = analysisText.match(/^TRADE_DECISION:(.+)$/m);
      if (m) { try { decision = JSON.parse(m[1]); } catch { /* keep empty */ } }

      // Apply the same influencer cap + downtrend guard the real run uses (display only)
      const keptInfluencer = (previousRun?.influencerPositions ?? []).filter(p => !decision.sells.some(s => s.symbol === p.symbol)).length;
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) => b.strategy === "influencer" || !sp500Set.has(b.symbol);
      const annotatedBuys = decision.buys.map(b => {
        const mom = influencerMomentum.get(b.symbol);
        const downtrendRejected = isInfluencerBuy(b) && isInfluencerDowntrend(mom);
        return { ...b, resolvedStrategy: isInfluencerBuy(b) ? "influencer" : "main", momentum: mom ?? null, downtrendRejected };
      });
      const influencerBuys = annotatedBuys.filter(b => b.resolvedStrategy === "influencer");
      const allowedNew = Math.max(0, 2 - keptInfluencer);
      // Preview the pre-flight buy sizing the real run now applies.
      const { sized: sizedBuys, adjustments: sizingAdjustments } = fitBuysToBudget(decision.buys, buyingPower);

      return Response.json({
        dryRun: true,
        simulateCash: buyingPower,
        influencerSignalsAvailable: influencerCache?.signals.length ?? 0,
        topInfluencerTickers: Object.entries(influencerCache?.tickerCounts ?? {}).sort(([, a], [, b]) => b - a).slice(0, 8).map(([t, s]) => `${t}(${s})`),
        influencerSectionInjected: influencerSection.length > 0,
        decision: { thesis: decision.thesis, sells: decision.sells, buys: annotatedBuys },
        influencerCap: { keptInfluencer, allowedNew, influencerBuysRequested: influencerBuys.length, wouldTrim: Math.max(0, influencerBuys.length - allowedNew) },
        buySizing: { settledBuyingPower: buyingPower, adjustments: sizingAdjustments, sizedBuys: sizedBuys.map(b => ({ symbol: b.symbol, quantity: b.quantity, price: b.price })) },
        thesisPreview: analysisText.slice(0, 1200),
      });
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

    const priceMap = new Map<string, number>(marketData.stocks.map(s => [s.symbol, s.price]));

    // Fetch live prices + 5-day momentum for top influencer tickers (downtrend screen)
    let influencerSection = "";
    const influencerMomentum = new Map<string, MomentumSignal>();
    if (influencerCache && Object.keys(influencerCache.tickerCounts).length > 0) {
      const topInfluencerTickers = Object.entries(influencerCache.tickerCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12)
        .map(([t]) => t);
      const moms = await Promise.allSettled(topInfluencerTickers.map(t => fetchMomentum(t).then(m => ({ t, m }))));
      for (const r of moms) {
        if (r.status === "fulfilled" && r.value.m) {
          priceMap.set(r.value.t, r.value.m.price);
          influencerMomentum.set(r.value.t, { change5d: r.value.m.change5d, distFromHigh: r.value.m.distFromHigh, aboveShortMA: r.value.m.aboveShortMA });
        }
      }
      influencerSection = formatInfluencerSignals(influencerCache, priceMap, influencerMomentum);
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

    // Current book β + sector exposure → fed into the prompt so the agent can weigh each
    // buy's marginal risk impact and respect the 40% soft cap.
    const sectorSection = buildRiskSection(portfolioCtx?.positions ?? [], priceMap, marketData.stocks);

    const runTimestamp = new Date().toISOString();
    let textContent = "";
    let trades: TradeSnapshot[] = [];

    // ── SESSION 1: Analysis (Sonnet, no MCP) ────────────────────────────────
    // Pure reasoning — no tool calls. Should complete in ~30-60s.
    const analysisController = new AbortController();
    const analysisKillTimer = setTimeout(() => analysisController.abort(), 150_000);
    let analysisText = "";
    try {
      const analysisResp = await (anthropic.beta.messages as any).create({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system: buildAnalysisPrompt(today, formatMarketDataForPrompt(marketData), portfolioCtx!, influencerSection, sectorSection),
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

    // ── Hard cap: max concurrent influencer positions ─────────────────────────
    // The influencer bucket is high-risk by design; limit concentration regardless
    // of what the model decides. Count positions we'd KEEP plus NEW influencer buys.
    const MAX_INFLUENCER_POSITIONS = 2;
    {
      const soldSet = new Set(decision.sells.map(s => s.symbol));
      const keptInfluencer = (previousRun?.influencerPositions ?? []).filter(p => !soldSet.has(p.symbol)).length;
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || !sp500Set.has(b.symbol);
      const allowedNew = Math.max(0, MAX_INFLUENCER_POSITIONS - keptInfluencer);
      let kept = 0;
      const trimmed: string[] = [];
      decision.buys = decision.buys.filter(b => {
        if (!isInfluencerBuy(b)) return true;       // main picks unaffected
        if (kept < allowedNew) { kept++; return true; }
        trimmed.push(b.symbol);
        return false;
      });
      if (trimmed.length > 0) {
        console.log("INFLUENCER_CAP_TRIMMED", { keptInfluencer, allowedNew, trimmed });
      }
    }

    // ── Pre-buy momentum guard: reject influencer picks in a clear downtrend ──────
    // The influencer signal measures popularity, not price trend — a stock can be the
    // most-talked-about one precisely because it's crashing (SPCX bought mid-decline).
    // Don't buy a falling knife; the −5% stop is cleanup, not a substitute for this.
    {
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || !sp500Set.has(b.symbol);
      const rejected: string[] = [];
      decision.buys = decision.buys.filter(b => {
        if (!isInfluencerBuy(b)) return true; // main strategy already screens momentum
        const mom = influencerMomentum.get(b.symbol);
        if (isInfluencerDowntrend(mom)) {
          rejected.push(`${b.symbol} (5d ${mom!.change5d.toFixed(0)}%, ${mom!.distFromHigh.toFixed(0)}% off high)`);
          return false;
        }
        return true;
      });
      if (rejected.length > 0) {
        console.log("INFLUENCER_DOWNTREND_REJECTED", { rejected });
      }
    }

    // ── Pre-flight buy sizing: fit buys into live settled buying power ────────────
    // (sells today settle T+1 → they don't fund today's buys; size against real BP)
    if (decision.buys.length > 0 && agenticBalance) {
      const { sized, adjustments } = fitBuysToBudget(decision.buys, agenticBalance.buyingPower);
      if (adjustments.length > 0) {
        console.log("BUY_SIZING_ADJUSTED", { settledBuyingPower: agenticBalance.buyingPower, adjustments });
      }
      decision.buys = sized;
    }

    const mcpServer = { type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken };

    // ── SESSION 2: Execute sells (Haiku, MCP) — sequential + verify + retry ───
    // Placing orders ONE AT A TIME (not "simultaneously") avoids the model dropping
    // an order from a batched multi-tool-call. Then we verify each decided sell
    // actually hit Robinhood and retry any that didn't, so a silent drop can't pass.
    const sellStrategyTag = (sym: string) =>
      (previousRun?.trades ?? []).find(t => t.side === "buy" && t.symbol === sym)?.strategy;

    async function runSellSession(sells: Array<{ symbol: string; quantity: number }>, timeoutMs: number): Promise<boolean> {
      if (sells.length === 0) return true;
      const lines = sells.map(s => `- sell ${s.symbol} ${s.quantity} shares`).join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market sell orders one at a time for account ${ACCOUNT} using place_equity_order. Use type=market, time_in_force=gfd. Place each order sequentially and wait for confirmation before the next. Do not skip any. Do not analyze — just execute.\n${lines}\nOutput: SELLS_DONE`,
          messages: [{ role: "user", content: "Execute the sells now, one at a time." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log("SELLS_DONE", { count: sells.length, result: txt.slice(0, 100) });
        return true;
      } catch (e) {
        console.warn("SELLS_FAILED", e instanceof Error ? e.message : String(e));
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
        const m = txt.match(/^VERIFIED_SELLS:(.+)$/m);
        if (!m) return new Map();
        const orders = JSON.parse(m[1]) as VerifiedSell[];
        return new Map(orders.map(o => [o.symbol, o]));
      } catch {
        return new Map();
      } finally {
        clearTimeout(timer);
      }
    }

    if (decision.sells.length > 0) {
      const ok = await runSellSession(decision.sells, 120_000);
      if (ok) {
        let verified = await verifySells();
        let missing = decision.sells.filter(s => !verified.has(s.symbol));
        if (missing.length > 0) {
          console.warn("SELL_VERIFY_MISSING — retrying", { missing: missing.map(s => s.symbol) });
          await runSellSession(missing, 90_000); // retry only the dropped orders
          verified = await verifySells();
          missing = decision.sells.filter(s => !verified.has(s.symbol));
        }
        // Record ONLY confirmed sells. A decided sell with no confirmed order didn't
        // execute — leave it unrecorded (the position stays held) and alert.
        for (const s of decision.sells) {
          const v = verified.get(s.symbol);
          if (!v) continue;
          const fill = parseFloat(v.avgPrice) > 0 ? v.avgPrice : String(priceMap.get(s.symbol) ?? 0);
          trades.push({ symbol: s.symbol, side: "sell", quantity: v.quantity, avgPrice: fill, state: v.state, strategy: sellStrategyTag(s.symbol) });
        }
        if (missing.length > 0) {
          console.warn("SELL_STILL_MISSING_AFTER_RETRY", { missing: missing.map(s => s.symbol) });
          await sendAlert(
            `⚠️ Sell orders not confirmed — ${today}`,
            `These decided sells did NOT execute even after a retry: ${missing.map(s => s.symbol).join(", ")}.\nThey are still held. The next run will re-attempt, or place them manually in Robinhood.`,
          );
        }
      }
    }

    // ── SESSION 3: Execute buys (Haiku, MCP) — sequential + verify + retry ────
    // Mirrors the sell flow: place one at a time, verify each decided buy actually hit
    // Robinhood, retry any that didn't ONCE, then record ONLY confirmed buys with real
    // fill data. A buy that never confirms (insufficient buying power, or a dropped
    // order) is left unrecorded + alerted. The buy-sizing pre-flight already prevents
    // most buying-power rejections; this catches dropped orders (the buy-side BAX case).
    type VerifiedBuy = { symbol: string; quantity: string; avgPrice: string; state: string };
    async function runBuySession(buys: typeof decision.buys, timeoutMs: number): Promise<boolean> {
      if (buys.length === 0) return true;
      const lines = buys.map(b => `- buy ${b.symbol} ${b.quantity} shares`).join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market buy orders one at a time for account ${ACCOUNT} using place_equity_order. Use type=market, time_in_force=gfd. Place each order sequentially and wait for confirmation before the next. Do not skip any. Do not analyze — just execute.\n${lines}\nOutput: BUYS_DONE`,
          messages: [{ role: "user", content: "Execute the buys now, one at a time." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log("BUYS_DONE", { count: buys.length, result: txt.slice(0, 100) });
        return true;
      } catch (e) {
        console.warn("BUYS_FAILED", e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        clearTimeout(timer);
      }
    }
    async function verifyBuys(): Promise<Map<string, VerifiedBuy>> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_BUYS:[{"symbol":"XX","quantity":"X","avgPrice":"XX.XX","state":"XX"}]
Include only BUY orders placed today that are filled or pending (not cancelled/rejected). If none, output VERIFIED_BUYS:[]. Output nothing else.`,
          messages: [{ role: "user", content: "Verify today's buy orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const m = txt.match(/^VERIFIED_BUYS:(.+)$/m);
        if (!m) return new Map();
        const orders = JSON.parse(m[1]) as VerifiedBuy[];
        return new Map(orders.map(o => [o.symbol, o]));
      } catch {
        return new Map();
      } finally {
        clearTimeout(timer);
      }
    }

    if (decision.buys.length > 0) {
      const ok = await runBuySession(decision.buys, 120_000);
      if (ok) {
        let verified = await verifyBuys();
        let missing = decision.buys.filter(b => !verified.has(b.symbol));
        if (missing.length > 0) {
          console.warn("BUY_VERIFY_MISSING — retrying", { missing: missing.map(b => b.symbol) });
          await runBuySession(missing, 90_000); // retry only the dropped/unconfirmed buys
          verified = await verifyBuys();
          missing = decision.buys.filter(b => !verified.has(b.symbol));
        }
        // Record ONLY confirmed buys with real fill data (preserve strategy tag).
        // Any non-S&P 500 ticker (expanded universe) can ONLY belong to the influencer bucket.
        for (const b of decision.buys) {
          const real = verified.get(b.symbol);
          if (!real) continue;
          const strategy: "main" | "influencer" =
            (b.strategy === "influencer" || !sp500Set.has(b.symbol)) ? "influencer" : "main";
          trades.push({ symbol: b.symbol, side: "buy", quantity: real.quantity, avgPrice: real.avgPrice, state: real.state, strategy });
        }
        if (missing.length > 0) {
          console.warn("BUY_STILL_MISSING_AFTER_RETRY", { missing: missing.map(b => b.symbol) });
          await sendAlert(
            `⚠️ Buy orders not confirmed — ${today}`,
            `These decided buys did NOT execute even after a retry: ${missing.map(b => b.symbol).join(", ")}.\nLikely insufficient buying power (today's sells settle T+1) or a dropped order. Place manually if still wanted; the next run re-evaluates.`,
          );
        }
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

    // Unsettled sell proceeds (T+1): this run's sell proceeds are locked until the
    // next trading day. Computed from the sell trades (deterministic) — NOT Robinhood's
    // unsettled_funds field, which returns 0. Included in totalValue so the account
    // value isn't understated by this amount on sell days (settled cash excludes it and
    // equity already dropped). The daily RETURN is position-based, so this only corrects
    // the displayed value and the impliedTransfer diagnostic — it can't distort returns.
    // Prefer the LIVE unsettled (total cash − settled buying power) from the post-trade
    // balance — it's the ground truth and captures sells that filled today from a prior
    // run (e.g. a queued stop that filled at the open). Fall back to summing this run's
    // sell proceeds only if the live balance is unavailable.
    const sellProceeds = trades
      .filter(t => t.side === "sell")
      .reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
    const unsettledAfter = (liveBalanceAfter?.unsettled ?? 0) > 0
      ? liveBalanceAfter!.unsettled
      : (isFinite(sellProceeds) && sellProceeds > 0 ? sellProceeds : 0);

    const equityAfter = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
    const portfolioAfter = {
      totalValue: (cashAfter + unsettledAfter + equityAfter).toFixed(2),
      cash: cashAfter.toFixed(2),
      equity: equityAfter.toFixed(2),
      unsettledCash: unsettledAfter.toFixed(2),
    };
    console.log("SNAPSHOT_BUILT", { cash: cashAfter, unsettled: unsettledAfter, positions: positions.length, trades: trades.length });

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

    // Save core run so orders + positions are persisted even if a later step fails.
    // (Personal-account comparison removed: the agentic MCP token is sandboxed to the
    // agentic account — agentic_allowed:false on the individual account — so the personal
    // snapshot could never be read; the fetch just hung ~25s every run.)
    await saveRun({ ...baseRun, portfolioAfter, positions, trades, personal: null });
    console.log("CORE_RUN_SAVED");

    // Compute transfer-adjusted daily return.
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

    // Main book = the core S&P sleeve (positions NOT in the influencer set). Stored here
    // in the clean trade-time context so the dashboard can show the core strategy isolated
    // from the influencer drag — reconstructing it later from repaired snapshots is unreliable.
    const mainPositions = positions.filter(p => !influencerSymbols.has(p.symbol));
    const prevDayInfluencerSyms = new Set((previousDayRun?.influencerPositions ?? []).map(p => p.symbol));
    const prevMainPositions = (previousDayRun?.positions ?? []).filter(p => !prevDayInfluencerSyms.has(p.symbol));
    const mainResult = mainPositions.length > 0 && prevMainPositions.length > 0
      ? computeDailyReturn(
          mainPositions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0),
          prevMainPositions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0),
          mainPositions,
          prevMainPositions,
          trades.filter(t => !influencerSymbols.has(t.symbol))
        )
      : null;

    // Patch the run already saved at index 0 with return metrics.
    await updateLatestRun({
      ...baseRun,
      portfolioAfter,
      positions,
      trades,
      personal: null,
      influencerPositions,
      agenticDailyReturn: agenticResult?.dailyReturn ?? null,
      agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null,
      influencerDailyReturn: influencerResult?.dailyReturn ?? null,
      mainDailyReturn: mainResult?.dailyReturn ?? null,
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
