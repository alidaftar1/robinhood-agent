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
  span.log({
    input: { fixture: r.id, kind: f.shouldFlag ? "should-flag" : "clean", expected: f.expected ?? "stay quiet (no concern)" },
    output: { outcome: r.outcome, concerns: r.concerns.map((c) => `[${c.severity}] ${c.title}`) },
    scores: {
      // 1 when the reviewer was right (caught a real problem, or stayed quiet on a clean run); null when skipped.
      reviewer_correct: r.outcome === "skipped" ? null : r.outcome === "TP" || r.outcome === "TN" ? 1 : 0,
      // recall vs specificity split out so the dashboard can trend each independently.
      caught_real_problem: f.shouldFlag && r.outcome !== "skipped" ? (r.outcome === "TP" ? 1 : 0) : null,
      quiet_on_clean: !f.shouldFlag && r.outcome !== "skipped" ? (r.outcome === "TN" ? 1 : 0) : null,
    },
    metadata: { shouldFlag: f.shouldFlag, note: f.note, error: r.error ?? null },
  });
  span.end();
}

const s = scoreReviewer(results);
console.log(`\nreviewer recall ${s.recall == null ? "n/a" : Math.round(s.recall * 100) + "%"} (${s.tp}/${s.tp + s.fn}) · specificity ${s.specificity == null ? "n/a" : Math.round(s.specificity * 100) + "%"} (${s.tn}/${s.tn + s.fp})`);
console.log(llmBudgetSummary());
await experiment.flush();
console.log(`\nhttps://www.braintrust.dev/app/Yogi's%20Insight/p/robinhood-agent/experiments/${EXPERIMENT_NAME}`);
