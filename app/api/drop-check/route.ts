import { requireCronAuth } from "@/lib/auth";
import { dashboardPublicUrl } from "@/lib/dashboard-auth";
import { createAnthropic } from "@/lib/anthropic";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice, fetchQuoteLite, enrichPriceMap } from "@/lib/market-data";
import { saveRun, getRuns, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";
import { recordStopout, resolveDropCheckExits } from "@/lib/stopouts";
import { sendAlert } from "@/lib/alert";
import { isMarketHoliday } from "@/lib/holidays";
import { fetchAgenticBalance } from "@/lib/robinhood-balance";

export const maxDuration = 300;

const DROP_THRESHOLD_PCT = -5; // sell if down ≥5% (intraday for main; from buy for influencer)
const TAKE_PROFIT_PCT = 40;    // influencer winners: let winners run — lock the gain at +40% from buy price

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = new Date().toISOString().split("T")[0];

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
  }

  // scope=influencer → only check influencer positions (hourly tight leash).
  // No scope → check ALL positions (the original once-daily full stop check).
  const scope = new URL(request.url).searchParams.get("scope");
  const influencerOnly = scope === "influencer";

  // Fetch a few recent runs (not just the latest): an intraday exit run this same day
  // saves a sells-only run at the front of the list, so getLatestRun() alone would hide
  // the morning trade run's buys — which boughtTodaySymbols below needs. runs[0] is still
  // the canonical latest for held-positions/portfolio context.
  const recentRuns = await getRuns(6);
  const previousRun = recentRuns[0] ?? null;
  const heldPositions = previousRun?.positions ?? [];

  if (heldPositions.length === 0) {
    return Response.json({ skipped: true, reason: "no positions held" });
  }

  // Influencer picks: use tighter stop-loss vs buy price (not prev close)
  // A position is an influencer pick if it appears in the latest run's influencerPositions
  const influencerSymbols = new Set((previousRun?.influencerPositions ?? []).map(p => p.symbol));

  // Names bought TODAY. Their intraday % from prev-close includes the part of the day
  // that happened BEFORE we bought them — measuring the stop from that baseline whipsaws
  // a fresh buy out on a decline it never took (see the TER 2026-07-27 same-day round-trip:
  // −5.75% from prev-close but +1.1% from the actual buy). Measure these from buy price
  // instead, the same treatment influencer picks already get. Union buys across ALL of
  // today's runs (an earlier intraday sells-only exit run must not hide the morning buys).
  const boughtTodaySymbols = new Set(
    recentRuns
      .filter((r) => r.date === today)
      .flatMap((r) => (r.trades ?? []).filter((t) => t.side === "buy").map((t) => t.symbol))
  );

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
      // Measure from BUY price (avgCost) instead of prev-close for influencer picks (covers
      // the −5% stop and +TP target) AND for same-day buys (avoid stopping on a pre-purchase
      // decline). Established main-book holds still use intraday-from-prev-close, which catches
      // a genuine fresh crash on a name that was fine yesterday.
      const measureFromBuy = isInfluencer || boughtTodaySymbols.has(p.symbol);

      let change1d: number;
      if (measureFromBuy && currentPrice > 0 && parseFloat(p.avgCost) > 0) {
        change1d = ((currentPrice - parseFloat(p.avgCost)) / parseFloat(p.avgCost)) * 100;
      } else {
        change1d = q?.change1d ?? 0;
      }

      let reason: "stop" | "profit" | null = null;
      if (change1d <= DROP_THRESHOLD_PCT) reason = "stop";
      else if (isInfluencer && change1d >= TAKE_PROFIT_PCT) reason = "profit";

      return { position: p, change1d, isInfluencer, reason };
    })
    .filter((e): e is { position: PositionSnapshot; change1d: number; isInfluencer: boolean; reason: "stop" | "profit" } => e.reason !== null);

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
    const anthropic = createAnthropic();

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
    // Broad-market regime (SPY vs its ~100-day MA) — the cleanest input for the sympathy
    // check below. Steadier than raw SPY %; on a risk-off day a drop is more likely
    // sympathy (lean hold), on risk-on a lone crater is more likely name-specific (cut).
    const regime = marketData.spyContext?.regime;
    const regimeLine = regime
      ? `MARKET REGIME (use for the sympathy check): ${regime.riskOn ? "RISK-ON" : "RISK-OFF"} — SPY $${regime.spy.toFixed(2)} is ${regime.riskOn ? "ABOVE" : "BELOW"} its 100-day average $${regime.ma.toFixed(2)}. ${regime.riskOn ? "Broad market is in an uptrend, so a single name cratering here is MORE likely name-specific — the drop is real, lean toward CUTTING." : "Broad market is in a downtrend, so a drop is MORE likely broad-market sympathy — a sympathy-HOLD (if fundamentals are intact) is more defensible."}\n`
      : "";
    const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const runTimestamp = new Date().toISOString();

    // ── Reasoning pass — NO trade token (security audit 2026-08-18, finding [7]) ──────
    // The reasoning model NEVER holds the Robinhood MCP token. It ONLY decides which STOP-LOSS
    // names to hold on sympathy; a constrained executor (below) places the resulting sells.
    // Take-profits are non-negotiable (always sold). A BUY cannot happen: no code path builds one
    // (sells come only from held positions), the reasoning model that ingests untrusted headlines
    // has no MCP token, and the MCP-enabled executor/verify calls receive only code-controlled
    // sell/read prompts with no injected data. (place_equity_order is still a tool on the executor's
    // MCP — safety is the code-controlled prompt + no injection reaching it, not tool removal.)
    // Replaces the prior design where Sonnet held the token and "don't buy" was prompt-only, caught
    // after the fact by a detector that couldn't un-place an order.
    const stopEntries = droppedPositions.filter((e) => e.reason === "stop");
    const sympathyHolds = new Set<string>();
    let decisionText = "";
    if (stopEntries.length > 0) {
      const decisionSystem = `${basePrompt}

🔴 RISK-EXIT DECISION — ${today} 🔴  (DECISION ONLY — you place NO orders)
These held positions hit a STOP-LOSS (down ≥${Math.abs(DROP_THRESHOLD_PCT)}%): ${stopEntries.map((e) => `${e.position.symbol} (${e.change1d.toFixed(1)}%)`).join(", ")}.
Default action is to SELL each — a stop-loss is a thesis breakdown, cut it. The ONE exception: if a drop is clearly broad-market SYMPATHY selling (whole market down, fundamentals unchanged), you may HOLD that name and let it recover.
${regimeLine}For EACH stop-loss name, decide SELL or HOLD-on-sympathy. (Take-profit exits are handled separately in code and are always sold — not your call.)
Output EXACTLY one line, nothing else:
SELL_DECISION:{"hold":["SYM",...]}
List only the names to HOLD on sympathy; every stop-loss not listed will be SOLD. When in doubt, SELL (leave it out) — capital preservation is the default.`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: decisionSystem,
          messages: [{ role: "user", content: "Decide SELL or HOLD-on-sympathy for each stop-loss name. Output the SELL_DECISION line only." }],
          // NO mcp_servers on purpose — this model cannot place orders. Execution is code-driven below.
        }, { signal: ctrl.signal });
        decisionText = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const m = decisionText.match(/^SELL_DECISION:(.+)$/m);
        if (m) {
          const parsed = JSON.parse(m[1]) as { hold?: string[] };
          for (const s of parsed.hold ?? []) {
            const sym = String(s).toUpperCase();
            // Only honor a HOLD for a name that actually triggered a stop — never invent a hold.
            if (stopEntries.some((e) => e.position.symbol === sym)) sympathyHolds.add(sym);
          }
        }
      } catch (e) {
        // Fail-safe: on any decision error, HOLD NONE → sell every triggered stop. A stopped
        // position defaulting to SOLD is the capital-preservation choice; never hold on an error.
        console.warn("DROP_CHECK_DECISION_FAILED — defaulting to SELL all stops", e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }
    }

    // ── Code builds the sell set — full held quantity of every name we're exiting ─────
    // Take-profits (always) + stop-losses not held on sympathy. Quantity is the EXACT held
    // amount (incl. fractional) so no dangling fraction is left. Nothing else can be sold; and
    // there is no code path that constructs a BUY.
    const { exiting, heldOnSympathy } = resolveDropCheckExits(droppedPositions, sympathyHolds);
    const sellsToExecute = exiting
      .map((e) => ({ symbol: e.position.symbol, quantity: e.position.quantity }))
      .filter((s) => (parseFloat(s.quantity) || 0) > 0);

    let portfolioAfter: { totalValue: string; cash: string; equity: string; unsettledCash?: string } | null = null;
    let positions: PositionSnapshot[] = [];
    const trades: TradeSnapshot[] = [];

    // DRY RUN: report the decision + the sells we WOULD place, then stop — place nothing, save nothing.
    if (dryRun) {
      return Response.json({
        dryRun: true, today, scope: scope ?? "all",
        triggered: droppedPositions.map((e) => ({ symbol: e.position.symbol, reason: e.reason, change1d: Number(e.change1d.toFixed(2)) })),
        heldOnSympathy,
        wouldSell: sellsToExecute,
        decision: decisionText.slice(0, 200),
      });
    }

    // ── Constrained executor (Haiku, MCP) — handed ONLY the sell list; cannot buy ─────
    // Mirrors /api/trade's runSellSession/verifySells: place one at a time, verify each hit
    // Robinhood via get_equity_orders, retry any that didn't ONCE, record only confirmed fills.
    const mcpServer = { type: "url", url: "https://agent.robinhood.com/mcp/trading", name: "robinhood", authorization_token: accessToken };
    const sellStrategyTag = (sym: string) => (influencerSymbols.has(sym) ? "influencer" : undefined);

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
        console.log("DROP_CHECK_SELLS_DONE", { count: sells.length, result: txt.slice(0, 100) });
        return true;
      } catch (e) {
        console.warn("DROP_CHECK_SELLS_FAILED", e instanceof Error ? e.message : String(e));
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
        // Tolerate the model pretty-printing the array across lines despite "one line": take the
        // first complete [...] after the marker. verifySells is the ONLY source of truth for what
        // actually filled now, so a parse miss = a real sell recorded as still-held (phantom holding).
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
      if (!ok) console.warn("DROP_CHECK_SELL_SESSION_ABORTED — verifying anyway (an order may have filled before the abort)");
      // Verify REGARDLESS of ok: an aborted/timed-out place session can still have filled orders on
      // Robinhood. verifySells reads get_equity_orders (ground truth), so we record what truly filled
      // and never assume "nothing executed" just because the place call errored.
      let verified = await verifySells();
      let missing = sellsToExecute.filter((s) => !verified.has(s.symbol));
      if (missing.length > 0) {
        console.warn("DROP_CHECK_SELL_VERIFY_MISSING — retrying", { missing: missing.map((s) => s.symbol) });
        await runSellSession(missing, 90_000); // retry only the dropped orders
        verified = await verifySells();
        missing = sellsToExecute.filter((s) => !verified.has(s.symbol));
      }
      // Record ONLY confirmed sells. A decided sell with no confirmed order didn't execute —
      // leave it unrecorded (the position stays held) and alert. Prefer the REAL fill price from
      // get_equity_orders; fall back to the live detection quote.
      for (const s of sellsToExecute) {
        const v = verified.get(s.symbol);
        if (!v) continue;
        const fill = parseFloat(v.avgPrice) > 0 ? v.avgPrice : String(liteMap.get(s.symbol)?.price ?? priceMap.get(s.symbol) ?? 0);
        trades.push({ symbol: s.symbol, side: "sell", quantity: v.quantity, avgPrice: fill, state: v.state, strategy: sellStrategyTag(s.symbol) });
      }
      if (missing.length > 0) {
        console.warn("DROP_CHECK_SELL_STILL_MISSING", { missing: missing.map((s) => s.symbol) });
        await sendAlert(
          `⚠️ Drop-check sells not confirmed — ${today}`,
          `These exits did NOT execute even after a retry: ${missing.map((s) => s.symbol).join(", ")}.\nThey are still held. The next run will re-attempt, or sell them manually in Robinhood.`,
        );
      }
    }

    // Surviving positions = held minus CONFIRMED sells (a sympathy-hold or an unconfirmed sell stays held).
    const soldSymbols = new Set(trades.filter((t) => t.side === "sell").map((t) => t.symbol));
    const survivors = heldPositions.filter((p) => !soldSymbols.has(p.symbol));
    // Live-fetch a market price for any survivor missing from priceMap/liteMap — otherwise it falls
    // back to avgCost, injecting a phantom 0% day-over-day move into the sleeve-return series (the
    // old snapshot path guarded this with the same enrichPriceMap call).
    await enrichPriceMap(survivors.map((p) => p.symbol), priceMap);
    positions = survivors
      .map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost, price: String(priceMap.get(p.symbol) ?? liteMap.get(p.symbol)?.price ?? p.avgCost) }));
    const equity = positions.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);
    const sellProceeds = trades.filter((t) => t.side === "sell").reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
    // Prefer the LIVE balance (settled + true unsettled) so this thin run records ALL of today's
    // unsettled proceeds — incl. the morning rebalance's sells — not just its own. Fall back to
    // the prior run's cash + this run's proceeds.
    const live = await fetchAgenticBalance(anthropic, accessToken);
    if (live) {
      portfolioAfter = {
        totalValue: (live.buyingPower + live.unsettled + equity).toFixed(2),
        cash: live.buyingPower.toFixed(2),
        equity: equity.toFixed(2),
        unsettledCash: live.unsettled.toFixed(2),
      };
    } else {
      const cash = parseFloat(previousRun?.portfolioAfter?.cash ?? "0");
      portfolioAfter = {
        totalValue: (cash + equity).toFixed(2),
        cash: cash.toFixed(2),
        equity: equity.toFixed(2),
        unsettledCash: (isFinite(sellProceeds) && sellProceeds > 0 ? sellProceeds : 0).toFixed(2),
      };
    }

    // Record stop-loss exits we ACTUALLY sold (not sympathy-holds) so the next analysis can reason
    // about re-entry instead of blindly re-buying the name it just dumped. Take-profits went UP —
    // a different re-entry decision, so skip those. Best-effort.
    for (const e of stopEntries) {
      if (soldSymbols.has(e.position.symbol)) await recordStopout(e.position.symbol, today, e.change1d);
    }

    // Carry forward influencer tracking: surviving influencer positions only (sold ones drop out).
    const influencerPositions = positions.filter((p) => influencerSymbols.has(p.symbol));

    const sympathyNote = heldOnSympathy.length > 0 ? `\n\nHELD on sympathy (stop-loss judged broad-market): ${heldOnSympathy.join(", ")}.` : "";
    const soldList = trades.filter((t) => t.side === "sell").map((t) => `${t.symbol} x${t.quantity} @ ${t.avgPrice}`).join(", ") || "none confirmed";

    await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[RISK-EXIT] Sold: ${soldList}.${sympathyNote}`,
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
      `${hasProfit && !hasStop ? "🟢 Take-Profit" : "🔴 Risk-Exit"} Triggered — ${today}`,
      `Sold: ${soldList}.${sympathyNote}\n\nCheck the dashboard:\n${dashboardUrl}`,
    );

    console.log("DROP_CHECK_COMPLETE", { sold: [...soldSymbols], heldOnSympathy });
    return Response.json({ success: true, sold: [...soldSymbols], heldOnSympathy, date: today });
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
