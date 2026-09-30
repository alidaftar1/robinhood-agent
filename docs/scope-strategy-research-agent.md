# Scope — an autonomous strategy-research agent

**Status:** SCOPED, NOT BUILT.
**Date:** 2026-09-30
**Owner decisions taken:** tiered autonomy earned by evidence; objective = risk-adjusted excess
return vs SPY. Fixed constraints: budget unchanged, main-book universe stays S&P 500, influencer
sleeve stays $500.
**Changes what the agent trades — owner sign-off required before Tier 1 or Tier 2 ships.**

---

## The idea

Strategy iteration is currently manual and slow: a human notices something, scopes it, builds it,
and waits weeks for live data. The agent's job is to compress that loop — generate strategy
variants, evaluate them against real point-in-time data, and surface the ones that survive.

The design principle is a single sentence, and everything below follows from it:

> **The optimizer must never control the scorer.**

An agent optimizing toward a return target, with authority over the code that *computes* returns,
will eventually hit the target by changing the computation. That is not a hypothetical failure mode
in this repo — it has already produced a phantom −14.13% day, a deposit booked as return, and a
compounded-% index that silently dropped a realized loss. Each took real work to find. So the
scorer, the accounting, and the benchmark sit permanently outside the agent's reach.

## Why autonomy is bounded by an INTERFACE, not by rules

The weak version of this design tells the agent "you may not touch the accounting" and hopes. The
strong version makes it **structurally impossible**, by giving the agent a surface that has no
access to anything dangerous:

```ts
/** A variant is a PURE function over one day of captured features.
 *  No I/O, no clock, no randomness, no network, no Redis. Same day in → same picks out. */
export interface StrategyVariant {
  id: string;                    // stable slug, e.g. "mom12-1-lowvol-v3"
  description: string;
  registeredAt: string;          // YYYY-MM-DD — forward scoring counts only days AFTER this
  criteria: PromotionCriteria;   // pre-registered, see below
  config: VariantConfig;         // risk params, CLAMPED in code
  pick(day: CaptureDay): VariantPick[];
}
```

A pure function over a feature matrix cannot place an order, cannot write a return series, cannot
reach Redis, and cannot deploy. The agent gets *complete* freedom inside `pick()` — any ranking,
any weighting, any factor combination it can express — and zero freedom outside it. Autonomy and
containment stop being in tension.

This is the LLM-vs-code boundary the repo already uses, applied one level up: **code owns the
invariants, the model optimizes within them.**

## The substrate already exists

This is the part that makes the whole thing cheap. `lib/feature-capture.ts` has been recording,
every trading day, for the entire S&P 500 universe:

```
symbol, price, mom12_1, change5d, change14d, change30d, volatility30d, beta,
sharpe5d, sharpe14d, sharpe30d, distFrom52wHigh, relStrength5d, relStrength30d,
qualityPct, peTTM, peFY, daysToEarnings
```

That is a **point-in-time, survivorship-free feature matrix** — captured live, so it cannot be
contaminated by knowledge of what later happened, which is the flaw that made the earlier backtest
untrustworthy. It also carries `spyAvailable`, so a day where SPY failed to fetch (and every
`relStrength` column silently collapsed to the name's own return) is identifiable rather than
quietly poisoning the set.

Scoring already exists too: `scoreShadowObservations(observations, today, "entry" | "exit")` in
`lib/shadow-scoring.ts`, with `MIN_DAYS_ELAPSED = 5`, scored one vote per NAME and measured as
excess vs SPY. The mean-reversion and give-back shadows are working examples of the whole pattern.

**So Tier 0 needs almost no new infrastructure** — a variant registry, a replay loop over stored
`CaptureDay`s, and a results view.

## The honest constraint: shadow testing KILLS variants fast and CONFIRMS them slowly

This has to be stated plainly, because it determines what the promotion gates can and cannot mean.

To distinguish a genuinely good strategy (information ratio 0.5) from noise at 95% confidence takes
roughly **16 years** of live data. At IR 1.0 — exceptional — it still takes about 4. The dashboard
already says as much: ~1 year to a decade to prove this book beats SPY.

So forward shadow evidence is **strong disqualifying evidence and weak confirming evidence**. A
variant that is clearly broken shows up in weeks. A variant that is genuinely good cannot be
*proven* good in any timeframe that matters here.

Two consequences, and they are the difference between this working and becoming theatre:

1. **Promotion is a BET with bounded downside, not a proof.** The gates below are honest about
   this. Anyone describing a Tier 1 promotion as "validated" is misreading it.
2. **The backtest stops being optional.** Replaying variants across 10+ years and multiple regimes
   (2008, 2020, 2022) is the only way to get confirming evidence in useful time. Sharadar, ~$50/mo,
   currently parked in `docs/experiment-nori-tail-risk.md`, is what unblocks this — and it is the
   single highest-leverage purchase for this project.

Capture began 2026-09-29, so stored replay history is currently ~2 days and grows by one per
trading day. **Verify the real count before building anything that assumes depth.**

## The tiers

### Tier 0 — unrestricted autonomy, zero capital
The agent writes any variant it wants. Evaluated two ways, both free:
- **Replay** over every stored `CaptureDay` (point-in-time, no survivorship bias)
- **Forward**, daily, alongside the live book, scored as picks mature

No approval, no gate, no money, no deploy. **The agent lives here ~95% of the time.** This is the
tier where "full autonomy" is real and unqualified.

### Tier 1 — small real allocation, earned
Requires ALL of:
- Pre-registered criteria met on data accrued strictly AFTER `registeredAt`
- ≥ 40 trading days of forward shadow, ≥ 30 distinct names
- Positive excess vs SPY, and a higher IR than the live book over the same window
- Not disqualified by the backtest across at least one full drawdown regime
- Owner sign-off (CLAUDE.md already requires this for anything changing what the agent trades)

Allocation: a bounded slice of the main book, with a hard kill-switch on drawdown.

### Tier 2 — full sleeve
Same evidence bar, sustained, plus a live Tier 1 track record. Owner sign-off again.

## Pre-registration, because the alternative is guaranteed self-deception

Without this the agent reads the results, then picks the threshold that its best variant happens to
clear. With many candidate variants and a noisy monthly signal, *something* always looks good — an
agent trying 10 variants a month and reporting the best gets roughly 1.5 sigma of pure selection
bias, for free, forever.

So: a variant's `criteria` and `registeredAt` are written **before** it accrues forward data, and
the scorer counts only days after `registeredAt`. Criteria are immutable — changing them mints a
new variant id with a fresh clock, which makes the multiple-comparisons cost *visible* instead of
hidden.

## Risk parameters: chosen by the agent, CLAMPED by code

Not everything is expressible as a ranking function. Position count, stop levels, and sizing are
real strategy choices. The agent picks them; code bounds them:

```ts
clampVariantConfig({
  maxPositions:   [4, 12],
  stopLossPct:    [-15, -3],
  maxPerSectorPct:[20, 50],
  maxPositionPct: [10, 30],
})
```

The agent optimizes inside the envelope. **The envelope is not agent-editable** — that is the
difference between tuning a strategy and dismantling its risk controls.

## Permanently out of reach, at every tier

These are not policy requests to the agent; they must be enforced structurally.

| Off-limits | Why |
|---|---|
| Return accounting (`run-store`, `risk-metrics`) | The optimizer must never control the scorer |
| The SPY benchmark | Moving the goalposts is the cheapest way to "win" |
| Code-enforced caps (`applyPerPositionCap`, sector/concentration) | CLAUDE.md security invariant — every buy capped in CODE |
| The trade-token boundary | CLAUDE.md security invariant — a reasoning LLM never holds the token |
| Order placement | Already true; variants are pure functions |
| Prod deploy | The `/code-review` + `REVIEWED=1` gate stays |
| Budget, S&P universe, $500 influencer cap | Owner-fixed |

## What this does NOT address

- **It will not produce 10%/month.** That implies ~5.0 Sharpe (against Medallion's ~2.5) or ~120%
  annualized volatility. Nothing here is a route to it, and a system that appeared to deliver it
  would be a measurement bug before it was a strategy.
- **It does not fix the −5.90% alpha.** It builds the apparatus for finding out *why*. The
  picked-vs-passed-over comparison in `docs/experiment-main-book-position-cap.md` is the first
  question it should answer, and that comparison is now cheap for it.
- **It adds no new live-money risk at Tier 0**, which is the whole point of starting there.

## Recommendation

Build Tier 0 only, in this order:

1. `StrategyVariant` interface + registry + `clampVariantConfig`
2. Replay harness over stored `CaptureDay`s, scored through the existing `scoreShadowObservations`
3. A variants panel on `/observability`, alongside the existing shadow cards
4. Let the agent generate and run variants against it — unrestricted, zero capital
5. **Revisit Sharadar.** Without it, confirming evidence takes years; with it, weeks.

Do not build Tier 1 until Tier 0 has produced a variant that survives its own pre-registered
criteria. The thing to resist is promoting a variant because the agent argues well for it: with
this much noise and this many candidates, a persuasive case for a bad variant is the *expected*
output, not a surprise.
