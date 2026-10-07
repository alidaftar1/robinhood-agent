import { requireCronAuth } from "@/lib/auth";
import * as Sentry from "@sentry/nextjs";
import { createAnthropic } from "@/lib/anthropic";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildV1AnalysisPrompt, SP500_UNIVERSE, maxPositionDollars, isMainRebalanceDay, type PortfolioContext, STALE_DAYS, staleReasonOf } from "@/lib/strategy";
import { getMarketData, fetchCurrentPrice, fetchMomentum, buildV1Shortlist, formatV1Shortlist, enrichPriceMap, formatMarketContext } from "@/lib/market-data";
import { getQualityScores, withBudget, QUALITY_CALL_BUDGET_MS } from "@/lib/quality";
import { saveRun, updateLatestRun, getLatestRun, getRuns, getPreviousDayRun, computeDailyReturn, findUnpriceableTrades, computeSleeveReturns, clampSleeveReturn, mergeRunsByDate, type PositionSnapshot, type TradeSnapshot, MAX_RUNS } from "@/lib/run-store";
import { getInfluencerSignals, formatInfluencerSignals, isInfluencerDowntrend, netScores, INFLUENCER_BUY_FLOOR, type MomentumSignal } from "@/lib/influencer-signals";
import { applyRebuyCooldown, findPostSaleCatalyst, type CooldownExit } from "@/lib/rebuy-cooldown";
import { computeSectorSlices, formatSectorExposure, computeBookBetaForPositions, formatBookBeta } from "@/lib/risk-metrics";
import { sendAlert } from "@/lib/alert";
import { parseTradeDecision, isFullExit, type TradeDecision } from "@/lib/trade-decision";
import { isMarketHoliday, holidayTableCovers } from "@/lib/holidays";
import { fitNotionalBuysToBudget, usableNotionalBudget, applyPerPositionCap, applyConcentrationTrim, resolveSellQuantity, MIN_BUY_DOLLARS } from "@/lib/buy-sizing";
import { getRecentStopouts, getRecentSells, recordSell } from "@/lib/stopouts";
import { recordSignalPicks, type SignalPick } from "@/lib/signal-ledger";
import { screenMeanReversionCandidates, recordMeanRevShadow } from "@/lib/mean-reversion";
import { buildFeatureRows, recordFeatureCapture } from "@/lib/feature-capture";
import { applySellRail, MAX_DISCRETIONARY_EXITS } from "@/lib/sell-rail";
import { TARGET_MAIN_POSITIONS } from "@/lib/position-target";
import { screenGivebackStops, recordGivebackShadow } from "@/lib/giveback-shadow";
import { fetchNewsSignals } from "@/lib/news";
import { getEarningsReleaseAnalyses, formatEarningsReleases, type EarningsReleaseAnalysis } from "@/lib/earnings-release";
import { getValuations, formatValuations } from "@/lib/valuation";
import { formatConviction, convictionAuditNote, loadConvictionRun } from "@/lib/conviction";
import { fetchEarningsForSymbols, fetchEarningsBeatHistory, hasPrintedBySession, normalizeReportDate, type EarningsBeatRecord, type RecentEarnings } from "@/lib/earnings";
import { logTradeRun } from "@/lib/braintrust-trace";
import { inferSellStrategy } from "@/lib/run-store";
import { fetchAgenticBalance, fetchAgenticPositions } from "@/lib/robinhood-balance";

export const maxDuration = 300;

// Risk section injected into the buy prompt: current book β vs SPY + sector exposure.
// Gives the agent the "how much beta / sector risk am I already carrying" baseline so
// it can weigh each new buy's MARGINAL impact (see buildV1AnalysisPrompt) instead of
// picking names in isolation. Beta per holding is looked up from today's market data.
function buildRiskSection(
  positions: Array<{ symbol: string; quantity: string; avgCost: string }>,
  priceMap: Map<string, number>,
  stocks: Array<{ symbol: string; beta: number | null }>,
): string {
  const valued = positions.map(p => ({
    symbol: p.symbol,
    value: parseFloat(p.quantity) * (priceMap.get(p.symbol) ?? parseFloat(p.avgCost)),
  }));
  return formatBookBeta(computeBookBetaForPositions(stocks, valued)) + formatSectorExposure(computeSectorSlices(valued));
}

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";
const sp500Set = new Set(SP500_UNIVERSE);

// Live balance (settled buying power, total value, unsettled = cash − buying power) —
// shared with drop-check/earnings-exit via lib/robinhood-balance.
const fetchAgenticBuyingPower = fetchAgenticBalance;

// Pre-flight buy sizing lives in lib/buy-sizing.ts (pure + unit-tested in evals).


export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const simulateCash = url.searchParams.get("simulateCash");

  try {
    const today = new Date().toISOString().split("T")[0];
    const isRebalanceDay = isMainRebalanceDay(today, isMarketHoliday);
    // Surfaced on the RUN, not just in Vercel logs — a silent console.warn is how the unreachable
    // stale clock went unnoticed in the first place. An ARRAY, not a string: these conditions are
    // independent and can hold together, and a single slot silently dropped one of them.
    const contextWarnings: string[] = [];
    const yr = Number(today.slice(0, 4));
    // Only the CURRENT year is load-bearing: a Mon-Fri window can only span a year boundary in the
    // last week of December, so yr+1 is checked as a maintenance reminder from mid-December only.
    const needsNextYear = today.slice(5, 7) === "12" && Number(today.slice(8, 10)) >= 15;
    if (!holidayTableCovers(yr) || (needsNextYear && !holidayTableCovers(yr + 1))) {
      // Load-bearing now: a lapsed table can point the rebalance at a CLOSED Monday and skip the
      // week's main-book buys with no other symptom.
      const missing = [yr, ...(needsNextYear ? [yr + 1] : [])].filter((y) => !holidayTableCovers(y));
      console.error("HOLIDAY_TABLE_LAPSED — NYSE_HOLIDAYS is missing a year the rebalance window can span; it may land on closed sessions", { missing });
      contextWarnings.push(`CONTEXT — the NYSE holiday table has no entries for ${missing.join(" and ")}. isMarketHoliday now returns false for every real holiday, so the weekly rebalance window can land on CLOSED sessions and skip a week's main-book buys with no other symptom. Update lib/holidays.ts. No order was affected.`);
    }

    if (isMarketHoliday(today)) {
      console.log("MARKET_HOLIDAY_SKIP", { date: today });
      return Response.json({ skipped: true, reason: "market holiday", date: today });
    }

    // ── DRY RUN ───────────────────────────────────────────────────────────────
    // Analysis only: no MCP, no orders, no saveRun. Lets us validate that influencer
    // signals flow into Sonnet's decision (and the influencer cap) without real trades.
    if (dryRun) {
      const anthropic = createAnthropic();
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
        for (const r of moms) if (r.status === "fulfilled" && r.value.m) { priceMap.set(r.value.t, r.value.m.price); influencerMomentum.set(r.value.t, { change1d: r.value.m.change1d, change5d: r.value.m.change5d, distFromHigh: r.value.m.distFromHigh, aboveShortMA: r.value.m.aboveShortMA }); }
        influencerSection = formatInfluencerSignals(influencerCache, priceMap, influencerMomentum);
      }

      const buyingPower = simulateCash ? parseFloat(simulateCash) : parseFloat(previousRun?.portfolioAfter?.cash ?? "0");
      const portfolioCtx: PortfolioContext = {
        buyingPower: `$${usableNotionalBudget(buyingPower).toFixed(2)} (SIMULATED dry run — buffer-reserved spend limit)`,
        totalValue: `$${previousRun?.portfolioAfter?.totalValue ?? "0"} (estimated)`,
        positions: (previousRun?.positions ?? []).map(p => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })),
      };
      const sectorSection = buildRiskSection(previousRun?.positions ?? [], priceMap, marketData.stocks);

      // V1 quality-momentum shortlist (the main-book rails). Falls back to momentum-only if quality data
      // is unavailable so a dry run still produces a book.
      const dryQuality = await getQualityScores();
      const dryEligible = dryQuality
        ? new Set(Object.entries(dryQuality.scores).filter(([, v]) => v.eligible).map(([s]) => s))
        : new Set(marketData.stocks.map(s => s.symbol));
      const dryInfluencerHeld = new Set((previousRun?.influencerPositions ?? []).map(p => p.symbol));
      const dryHeldMain = new Set((previousRun?.positions ?? []).map(p => p.symbol).filter(s => !dryInfluencerHeld.has(s)));
      const { buy: dryBuy, retained: dryRetained } = buildV1Shortlist(marketData.stocks, dryEligible, { held: dryHeldMain });
      const dryShortlistTable = formatV1Shortlist(
        [...dryBuy, ...dryRetained], dryQuality?.scores ?? {}, marketData.insiderBuys, marketData.analystRatings, dryHeldMain,
        new Map(), new Map(), new Map(), new Map(), today,
      );

      const analysisResp = await (anthropic.beta.messages as any).create({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        // analystRatings passed for the same reason the eval harness now passes it: the dry run is
        // the surface a human reads before trusting a prompt change, so a preview missing a field
        // the live path renders is a preview of a different prompt.
        system: buildV1AnalysisPrompt(today, dryShortlistTable, portfolioCtx, influencerSection, sectorSection, (previousRun?.influencerPositions ?? []).map(p => p.symbol), [], [], Object.fromEntries(marketData.stocks.filter(s => s.earningsDate).map(s => [s.symbol, s.earningsDate as string])), new Map(), new Map(), new Map(), {}, {}, [], "", "", isRebalanceDay, "", marketData.analystRatings),
        messages: [{ role: "user", content: "Analyze and decide. Output your thesis then the TRADE_DECISION line." }],
      });
      const analysisText = analysisResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

      // Use the full outcome, not extractTradeDecision — a dry run whose payload is unreadable must
      // not render as a tidy "no trades" preview, which is the same silent-cancel shape the executor
      // path was just fixed to make loud. Surfaced as decisionParseError in the response below.
      const dryParsed = parseTradeDecision(analysisText);
      const decision: TradeDecision = dryParsed.status === "parsed"
        ? dryParsed.decision
        : { thesis: "", sells: [], buys: [] };
      const decisionParseError = dryParsed.status === "unparsed" ? dryParsed.reason : null;

      // Apply the same influencer cap + downtrend guard the real run uses (display only)
      const heldInflQty = new Map((previousRun?.influencerPositions ?? []).map(p => [p.symbol, parseFloat(p.quantity) || 0]));
      const keptInfluencer = (previousRun?.influencerPositions ?? [])
        .filter(p => !decision.sells.some(s => s.symbol === p.symbol && isFullExit(s, heldInflQty.get(p.symbol))))
        .length;
      const dryShortlistSet = new Set(dryBuy.map(s => s.symbol)); // buy-allowlist (retained ◆HELD names excluded)
      const dryInfluencerCandidates = new Set(influencerMomentum.keys());
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) => b.strategy === "influencer" || (dryInfluencerCandidates.has(b.symbol) && !dryShortlistSet.has(b.symbol));
      const annotatedBuys = decision.buys.map(b => {
        const mom = influencerMomentum.get(b.symbol);
        const downtrendRejected = isInfluencerBuy(b) && isInfluencerDowntrend(mom);
        return { ...b, resolvedStrategy: isInfluencerBuy(b) ? "influencer" : "main", momentum: mom ?? null, downtrendRejected };
      });
      const influencerBuys = annotatedBuys.filter(b => b.resolvedStrategy === "influencer");
      const allowedNew = Math.max(0, 2 - keptInfluencer);
      // Preview the pre-flight NOTIONAL buy sizing the real run now applies.
      const { sized: sizedBuys, adjustments: sizingAdjustments } = fitNotionalBuysToBudget(decision.buys, buyingPower);

      return Response.json({
        dryRun: true,
        simulateCash: buyingPower,
        influencerSignalsAvailable: influencerCache?.signals.length ?? 0,
        topInfluencerTickers: Object.entries(influencerCache?.tickerCounts ?? {}).sort(([, a], [, b]) => b - a).slice(0, 8).map(([t, s]) => `${t}(${s})`),
        influencerSectionInjected: influencerSection.length > 0,
        decision: { thesis: decision.thesis, sells: decision.sells, buys: annotatedBuys },
        ...(decisionParseError ? { decisionParseError } : {}),
        influencerCap: { keptInfluencer, allowedNew, influencerBuysRequested: influencerBuys.length, wouldTrim: Math.max(0, influencerBuys.length - allowedNew) },
        buySizing: { settledBuyingPower: buyingPower, adjustments: sizingAdjustments, sizedBuys: sizedBuys.map(b => ({ symbol: b.symbol, dollarAmount: b.dollarAmount })) },
        thesisPreview: analysisText.slice(0, 1200),
      });
    }

    console.log("TRADE_START");
    // Fetch market data and previous run in parallel — no Robinhood REST calls
    // (the Claude MCP client token only works for the MCP endpoint, not direct REST API)
    const accessToken = await getValidAccessToken();
    console.log("TOKEN_OK");
    const anthropic = createAnthropic();
    const [marketData, spyPrice, previousRun, previousDayRun, agenticBalance, livePositions, influencerCache, recentStopouts, recentSells] = await Promise.all([
      getMarketData(),
      fetchCurrentPrice("SPY"),
      getLatestRun(),
      getPreviousDayRun(today),
      fetchAgenticBuyingPower(anthropic, accessToken),
      fetchAgenticPositions(anthropic, accessToken),
      getInfluencerSignals(),
      getRecentStopouts(today),
      getRecentSells(today),
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
    // The decision-time quote, stamped on every trade so execution cost is measurable at all.
    // Omitted rather than zeroed when unknown — a 0 reference would compute as -100% slippage.
    const refPriceOf = (sym: string): { refPrice?: string } => {
      const px = priceMap.get(sym);
      return px != null && px > 0 ? { refPrice: String(px) } : {};
    };

    // Fetch live prices + 5-day momentum for top influencer tickers (downtrend screen)
    let influencerSection = "";
    const influencerMomentum = new Map<string, MomentumSignal>();
    const influencerCandidateSet = new Set<string>(); // symbols the LLM may buy as INFLUENCER picks (the rails allow these off-shortlist)
    // Net influencer conviction (weighted-buy − avoid) per ticker, computed once. Also surfaced as a
    // CROSS-SIGNAL onto MAIN-book shortlist rows (🎬INFL✓/⚠) so a main buy is aware the YouTube crowd
    // corroborates or warns against it. Built even when there are no BUYS (avoid-only names still flag).
    const influencerNet: Record<string, number> = influencerCache ? netScores(influencerCache) : {};
    const influencerX = new Map<string, { net: number; avoid: number }>();
    if (influencerCache) {
      const avoids = influencerCache.avoidCounts ?? {};
      for (const s of new Set([...Object.keys(influencerNet), ...Object.keys(avoids)])) {
        influencerX.set(s, { net: influencerNet[s] ?? 0, avoid: avoids[s] ?? 0 });
      }
    }
    if (influencerCache && Object.keys(influencerCache.tickerCounts).length > 0) {
      // Rank by NET score (buy − avoid), matching formatInfluencerSignals exactly, so every name the
      // LLM is SHOWN is also in the buy-allowlist (no "shown but silently dropped" mismatch).
      const topInfluencerTickers = Object.keys(influencerCache.tickerCounts)
        .sort((a, b) => (influencerNet[b] ?? 0) - (influencerNet[a] ?? 0))
        .slice(0, 12)
        .map((t) => t);
      topInfluencerTickers.forEach(t => influencerCandidateSet.add(t));
      const moms = await Promise.allSettled(topInfluencerTickers.map(t => fetchMomentum(t).then(m => ({ t, m }))));
      for (const r of moms) {
        if (r.status === "fulfilled" && r.value.m) {
          priceMap.set(r.value.t, r.value.m.price);
          influencerMomentum.set(r.value.t, { change1d: r.value.m.change1d, change5d: r.value.m.change5d, distFromHigh: r.value.m.distFromHigh, aboveShortMA: r.value.m.aboveShortMA });
        }
      }
      // Section is BUILT once below, after recentEarnings is fetched, so the 📊REPORTED flag is included.
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
      // Holding age per position (for the staleness time-stop): how many recent trading days each
      // symbol has been held, from the per-date run history. Wrapped so a bad/legacy history record
      // can never abort the trade run (degrades to no ages → rule omitted). BOTH books now — the
      // sleeve has its own (tighter) staleness rotation too. The streak tolerates an isolated 1-day
      // snapshot gap (routine here) and only breaks on a real exit.
      let heldDaysOf: (symbol: string) => number | undefined = () => undefined;
      try {
        // Fetch RECORDS, count DATES. Several routes write extra records on a date that already has
        // one (drop-check exits, earnings-exit, same-day re-runs), so N records is always FEWER than
        // N distinct dates — at the observed ~1.2 records/date, getRuns(60) yielded only ~50 dates
        // and `heldDays >= STALE_DAYS` (60) was unreachable: the main-book time-stop was dead code
        // while its rule text still rendered into every prompt. Pull the full retained history and
        // say so loudly if it still cannot span the clock.
        const history = mergeRunsByDate(await getRuns(MAX_RUNS)); // newest-first, one run per date
        if (history.length < STALE_DAYS) {
          console.warn("STALE_WINDOW_TOO_SHORT — heldDays cannot reach STALE_DAYS, the main-book time-stop cannot fire", {
            distinctDates: history.length, staleDays: STALE_DAYS, maxRuns: MAX_RUNS,
          });
          contextWarnings.push(`CONTEXT — the main-book TIME-STOP cannot fire: only ${history.length} distinct run dates are retained but STALE_DAYS is ${STALE_DAYS}. Raise MAX_RUNS (currently ${MAX_RUNS} records, shared across dates) or lower STALE_DAYS. No order was affected.`);
        }
        heldDaysOf = (symbol: string) => {
          let held = 0, absent = 0;
          for (const run of history) {
            const inMain = (run.positions ?? []).some(p => p.symbol === symbol);
            const inInfl = (run.influencerPositions ?? []).some(p => p.symbol === symbol);
            if (inMain || inInfl) { held++; absent = 0; continue; }
            // A recorded SELL that day is a real exit, not a data-snapshot gap — stop
            // counting immediately so a same/next-day rebuy starts its age at 0 instead of
            // inheriting the closed lot's age. Without this, the 1-day tolerance below (meant
            // for genuine missing snapshots) also swallows every sell-then-rebuy-next-day
            // transition, since a full close+reopen has at most a 1-day gap in daily runs —
            // this merged ILMN's 08-07 reopen with its 07-28 lot into a false "held 19d" by
            // 08-10, which drove a STALE-rotation sell on what was actually a 1-day-old lot.
            if ((run.trades ?? []).some(t => t.symbol === symbol && t.side === "sell")) break;
            if (++absent >= 2) break; // tolerate one missing day; two = a real exit
          }
          return held;
        };
      } catch (e) {
        console.error("HELD_DAYS_ENRICHMENT_FAILED — skipping time-stop ages", e);
      }
      // priceMap so far only covers the S&P universe + this run's top-12 influencer-momentum
      // tickers (line ~226-234) — a held influencer name that fell out of today's top-12 (or any
      // held main name outside the universe fetch) has no price yet. Without this, `price` below
      // is undefined for that symbol, so strategy.ts's `ret`/⏳STALE computation silently goes null
      // and the staleness tag never renders — the model then reasons blind on a fully-computed
      // heldDays with no return figure (2026-08-18: CAKE hit heldDays=10/INFLUENCER_STALE_DAYS with
      // a real +2.4% gain, but the model's own thesis said "I don't have CAKE's current price in
      // the data" and held it unflagged). enrichPriceMap already exists for the POST-decision
      // snapshot (below); call it here too so the PROMPT the model reads is never missing a price
      // for a symbol it currently holds. No-ops (one Map lookup per symbol) when already populated.
      await enrichPriceMap(positions.map(p => p.symbol), priceMap);
      // Budget the analysis against the USABLE spend limit (broker buffer reserved; notional needs
      // no price cushion — we specify dollars, not shares), not the raw settled figure. fitNotional-
      // BuysToBudget below runs on the raw buyingPower and applies the same broker buffer, so the two
      // stay in sync.
      portfolioCtx = {
        buyingPower: `$${usableNotionalBudget(agenticBalance.buyingPower).toFixed(2)} (settled, buffer-reserved spend limit)`,
        totalValue: `$${agenticBalance.totalValue.toFixed(2)} (live from Robinhood)`,
        positions: positions.map(p => ({
          symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost,
          heldDays: heldDaysOf(p.symbol),
          price: priceMap.get(p.symbol),
        })),
      };
    }

    // Current book β + sector exposure → fed into the prompt so the agent can weigh each
    // buy's marginal risk impact and respect the 40% soft cap.
    const sectorSection = buildRiskSection(portfolioCtx?.positions ?? [], priceMap, marketData.stocks);

    // ── V1 quality-momentum shortlist (the main-book rails) ──────────────────────
    // Deterministic: quality-eligible names with positive 12-1 momentum, sector-capped. The LLM may
    // ONLY buy MAIN-book names from this list (enforced by a hard filter after the decision). Falls back
    // to momentum-only (no quality screen) + an alert if SEC/quality data is unavailable, so the strategy
    // still runs. Rotation is NOT keyed on list position: a held name ranking below the cut is still
    // shown (as ◆HELD via `retained`), so it only rotates out when its momentum goes negative or it
    // loses quality-eligibility.
    //
    // ONE REAL SIDE EFFECT of widening the list (2026-09-18), deliberately accepted by the owner:
    // sleeve classification at route.ts ~1079 infers "influencer" from `!v1ShortlistSet.has(sym)`,
    // so a growing shortlist moves overlapping names (e.g. GOOGL, which carries an influencer
    // signal AND ranks on momentum) from influencer to MAIN. Such a name then gets the main book's
    // regime — daily drop-check, -5% SAME-DAY stop, -10%-from-entry loss discipline, STALE
    // time-stop — instead of the sleeve's hourly check and -10%-from-buy stop, and it bypasses the
    // sleeve's pre-buy guards (2-slot cap, downtrend screen, net>=3 floor, rebuy cooldown). The
    // coupling PREDATES this change (MU and TGT already classify main for the same reason); a wider
    // list just enlarges the affected set. Owner's call: an S&P name belongs in the main book's
    // framework. If sleeve membership ever needs to be list-size-independent, key it on
    // SP500_UNIVERSE instead, which matches the documented "non-S&P tickers can ONLY be influencer
    // picks" rule.
    // BUDGETED, and the budget is only tunable because a timeout now FAILS CLOSED. While a failed
    // screen widened `eligible` to every stock, any timeout traded "the run finished" for "the book
    // bought on a weaker strategy", so no value was correct: 120s sat below this module's own
    // ceilings (FRAMES 75s + RECOVERY 45s) and would discard a slow-but-CORRECT refresh, while
    // anything higher pushed a run that also places the risk SELLS toward maxDuration — the
    // partially-executed-trades failure that cut valuation to 20s (see ~line 514).
    // Now a timeout only costs a buy day, so it can be set well below the internal ceilings.
    // CACHE-ONLY. The cold SEC path moved to /api/quality-refresh (its own cron, maxDuration 300),
    // because no budget was correct for it here: big enough to let a cold refresh finish endangered
    // the risk SELLS against maxDuration, small enough to be safe discarded slow-but-correct results
    // — and with the screen failing closed, discarding one stops main-book buying. It also would not
    // self-heal, since a single SEC failure marks the result `degraded` and a degraded result is
    // never cached, so every following run started cold again.
    // What remains here is a Redis GET, so the budget is short on purpose.
    const quality = await withBudget(
      getQualityScores(false, true),
      QUALITY_CALL_BUDGET_MS,
      () => console.error("QUALITY_BUDGET_EXCEEDED", { budgetMs: QUALITY_CALL_BUDGET_MS, date: today }),
    );
    // FAIL CLOSED. Previously a null quality set `eligible` to EVERY stock, so the main book bought
    // on momentum alone — a different and measurably worse strategy (the TTM quality gate is worth
    // +2.36 CAGR / +0.07 Sharpe over 28 survivorship-free years) — and CLAUDE.md's own rule is that
    // a guard which cannot establish a number must WITHHOLD it, not publish it.
    //
    // The withhold is applied to BUYS ONLY, at the execution boundary (see mainBuysBlocked below),
    // NOT by emptying `eligible` — which looks equivalent and is not, in two ways that both end
    // badly:
    //   · `retained` admits a held name only if it is eligible OR quality-unknown. With a null
    //     quality BOTH sets are empty, so every held name would drop off the shortlist — and
    //     "fell off the shortlist" is a reason lib/sell-rail accepts for SELLING. Fail-closed would
    //     have become a liquidation.
    //   · sleeve classification infers "influencer" from `!v1ShortlistSet.has(sym)`, so an empty
    //     allowlist would relabel every main buy as an influencer pick.
    // Risk SELLS are deliberately untouched: the screen decides what may be BOUGHT, and a data
    // outage must never suspend loss discipline.
    const mainBuysBlocked = !quality;
    if (!quality) {
      console.warn("V1_QUALITY_UNAVAILABLE — main-book BUYS withheld this run (fail closed); sells unaffected");
      await sendAlert(
        `⚠️ V1 quality data unavailable — ${today}`,
        `No cached quality data, so the main book is NOT BUYING this run (fail closed — it will not buy on momentum alone). Risk sells and the influencer sleeve are unaffected.\n\nThe trade run reads the cache only; the SEC refresh runs separately at /api/quality-refresh. A miss here means that cron has not landed a good result before the 8-day TTL expired — check its logs/alerts rather than SEC reachability from this run. Main-book buys only run on the first two trading days of the week, so a single occurrence costs a few days at most.`
      ).catch(() => {});
    }
    const eligible = quality
      ? new Set(Object.entries(quality.scores).filter(([, v]) => v.eligible).map(([s]) => s))
      : new Set(marketData.stocks.map(s => s.symbol));
    // Held MAIN-book names (exclude the influencer sleeve, which has its own rails) — fed to the
    // shortlist so the hysteresis band retains them and the table marks them ◆HELD.
    const influencerHeld = new Set((previousRun?.influencerPositions ?? []).map(p => p.symbol));
    const heldMainSymbols = new Set((portfolioCtx?.positions ?? []).map(p => p.symbol).filter(s => !influencerHeld.has(s)));
    // buy = the sector-capped buy-allowlist; retained = ◆HELD render-only names (not buyable).
    // qualityUnknown keeps an unmeasurable name out of BUY without making a HELD one read as
    // "fell off the shortlist" — see buildV1Shortlist and lib/quality's `withheld`.
    const qualityUnknown = new Set(quality?.withheld ?? []);
    const { buy: v1Buy, retained: v1Retained } = buildV1Shortlist(marketData.stocks, eligible, { held: heldMainSymbols, qualityUnknown });
    const v1ShortlistSet = new Set(v1Buy.map(s => s.symbol)); // buy-allowlist — retained names excluded on purpose

    // RELIABLE per-symbol earnings for the names that actually drive the ⚠⚠ judgment (shortlist +
    // held). The bulk calendar's 1500-row cap drops near-term dates in peak season (PLTR 08-03 was
    // silently missing 2026-07-31 → the earnings judgment never fired on a held name 3 days out).
    // Patch these onto marketData.stocks so BOTH the shortlist ⚠EARN column and the positions tags
    // are correct. Fail-safe.
    // ONE per-symbol Finnhub pass yields BOTH upcoming (⚠EARN) AND just-reported (📊REPORTED) — for
    // shortlist + held + influencer candidates. Influencer candidates were the blind spot: a fresh
    // post-earnings pop read as durable momentum (PLTR +28% 1d bought via the sleeve). Fail-safe.
    const earnSymbols = [...v1Buy.map(s => s.symbol), ...v1Retained.map(s => s.symbol), ...heldMainSymbols, ...influencerHeld, ...influencerCandidateSet];
    const { upcoming: perSymbolEarnings, upcomingHour: perSymbolEarningsHour, recent: recentEarnings, lastReport: perSymbolLastReport } = await fetchEarningsForSymbols(earnSymbols)
      .catch(() => ({ upcoming: new Map<string, string>(), upcomingHour: new Map<string, string | undefined>(), recent: new Map<string, RecentEarnings>(), lastReport: new Map<string, { date: string; hour?: string }>() }));
    for (const s of marketData.stocks) {
      const d = perSymbolEarnings.get(s.symbol);
      if (d && (!s.earningsDate || d < s.earningsDate)) s.earningsDate = d; // nearest upcoming wins
    }
    // earnings map for the positions tags — per-symbol (reliable) over the bulk backfill; covers a
    // held name even if it's not in marketData.stocks.
    const earningsDatesMap: Record<string, string> = {
      ...Object.fromEntries(marketData.stocks.filter(s => s.earningsDate).map(s => [s.symbol, s.earningsDate as string])),
      ...Object.fromEntries(perSymbolEarnings),
    };
    // Material per-stock news (Finnhub → Haiku) for the shortlist + ALL held names (main AND
    // influencer) — the event tail (M&A/litigation/guidance/product/regulatory). Held influencer
    // names matter MOST here (high-variance sleeve). Fail-safe: empty map on any failure/missing key.
    const newsSignals = await fetchNewsSignals([
      ...v1Buy.map(s => s.symbol), ...v1Retained.map(s => s.symbol), ...heldMainSymbols, ...influencerHeld, ...influencerCandidateSet,
    ]).catch(() => new Map<string, { direction: string; summary: string }>());
    // change1d for HELD names (for the 📊REPORTED reaction on position lines) — from the universe
    // fetch, then FALL BACK to influencer momentum so non-S&P sleeve holds (PLTR/SPCX/COIN — absent
    // from the S&P universe) still show the 1d magnitude the flag exists to surface.
    const change1dOfHeld: Record<string, number> = Object.fromEntries(
      marketData.stocks.filter(s => typeof s.change1d === "number").map(s => [s.symbol, s.change1d]),
    );
    for (const [sym, m] of influencerMomentum) if (!(sym in change1dOfHeld)) change1dOfHeld[sym] = m.change1d;
    // ALSO the 5-day move — a few days after a print, change1d is just today's tick, so the pop the
    // 📊REPORTED flag exists to surface lives in the 5d window. Showing both (e.g. "1d -1%, 5d +26%")
    // makes a fading post-earnings gap legible to the HOLD/take-profit decision (PLTR bought AT the
    // pop, -2.7% since entry, showed only "(1d -1%)" on 08-06 and read as re-accelerating → hold).
    const change5dOfHeld: Record<string, number> = Object.fromEntries(
      marketData.stocks.filter(s => typeof s.change5d === "number").map(s => [s.symbol, s.change5d]),
    );
    for (const [sym, m] of influencerMomentum) if (!(sym in change5dOfHeld)) change5dOfHeld[sym] = m.change5d;
    // Earnings-BEAT track record — the base rate that separates a serial beater (ride through /
    // PEAD-drift) from a coin flip. TWO populations need it, for the two rules that name it:
    //   (a) HELD names approaching earnings — the hold-judgment's ride-through exception. PLTR was
    //       sold as "stale + earnings" while a 4/4 beater (+15% avg), the exception the rule couldn't
    //       see (registry 2026-08-04); ≤15d out (registry #18 widened this from ≤10 after ROST @ 12d).
    //   (b) BUY candidates that JUST REPORTED (📊REPORTED, main shortlist or influencer sleeve) — the
    //       post-earnings screen tells the model to skip a fresh gap "unless it's a serial beater with
    //       a strong 📈EARN-RECORD", but the record was only ever fetched for (a), so on a CANDIDATE
    //       the carve-out was unreachable and the screen only ever pointed one way. 2026-09-01: CRM
    //       carried the run's highest influencer net score (5) and was skipped as a "+27% one-time
    //       earnings gap" with its beat record never fetched, shown, or considered.
    // Both sets are small (held ≈ 0-2; just-reported candidates are a handful of the ~12 shortlist +
    // ~12 sleeve names, and only inside recentEarnings' 7-day lookback), batched 10-wide in
    // fetchEarningsBeatHistory. Fail-safe: empty map → rows simply omit the record.
    const heldIntoEarnings = [...heldMainSymbols, ...influencerHeld].filter(sym => {
      const d = earningsDatesMap[sym];
      if (!d) return false;
      const days = Math.round((new Date(d + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime()) / 86400000);
      return days >= 0 && days <= 15; // registry #18: surface the beat-record for held names ≤15d from earnings (ROST @ 12d was missed by the earlier ≤10)
    });
    // Buyable candidates only — a name the rails won't let us buy doesn't need the record. v1Retained
    // (◆HELD, render-only) is excluded here since anything held is already covered by (a).
    const reportedCandidates = [...v1Buy.map(s => s.symbol), ...influencerCandidateSet]
      .filter(sym => recentEarnings.has(sym));
    const beatSymbols = [...new Set([...heldIntoEarnings, ...reportedCandidates])];
    const beatHistory = beatSymbols.length
      ? await fetchEarningsBeatHistory(beatSymbols).catch(() => new Map<string, EarningsBeatRecord>())
      : new Map<string, EarningsBeatRecord>();
    console.log("EARN_RECORD_SCOPE", { held: heldIntoEarnings, reportedCandidates, fetched: beatSymbols.length });

    const shortlistTable = formatV1Shortlist([...v1Buy, ...v1Retained], quality?.scores ?? {}, marketData.insiderBuys, marketData.analystRatings, heldMainSymbols, newsSignals, recentEarnings, influencerX, beatHistory, today);
    // Build the influencer section HERE (once) — after recentEarnings/news, so candidates carry the
    // SAME universal risk flags as the main book: 📊REPORTED, ⚠EARN/⚠⚠ IMMINENT (upcoming), ⚡NEWS.
    influencerSection = formatInfluencerSignals(influencerCache, priceMap, influencerMomentum, recentEarnings, perSymbolEarnings, today, newsSignals, beatHistory);
    console.log("V1_SHORTLIST", { buy: v1Buy.length, retained: v1Retained.map(s => s.symbol), held: [...heldMainSymbols], qualityAvailable: !!quality, universe: marketData.stocks.length, symbols: v1Buy.map(s => s.symbol) });

    // ── V1 DEGENERATE-DATA GUARD ──────────────────────────────────────────────
    // If the universe fetch came back badly partial (Yahoo throttling on the heavier 2y fetch) or the
    // shortlist is too small to form a book, DO NOT trade — a data glitch must NEVER drive a mass
    // rotation/liquidation. Skip the run, leaving the existing book (and its −5% stops) untouched.
    const UNIVERSE_FLOOR = 350;   // normal ~432
    const SHORTLIST_FLOOR = 4;    // absolute floor; normal is now ~19-22 (derived), so this trips on a ~80% collapse
    // Count the BUY candidates only — retained ◆HELD names must not pad this floor (they could
    // mask a collapsed opportunity set and let the run trade on degenerate data).
    if (marketData.stocks.length < UNIVERSE_FLOOR || v1Buy.length < SHORTLIST_FLOOR) {
      console.error("V1_DEGENERATE_DATA_SKIP", { universe: marketData.stocks.length, shortlist: v1Buy.length });
      await sendAlert(
        `⚠️ V1 skipped trading — degenerate market data (${today})`,
        `Universe=${marketData.stocks.length} (floor ${UNIVERSE_FLOOR}), shortlist=${v1Buy.length} (floor ${SHORTLIST_FLOOR}). Likely a Yahoo/SEC hiccup, not a real signal. Skipped the run to avoid a data-driven mass rotation; existing book untouched.`
      ).catch(() => {});
      return Response.json({ skipped: true, reason: "degenerate market data", universe: marketData.stocks.length, shortlist: v1Buy.length });
    }

    // Earnings RELEASE context — what these names actually said and guided, for the same population
    // the beat-record covers. Placed AFTER the degenerate-data return above on purpose: a run that
    // trades nothing must not pay for EDGAR fetches or Sonnet calls. getEarningsReleaseAnalyses
    // serves cache hits free, caps fresh analyses per run, and reports any name it could not cover.
    // Fail-safe end to end: a failure yields no section and never reaches the outer catch.
    const releaseCtrl = new AbortController();
    const releaseTimer = setTimeout(() => releaseCtrl.abort(), 90_000);
    let earningsReleaseSection = "";
    const releaseNotes: string[] = [];
    try {
      const { analyses, notes } = await getEarningsReleaseAnalyses(beatSymbols, recentEarnings, releaseCtrl.signal);
      // INSIDE the try: formatting a cached blob from an older schema could throw, and this block
      // must never be the reason a trade run 500s with zero trades.
      earningsReleaseSection = formatEarningsReleases(analyses);
      releaseNotes.push(...notes);
      console.log("EARNINGS_RELEASE_SCOPE", { considered: beatSymbols.length, analysed: analyses.size, notes: notes.length });
    } catch (e) {
      console.warn("EARNINGS_RELEASE_FAILED — continuing without it", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(releaseTimer);
    }

    // VALUATION — the only price-based check in the system. Everything else the model sees is
    // profitability (quality = ROE/ROA/leverage, no price term) or trend (12-1 momentum asks whether
    // a name went UP, never whether it is EXPENSIVE). Scoped to names it can actually act on, EPS
    // cached (it changes only on a filing) while the P/E is recomputed from the live price.
    // Fail-safe: a failure yields no section rather than reaching the outer catch.
    let valuationSection = "";
    // Hoisted only so the Phase-0 feature capture can record the P/E it already computed.
    // NOTE it covers valSymbols (shortlist + held), not the universe, so most captured rows will
    // have a null P/E — that is accurate, not a gap to paper over.
    let valuationsForCapture: Map<string, import("@/lib/valuation").Valuation> | null = null;
    const valuationNotes: string[] = [];
    try {
      const valCtrl = new AbortController();
      // 20s, not 60: maxDuration is 300 and the declared caps (earnings 90 + analysis 150 + the
      // sell session's 120) already exceed it. Valuation is the most expendable input here — a run
      // that times out DURING order placement leaves partially-executed trades, which is far worse
      // than a run with no P/E block.
      const valTimer = setTimeout(() => valCtrl.abort(), 20_000);
      try {
        const valSymbols = [...v1Buy.map(s => s.symbol), ...heldMainSymbols];
        // recentEarnings is already in hand: pass it so EPS cached BEFORE a fresh print is discarded
        // rather than divided into a post-print price.
        // Built from lastReport, NOT recentEarnings: 📊REPORTED is a 7-day flag, but the filing
        // that makes a post-print P/E safe lands 23-38 days after the press release. Keying
        // suppression to the 7-day flag stops guarding weeks before the fix arrives.
        // Normalised, never dropped — dropping un-suppresses. See normalizeReportDate.
        const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
        const reportedOn = new Map(
          [...perSymbolLastReport].map(([sym, r]) => [sym.toUpperCase(), normalizeReportDate(r.date)] as const),
        );
        for (const [sym, date] of perSymbolEarnings) {
          const norm = normalizeReportDate(date);
          // An unreadable date folds in rather than being skipped: on the largest-divergence day,
          // "not sure whether it printed" must resolve to withholding the P/E, not to showing one.
          if (!ISO_DATE.test(norm) || hasPrintedBySession(norm, perSymbolEarningsHour.get(sym), today)) {
            reportedOn.set(sym.toUpperCase(), norm);
          }
        }
        const { valuations, notes } = await getValuations(valSymbols, (sym) => priceMap.get(sym), valCtrl.signal, { reportedOn });
        valuationsForCapture = valuations;
        valuationSection = formatValuations(valuations);
        // The notes travel WITH the block into the prompt. They used to go only to
        // buySizingAdjustments, which is recorded and emailed but never rendered to any model — so
        // the one reader who acts on this saw a withheld name as silently absent, with no way to
        // tell "we withheld this on purpose" from "this name has no P/E". Absence is exactly what
        // the block warns must not be read as cheap, so the explanation has to reach the reader.
        // Rendered even when the block itself is empty: that case is the most misleading of all.
        if (notes.length) {
          valuationSection += `${valuationSection ? "\n" : "\n\nVALUATION (P/E from SEC filings):\n"}`
            + `Why some names carry no P/E this run — absence here is a GAP IN OUR DATA, never a verdict on the company:\n`
            + notes.map(n => `  ${n}`).join("\n") + "\n";
        }
        valuationNotes.push(...notes);
        console.log("VALUATION_SCOPE", { considered: valSymbols.length, priced: valuations.size, notes: notes.length });
      } finally { clearTimeout(valTimer); }
    } catch (e) {
      console.warn("VALUATION_FAILED — continuing without it", e instanceof Error ? e.message : String(e));
    }

    // CONVICTION RESEARCH — advisory only. The buyable set is exactly the off-rails filter's own
    // allowlist, so a pick is labelled "usable" only when a buy for it would actually survive; the
    // block can never nudge the model toward a buy that code will drop.
    let convictionSection = "";
    const convictionNotes: string[] = [];
    try {
      // The cadence gate, not just the off-rails filter: outside the weekly window EVERY main-book
      // buy is dropped, so a pick labelled "usable" would contradict the BUY: CLOSED line in the
      // same prompt on 3 of 5 weekdays.
      const convictionRun = loadConvictionRun();
      // Filter to the names that would actually clear the hard net-score floor: the candidate set
      // is the top 12 by net REGARDLESS of value, but a buy below the floor is rejected in code.
      const convictionInfluencer = new Set(
        [...influencerCandidateSet].filter(t => (influencerNet[t] ?? 0) >= INFLUENCER_BUY_FLOOR));
      const convictionCtx = { mainShortlist: v1ShortlistSet, influencerCandidates: convictionInfluencer, isRebalanceDay };
      convictionSection = formatConviction(convictionRun, today, convictionCtx);
      const auditNote = convictionAuditNote(convictionRun, today, convictionCtx);
      if (auditNote) convictionNotes.push(auditNote);   // so the run records WHAT research it saw
    } catch (e) {
      // Fail-safe: research is a nice-to-have, never a reason to skip a trading run.
      console.warn("CONVICTION_LOAD_FAILED — continuing without it", e instanceof Error ? e.message : String(e));
    }

    const runTimestamp = new Date().toISOString();
    let textContent = "";
    let trades: TradeSnapshot[] = [];

    // ── SESSION 1: Analysis (Sonnet, no MCP) ────────────────────────────────
    // Pure reasoning — no tool calls. Should complete in ~30-60s.
    const analysisController = new AbortController();
    const analysisKillTimer = setTimeout(() => analysisController.abort(), 150_000);
    let analysisText = "";
    try {
      // Wrap the decision call in a gen_ai.invoke_agent span so the child gen_ai.chat
      // span nests under it — this is what populates Sentry's AI Agents dashboard
      // ("trade-analyst" runs). Plain messages.create only shows in Traces.
      const analysisResp = await Sentry.startSpan(
        {
          op: "gen_ai.invoke_agent",
          name: "invoke_agent trade-analyst",
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.system": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4-6",
            "gen_ai.agent.name": "trade-analyst",
          },
        },
        () => (anthropic.beta.messages as any).create({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          system: buildV1AnalysisPrompt(today, shortlistTable, portfolioCtx!, influencerSection, sectorSection, (previousRun?.influencerPositions ?? []).map(p => p.symbol), recentStopouts, marketData.headlines, earningsDatesMap, newsSignals, beatHistory, recentEarnings, change1dOfHeld, change5dOfHeld, recentSells, formatMarketContext(marketData.sectors, marketData.spyContext?.regime ?? null), earningsReleaseSection, isRebalanceDay, valuationSection + convictionSection, marketData.analystRatings),
          messages: [{ role: "user", content: "Analyze and decide. Output your thesis then the TRADE_DECISION line." }],
        }, { signal: analysisController.signal }),
      );
      analysisText = analysisResp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      console.log("ANALYSIS_DONE", { length: analysisText.length });
    } finally {
      clearTimeout(analysisKillTimer);
    }
    textContent = analysisText;

    // Parse TRADE_DECISION
    // Buys are NOTIONAL (dollarAmount). Sells express INTENT (exit:"all" for a full exit, fraction
    // for a trim) resolved to a concrete share qty from the LIVE held position below — the model
    // never types a fractional share count. `quantity` kept optional as a legacy fallback.
    let decision: TradeDecision = { thesis: "", sells: [], buys: [] };
    // Extraction is deliberately tolerant of markdown around the marker (lib/trade-decision.ts) —
    // on 2026-09-01 a bolded `**TRADE_DECISION:**{...}` silently cancelled a whole run under the old
    // strict regex. `unparsed` (marker present, payload unreadable) is a CODE bug, not a quiet
    // no-trade day, so it alerts and leaves a run-visible note rather than logging into the void.
    let decisionParseNote = "";
    const parsed = parseTradeDecision(analysisText);
    if (parsed.status === "parsed") {
      decision = parsed.decision;
      console.log("DECISION_PARSED", { sells: decision.sells.length, buys: decision.buys.length });
    } else if (parsed.status === "unparsed") {
      console.error("DECISION_UNPARSED", { reason: parsed.reason });
      decisionParseNote = `NO ORDERS PLACED — the analysis emitted a TRADE_DECISION but it could not be read (${parsed.reason}). NOT a decision to stand pat: either the model\u2019s output was truncated mid-payload or the parser met an unknown shape.`;
      await sendAlert(
        "Trade run placed NO orders — TRADE_DECISION could not be parsed",
        `The model produced a TRADE_DECISION payload but it could not be read (${parsed.reason}), so no sells or buys were executed. The run's own decision is in its summary. If the reason says the braces never close, the analysis hit its max_tokens cap mid-payload; otherwise check lib/trade-decision.ts against the raw analysis text.`,
      );
    } else {
      console.warn("DECISION_MISSING — no TRADE_DECISION found in analysis output");
    }

    // Snapshot the model's RAW decision before the guards/sizer mutate decision.buys/sells below,
    // so the Braintrust trace records what the model actually DECIDED (executed trades are logged
    // separately), not the post-guard/post-sizing orders.
    const decidedRaw = { thesis: decision.thesis, buys: decision.buys.map(b => ({ ...b })), sells: decision.sells.map(s => ({ ...s })) };

    // Deterministic re-entry audit (the "verify" half): the model was shown its recent
    // stop-outs and told to justify any re-buy — this FLAGS when it did so anyway, so a
    // whipsaw (or a weak "it's high quality" justification) is never silent. Uses the
    // DECIDED buys (the model's judgment), not post-sizing, so intent is audited even if
    // the buy is later dropped for budget.
    // These flags audit INTENT, so they deliberately read decidedRaw.buys and still fire for a buy
    // later dropped for budget or rails. The ONE exception is the rebalance gate: off-cycle, a main
    // buy is dropped for a calendar reason with no bearing on churn, so flagging it would warn about
    // a trade that could never have happened today. Such a buy still gets a DEFERRED note, which
    // carries its own churn-intent marker.
    const flagBuys = isRebalanceDay ? decidedRaw.buys : decidedRaw.buys.filter(b => !v1ShortlistSet.has(b.symbol));
    let reentryNote = "";
    const reentries = flagBuys.filter(b => recentStopouts.some(s => s.symbol === b.symbol));
    if (reentries.length > 0) {
      const notes = reentries.map(b => {
        const s = recentStopouts.find(x => x.symbol === b.symbol)!;
        return `${b.symbol} (stopped ${s.date} at ${s.changePct.toFixed(1)}%)`;
      }).join(", ");
      console.warn("REENTRY_DETECTED", { reentries: notes });
      reentryNote = `\n\n⚠️ RE-ENTRY FLAG: re-bought recently-stopped name(s): ${notes}. Confirm the thesis justifies re-entry (a confirmed reversal / fresh catalyst — not just shortlist membership), else this is a whipsaw.`;
    }
    // Rotation-churn audit (companion to the stop re-entry flag): the model re-bought a name it
    // DISCRETIONARILY sold within the last few days (ILMN 08-06→08-07). Deterministic membership flag;
    // whether a genuine fresh catalyst justifies it is the reviewer's judgment.
    const churnRebuys = flagBuys.filter(b => recentSells.some(s => s.symbol === b.symbol));
    if (churnRebuys.length > 0) {
      const notes = churnRebuys.map(b => {
        const s = recentSells.find(x => x.symbol === b.symbol)!;
        return `${b.symbol} (sold ${s.date} @ $${s.price.toFixed(2)})`;
      }).join(", ");
      console.warn("ROTATION_CHURN_DETECTED", { churn: notes });
      reentryNote += `\n\n⚠️ ROTATION-CHURN FLAG: re-bought recently-SOLD name(s): ${notes}. Confirm a SPECIFIC fresh reason the discretionary exit no longer applies (a real new catalyst — ★INS / ⚡↑ / ⚡NEWS↑), not just shortlist membership; otherwise this is churn — sold and re-bought at ~the same price for no strategic gain.`;
    }

    // Sizing adjustments (buys shrunk/dropped by ANY guard below) — surfaced in the run + email so a
    // trim/drop is never silent, AND so the skeptical reviewer's decided-vs-executed reconciliation
    // finds a note for every buy that didn't execute. Declared BEFORE the first guard (the within-rails
    // filter) so its drops are recorded too — 2026-08-31: an off-rails AMAT buy was dropped correctly
    // but only console.error'd + alerted separately, leaving NO buySizingAdjustments note, so the
    // reviewer flagged "decided buy absent, no explanation" (registry #19). Every drop belongs here.
    // Seeded with earnings-release coverage gaps gathered above, so a per-run cap or an EDGAR
    // miss is visible on the stored run. Prefixed CONTEXT — these are not dropped orders.
    let buySizingAdjustments: string[] = [...releaseNotes, ...contextWarnings, ...valuationNotes, ...convictionNotes];
    if (decisionParseNote) buySizingAdjustments.push(decisionParseNote);
    // Influencer-sleeve guard drops (position cap, downtrend screen). Collected separately because
    // those guards run before buySizingAdjustments' own guards, then merged in below.
    const influencerGuardNotes: string[] = [];

    // ── V1 WITHIN-RAILS HARD FILTER ───────────────────────────────────────────
    // The main book may ONLY buy from the pre-screened quality-momentum shortlist. Soft prompt guidance
    // does not reliably bind (see the regime-overlay + SCHW incidents), so enforce it in code: drop any
    // MAIN buy whose symbol is not in the shortlist. Pre-execution, so dropping is safe (no order placed).
    // Influencer buys are governed by their own cap/downtrend guards below, not this filter.
    // A buy is allowed iff it is on the quality-momentum shortlist (a MAIN pick) OR is an actual
    // influencer candidate (a symbol shown in the INFLUENCER SIGNALS section). Anything else — an
    // off-shortlist S&P name, a hallucinated/off-universe ticker, or a mislabeled buy — is dropped.
    // Do NOT infer "influencer" from `!sp500Set.has(symbol)`: that let hallucinated tickers through.
    {
      const offList: string[] = [];
      const qualityBlocked: string[] = [];
      decision.buys = decision.buys.filter(b => {
        // Quality unavailable → no MAIN buys. Checked before the shortlist test, because with a null
        // quality the shortlist was built on an UNSCREENED universe and must not authorise anything.
        //
        // The exemption uses the SAME predicate as every other sleeve site (cap, cadence gate,
        // recording). The first version exempted anything in influencerCandidateSet, which is NOT
        // the same thing and left a hole: on a quality outage the unscreened shortlist can contain a
        // name that is ALSO a recurring influencer candidate (MU is the standing example). Untagged
        // and on the shortlist, it is classified MAIN downstream — so it would be sized and railed
        // as a main position, with no quality screen, while the alert email said "the main book is
        // NOT BUYING this run". Only a genuine sleeve buy is exempt.
        const sleeveExempt = b.strategy === "influencer"
          || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
        if (mainBuysBlocked && !sleeveExempt) { qualityBlocked.push(b.symbol); return false; }
        if (v1ShortlistSet.has(b.symbol)) return true;           // main buy on the rails
        if (influencerCandidateSet.has(b.symbol)) return true;   // legit influencer pick (in the real signal set)
        offList.push(b.symbol);
        return false;
      });
      // Never silent: a run that bought nothing because of a DATA outage must be distinguishable
      // from one that simply found nothing worth buying.
      if (qualityBlocked.length > 0) {
        console.warn("MAIN_BUYS_BLOCKED_NO_QUALITY", { date: today, dropped: qualityBlocked });
        // Also a SIZING NOTE, not just a log. lib/autopilot-review.ts feeds buySizingAdjustments to
        // the skeptical reviewer precisely so a missing buy has a citable reason — without it, a
        // quality-outage run shows zero buys against material settled cash and reads as the
        // "broken guardrail / idle capital" false positive that field exists to prevent.
        buySizingAdjustments.push(`main-book buys WITHHELD (quality screen unavailable — fail closed): ${qualityBlocked.join(", ")}`);
      }

      // ── Weekly rebalance gate (main book only) ────────────────────────────────
      // 12-1 momentum is a months-horizon signal; re-deciding it every morning turned the book over
      // ~2x in five weeks and made 18% of round-trips profitable. The strategy doc always specified a
      // WEEKLY rebalance — this enforces it. Deliberately BUYS ONLY: sells stay available every day
      // so risk exits (loss discipline, a bearish event, a downgrade) are never delayed, and the
      // influencer sleeve keeps its own cadence. A sell without a re-buy simply holds cash until the
      // next rebalance, which is the conservative direction.
      //
      // TWO KNOWN INTERACTIONS, accepted deliberately:
      //  · T+1 SETTLEMENT. Today's sells never fund today's buys, and SELLS run every day while buys
      //    run twice a week — so this is bounded by total sell frequency, not by rotation frequency
      //    (a Wednesday stop-out or loss-discipline exit waits for the next window just as a rotation
      //    does). Positions run $400-$750, so an exit idle for up to three sessions at typical market
      //    drift costs order-of-$1, not cents. The two-day window exists partly to shorten this: a
      //    Monday sell settles Tuesday and can be redeployed inside the same window.
      //  · NOT "one event". The Tuesday prompt is identical to Monday's — nothing tells the model the
      //    week's rebalance already happened, so a ⏳STALE rotate-or-justify call can be re-litigated
      //    on day two. Bounded by hysteresis/◆HELD and by buying power, and the churn diagnosis is
      //    still materially addressed (2 open days of 5, main buys hard-dropped in code on the other
      //    3, vs 26 buys in 25 days before). Enforcing it would need a mainBookRebalancedThisWeek
      //    flag in the prompt; deliberately not built yet.
      //  · RE-BUY COOLDOWN. lib/stopouts RECENT_SELL_DAYS=7 was tuned for daily buys; with buys only
      //    on the rebalance day, a name sold in week N is still inside the window at week N+1, so an
      //    exit effectively blocks re-entry for two rebalances. That is MORE anti-churn, which is the
      //    direction this change wants — left as-is on purpose, not overlooked.
      if (!isRebalanceDay) {
        // DELIBERATELY NARROWER than the file's other influencer classifiers, which are all
        // `tag || (candidate && !shortlist)`. Here the `!shortlist` guard also applies to the
        // EXPLICIT-TAG branch, so a name that is both a main-shortlist entry and a sleeve pick
        // (PLTR, GOOGL) is treated as MAIN and deferred — the owner's 2026-09-18 decision that an
        // S&P name belongs to the main book's framework. Every other use of that predicate is
        // RESTRICTIVE (they add constraints to influencer buys) except the recording site, which is
        // pure accounting; this one is PERMISSIVE, so the looser form would let a shortlist name
        // through the gate on any weekday. PROVENANCE, not shortlist membership, decides this — and
        // it now matches the cap's predicate exactly, resolving an inconsistency this comment used to
        // merely record: a name tagged strategy:"influencer" was MAIN to this gate (so deferred on
        // 3 of 5 weekdays) while still booking as influencer and charging the 2-slot sleeve cap.
        // One name was MAIN to the gate and SLEEVE to P&L.
        //
        // The old `!v1ShortlistSet.has(...)` conjunct inferred "is a sleeve pick" from "is not an
        // S&P pick", which is only true while the universe is incomplete. It is already wrong for
        // MU and TGT, and the Sharadar drift report shows 118 index members currently outside
        // STOCK_SECTOR — adding them would silently remove sleeve access to all 118 on non-rebalance
        // days. An S&P name the channels are pushing is a legitimate sleeve pick; the sleeve's own
        // rails (2-slot cap, downtrend screen, net>=3 floor, re-buy cooldown) are what govern it.
        //
        // Precedence is unchanged where it matters: an EXPLICIT tag wins, and an untagged name that
        // is on the shortlist is still MAIN, so this cannot quietly reclassify ordinary main buys.
        const isSleeveBuy = (b: { symbol: string; strategy?: string }) =>
          b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
        const deferred = decision.buys.filter(b => !isSleeveBuy(b));
        if (deferred.length > 0) {
          decision.buys = decision.buys.filter(isSleeveBuy);
          console.log("MAIN_BUYS_DEFERRED_OFF_REBALANCE_DAY", { deferred: deferred.map(b => b.symbol), nextWindow: "first two trading days of next week" });
          buySizingAdjustments.push(...deferred.map(b => {
            // Preserve the churn signal: without this, a re-buy attempted 2 days after selling the
            // same name reads as a neutral deferral and the intent is lost from the audit trail.
            const churn = recentSells.some(x => x.symbol === b.symbol) ? " ⚠ this was also a re-buy of a name sold in the last few days (churn intent)." : "";
            return `${b.symbol} main-book buy DEFERRED — outside the weekly rebalance window (main-book buys run on the first two trading days of the week; sells and risk exits still run daily). Re-evaluated at the next window.${churn}`;
          }));
        }
      }
      if (offList.length > 0) {
        console.error("V1_OFF_RAILS_BUYS_DROPPED", offList);
        // Record in the run so decided-vs-executed reconciles (not just a separate alert email). A
        // ◆HELD retained name (held, but squeezed off the buyable shortlist by the sector cap) is the
        // common case — the model tried to ADD to it, which the rails correctly forbid.
        buySizingAdjustments.push(...offList.map(s => `${s} buy DROPPED — off-rails (not on the quality-momentum shortlist or influencer signal set; e.g. a ◆HELD name not on the buyable list)`));
        await sendAlert(
          `⚠️ V1 off-rails buys dropped — ${today}`,
          `The model tried to buy names on neither the quality-momentum shortlist nor the influencer signal set: ${offList.join(", ")}. Dropped before execution (within-rails guard). Investigate if this recurs.`
        ).catch(() => {});
      }
    }

    // ── Notional buy sanitation ───────────────────────────────────────────────
    // A buy MUST carry a positive numeric dollarAmount ≥ the $50 min. Enforce it deterministically:
    // (a) a missing/NaN dollarAmount would otherwise crash the notional buy-line builder (which runs
    // before its try block) AFTER sells already executed; (b) a sub-$50 amount violates the
    // min-position rule the prompt states. Runs on the RAW model output, before cap/budget sizing.
    {
      const dropped = decision.buys.filter(b => !(typeof b.dollarAmount === "number" && isFinite(b.dollarAmount) && b.dollarAmount >= MIN_BUY_DOLLARS));
      if (dropped.length > 0) {
        decision.buys = decision.buys.filter(b => typeof b.dollarAmount === "number" && isFinite(b.dollarAmount) && b.dollarAmount >= MIN_BUY_DOLLARS);
        console.warn("NOTIONAL_BUYS_DROPPED_INVALID_OR_DUST", { dropped });
        buySizingAdjustments.push(...dropped.map(b =>
          `${b.symbol} buy DROPPED — dollarAmount ${typeof b.dollarAmount === "number" ? `$${b.dollarAmount.toFixed(2)}` : String(b.dollarAmount)} is invalid or below the $${MIN_BUY_DOLLARS} min`
        ));
      }
    }

    // ── Hard cap: per-position TOP-UP guard (main book) ──────────────────────────
    // The prompt's per-position cap (max_qty = floor(maxPos/price)) checks each BUY ORDER in
    // isolation, so ADDING to an existing holding can push the position past the cap: on 2026-07-29
    // the model topped up ROST to 3sh = $749 (30.2%) and APA sat at $617 (24.9%) vs the ~$496 (20%)
    // cap. Soft prompt guidance doesn't reliably bind, so enforce the cap in code against
    // existing-holding value + new-buy value. Reduce the buy qty to fit, or drop it. Buy-time guard
    // only — it stops the breach GROWING; it never force-sells an already-over-cap position.
    // Applies to INFLUENCER buys too: the sleeve caps the NUMBER of names (2 slots) but had no
    // per-position dollar ceiling, so a single influencer buy — or a shortlist name laundered
    // through strategy:"influencer" — could take ~the whole book past the 20% cap. The same maxPos
    // ceiling now binds EVERY buy regardless of tag (security audit 2026-08-18, finding [3]).
    {
      const maxPos = maxPositionDollars(agenticBalance ? `$${agenticBalance.totalValue}` : portfolioCtx?.totalValue);
      const heldValueOf = (sym: string) => {
        const p = (portfolioCtx?.positions ?? []).find(pp => pp.symbol === sym);
        if (!p) return 0;
        const price = priceMap.get(sym) ?? (parseFloat(p.avgCost) || 0);
        return (parseFloat(p.quantity) || 0) * price;
      };
      const { buys: cappedBuys, notes: capNotes } = applyPerPositionCap(decision.buys, maxPos, heldValueOf);
      decision.buys = cappedBuys;
      if (capNotes.length > 0) {
        console.log("V1_POSITION_CAP_GUARD", { maxPos, notes: capNotes });
        buySizingAdjustments.push(...capNotes); // surface in the run/email like other sizing adjustments
      }
    }

    // ── Hard cap: max concurrent influencer positions ─────────────────────────
    // The influencer bucket is high-risk by design; limit concentration regardless
    // of what the model decides. Count positions we'd KEEP plus NEW influencer buys.
    const MAX_INFLUENCER_POSITIONS = 2;
    {
      // A slot only frees up on a FULL exit — a partial trim (fraction/legacy-qty) still HOLDS the
      // position, so counting it as sold would wrongly raise allowedNew and admit a 3rd influencer name.
      // NOT `.filter(isFullExit)` — Array.filter passes (value, INDEX, array), so the index would
      // arrive as `heldQty` and at index 0 make `quantity >= 0` always true, turning a numeric-
      // quantity trim into a "full exit", freeing an influencer slot and admitting a 3rd position
      // past MAX_INFLUENCER_POSITIONS (security-audit finding [3]).
      const heldInflQtyExec = new Map((previousRun?.influencerPositions ?? []).map(p => [p.symbol, parseFloat(p.quantity) || 0]));
      const soldSet = new Set(
        decision.sells.filter(s => isFullExit(s, heldInflQtyExec.get(String(s.symbol)))).map(s => s.symbol),
      );
      const keptInfluencer = (previousRun?.influencerPositions ?? []).filter(p => !soldSet.has(p.symbol)).length;
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
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
        // Recorded, not just logged: every other guard writes a note, and the autopilot's
        // decided-vs-executed check treats an absent buy WITHOUT one as an unexplained anomaly —
        // which raises an issue and dispatches the paid cloud agent at a guard doing its job.
        influencerGuardNotes.push(...trimmed.map(sym =>
          `${sym} buy DROPPED — influencer sleeve already at its ${MAX_INFLUENCER_POSITIONS}-position cap (${keptInfluencer} kept, ${allowedNew} new slot(s) available)`));
        console.log("INFLUENCER_CAP_TRIMMED", { keptInfluencer, allowedNew, trimmed });
      }
    }

    // ── MAIN-BOOK POSITION CAP (buy-side) ────────────────────────────────────────
    // The strategy targets ~6 concentrated names; nothing bounded the count, so buys added,
    // hysteresis retained, and the book drifted to 12 half-size positions across seven sectors —
    // an index clone. TARGET_MAIN_POSITIONS was only ever used to DERIVE the sector cap
    // (0.4 x 6 = 2); it never limited the book.
    //
    // Shipped on the 28-year survivorship-free backtest, which is unambiguous about the DESIGN
    // (scripts/full-period.ts --positions 4,6,8,10,12, same rules otherwise):
    //        4 → CAGR +11.88%  Sharpe 0.51  IR 0.24  maxDD -84.3%  7,475 trades
    //        6 → CAGR +11.75%  Sharpe 0.53  IR 0.22  maxDD -71.9% 10,954
    //        8 → CAGR +11.41%  Sharpe 0.55  IR 0.20  maxDD -68.2% 14,451
    //       10 → CAGR  +9.54%  Sharpe 0.50  IR 0.10  maxDD -66.7% 17,834
    //       12 → CAGR  +8.12%  Sharpe 0.46  IR 0.01  maxDD -66.6% 21,138
    // Monotonic: 12 → 6 is +3.6pp CAGR and takes IR from 0.01 to 0.22, and HALVES trade count, so
    // it improves returns and cuts execution cost together. 4 wins on CAGR but at a -84.3%
    // drawdown; 6 is the design target and the knee of the curve.
    //
    // WHAT THIS DOES NOT PROVE: that run is the mechanical screen, not the live book with LLM
    // selection on top. It says the design rewards concentration, not that capping fixes the live
    // -5.9% alpha. The live book holding 12 with near-zero alpha is CONSISTENT with the backtest's
    // 12-position row, which is what moved this from "do not ship" to "ship".
    //
    // BUY-SIDE ONLY, mirroring MAX_INFLUENCER_POSITIONS exactly: at the cap a new main buy is
    // dropped unless a FULL EXIT frees a slot in the same decision. It can never force a sale, so
    // it cannot manufacture churn — and under T+1 a forced sale would not fund a buy today anyway.
    // The existing 12 therefore drain only through ordinary exits (stops, loss discipline,
    // time-stop, hysteresis failure), which with hysteresis retaining names may be SLOW. That is
    // the known weakness: if the count has not fallen in a month, the cap alone was not enough.
    {
      const heldMainQty = new Map(
        (portfolioCtx?.positions ?? [])
          .filter(p => !influencerHeld.has(p.symbol))
          .map(p => [p.symbol, parseFloat(p.quantity) || 0]),
      );
      const mainSoldSet = new Set(
        decision.sells.filter(s => isFullExit(s, heldMainQty.get(String(s.symbol)))).map(s => s.symbol),
      );
      const keptMain = [...heldMainQty.keys()].filter(sym => !mainSoldSet.has(sym)).length;
      const allowedNewMain = Math.max(0, TARGET_MAIN_POSITIONS - keptMain);
      // A buy is MAIN unless it is a sleeve buy — same predicate as the cap, cadence gate and
      // recording site, so one name cannot be MAIN here and SLEEVE there.
      const isMainBuy = (b: { symbol: string; strategy?: string }) =>
        !(b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol)));
      let keptNew = 0;
      const cappedOut: string[] = [];
      decision.buys = decision.buys.filter(b => {
        if (!isMainBuy(b)) return true;              // sleeve picks have their own cap
        // A TOP-UP of a name already held does not add a position, so it must not consume a slot.
        // buildV1Shortlist does not exclude held names from `buy` — a holding that still ranks is
        // buyable — and once the book is AT the cap every slot is taken, so counting top-ups would
        // block the one action that still concentrates the book. That is the opposite of the point:
        // it would leave proceeds sitting in cash at exactly the moment we want them redeployed
        // into the remaining names.
        if (heldMainQty.has(b.symbol) && !mainSoldSet.has(b.symbol)) return true;
        if (keptNew < allowedNewMain) { keptNew++; return true; }
        cappedOut.push(b.symbol);
        return false;
      });
      if (cappedOut.length > 0) {
        // Recorded, not just logged — the autopilot's decided-vs-executed check reads an absent buy
        // WITHOUT a note as an unexplained anomaly and dispatches the paid cloud agent at a guard
        // doing its job.
        buySizingAdjustments.push(...cappedOut.map(sym =>
          `${sym} buy DROPPED — main book at its ${TARGET_MAIN_POSITIONS}-position cap (${keptMain} kept, ${allowedNewMain} new slot(s) available)`));
        console.log("MAIN_CAP_TRIMMED", { keptMain, allowedNewMain, cappedOut });
      }
    }

    // ── Pre-buy momentum guard: reject influencer picks in a clear downtrend ──────
    // The influencer signal measures popularity, not price trend — a stock can be the
    // most-talked-about one precisely because it's crashing (SPCX bought mid-decline).
    // Don't buy a falling knife; the stop is cleanup, not a substitute for this — and for the sleeve that net is now −10%, i.e. half as tight, which strengthens the case for this screen.
    {
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
      const rejected: string[] = [];
      decision.buys = decision.buys.filter(b => {
        if (!isInfluencerBuy(b)) return true; // main strategy already screens momentum
        const mom = influencerMomentum.get(b.symbol);
        if (isInfluencerDowntrend(mom)) {
          rejected.push(`${b.symbol} (5d ${mom!.change5d.toFixed(0)}%, ${mom!.distFromHigh.toFixed(0)}% off high)`);
          // Note carries the FULL momentum reading, not just the verdict, so the screen's value can
          // eventually be measured: it records what was rejected, at what price, on what date. Until
          // now a downtrend rejection was console.log-only, leaving no record of what the screen
          // blocked and therefore no way to ask whether those names actually went on to fall.
          influencerGuardNotes.push(
            `${b.symbol} buy REJECTED — ⛔DOWNTREND screen (5d ${mom!.change5d.toFixed(1)}%, ${mom!.distFromHigh.toFixed(1)}% off recent high, $${(priceMap.get(b.symbol) ?? 0).toFixed(2)})`);
          return false;
        }
        return true;
      });
      if (rejected.length > 0) {
        console.log("INFLUENCER_DOWNTREND_REJECTED", { rejected });
      }
    }

    // ── Pre-buy net-score guard: reject influencer picks below the mandatory net≥3 floor ──
    // The influencer-signals prompt tells the model "if ANY ticker has NET score ≥ 3, you SHOULD
    // buy 1-2 of them" and lists only price-cap / imminent-earnings / no-settled-cash as valid
    // reasons to skip the sleeve — a sub-floor net score has no stated exception, including a
    // rumor-driven catalyst. Soft prompt guidance doesn't reliably bind (2026-08-19: PYPL bought at
    // net=2 on an unconfirmed Stripe/Advent acquisition rumor, below its own mandatory floor).
    // Enforce the floor in code, same pattern as the downtrend guard above.
    {
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
      const rejected: string[] = [];
      decision.buys = decision.buys.filter(b => {
        if (!isInfluencerBuy(b)) return true; // main strategy has no net-score floor
        const net = influencerNet[b.symbol] ?? 0;
        if (net < INFLUENCER_BUY_FLOOR) {
          rejected.push(`${b.symbol} (net=${net}, below the ${INFLUENCER_BUY_FLOOR} floor)`);
          return false;
        }
        return true;
      });
      if (rejected.length > 0) {
        console.log("INFLUENCER_NET_FLOOR_REJECTED", { rejected });
        buySizingAdjustments.push(...rejected.map(r => `Influencer buy REJECTED — ${r}`));
      }
    }

    // ── Anti-churn re-buy cooldown (MAIN book): drop a re-buy of a recently sold/stopped name
    // unless a catalyst (bullish ⚡NEWS / analyst upgrade / ★INS insider buy) is dated AFTER the exit.
    // Promotes the advisory RE-ENTRY / ROTATION-CHURN flags above into an ENFORCED gate — measured
    // 2026-08-25: 9 re-entries in 30 runs (ILMN ×3); ROST sold 08-20 then re-bought citing earnings
    // dated 08-19, a "catalyst" that PREDATED the sale. A catalyst already public when it sold can't
    // justify the round-trip. Influencer buys are skipped (they have their own net-floor/downtrend guards).
    {
      const cooldownOf = (sym: string): CooldownExit | null => {
        const sold = recentSells.find(s => s.symbol === sym);
        const stopped = recentStopouts.find(s => s.symbol === sym);
        if (!sold && !stopped) return null;
        // If in both registries, the catalyst must beat the MOST RECENT exit.
        if (sold && stopped) return sold.date >= stopped.date
          ? { symbol: sym, date: sold.date, kind: "sold" }
          : { symbol: sym, date: stopped.date, kind: "stopped" };
        return sold
          ? { symbol: sym, date: sold.date, kind: "sold" }
          : { symbol: sym, date: stopped!.date, kind: "stopped" };
      };
      const catalystOf = (sym: string, exitDate: string) => findPostSaleCatalyst(exitDate, {
        news: newsSignals.get(sym),
        analyst: marketData.analystRatings[sym],
        insider: marketData.insiderBuys[sym],
      });
      // Same influencer classification as the net-floor guard above (tag OR off-shortlist candidate).
      const isInfluencerBuy = (b: { symbol: string; strategy?: string }) =>
        b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol));
      const { buys: cooled, notes: cooldownNotes } = applyRebuyCooldown(decision.buys, isInfluencerBuy, cooldownOf, catalystOf);
      decision.buys = cooled;
      if (cooldownNotes.length > 0) {
        console.log("REBUY_COOLDOWN_BLOCKED", { blocked: cooldownNotes });
        buySizingAdjustments.push(...cooldownNotes);
      }
      // Flushed UNCONDITIONALLY. These were briefly pushed inside the net-score-floor guard's
      // `if (rejected.length > 0)` block — but the downtrend guard runs FIRST and removes its
      // rejects from decision.buys, so those symbols can never reach the net-floor guard and the
      // two conditions are near-mutually-exclusive on a single-buy day. The notes were therefore
      // discarded in exactly the common case, leaving the run with no record of the drop and
      // dispatching the paid cloud agent at a guard doing its job.
      if (influencerGuardNotes.length > 0) {
        buySizingAdjustments.push(...influencerGuardNotes);
      }
    }

    // ── Pre-flight buy sizing: fit NOTIONAL buys into live settled buying power ────
    // (sells today settle T+1 → they don't fund today's buys; size against real BP). Notional has
    // no indivisible whole-share to strand — cash deploys down to the last ~$50, nothing idle.
    if (decision.buys.length > 0 && agenticBalance) {
      const { sized, adjustments } = fitNotionalBuysToBudget(decision.buys, agenticBalance.buyingPower);
      if (adjustments.length > 0) {
        console.log("BUY_SIZING_ADJUSTED", { settledBuyingPower: agenticBalance.buyingPower, adjustments });
        buySizingAdjustments.push(...adjustments); // append — don't clobber the cap-guard notes above
      }
      decision.buys = sized;
    }

    // ── Concentration trim-on-drift (code-enforced risk cap on HELD value) ─────────
    // A code trim is a RISK reduction of a STILL-HELD name — NOT a discretionary exit — so it must be
    // kept out of the recent-sells registry (else the next run's rebuy-cooldown would block adding to a
    // name we still own, and the prompt would mislabel a held winner as "rotated OUT"). Tracked here.
    const trimmedSymbols = new Set<string>();
    // The buy cap only bounds new buys; a winner can appreciate past it (APA drifted to 28% with the
    // 20% cap never trimming, then was >half the −4% week when Energy sold off 2026-08-27). Enforce
    // the cap on held value too: a MAIN name over ~25% of the book is trimmed back to the 20% cap.
    // The LLM chooses exit-vs-trim (it's shown the flag); code enforces the CEILING — if the LLM
    // already sells the name (exit/fraction), we DON'T double-trim (respect its decision).
    {
      const trimMaxPos = maxPositionDollars(agenticBalance ? `$${agenticBalance.totalValue}` : portfolioCtx?.totalValue);
      const trimHeldValueOf = (sym: string) => {
        const p = (portfolioCtx?.positions ?? []).find(pp => pp.symbol === sym);
        if (!p) return 0;
        return (parseFloat(p.quantity) || 0) * (priceMap.get(sym) ?? (parseFloat(p.avgCost) || 0));
      };
      // MAIN-book holds only (influencer sleeve has its own sizing/stops), and only names the LLM
      // hasn't ALREADY put a sell on — so a model exit/trim takes precedence over the code trim.
      const alreadySelling = new Set(decision.sells.map(s => s.symbol));
      const mainHeld = (portfolioCtx?.positions ?? [])
        .map(p => p.symbol)
        .filter(sym => !influencerHeld.has(sym) && !alreadySelling.has(sym));
      const { trims, notes: trimNotes } = applyConcentrationTrim(mainHeld, trimMaxPos, trimHeldValueOf);
      if (trims.length > 0) {
        decision.sells.push(...trims); // flow through the normal sell resolve → execute → verify path
        for (const t of trims) trimmedSymbols.add(t.symbol);
        console.log("CONCENTRATION_TRIM", { trims: trimNotes });
        buySizingAdjustments.push(...trimNotes);
      }
    }

    // ── Resolve sell INTENT → concrete share quantity from the LIVE held position ──
    // The model emits intent (exit:"all" / fraction), NEVER a fractional share count, so it can't
    // mistype and over/under-sell. A full exit sells the EXACT held qty (no dust remainder); a trim
    // sells fraction × held. A legacy numeric `quantity` is clamped to what's held. Names we don't
    // actually hold are dropped. Fractional quantities are fine (market + regular_hours sells).
    // ── SELL VOLUME RAIL ──────────────────────────────────────────────────────
    // Bounds DISCRETIONARY main-book full exits. Measured 2026-09-29: the model proposed selling
    // the entire main book in 1 of 4 runs. Sells previously passed one filter (is it held) while
    // buys passed six. Provable risk exits are never capped, and the automatic stop path
    // (/api/drop-check, its own cron) does not come through here at all. Fails OPEN.
    {
      // Ownership, not the model's tag. The tag is model-emitted and never validated, so an
      // untagged sleeve exit would route to the MAIN rail and be judged on the 60-day main clock —
      // while the sleeve's clocks are 10/25 days and the prompt makes that rotation a MUST.
      const mainHeldForRail = (portfolioCtx?.positions ?? []).filter(p => !influencerHeld.has(p.symbol)).length;
      const isSleeveOwned = (x: { symbol: string; strategy?: string }) =>
        x.strategy === "influencer" || influencerHeld.has(x.symbol);
      const mainSells = decision.sells.filter(x => !isSleeveOwned(x));
      const sleeveSells = decision.sells.filter(isSleeveOwned);
      const railCtx = {
        positionOf: (sym: string) => {
          const p = (portfolioCtx?.positions ?? []).find(x => x.symbol === sym);
          return p ? { avgCost: parseFloat(p.avgCost), price: p.price, quantity: parseFloat(p.quantity) } : undefined;
        },
        stillRanked: (sym: string) => v1ShortlistSet.has(sym) || v1Retained.some(r => r.symbol === sym),
        hasBearishNews: (sym: string) => newsSignals.get(sym)?.direction === "-",
        hasDowngrade: (sym: string) => (marketData.analystRatings[sym] ?? []).some(r => r.action === "downgrade" || r.action === "lower_pt"),
        daysToEarnings: (sym: string) => {
          const ed = earningsDatesMap[sym];
          if (!ed) return null;
          const d = Math.round((new Date(ed).getTime() - new Date(today).getTime()) / 86_400_000);
          return Number.isFinite(d) ? d : null;
        },
        // The prompt MANDATES reducing a ⚠CONCEN name and authorises a full exit when its thesis
        // has weakened — and such a name is a WINNER that grew past the cap, so no distress test
        // fires. Without this the rail could block an exit the prompt required.
        isOverConcentrationCap: (sym: string) => {
          const p = (portfolioCtx?.positions ?? []).find(x => x.symbol === sym);
          const val = p?.price != null ? p.price * (parseFloat(p.quantity) || 0) : null;
          // The SAME trigger the ⚠CONCEN flag and applyConcentrationTrim use (maxPos x 1.25), not
          // bare maxPos — otherwise the rail justifies an exit for a name never shown ⚠CONCEN.
          return val != null && val > maxPositionDollars(portfolioCtx?.totalValue) * 1.25;
        },
        // A post-print DROP can be well under 10% below entry and so invisible to loss discipline,
        // while the prompt tells the model to reassess or exit on exactly that. Gated on the
        // direction: "reported at all" would exempt any name in a 7-day window, and through
        // earnings season that is most of an 11-name book — the rail would quietly become a no-op
        // in the regime that produces mass restructuring.
        reportedRecently: (sym: string) =>
          recentEarnings.has(sym) && ((change1dOfHeld[sym] ?? 0) < -3 || (change5dOfHeld[sym] ?? 0) < -5),
        isStale: (sym: string) => {
          const p = (portfolioCtx?.positions ?? []).find(x => x.symbol === sym);
          const avg = p ? parseFloat(p.avgCost) : NaN;
          const ret = p?.price != null && avg > 0 ? ((p.price - avg) / avg) * 100 : null;
          return staleReasonOf(false, p?.heldDays ?? null, ret) != null;
        },
      };
      // Scaled on the rebalance day: the prompt explicitly adds "free a slot for a clearly
      // higher-conviction NEW name" to the valid-sell list there, and the book holds ~11 against a
      // 6-name target, so a legitimate consolidation is larger than 3. Off-window that trigger is
      // withdrawn, so the tighter cap is the right one.
      const railMax = isRebalanceDay
        ? Math.max(MAX_DISCRETIONARY_EXITS, Math.ceil((mainHeldForRail - TARGET_MAIN_POSITIONS) / 2))
        : MAX_DISCRETIONARY_EXITS;
      // Both news and analyst ratings fail to an EMPTY map on an outage or a missing key, which
      // would make every bearish-news/downgrade exit unverifiable — the rail tightening exactly
      // when its evidence is weakest.
      const evidenceDegraded =
        Object.keys(marketData.analystRatings ?? {}).length === 0 || newsSignals.size === 0;
      // RECORDED, not just logged. Standing down is correct — but it disables a live guard, and a
      // guard that switches itself off silently is indistinguishable from one that is working. A
      // persistent provider failure (plan change → 403, expired key) degrades evidence on EVERY
      // run, so without this the rail would be permanently off with nothing to show for it. Gated
      // on there actually being exits to bound, so a quiet day does not emit noise.
      if (evidenceDegraded && mainSells.length > 0) {
        console.error("SELL_RAIL_STOOD_DOWN", {
          proposedExits: mainSells.length,
          analystSymbols: Object.keys(marketData.analystRatings ?? {}).length,
          newsSignals: newsSignals.size,
        });
        // "proposed", not "executed": mainSells is the DECIDED count here. Downstream, an unheld
        // name is dropped (SELL_SKIPPED_NOT_HELD) and placement can fail, so claiming execution
        // would assert something this line cannot know — the decision and the claim stay separate.
        buySizingAdjustments.push(
          `⚠️ Sell-volume rail STOOD DOWN — evidence degraded (analyst ratings: ` +
          `${Object.keys(marketData.analystRatings ?? {}).length} symbols, news signals: ${newsSignals.size}). ` +
          `${mainSells.length} main-book exit(s) proposed, none bounded by the rail. It stands down when it ` +
          `cannot verify bearish-news/downgrade reasons, so it does not tighten hardest when it sees least — ` +
          `but if this repeats daily, a provider is down and the guard is effectively off.`,
        );
      }
      const rail = applySellRail(mainSells, railCtx, railMax, { evidenceDegraded });
      if (rail.dropped.length > 0) {
        decision.sells = [...rail.sells, ...sleeveSells];
        buySizingAdjustments.push(...rail.notes);
        console.error("SELL_RAIL_TRIMMED", { dropped: rail.dropped, kept: rail.sells.length });
        await sendAlert(
          `⚠️ Sell-volume rail trimmed ${rail.dropped.length} exit(s) — ${today}`,
          `The decision proposed more discretionary full exits than the rail allows: ${rail.dropped.join(", ")}. ` +
          `Provable risk exits (underwater, stale, off-shortlist, downgrade, bearish news, imminent earnings) are never capped, ` +
          `so these had no code-verifiable reason. Investigate if this recurs — it is the shape that preceded a proposed full liquidation on 2026-09-29.`,
        ).catch(() => {});
      }
    }

    const sellsToExecute: Array<{ symbol: string; quantity: string; strategy?: string }> = [];
    for (const s of decision.sells) {
      const pos = (portfolioCtx?.positions ?? []).find(p => p.symbol === s.symbol);
      if (!pos) { console.warn("SELL_SKIPPED_NOT_HELD", { symbol: s.symbol }); continue; }
      const qtyStr = resolveSellQuantity(s, pos.quantity);
      if (qtyStr && (parseFloat(qtyStr) || 0) > 0) sellsToExecute.push({ symbol: s.symbol, quantity: qtyStr, strategy: s.strategy });
      else console.warn("SELL_SKIPPED_NOT_HELD", { symbol: s.symbol });
    }
    if (sellsToExecute.length !== decision.sells.length) {
      console.log("SELLS_RESOLVED", { requested: decision.sells.length, executable: sellsToExecute.length });
    }

    const mcpServer = { type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken };

    // ── SESSION 2: Execute sells (Haiku, MCP) — sequential + verify + retry ───
    // Placing orders ONE AT A TIME (not "simultaneously") avoids the model dropping
    // an order from a batched multi-tool-call. Then we verify each decided sell
    // actually hit Robinhood and retry any that didn't, so a silent drop can't pass.
    // Was: find the symbol's BUY in the PREVIOUS RUN. A position is bought days or weeks before it
    // is sold, so that run almost never holds it — 67 of 81 historical sells ended up untagged,
    // which makes per-sleeve realised P&L uncomputable because nothing ever nets to closed.
    // influencerPositions on the prior run is the authoritative record and is what
    // computeSleeveReturns already partitions on.
    const sellStrategyTag = (sym: string) =>
      inferSellStrategy(sym, previousRun?.influencerPositions, previousRun?.trades ?? []);

    async function runSellSession(sells: Array<{ symbol: string; quantity: string }>, timeoutMs: number): Promise<boolean> {
      if (sells.length === 0) return true;
      const lines = sells.map(s => `- sell ${s.quantity} shares of ${s.symbol}`).join("\n");
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
    async function verifySells(): Promise<Map<string, VerifiedSell> | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_SELLS:[{"symbol":<TICKER>,"quantity":<QTY>,"avgPrice":<PRICE>,"state":<STATE>}]
Every value must be a quoted JSON string — the <...> above are placeholders, not literals.
Include only SELL orders placed today that are filled or pending (not cancelled/rejected). If none, output VERIFIED_SELLS:[]. Output nothing else.`,
          messages: [{ role: "user", content: "Verify today's sell orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const m = txt.match(/^VERIFIED_SELLS:(.+)$/m);
        // null, NOT an empty Map. "Verified: nothing filled" and "could not verify" are different
        // facts: the first means those orders are genuinely absent from the broker and may be
        // re-placed; the second is unknown state, where re-placing could duplicate a fill that
        // already went through. Collapsing them is what made a parse failure re-place everything.
        if (!m) return null;
        const orders = JSON.parse(m[1]) as VerifiedSell[];
        // Reject a TEMPLATE ECHO. Unparseable <...> placeholders stop a verbatim echo, but a model
        // that also obeys "every value must be a quoted JSON string" emits {"symbol":"<TICKER>"} —
        // valid JSON, which parses to a map keyed "<TICKER>". Every real symbol then reads as
        // missing, i.e. "nothing of yours filled", and the whole decided list gets re-placed.
        // Treat any placeholder-shaped row as a failure to verify, not as a result.
        const good = orders.filter(o => typeof o?.symbol === "string" && o.symbol.length > 0 && !o.symbol.startsWith("<"));
        // A pure echo leaves nothing behind, so it still degrades to unknown state — but one bad
        // row no longer discards confirmations that ARE real. Recording what filled is always safe.
        if (good.length === 0 && orders.length > 0) return null;
        return new Map(good.map(o => [o.symbol, o]));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    if (sellsToExecute.length > 0) {
      const ok = await runSellSession(sellsToExecute, 120_000);
      // VERIFY regardless of ok — the executor places orders ONE AT A TIME, so an aborted or
      // timed-out session can leave earlier orders already filled at the broker. Gating this on
      // `ok` meant such a fill was never recorded, never alerted, and the position existed with no
      // trade record. RETRY, by contrast, stays gated on `ok` below: recording what filled is
      // always safe, re-placing an order is not.
      if (!ok) console.warn("SELL_SESSION_ABORTED — verifying anyway (an order may have filled before the abort)");
      const verifiedOrNull = await verifySells();
      if (verifiedOrNull === null) {
        // Unknown broker state. Record nothing, place nothing, and say so on the run itself —
        // sendAlert alone is a side-channel the stored run, dashboard and reviewer never see.
        console.warn("SELL_VERIFY_FAILED — unknown broker state, no retry");
        buySizingAdjustments.push(...sellsToExecute.map(s =>
          `${s.symbol} sell UNVERIFIABLE — the broker order-list check failed, so this run cannot tell whether it filled. No retry attempted (it could duplicate a fill). Reconcile manually.`
        ));
        await sendAlert(
          `⚠️ Could not verify sell orders — ${today}`,
          `The broker order-list check failed after the sell session, so this run cannot tell which of these filled: ${sellsToExecute.map(s => s.symbol).join(", ")}.\nNo retry was attempted. Check the account and reconcile manually.`,
        );
      } else {
        let verified = verifiedOrNull;
        let missing = sellsToExecute.filter(s => !verified.has(s.symbol));
        // What we can actually claim afterwards: whether a retry ran at all, and whether the
        // follow-up check settled it. Without these the notes assert non-execution on the abort
        // path — the one path where an order may still be in flight at the broker.
        let retried = false, reverified = true, retryReached = true;
        if (missing.length > 0 && ok) {
          retried = true;
          console.warn("SELL_VERIFY_MISSING — retrying", { missing: missing.map(s => s.symbol) });
          const retryPlaced = await runSellSession(missing, 90_000); // retry only the dropped orders
          const second = await verifySells();
          if (second) { verified = second; missing = sellsToExecute.filter(s => !verified.has(s.symbol)); }
          else { reverified = false; retryReached = retryPlaced; }
        }
        // Record ONLY confirmed sells. A decided sell with no confirmed order didn't
        // execute — leave it unrecorded (the position stays held) and alert.
        for (const s of sellsToExecute) {
          const v = verified.get(s.symbol);
          if (!v) continue;
          const fill = parseFloat(v.avgPrice) > 0 ? v.avgPrice : String(priceMap.get(s.symbol) ?? 0);
          trades.push({ symbol: s.symbol, side: "sell", quantity: v.quantity, avgPrice: fill, state: v.state, actor: "agent", strategy: sellStrategyTag(s.symbol), ...refPriceOf(s.symbol) });
          // Record a MAIN-book discretionary sell so a next-run re-buy trips the rotation-churn flag.
          // (Influencer-sleeve sells have their own rotation logic; the churn concern is the main book.)
          // EXCLUDE a concentration TRIM — it's a risk reduction of a still-held name, not an exit, so
          // it must not enter the recent-sells registry (would poison the rebuy-cooldown + mislabel it).
          if (sellStrategyTag(s.symbol) !== "influencer" && !trimmedSymbols.has(s.symbol)) await recordSell(s.symbol, today, parseFloat(fill) || 0);
        }
        if (missing.length > 0) {
          console.warn("SELL_STILL_MISSING_AFTER_RETRY", { missing: missing.map(s => s.symbol) });
          // Persist the drop on the run itself — sendAlert is a side-channel email the stored
          // run/dashboard/reviewer never see, so without this a decided-but-unconfirmed sell
          // looked identical to a silently-bypassed guard (2026-08-31: same gap on the buy side).
          buySizingAdjustments.push(...missing.map(s =>
            !reverified
              ? `${s.symbol} sell UNVERIFIABLE — ${retryReached ? "a retry WAS placed" : "a retry was attempted but may not have reached the broker"} and the follow-up check failed. Do NOT assume still-held; reconcile manually.`
              : retried
                ? `${s.symbol} sell DID NOT CONFIRM after retry — still held; broker never verified the order filled`
                : `${s.symbol} sell NOT CONFIRMED (no retry attempted — the place session aborted, so an order may still be in flight). Verify before assuming still-held.`
          ));
          await sendAlert(
            `⚠️ Sell orders not confirmed — ${today}`,
            !reverified
              ? `A retry was ${retryReached ? "placed" : "attempted (it may not have reached the broker)"} for these sells and the follow-up check failed, so their state is unknown: ${missing.map(s => s.symbol).join(", ")}.\nDo not assume they are still held — reconcile in Robinhood before the next run.`
              : retried
                ? `These decided sells did NOT execute even after a retry: ${missing.map(s => s.symbol).join(", ")}.\nThey are still held. The next run will re-attempt, or place them manually in Robinhood.`
                : `These decided sells were not confirmed and NO retry was attempted (the place session aborted, so an order may still be in flight): ${missing.map(s => s.symbol).join(", ")}.\nVerify in Robinhood before assuming they are still held.`,
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
      // Each buy is NOTIONAL ($ amount). Include a per-share price hint so the executor can compute
      // the whole-share FALLBACK if a name turns out not to be fractional/dollar-eligible.
      const lines = buys.map(b => {
        const px = priceMap.get(b.symbol) ?? 0;
        const hint = px > 0 ? ` (fallback if not fractional-eligible: buy ${Math.floor(b.dollarAmount / px)} whole shares at ~$${px.toFixed(2)})` : "";
        return `- buy $${b.dollarAmount.toFixed(2)} of ${b.symbol}${hint}`;
      }).join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `Place these market buy orders one at a time for account ${ACCOUNT} using place_equity_order. For each: type=market, dollar_amount=<the $ amount>, time_in_force=gfd, market_hours=regular_hours (a dollar-based/notional order — the broker fills fractional shares). If a dollar_amount order is REJECTED because the stock is not eligible for fractional/dollar-based orders, retry that SAME symbol as a whole-share order instead: type=market, quantity=<the fallback whole-share count shown for it>, time_in_force=gfd (skip it only if the fallback count is 0). Place each order sequentially and wait for confirmation before the next. Do not skip any. Do not analyze — just execute.\n${lines}\nOutput: BUYS_DONE`,
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
    async function verifyBuys(): Promise<Map<string, VerifiedBuy> | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_BUYS:[{"symbol":<TICKER>,"quantity":<QTY>,"avgPrice":<PRICE>,"state":<STATE>}]
Every value must be a quoted JSON string — the <...> above are placeholders, not literals.
Include only BUY orders placed today that are filled or pending (not cancelled/rejected). If none, output VERIFIED_BUYS:[]. Output nothing else.`,
          messages: [{ role: "user", content: "Verify today's buy orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const m = txt.match(/^VERIFIED_BUYS:(.+)$/m);
        // null, NOT an empty Map. "Verified: nothing filled" and "could not verify" are different
        // facts: the first means those orders are genuinely absent from the broker and may be
        // re-placed; the second is unknown state, where re-placing could duplicate a fill that
        // already went through. Collapsing them is what made a parse failure re-place everything.
        if (!m) return null;
        const orders = JSON.parse(m[1]) as VerifiedBuy[];
        // Reject a TEMPLATE ECHO. Unparseable <...> placeholders stop a verbatim echo, but a model
        // that also obeys "every value must be a quoted JSON string" emits {"symbol":"<TICKER>"} —
        // valid JSON, which parses to a map keyed "<TICKER>". Every real symbol then reads as
        // missing, i.e. "nothing of yours filled", and the whole decided list gets re-placed.
        // Treat any placeholder-shaped row as a failure to verify, not as a result.
        const good = orders.filter(o => typeof o?.symbol === "string" && o.symbol.length > 0 && !o.symbol.startsWith("<"));
        // A pure echo leaves nothing behind, so it still degrades to unknown state — but one bad
        // row no longer discards confirmations that ARE real. Recording what filled is always safe.
        if (good.length === 0 && orders.length > 0) return null;
        return new Map(good.map(o => [o.symbol, o]));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    if (decision.buys.length > 0) {
      const ok = await runBuySession(decision.buys, 120_000);
      // Verify regardless of ok; retry only when the session completed cleanly. See the sell path.
      if (!ok) console.warn("BUY_SESSION_ABORTED — verifying anyway (an order may have filled before the abort)");
      const verifiedOrNull = await verifyBuys();
      if (verifiedOrNull === null) {
        console.warn("BUY_VERIFY_FAILED — unknown broker state, no retry");
        buySizingAdjustments.push(...decision.buys.map(b =>
          `${b.symbol} buy UNVERIFIABLE — decided $${b.dollarAmount.toFixed(2)}; the broker order-list check failed, so this run cannot tell whether it filled. No retry attempted (it could duplicate a fill). Reconcile manually.`
        ));
        await sendAlert(
          `⚠️ Could not verify buy orders — ${today}`,
          `The broker order-list check failed after the buy session, so this run cannot tell which of these filled: ${decision.buys.map(b => b.symbol).join(", ")}.\nNo retry was attempted — it could duplicate a fill that already went through. Check the account and reconcile manually.`,
        );
      } else {
        let verified = verifiedOrNull;
        let missing = decision.buys.filter(b => !verified.has(b.symbol));
        let retried = false, reverified = true, retryReached = true;   // see the sell path
        if (missing.length > 0 && ok) {
          retried = true;
          console.warn("BUY_VERIFY_MISSING — retrying", { missing: missing.map(b => b.symbol) });
          const retryPlaced = await runBuySession(missing, 90_000); // retry only the dropped/unconfirmed buys
          const second = await verifyBuys();
          if (second) { verified = second; missing = decision.buys.filter(b => !verified.has(b.symbol)); }
          else { reverified = false; retryReached = retryPlaced; }
        }
        // Record ONLY confirmed buys with real fill data (preserve strategy tag).
        // Any non-S&P 500 ticker (expanded universe) can ONLY belong to the influencer bucket.
        for (const b of decision.buys) {
          const real = verified.get(b.symbol);
          if (!real) continue;
          const strategy: "main" | "influencer" =
            (b.strategy === "influencer" || (influencerCandidateSet.has(b.symbol) && !v1ShortlistSet.has(b.symbol))) ? "influencer" : "main";
          trades.push({ symbol: b.symbol, side: "buy", quantity: real.quantity, avgPrice: real.avgPrice, state: real.state, actor: "agent", strategy, ...refPriceOf(b.symbol) });
        }
        if (missing.length > 0) {
          console.warn("BUY_STILL_MISSING_AFTER_RETRY", { missing: missing.map(b => b.symbol) });
          // Persist the drop on the run itself (2026-08-31: AMAT's decided $200 top-up passed every
          // pre-flight sizing/cap guard with no adjustment note, then silently never confirmed —
          // the only record of it was this sendAlert, a side-channel email the stored run, dashboard,
          // and skeptical reviewer never see). Without this, a genuine execution failure is
          // indistinguishable from a silently-bypassed guardrail.
          buySizingAdjustments.push(...missing.map(b =>
            !reverified
              ? `${b.symbol} buy UNVERIFIABLE — ${retryReached ? "a retry WAS placed" : "a retry was attempted but may not have reached the broker"} and the follow-up check failed. Do NOT assume unbought; reconcile manually.`
              : retried
                ? `${b.symbol} buy DID NOT CONFIRM after retry — decided $${b.dollarAmount.toFixed(2)} but broker never verified a fill; remains unbought, next run re-evaluates`
                : `${b.symbol} buy NOT CONFIRMED (no retry attempted — the place session aborted, so an order may still be in flight). Verify before assuming unbought.`
          ));
          await sendAlert(
            `⚠️ Buy orders not confirmed — ${today}`,
            !reverified
              ? `A retry was ${retryReached ? "placed" : "attempted (it may not have reached the broker)"} for these buys and the follow-up check failed, so their state is unknown: ${missing.map(b => b.symbol).join(", ")}.\nDo not assume they are unbought — reconcile in Robinhood before the next run.`
              : retried
                ? `These decided buys did NOT execute even after a retry: ${missing.map(b => b.symbol).join(", ")}.\nLikely insufficient buying power (today's sells settle T+1) or a dropped order. Place manually if still wanted; the next run re-evaluates.`
                : `These decided buys were not confirmed and NO retry was attempted (the place session aborted, so an order may still be in flight): ${missing.map(b => b.symbol).join(", ")}.\nVerify in Robinhood before assuming they are unbought.`,
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
      // Fill in a live MARKET price for any held symbol the priceMap doesn't already carry
      // (influencer name outside the top-12 momentum set, or a failed Yahoo fetch) so the
      // recorded `price` is never silently the position's avgCost — a price==avgCost
      // placeholder injects a phantom day-over-day move into the sleeve-return series.
      const unresolved = await enrichPriceMap(livePositionsAfter.map(p => p.symbol), priceMap);
      if (unresolved.length > 0) console.warn("POSITION_PRICE_UNRESOLVED — snapshot falling back to avgCost", { symbols: unresolved });
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
            // Tagged like any other sell — an inferred sell is still a real disposal, and leaving it
            // untagged is one of the ways the sleeve accounting lost track of closed positions.
            trades.push({ symbol: pos.symbol, side: "sell", quantity: pos.quantity, avgPrice: avgPrice.toFixed(2), state: "inferred", strategy: sellStrategyTag(pos.symbol) });  // no actor: a reconstruction does not know who placed it
            console.log("INFERRED_SELL", { symbol: pos.symbol, quantity: pos.quantity, avgPrice: avgPrice.toFixed(2) });
          }
        }
      }

      console.log("POST_TRADE_LIVE_SNAPSHOT_OK", { positions: positions.length, cash: cashAfter });
    } else {
      console.warn("POST_TRADE_LIVE_SNAPSHOT_MISSING — falling back to reconstructed snapshot");
      // Reconstruct by QUANTITY, not by symbol. Dropping every symbol that appears in a sell
      // deletes the remainder of a TRIM — the same damage the merge layer was fixed for on
      // 2026-09-15, except here it corrupts what gets STORED, so no downstream fix can recover it
      // (heldDaysOf reads 0 and the 15-day STALE clock silently resets). Buys are folded into an
      // existing row rather than appended, so a top-up doesn't leave two rows for one symbol and
      // make `find(p => p.symbol === X)` consumers see only part of the holding.
      const qtyDelta = new Map<string, number>();
      const boughtCost = new Map<string, number>(); // Σ(qty × price) over PRICED buys only
      const pricedQty = new Map<string, number>();  // qty backing boughtCost (excludes pending)
      for (const t of trades) {
        const q = parseFloat(t.quantity) || 0;
        qtyDelta.set(t.symbol, (qtyDelta.get(t.symbol) ?? 0) + (t.side === "sell" ? -q : q));
        if (t.side === "buy") {
          // verifyBuys deliberately includes PENDING orders, which carry no fill price. Folding a
          // 0 into the weighted average would drag a real basis toward zero (1 @ $100 + a pending
          // 1 @ unknown => $50), corrupting the very number /api/verify diffs against Robinhood.
          const px = parseFloat(t.avgPrice) || 0;
          if (px > 0) {
            pricedQty.set(t.symbol, (pricedQty.get(t.symbol) ?? 0) + q);
            boughtCost.set(t.symbol, (boughtCost.get(t.symbol) ?? 0) + q * px);
          }
        }
      }
      const startingPositions = portfolioCtx?.positions ?? [];
      const merged: Array<{ symbol: string; quantity: string; avgCost: string }> = [];
      for (const p of startingPositions) {
        const startQty = parseFloat(p.quantity) || 0;
        const remaining = startQty + (qtyDelta.get(p.symbol) ?? 0);
        qtyDelta.delete(p.symbol); // consumed — anything left is a brand-new position
        if (remaining <= 1e-6) continue; // fully exited
        // A top-up moves the cost basis. Keeping the old avgCost while the quantity grows stores a
        // basis that /api/verify then compares against live Robinhood's own avgCost, and that the
        // P&L/ledger code reads — e.g. 1 @ $100 topped up with 1 @ $150 must store 2 @ $125, not $100.
        const startCost = parseFloat(p.avgCost) || 0;
        const priced = pricedQty.get(p.symbol) ?? 0;
        // Only priced buys move the basis; an unpriced (pending) top-up leaves it as-is, which is
        // roughly right and never actively wrong.
        const avgCost = priced > 0 && startQty + priced > 0
          ? ((startQty * startCost + (boughtCost.get(p.symbol) ?? 0)) / (startQty + priced)).toFixed(6)
          : p.avgCost;
        merged.push({ symbol: p.symbol, quantity: remaining.toFixed(6), avgCost });
      }
      for (const [symbol, delta] of qtyDelta) {
        if (delta <= 1e-6) continue; // a sell of something not in startingPositions — nothing to add
        const priced = pricedQty.get(symbol) ?? 0;
        merged.push({ symbol, quantity: delta.toFixed(6), avgCost: priced > 0 ? ((boughtCost.get(symbol) ?? 0) / priced).toFixed(6) : "0" });
      }
      // Same guard as the live path: resolve a real market price for any held symbol missing
      // from the priceMap rather than silently stamping avgCost as the snapshot price.
      const unresolved = await enrichPriceMap(merged.map(p => p.symbol), priceMap);
      if (unresolved.length > 0) console.warn("POSITION_PRICE_UNRESOLVED — reconstructed snapshot falling back to avgCost", { symbols: unresolved });
      positions = merged.map(p => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.avgCost,
        price: String(priceMap.get(p.symbol) ?? parseFloat(p.avgCost)),
      }));
      const startingCash = agenticBalance.buyingPower;
      // `|| 0` on BOTH factors: verifyBuys deliberately includes PENDING orders, which carry no
      // fill price, and a single NaN here propagates through cashAfter to serialize the whole run's
      // portfolioAfter.cash as null.
      // Falling back to 0 here would be worse than a NaN: an unpriced (pending) buy still lands in
      // `merged` and picks up a real market price for equityAfter, so charging $0 for it keeps cash
      // that was actually spent and overstates totalValue by the full notional — which then becomes
      // tomorrow's return baseline. Use the market price, same source equityAfter uses.
      const buyCost = trades.filter(t => t.side === "buy")
        .reduce((s, t) => {
          const px = parseFloat(t.avgPrice) || priceMap.get(t.symbol) || 0;
          return s + (parseFloat(t.quantity) || 0) * px;
        }, 0);
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
      // Symmetric with buyCost above: Robinhood's unsettled_funds returns 0, so this IS the live
      // path. A sell stored at avgPrice "0" would understate unsettledAfter and totalValue by the
      // full proceeds, which becomes tomorrow's baseline and reads as a phantom deposit.
      .reduce((s, t) => s + (parseFloat(t.quantity) || 0) * (parseFloat(t.avgPrice) || priceMap.get(t.symbol) || 0), 0);
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

    // Holdings-based book β vs SPY of the FINAL (post-trade) positions — put on baseRun so
    // BOTH the initial saveRun and the later updateLatestRun (which each spread baseRun and
    // overwrite index 0 wholesale) persist it. Gives the dashboard's "Swings vs. Market" card
    // a meaningful-day-one number instead of a noisy realized regression. Same β source
    // (marketData.stocks) buildRiskSection uses.
    const bookBeta = computeBookBetaForPositions(
      marketData.stocks,
      positions.map(p => ({ symbol: p.symbol, value: parseFloat(p.quantity) * parseFloat(p.price) })),
    );

    const baseRun = {
      timestamp: runTimestamp,
      date: today,
      summary: textContent + reentryNote,
      market: {
        stocksLoaded: marketData.stocks.length,
        headlinesLoaded: marketData.headlines.length,
      },
      bookBeta,
      ...(buySizingAdjustments.length > 0 ? { buySizingAdjustments } : {}),
      ...(spyPrice != null ? { spyPrice } : {}),
    };

    // Save core run so orders + positions are persisted even if a later step fails.
    // (Personal-account comparison removed: the agentic MCP token is sandboxed to the
    // agentic account — agentic_allowed:false on the individual account — so the personal
    // snapshot could never be read; the fetch just hung ~25s every run.)
    const saved = await saveRun({ ...baseRun, portfolioAfter, positions, trades, personal: null });
    // Not fatal to the trades — they are already placed — but the run IS the ledger, so a failed
    // write means today's fills exist only at the broker. Say so loudly; /api/verify?capture=1 is
    // what recovers it.
    if (!saved) {
      console.error("TRADE_RUN_NOT_PERSISTED", { date: today, trades: trades.length });
      await sendAlert(
        `🚨 Trade run NOT RECORDED — ${today}`,
        `The orders were placed but the run could not be written to the store, so today's fills are `
        + `missing from the ledger. They will surface as "uncaptured orders" in /api/verify; the next `
        + `autopilot run should capture them.`,
      ).catch(() => {});
    }
    console.log("CORE_RUN_SAVED");

    // Signal-attribution ledger: snapshot the signals present on each confirmed BUY, so their
    // forward returns can be measured per signal over time. Fail-safe — never break the trade run.
    try {
      const buyPicks: SignalPick[] = trades
        .filter((t) => t.side === "buy")
        .map((t) => {
          const s = marketData.stocks.find((x) => x.symbol === t.symbol);
          const ratings = marketData.analystRatings[t.symbol];
          const act = ratings?.length ? [...ratings].sort((a, b) => b.date.localeCompare(a.date))[0].action : null;
          const nw = newsSignals.get(t.symbol);
          const beat = beatHistory.get(t.symbol);
          return {
            symbol: t.symbol,
            date: today,
            strategy: t.strategy ?? "main",
            priceAtBuy: parseFloat(t.avgPrice) || s?.price || 0,
            signals: {
              mom12_1: s?.mom12_1 ?? null,
              quality: quality?.scores?.[t.symbol]?.quality ?? null,
              beta: s?.beta ?? null,
              insider: (marketData.insiderBuys[t.symbol]?.length ?? 0) > 0,
              analyst: act === "upgrade" || act === "raise_pt" ? "up" : act === "downgrade" || act === "lower_pt" ? "down" : null,
              news: nw ? (nw.direction === "+" ? "up" : nw.direction === "-" ? "down" : null) : null,
              earnBeatRate: beat && beat.total > 0 ? beat.beats / beat.total : null,
              influencerNet: influencerNet[t.symbol] ?? null,
            },
          };
        });
      const rec = await recordSignalPicks(buyPicks);
      console.log("SIGNAL_LEDGER", { buys: buyPicks.length, recorded: rec.recorded, skipped: rec.skipped ?? false });
    } catch (e) {
      console.warn("SIGNAL_LEDGER_SKIP", e);
    }

    // ── Mean-reversion SHADOW capture (Phase 1: ZERO capital) ──────────────────────────────────────
    // Log what an oversold-quality "buy the dip" sleeve WOULD pick today, so we can later MEASURE
    // whether it is uncorrelated with the momentum book (the diversification thesis) BEFORE committing
    // any capital. Reuses this run's already-fetched marketData / quality / news / earnings — no extra
    // I/O. FAIL-SAFE: pure observability, can never affect the trade.
    try {
      if (quality) {
        const mrEligible = new Set(Object.entries(quality.scores).filter(([, v]) => v.eligible).map(([s]) => s));
        const qualityOf = (sym: string) => quality.scores[sym]?.quality ?? 0;
        const isBroken = (sym: string) => {
          if (newsSignals.get(sym)?.direction === "-") return true;                    // bearish material news
          if ((marketData.analystRatings[sym] ?? []).some(r => r.action === "downgrade" || r.action === "lower_pt")) return true; // analyst downgrade/PT-cut
          const ed = earningsDatesMap[sym];
          if (ed) { const d = (new Date(ed).getTime() - new Date(today).getTime()) / 86_400_000; if (d >= 0 && d <= 3) return true; } // imminent earnings
          return false;
        };
        const mrCands = screenMeanReversionCandidates(marketData.stocks, mrEligible, qualityOf, isBroken);
        const mrRec = await recordMeanRevShadow(mrCands, today);
        console.log("MEANREV_SHADOW", { candidates: mrCands.length, symbols: mrCands.map(c => c.symbol), logged: mrRec.logged, skipped: mrRec.skipped ?? false });
      }
    } catch (e) {
      console.warn("MEANREV_SHADOW_SKIP", e);
    }

    // FEATURE CAPTURE (Phase 0, docs/experiment-nori-tail-risk.md). Writes down the per-name
    // feature vector this run already computed and would otherwise discard. Zero capital, zero new
    // I/O, no model. A SIBLING of the meanrev shadow, deliberately not nested inside it: a meanrev
    // throw would otherwise skip the capture for that day, and this asset cannot be backfilled.
    try {
      const peOf = (sym: string) => {
        const v = valuationsForCapture?.get(sym);
        return { peTTM: v?.peTTM ?? null, peFY: v?.peFY ?? null };
      };
      const daysToEarningsOf = (sym: string) => {
        const ed = earningsDatesMap[sym];
        if (!ed) return null;
        const d = Math.round((new Date(ed).getTime() - new Date(today).getTime()) / 86_400_000);
        return Number.isFinite(d) ? d : null;
      };
      const rows = buildFeatureRows(
        marketData.stocks,
        (sym) => quality?.scores[sym]?.quality ?? null,
        peOf,
        daysToEarningsOf,
      );
      const cap = await recordFeatureCapture(rows, today, {
        capturedAt: new Date().toISOString(),
        spyPrice: spyPrice ?? null,
      });
      console.log("FEATURE_CAPTURE", { rows: cap.written, bytes: cap.bytes, verified: cap.verified, skipped: cap.skipped ?? false });
    } catch (e) {
      console.warn("FEATURE_CAPTURE_SKIP", e instanceof Error ? e.message : String(e));
    }

    // ── Give-back stop SHADOW capture (Phase 1: ZERO capital) ──────────────────────────────────────
    // The −5% intraday stop misses SLOW BLEEDS (APA/LLY/AMAT bled 4–8% over 5d, none fired, 2026-08-27).
    // Log which MAIN holdings WOULD trip a give-back stop (down ≥5% over 5d) + their price, so we can
    // later measure the forward outcome: did shadow-cut names keep falling (a stop helps) or bounce (it
    // whipsaws)? MAIN book only (the sleeve has its own stop). FAIL-SAFE observability, cannot trade.
    try {
      const stockBySym = new Map(marketData.stocks.map(s => [s.symbol, s]));
      const gbHoldings = (portfolioCtx?.positions ?? [])
        .filter(p => !influencerHeld.has(p.symbol) && stockBySym.has(p.symbol)) // MAIN, priced in the S&P universe
        .map(p => {
          const s = stockBySym.get(p.symbol)!;
          const px = priceMap.get(p.symbol) ?? s.price;
          const avg = parseFloat(p.avgCost) || 0;
          return { symbol: p.symbol, price: px, change5d: s.change5d, distFromHigh: s.distFrom52wHigh, retFromCostPct: avg > 0 ? (px - avg) / avg * 100 : null };
        });
      const gbTrig = screenGivebackStops(gbHoldings);
      const gbRec = await recordGivebackShadow(gbTrig, today);
      console.log("GIVEBACK_SHADOW", { triggered: gbTrig.length, symbols: gbTrig.map(h => `${h.symbol}(${h.change5d.toFixed(1)}%)`), logged: gbRec.logged, skipped: gbRec.skipped ?? false });
    } catch (e) {
      console.warn("GIVEBACK_SHADOW_SKIP", e);
    }

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

    // A null return WITH trades on the books means computeDailyReturn found a trade it could not
    // price from either day's snapshot. That is a PERMANENT hole: /api/debug?patchDate recomputes
    // from the same stored trades and never re-derives avgPrice, so it can never repair it, and the
    // |return| > 30% alarm only fires on a non-null return. Meanwhile the dashboard keeps
    // compounding SPY across the gap, biasing the headline AI-vs-SPY figure by a full day's move.
    // Make it loud at the moment it happens, while the prices are still recoverable.
    // The SAME predicate computeDailyReturn uses, so the alert names the trades that actually
    // blocked it — a looser filter also lists buys and partial sells it priced successfully.
    const unpricedTrades = findUnpriceableTrades(positions, allTradesToday)
      .map(t => `${t.side} ${t.symbol} x${t.quantity}`);
    if (agenticResult === null && unpricedTrades.length > 0 && portfolioAfter && previousDayRun?.portfolioAfter) {
      buySizingAdjustments.push(
        `DAILY RETURN NOT COMPUTED — ${unpricedTrades.join(", ")} has no usable price in either day's snapshot; today's return is a permanent gap unless the fill price is supplied.`);
      await sendAlert(
        "Daily return could not be computed — permanent track-record gap",
        `computeDailyReturn returned null with ${allTradesToday.length} trade(s) recorded. Unpriced: ${unpricedTrades.join(", ")}. patchDate CANNOT repair this (it recomputes from the same trades), so the fill price must be corrected in the stored run.`,
      ).catch(() => {});
    } else if (agenticResult === null && allTradesToday.length > 0 && portfolioAfter && previousDayRun?.portfolioAfter) {
      // The other null path: computeDailyReturn bails when yesterdayValue <= 0. Reachable — a
      // drop-check that liquidated everything with a failed balance fetch stores totalValue "0.00".
      // Gating the price alert on unpriced trades removed this case's ONLY signal, leaving the same
      // silent permanent gap under a different cause.
      const why = !(parseFloat(previousDayRun.portfolioAfter.totalValue) > 0)
        ? `the previous run's portfolioAfter.totalValue is ${previousDayRun.portfolioAfter.totalValue}`
        : "an unknown condition";
      buySizingAdjustments.push(
        `DAILY RETURN NOT COMPUTED — ${why}, so there is no baseline to measure today against. Today's return is a permanent gap unless the prior run's total value is corrected.`);
      await sendAlert(
        "Daily return could not be computed — no usable baseline",
        `computeDailyReturn returned null with ${allTradesToday.length} trade(s) recorded, and no trade was unpriceable — ${why}. Fix the prior run's stored total value; patchDate cannot derive it.`,
      ).catch(() => {});
    }

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

    // Influencer + main sleeve daily returns — one shared definition (computeSleeveReturns)
    // so the sell of a position leaving the sleeve is reconciled in the right book instead of
    // booking as a phantom loss. Stored at trade time in the clean context; the same helper
    // backfills history via /api/debug?recomputeSleeves.
    const prevInfluencerPositions = previousDayRun?.influencerPositions ?? [];
    // Use allTradesToday (incl. earlier same-day runs — e.g. a drop-check that stopped out an
    // influencer name), NOT just this run's trades: else that sell's PROCEEDS aren't credited and the
    // name's value books as a phantom loss (PYPL stopped −11% by the 7am drop-check → sleeve read
    // −51.25% instead of −6.29% on 2026-08-28). The agentic return above already uses allTradesToday.
    const rawSleeves = computeSleeveReturns(
      positions,
      allTradesToday,
      influencerPositions,
      prevInfluencerPositions,
      previousDayRun?.positions ?? [],
    );
    // Clamp an extreme single-day sleeve move at the LIVE write too (not just the recompute), so a
    // residual artifact from any source is nulled here rather than stored raw + shown on the dashboard
    // until a manual recompute. Matches backfillSleeveReturns' sanity clear.
    const influencerDailyReturn = clampSleeveReturn(rawSleeves.influencerDailyReturn);
    const mainDailyReturn = clampSleeveReturn(rawSleeves.mainDailyReturn);

    // Patch the run already saved at index 0 with return metrics.
    const finalRun = {
      ...baseRun,
      // Re-attached HERE, not inherited from baseRun. baseRun snapshotted the array ~170 lines
      // earlier via a conditional spread, so any note pushed afterwards — including the
      // "DAILY RETURN NOT COMPUTED" alert above — was silently dropped whenever no OTHER sizing
      // adjustment had fired, which is the routine case.
      ...(buySizingAdjustments.length > 0 ? { buySizingAdjustments } : {}),
      portfolioAfter,
      positions,
      trades,
      personal: null,
      influencerPositions,
      agenticDailyReturn: agenticResult?.dailyReturn ?? null,
      agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null,
      influencerDailyReturn,
      mainDailyReturn,
    };
    await updateLatestRun(finalRun);

    console.log("TRADE_RUN_COMPLETE", { date: today, summary: textContent.slice(0, 300) });
    // Online observability: log the completed run to Braintrust. Fail-safe — runs AFTER the trade is
    // saved + executed; the helper can't throw, and the .catch() decouples tracing from the trade
    // response entirely (a logging problem must never affect the trade's success/500 path).
    await logTradeRun({ run: finalRun, decision: decidedRaw, buyingPower: agenticBalance ? String(agenticBalance.buyingPower) : null }).catch(() => {});
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
