/**
 * Braintrust eval runner — REVIEWER path (the "watcher").
 * The sibling runner (braintrust.eval.ts) scores the WORKER — does the agent decide well. This one
 * scores the WATCHER: it runs the live skeptical-reviewer (lib/autopilot-review.reviewRun) against
 * labeled failure fixtures and logs per-fixture outcomes + recall/specificity to Braintrust, so a
 * regression in the reviewer (e.g. after a prompt tweak) shows up run-over-run on the same dashboard.
 *
 * Usage (makes live LLM calls, so it's opt-in like the test):
 *   EVAL_LLM=1 bun --env-file=.env.local evals/braintrust-reviewer.eval.ts
 *
 * Results appear at https://www.braintrust.dev under project "robinhood-agent".
 */
import Anthropic from "@anthropic-ai/sdk";
import { initExperiment } from "braintrust";
import { FIXTURES, runReviewerRecall, scoreReviewer } from "./reviewer-recall";
import { LLM_EVALS_ENABLED, llmBudgetSummary, resetLlmBudget } from "./llm-budget";

if (!LLM_EVALS_ENABLED) {
  console.error("This runs the reviewer against the fixtures (live LLM calls). Re-run with EVAL_LLM=1.");
  process.exit(1);
}
resetLlmBudget();

const _d = new Date();
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
const EXPERIMENT_NAME = `eval-${TODAY}-reviewer`;

const experiment = await initExperiment("robinhood-agent", {
  apiKey: process.env.BRAINTRUST_API_KEY,
  experiment: EXPERIMENT_NAME,
  update: true,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });

console.log(`Running ${FIXTURES.length} reviewer fixtures → ${EXPERIMENT_NAME}`);
const results = await runReviewerRecall(anthropic, FIXTURES);

for (const r of results) {
  const f = FIXTURES.find((x) => x.id === r.id)!;
  const span = experiment.startSpan({ name: r.id });
  const verdict = r.skipped ? "skipped" : r.kPass === r.kRan ? "pass^k" : r.kPass === 0 ? "fail" : "flaky";
  span.log({
    input: { fixture: r.id, kind: f.shouldFlag ? "should-flag" : "clean", expected: f.expected ?? "stay quiet (no concern)" },
    output: { verdict, kPass: r.kPass, kRan: r.kRan, outcomes: r.outcomes, concerns: r.concernsSample.map((c) => `[${c.severity}] ${c.title}`) },
    scores: {
      // pass^K (consistency): 1 only when the reviewer was right on ALL k runs; null when skipped.
      reviewer_pass_k: r.skipped ? null : r.kPass === r.kRan ? 1 : 0,
      // per-run pass RATE (the lenient "pass@1" view) — the gap to pass^k is the flakiness.
      reviewer_pass_rate: r.skipped ? null : r.kPass / r.kRan,
      // recall vs specificity split out (as per-run rates) so the dashboard can trend each.
      caught_real_problem: f.shouldFlag && !r.skipped ? r.kPass / r.kRan : null,
      quiet_on_clean: !f.shouldFlag && !r.skipped ? r.kPass / r.kRan : null,
    },
    metadata: { shouldFlag: f.shouldFlag, note: f.note, k: r.kRan, error: r.error ?? null },
  });
  span.end();
}

const s = scoreReviewer(results);
const pct = (x: number | null) => (x == null ? "n/a" : Math.round(x * 100) + "%");
console.log(`\npass^${s.K} recall ${pct(s.recallPassK)} (per-run ${pct(s.recallMean)}) · pass^${s.K} specificity ${pct(s.specificityPassK)} (per-run ${pct(s.specificityMean)})${s.flaky.length ? ` · flaky: ${s.flaky.join(", ")}` : ""}`);
console.log(llmBudgetSummary());
await experiment.flush();
console.log(`\nhttps://www.braintrust.dev/app/Yogi's%20Insight/p/robinhood-agent/experiments/${EXPERIMENT_NAME}`);
