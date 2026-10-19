import { describe, test, expect } from "bun:test";
import { daysPricedIn } from "@/app/dashboard-view";
import { readFileSync } from "node:fs";
import { V1_TRACK_START } from "@/lib/risk-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// A cumulative return that skips days must SAY it skipped days.
//
// The influencer figure compounds 79 of 84 days in its window and the main book
// 85 of 87, because a sleeve return is withheld on any day it cannot be priced
// honestly — the tiny-denominator guard, and (since 2026-10-19) inheriting a
// withheld account return. Both are correct. The number is not wrong; it just
// covers less than a reader assumes when they see one figure and one start date.
//
// Deliberately NOT fixed: counting the withheld stub days would move the
// influencer figure 3.5pp better and the main book 1.9pp worse. That asymmetry
// is what shows this is a convention, not a bug — so the display changes, the
// maths does not.
// ─────────────────────────────────────────────────────────────────────────────
const r = (influencerDailyReturn: number | null) => ({ influencerDailyReturn });

describe("the days-priced badge", () => {
  test("counts only from the first priced day — earlier runs are not 'missing'", () => {
    // The sleeve did not exist yet on those days; they are not holes in its record.
    expect(daysPricedIn([r(null), r(null), r(0.01), r(0.02)], "influencerDailyReturn"))
      .toBeNull();   // 2 of 2 priced once the series starts → complete → silent
  });

  test("a withheld day inside the window IS counted as unpriced", () => {
    expect(daysPricedIn([r(0.01), r(null), r(0.02)], "influencerDailyReturn"))
      .toEqual({ priced: 2, total: 3 });
  });

  test("silent when the window is complete — a '91 of 91' badge is noise", () => {
    // Showing it everywhere trains the eye to skip the line, which defeats the point.
    expect(daysPricedIn([r(0.01), r(0.02), r(0.03)], "influencerDailyReturn")).toBeNull();
  });

  test("silent when the series never started, rather than reporting 0 of 0", () => {
    expect(daysPricedIn([r(null), r(null)], "influencerDailyReturn")).toBeNull();
    expect(daysPricedIn([], "influencerDailyReturn")).toBeNull();
  });

  test("a trailing withheld day still counts — the window ends at the data, not the last value", () => {
    // The influencer series freezes when the sleeve is fully exited; those later days are real
    // days the figure does not cover.
    expect(daysPricedIn([r(0.01), r(0.02), r(null)], "influencerDailyReturn"))
      .toEqual({ priced: 2, total: 3 });
  });

  test("the live shape: 5 withheld days across an 84-day influencer window", () => {
    const window = Array.from({ length: 84 }, (_, i) => r([3, 17, 41, 60, 71].includes(i) ? null : 0.001));
    expect(daysPricedIn(window, "influencerDailyReturn")).toEqual({ priced: 79, total: 84 });
  });

  test("each field is counted independently", () => {
    const runs = [
      { influencerDailyReturn: 0.01, mainDailyReturn: 0.01 },
      { influencerDailyReturn: null, mainDailyReturn: 0.02 },
    ];
    expect(daysPricedIn(runs, "influencerDailyReturn")).toEqual({ priced: 1, total: 2 });
    expect(daysPricedIn(runs, "mainDailyReturn")).toBeNull();   // main is complete → silent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The quality-momentum card measured from V1_TRACK_START while every label said
// 2026-07-09 — a two-day gap, hardcoded in five places. The constant is the
// right anchor (the tooltip's own rationale, "once the book was fully rebuilt
// after T+1 settlement", describes 07-11, not the switch date), so the labels
// were what was wrong. Measured from 07-09 instead, the card would read
// -0.56% / SPY +3.38% / vs S&P -3.95% rather than -0.96% / +2.10% / -3.06%.
//
// Fifth instance this week of a literal duplicating a value that lives
// elsewhere, so pin it rather than fix it and move on.
// ─────────────────────────────────────────────────────────────────────────────
describe("the quality-momentum card cannot drift from the window it measures", () => {
  const src = readFileSync(`${import.meta.dir}/../app/dashboard-view.tsx`, "utf8");

  test("the measurement window is stated from the CONSTANT, never a literal", () => {
    expect(src).toContain("`measured from ${V1_TRACK_START}`");
    expect(src).toMatch(/measured from \$\{V1_TRACK_START\}\)/);          // the vs-S&P tooltip
    expect(src).toMatch(/measured from \$\{V1_TRACK_START\}\./);          // the days-beat tooltip
  });

  test("no label claims the card is measured from the SWITCH date", () => {
    // The switch (2026-07-09) and the measurement anchor are different dates and must read that
    // way. The banner may still name the switch; nothing may say the measurement starts there.
    expect(src).not.toMatch(/since strategy update · 2026-07-09/);
    expect(src).not.toMatch(/since the 2026-07-09 switch/);
    expect(src).not.toMatch(/since it took over on 2026-07-09/);
  });

  test("the switch date and the anchor are genuinely different — the gap is real", () => {
    expect(V1_TRACK_START).toBe("2026-07-11");
    expect(V1_TRACK_START > "2026-07-09").toBe(true);
  });
});
