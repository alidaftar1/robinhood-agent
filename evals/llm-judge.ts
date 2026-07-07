import Anthropic from "@anthropic-ai/sdk";
import { reserveLlmCall, recordLlmUsage, JUDGE_MODEL, JUDGE_MAX_TOKENS } from "./llm-budget";

// LLM-as-judge: a single-prompt binary evaluator (the pattern the industry standardized on).
// Returns true/false, or NULL when the token budget refused the call (disabled or over the cap) —
// so callers degrade gracefully instead of forcing spend. We don't trust the judge blind: the
// harness measures its true-positive / true-negative rate against the deterministic ground truth,
// which is how you tell a judge is reliable enough to use on the subjective modes.
export async function llmJudge(question: string, context: string): Promise<boolean | null> {
  if (!reserveLlmCall()) return null;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const resp = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    system: "You are a strict evaluator. Answer the yes/no question about the DATA with EXACTLY one word: YES or NO. No explanation.",
    messages: [{ role: "user", content: `${question}\n\nDATA:\n${context}` }],
  });
  recordLlmUsage(resp.usage);
  const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").toUpperCase();
  // Take the FIRST YES/NO token, not "contains YES" — otherwise a verbose "NO, though yes there's a
  // beta mention" would score as a match and silently inflate recall (the metric this harness reports).
  const m = txt.match(/\b(YES|NO)\b/);
  return m ? m[1] === "YES" : false; // ambiguous / no verdict → treat as not-caught (conservative)
}
