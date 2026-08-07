# Strategy Spec: Quality-Momentum

**Status:** PROPOSAL — owner review required before any live code. Strategy change to a live account.
**Author:** drafted 2026-07-09 from the backtest arc (see `strategy-research-findings.md`).
**Supersedes:** the current 5-/14-day momentum ranking, and the shelved `strategy-dip-in-uptrend.md`.

---

## 1. Why this
Backtesting (2017–2026, `strategy-research-findings.md`) found:
- The current **5–14 day** signal trades the short-term *reversal* zone — the wrong side of the horizon.
- **Medium-horizon momentum** beats SPY in-sample (but the edge is fragile/unproven, −48% drawdown).
- **Quality-screening** was the *only* lever that cut that drawdown (−50%→−40%) at ~flat Sharpe, and made
  the profile less bubble-year-dependent — it drops junk-momentum (INTC/ALB), keeps quality winners.
- The **sector cap** costs ~4 CAGR pts but is real insurance against a single-theme crash → **keep it**.

Net design: **medium-horizon momentum, screened by quality, sector-capped, rebalanced weekly.**

> Honest caveat up front: the *edge is not validated* (survivorship bias, single sample; quality's
> backtested magnitude was look-ahead-inflated). Shipping this is a **forward bet**, to be measured live
> against SPY and against the current strategy — not a proven strategy. Note: using *current* fundamentals
> is methodologically **correct for live trading** (you trade today on what's known today); the look-ahead
> issue only limited backtest credibility, not live use.

## 2. Signals (precise)

Requires ~1 year of daily closes per stock (current fetch is `range=1mo` — widen; §6).

**2.1 Momentum (the ranking signal).**
```
mom = price[t-21] / price[t-252] - 1        # 12-1 momentum: 12-month return, skipping the last month
```
- Rank eligible names by `mom` descending. (6-1 momentum — `price[t-21]/price[t-126]-1` — was near-identical
  in testing; a 0.5·(6-1)+0.5·(12-1) blend is an option, §8.)
- Default is **raw** return (what was backtested). Optional risk-adjustment `mom / vol^k` (our existing
  `momentumScore`) is a refinement, **not** what the backtest validated — leave off for v1 (§8).

**2.2 Quality screen (the eligibility filter).**
Fundamentals from **SEC EDGAR frames API** (free, compliant User-Agent required), latest completed fiscal
year, cached and refreshed **quarterly** (fundamentals move slowly). Ticker→CIK via `company_tickers.json`.
Pull: `NetIncomeLoss` (CY duration), `StockholdersEquity`, `Assets`, `Liabilities` (CY-end instant).
```
ROE = NetIncome / StockholdersEquity      # profitability
ROA = NetIncome / Assets                   # profitability, capital-structure-neutral
LEV = Liabilities / Assets                 # safety (lower = better)
quality = mean( pct(ROE), pct(ROA), 1 - pct(LEV) )   # percentile ranks within the covered universe
```
- **Financials & Real Estate exception:** banks/REITs are structurally levered → drop the `LEV` term for
  those sectors (use `mean(pct(ROE), pct(ROA))`) to avoid mis-flagging them low-quality.
- **Eligible = `quality >= median`** of the covered universe.
- **No fundamentals → ineligible** (conservative: don't buy what we can't quality-screen). ~361/449 names
  have coverage today; this shrinks the tradable universe accordingly (acceptable).

**2.3 Selection.** Among eligible names, walk the momentum ranking and pick top **N**, skipping any name
whose sector is already at the 40% cap (max `floor(0.40·N)` per sector). Result: the highest-momentum,
above-median-quality, sector-diversified names.

## 3. Portfolio & risk
- **N = 6** positions (matches the concentrated-book setting; sector cap ⇒ max 2/sector at N=6).
  *(Backtest used N=10 — steadier; N=6 is higher-variance. Decision §8.)*
- **Sizing:** equal-weight for v1 (`value/N` each); risk-based sizing (~1% risked to the stop) is a §8 option.
- **Caps/rules unchanged:** `max($400, 20% of equity)` per position, min $50, whole shares, cash-only,
  never buy `⚠⚠ IMMINENT` earnings, 40% sector cap.

## 4. Hold / exit (replaces "fell out of the 5-day top-40 → sell")
At each **weekly** rebalance, recompute the eligible ranked set and hold the top **N**:
1. **Rotation:** a held name that's no longer in the top-N eligible set is sold; new entrants are bought.
   Because the 12-1 signal is slow, this turns over infrequently — long holds emerge naturally.
2. **Stop-loss:** −5% from entry (existing hourly drop-check, already sell-only) — the one intra-week exit.
3. **Quality/trend break (optional):** drop a held name immediately if its `mom` goes negative or it falls
   below the quality median at a refresh. (Simple v1: rely on weekly rotation + stop only. §8.)

No forced minimum-hold lock (blunt). Long holds come from the slow signal + weekly cadence, not a rule.

## 5. Cadence (stays dynamic)
- **Rebalance weekly** (e.g., first trading day of the week) — recompute eligibility/ranking, rotate.
- **Daily:** drop-check stops (existing). No daily churn on rank noise.
- Turnover is far below today's ~2-day median hold, but the heartbeat stays weekly — no monthly lock.

## 6. Code touch points
- **`lib/market-data.ts`** — `fetchQuote` `range=1mo`→`range=1y`; compute `mom` at (t-252, t-21); replace
  the `0.6·sharpe5d+0.4·sharpe14d` universe sort with the momentum→quality-filter→sector-cap pipeline.
- **`lib/quality.ts` (new)** — SEC EDGAR fetch (CIK map + 4 frames), quality score, in-memory/Redis cache
  with quarterly TTL, sector-aware leverage handling. Pure, unit-testable, fetched out-of-band (not on the
  trade hot path — refresh via a weekly/quarterly cron or cached blob).
- **`lib/strategy.ts`** — rewrite `READING THE MARKET DATA TABLE` + sell-discipline: describe momentum
  (12-1), the quality gate, the sector cap, and the §4 exits. Add a quality column to the table.
- **`app/api/trade/route.ts`** — the deterministic layer builds the eligible, ranked, capped candidate
  list; the LLM picks from *that list only* + writes the thesis (§7).
- **`app/api/drop-check/route.ts`** — keep −5% stop (sell-only, unchanged).
- **`vercel.json`** — trade cron effectively acts weekly (guard so it only rebalances the book once/week;
  stops still run daily/hourly). Add a fundamentals-refresh cron (quarterly/weekly).
- **`evals/`** — the deterministic pipeline (momentum rank, quality filter, cap) is unit-testable; add
  fixtures.

## 7. LLM role — "within rails" (recommended)
The deterministic layer produces the **eligible, quality-screened, sector-capped, momentum-ranked
shortlist**. The LLM: (a) picks the final N from that shortlist, (b) writes the thesis, (c) may *decline*
a name (hold cash) but **cannot add anything off the list**. This keeps the "autonomous LLM agent" identity
while structurally preventing off-book trades (the SCHW-class failure) and wrong-side picks. Fully
deterministic (LLM narrates only) is the alternative (§8).

## 8. V1 decisions (LOCKED 2026-07-09 — owner delegated "best judgment for v1")
1. **Momentum window: 12-1, raw return.** 6-1 was near-identical in testing; 12-1 is the most-documented/
   robust, and *raw* is exactly what the backtest validated (vol-adjustment would change the signal from
   what we tested — deferred to a possible v2).
2. **N = 6, equal-weight.** Chosen over the backtest's N=10 for a *practical small-account* reason: at
   ~$2,500, N=10 ⇒ ~$250/slot, which can't buy whole shares of the higher-priced momentum leaders; N=6 ⇒
   ~$417/slot leaves room. It also honors the concentration preference. Tradeoff acknowledged: higher
   single-name variance than the N=10 backtest — quality-screen + sector cap + −5% stop mitigate it.
3. **Sizing: equal-weight.** Matches the backtest; risk-based sizing (~1%/stop) is a v2 refinement.
4. **Exits: weekly rotation + −5% stop only.** The slow 12-1 signal + weekly rebalance already drops names
   that lose momentum/quality; a mid-week quality/trend-break (§4.3) adds turnover for little v1 benefit —
   deferred.
5. **LLM role: within-rails** (owner-confirmed). Deterministic shortlist; LLM picks from it + writes thesis,
   cannot go off-list.

The §2–§7 body already reflects these defaults, so no further changes are needed to lock v1.

## 9. Validation & rollout (do NOT ship blind)
1. **Backtest this exact pipeline** (momentum→quality→cap→weekly, N as chosen) on the existing data as a
   sanity check — deterministic, so reproducible.
2. **Paper/shadow-run in parallel** with the live strategy; compare forward vs SPY *and* vs current.
3. **Later, for real validation:** point-in-time fundamentals + walk-forward + survivorship-corrected
   universe (the rigor the backtest lacked).
4. Only after review → deploy behind the usual gate (`/code-review`, secret scan, `REVIEWED=1`).

## 10. Honest caveats (carry from the research)
- The edge is **unproven** — survivorship-biased, single-sample; quality's backtested size was
  look-ahead-inflated. This is the *best-supported* option found, not a sure thing.
- Beating SPY risk-adjusted, robustly, was **not** established in any test.
- Momentum still carries large drawdowns; quality softens but does not remove them.
- Treat live deployment as a measured forward experiment with a defined kill/keep decision date.
