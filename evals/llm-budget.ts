// ── Token-usage guardrail for LLM-calling evals ──────────────────────────────
// Deterministic evals run free and always. Anything that calls an LLM (the LLM-as-judge in the
// failure-taxonomy harness, scenario tests) goes through this budget so a test run can never
// quietly burn tokens:
//   1. OPT-IN — LLM evals are SKIPPED unless EVAL_LLM=1. Default `bun test` makes zero LLM calls.
//   2. HARD CAP — at most MAX_LLM_CALLS calls per run (EVAL_LLM_MAX_CALLS, default 12); over the
//      cap, requests are refused, not silently truncated.
//   3. CHEAP MODEL + SMALL OUTPUT — Haiku, JUDGE_MAX_TOKENS output, so each call is a few $0.000x.
//   4. VISIBLE — every call is counted and the estimated spend is printed at the end.

export const LLM_EVALS_ENABLED = process.env.EVAL_LLM === "1";
export const MAX_LLM_CALLS = Math.max(0, Number(process.env.EVAL_LLM_MAX_CALLS ?? 12) || 0);
export const JUDGE_MODEL = "claude-haiku-4-5-20251001";
export const JUDGE_MAX_TOKENS = 256;

let callsUsed = 0;
let inputTokens = 0;
let outputTokens = 0;

// Reserve one call against the budget. Returns false when disabled or over the cap — callers
// MUST honor a false and skip the call, so the cap is real, not advisory.
export function reserveLlmCall(): boolean {
  if (!LLM_EVALS_ENABLED) return false;
  if (callsUsed >= MAX_LLM_CALLS) return false;
  callsUsed++;
  return true;
}

// Will `n` more calls fit under the cap? Lets a multi-call unit (e.g. reviewer-run + judge-grade)
// check up front so it never spends the first call and then gets refused the second — which would
// drop the item from the metric denominator and skew the reported number.
export function llmBudgetCanAfford(n: number): boolean {
  return LLM_EVALS_ENABLED && callsUsed + n <= MAX_LLM_CALLS;
}

// Reset the process-wide counter — call in a suite's beforeAll so multiple LLM-consuming eval files
// in one `bun test` process don't drain each other's budget (order-dependent flakiness otherwise).
export function resetLlmBudget(): void {
  callsUsed = 0; inputTokens = 0; outputTokens = 0;
}

export function recordLlmUsage(usage?: { input_tokens?: number; output_tokens?: number } | null): void {
  inputTokens += usage?.input_tokens ?? 0;
  outputTokens += usage?.output_tokens ?? 0;
}

export function llmBudgetStatus(): { enabled: boolean; calls: number; cap: number; inputTokens: number; outputTokens: number } {
  return { enabled: LLM_EVALS_ENABLED, calls: callsUsed, cap: MAX_LLM_CALLS, inputTokens, outputTokens };
}

// One-line human summary for the end of a test run.
export function llmBudgetSummary(): string {
  if (!LLM_EVALS_ENABLED) return "LLM evals: SKIPPED (set EVAL_LLM=1 to enable; deterministic evals ran free).";
  const total = inputTokens + outputTokens;
  return `LLM evals: ${callsUsed}/${MAX_LLM_CALLS} calls used · ~${total.toLocaleString()} tokens (${inputTokens} in / ${outputTokens} out) on ${JUDGE_MODEL}.`;
}
