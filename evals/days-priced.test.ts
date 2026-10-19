import { describe, test, expect } from "bun:test";
import { daysPricedIn } from "@/app/dashboard-view";

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
