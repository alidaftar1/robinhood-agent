/**
 * The analysis token cap. Reasoning comes before TRADE_DECISION, so a truncated analysis loses the
 * decision and the run places nothing (2026-11-10: LLY trim + SNDK buy lost at max_tokens 3000).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const route = readFileSync(join(import.meta.dir, "..", "app", "api", "trade", "route.ts"), "utf8");
const agent = readFileSync(join(import.meta.dir, "agent.ts"), "utf8");

describe("analysis max_tokens", () => {
  const cap = Number(route.match(/const ANALYSIS_MAX_TOKENS = (\d+);/)?.[1]);
  // Floor: 3000 truncated a real run. Ceiling: at ~45 tok/s the output must finish inside the 150s kill.
  it("is above the 3000 that truncated 2026-11-10 and below what the 150s analysis kill allows", () => {
    expect(cap).toBeGreaterThanOrEqual(4500);
    expect(cap).toBeLessThanOrEqual(5000);
    expect(route).toContain("setTimeout(() => analysisController.abort(), 150_000)");
  });
  it("both the live and dry-run analysis calls use it (no stray literal cap)", () => {
    expect(route.match(/max_tokens: ANALYSIS_MAX_TOKENS,/g)?.length).toBe(2);
    expect(route).not.toMatch(/model: "claude-sonnet-4-6",\s*max_tokens: \d+/);
  });
  it("the eval harness grades the same cap", () => expect(agent).toContain(`max_tokens: ${cap},`));
});
