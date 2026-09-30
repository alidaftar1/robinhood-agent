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
 *  target IS. It is NOT a cap — nothing enforces it. Whether it should be is deliberately still
 *  open; see docs/experiment-main-book-position-cap.md for why concentrating a strategy whose
 *  selection edge is unproven could make things worse rather than better. */
export const TARGET_MAIN_POSITIONS = 6;
