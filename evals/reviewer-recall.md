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

The reviewer emits free-text concerns, so deciding "did it catch mode X" is itself a judgment — an
**LLM-as-judge** (`llm-judge.ts`) grades each concern set against the labeled expectation. Every LLM
call — reviewer and judge — goes through a **token budget** (`llm-budget.ts`): opt-in (`EVAL_LLM=1`),
hard-capped, cheap judge, spend logged.

## The fixtures (real incidents, hand-labeled)

| Fixture | Real incident | Should flag? |
|---|---|---|
| `sleeve-return-artifact` | phantom −12.7% influencer sleeve return while the account was flat | ✅ (currently a **blind spot** — see below) |
| `regime-beta-mismatch` | book β 0.03 on a risk-on day (target ~1.0–1.3) | ✅ |
| `sector-vs-thesis` | book ~57% tech while the thesis claimed ~37% | ✅ |
| `stranded-decided-buy` | decided TSLA buy didn't execute; ~$408 left idle | ✅ |
| `clean-run-control` | a healthy, diversified, internally-consistent run | ❌ (specificity) |

## Latest run (illustrative — the reviewer is stochastic; this is not a CI-asserted number)

```
reviewer recall 75% (3/4) · specificity 100% (1/1)
  sleeve-return-artifact   FN   (blind spot — see below)
  regime-beta-mismatch     TP
  sector-vs-thesis         TP
  stranded-decided-buy     TP
  clean-run-control        TN
```

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
bun --env-file=.env.local test evals/reviewer-recall.test.ts            # integrity only, free
EVAL_LLM=1 bun --env-file=.env.local test evals/reviewer-recall.test.ts # runs the live reviewer
bun run eval:braintrust:reviewer                                        # + logs to Braintrust
```

## Honest limitations

- **Small N (5 fixtures), stochastic reviewer** → a directional gauge, not a precise metric. The test
  deliberately does not hard-assert recall (it would flake); the numbers above are one representative run.
- **The judge is an LLM** — grading free-text concerns is fallible; the crisp `expected` strings keep
  it tight, and it takes the first YES/NO token to avoid a verbose reply inflating recall.
- **Token metering** counts *calls* for both reviewer and judge, but *tokens* only for the judge
  (Haiku); the reviewer's Sonnet call is capped-and-counted as a call but not token-tallied.
- **Fixtures are reconstructed** from real incidents (real numbers/tickers), not captured production JSON.
