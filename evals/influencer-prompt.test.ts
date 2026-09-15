import { describe, expect, test } from "bun:test";
import {
  formatInfluencerSignals,
  isInfluencerDowntrend,
  MOMENTUM_FLOOR_PCT,
  DIST_FROM_HIGH_FLOOR,
} from "../lib/influencer-signals";

// 2026-09-15: three qualifying influencer picks were skipped as "failing the ⛔DOWNTREND screen"
// when none was tagged — the model re-derived the rule from the explanatory text and mis-stated the
// bar as ">8% below recent high", conflating the 5-day threshold with the distance-from-high one.
// The screen itself was correct; the prompt let the two numbers be collapsed.

const cache = {
  refreshedAt: "2026-09-16",
  signals: [{ tickers: ["CELH"], channelName: "Meet Kevin", confidence: "high" }],
  tickerCounts: { CELH: 6 },
  avoidCounts: {},
} as any;

const render = (m: { change5d: number; distFromHigh: number; aboveShortMA: boolean }) =>
  formatInfluencerSignals(
    cache,
    new Map([["CELH", 27.78]]),
    new Map([["CELH", { change1d: -1, ...m }]]) as any,
  );

const section = render({ change5d: -6, distFromHigh: -12, aboveShortMA: false });

describe("downtrend screen prompt", () => {
  test("states the TAG is the rule, not the numbers", () => {
    expect(section).toContain("THE ⛔DOWNTREND TAG IS THE RULE");
    expect(section).toMatch(/do NOT re-derive the screen from the numbers/i);
    expect(section).toMatch(/without ⛔DOWNTREND has PASSED the screen and is buyable/i);
  });

  test("renders the two thresholds against their OWN metric, from the constants", () => {
    // Drift guard: if a constant changes, the prompt must change with it.
    expect(section).toContain(`5-DAY CHANGE (the row's "5d:")  →  tagged only if worse than -${Math.abs(MOMENTUM_FLOOR_PCT)}%`);
    expect(section).toContain(`DISTANCE FROM RECENT HIGH (the row's "hi:")  →  tagged only if worse than -${Math.abs(DIST_FROM_HIGH_FLOOR)}%`);
    // The two numbers must be distinct, or they can be conflated again.
    expect(Math.abs(MOMENTUM_FLOOR_PCT)).not.toBe(Math.abs(DIST_FROM_HIGH_FLOOR));
  });

  test("its worked example is TRUE — the screen really does allow it", () => {
    expect(section).toContain('a pick at "5d:-6% hi:-12%" clears BOTH bars and is buyable');
    expect(isInfluencerDowntrend({ change1d: -1, change5d: -6, distFromHigh: -12, aboveShortMA: false } as any)).toBe(false);
    // And the row the model actually reads carries no tag.
    const row = section.split("\n").find(l => l.includes("CELH"))!;
    expect(row).not.toContain("⛔DOWNTREND");
  });

  test("a genuine breach IS tagged on the row", () => {
    const breached = render({ change5d: -9, distFromHigh: -12, aboveShortMA: false });
    const row = breached.split("\n").find(l => l.includes("CELH"))!;
    expect(row).toContain("⛔DOWNTREND");
    expect(isInfluencerDowntrend({ change1d: -1, change5d: -9, distFromHigh: -12, aboveShortMA: false } as any)).toBe(true);
  });

  test("the mis-stated bar the model invented is explicitly contradicted", () => {
    // -12% off the high must NOT read as a rejection anywhere in the section.
    expect(section).toMatch(/neither -6% nor -12% is a rejection/i);
  });
});
