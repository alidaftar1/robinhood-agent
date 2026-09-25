# Conviction Sleeve — Specification (DRAFT, not built)

**Status:** spec for review. Nothing implemented. Requires owner approval before any code, because it
changes what the agent trades and how much.

**Intent:** a small sleeve where selection is driven by *research into the business* rather than by a
transform of price, held for 3–6 months. This is the direct answer to "shouldn't the AI research
companies and pick high-conviction names?" — scoped so it can be wrong without being expensive.

---

## 1. The measurement problem — read this first

Everything else in the system can be checked against history. **This sleeve cannot be backtested at
all.** Ask a model to research a name "as of March 2023" and it already knows what happened; the
lookahead contamination is unfixable, not an engineering gap. So the sleeve can only ever be judged
forward, in real time.

Worse, the sample accrues slowly by construction: 2–3 positions held 3–6 months is **roughly 6–8
picks per year**. Thirty picks — still a thin sample — would take about four years.

**Therefore this sleeve will not produce a statistically credible verdict on any horizon we care
about.** That is not an argument against running it; it is an argument for sizing it as a bounded
experiment, and for measuring what *can* be measured instead of pretending we'll get significance:

- **Per-pick attribution** vs SPY over each pick's own holding window.
- **Opportunity cost:** what the main book would have done with the same capital over the same window.
- **Thesis-invalidation rate:** how often the stated falsifiers actually tripped (see §6). This is the
  honest measure of research quality and it needs no statistics — either the reasoning held or it didn't.

If after a year the answer is "indistinguishable from the main book," that is a real result and the
sleeve should be retired rather than defended.

---

## 2. Capital and funding — the part that needs a decision

Measured 2026-09-18: **total equity $2,433.23**, positions $2,210.27, **cash $50.11**.

| | $ | % of equity |
|---|---|---|
| Main momentum book | ~$1,700 | ~70% |
| Influencer sleeve | $511 | 21% |
| **Conviction sleeve (proposed)** | **$500** | **20.6%** |

Two consequences the number alone doesn't show:

1. **There is no spare $500.** Funding it requires selling ~$450 of existing positions, a deposit, or
   phasing in as positions rotate out naturally.
2. **The two experimental sleeves would be ~41% of the book**, leaving ~59% in the strategy that has
   the only measurable track record. That may be the intent; it should be a decision, not a side effect.

**Recommendation:** phase in over 4–8 weeks from natural main-book rotation rather than force-selling,
and start at **2 positions (~$250 each)**, adding the third only after the first thesis review.

---

## 3. Universe

`SP500_UNIVERSE ∪ EXPANDED_UNIVERSE`, liquidity-gated — the same machinery the influencer sleeve
already uses. Rationale: research depends on filing availability, and all of these are US filers with
EDGAR coverage. Deliberately **not** widened to small caps: the fundamentals plumbing (`lib/quality.ts`)
is built on the S&P universe, and a research edge we cannot verify is worse than no edge.

---

## 4. Research inputs

| Input | Source | Status |
|---|---|---|
| Earnings press release (guidance, tone, red flags) | SEC 8-K EX-99.1 | **shipped** (`lib/earnings-release.ts`) |
| Fundamentals / quality score | SEC financials | **shipped** (`lib/quality.ts`) |
| Analyst consensus + earnings surprise history | Finnhub | key present, port from `newsai2` |
| Material news events | existing news pipeline | shipped, **headlines only** |
| 10-K / 10-Q — MD&A and Risk Factors | SEC EDGAR | **to build** (free; same plumbing as EX-99.1) |
| Competitive/industry context, policy & politics | web search | **to build**, or accept as a gap |

The last row is the one to be honest about. Without it the model reasons from its training prior plus
filings — which is real, but it is not "current dynamics and politics." Options: add a search tool,
or state plainly that v1 is *filings-driven research*, not *world-state research*.

---

## 5. Selection

Keeps the repo's existing boundary: **code decides what is eligible, the model decides which and why.**

1. **Candidate funnel (deterministic).** We cannot research 450 names. Code produces ~10–15 candidates
   per research cycle — quality-eligible, liquid, with a recent catalyst (earnings, material news, or a
   large analyst revision). This is a *funnel*, not a ranking: it does not pre-judge conviction.
2. **Deep research (model).** Per candidate: filings, earnings release, consensus, surprise history,
   news. Expensive, so run on a cycle (§7), not daily.
3. **Selection (model).** Choose 2–3 with the highest conviction and write a thesis for each.

### The thesis must be falsifiable

Every pick states, in its own words:

- **Why now** — what the market is underweighting, specifically.
- **Expected horizon** — 3 or 6 months.
- **Named falsifiers** — the concrete, checkable conditions that would prove the thesis wrong
  (e.g. *"gross margin below 40% for two consecutive quarters"*, *"the China ban extends to Blackwell"*).

This is the core of the design. Without named falsifiers, "conviction" is unfalsifiable and exits
become vibes; with them, every later review is an objective check, and §1's invalidation rate becomes
measurable.

---

## 6. Risk framework

**The existing machinery is wrong for this sleeve and must be explicitly overridden, not inherited.**

| Rule | Main book | Influencer | **Conviction** |
|---|---|---|---|
| STALE time-stop | 60d / <+3% | TWO clocks: 10d and DOWN, or 25d / <+8% | EXEMPT — a 3-6 month thesis outlives both clocks by design |
| Stop-loss | −5% same-day | −10% from buy | **−25% from buy, as a circuit breaker only** |
| Take-profit | none | +40% | **none** — capping a 6-month thesis at a price target defeats it |
| Drop-check cadence | daily | 6×/day | **daily is enough** — a thesis holder does not need an hourly leash |
| Position cap | 20% of equity | 20% | **~$250 (~10%)** |
| Sector cap | ≤2 per sector | n/a | **≤2 per sector** across the sleeve |

On the −25% stop: it is deliberately wide enough not to fire on noise (the sleeve's names run ~2.5–4%
daily vol, so −25% is well beyond a normal drawdown) and exists solely to bound a catastrophe —
fraud, a collapsed thesis we failed to act on. **It is not a trading signal**, and a pick approaching
it should already have been exited by §7's review on thesis grounds.

---

## 7. Cadence and cost

| Trigger | Action | Cost |
|---|---|---|
| Research cycle (monthly, or when a slot is open) | full funnel + deep research | ~$1–2 per candidate researched |
| Monthly thesis review | check each holding's named falsifiers | ~$0.10 per holding |
| Event-driven (earnings, material news on a holding) | re-check falsifiers | ~$0.10 |
| Daily | **nothing** — price check only, via the existing drop-check | $0 |

Estimated **$15–30/year**. The cost discipline that matters is *not researching daily*; the expensive
step runs at most monthly, and only when there is a slot to fill or a thesis to re-test.

---

## 8. Exits

A conviction position is sold when, and only when:

1. **A named falsifier trips** — the thesis is disproven on its own stated terms. Primary exit.
2. **The horizon is reached** (3 or 6 months) and the thesis is re-underwritten or retired. A pick that
   is merely flat at horizon is **not** automatically sold — that was the thesis's own timeframe.
3. **The −25% circuit breaker** fires.
4. **Sleeve-level judgment**: a materially better candidate exists and this is the weakest thesis.

Explicitly **not** exit reasons: ranking below a momentum name, being flat for three months, or a
single bad print that does not trip a named falsifier.

---

## 9. Accounting and reporting

Reuses the sleeve infrastructure that already exists:

- `strategy: "conviction"` trade tag, its own `convictionPositions` on each run snapshot.
- Sleeve return series alongside the main and influencer series (`computeSleeveReturns`).
- A dashboard card: return, vs SPY, **and the per-pick thesis with its falsifiers and current status.**
- Each pick logged to a conviction ledger at entry, scored forward — mirroring `lib/signal-ledger.ts`.

Showing the thesis and falsifiers on the dashboard is the point: it makes the reasoning auditable
rather than a black box, and it is what makes §1's invalidation rate real rather than aspirational.

---

## 10. Known weaknesses

- **Unfalsifiable at the portfolio level** (§1). Accepted, and the reason for the small size.
- **No world-state awareness** without a search tool (§4). v1 is filings-driven.
- **Model bias toward familiar mega-caps.** Its prior is strongest on the most-covered names, which are
  also the most efficiently priced — exactly where research edge is least likely.
- **Concentration.** 2–3 names at ~$250 means one bad pick is ~10% of equity.
- **Correlation with the main book.** A conviction pick may be a name the momentum book already holds.
  Needs an explicit rule: either forbid overlap or cap combined exposure.

---

## 11. Build order

1. 10-K/10-Q MD&A + Risk Factors extraction (EDGAR — reuses the EX-99.1 plumbing).
2. Finnhub consensus + surprise port from `newsai2`.
3. Candidate funnel (deterministic).
4. Research + selection prompt, thesis schema with named falsifiers.
5. Sleeve accounting, overrides in drop-check / stale / caps.
6. Dashboard card + conviction ledger.
7. **Paper-run for 2–4 weeks** — produce picks and theses, place nothing, and see whether the
   reasoning survives a read before any capital is committed.

Step 7 is not optional. It is the only cheap way to find out whether the research output is worth
$500 before it costs $500.

---

## 12. Decisions needed before any of this is built

1. **Funding:** sell ~$450 of main book, deposit, or phase in from natural rotation?
2. **41% of the book in experimental sleeves** — intended, or should the influencer sleeve shrink?
3. **Search tool** for world-state, or accept a filings-only v1?
4. **Overlap with the main book** — forbid, or cap combined exposure?
5. **Horizon:** fixed 3 months, fixed 6, or per-thesis (model states it at entry)?
