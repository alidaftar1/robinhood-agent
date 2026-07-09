// ─────────────────────────────────────────────────────────────────────────────
// PAST-MISSES REGISTRY
//
// Every entry here is a real bug or bad outcome the OWNER caught by hand that the
// autopilot's deterministic checks did NOT flag. The skeptical-reviewer pass
// (lib/autopilot-review.ts) reads this list every morning and explicitly checks
// the current run for a recurrence of each one.
//
// HOW TO ADD ONE: whenever you catch something the autopilot missed, append a row.
// Keep `check` phrased as a concrete, run-data-driven question the reviewer can
// actually answer from what it's given (today's run, recent runs, positions,
// trades, the parsed TRADE_DECISION). This is the mechanism that keeps the
// autopilot from going stale — today's miss becomes tomorrow's check.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownIssue {
  /** When this class of miss was first caught, YYYY-MM-DD. */
  date: string;
  /** Short name for the failure mode. */
  title: string;
  /** What actually went wrong / why it mattered. */
  lesson: string;
  /** A concrete question the reviewer answers from the run data. */
  check: string;
}

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    date: "2026-06-23",
    title: "Silent self-heal masks a failed morning",
    lesson:
      "The trade cron 529'd (Anthropic overloaded) at 7:30am and the 8:01am retry 529'd too; the run only succeeded on a later attempt. Because both autopilots inspect the recovered run, they reported HEALTHY and never surfaced that the pipeline failed twice and no success report went out.",
    check:
      "Is the run's timestamp far later than the 14:30 UTC (7:30am PT) scheduled cron? A run stamped ~15:01 UTC or later means the morning failed at least once and silently recovered — say so explicitly even though the end state is fine.",
  },
  {
    date: "2026-06-22",
    title: "Influencer falling-knife buy",
    lesson:
      "Bought SPCX at $166 while it was already crashing post-IPO ($211→$185→$166); it kept falling and stopped out at −6.9%. A buy can be 'valid' structurally yet be a bad falling-knife entry.",
    check:
      "For each BUY (especially strategy:influencer), does the run/thesis show it was bought into a downtrend (well off a recent high, negative 5d momentum) without the momentum guard catching it? Flag any influencer buy that looks like chasing a crashing name.",
  },
  {
    date: "2026-06-22",
    title: "Wrong derived metric despite clean reconciliation",
    lesson:
      "The 'T+1 settling' / unsettled-cash figure was inferred from sell trades and showed $354 when the live value was $505. /api/verify still passed (cashDiff $0) because the bug was in a DERIVED dashboard metric, not stored cash — reconciliation can't catch derived-metric bugs.",
    check:
      "Do the derived figures self-reconcile? totalValue should ≈ settled cash + unsettledCash + equity. unsettledCash should ≈ live cash − settled buying power. Flag any composition that doesn't add up, even if cashDiff reconciled.",
  },
  {
    date: "2026-06-23",
    title: "Transfer amount mislabeled as an expected deposit",
    lesson:
      "A real $334 deposit surfaced as impliedTransfer ~$509 (a totalValue format-transition artifact). The deterministic check only says 'transfer >$300 → expected deposit', so it auto-labeled the WRONG number as fine instead of flagging the mismatch.",
    check:
      "Is impliedTransfer nonzero on a day with no known owner deposit, or does its size look like an artifact rather than a round real transfer? Flag transfers that can't be cleanly explained — don't assume large == legitimate deposit.",
  },
  {
    date: "2026-06-22",
    title: "Dedup kept the thin intraday run",
    lesson:
      "A same-date stop-loss run (1 trade, null return) overwrote the main daily run (full trades + correct return) because dedup kept the latest timestamp. Fixed in mergeRunsByDate, but the symptom is worth watching for.",
    check:
      "Does today (or a recent date) show only 1 trade and a null/odd return where a full rebalance was expected? That signature suggests the main run was lost to a thin intraday run.",
  },
  {
    date: "2026-06-24",
    title: "Phantom holding after an intraday stop-loss",
    lesson:
      "A noon stop-loss sold SMCI after the 7:30am run had already snapshotted it as held. Dedup correctly kept the main run and unioned in the sell trade, but left SMCI in the main run's positions (and influencerPositions). A stale holding like this becomes the NEXT day's return baseline — its full value shows up as ~5% of phantom P&L — or gets re-inferred as a duplicate sell by patchTrades. Now reconciled in mergeRunsByDate (drop a position whose symbol was same-day sold in qty ≥ held).",
    check:
      "Does any position in today's run also appear as a same-day SELL in that run's trades (i.e. held AND sold the same day)? If so the snapshot predates an intraday exit and the holding is phantom — it must be dropped before it anchors tomorrow's baseline.",
  },
  {
    date: "2026-06-25",
    title: "Two full runs in one day: lost buy + split cash/unsettled",
    lesson:
      "The 7:30 rotation (full trades + computed return) was followed by an 8am run that BOTH sold (MSFT stop-loss) AND bought a new name (ES). Unlike a thin stop-loss exit, this later run was a full run with its own positions. mergeRunsByDate/preferRun kept the 7:30 run for its return but its STALE positions — MSFT still listed, ES missing — and reconcilePositions only drops sold names, never adds bought ones, so ES silently vanished from the canonical snapshot (→ phantom +$72 in the next day's baseline). Fixed by overlaying the latest non-empty positions snapshot. Residual: the canonical record carries the EARLIER run's cash/unsettled split, so on such days cashDiff (later buys) and unsettledDiff (later sells' T+1 proceeds) show nonzero in /api/verify even though holdings and total value match live.",
    check:
      "Are there two runs for the same date where BOTH are full (each has multiple trades and a positions snapshot), not a full run plus a thin 1-trade exit? If so, confirm the canonical positions match the LATER run's holdings (every name bought in the later run is present, every name it sold is gone), and treat a cashDiff ≈ a later buy or unsettledDiff ≈ a later sell as an explained split artifact, not missing money. ALSO: does stored portfolioAfter.equity ≈ Σ(positions qty × price)? A merge can drop a sold name from positions yet keep its value in equity WHILE also counting its proceeds in unsettled — a double-count that inflates totalValue (the 06-25 Cash-Clearing repair). Flag equity ≠ Σ(positions).",
  },
  {
    date: "2026-06-22",
    title: "Sector concentration drift",
    lesson:
      "The book quietly drifted to ~79% financials. A 40% soft cap is now in the prompt, but the autopilot never independently measured concentration, so drift was invisible until a commenter pointed it out.",
    check:
      "From the current positions, does any single sector look like it exceeds ~40% of equity? Flag concentration drift even though the cap is 'soft'.",
  },
  {
    date: "2026-07-01",
    title: "Decided buy dropped by T+1 rotation squeeze (idle cash)",
    lesson:
      "On a rotation day, an expensive WHOLE-SHARE buy can be squeezed out and strand its full budget as idle cash, because same-day sells settle T+1 (their proceeds aren't spendable today). Two incidents: GPN×4 07-01 (~$302 idle) and TSLA×1 @ $405 07-06 (~$405 idle, ~17% of equity — a cheap DXC buy consumed enough budget that the whole-share TSLA no longer fit and was dropped, which ALSO pushed Tech to ~57% since TSLA was the diversifying leg). Root cause was NOT 'fitBuysToBudget undeployed' (it was live both times) — it was order-dependence: the greedy fit walked buys in the model's order, so a small buy could starve a large whole-share buy that can't shrink below 1 share. FIXED 2026-07-06: fitBuysToBudget now fits the priciest-PER-SHARE buys first (an indivisible whole share is the one that gets fully dropped, so it must claim budget before cheaper divisible buys that can shrink), and it persists a buySizingAdjustments note on the run when it shrinks/drops a buy.",
    check:
      "'Decided' means the FINAL TRADE_DECISION.buys array ONLY — never a candidate the analysis PROSE names while reasoning about budget. The model routinely writes 'BUY 2 × DVA @ $239', then runs its own cost check, sees the total exceeds buying power, and REMOVES the priciest candidate before it emits TRADE_DECISION. A name that self-prunes in prose and never reaches TRADE_DECISION.buys was NOT dropped by fitBuysToBudget, so an empty/absent buySizingAdjustments is CORRECT and NOT a regression (2026-07-07: DVA was written up then self-pruned in the model's own budget math; TRADE_DECISION.buys = SPGI/APD/MSTR = the executed trades exactly, yet it was wrongly flagged as a #9 drop). So: FIRST parse TRADE_DECISION.buys and compare ONLY that array against the run's executed buy trades — was any name in TRADE_DECISION.buys fully dropped or filled at a LOWER quantity than decided? If TRADE_DECISION.buys matches the executed trades, there is NO drop regardless of what the prose considered. THEN, only when there IS a real TRADE_DECISION-vs-executed gap, check the run's buySizingAdjustments field — if a DROPPED/shrunk note is present, the guardrail worked and correctly reports the reason (a whole share that couldn't fit is expected to stay idle until the next run); only escalate if idle cash is large AND recurring. Flag as a real REGRESSION only if a name IN TRADE_DECISION.buys vanished from the executed trades with NO buySizingAdjustments note (guardrail bypassed) or if a cheaper buy was kept while a larger one was dropped despite fitting (largest-first ordering broken). Separately, materially idle settled cash (> ~$100 or > ~5% of equity) is worth noting only if large AND recurring — a single whole-share remainder is expected.",
  },
  {
    date: "2026-07-09",
    title: "Dashboard returns poisoned by cost-basis-priced holdings + same-day double-run",
    lesson:
      "Two distinct dashboard-return corruptions surfaced 2026-07-09. (a) COST-BASIS PRICE: a held position's snapshot `price` fell back to its avgCost whenever the symbol was missing from priceMap (built from the S&P universe + top-12 influencer momentum), so a held influencer name outside that set stored price==avgCost. PLTR 2026-07-08 stored $116.26 (=avgCost) vs ~$132 market → the next day computed a phantom +8% influencer return. FIXED: lib/market-data enrichPriceMap fetches a live price for every held symbol before each snapshot (trade + drop-check); history corrected via /api/debug?patchPositionPrice=DATE:SYM:PRICE then ?recomputeSleeves=1; and dashboard-reconcile check #3 flags any held (not-bought-today) position with price==avgCost. (b) SAME-DAY DOUBLE-RUN: on 2026-07-09 the 7:30am OLD-strategy cron AND a manual V1 run both ran; the second run computed mainDailyReturn against the prior DAY but saw only ITS OWN trades, so positions the first run had already sold looked like phantom losses (main −32.52%). mergeRunsByDate unions both runs' trades, so recomputeSleeves against the MERGED entry reconciles it (→ +0.41%). NOTE the trap while fixing this: on a BUY day price==avgCost is CORRECT (it nets the buy-day gain to zero) — do NOT 'correct' buy-day prices to the close, that injects a phantom gain (huge when the prior-day sleeve was tiny).",
    check:
      "Reconcile the dashboard's derived returns against the raw data. (1) Does any held position (NOT in today's buy trades) have snapshot price == avgCost? That's the cost-basis artifact — the stored price should be the live market price; it poisons the sleeve return the following day. (2) Does any single-day sleeve or main return look implausible (say |return| > ~15%) relative to the account's agenticDailyReturn and the actual price moves of the held names? A large sleeve return that doesn't reconcile with the positions' real moves is usually a price/partition artifact, not real P&L. (3) If TWO runs exist for one date (a manual run plus the cron), verify the day's sleeve returns were recomputed against the MERGED trades, not one run's subset. Do NOT flag a buy-day position whose price==avgCost — that is correct and nets to zero.",
  },
];

/** Renders the registry as a compact numbered block for the reviewer prompt. */
export function formatKnownIssues(issues: KnownIssue[] = KNOWN_ISSUES): string {
  return issues
    .map(
      (k, i) =>
        `${i + 1}. [${k.date}] ${k.title}\n   Lesson: ${k.lesson}\n   Check: ${k.check}`,
    )
    .join("\n\n");
}
