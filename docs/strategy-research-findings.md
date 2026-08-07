# Strategy Research Findings (backtest arc, 2026-07-08/09)

**Status:** Research/analysis only. **No live strategy code was changed** — the live account still runs
the current strategy. This documents what a set of deterministic backtests found, so we don't lose it.

**One-line takeaway:** The dip/mean-reversion idea is dead; medium-horizon momentum beats SPY in-sample
but the edge is *fragile* (window- and 2020-dependent, survivorship-inflated) and carries a ~−50%
drawdown; the only lever that meaningfully reduced that drawdown was **quality-filtering** — which is the
most promising direction, but its magnitude here is inflated by look-ahead and needs point-in-time data
to trust.

---

## 1. Context & goal
- Goal of the account: **beat the S&P 500** while staying dynamic (daily/weekly readjustment).
- The current *live* strategy ranks the S&P 500 by a vol-adjusted blend of **5-day and 14-day** returns,
  re-ranked daily, holding a name only while it's in the top-40. Diagnosis: this trades the **short-term
  *reversal* zone** (days–weeks, where recent winners revert), i.e. the *wrong side* of the documented
  effect, with ~2-day median holds and high turnover.

## 2. Method
- Deterministic backtester (pure Python), universe = current `SP500_UNIVERSE`.
- Prices: Yahoo daily adjusted closes. Coverage: **433/449** names (16 delisted/renamed excluded).
- Fundamentals (quality only): **SEC EDGAR frames API**, CY2024 (ROE, ROA, leverage). Coverage **361/449**.
- Windows: 5y (2022→2026) and 10y (2017→2026, after a 253-day warmup). Top-N equal-weight (N=10),
  marked daily, **net of 5 bps/side** costs. Momentum = **12-1** (return t-252→t-21, skipping last month).
- Numbers wobble ~1–2 pts run-to-run (set-ordering under cash/cost constraints) — treat as approximate.

## 3. Headline results (10y, 2017→2026, N=10, 5bps)

| Strategy | Total | CAGR | Sharpe | MaxDD | Verdict |
|---|---|---|---|---|---|
| Momentum 12-1 (uncapped) | ~+2300% | ~41–43% | ~1.10–1.15 | **−48%** | Beats SPY, but fragile |
| Quality-momentum | +1360% | 34.9% | 1.08 | **−39.5%** | Drawdown lever ✓ (look-ahead-inflated) |
| Momentum + 40% sector cap | +1870% | 39.4% | 1.11 | −50.4% | Cap ≈ cost-neutral; no DD help |
| Mag-10 buy & hold | +1452% | 35.8% | 1.07 | −54.6% | Hindsight + concentration |
| SPY buy & hold | +252% | 15.1% | 0.84 | −33.7% | The hard baseline |
| Momentum + 200d filter | +455% | 21.1% | 0.82 | −37.0% | **Failed** (whipsaw) |
| Dip-in-uptrend | +104% | 8.3% | 0.61 | −27.0% | **Dead** |

## 4. Findings by strategy

**Dip-in-uptrend (short-term reversal within an uptrend gate) — DEAD.**
Worst of everything: 8.3% CAGR, Sharpe 0.61, dead-last across every regime. Negative in 2022 *and* 2023,
made +0.8% in 2020 (SPY +18%). Mean-reversion caps upside in trending markets by selling winners on the
bounce, and 2017–2026 was trend-dominated. Independently, Farzam's repo shipped nearly the same design
(RSI<30 + 20-day-MA entry, 20-day-MA/−5%/10-day exits) — convergence validated the *structure*, but the
backtest killed the *edge*. **Do not build it.** (Supersedes `docs/strategy-dip-in-uptrend.md`.)

**Momentum 12-1 — beats SPY, but the edge is fragile.**
Highest raw return; over 10y it beats SPY on Sharpe too (1.15 vs 0.84). BUT:
- **Window-dependent.** On the 5y window (2022→2026), momentum Sharpe 1.03 *< SPY 1.20* — SPY won.
  On 10y it flips. Whether momentum "beats SPY" depends on the start date.
- **2019–2020-dependent.** Excluding just 2020, momentum Sharpe drops to ~1.04 and SPY *rises* to ~0.94
  — nearly tied. A large share of the edge is two bubble years.
- **Survivorship-inflated** (uses today's S&P constituents) — momentum benefits most (it selects the
  biggest recent winners among survivors).
- **−48% drawdown.** You'd have to survive nearly halving the account.
- **Current book = all semis.** The 12-1 (and 6-1, 3-1) rankings today are ~9–10/10 AI-semiconductor/
  memory names (WDC, MU, STX, INTC, MRVL, AMD, …) — a single-theme bet.

**Momentum horizon (3 / 6 / 12 month).** 6-1 ≈ 12-1 today (7/10 overlap, same semis theme). 3-1 diverges
more and starts catching reversal-prone spikes (ENPH, ORCL already rolling over) — the short edge is
noisier/higher-turnover and near the reversal boundary. **6–12 month is the defensible horizon**; 3-month
is the weak end.

**Sector cap (40%).** Applied to momentum: CAGR 43→39%, Sharpe ~flat (1.15→1.11), drawdown *slightly
worse* (−48→−50%). Over 10y momentum wasn't always one-sector (the all-semis thing is recent), and the
big drawdowns were *market-wide*, so sector diversification didn't protect. **Uncapped > capped on every
metric** in this sample — the cap is *unproven insurance* against a sector-specific crash (dot-com-style)
that didn't occur in-sample, not a performance win.

**200-day trend filter — FAILED.** De-risking to cash when SPY < 200-day MA *whipsawed* (turned 2022's
+15% into −15%, missed the 2023 recovery), cutting CAGR 43→21% and Sharpe *below SPY* for only a modest
drawdown reduction. The classic simple-MA-filter failure in choppy markets.

**Mag-10 buy & hold.** Highest Sharpe on the 5y window; on 10y a −55% drawdown and −50% in 2022. It's
hindsight concentration ("the winners won") — not a replicable, ex-ante strategy.

**Quality-momentum — the one drawdown lever.** Screening the momentum names by a quality score (ROE/ROA/
low-leverage) cut the drawdown **−50% → −40%** at ~flat Sharpe (1.10→1.08), gave up the 2019–2021 bubble
upside but **beat plain momentum every year 2022–2026** — a more consistent, less-2020-dependent profile.
Mechanism: it dropped junk-momentum (INTC, ALB — big runs, unprofitable) and kept quality winners (NVDA-
type). **Caveat: look-ahead.** Quality is CY2024 fundamentals applied over all history, so it screens out
names we *now know* deteriorated (INTC was fine in 2017–19) and keeps ones we *now know* thrived — the
real benefit is smaller than shown. Also financials are mis-flagged low-quality (leverage metric). Still,
it's the direction most consistent with the factor literature (quality = the defensive factor).

## 5. Cross-cutting truths
- **Beating SPY risk-adjusted, robustly, is genuinely hard** — SPY's Sharpe (0.84 over 10y) was only
  cleanly beaten by strategies that are fragile/inflated/drawdown-heavy.
- **Most of the apparent edges are window- and outlier-dependent** — the single biggest lesson. One 10y
  path, survivorship-biased, is not proof.
- **Industry context** (from cited research): serious quant firms use ML for **text→signal + execution**,
  *not* an LLM as the decision-maker (Two Sigma). LLM trading-agent backtests are frequently look-ahead/
  leakage mirages ("Profit Mirage", arXiv:2510.07920). The best-marketed retail AI ETF (AIEQ) *trails*
  the index. Our LLM-as-decider is the experimental frontier, not the proven path.

## 6. Caveats that apply to ALL numbers
1. **Survivorship bias** — today's constituents over history; inflates everything, momentum most.
2. **No point-in-time data** — neither index membership nor fundamentals are as-of-date → look-ahead.
3. **Quality = CY2024 applied over 10y** → specifically flatters quality-momentum.
4. **Idealized execution** — fractional shares, only 5 bps cost, no whole-share/small-account frictions.
5. **Single parameter set (N=10), single 10y path** — not walk-forward, not multi-regime-robust.
6. **The live LLM strategy can't be cleanly backtested** (training look-ahead) — forward-test only.

## 7. What this implies (decisions)
- **Kill the dip/mean-reversion idea.** Confirmed across regimes.
- **The live strategy's biggest fixable flaw is the *horizon*** (5–14 day = reversal zone). If we pursue
  active equity, **medium-horizon (6–12mo) momentum** is the better-supported direction.
- **Quality-momentum is the most promising combination** — the only lever that addressed the drawdown —
  but trust it only after **point-in-time fundamentals**.
- **Beating SPY robustly is unproven.** Defensible honest options: a low-turnover quality-momentum tilt
  *with eyes open on the drawdown*, or largely-index + a small active sleeve.
- **Narrow the LLM's role** (text→signal, e.g. the influencer sleeve) rather than whole-brain decider —
  matches the industry pattern and our own reliability lessons (e.g. the off-book SCHW trade).

## 8. Open next steps (rigor upgrades, in priority)
1. **Point-in-time fundamentals** → a trustworthy quality/quality-momentum test (the top item).
2. **Walk-forward across many start dates** → kill the window-dependence.
3. **Survivorship-corrected universe** (point-in-time membership) → deflate the momentum numbers.
4. **Cost/N sensitivity** (10 bps, N=6) and **position-level risk control** (per-name stops, vol sizing).

## 9. Provenance
Backtest scripts + data live in the session scratchpad (not committed): `fetch_prices.py` (Yahoo prices),
`backtest.py` (strategies/metrics), `qmom.py` (quality-momentum), `quality.json` (SEC-derived scores).
Prices 2016–2026 (433 names); fundamentals CY2024 via SEC EDGAR frames (361 names).
