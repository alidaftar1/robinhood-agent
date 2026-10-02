# Handoff — closing-bell snapshot (2026-10-01)

## CORRECTION, read this first: the cron is NOT scheduled, and that is deliberate

The owner asked the right question — *"the only place we actually need it is comparing with
backtesting results, right?"* — and the answer is yes. The dashboard's own cards are internally
consistent, because `spyPrice` is fetched in the same `Promise.all` as the portfolio snapshot, so
both legs share the 10:30 clock and it cancels. The clock mismatch only produces a **wrong** answer
where the two sides use *different* clocks: live-vs-backtest.

That makes a daily capture the wrong shape for the job. **`scripts/close-reconstruct.ts` is the
necessary piece** — it needs no write path into live-money data, and it covers the EXISTING run
history, which a forward-only capture can never reach. `/api/close-snapshot` stays built, tested and
unscheduled; enabling it later is a one-line `vercel.json` addition, and `evals/close-snapshot.test.ts`
guards that line (the config-invariant test asserts post-close timing *if* the cron is present).

No dashboard change is needed, and none was made.

## Status: code complete and verified locally. NOT reviewed, NOT deployed, NOT pushed.

Resume by running the deploy gate: `/code-review`, fix findings, `bun run check:secrets`,
then `REVIEWED=1 /Users/ali/.bun/bin/vercel deploy --prod`. Push is a separate approval.

## Why this was built

The trade cron fires 14:30 UTC (10:30 ET), and the run it writes is the only observation of the
portfolio — so the stored daily-return series is measured **10:30→10:30**, while the 28-year
backtest (`scripts/full-period.ts`) and every published SPY statistic are **close→close**.

Measured over the 29 stored days, those two clocks correlate only **0.668** on SPY. They are
genuinely different return series, not a time shift, so any "is live tracking the backtest?"
verdict is partly a sampling artefact until the clocks match. That was the one real justification;
the two conveniences were matching the Robinhood app and using the canonical closing mark.

Trigger: on 2026-10-01 the dashboard showed main **−0.70%** while the app showed the book **+1.16%**
— a disagreement on *direction*, caused entirely by the window (SPY sold off −0.66% through 09-30's
afternoon and rallied +0.48% through 10-01's, neither of which the 10:30 sample sees).

Explicitly NOT bought by this change: it does not alter returns, and it does not shorten the
~49 years needed to prove IR=0.28 beats zero at 95%. It also does **not** reduce noise — I assumed
it would and measured the opposite (SPY vol 0.533% on the 10:30 clock vs 0.605% at the close).

## What was added

| File | Role |
|---|---|
| `lib/close-snapshot.ts` | types, ET clock (`etParts`/`isAfterUsEquityClose`), `validateCloseSnapshot`, `computeCloseReturns`, `summarizeCloseReturns` |
| `app/api/close-snapshot/route.ts` | the cron; guards + withhold logic; writes observations only |
| `app/api/close-returns/route.ts` | derives the series on read (nothing persisted) |
| `evals/close-snapshot.test.ts` | 35 tests, wired into `test:unit` (suite is now 30 files / 544 tests as of 2026-10-02) |
| `vercel.json` | **UNCHANGED — no cron was added.** See the CORRECTION at the top; enabling it is a one-line addition, guarded by the config-invariant test |
| `lib/robinhood-balance.ts` | **moved** `fetchAgenticPositions` here from the trade route |
| `app/api/trade/route.ts` | now imports that shared function instead of its local copy |

## The three design decisions worth not re-litigating

1. **It ADDS an observation, it does not move the 10:30 one.** The 10:30 run is the post-trade state
   `/api/verify` reconciles against live Robinhood (autopilot Step 3). Moving it breaks that.

2. **The write path stores observations only — no returns.** Returns derive at read time. A stored
   derived number is a cached judgement that outlives the discovery it was wrong; this repo already
   carries two backfill endpoints (`/api/debug?recomputeSleeves`, `?patchDate`) written to undo
   exactly that. Deriving on read means fixing the formula fixes history for free.

3. **Returns reuse `computeDailyReturn` from `lib/run-store`, not a total-value diff.** That function
   is position-level on purpose (`pnl = ΔpositionValue − tradeNetCash`, residual = `impliedTransfer`),
   so the owner's next **deposit** reads as a transfer rather than a gain. A naive diff would have
   reported +51% on the test case that is really +1%. It also inherits the unpriceable-trade rule
   that returns null rather than silently erasing a stop-out's loss.

## Fail-closed behaviour (the part to not relax)

- `CLOSE_SETTLE_MINUTES = 16:05 ET` — Yahoo's `regularMarketPrice` keeps moving until the
  consolidated close settles, so sampling at 16:00:00 can store the last tick as the close.
- **No `force=1` override on the clock/holiday guards.** An escape hatch is how a mid-session mark
  ends up in a close-to-close series. `dryRun=1` exists for testing and does everything but write.
- **One unpriceable holding withholds the WHOLE snapshot.** `computeDailyReturn`'s `priceOf` falls
  back to `avgCost`, so storing a position without a real close marks it at cost and injects a
  phantom move into the next day's return — the PLTR 2026-07-08 bug (bogus +8%).
- `positions: null` (fetch failed) is **not** treated as `[]` (genuinely flat) — flat would value
  the book at 0 and read as −100%.
- Pairs more than `MAX_PAIR_GAP_DAYS = 10` apart are withheld, so a cron outage cannot compound a
  multi-week move into a "daily" series.
- Idempotent per ET date; duplicate dates collapse rather than emitting a phantom 0% day.

## DST

`10 21 * * 1-5` = 21:10 UTC, which is after the close in **both** halves of the year (17:10 ET under
EDT, 16:10 ET under EST — the close itself is 20:00 UTC in EDT and 21:00 UTC in EST). The handler
re-checks the ET clock via `Intl` with an explicit timeZone rather than trusting the schedule, and
`evals/close-snapshot.test.ts` carries a config-invariant test that reads `vercel.json` and asserts
the scheduled time is post-close in January *and* July.

## Verification already done

- `bun run test:unit` → **497 pass / 0 fail, 27 files** (was 464 / 26)
- `bunx tsc --noEmit` → clean
- `bun run build` → compiled; both new routes present
- **13 mutations applied to every guard, all 13 caught, zero survivors** (UTC-vs-ET date, flipped
  close comparison, buffer moved before the close, disabled unpriced check, null-as-flat, both
  trade-window off-by-ones, removed gap guard, removed dedupe, unpriceable-as-0%, withheld-as-flat,
  unscaled σ band, removed sort)

## ⚠ Reconstruction results below are STALE — regenerate before quoting them

A review on 2026-10-02 found three defects in `scripts/close-reconstruct.ts` that all corrupt the
series these numbers came from, so every figure in this section was produced by the buggy script:

1. Same-date runs were collapsed LAST-WINS, and because `/api/runs` returns raw runs newest-first
   and the sort is stable, the survivor was the OLDEST run — dropping the other run's trades, so an
   intraday sell's proceeds booked as P&L.
2. The main-book loop had NO gap guard, so dates withheld for a missing Sharadar close compounded
   into one oversized "daily" return — inflating `sd(active)` and deflating exactly the Sharpe, IR
   and t reported here. (The 10:30 loop had a related defect: its SPY leg spanned the gap while the
   stored return was a single day.)
3. `repriceAtClose` returned `[]` for a run with no positions snapshot, turning "unknown" into
   "flat" — which reads the prior day's whole equity book as a loss.

All three are fixed. Re-run `bun --env-file=.env.local scripts/close-reconstruct.ts` and replace
this section. The QUALITATIVE conclusion is not expected to change — the comparison has no power at
n≈29 either way, and that argument rests on the standard error, not on the point estimates — but the
specific numbers should not be quoted until regenerated.

## Reconstruction results (2026-10-01, 30 stored dates 08-20 → 10-01) — SUPERSEDED, see above

All 30 dates reconstructed cleanly — Sharadar had closes for all 24 symbols ever held, and zero
dates were withheld. Both clocks, 29 paired days:

| | 10:30 clock | close clock |
|---|---|---|
| cumulative main book | −8.40% | −7.86% |
| cumulative SPY | **−0.78%** | **+0.18%** |
| cumulative ACTIVE (main) | −7.62% | −8.04% |
| daily active vol | 0.86% | 1.08% |
| main Sharpe (ann.) | −5.74 | −3.77 |
| **SPY Sharpe (ann.)** | **−0.76** | **+0.21** |
| main info ratio (ann.) | −5.05 | −4.18 |

Backtest reference (27.7y, close-to-close, production ARY/netinc gate): CAGR +13.70% vs SPY +8.68%,
Sharpe 0.59 vs 0.53, IR 0.30.

**The headline is that this comparison has no power yet.** The standard error on an IR estimated over
n days is ≈√(252/n), so at n=29 it is **±2.95**: the live main-book IR of −4.18 has a 95% interval of
−9.95 … 1.60. That interval contains the backtest's 0.30, so the live data cannot distinguish the
strategy from the backtest — and also cannot distinguish it from zero. Annualised figures like
"Sharpe −3.77" are arithmetic on 29 days, not findings.

How long until the series can decide anything, since the window scales as 1/gap²:

| question | years |
|---|---|
| prove IR=0.30 beats zero | ~43 |
| pin the IR to ±0.10 | ~384 |
| detect the live IR is ≤ −0.5 | ~6.0 |
| detect the live IR is ≤ −1.0 | ~2.3 |
| detect the live IR is ≤ −2.0 | ~0.7 |

So the realistic use of this series is **failure detection, not validation** — a catastrophic
shortfall surfaces in ~1-2 years, while confirming the edge takes decades. Note also that even the
28-year backtest's own IR carries t = 0.30·√27.7 = **1.58**, which is below 1.96: the backtest does
not establish a 95%-significant edge either.

**One concrete reason the clock must always be named:** SPY's annualised Sharpe over the *same 29
days* is **−0.76 on the 10:30 clock and +0.21 on the close clock** — opposite signs. Any absolute
statistic quoted without its clock is meaningless at this sample size.

## Still open

- **Deploy gate not run.** `/code-review` → fix → `bun run check:secrets` → `REVIEWED=1 … deploy --prod`.
- **Not pushed** (needs approval; remote is currently level at `f52e43c`).
- **The series is empty and STAYS empty.** No cron writes it (see the CORRECTION at the top), so
  `/api/close-returns` returns nothing and will keep doing so until the cron is deliberately added.
  This bullet previously said the first snapshot "lands on the next weekday after deploy", which
  contradicted that correction. If the cron is ever enabled, the first *return* needs two
  snapshots, so allow ~2 trading days before the endpoint shows anything.
- **No dashboard surface yet** — the data is only at `/api/close-returns`. Deliberate: worth seeing
  real values before deciding how to present two parallel series without confusing them.
- **Not in the 8am email** or `lib/dashboard-reconcile.ts`. A reconciler check comparing the two
  clocks' cumulative active return would be a natural later addition.
- The existing 10:30 series is untouched and stays authoritative for now.
