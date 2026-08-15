# Plan — Survivorship-Aware Backtest of the Quality-Momentum Rules

**Drafted:** 2026-08-14. **Status:** scoped, not built.

## 0. Why (and why the last one wasn't enough)

We already ran a backtest (`strategy-research-findings.md`, 2026-07-08/09): quality-momentum
beat SPY over 10y (34.9% CAGR / Sharpe 1.08 vs 15.1% / 0.84). But it used **today's S&P 500
roster** as the historical universe → survivorship-inflated, and the docs flagged the magnitude
as "look-ahead-inflated." This plan rebuilds it **survivorship-aware and committed** (the old
scripts live only in a scratchpad), so we can trust the numbers and re-run them.

## 1. Goal / non-goals

**Goal:** understand how the *deterministic quality-momentum RULES* behave across market regimes
— especially **drawdowns** (2000, 2008, 2020, 2022) — which the ~24 live days (one calm bull
window) can't show and won't for years.

**Explicit non-goals:**
- NOT to prove the live book. The live strategy is Claude making judgment calls, not the rules;
  the LLM can't be cleanly backtested (training look-ahead, 2017–2026). A great backtest raises
  the *prior*; it does not move the live "69% beats SPY." Treat this as permanent.
- NOT to maximize a headline CAGR. The output that matters is drawdown/regime behavior and
  robustness, not a big number to brag about. Tuning to maximize CAGR = overfitting (see §6).

## 2. The crux: survivorship-free data

This is 80% of the work; the engine is easy. Three components:

**(a) Point-in-time S&P 500 membership** — the roster *as it was* on each rebalance date, incl.
names later removed.
- **Free:** `fja05680/sp500` (GitHub) — historical constituents + change log back to 1996. Good
  enough, needs parsing into a date→members map.

**(b) Prices incl. DELISTED names** — the hard part; Yahoo silently drops delisted tickers, which
is *the* survivorship bias. Options:
- **Paid (recommended, ~$50/mo): Sharadar `SEP`** via Nasdaq Data Link — survivorship-bias-free
  daily prices for ~16k US tickers incl. delisted, back to ~1998. The only clean path.
- **Free (imperfect): Yahoo/Stooq/Tiingo** — cover survivors well, delisted poorly. Result is
  "survivorship-*aware*" (better than today's-roster) but still leaks. Cheaper, honestly caveated.

**(c) Point-in-time fundamentals (for quality)** — ROE / ROA / leverage *as filed*, lagged for
reporting delay (no restatement look-ahead).
- **Paid: Sharadar `SF1`** (`dimension=ARQ`, as-reported) — cleanest.
- **Free: SEC EDGAR frames API** (what the old backtest used) — free but fiddly to make truly
  point-in-time (must lag ~45–90 days and use as-filed values).

**Recommendation:** do it right → **Sharadar SEP + SF1 (~$50/mo, one month suffices)** for a
truly survivorship-free run. Fall back to the free stack only if we won't pay — and label the
output as bias-*reduced*, not bias-*free*. **This data choice gates everything and is Phase 0.**

## 3. Engine spec (mirror live V1 exactly — do not "improve" it)

Reuse the live rules so the backtest tests *our* strategy, not a prettier cousin:
- **Universe:** point-in-time S&P 500 members at each rebalance.
- **Momentum:** 12-1 (return t-252 → t-21, skip last month). *Raw* return (matches live; the
  vol-adjusted `momentumScore` is a refinement, not what ships).
- **Quality filter:** above-median ROE & ROA, below-median leverage, as-of (lagged).
- **Selection:** top-N equal-weight. Test **N=6 (live)** and **N=10 (steadier)**.
- **Sector cap:** 40% (live). Toggleable to measure its cost/insurance.
- **Rebalance:** match the live cadence (daily decision → monthly is the defensible test; run both).
- **Costs:** 5 bps/side (as before) + a slippage sensitivity (10 bps) since small/mid names cost more.
- **Benchmark:** SPY total return over the identical windows.

## 4. Metrics — drawdown/regime first, not a headline

- **Max drawdown** + **full drawdown curve**; time-to-recover.
- **Regime slices:** each crisis (2000-02, 2008-09, 2020, 2022) AND each calendar year — return,
  drawdown, and vs-SPY for each. *The point is seeing behavior in the −40% windows.*
- **Rolling** 12-month Sharpe and alpha vs SPY (is the edge persistent or a few years?).
- **vs-SPY significance:** Information Ratio + the same "beats SPY" test we use live — but now
  over decades, where it can actually reach significance.
- **Robustness table:** N=6 vs 10, cap on/off, momentum 6-1 vs 12-1, quality on/off — flag which
  choices are robust vs. which just fit the sample.

## 5. Deliverables (committed, reproducible — unlike last time)

- `backtest/` dir: `fetch_data.(py|ts)`, `universe.(py|ts)`, `backtest.(py|ts)`, `metrics.(py|ts)`.
- Cached data snapshot (or a documented fetch) so results reproduce without re-paying.
- `docs/backtest-results-survivorship-aware.md`: the regime/drawdown tables + honest caveats.
- A one-line `make backtest` / npm script.

## 6. Overfitting guardrails (non-negotiable)

- **Pre-register** the parameter set = live V1 (N=6, 12-1, 40% cap, quality filter) BEFORE looking
  at results. Report those as the headline; everything else is labeled "sensitivity, not tuning."
- Never iterate the rules to make the backtest prettier — that's curve-fitting the past.
- Report the **worst** regime prominently, not just the 10y aggregate.

## 7. Effort

- Phase 0 — data-source decision (paid vs free): **owner call, blocks everything.**
- Phase 1 — point-in-time universe + prices (incl. delisted): the bulk.
- Phase 2 — point-in-time quality.
- Phase 3 — engine (old scratchpad `backtest.py` is a starting point) + regime/drawdown metrics.
- Phase 4 — robustness sweep + writeup.
- Rough: **~2–3 days on Sharadar data**; more on the free-but-leaky stack.

## 8. The honest bottom line

A clean run tells us whether the *rules* have a durable, across-regime edge and — most valuable —
**how they bleed in a −40% market**, which is the test we can't run live for years. It should make
us more (or less) willing to *keep funding the strategy through its inevitable drawdowns*. It will
**not** prove the live LLM book beats SPY — only the forward record judges that. Build it to
sharpen the prior and stress-test the downside, not to declare victory.
