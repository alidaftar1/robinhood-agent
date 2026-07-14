# Reviewer-recall: evaluating the watcher, not the worker

Most evals check the **worker** — does the agent make good decisions on curated scenarios (the
Braintrust scenario suite does this). This one checks the **watcher**: the agent has a live LLM
*reviewer* (`lib/autopilot-review.ts` — a Sonnet pass that audits each morning's run and emails the
owner), and an untested reviewer is just an assumption. This harness runs the **actual production
reviewer** against real labeled runs and measures how good it is.

## What it does

Runs `reviewRun` (unchanged production code) against real runs where a known problem existed:

- **Recall / TPR** — of the runs that really contained a problem, how many did the reviewer flag?
- **Specificity** — on a clean run, does it stay quiet instead of manufacturing a false concern?

**Consistency — `pass^K`.** The reviewer is stochastic, so a single run is luck, not capability. Each
fixture is run **K times** (default K=5, `REVIEWER_RECALL_K`) and scored two ways: **`pass^K`** (did it
get it right on *all* K runs — the strict, consistency bar) and the **per-run rate** (the lenient
`pass@1`-style average). The gap between them is *flakiness* a single run hides — a fixture caught 3/5
is reported as **FLAKY**, not a pass. Only a `pass^K` (K/K) fixture is "held." A fixture that can't be
funded for all K runs is **skipped**, never scored on a partial K.

The reviewer emits free-text concerns, so deciding "did it catch mode X" is itself a judgment — an
**LLM-as-judge** (`llm-judge.ts`) grades each concern set against the labeled expectation. Every LLM
call — reviewer and judge — goes through a **token budget** (`llm-budget.ts`): opt-in (`EVAL_LLM=1`),
hard-capped, cheap judge, spend logged. A full k=5 sweep is ~45 calls, so raise `EVAL_LLM_MAX_CALLS`.

## The fixtures (real incidents, hand-labeled)

| Fixture | Real incident | Should flag? |
|---|---|---|
| `sleeve-return-artifact` | phantom −12.7% influencer sleeve return while the account was flat | ✅ (currently a **blind spot** — see below) |
| `regime-beta-mismatch` | book β 0.03 on a risk-on day (target ~1.0–1.3) | ✅ |
| `sector-vs-thesis` | book ~57% tech while the thesis claimed ~37% | ✅ |
| `stranded-decided-buy` | decided TSLA buy didn't execute; ~$408 left idle | ✅ |
| `clean-run-control` | a healthy, diversified, internally-consistent run | ❌ (specificity) |

## Latest run (illustrative — stochastic, not a CI-asserted number; here budget-capped to k=2)

```
  fixture                  kind         k-pass  verdict  reviewer concern(s)
  sleeve-return-artifact   should-flag  0/2     FAIL     (blind spot — see below)
  regime-beta-mismatch     should-flag  2/2     pass^2
  sector-vs-thesis         should-flag  —       SKIP
  stranded-decided-buy     should-flag  —       SKIP
  clean-run-control        clean        —       SKIP
  pass^2 RECALL (caught EVERY run): 50%   ·   per-run recall: 50%
  (3 fixture(s) skipped for budget — a full k=2 sweep needs ~18 calls: set EVAL_LLM_MAX_CALLS)
```

`pass^K` here confirmed the sleeve-return blind spot is *consistent* (0/2, not a one-run fluke) and the
regime-mismatch catch is *reliable* (2/2) — the distinction a single run couldn't make.

## What the harness surfaced — and the judgment call it forced

The value isn't the 75%. It's what the gap turned out to be:

1. **The reviewer is blind to sleeve-return artifacts** because it's never fed the per-sleeve
   (main/influencer) returns — a blind spot invisible from reading its output. The harness found it.
2. **The obvious fix — feed the sleeve returns to the reviewer — would backfire.** A code-review pass
   caught that the account return and the sleeve returns use *different denominators* (account =
   total value **including cash**; sleeves = **invested equity only**), so on a cash-heavy day the
   account return legitimately sits *below* both sleeves. The reviewer, told to catch "numbers that
   don't add up," would then file **false "returns don't reconcile" alarms in the live daily email**.
3. **So the fix was not shipped.** This artifact class is already prevented at the source (the
   sleeve-return computation + its backfill), so the reviewer's blind spot to it is *documented and
   accepted* rather than closed with a change that cries wolf on ordinary days.

That is the loop doing real work: the eval found a gap, the candidate fix was measured *and rejected
for a concrete reason*, and the decision is recorded — closer to what production eval work actually
looks like than a clean 100%. (A related lesson: getting the fixtures to isolate exactly one signal
is itself part of the job — the reviewer correctly flagged early fixtures' own inconsistencies, e.g.
equity ≠ Σ(positions), before they were tightened.)

## Tracked in Braintrust

`bun run eval:braintrust:reviewer` logs each fixture as a span (recall and specificity split out) to
the same Braintrust project as the worker evals, so the reviewer's recall trends run-over-run — a
regression after a reviewer-prompt change shows up on the dashboard instead of only in console output.

## Run it

```bash
bun --env-file=.env.local test evals/reviewer-recall.test.ts                                  # integrity only, free
EVAL_LLM=1 bun --env-file=.env.local test evals/reviewer-recall.test.ts                        # live reviewer (defaults k=5 — raise the cap)
EVAL_LLM=1 EVAL_LLM_MAX_CALLS=50 bun --env-file=.env.local test evals/reviewer-recall.test.ts  # full k=5 pass^K sweep
EVAL_LLM=1 REVIEWER_RECALL_K=3 EVAL_LLM_MAX_CALLS=30 bun --env-file=.env.local test evals/reviewer-recall.test.ts  # cheaper k=3
bun run eval:braintrust:reviewer                                                               # + logs pass^k to Braintrust
```

## Honest limitations

- **Small N (5 fixtures)** → still a directional gauge, not a precise metric. `pass^K` now measures the
  reviewer's *stochasticity* directly (K runs per fixture), so consistency is no longer guessed from one
  run — but the fixture count is small. The test deliberately does not hard-assert recall (it would flake).
- **The judge is an LLM** — grading free-text concerns is fallible; the crisp `expected` strings keep
  it tight, and it takes the first YES/NO token to avoid a verbose reply inflating recall.
- **Token metering** counts *calls* for both reviewer and judge, but *tokens* only for the judge
  (Haiku); the reviewer's Sonnet call is capped-and-counted as a call but not token-tallied.
- **Fixtures are reconstructed** from real incidents (real numbers/tickers), not captured production JSON.
