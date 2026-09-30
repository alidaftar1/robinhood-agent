# Scope — why the main book trails, and whether a position cap fixes it

**Status:** SCOPED, NOT BUILT. Needs a decision on the cap number and the drain rule.
**Date:** 2026-09-29
**Changes what the agent trades — owner sign-off required before any of this ships.**

---

## The measurement

From the live dashboard, 2026-09-29:

| | |
|---|---|
| Main book since 2026-06-15 | **−4.89%** |
| SPY, same period | **+1.22%** |
| Book beta | **0.83** |
| Expected from market exposure (0.83 × 1.22) | **+1.01%** |
| **Alpha** | **−5.90%** |
| Sharpe | −0.09 (SPY 0.83) |
| Days beating SPY | 42% of 71 (45% of 55 under V1) |
| Confidence it beats SPY | ~35% |

This is not a market problem. The book took market risk and produced −5.9% on top of it.

## The structural finding

The strategy targets **~6 high-conviction names**. It holds **12**.

- `N = 6` (lib/market-data.ts) is used only to derive `maxPerSector` (0.4 × 6 = 2). It does not
  bound the book.
- "Pick up to 6" in the prompt is **per rebalance**, not in total.
- Hysteresis **retains** held names on purpose: "a ◆HELD name is NOT a rotation candidate".
- So buys add, retention holds, and **nothing ever forces the count down**.

Consequences, in order of how much they matter:

1. **Dilution.** $2,414 / 12 = **$201 per position**, against ~$402 at target. A 12-name,
   beta-0.83, seven-sector book is an index clone. It cannot outperform SPY, and after costs it
   underperforms. The prompt's own words: "a concentrated ~6-name book beats a long thin tail."
2. **The model cannot see it.** The prompt lists holdings but never states the position COUNT or
   the TARGET. Grep for either: zero matches. It has no way to know it is at 12 against a 6-name
   design, and no instruction that would make it care.
3. **No capital to act on the signal.** Settled buying power is **$2.44**. When the shortlist
   surfaces a better name, nothing can be bought. The screen runs daily and cannot be acted on.
4. **The asymmetry.** The influencer sleeve has a HARD-CODED 2-position cap enforced in code
   (`MAX_INFLUENCER_POSITIONS`, added after a security audit). The main book — which holds most of
   the money — has no equivalent.

## The honest tension, which cuts against the obvious fix

Concentration is **necessary** for alpha but not **sufficient**. If name selection has no edge,
holding 6 instead of 12 does not create return — it raises variance around the same expectation.
And the current evidence for selection edge is weak-to-negative: Sharpe −0.09, ~35% confidence of
beating SPY, beating it on fewer than half of days.

So there are two readings, and they imply opposite actions:

- **(A) Dilution is the cause.** 12 half-size names in 7 sectors cannot express a view. Capping
  restores the concentration the strategy was designed around, and the edge becomes visible.
- **(B) Dilution is a symptom.** The selection has no edge; position count is downstream of that.
  Capping would concentrate a negative edge and make results *worse*, while looking like action.

**A cap is only right under (A).** Under (B) it is actively harmful. So the first question is not
"what cap" but "which reading", and that is answerable with data rather than argument.

### What would distinguish them

Do the names the model PICKS from the shortlist outperform the ones it passes over? That isolates
selection skill from everything else.

- `lib/signal-ledger.ts` already records per-buy forward returns.
- The feature capture that started today (docs/experiment-nori-tail-risk.md) records the whole
  shortlist daily, so from now on the passed-over names have forward returns too.
- Comparing picked vs passed-over over the same windows answers (A) vs (B) directly.

That comparison needs weeks of capture, but it is the difference between fixing the problem and
performing a fix.

## Options for the cap itself, if (A) holds

### The number
6 matches the design and gives ~$400 positions at current size — comfortably above the $50 minimum
and inside the per-position dollar cap. 8 is the softer version. Below 6, sector-cap interactions
get awkward (2 per sector × 7 sectors means 6 names can already saturate two sectors).

### Enforcement point — this is the real decision
- **Buy-side only (recommended).** At the cap, a new buy is DROPPED unless a full exit frees a
  slot in the same decision. Mirrors `MAX_INFLUENCER_POSITIONS` exactly: same `isFullExit`
  accounting, same note-and-log so the autopilot's decided-vs-executed check does not read a guard
  doing its job as an anomaly. Cannot force a sale, so it cannot manufacture churn.
- **Force-sell down to the cap.** Gets to target immediately, realises losses on 6 positions at
  once, and risks exactly the churn that the 8-day median holding period already suggests is the
  bigger problem. **Not recommended.**
- **One forced replacement per rebalance.** Middle path; bounded churn; slow.

### How the existing 12 drain
Under buy-side-only enforcement, the count falls only through existing exits — stops, loss
discipline, time-stop, hysteresis failure. With hysteresis deliberately retaining names, that could
be **slow**, and the book stays diluted meanwhile. This is the main weakness of the recommended
option and should be measured, not assumed: if the count has not fallen in a month, the cap alone
was not enough.

## What this does NOT address

- The **8-day median holding period** against a 12-month signal. The weekly-rebalance and
  `STALE_DAYS = 60` fixes shipped 2026-09-21 — eight days ago — so they are not visible in these
  numbers yet and may already be working. Do not re-fix this before the data shows it is broken.
- **Realised vs unrealised.** Current positions are 6 up / 5 down with APA at +25.7%, so most of
  the −4.89% is realised losses from round-trips, not the current book. A position cap does nothing
  about trades already closed.

## Recommendation

Do not ship a cap yet. Two steps, in order:

1. **Make the count visible** to the model and on the dashboard — position count against target.
   That is not a trading change, it is instrumentation, and it costs nothing. It may also be
   sufficient on its own: the model has never been told it is over target.
2. **Run the picked-vs-passed-over comparison** once the feature capture has a few weeks. If
   selection shows edge, cap at 6 buy-side. If it does not, a cap is the wrong intervention and the
   question becomes the shortlist itself, not how many of its names we hold.

The thing to resist is shipping the cap because the diagnosis feels right. −5.9% of alpha is a
strong motive to act, and acting on the wrong reading would concentrate a negative edge.
