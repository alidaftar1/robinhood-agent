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
    date: "2026-07-14",
    title: "Per-position cap breach: buy-time guard never retroactively trims",
    lesson:
      "The prompt's per-position cap (max_qty = floor(maxPos/price), maxPos = max($400, 20%×totalValue)) was only enforced per-BUY, assuming zero existing shares — so top-ups drifted a held name past cap uncaught: APA built to ~24% by 07-14, ROST to ~30% by 07-29 (2 independent names over cap at once). Fixed 2026-07-29 with `positionCapQty` (lib/buy-sizing.ts), a deterministic buy-time guard wired into app/api/trade/route.ts that clamps/drops a top-up so (existing $held + new shares) ≤ maxPos, recording the clamp/drop in buySizingAdjustments. Residual: it is a BUY-TIME guard only — it stops a breach from GROWING via a new top-up, but never forces a sell, so a position that was already over cap before 07-29 (or that drifts over cap later from pure price appreciation, with no new buy at all) stays over cap indefinitely with no code path that trims it. That is by design (never force a sell the model didn't choose), not a bug — but it means the breach is invisible unless someone independently checks current position values against the cap each morning.",
    check:
      "From current positions + totalValue, does any single position's value exceed max($400, 20%×totalValue)? If yes: (a) is it EXPLAINED — it predates the 2026-07-29 guard deploy, or its rise since is pure price appreciation with no new buy of that symbol in the run — in which case it's an expected residual, not a regression; or (b) did the run's TRADE_DECISION.buys include a NEW top-up of that already-over-cap symbol with no matching 'trimmed'/'DROPPED' note in buySizingAdjustments — that WOULD be a guard bug (e.g. a heldValueOf lookup miss) and should be escalated. Do not flag the standing APA/ROST breaches themselves as new issues absent a fresh, un-guarded top-up.",
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
  {
    date: "2026-07-10",
    title: "Sleeve return distorted by a tiny prior-day base (book rebuilt from cash)",
    lesson:
      "The V1 strategy switch liquidated the main book on 07-09 (main sleeve → just APA, ~$33.60) and rebuilt it from settled cash on 07-10 (→ ~$2,038 across 5 names). computeDailyReturn only guarded yesterdayValue <= 0, so the tiny-but-positive $33.60 base slipped through: a sub-dollar real P&L / $33.60 = a phantom mainDailyReturn of −2.05%, which compounded the dashboard's Main Book Return from the honest −4.25% to −6.22%. The whole-account agenticDailyReturn was correct (+0.02%) because it divides by TOTAL value (incl. cash), so the distortion was sleeve-only. FIXED: computeSleeveReturns now nulls a sleeve's daily return when its prior-day book was < 10% of today's (a >10x growth = rebuilt from cash, not managed — directional, so liquidation days and normal add days are unaffected); 07-10 backfilled via ?recomputeSleeves=1.",
    check:
      "Is any single-day sleeve return (main or influencer) large in % BUT driven by a tiny prior-day base rather than a real price move? Signature: the sleeve's prior-day position value is a small fraction (<~10%) of its current-day value — i.e. the book was rebuilt from cash that day (mass liquidation the day before, then redeploy). That daily % is a denominator artifact and should be null (excluded from compounding), NOT counted as real P&L. Distinguish from a genuine loss by checking whether the held names actually moved that much.",
  },
  {
    date: "2026-07-30",
    title: "Stale holding kept without a justified exception (dead-money squat)",
    lesson:
      "The staleness time-stop is forced-default: a holding held ≥ its clock (main 15 trading days / influencer 10) that's still roughly flat (main up <+3%, influencer <+8%) MUST be rotated UNLESS the thesis names a specific re-acceleration signal (ranks high now / ↑RECOVERING / rising momentum) or a fresh ★INS/⚡↑ catalyst. The failure mode is the model KEEPING a flat, long-held name on a vague 'it might move' / 'still like it' — dead money squatting a slot (doubly costly for the 2-slot influencer sleeve). The −5% stop covers losers and +40% covers winners; this rule covers the flat middle nothing else does.",
    check:
      "For each holding that has been present in the positions snapshot for ≥ its stale window (roughly: main ≥15 recent runs / influencer ≥10) AND is still roughly flat since entry (main up <+3%, influencer <+8%, and not stopped out), was it SOLD this run? If it was KEPT, does the thesis give a SPECIFIC keep-reason — a named re-acceleration signal (high shortlist rank / ↑RECOVERING / rising momentum) or a fresh ★INS/⚡↑? Flag (medium) any long-held flat name kept with only a vague reason ('might move', 'still like it', 'hasn't lost money') or no mention — that's a dead-money squat the time-stop is supposed to rotate.",
  },
  {
    date: "2026-07-29",
    title: "Rotation churn — selling a still-strong name as 'decayed', then rebuying it",
    lesson:
      "The V1 sell rule was a HARD shortlist cutoff ('not in the top-12 → decayed → SELL'), so names jostling at the rank boundary got churned on daily momentum noise. ILMN was sold 07-28 as 'momentum/quality decayed' at 65% momentum, then REBOUGHT 07-29 at the same 65% momentum for $193 (sold at $189) — the 'decay' was fiction, the number never moved; it just got out-ranked for one day. INCY was a 1-day hold (bought 07-28, sold 07-29 for the same 'decayed' reason it was bought). FIXED 2026-07-29: a hysteresis retention band keeps held names (marked ◆HELD) as long as momentum stays positive + quality-eligible; the prompt forbids selling a ◆HELD name for merely ranking below newer names and requires a specific real reason for every main-book sell. RECURRED 08-06→08-07 across DAYS (not same-run): ILMN sold 08-06 @ $188.96, re-bought 08-07 @ $188.54 — the hysteresis fix stops same-run churn but the model was BLIND to a discretionary sell it made yesterday (the re-entry guard only tracked −5% stops). FIXED 2026-08-07 (commit + recordSell/getRecentSells in lib/stopouts): discretionary main-book sells are now recorded, surfaced to the next run (RECENTLY SOLD block) with a justify-a-re-buy rule, and a deterministic ⚠️ ROTATION-CHURN FLAG is stamped on the run when a name is re-bought within ~5 days of its discretionary sale. That 08-07 re-buy itself never showed the flag — traced 2026-08-10 and confirmed as EXPECTED, not a bug: the recordSell/getRecentSells commit landed at 09:26 PT on 08-07, ~2 hours AFTER that morning's 7:30am trade cron already ran, so the 08-06 sell was never recorded under the old code and there was nothing for 08-07's (new) code to find — a one-time rollout-timing gap, self-resolving once both the sell and the re-buy occur under the fixed code. SEPARATE, DEEPER BUG found the same day (2026-08-10) via a scripted replay of the real run history: `heldDaysOf` in `app/api/trade/route.ts` tolerates a 1-day absence as a 'data-snapshot gap' to survive genuine missing snapshots, but that same tolerance also swallows a REAL full close+reopen, since a sell-then-rebuy-next-day always shows as just a 1-day gap in the daily run history. This silently merged ILMN's fresh 08-07 lot with every prior ILMN holding stretch back to ~07-19 across the 07-28 and 08-06 sells, producing a fabricated 'held 19d' on 08-10 for a lot that was actually 1 trading day old — replay confirmed heldDaysOf('ILMN') returned exactly 19 with the buggy logic and 1 with the fix. That false age is what triggered the STALE-rotation default (≥15 trading days) and drove the 08-10 sell — the model's sell thesis wasn't wrong given the data it was shown, the DATA was wrong. FIXED 2026-08-10: heldDaysOf now breaks the streak immediately (no tolerance) when the day being examined has an actual recorded SELL trade for that symbol, distinguishing a real exit from a mere missing snapshot.",
    check:
      "FIRST check the run summary for a '⚠️ ROTATION-CHURN FLAG' (stamped deterministically when a name is re-bought within ~5 days of a discretionary main-book sell). If present, read the re-buy thesis: does it name a SPECIFIC fresh reason the exit no longer applies (a NEW catalyst since the sale — ★INS/⚡↑/⚡NEWS↑, or a confirmed thesis change)? 'It's back on the shortlist / momentum is strong' is NOT valid (both were true when it was sold) → flag it as churn (sold + re-bought at ~the same price for no gain). SEPARATELY, for each MAIN-book SELL, does the thesis justify it with a SPECIFIC real reason (fell off the shortlist / ↓FIRM / sector-cap trim / free a slot for higher conviction)? Flag a sell whose only rationale is 'decayed' / 'out-ranked' while momentum is still positive. ALSO: for any ⏳STALE-triggered sell, sanity-check the reported 'held Nd' against the symbol's most recent BUY in the run history — if a full sell (any prior exit, even weeks back) occurred more recently than N days before today, the age is almost certainly stale-merged across that closed lot (the heldDaysOf bug fixed 2026-08-10) and the STALE trigger should not be trusted at face value; flag it for re-verification rather than treating the sell as a legitimate time-stop.",
  },
  {
    date: "2026-07-27",
    title: "Same-day round-trip — bought and stopped out the same day",
    lesson:
      "TER was bought at 7:30am ($326.20) as the top quality-momentum shortlist pick on a day it was already down ~12% from its prior close, then the drop-check stopped it out the same day at ~$328. The stop measured TER's intraday % from the PRIOR CLOSE (−5.75%), which includes the drop that happened BEFORE the buy — but from the actual buy price it was +1.1%, so no real loss occurred. Result: a pointless same-day round-trip near breakeven (also NTAP 07-09 −0.2%, SMCI 06-24 +0.0% — same signature). FIXED 2026-07-27: the drop-check now measures a same-day buy from its buy price (avgCost), the same treatment influencer picks already got, so a fresh buy is no longer stopped on a pre-purchase decline.",
    check:
      "Does any symbol appear as BOTH a buy and a sell in the same run's trades (today's run or any recent run)? That's a same-day round-trip. If the round-trip's realized P&L is roughly flat or positive (sold at ≈ or above the buy price), it's a whipsaw — the stop reacted to a decline that predated the buy — flag it (medium) naming the symbol, buy price, sell price, net %. A round-trip sold WELL BELOW the buy (≤ −5% from buy) is a legitimate post-buy crash stop, not a whipsaw — don't flag those. Since the same-day-buy-from-buy-price fix, a new flat/positive round-trip means that fix regressed or a different exit path caused it.",
  },
  {
    date: "2026-07-24",
    title: "Whipsaw — re-buying a name just stopped out",
    lesson:
      "GOOGL was stopped out 07-23 at −6.5% (thesis breakdown) and the 07-24 analysis decided to re-buy it the next day because it still topped the quality-momentum shortlist (the shortlist ranks 12-month momentum + quality, which a one-day breakdown barely dents). Selling at the low and re-buying near the same price realizes the loss for nothing. The book is now shown its recent stop-outs and told to justify any re-entry; the trade route stamps a deterministic '⚠️ RE-ENTRY FLAG' in the run summary when it re-buys a recently-stopped name — but whether the JUSTIFICATION is legitimate is a judgment only you can make.",
    check:
      "Does the run summary contain a '⚠️ RE-ENTRY FLAG'? If so, read the thesis: does it give a SPECIFIC reason the earlier breakdown no longer applies — a confirmed reversal, a fresh catalyst (★INS / ⚡↑), or evidence it was broad-market sympathy selling that has reversed? If the only justification is that the name is high quality / high momentum (that's merely why it's on the shortlist), flag it as a likely whipsaw — sold at the low, bought back near the same price.",
  },
  {
    date: "2026-07-27",
    title: "One intraday fill recorded twice → phantom sell proceeds, day's return deleted",
    lesson:
      "TER was bought 07-27 morning (1 share @ $326.20), stopped out intraday, and the SINGLE real sell (live Robinhood: 1 share filled @ $327.74) was stored TWICE: @ $327.94 'filled' and @ $328.73 'submitted'. Two same-date runs each recorded the same fill at a different price estimate — drop-check overwrites a sell's avgPrice with its detection-pass QUOTE while other paths keep the model's self-report — and unionTrades' identity key (symbol|side|quantity|avgPrice) includes the price, so it could not collapse them. computeDailyReturn then counted $328.73 of proceeds that never existed: a true −0.08% day computed as +13.27% with a phantom −$331.57 'withdrawal'. It slipped under the autopilot's |return| > 30% flag AND its |impliedTransfer| > 300 branch reported the phantom as a real 'large withdrawal — return is transfer-adjusted'. The day's return was then CLEARED (returnLocked) instead of corrected, so 07-27 is a permanent hole in the compounded track record. FIXED: findReRecordedSells (lib/run-store) drops a sell record only when the day's recorded sells for a symbol exceed what could possibly be sold (start-of-day holding + same-day buys) AND the record is a same-quantity twin of one it keeps; mergeRunsByDate applies it before reconcilePositions, and dashboard-reconcile check #4 reports it so the drop is never silent.",
    check:
      "For each date, do the recorded sells of any symbol exceed what the account could have sold that day — the previous day's holding of that name plus anything bought that day? A one-share position with TWO one-share sell records (typically one 'filled' and one 'submitted', at slightly different prices) is the signature: ONE real fill, recorded twice. The tell in the derived metrics is a large-and-negative agenticImpliedTransfer roughly equal to the duplicated proceeds — do NOT accept that as a withdrawal (the agent never transfers; only the owner deposits) and do NOT 'fix' the day by clearing its return, which throws away real history. Also ask the follow-up the record fix does NOT answer: did TWO exit runs each PLACE a sell order (check the Vercel logs for repeated DROP_CHECK_TRIGGERED on that date)? A duplicate order on a live account is a separate, more serious problem than a duplicate record.",
  },
  {
    date: "2026-08-04",
    title: "Sold a serial earnings-beater as 'stale + imminent earnings' — the record was invisible to the hold-judgment",
    lesson:
      "PLTR was SOLD 08-03 because it was ⏳STALE (23d flat) AND ⚠⚠ IMMINENT EARNINGS (08-03) — both the stale-rotation default and the imminent-earnings caution said exit. It then beat and popped ~+20%. The sell was defensible PROCESS (a +20% pop is a coin flip; the rule that skips it also skips the −20%), BUT the model was BLIND to the one fact that made PLTR not a coin flip: it had beaten estimates 4/4 recent quarters by ~+15% avg — the textbook 'high-conviction winner rides through, PEAD favors it' exception the rule already carves out. It read as dead-money-stale because the beat record wasn't in front of it. FIXED: fetchEarningsBeatHistory (lib/earnings) pulls the last-8-quarter surprise history for HELD names ≤15d from earnings; buildV1AnalysisPrompt renders a 📈EARN-RECORD tag on those position lines and the earnings hold-judgment now says a strong record (beat most quarters, positive avg surprise) is a RIDE-THROUGH candidate that can OVERRIDE the stale-rotation default. It is a tilt on the odds, NOT a guarantee — a beat can still sell off and serial beaters eventually miss.",
    check:
      "Did a held name get SOLD while carrying both ⏳STALE and ⚠⚠/⚠EARN tags? If so, check its 📈EARN-RECORD: if it beat most of its last quarters with a solidly positive avg surprise and the thesis did NOT weigh that record before exiting, flag it — a serial beater's flat run into its print is exactly the case that tends to resolve UP, and the stale-rotation default should not silently override it. Conversely, if a mixed/negative-record name was HELD through imminent earnings purely on 'high conviction' with no other support, that's the opposite failure. Also confirm the tag actually rendered (log PROMPT_POSITION_LINES) — a held name ≤15d from earnings with no 📈EARN-RECORD means the Finnhub fetch failed or returned <2 quarters, so the judgment ran blind.",
  },
  {
    date: "2026-08-06",
    title: "Sub-$50 'spend the whole remaining budget' buy vanished with zero note anywhere",
    lesson:
      "Settled buying power was $11.36 after two same-day sells. The model decided BUY LLY $11.36 — its entire remaining budget, sized as if there were no floor — even though the prompt states a $50 per-buy minimum. The deterministic notional-buy sanitation filter (app/api/trade/route.ts, run BEFORE buySizingAdjustments existed) correctly dropped it as dust, but only logged a console.warn; it never recorded a buySizingAdjustments note. So TRADE_DECISION.buys contained LLY, executed trades did not, and nothing in the stored run, dashboard, or email said why — exactly the silent 'guardrail bypassed'-looking gap the existing #9-style check (registry entry above re: DVA) is designed to catch, except here there was no note to find because the code never wrote one. FIXED: buySizingAdjustments is now declared before the sanitation filter, and a dropped buy pushes a `'<SYM> buy DROPPED — dollarAmount $X is invalid or below the $50 min'` note, matching the pattern the adjacent per-position-cap guard already uses two lines below.",
    check:
      "Does TRADE_DECISION.buys contain a symbol that is absent from the run's executed buy trades? If so this is ALWAYS worth explaining — first check buySizingAdjustments for a matching '<SYM> buy DROPPED/trimmed' note (guardrail working, note the reason and move on); if the symbol is dropped with NO matching note anywhere, that is a real regression (a guard silently ate a decided buy) — escalate it, don't defer to 'probably fine.' Also worth a light touch on tiny-budget days generally: is the model repeatedly trying to force its entire sub-$50 leftover cash into a single buy instead of just deciding buys=[] like it correctly does most days? A one-off is fine; a recurring pattern of the model fighting its own stated $50 floor would be worth a strategy-analyst hypothesis (not a code change — the floor is a deliberate anti-dust design choice).",
  },
  {
    date: "2026-08-14",
    title: "Reviewer flagged a long-held position's age as 'impossible to verify' because its own history window was too short",
    lesson:
      "The skeptical-reviewer prompt (lib/autopilot-review.ts) capped RECENT RUNS at a flat 7 most-recent runs, while heldDaysOf (app/api/trade/route.ts) — the thing that actually computes the heldDays the model reasons from — looks back 60 runs. GOOGL's current lot was bought 2026-07-27 at exactly its stored avgCost ($326.37), a real, correctly-tracked position, but by 08-14 that buy was more than 7 runs back with no other GOOGL activity in between, so the reviewer's own (too-shallow) window couldn't see it and it wrongly concluded the held-days count was 'impossible to verify.' FIXED: the window now covers STALE_DAYS (15, imported from lib/strategy.ts) runs instead of a flat 7, so any position within the actual staleness window has its most recent buy trade visible to the reviewer.",
    check:
      "If the reviewer raises a concern that a held position's age or origin 'cannot be verified' or has 'no purchase visible in recent history', first check whether that symbol's buy trade is actually present further back in the FULL run history (not just what the reviewer was shown) — if it is, this is the reviewer under-provisioned, not a real data gap, and heldDaysOf's own (deeper) lookback is unaffected. Only escalate as a real issue if the buy trade is genuinely absent from the entire available run history.",
  },
  {
    date: "2026-08-18",
    title: "Held influencer position outside today's top-12 mention ranking got no price → ⏳STALE tag suppressed, model reasoned blind",
    lesson:
      "CAKE (influencer sleeve, bought 08-04) hit heldDays=10/INFLUENCER_STALE_DAYS with a real +2.4% gain (well under the +8% keep bar) — the time-stop should have forced a rotate-or-justify decision. It didn't fire: the model's own thesis said 'I don't have CAKE's current price in the data ... No ⏳STALE tag appears ... I'll trust the system's flagging. Hold.' Root cause: priceMap (app/api/trade/route.ts) is seeded from the S&P-universe fetch plus THIS RUN's top-12 influencer tickers by net mention score (route.ts ~226-234) — a held influencer name like CAKE that isn't S&P-listed and fell out of today's top-12 (its YouTube mentions cooled) never gets a price at all. strategy.ts's `ret`/`isStale` computation requires `ret != null`, so a missing price silently suppresses the tag even when heldDays and the real return both clear the threshold — the model then reasons off heldDays alone with zero return figure, same failure shape the 07-09 cost-basis-price bug had (registry entry above), but manifesting at PROMPT-BUILD time instead of snapshot time; enrichPriceMap (added for that 07-09 fix) was only ever called AFTER the decision, for the stored snapshot — never before, for the prompt itself. FIXED: call enrichPriceMap on every currently-held symbol right after `positions` is resolved and before portfolioCtx/priceMap are read into the prompt (app/api/trade/route.ts), so a held name missing from both the universe and today's top-12 still gets a live price before the model reasons about it. Confirmed in isolation: enrichPriceMap(['CAKE'], new Map()) resolves a real live price with the fix's exact call shape.",
    check:
      "For any held name (main or influencer) at or past its stale window, does the model's own thesis text say something like 'no price available' / 'don't have the current price' / 'trust the system's flagging' instead of citing an actual return figure? That's the signature of this bug — the tag-suppression is silent (no adjustment note, nothing in buySizingAdjustments), so the only tell is the model's own prose admitting a missing input. Cross-check: is the symbol present in that day's `topInfluencerTickers` (visible in a dry-run response) or the S&P/main universe? If neither, and no price is cited, the staleness judgment ran blind — flag it even if the eventual keep/rotate call looks reasonable, since a blind coin-flip that happens to land right is still a process failure waiting to recur on a worse day.",
  },
  {
    date: "2026-08-19",
    title: "Influencer buy executed below its own mandatory net≥3 floor — rumor-driven, prompt-only rule had no code backstop",
    lesson:
      "Bought PYPL (strategy:influencer) primarily on an unconfirmed 'Stripe/Advent acquisition talks at $70-80/share' rumor, but PYPL's own influencer net score that run was only 2 — below the sleeve's stated qualifying bar. The influencer-signals prompt (lib/influencer-signals.ts formatInfluencerSignals) says 'If ANY ticker below has NET score ≥ 3, you SHOULD buy 1-2 of them' and lists only price-cap/imminent-earnings/no-cash as valid reasons to SKIP the sleeve — nowhere does it offer a 'confirmed catalyst can override a low net score' exception, so this was the model improvising past its own rule, not a documented judgment call. Root cause: INFLUENCER_BUY_FLOOR (=3, lib/influencer-signals.ts) was only ever used for the 🎬INFL display tag and the ledger's MIN_SCORE — nothing in app/api/trade/route.ts's buy-processing pipeline actually rejected a sub-floor influencer buy before execution, unlike the per-position dollar cap and the downtrend screen, which ARE both code-enforced (security audit 2026-08-18, finding [3], same invariant: never prompt-only for a stated hard rule). FIXED: added a pre-buy net-score guard in app/api/trade/route.ts (same pattern/location as the existing downtrend guard) that drops any influencer buy with net < INFLUENCER_BUY_FLOOR before execution, surfaced via buySizingAdjustments.",
    check:
      "For any BUY tagged strategy:influencer, does the run's stored influencerNet (or the thesis text) show a net score < 3? If the fix is deployed this should now be impossible (the buy would have been rejected pre-execution) — a recurrence means the guard has a gap (e.g. the symbol wasn't in influencerNet's map key exactly, or a different code path bypassed it). Also check whether the thesis leans on a speculative/unconfirmed catalyst (M&A rumor, unverified rating change) as the PRIMARY reason for an influencer buy — even above the net floor, a second-hand rumor is a weaker basis than a corroborated creator consensus and is worth a skeptical look.",
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
