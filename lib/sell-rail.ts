// ─────────────────────────────────────────────────────────────────────────────
// SELL VOLUME RAIL — bounds DISCRETIONARY main-book exits in a single decision.
//
// Why this exists (docs/scope-sell-volume-rail.md): on 2026-09-29, measured against the live book,
// the production model proposed selling the ENTIRE main book in 1 of 4 runs and five names in
// another. Under T+1 the paired buys cannot settle the same day and die on the $50 floor, so that
// decision liquidates into cash, realises every loss, and buys nothing. One sentence of prompt
// wording was all that stood between it and execution.
//
// Sells previously passed exactly one filter — is the name held — while buys passed six
// (off-rails shortlist, rebalance gate, influencer slot cap, per-position cap, budget fit, $50
// floor). A sell reads as the safe direction because it reduces exposure; an UNINTENDED sell
// realises losses, strands capital in cash under T+1, and off-window cannot be reversed for days.
//
// WHY THIS IS SAFE, and it is the whole argument: mechanical risk exits do NOT come through here.
// /api/drop-check builds its own sell list from classifyExit (−5% main same-day, −10% influencer
// from buy, +40% take-profit) and runs six times a day on its own cron. This rail bounds JUDGMENT
// sells only. Without that separation a cap could block real risk management during a sell-off,
// which would be far worse than the problem it solves.
//
// Sells carry no structured reason — justification lives in thesis prose. So the rail does not read
// intent; it VERIFIES the claim independently from data the run already has, and bounds only what
// it cannot verify. A name that is genuinely underwater, stale, off-shortlist, downgraded, carrying
// bearish news, or facing imminent earnings passes unconditionally, however many there are.
// ─────────────────────────────────────────────────────────────────────────────

import { isFullExit, type TradeDecisionSell } from "./trade-decision";

/** Discretionary FULL exits allowed per decision. With a ~6-name target, 2-3 is an ordinary
 *  rotation and 5+ is a restructuring. Trims are never counted — a 50% trim is not a liquidation,
 *  and applyConcentrationTrim already issues partial sells in code. */
export const MAX_DISCRETIONARY_EXITS = 3;

/** Below this since entry, loss discipline independently justifies the exit. Mirrors the prompt's
 *  "more than 10% below entry" rule so code and prompt cannot disagree about what is justified. */
export const LOSS_DISCIPLINE_PCT = -10;

export interface SellRailContext {
  /** Live position, for the return and age the justification tests need. */
  positionOf: (symbol: string) => { avgCost?: number; price?: number; quantity?: number } | undefined;
  /** Still on the buy shortlist or retained by hysteresis — i.e. has NOT fallen off. */
  stillRanked: (symbol: string) => boolean;
  hasBearishNews: (symbol: string) => boolean;
  hasDowngrade: (symbol: string) => boolean;
  /** Days until earnings, or null when unknown / outside the window. */
  daysToEarnings: (symbol: string) => number | null;
  isStale: (symbol: string) => boolean;
  /** Over the concentration cap (⚠CONCEN). The prompt MANDATES reducing these and explicitly
   *  authorises a full exit when the thesis has weakened — and such a name is usually a WINNER
   *  that appreciated past the cap, so none of the distress tests above fire for it. */
  isOverConcentrationCap: (symbol: string) => boolean;
  /** Reported earnings within the lookback. The prompt tells the model to reassess or exit on a
   *  large post-print drop, which can easily be less than 10% BELOW ENTRY and therefore invisible
   *  to loss discipline. */
  reportedRecently: (symbol: string) => boolean;
}

export interface SellRailResult {
  sells: TradeDecisionSell[];
  dropped: string[];
  notes: string[];
}

/** Can the run PROVE this exit was warranted, without reading the thesis? */
export function justifiedReason(symbol: string, ctx: SellRailContext): string | null {
  const pos = ctx.positionOf(symbol);
  const avg = pos?.avgCost;
  const price = pos?.price;
  if (avg != null && price != null && avg > 0) {
    const ret = ((price - avg) / avg) * 100;
    if (ret <= LOSS_DISCIPLINE_PCT) return `down ${ret.toFixed(1)}% since entry (loss discipline)`;
  }
  if (ctx.isStale(symbol)) return "⏳STALE (time-stop)";
  if (!ctx.stillRanked(symbol)) return "fell off the shortlist";
  if (ctx.hasDowngrade(symbol)) return "analyst downgrade";
  if (ctx.hasBearishNews(symbol)) return "bearish material news";
  const d = ctx.daysToEarnings(symbol);
  if (d != null && d >= 0 && d <= 3) return `earnings in ${d}d`;
  if (ctx.isOverConcentrationCap(symbol)) return "⚠CONCEN — over the concentration cap";
  if (ctx.reportedRecently(symbol)) return "just reported earnings";
  return null;
}

/** Bound discretionary full exits. FAILS OPEN: if anything here throws, every sell is returned
 *  untouched — a rail that blocks all sells on its own bug is worse than no rail. */
export function applySellRail(
  sells: TradeDecisionSell[],
  ctx: SellRailContext,
  max: number = MAX_DISCRETIONARY_EXITS,
  opts: { evidenceDegraded?: boolean } = {},
): SellRailResult {
  try {
    // News and analyst ratings both fail to an EMPTY map on a provider outage or a missing key.
    // With them gone, every bearish-news and downgrade exit reads as unverifiable — so the rail
    // would tighten hardest precisely when it can see least. Stand down instead.
    if (opts.evidenceDegraded) {
      return { sells, dropped: [], notes: [] };
    }
    const kept: TradeDecisionSell[] = [];
    const dropped: string[] = [];
    const notes: string[] = [];
    let discretionary = 0;

    for (const s of sells) {
      const symbol = String(s.symbol ?? "");
      const pos = ctx.positionOf(symbol);
      // Not held: harmless, and the executor drops it anyway (SELL_SKIPPED_NOT_HELD). Counting it
      // would let a phantom symbol push a REAL exit over the cap.
      if (!pos) { kept.push(s); continue; }
      // Trims pass unconditionally — reducing a position is not the failure this bounds.
      if (!isFullExit(s, pos.quantity)) { kept.push(s); continue; }
      // No price: loss-discipline, staleness and the concentration test ALL silently read
      // "healthy" without one, so a −20% position would look unjustified and be cappable. Unknown
      // must not mean blockable — this is the documented priceMap gap that once suppressed the
      // ⏳STALE tag the same way.
      if (pos.price == null || !Number.isFinite(pos.price)) { kept.push(s); continue; }

      const reason = justifiedReason(symbol, ctx);
      if (reason) { kept.push(s); continue; }   // provable risk exit — never capped, however many

      discretionary++;
      if (discretionary <= max) { kept.push(s); continue; }

      dropped.push(symbol);
      // RECORDED, never silent. The influencer cap's lesson: the autopilot's decided-vs-executed
      // reconciliation treats a trade that is absent WITHOUT a note as an unexplained anomaly and
      // escalates — so a guard doing its job would otherwise look like a bug.
      notes.push(
        `${symbol} SELL DROPPED — sell-volume rail: this decision proposed more than ${max} ` +
        `discretionary full exits (exits with no code-verifiable reason — not underwater past ` +
        `${LOSS_DISCIPLINE_PCT}%, not ⏳STALE, still ranked, no downgrade, no bearish news, no ` +
        `imminent earnings). Risk exits are never capped; this bounds restructuring. The automatic ` +
        `stop-loss path (/api/drop-check) is unaffected.`,
      );
    }

    return { sells: kept, dropped, notes };
  } catch (e) {
    console.error("SELL_RAIL_FAILED_OPEN — letting every sell through", e instanceof Error ? e.message : String(e));
    return { sells, dropped: [], notes: [] };
  }
}
