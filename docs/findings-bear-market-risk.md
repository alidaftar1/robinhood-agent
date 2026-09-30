# Finding — what the strategy does in a bear market

**Date:** 2026-09-30
**Status:** MEASURED. No code change proposed yet; this is the risk read the live book had no data for.
**Method:** `scripts/bear-test.ts` — the live screen, unmodified, over survivorship-free Sharadar
history. One strategy, four pre-specified windows, no variant search and no parameter tuning, so
there is no multiple-comparisons cost and no overfitting exposure.

---

## The numbers

| Window | Strategy | SPY | Strategy max DD | SPY max DD | Stop-outs | Days in cash |
|---|---|---|---|---|---|---|
| Dot-com 2000-03 → 2002-12 | **−50.1%** | −33.7% | −53.1% | −47.5% | 238 | 1% |
| **GFC 2007-10 → 2009-06** | **−70.2%** | −37.9% | **−72.1%** | −55.2% | 153 | 3% |
| COVID 2020 | **+26.3%** | +17.3% | −30.9% | −33.7% | 58 | 1% |
| 2022 grind | −13.7% | −18.6% | −27.1% | −24.5% | 71 | 1% |

## Three findings, in order of how much they should change behaviour

### 1. In a LONG GRINDING bear the screen loses ~1.6–1.9× the market, and diversification does not fix it

The obvious objection is concentration: 6 equal-weighted names is a far narrower book than SPY, and
the live book actually holds ~12. Tested directly on the GFC window:

| Positions | Return | Max DD | Avg actually held |
|---|---|---|---|
| 6 | −70.2% | −72.1% | 5.1 |
| 12 (≈ live) | −59.5% | −63.6% | 9.4 |
| 20 | −58.4% | −63.7% | 14.8 |
| 30 | −64.1% | −67.6% | 21.2 |

Going from 6 to 20 names recovers about 12 points and then stops helping. Every configuration still
loses far more than SPY's −37.9%. **This is a property of the signal in that regime, not of the
position count** — consistent with the documented momentum-crash literature, where momentum is
worst hit during the violent reversal off a bottom (here, March–June 2009, which this window
deliberately includes).

### 2. The stops never actually de-risk — they churn

This is the most robust finding, because it does not depend on the fidelity gaps below.

**The book is in cash 1–3% of days in every single window.** Across the GFC it was stopped out 153
times and still spent 97% of the period fully invested. The mechanism is visible: a stop fires, the
position is sold, and the next weekly rebalance immediately redeploys into whatever still ranks.
The stop realises a loss and re-enters; it does not reduce exposure.

That is exactly what `docs/` already suspected without evidence — the regime signal is advisory
only, there is no hedge and no cash trigger, and de-risking is *reactive* via serial stop-outs. This
measures the consequence: reactive de-risking, at this cadence, is not de-risking.

One nuance worth keeping: in the GFC the screen could not even fill its slots (5.1 of 6 held on
average), because few names had positive 12-1 momentum. The strategy does drift toward partial cash
on its own — just nowhere near enough, and not by design.

### 3. A fast V-shaped crash is where momentum WINS

COVID 2020: **+26.3% vs SPY's +17.3%, with a shallower drawdown (−30.9% vs −33.7%).** It beat the
market on both axes in the most violent crash of the sample.

This matters for interpretation. Had the sample stopped at COVID — the only crash within a 5-year
data window, and therefore the only one a cheaper Sharadar tier would have shown — the conclusion
would have been "bear markets are fine." The two long grinds say the opposite. **The regimes
disagree, which is precisely why the full-history tier was the right purchase.**

## What this does NOT establish

Stated plainly, because a number without its caveats gets quoted alone:

- **Quality is missing.** The Prices plan has no fundamentals, so the screen ran momentum-only,
  without the above-median quality gate. In a bear, quality screens out exactly the junk that gets
  destroyed, so the real strategy would plausibly do better. **This is the single biggest unknown
  and the main argument for upgrading to the Bundle tier.**
- **No LLM layer.** Live is deterministic shortlist → LLM selection/sizing → risk rails. This tests
  the screen and the rails, not the agent. The model may have overridden some of these trades.
- **Stops are evaluated on closes**, so intraday stop-outs are undercounted. That flatters fast
  crashes and understates churn.
- **Execution is close-to-close** at the price the signal was measured on — the standard convention,
  mildly optimistic, not look-ahead.

## Correction logged

The first run of this test reported a GFC drawdown of −76.8% using a stop of −5% **cumulative from
entry**. That is the INFLUENCER sleeve's rule. The live main book uses
`MAIN_DROP_THRESHOLD_PCT = -5 // same-day move, from prev close` — a one-day crash stop. A slow
bleed of −2%/day trips the cumulative version in three days and never trips the live one, so the
first run manufactured churn and losses the live design would not have taken. `stopMode` is now an
explicit field with tests that prove the two modes diverge on a slow bleed versus a one-day crash.
The corrected GFC figure is −70.2%. The direction of the finding did not change; the magnitude did.

## What I would do with this

Not a recommendation to act today — the book is in a bull/chop regime and this describes a regime
that is not currently happening. But it converts a named, unquantified risk into a measured one:

1. **Close the quality gap first.** Upgrade to Bundle Full and re-run. If quality materially
   changes the grind results, the picture is different and everything below is premature.
2. **The lever already scoped is the right one.** `docs/` notes exactly one deliberately-unbuilt
   lever: a single absolute-momentum gate (go to cash when the name's own trend turns negative).
   These results are the argument for it, and it is now testable rather than theoretical.
3. **Do not reach for more stops.** The evidence says the stop path is already firing 153 times
   without reducing exposure. More of that mechanism is not the fix.
