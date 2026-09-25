import { describe, test, expect } from "bun:test";
import {
  buildV1AnalysisPrompt, INFLUENCER_STALE_DAYS, INFLUENCER_STALE_RETURN_PCT,
  STALE_DAYS, STALE_RETURN_PCT,
} from "@/lib/strategy";

// The influencer time-stop's return bar was +8% until 2026-09-25. That was incoherent with the
// sleeve's own geometry: +8% inside 10 trading days is ~a 600% annualised pace, so with a −10% stop
// and a +40% take-profit it force-rotated an 18-point band — a name up a real +7% after two weeks
// counted as "dead weight". At 0 the rule means what dead money actually means: held two weeks and
// underwater. These pin the semantics, since the threshold is read by the prompt AND by the
// skeptical reviewer's daily checks, which previously hardcoded it.
const pos = (symbol: string, heldDays: number, avgCost: number, price: number) =>
  ({ symbol, quantity: "10", avgCost: String(avgCost), heldDays, price });

// The POSITION LINE only. The word ⏳STALE also appears in the strategy RULES of every prompt, so
// scanning the whole string matches unconditionally — an assertion that can never fail.
const positionLine = (heldDays: number, avgCost: number, price: number, influencer = true) => {
  const prompt = buildV1AnalysisPrompt(
    "2026-09-25", "", { cash: 1000, positions: [pos("TEST", heldDays, avgCost, price)] } as never,
    undefined, undefined, influencer ? ["TEST"] : [],
  );
  return prompt.split("\n").find(l => l.includes("TEST ×")) ?? "";
};

describe("influencer time-stop fires on UNDERWATER, not on 'not up enough'", () => {
  test("a name UP after the clock is NOT stale — the whole point of the loosening", () => {
    // CAKE's real case: +2.4% at day 10. Under the old +8% bar this was a forced rotate.
    expect(positionLine(INFLUENCER_STALE_DAYS, 100, 102.4)).not.toContain("⏳STALE");
    // And the case that motivated it: a genuine winner mid-consolidation.
    expect(positionLine(INFLUENCER_STALE_DAYS, 100, 107)).not.toContain("⏳STALE");
  });

  test("a name DOWN after the clock IS stale", () => {
    const line = positionLine(INFLUENCER_STALE_DAYS, 100, 97);
    expect(line).toContain("⏳STALE");
    expect(line).toContain("down");       // not "flat" — the tag must describe what it shows
  });

  test("the clock still gates it — a fresh loser is not stale", () => {
    expect(positionLine(INFLUENCER_STALE_DAYS - 1, 100, 97)).not.toContain("⏳STALE");
  });

  test("the constants are what the prompt and the reviewer both read", () => {
    expect(INFLUENCER_STALE_RETURN_PCT).toBe(0);
    expect(INFLUENCER_STALE_DAYS).toBe(10);
    // The main book is deliberately different and must not be swept along.
    expect(STALE_RETURN_PCT).toBe(3);
    expect(STALE_DAYS).toBe(60);
  });

  test("the prompt phrases a 0 bar as DOWN, not as 'up less than +0%'", () => {
    const prompt = buildV1AnalysisPrompt(
      "2026-09-25", "", { cash: 1000, positions: [pos("TEST", INFLUENCER_STALE_DAYS, 100, 97)] } as never,
      undefined, undefined, ["TEST"],
    );
    expect(prompt).toContain("still DOWN since entry");
    expect(prompt).not.toContain("up less than +0%");
  });
});
