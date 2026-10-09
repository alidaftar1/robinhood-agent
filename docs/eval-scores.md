# Eval scores over time

## The bar: a change must clear the noise floor

A measurement that moves on its own cannot tell you whether an edit helped. Before accepting any
eval or model change, check the delta against the floor for that suite — the same rule
`lib/slippage.ts` already applies to execution cost (`significant: |mean| > 1.96 * se`), which is
why slippage prints "noise" instead of a number it cannot distinguish from zero.

| suite | floor (single run) | measured | rule |
|---|---|---|---|
| `test:fast` (908 tests) | **±0.00** | 2026-10-09, 3 identical runs, all 0 failures | deterministic — any difference is real |
| registry replay (20 cases) | **±0** | deterministic by construction | 14/20 → 15/20 is a real gain |
| LLM suite (190 checks) | **≈±2.6** | 3 identical runs gave 3 / 3 / 1 failures | a 1–2 test move is NOT a result |

Re-measure with `bun run eval:noise --suite fast --runs 3`. The floor is a property of the suite as
it stands, not a constant — it moves when tests are added or a model changes, and a *non-zero*
floor on `test:fast` would mean a flaky test is sitting in the gate that blocks deploys.

Two bounds, and conflating them is the classic error: judge a SINGLE run against the spread of
individual runs (1.96·sd); judge the MEAN of K runs against the standard error (1.96·se), which
shrinks with K. Using se where sd belongs declares victory on noise.


Appended by `bun scripts/registry-replay.ts --record`. Each row is the
share of documented incidents the suite still catches. A fall means a control
lost its test; a rise means one gained a test. Misses are named so the trend is
readable without opening a run.

| date | score | pct | not caught |
|---|---|---|---|
| 2026-10-09 | 14/20 | 70% | whipsaw-rebuy, cap-never-trims, budget-fit-order, shifted-spy-bar-beta, cost-basis-priced-holdings, earnings-record-invisible |
| 2026-10-09 | 14/20 | 70% | whipsaw-rebuy, cap-never-trims, budget-fit-order, shifted-spy-bar-beta, cost-basis-priced-holdings, earnings-record-invisible | (first CI run — reproduced the local score exactly) |
