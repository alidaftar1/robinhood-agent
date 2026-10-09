import { describe, it, expect, beforeAll } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { FIXTURES, runReviewerRecall, scoreReviewer, renderReviewerScoreboard } from "./reviewer-recall";
import { LLM_EVALS_ENABLED, llmBudgetSummary, resetLlmBudget } from "./llm-budget";

beforeAll(resetLlmBudget); // don't inherit budget spent by another LLM eval in the same `bun test` process

// See evals/reviewer-recall.md. This evaluates the WATCHER — the live Sonnet skeptical-reviewer —
// by running it against real labeled runs and measuring recall (real problems caught) + specificity
// (clean runs left quiet). Token-gated: default `bun test` makes ZERO LLM calls and only checks
// fixture integrity; set EVAL_LLM=1 to actually run the reviewer.

describe("reviewer-recall: fixture integrity (no tokens)", () => {
  it("every should-flag fixture has a gradeable expectation, and there is a clean control", () => {
    for (const f of FIXTURES) {
      expect(typeof f.run.date).toBe("string");
      if (f.shouldFlag) expect(f.expected && f.expected.length > 0).toBe(true);
    }
    expect(FIXTURES.some((f) => !f.shouldFlag)).toBe(true);   // a clean control exists (specificity)
    expect(FIXTURES.filter((f) => f.shouldFlag).length).toBeGreaterThanOrEqual(3);
  });
});

describe("reviewer-recall: live reviewer evaluation (token-gated)", () => {
  it("runs the real reviewer over the fixtures and reports recall/specificity", async () => {
    if (!LLM_EVALS_ENABLED) {
      console.log("\n" + llmBudgetSummary() + "\n");
      return; // opt-in only — nothing to assert without the reviewer calls
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
    const results = await runReviewerRecall(anthropic);
    console.log("\nREVIEWER RECALL (live Sonnet skeptical-reviewer vs real labeled runs):\n" + renderReviewerScoreboard(results) + "\n" + llmBudgetSummary() + "\n");

    const scored = results.filter((r) => !r.skipped);
    expect(scored.length).toBeGreaterThan(0); // the harness actually exercised the reviewer
    // We MEASURE the reviewer; we do NOT hard-assert a specific recall/specificity — the reviewer is
    // stochastic and N is tiny, so an equality assertion would flake in CI. Just surface a drop.
    const clean = results.find((r) => !r.shouldFlag && !r.skipped);
    if (clean && clean.kPass < clean.kRan) console.warn(`[reviewer-recall] clean control drew a concern on ${clean.kRan - clean.kPass}/${clean.kRan} run(s) — specificity < 100% (stochastic; watch if it persists).`);
  // 30 MINUTES, and the number is load-bearing. The harness makes FIXTURES x REVIEWER_RECALL_K
  // live reviewer calls plus a judge call each — 9 x 5 = ~90 round-trips today. 120s could never
  // have covered that, and a per-test timeout silently overrides the CLI --timeout, so the
  // workflow's 180s had no effect either.
  //
  // It went unnoticed because the test is token-gated: with EVAL_LLM unset it returns early in
  // microseconds, which is every local run and every CI run until the scheduled workflow added
  // 2026-10-08 set EVAL_LLM=1 for the first time. The harness measuring the WATCHER had itself
  // never completed a single run. Scale this with REVIEWER_RECALL_K rather than trimming
  // fixtures — K is what makes pass@K meaningful against a stochastic reviewer.
  }, 1_800_000);
});
