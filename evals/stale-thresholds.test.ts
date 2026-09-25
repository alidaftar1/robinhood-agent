import { describe, test, expect } from "bun:test";
import {
  buildV1AnalysisPrompt, staleReasonOf,
  INFLUENCER_STALE_DAYS, INFLUENCER_STALE_RETURN_PCT,
  INFLUENCER_ZOMBIE_DAYS, INFLUENCER_ZOMBIE_RETURN_PCT,
  STALE_DAYS, STALE_RETURN_PCT,
} from "@/lib/strategy";

// The influencer time-stop was a single +8%-at-10-days bar until 2026-09-25. That evicted winners
// mid-consolidation (+8% in 10 trading days is ~a 600% annualised pace). Dropping the bar to 0
// fixed that and opened the opposite hole: at +0.1% a name flips back to "do not sell here", so
// the whole [0%, +40%) band became unrotatable in a 2-slot sleeve. Two clocks express both shapes.
describe("influencer staleness has two clocks, and each catches a different failure", () => {
  test("FAST clock: down after ~2 weeks is stale", () => {
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, -3)).toBe("down");
  });

  test("SLOW clock: up but going nowhere after ~5 weeks is stale", () => {
    expect(staleReasonOf(true, INFLUENCER_ZOMBIE_DAYS, 1)).toBe("nomove");
    // The zombie this tier exists for: permanently un-exitable under a bare 0 bar.
    expect(staleReasonOf(true, 200, 0.1)).toBe("nomove");
  });

  test("THE POINT: a winner mid-consolidation is left alone", () => {
    // CAKE's real case (+2.4% at day 10) and a genuine +7% — both forced rotates under the old bar.
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, 2.4)).toBeNull();
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, 7)).toBeNull();
    expect(staleReasonOf(true, INFLUENCER_ZOMBIE_DAYS - 1, 7)).toBeNull();
  });

  test("the dead-band stops daily flip-flop around the entry price", () => {
    // A bare sign test sits exactly where "going nowhere" names cluster, so -0.2% Monday would
    // force a rotate and +0.2% Tuesday would say do-not-sell.
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, -0.2)).toBeNull();
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, -0.6)).toBe("down");
  });

  test("the clocks gate: a fresh loser is not yet stale", () => {
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS - 1, -5)).toBeNull();
  });

  test("missing price or age never asserts staleness", () => {
    expect(staleReasonOf(true, null, -5)).toBeNull();
    expect(staleReasonOf(true, INFLUENCER_STALE_DAYS, null)).toBeNull();
    expect(staleReasonOf(true, undefined, undefined)).toBeNull();
  });

  test("the MAIN book keeps its own single clock and is not swept along", () => {
    expect(staleReasonOf(false, STALE_DAYS, 1)).toBe("nomove");
    expect(staleReasonOf(false, STALE_DAYS, 4)).toBeNull();
    expect(staleReasonOf(false, INFLUENCER_ZOMBIE_DAYS, -10)).toBeNull();   // main clock is 60d
    expect(STALE_DAYS).toBe(60);
    expect(STALE_RETURN_PCT).toBe(3);
  });

  test("the constants are what the prompt and the reviewer both read", () => {
    expect(INFLUENCER_STALE_DAYS).toBe(10);
    expect(INFLUENCER_STALE_RETURN_PCT).toBe(-0.5);
    expect(INFLUENCER_ZOMBIE_DAYS).toBe(25);
    expect(INFLUENCER_ZOMBIE_RETURN_PCT).toBe(8);
  });
});

describe("the rendered position line tells the model WHICH clock fired", () => {
  const pos = (heldDays: number, avgCost: number, price: number) =>
    ({ symbol: "TEST", quantity: "10", avgCost: String(avgCost), heldDays, price });

  const lineFor = (heldDays: number, avgCost: number, price: number) => {
    const prompt = buildV1AnalysisPrompt(
      "2026-09-25", "", { cash: 1000, positions: [pos(heldDays, avgCost, price)] } as never,
      undefined, undefined, ["TEST"],
    );
    const line = prompt.split("\n").find(l => l.includes("TEST ×"));
    // NOT `?? ""` — a missing line would silently satisfy every .not.toContain assertion below,
    // which is exactly the vacuity this file exists to avoid.
    if (!line) throw new Error("position line not rendered — fixture or prompt shape changed");
    return line;
  };

  test("a broken name reads 'down' and loses its do-not-sell protection", () => {
    const line = lineFor(INFLUENCER_STALE_DAYS, 100, 96);
    expect(line).toContain("⏳STALE");
    expect(line).toContain("— down");
    expect(line).toContain("NOT protected → ROTATE");
  });

  test("a zombie reads 'no move', not 'down' — it never lost money, it just never worked", () => {
    const line = lineFor(INFLUENCER_ZOMBIE_DAYS, 100, 101);
    expect(line).toContain("⏳STALE");
    expect(line).toContain("— no move");
    expect(line).not.toContain("— down");
  });

  test("a consolidating winner keeps its protection", () => {
    const line = lineFor(INFLUENCER_STALE_DAYS, 100, 107);
    expect(line).not.toContain("⏳STALE");
    expect(line).toContain("do not sell here");
  });
});
