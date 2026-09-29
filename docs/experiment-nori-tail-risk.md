# Experiment scope — Synthefy Nori for tail-risk sizing

**Status:** SCOPED, NOT STARTED. Needs a go/no-go on Phase 0.
**Date:** 2026-09-29
**Owner decision required:** whether to start the capture. Nothing here touches trading.

---

## The question

Not "can a model pick stocks". Specifically:

> Can a tabular foundation model predict the **forward drawdown distribution** of a held name
> better than the trailing realized volatility we already compute — well enough, and calibrated
> enough, to size positions or set a stop by?

Everything below exists to answer that with evidence and to kill it cheaply if the answer is no.

## Why return prediction is explicitly out of scope

From the [Nori model card](https://huggingface.co/Synthefy/Nori), on training data:

> "An ExtraTrees **signal-quality filter rejects unlearnable synthetic datasets**"

Nori trained exclusively on synthetic SCM data, and datasets without learnable structure were
filtered *out*. Its benchmark median R² is **0.8702**. Cross-sectional equity return prediction
runs at R² ≈ 0.01–0.03.

So the model has never been trained on a problem whose correct answer is "there is nothing here."
Its prior is that structure exists, and applied to returns it will fit noise confidently. That is
not a defect — it is the right choice for their market (fraud, demand forecasting) — but it makes
return prediction the single worst thing to point it at.

Note also: Synthefy's LinkedIn post lists "trading on prediction markets and financial markets" as
a use case. Neither the product page nor the model card mentions finance, and no benchmark or case
study is offered. Treat that as marketing.

## Why tail risk is the defensible target

| | Return prediction | Forward drawdown |
|---|---|---|
| Signal present in the data | No (~0.01 R²) | Yes — volatility is persistent |
| Inside Nori's trained class | **No** (filtered out) | Yes |
| Output shape needed | Point estimate | **Quantiles** |
| Nori's native output | 999 quantiles (pinball loss) | fits exactly |
| Our sample size | Far too small | Small = their stated sweet spot |

Nori emits predictive distributions natively via a 999-quantile head, with no conformal wrapper.
For a question that is *entirely* about the left tail, that is the right output. Its stated
intended use is "small-to-medium tabular regression", and its known weakness is large-N — which
matches our data rather than fighting it.

**Caveat the card is explicit about:** it does **not** claim calibration validated on held-out
data. An uncalibrated tail estimate driving a stop would be worse than the fixed −10%, so
calibration is a gate, not a nice-to-have.

---

## BLOCKER: the training data does not exist

The system computes rich per-name features every run and **throws them away**.

- `TradeRun.market` stores `{ stocksLoaded, headlinesLoaded }` — counts only.
- `positions[]` covers only held names (~6–10), not the universe.
- `signal-ledger` / `influencer-ledger` / the two shadow captures store `{symbol, price, date}` as
  forward-return baselines — deliberately, since that is all they need.

So there is no historical feature matrix, and no amount of effort produces one now.
Reconstructing it from vendor history would also import survivorship bias — the same problem that
parked the Sharadar backtest.

**Consequence: this is a capture-first experiment.** The only decision available today is whether
to start the clock.

---

## Phase 0 — capture (the only thing being proposed now)

Zero trading risk, zero capital, no change to any decision path. Follows the precedent already in
this repo: `giveback-shadow` exists precisely to accrue forward outcomes before committing capital.

Each trade run, append a snapshot row per universe name:

```
robinhood:feature-capture:<YYYY-MM-DD>   (14–18 month TTL)
  symbol, date, price
  mom12_1, change5d, change14d, change30d
  volatility30d, beta, sharpe5d, sharpe14d, sharpe30d
  distFrom52wHigh, relStrength5d, relStrength30d
  qualityPct, sector, peTTM | peFY | null, daysToEarnings
```

All of these are **already computed** in the run — this writes what is currently discarded.

Cost: one extra Redis write per run, ~500 rows/day. No new API calls, no new vendor, no LLM.
Forward outcomes are computed **on read** from the stored price, exactly as the existing shadow
captures do — nothing needs to be labelled at write time.

### Honest cost of waiting

This is the part worth weighing before agreeing.

With daily snapshots and a 10-day forward window, samples overlap heavily. Cross-sectional rows
are dominated by a shared market factor, so effective sample size is closer to the number of
**independent time blocks** than to the row count:

| Elapsed | Rows | Independent 10-day blocks |
|---|---|---|
| 1 month | ~10,000 | ~2 |
| 3 months | ~30,000 | ~6 |
| 6 months | ~63,000 | ~12 |

Twelve independent blocks is thin for a tail-calibration claim. A 5-day horizon doubles the blocks
and is the better first target. **Realistically: no credible read before ~3 months, and a
defensible one closer to 6.** If that horizon is unattractive, the correct decision is to decline
now rather than capture for a quarter and then decide.

---

## Phase 1 — evaluation (only if Phase 0 accrues)

- **Target:** worst peak-to-trough drawdown of each name over the next 5 (then 10) trading days.
- **Split:** strictly temporal, with an embargo of one full horizon between train and test so
  overlapping windows cannot leak. No shuffling, no random CV, ever.
- **Baseline:** `volatility30d`, already computed — scaled to the horizon. A model that cannot beat
  a number we get for free is not interesting.
- **Metric:** pinball loss at the 5th/10th percentile (the tail we actually act on), not RMSE.

### Gates — both must pass

1. **Beats the baseline** on tail pinball loss, out-of-sample, by a margin exceeding the spread
   across time blocks. A win inside the noise is not a win.
2. **Calibrated:** the realized 10th-percentile exceedance rate falls within a stated tolerance of
   10% on held-out data. Synthefy does not claim this; we verify it or we stop.

### Kill criteria — stop and write it up

- Either gate fails.
- The margin is inside the between-block spread.
- The result depends on the split date.

## What this is explicitly NOT

- Not a stock picker, and not a return model.
- Not in the live path. Even on success, Nori is a Python package against a TypeScript/Vercel
  system — integration means a service boundary or offline batch scoring, which is a **separate**
  decision made after the gates pass, not implied by them.
- Not a replacement for the −10% stop. The earliest plausible use is *informing position size*,
  which is code-capped anyway.

## Recommendation

Phase 0 is cheap, reversible, and starts a clock that cannot be started retroactively — that is its
whole argument. Phase 1 is genuinely uncertain and may well conclude "the baseline wins", which is
a real result worth having.

The thing to be clear-eyed about: the binding constraint is **data, not model quality**. Nori being
excellent at R²=0.87 problems says nothing about this one. If the honest answer in six months is
"trailing vol was as good", that closes a question that would otherwise keep resurfacing.
