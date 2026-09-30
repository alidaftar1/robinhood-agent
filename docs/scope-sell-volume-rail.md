# Scope — a code rail on sell volume

**Status:** SCOPED, NOT BUILT. Two decisions needed before anything ships.
**Date:** 2026-09-30
**Changes what the agent trades — owner sign-off required.**

---

## The evidence

2026-09-29, measured against the live book shape (12 held, $2.44 settled buying power, several
names underwater, rebalance day). Four runs of the production model per prompt wording:

| Wording | Runs proposing sells |
|---|---|
| Count note pointing at "the free-a-slot judgment" | **2 of 4** — one proposed **11 sells**, one proposed 5 |
| Reworded to point at buying fewer, larger names | 0 of 4 |

Run 1 was the entire main book. Under T+1 the paired buys cannot settle the same day and die on
the $50 floor, so that decision liquidates the account into cash, realises every loss, and buys
nothing.

The wording is fixed. **The rail question is separate and survives it:** one sentence of prompt
text was all that stood between that decision and execution.

## Why nothing stopped it

Sells are filtered for exactly one thing — is the name held:

```
for (const s of decision.sells) {
  const pos = positions.find(p => p.symbol === s.symbol);
  if (!pos) continue;                 // not held -> drop
  sellsToExecute.push(...)            // otherwise EXECUTE
}
```

Compare the buy side, which passes through six independent guards: the off-rails shortlist filter,
the weekly rebalance gate, the influencer slot cap, `applyPerPositionCap`,
`fitNotionalBuysToBudget`, and the $50 floor. **Buys are guarded six ways; sells are guarded once,
and only against a typo.**

That asymmetry is understandable — a sell reduces exposure, so it reads as the safe direction. It
is not, when the sell is unintended: it realises losses, strands capital in cash under T+1, and on
a non-rebalance day cannot be reversed for days.

## The fact that makes a rail safe

**Mechanical risk exits do not pass through `decision.sells`.**

`/api/drop-check` builds its own `sellsToExecute` from `classifyExit` (−5% main same-day, −10%
influencer from buy, +40% take-profit) and runs six times a day on its own cron. It is code-decided
end to end and would be completely unaffected by a cap here.

So a rail on the model's sell list bounds *judgment* sells — loss discipline, news, rotation,
time-stop — while leaving the automatic stop-loss path untouched. This is the crux: without it, a
cap would risk blocking real risk management during a sell-off, which would be far worse than the
problem it solves.

Supporting: the strategy has **no cash or hedge action** by design (the regime signal is
deliberately advisory-only). De-risking is reactive, via serial stop-outs on the drop-check path. A
mass exit to cash is therefore *out-of-model behaviour*, not a strategy state the rail would be
overriding.

## The hard part

Sells carry no structured reason. The schema is `{symbol, exit|fraction, strategy}` — the
justification lives in free-text thesis prose. So code cannot read intent directly.

But it can **verify the claim independently**, because every legitimate judgment-sell reason is
already computable from data the run has:

| Reason | Code-visible? | From |
|---|---|---|
| >10% below entry (loss discipline) | yes | `avgCost` vs `price` |
| ⏳STALE (time-stop) | yes | `staleReasonOf(heldDays, ret)` |
| Fell off the shortlist | yes | not in `v1ShortlistSet` ∪ retained |
| Bearish ⚡NEWS↓ / ↓FIRM downgrade | yes | `newsSignals`, `analystRatings` |
| Imminent earnings | yes | `earningsDatesMap` |
| **Rotation / "free a slot"** | **no** | pure judgment |

So the rail does not need to guess. It can classify each sell as **independently justified** or
**discretionary**, and bound only the second.

## Options

### A. Cap discretionary exits per run (recommended)
Any sell whose name satisfies a code-visible risk condition passes unconditionally. Sells that
satisfy none are discretionary and capped at N per run; the excess is dropped, recorded, and
alerted. Directly targets the observed failure and cannot block a genuine risk exit.

### B. Cap total book value exited per run
Simpler to reason about ("no more than X% of main-book value may leave in one decision"), but it
*can* block legitimate risk exits in a bad week, when several names breach loss discipline at once.

### C. Alert-only, no block
Execute everything, alert loudly above a threshold. Zero chance of blocking a good exit, and zero
protection — the 11-sell decision would still have executed, with an email afterwards.

### D. Require a paired buy for rotation sells
Elegant but wrong here: under T+1 a same-day pair is impossible by construction, which is exactly
why the rebalance window is two days (sell day 1, redeploy day 2).

## Open decisions

1. **The cap number.** With a ~6-name target, 2 or 3 discretionary exits per run is a normal
   rotation; 5+ is a restructuring. I lean 3.
2. **Full exits only, or trims too?** A 50% trim is not a liquidation, and `applyConcentrationTrim`
   already issues partial sells in code. I lean counting full exits only, so the rail cannot
   interfere with trimming.

## What the rail must not become

- It must not block the drop-check path (it cannot — different route).
- It must not silently drop a sell. The influencer cap's lesson applies directly: every drop needs
  a recorded note, because the autopilot's decided-vs-executed reconciliation treats an absent trade
  *without* a note as an unexplained anomaly and escalates — a guard doing its job would look like a
  bug.
- It must fail **open** on its own error. A rail that throws and blocks all sells is worse than no
  rail; if classification fails, let the sell through and log it.

## Recommendation

Option A, cap 3, full exits only, with notes and an alert. Build it before exposing day-1-vs-day-2
consolidation to the prompt — that change is the same shape of nudge as the one measured proposing
eleven sells, and the rail should exist first rather than after.

Worth stating plainly: the rail addresses a **tail** risk. It is not a fix for the −5.90% alpha, and
shipping it should not be mistaken for one.
