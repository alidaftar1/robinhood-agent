// Leaf module ON PURPOSE — no imports. The target is needed by the shortlist builder
// (lib/market-data), the analysis prompt (lib/strategy) and the dashboard, and putting it in any
// of those makes the others import a heavy module for one number. strategy -> market-data in
// particular creates a runtime cycle through influencer-signals ("Cannot access SP500_UNIVERSE
// before initialization"), which a type-only import had been hiding.

/** Target number of MAIN-BOOK holdings.
 *
 *  Until 2026-09-29 this existed only as a `?? 6` default inside buildV1Shortlist and as the words
 *  "up to 6" in the prompt — and "up to 6" means per REBALANCE, not in total. Nothing counted the
 *  book against it, so buys added, hysteresis retained, and the count ratcheted to 12: ~$201
 *  positions against a ~$402 design, which at beta 0.83 across seven sectors is an index clone.
 *
 *  Named and exported so the shortlist, the prompt and the dashboard cannot disagree about what the
 *  target IS. Since 2026-09-29 it IS enforced on buys (app/api/trade's main-book cap); see
 *  docs/experiment-main-book-position-cap.md for the original caution about concentrating a
 *  strategy whose selection edge is unproven.
 *
 *  6 -> 7 on 2026-10-14, from the position sweep at the current -10% stop bar
 *  (`bun scripts/full-period.ts --positions 4,5,6,7,8,10,12`, docs/experiment-stop-threshold.md):
 *
 *      positions     CAGR   Sharpe     IR    maxDD
 *      4          +11.75%     0.49   0.26   -90.9%
 *      6          +11.51%     0.51   0.24   -79.0%   <- was here
 *      7          +11.60%     0.52   0.24   -73.8%
 *      8           +9.77%     0.47   0.15   -72.3%
 *      12          +8.35%     0.45   0.06   -69.1%
 *
 *  Return is flat from 4 to 7 and falls off a cliff at 8+; drawdown improves MONOTONICALLY with
 *  count, across a 22pp range. So 7 buys ~5pp of drawdown for a return difference of 0.09pp, which
 *  is inside the noise — the honest claim is "drawdown improves at no measurable return cost", not
 *  "7 is optimal". 6 vs 7 is not a distinguishable return result and must not be quoted as one.
 *
 *  WHY THIS LEVER AND NOT THE STOP: 23 stop configurations moved maxDD by ~1-5pp unsystematically;
 *  position count moves it 22pp monotonically. Concentration is where this book's risk lives.
 *
 *  The sector cap is DERIVED from N: since 2026-10-23 it is ≤3x the sector's S&P weight in names
 *  (lib/sector-cap — at N=7: Tech 3, Financials/Health Care 2, others 1); before, floor(0.4 x N). */
export const TARGET_MAIN_POSITIONS = 7;
