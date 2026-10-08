import { requireCronAuth } from "@/lib/auth";
import { dashboardPublicUrl } from "@/lib/dashboard-auth";
import { createAnthropic } from "@/lib/anthropic";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { buildSystemPrompt } from "@/lib/strategy";
import { getMarketData, formatMarketDataForPrompt, fetchCurrentPrice, fetchQuoteLite, enrichPriceMap } from "@/lib/market-data";
import { saveRun, getRuns, type PositionSnapshot, type TradeSnapshot, MAX_RUNS } from "@/lib/run-store";
import { recordStopout, resolveDropCheckExits, classifyExit, buildExitContext, symbolsWithMainOwnership, stopThresholdFor,
         MAIN_DROP_THRESHOLD_PCT, INFLUENCER_DROP_THRESHOLD_PCT } from "@/lib/stopouts";
import { sendAlert } from "@/lib/alert";
import { recordExits, type ExitTrigger } from "@/lib/exit-ledger";
import { isMarketHoliday } from "@/lib/holidays";
import { fetchAgenticBalance } from "@/lib/robinhood-balance";

export const maxDuration = 300;

// Two separate bars, because they measure DIFFERENT THINGS. MAIN is a same-day shock detector
// (intraday, from prev close): a name that was fine yesterday falling out of bed. INFLUENCER is a
// CUMULATIVE drawdown from the buy price, which a slow drift reaches over days.
//
// They are calibrated to volatility, not set equal. Measured 2026-09-17: influencer-sleeve names
// run ~3.7% daily vol vs ~2.5% for main-book names. The old shared −5% was therefore ~1.4σ for the
// sleeve (SPCX/PLTR ~1.0σ — one ordinary day triggers it) while the main book's own cumulative rule
// (−10% from entry, lib/strategy.ts LOSS DISCIPLINE) sits at ~4σ. The wildest names carried the
// tightest leash and stopped out on noise: IMAX stopped −5.66% on 08-28 and was back ABOVE its buy
// price within 10 days; CRM stopped −5.17% on 09-10 and recovered +3.2%. Of the 3 stops observed,
// 2 were whipsaws. −10% puts the sleeve at ~2.7σ — still TIGHTER than the main book's −10% at ~4σ
// (vol-matched parity would be ~−15%). Changed from −5% on 2026-09-17 (owner decision).
// Thresholds + classifyExit live in lib/stopouts.ts so they are unit-testable.

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
  // MAX_RUNS (the full retained history) so symbolsWithMainOwnership() sees main ownership on a
  // long-held name. A SHORT window is the unsafe direction here: missing it reads a merged lot as
  // pure sleeve and grants it the looser bar. Bound to the constant, not a literal — if MAX_RUNS
  // is ever raised, a hardcoded 90 would silently start reading a subset.
  const recentRuns = await getRuns(MAX_RUNS);
  const previousRun = recentRuns[0] ?? null;
  const heldPositions = previousRun?.positions ?? [];

  if (heldPositions.length === 0) {
    return Response.json({ skipped: true, reason: "no positions held" });
  }

  // Influencer picks: measured against the BUY price (not prev close), on their own -10% bar.
  // A position is an influencer pick if it appears in the latest run's influencerPositions.
  // Quantities are kept too: positions are merged per symbol, so an influencer-tagged row can also
  // hold MAIN-book shares (PLTR is both an S&P member and a recurring pick). Such a mixed lot must
  // NOT inherit the sleeve's looser leash — the sell would liquidate the main-book shares as well.
  const influencerSymbols = new Set((previousRun?.influencerPositions ?? []).map(p => p.symbol));
  const mainOwnedSymbols = symbolsWithMainOwnership(recentRuns);

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
      // the stop and +TP target) AND for same-day buys (avoid stopping on a pre-purchase
      // decline). Established main-book holds still use intraday-from-prev-close, which catches
      // a genuine fresh crash on a name that was fine yesterday.
      const ctx = buildExitContext({
        isInfluencer,
        mainOwned: mainOwnedSymbols.has(p.symbol),
        boughtToday: boughtTodaySymbols.has(p.symbol),
        // A missing/zero cost basis makes a from-cost reading impossible; the context falls back
        // to the intraday move, and the sleeve's from-cost bar is not applied to it.
        canMeasureFromBuy: currentPrice > 0 && parseFloat(p.avgCost) > 0,
      });
      const change1d = ctx.measuredFromBuy
        ? ((currentPrice - parseFloat(p.avgCost)) / parseFloat(p.avgCost)) * 100
        : (q?.change1d ?? 0);
      const reason = classifyExit(change1d, ctx);
      // Which bar this name was actually judged against — an influencer name can fall back to the
      // main bar (unusable cost basis, or a merged lot), and the model must not read that -5.4% as
      // failing to meet a stated -10% sleeve bar.
      const bar = stopThresholdFor(ctx) === INFLUENCER_DROP_THRESHOLD_PCT ? "influencer" : "main";
      // State the BASIS too: "main bar" alone is ambiguous between a merged lot and an unusable
      // cost basis, and those report different quantities. The sympathy judgment ("is the whole
      // market down today?") is only meaningful against a same-day figure.
      const basis = ctx.measuredFromBuy ? "from buy" : "same-day";

      return { position: p, change1d, isInfluencer, reason, bar, basis };
    })
    .filter((e): e is { position: PositionSnapshot; change1d: number; isInfluencer: boolean; reason: "stop" | "profit"; bar: string; basis: string } => e.reason !== null);

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
These held positions hit their STOP-LOSS (main book: ≥${Math.abs(MAIN_DROP_THRESHOLD_PCT)}% down — same-day from prev close, or from the BUY price if bought today; influencer sleeve: ≥${Math.abs(INFLUENCER_DROP_THRESHOLD_PCT)}% below its BUY price). Each name is tagged with the bar it was judged against AND the basis its figure is measured on, because a sleeve name can legitimately sit on the main bar (the main book also holds it, or its cost basis is unusable): ${stopEntries.map((e) => `${e.position.symbol} (${e.change1d.toFixed(1)}% ${e.basis}, ${e.bar} bar)`).join(", ")}.
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
    // Snapshot-vs-live divergences, surfaced in the run summary and the alert so an exit the agent
    // SKIPPED is visible rather than silently absent.
    const staleNotes: string[] = [];
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

    type VerifiedSell = { symbol: string; quantity: string; avgPrice: string; state: string; id?: string };
    /**
     * Live holdings AND the sell orders already on the book, in ONE call — both are needed before
     * placing and splitting them would double a 20s MCP round-trip on the risk path.
     *
     * Returns null on any failure. The caller then proceeds on the snapshot, which is the
     * pre-2026-10-08 behaviour: degrading to "place the exit" is the right direction for a RISK
     * path, since refusing to stop out because a status call failed is the worse error.
     */
    async function fetchLiveState(): Promise<{ positions: Array<{ symbol: string; quantity: string }>; sellIds: Set<string>; sawIds: boolean } | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `For account ${ACCOUNT}: call get_equity_positions, then get_equity_orders filtered to today (${today}). Output exactly two lines:
LIVE_POSITIONS:[{"symbol":"XX","quantity":"X.XX"}]
PRIOR_SELLS:[{"id":"<order id>","symbol":"XX","quantity":"X.XX","avgPrice":"XX.XX","state":"XX"}]
For positions use instrument_symbol and quantity. For PRIOR_SELLS include only SELL orders that are FILLED or PENDING (not cancelled or rejected), and copy each order id verbatim. If either is empty output []. Output nothing else.`,
          messages: [{ role: "user", content: "Report live positions and today's sell orders." }],
          mcp_servers: [mcpServer],
          betas: ["mcp-client-2025-04-04"],
        }, { signal: ctrl.signal });
        const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const grab = (marker: string) => {
          const i = txt.indexOf(marker);
          if (i === -1) return null;
          const m = txt.slice(i).match(/\[[\s\S]*?\]/);
          try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
        };
        const positions = grab("LIVE_POSITIONS:") as Array<{ symbol: string; quantity: string }> | null;
        const priorSellsRaw = grab("PRIOR_SELLS:") as VerifiedSell[] | null;
        // EVERY degraded shape must read as UNUSABLE, never as "the account is flat". The reader is
        // an LLM, so the failure modes are not exceptions: it can echo the template verbatim (the
        // placeholders here are already quoted strings, so "XX"/"X.XX" is VALID JSON — the trade
        // route hit exactly this and guards against it), obey "if empty output []" when the MCP tool
        // itself errored, or truncate the list under max_tokens. Each of those would otherwise mean
        // "not held" and SKIP a real stop-loss.
        if (!positions || positions.length === 0 || priorSellsRaw === null) return null;
        const bad = positions.find(p => !/^[A-Z][A-Z.]{0,5}$/.test(String(p?.symbol ?? "").trim().toUpperCase())
                                     || !(parseFloat(String(p?.quantity ?? "")) > 0));
        if (bad) { console.warn("DROP_CHECK_LIVE_STATE_UNUSABLE", { row: bad }); return null; }
        const priorSells = priorSellsRaw;
        console.log("DROP_CHECK_LIVE_STATE", { positions: positions.length, priorSells: priorSells.length });
        // Identity includes the quantity so a SECOND sell of the same name is still seen as new.
        return {
          positions: positions.map(p => ({ symbol: String(p.symbol).trim().toUpperCase(), quantity: String(p.quantity) })),
          // ORDER IDS, not symbol|quantity. Both the agent and the owner exit a WHOLE position, so
          // their quantities match and a quantity-keyed filter discards the agent's own fill.
          sellIds: new Set(priorSells.map(o => String(o.id ?? "")).filter(Boolean)),
          sawIds: priorSells.length === 0 || priorSells.some(o => o.id),
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    async function verifySells(): Promise<Map<string, VerifiedSell>> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const resp = await (anthropic.beta.messages as any).create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Call get_equity_orders for account ${ACCOUNT} filtered to today (${today}). Output exactly one line:
VERIFIED_SELLS:[{"id":"<order id>","symbol":"XX","quantity":"X","avgPrice":"XX.XX","state":"XX"}]
Include only SELL orders placed today that are filled or pending (not cancelled/rejected). Copy each order id verbatim. If none, output VERIFIED_SELLS:[]. Output nothing else.`,
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
        return new Map((JSON.parse(arr[0]) as VerifiedSell[]).map((o) => [String(o.symbol).trim().toUpperCase(), o]));
      } catch {
        return new Map();
      } finally {
        clearTimeout(timer);
      }
    }

    // ── BEFORE PLACING: is the book still what we think it is? ────────────────
    // Exits are DETECTED from previousRun.positions, a 07:30 snapshot. The owner trades this
    // account by hand during the session, so by 10:00 that snapshot can be hours out of date.
    //
    // 2026-10-06 is the worked example and it cost more than a stale order. The owner had already
    // sold ILMN; the snapshot still showed it held; the stop triggered on a real -5.8% break and
    // placed a sell for a position that no longer existed. Then verifySells — which asks the broker
    // for "SELL orders placed today" and matches BY SYMBOL, with nothing distinguishing an order we
    // placed from one the owner placed — found the OWNER's fill and recorded it as confirmation of
    // our own. The agent reported a successful risk exit it had no part in, and the false
    // attribution survived into the ledger.
    //
    // So: re-read holdings from the broker and take the PRE-EXISTING sell orders in the same call,
    // but only once a drop has already been detected — the common path exits long before here, so
    // this costs nothing on a quiet run.
    const pre = sellsToExecute.length > 0 ? await fetchLiveState() : null;
    if (pre) {
      const liveQty = new Map(pre.positions.map(p => [p.symbol, parseFloat(p.quantity) || 0]));
      // CORROBORATION GATE. The read may only VETO an exit if it demonstrably describes this
      // account: at least one name we still hold and are NOT exiting must appear in it. Without
      // that, a read that is well-formed but about nothing (or badly truncated) can silently
      // cancel every stop. Skipping a stop costs unbounded downside with no retry until tomorrow —
      // /api/drop-check with no scope, the only MAIN-book check, runs ONCE a day. Placing a sell
      // for a position already closed costs a broker rejection. Those are not symmetric, so the
      // risk path fails toward PLACING.
      const exiting = new Set(sellsToExecute.map(s => s.symbol));
      const corroborated = heldPositions.some(p => !exiting.has(p.symbol) && (liveQty.get(p.symbol) ?? 0) > 0);
      if (!corroborated && heldPositions.some(p => !exiting.has(p.symbol))) {
        console.warn("DROP_CHECK_LIVE_STATE_UNCORROBORATED — placing on the snapshot", {
          live: [...liveQty.keys()], snapshot: heldPositions.map(p => p.symbol),
        });
        staleNotes.push("live holdings could not be corroborated — exits placed on the 07:30 snapshot");
      } else {
        const dropped: string[] = [];
        for (let i = sellsToExecute.length - 1; i >= 0; i--) {
          const s = sellsToExecute[i];
          const live = liveQty.get(s.symbol) ?? 0;
          const want = parseFloat(s.quantity) || 0;
          if (live <= 0) { dropped.push(`${s.symbol} (no longer held)`); sellsToExecute.splice(i, 1); continue; }
          // Only a MATERIAL shortfall re-sizes. The reader formats quantities to ~2dp, so a held
          // 2.371 comes back "2.37" — re-sizing on that strands a dangling fraction (breaking this
          // route's own "no dangling fraction is left" guarantee) and tells the owner they trimmed
          // a position they never touched.
          if (live < want * 0.995) {
            dropped.push(`${s.symbol} (owner trimmed to ${live})`);
            sellsToExecute[i] = { ...s, quantity: String(live) };
          }
        }
        if (dropped.length > 0) {
          console.warn("DROP_CHECK_STALE_SNAPSHOT", { adjusted: dropped });
          staleNotes.push(...dropped);
        }
      }
    } else if (sellsToExecute.length > 0) {
      // Unusable read. Place on the snapshot — but say the attribution is unverified rather than
      // asserting a clean exit, because nothing about risk management requires claiming one.
      staleNotes.push("live holdings unreadable — exits placed on the 07:30 snapshot, attribution unverified");
    }

    if (sellsToExecute.length > 0) {
      const ok = await runSellSession(sellsToExecute, 120_000);
      if (!ok) console.warn("DROP_CHECK_SELL_SESSION_ABORTED — verifying anyway (an order may have filled before the abort)");
      // Verify REGARDLESS of ok: an aborted/timed-out place session can still have filled orders on
      // Robinhood. verifySells reads get_equity_orders (ground truth), so we record what truly filled
      // and never assume "nothing executed" just because the place call errored.
      // Discard any order that was ALREADY on the book before we placed. verifySells matches by
      // symbol and cannot tell whose order it found; without this, an exit the owner had already
      // made counts as confirmation of ours (2026-10-06 ILMN). Only applied when the pre-read
      // succeeded — with no "before" picture there is nothing to subtract.
      // Was this fill OURS? Identified by ORDER ID — a quantity is not an identity, because both the
      // agent and the owner exit a whole position, so their quantities match. Fails toward "ours"
      // whenever ids are unavailable on either side: discarding a genuine fill is the worse error,
      // since the sale then goes unrecorded while its proceeds sit in cash, double-counting the
      // position in portfolioAfter and inflating the day's return.
      const isOurs = (v: VerifiedSell) => !pre || !pre.sawIds || !v.id || !pre.sellIds.has(v.id);
      let verified = await verifySells();
      // RETRY IS DECIDED ON THE RAW VERIFICATION, never on the ownership filter. A discarded
      // pre-existing match must not read as "our order did not fill" — that would place a SECOND
      // real sell order on a name someone has already exited.
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
        if (!isOurs(v)) {
          console.warn("DROP_CHECK_PREEXISTING_ORDER_IGNORED", { symbol: s.symbol, orderId: v.id });
          staleNotes.push(`${s.symbol} (filled by a pre-existing order, not ours)`);
          continue;
        }
        const fill = parseFloat(v.avgPrice) > 0 ? v.avgPrice : String(liteMap.get(s.symbol)?.price ?? priceMap.get(s.symbol) ?? 0);
        trades.push({ symbol: s.symbol, side: "sell", quantity: v.quantity, avgPrice: fill, state: v.state, actor: "agent", strategy: sellStrategyTag(s.symbol) });
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
    const staleNote = staleNotes.length > 0
      ? `\n\nSNAPSHOT WAS STALE — the live book had already changed, so these exits were adjusted or skipped: ${staleNotes.join(", ")}. Almost always the owner trading by hand during the session.`
      : "";
    const soldList = trades.filter((t) => t.side === "sell").map((t) => `${t.symbol} x${t.quantity} @ ${t.avgPrice}`).join(", ") || "none confirmed";

    const saved = await saveRun({
      timestamp: runTimestamp,
      date: today,
      summary: `[RISK-EXIT] Sold: ${soldList}.${sympathyNote}${staleNote}`,
      portfolioAfter,
      positions,
      trades,
      personal: previousRun?.personal ?? null,
      influencerPositions,
      market: { stocksLoaded: marketData.stocks.length, headlinesLoaded: marketData.headlines.length },
      ...(spyPrice != null ? { spyPrice } : {}),
    });

    // EXIT LEDGER — this path knows exactly why it sold, which is the whole point of recording it.
    // Fail-safe: never blocks or alters the exit, and a write failure is swallowed inside.
    await recordExits(
      trades.filter(t => t.side === "sell" && parseFloat(t.avgPrice) > 0).map(t => {
        const e = droppedPositions.find(d => d.position.symbol === t.symbol);
        return {
          symbol: t.symbol,
          date: today,
          strategy: t.strategy ?? "main",
          priceAtExit: parseFloat(t.avgPrice),
          trigger: (e?.reason === "profit" ? "take-profit" : "stop") as ExitTrigger,
        };
      }),
    ).catch(() => 0);

    const dashboardUrl = dashboardPublicUrl(process.env.APP_URL);
    // The orders are REAL whether or not the run persisted, so the sale is still reported — but the
    // header must not say the system is in a good state when its own ledger is missing the trade.
    // This is the 2026-10-06 ILMN case: a correct -5.8% stop, a real fill at $276.75, an
    // unpersisted run, and a "🔴 Risk-Exit Triggered" email that read like everything worked.
    await sendAlert(
      saved
        ? `${hasProfit && !hasStop ? "🟢 Take-Profit" : "🔴 Risk-Exit"} Triggered — ${today}`
        : `🚨 Risk-Exit EXECUTED but NOT RECORDED — ${today}`,
      saved
        ? `Sold: ${soldList}.${sympathyNote}${staleNote}\n\nCheck the dashboard:\n${dashboardUrl}`
        : `Sold: ${soldList}.${sympathyNote}${staleNote}\n\n`
          + `THE ORDERS WENT THROUGH — the run could not be written to the store, so the trade is `
          + `missing from the ledger every return and attribution figure is computed from. It will `
          + `show up as an "uncaptured order" in /api/verify; the next autopilot run should capture `
          + `it (verify?capture=1). If it does not, record it before trusting any return number.\n\n`
          + `${dashboardUrl}`,
    );

    console.log("DROP_CHECK_COMPLETE", { sold: [...soldSymbols], heldOnSympathy, saved });
    return Response.json({ success: true, persisted: saved, sold: [...soldSymbols], heldOnSympathy, date: today });
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
