# Experiment — is the main book's −5% same-day stop too tight?

**Asked** 2026-10-14 by the owner: "5% for main seems way too strict."
**Answer: yes, measurably — and it buys no drawdown protection.**

## What the bar actually is

Three different numbers get called "the stop", and conflating them is most of the confusion:

| constant | value | measured from | applies to |
|---|---|---|---|
| `MAIN_DROP_THRESHOLD_PCT` | −5% | **previous close** (same day) | main book |
| `INFLUENCER_DROP_THRESHOLD_PCT` | −10% | **buy price** (cumulative) | pure-sleeve only |
| `LOSS_DISCIPLINE_PCT` | −10% | **entry** (cumulative) | main book |

The main book has **no −5% stop-loss from entry**. A name can sit 9% underwater indefinitely and
the drop-check never touches it. The −5% fires on a −5% *day*. So the question is empirical: does a
one-session crater of that size predict further decline, or mean-revert?

## Method

`bun scripts/full-period.ts --stops -3,-5,-7,-10,-15,off` — the 1999-2026 survivorship-free
Sharadar path, `live-proxy` variant, 6 positions, 5-day rebalance, 5bps costs. Only
`stopLossPct` varies; `stopMode` stays `same-day`, matching production. One pass per level.

## Result

```
  stop         CAGR   Sharpe      IR    maxDD   trades  stopOuts  flat days
  -3%        +7.94%     0.43    0.04   -82.5%    12370      2964        126
  -5%       +10.89%     0.51    0.19   -77.8%    10944      1194         13   ← live
  -7%       +10.99%     0.50    0.21   -80.1%    10368       517          7
  -10%      +11.51%     0.51    0.24   -79.0%    10107       186          0
  -15%      +12.36%     0.53    0.28   -77.6%    10000        43          0
  none      +12.18%     0.52    0.27   -78.8%     9968         0          0
```

**The −5% bar costs ~1.3-1.5pp CAGR per year and takes IR from ~0.27 to 0.19.**

**`maxDD` is the decisive column: it does not move.** −77.6% to −82.5% across every setting,
including no stop at all. The stop is paid for in returns and buys no drawdown protection. The
tightest bar has the WORST drawdown of the six while stopping out 2,964 times — it sells into every
crash and is absent for the rebound. −5% is a milder case of the same mechanism.

1,194 stop-outs ≈ 43/year on a 6-name book: a position is ejected roughly every 6 trading days.

## Decision — APPLIED 2026-10-14 (owner approved)

`MAIN_DROP_THRESHOLD_PCT` moved from **−5% to −10%**. Worth ~0.6pp CAGR and IR 0.19 → 0.24, still
catches genuine single-day collapses (186 in 28 years), and makes **−10 one number across the
book**: −10% from entry (loss discipline), −10% from buy (sleeve), −10% in a day (crash). Today the
main book carries the tightest leash in the system on the day-move axis, which is backwards.

**Stop at −10, do not chase −15.** The −10→−15 gap is one path's worth of difference, −15 beats
`none` by +0.18pp which is plainly noise, and a bar firing 43 times in 28 years is not a guard.

## Caveats that bound this

- **Closes, not intraday.** A day that dips through the bar and recovers never fires. Every
  `stopOuts` count is a FLOOR, and the undercount is largest at tight bars — live −5% fires more
  often than 1,194.
- **No sympathy-hold model.** Live, a reasoning pass vetoes some −5% stops on risk-off days, so
  real behaviour sits between the −5% and −7% rows. This bounds the mechanical bar, not the agent.
- **One path, one sample.** The SHAPE of the curve is the finding; no single row is. This was a
  pre-specified question about one constant, not a parameter search — do not read it as licence
  to tune.
- **~−78% drawdown at every level** is the strategy's character (concentrated, unhedged,
  long-only), not something a stop was ever going to fix.


## What moved with it

Changing the constant touched four things that had encoded −5 independently:

1. **`lib/backtest.ts`** now IMPORTS `MAIN_DROP_THRESHOLD_PCT` instead of hardcoding `-5`. The
   default exists to mirror production and a second literal lets the two drift silently. Figures
   quoted in older comments (the position sweep, the +10.60% / IR 0.18 baseline) were produced at
   −5 and will not reproduce at this default; pass an explicit cfg for those.
2. **`evals/fixtures.ts`** — the `drop-check` scenario had IBM falling **6.2%** and expected a sell.
   Under a −10% bar that day never reaches the drop-check's sell session, so the eval would have
   been grading behaviour production cannot produce. Deepened to −12.4%.
3. **`evals/checks.ts`** — "exits severely dropped holdings (≥5% intraday)" renamed; the number
   lived in a check NAME, which would have gone stale silently.
4. **`lib/stopouts.ts`** gained `stopBarFor(ctx): "main" | "sleeve"`. This one matters: with both
   bars now at −10, every routing test asserting `stopThresholdFor(mixed) === -5` would have become
   VACUOUS — reading −10 whichever bar was selected. Eight tests protecting which-bar-applies would
   have passed while testing nothing. They assert the bar NAME now, and a mutation that routes
   everything to the sleeve bar fails four of them.

## Known consequence, accepted

An influencer row whose **cost basis is unreadable** falls back to the main bar. That fallback used
to be TIGHTER than the sleeve's own rule (−5 same-day vs −10 from-buy); it is now the RARER trigger,
because a −10% single session is much less common than a −10% cumulative drawdown. So this path was
loosened as a side effect, not by intent. Recorded here rather than inherited silently — if it
proves to matter it needs its own constant instead of borrowing the main book's.
