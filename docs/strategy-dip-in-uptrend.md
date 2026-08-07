# Strategy Spec: "Dip-in-Uptrend" (medium-momentum gate + short-term-reversal entry)

**Status:** ⛔ SHELVED (2026-07-09). Backtesting (see `strategy-research-findings.md`) showed this
mean-reversion approach is the *worst* of all tested strategies across 2017–2026 — 8.3% CAGR / Sharpe
0.61, dead-last in every regime, beaten by a plain SPY hold ~2.4×. Kept for the record and the reusable
mechanics (convex laddered scale-in), but **do not build as the core strategy.** Original proposal below.
**Author:** drafted 2026-07-08 (Claude + owner discussion)
**Supersedes:** the current 5-/14-day momentum ranking (see "Why" below).

---

## 1. Motivation

Our current rule ranks the S&P 500 by a volatility-adjusted blend of **5-day and 14-day** returns
(`0.6·mom5 + 0.4·mom14`), re-ranked **daily**, and holds a name only while it stays in the top-40.

Two documented problems:
- **Wrong side of the short-horizon anomaly.** At the days–weeks horizon the research (Jegadeesh 1990,
  Lehmann 1990, and the large short-term-reversal literature) says recent *winners revert* and recent
  *losers bounce*. We buy recent winners — the names most likely to pull back. 2026-07-08 was a live
  example: XRAY/ELV bought on their morning spike, faded that day.
- **Turnover is structural.** A fast, noisy signal re-ranked daily churns the roster (~2-day median hold),
  and turnover eats a small account net of costs.

**Goal of this account is to stay dynamic (weekly, even daily readjustment) — not to go slow/monthly.**
So instead of switching to 6–12 month momentum (drastic, kills the dynamism), we keep the fast heartbeat
but trade the **right side** of the horizon effects by combining two documented anomalies at their
correct horizons.

## 2. Principle — "buy the dip in an uptrend"

- **Trend (slow, stable): medium-term momentum** decides *which names are eligible* — only stocks in a
  genuine 3–6 month uptrend. Grounds us in the documented momentum premium; filters out downtrends.
- **Timing (fast, dynamic): short-term reversal** decides *when to buy* — within that uptrending set,
  buy names that have **pulled back / are oversold this week**, NOT names that just spiked.

Both effects are documented and operate at different horizons; combining them ("buy oversold dips inside
confirmed uptrends") is a standard, research-backed construction. We stay weekly/daily-dynamic on entries
and exits, but on the correct side of the evidence.

## 3. Signals (precise definitions)

Requires ~1 year of daily closes per stock (current fetch is `range=1mo` — must widen; see §7).

Per stock, compute:
- `ret126` = 126-trading-day (~6-month) return = `price / close[-126] - 1`
- `sma100` = mean of the last 100 daily closes
- `ret5` = 5-trading-day return (existing `change5d`)
- `sma10` = mean of the last 10 daily closes
- `vol` = annualized 30-day volatility (existing `volatility30d`)
- (optional alt oversold measure) `rsi2` = 2-period RSI (Connors-style)

### 3.1 Trend gate (hard eligibility filter)
A stock is **eligible** iff BOTH:
- `ret126 > 0`  (positive 6-month trend), AND
- `price >= sma100`  (above its 100-day average — uptrend intact)

Ineligible stocks are never bought (regardless of oversold reading — no falling knives).

### 3.2 Entry ranking (short-term reversal, within the gate)
Among eligible names, rank by **oversold pullback**, risk-adjusted:

```
entryScore = pullback / vol^VOL_PENALTY_EXP
  where pullback = max(0, (sma10 - price) / sma10)      # how far price sits BELOW its 10-day avg
```

Higher `entryScore` = more pulled-back within an uptrend = better dip. This is the **sign flip** from
today: we currently reward `ret5 > 0` (spikes); we now reward price *below* its short average (dips).

**Falling-knife guard** (exclude even if eligible+oversold): drop a candidate if `ret5 < -15%`
(collapse, not a dip) — the gate's `price >= sma100` already blocks most, this catches gap-downs.

Alt entry trigger (simpler, well-known): `rsi2 < 10` inside the gate → oversold; can be used instead of
or alongside the `pullback` rank. Decision left open (§9).

### 3.3 Quality
The gate (positive 6-month trend + above 100-day MA, S&P constituent) is the quality floor. Optional
future add: a profitability screen. Not required for v1.

## 4. Exits (replaces "fell out of top-40 → sell")

Sell a held name when ANY of:
1. **Bounce played out (target):** `price >= sma10` again (recovered to short-term mean) OR gain from
   entry `>= +8%`. The reversal thesis is complete — rotate.
2. **Trend break:** `price < sma100` OR `ret126 <= 0`. The uptrend that justified holding is gone.
3. **Stop-loss:** `-5%` from entry (hard). Keep existing drop-check (already sell-only).
4. **Reversal time-stop:** held `>= 10` trading days with no bounce (didn't reach target, still below
   `sma10`). Short-term reversal should resolve fast; a dead dip is dead money. (Replaces the current
   15-day *momentum* staleness stop, which doesn't fit a reversal thesis.)

## 5. Portfolio / risk controls (mostly unchanged)
- **Concentration:** 4–6 positions (current setting).
- **Sizing:** prefer **risk-based** — size so the −5% stop risks ~1% of equity per name (from the
  successful-trader research); cap at `max($400, 20% of equity)`. (If risk-sizing is deferred, keep the
  dollar cap.)
- **Sector cap:** ≤ 40% per sector (unchanged).
- **Hard rules:** cash-only, whole shares, min $50, never buy `⚠⚠ IMMINENT` earnings (unchanged).

## 6. Cadence (keeps the account dynamic)
- **Daily trade run (7:30am, existing cron):** recompute the gate (slow-moving), scan eligible names for
  fresh oversold entries, apply exits. New dips get bought as they appear → daily reactivity preserved.
- **Drop-check (hourly, existing, sell-only):** stops + the bounce target can fire intraday.
- Net turnover is naturally lower than today (we're not chasing every spike) but the *heartbeat stays
  daily/weekly* — no monthly lock, no forced holds. Exactly the dynamism the account was built for.

## 7. Code touch points
- **`lib/market-data.ts`**
  - `fetchQuote`: widen `range=1mo` → `range=1y` (need 126-day return + 100-day SMA).
  - Compute + expose per stock: `ret126`, `sma100`, `sma10`, `rsi2` (optional).
  - Replace the universe sort `0.6·sharpe5d + 0.4·sharpe14d` with: filter by trend gate, then sort by
    `entryScore` (§3.2). The table shown to the model becomes "uptrending names, most-oversold first."
- **`lib/strategy.ts`**
  - Rewrite `READING THE MARKET DATA TABLE` + sell-discipline: describe the gate, the oversold entry, and
    the §4 exits. Flip the buy guidance from "high mom5" to "oversold dip within an uptrend."
- **`app/api/drop-check/route.ts`**: keep −5% stop; optionally add the `+8% / back-above-sma10` target as
  an exit trigger (it's already sell-only, so no redeploy).
- **`vercel.json`**: cadence unchanged.
- **`evals/`**: update fixtures/tests to the new signals; the deterministic gate + entry + exit rules are
  unit-testable (unlike the LLM's discretion).

## 8. Role of the LLM (decision needed, §9)
This spec defines a **deterministic signal layer** (gate → oversold candidates → exit rules). Two options
for the LLM:
- **(A) LLM within rails (recommended):** deterministic layer produces the *eligible, ranked candidate
  list*; the LLM picks among that shortlist and writes the thesis, but **cannot buy anything off the
  list**. Preserves the "autonomous LLM agent" identity while structurally preventing off-book trades
  (the SCHW-class failure) and wrong-side picks.
- **(B) Fully deterministic:** no LLM in the trade decision; the LLM only narrates. Maximally backtestable
  and reliable, but changes the project's character.

## 9. Open decisions for the owner
1. Entry trigger: `pullback/vol^k` rank vs `rsi2 < 10` vs both? (§3.2)
2. Trend gate windows: 6-month + 100-day MA as proposed, or tune (e.g., 3-month, 50-day)?
3. Exit target: `+8%` and/or `back-above-sma10`? Time-stop 10 days?
4. Risk-based sizing now, or keep the dollar cap for v1?
5. LLM role: (A) within-rails or (B) deterministic? (§8)

## 10. Validation plan
- The deterministic layer is **backtestable** (unlike today's LLM-on-daily-noise). Backtest over
  ~2–5 years, point-in-time, survivorship-aware, **net of costs**, walk-forward, across regimes.
- Run the deterministic version **in parallel (paper)** as the benchmark the live book must beat.
- Compare to SPY and to the current strategy over a meaningful forward window (months, not days).

## 11. Honest caveats
- **Short-term reversal has decayed over time and is cost-sensitive** — the classic ~2%/mo is gross,
  decades-old, small-cap-heavy. The trend gate + quality floor + the −15% knife guard exist precisely to
  make it more robust than naive "buy the biggest losers." Net-of-cost backtesting is mandatory before
  trusting it.
- Parameters here are **judgment defaults, not optimized** — they must be validated out-of-sample, not
  fit to recent noise (avoid the overfitting trap).
- This is still only forward-validatable for the live/LLM version; the deterministic core is the part we
  can actually backtest. It is not a guaranteed edge — it's trading the *right side* of a documented
  effect at the horizon this account wants to operate.
