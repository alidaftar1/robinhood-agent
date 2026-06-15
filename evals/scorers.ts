/**
 * LLM-as-judge scorers for evals that require model-graded assessment.
 * These are async and produce a 0–1 score with a rationale string.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { InsiderBuy } from "@/lib/market-data";
import type { ToolCall } from "./agent";

export interface LLMScore {
  name: string;
  score: number; // 0–1
  rationale: string;
}

/**
 * Scores whether the agent acknowledged and reasoned about the ★INS signal.
 *
 * Returns 1.0 immediately when no insider buys are in the scenario — N/A case.
 *
 * Rubric:
 *   1.0 — explicitly mentions insider buying, explains why it did/didn't act on it
 *   0.7 — mentions insider buying and factored it into the decision, even briefly
 *   0.3 — traded the ★INS stock but never mentioned the signal in reasoning
 *   0.0 — completely ignored the signal with no mention
 */
export async function scoreInsiderAwareness(
  summary: string,
  insiderBuys: Record<string, InsiderBuy[]>,
  toolCalls: ToolCall[]
): Promise<LLMScore> {
  const insiderSymbols = Object.keys(insiderBuys).filter((s) => (insiderBuys[s]?.length ?? 0) > 0);

  if (insiderSymbols.length === 0) {
    return { name: "insider_signal_awareness", score: 1, rationale: "No insider buys in scenario — N/A" };
  }

  // Prefer MCP tool calls; fall back to parsing TRADE_DECISION from analysis-session output.
  let boughtInsider: (string | unknown)[];
  if (toolCalls.length > 0) {
    const orders = toolCalls.filter((c) => c.tool === "place_equity_order");
    boughtInsider = orders
      .filter((o) => o.input.side === "buy" && insiderSymbols.includes(String(o.input.symbol ?? "")))
      .map((o) => o.input.symbol);
  } else {
    const match = summary.match(/^TRADE_DECISION:(.+)$/m);
    if (match) {
      try {
        const d = JSON.parse(match[1]) as { buys?: Array<{ symbol: string }> };
        boughtInsider = (d.buys ?? []).map((b) => b.symbol).filter((s) => insiderSymbols.includes(s));
      } catch { boughtInsider = []; }
    } else { boughtInsider = []; }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are evaluating an AI trading agent's ability to use a specific market signal.

Context: The agent's market data included ★INS (insider buying) flags for: ${insiderSymbols.join(", ")}.
These represent recent open-market purchases by company officers or directors — a strong conviction signal.

Agent bought these ★INS stocks: ${boughtInsider.length > 0 ? boughtInsider.join(", ") : "none"}.

Agent's reasoning summary:
---
${summary.slice(0, 1200)}
---

Score the agent's insider signal awareness from 0 to 1 using this rubric:
1.0 — explicitly mentions insider buying, explains its decision (buy or skip) with reference to the signal
0.7 — mentions insider buying and factors it in, even if briefly
0.3 — traded the ★INS stock correctly but never mentioned the signal
0.0 — completely ignored the ★INS signal with no mention in reasoning

Respond with JSON only, no other text: {"score": <number 0-1>, "rationale": "<one sentence>"}`;

  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in judge response");
    const parsed = JSON.parse(match[0]) as { score: number; rationale: string };

    return {
      name: "insider_signal_awareness",
      score: Math.max(0, Math.min(1, parsed.score)),
      rationale: parsed.rationale,
    };
  } catch (err) {
    return {
      name: "insider_signal_awareness",
      score: 0,
      rationale: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
