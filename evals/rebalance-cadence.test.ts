import { describe, expect, test } from "bun:test";
import { isMainRebalanceDay, STALE_DAYS, INFLUENCER_STALE_DAYS } from "@/lib/strategy";
import { isMarketHoliday, holidayTableCovers } from "@/lib/holidays";

const noHolidays = () => false;
// 2026-09-21 is a Monday; 09-22 Tue ... 09-25 Fri; 09-26 Sat, 09-27 Sun.
describe("weekly main-book rebalance day", () => {
  test("Monday and Tuesday are the window in a normal week", () => {
    expect(isMainRebalanceDay("2026-09-21", noHolidays)).toBe(true);
    expect(isMainRebalanceDay("2026-09-22", noHolidays)).toBe(true);
  });

  test("Wed/Thu/Fri are closed to main-book buys", () => {
    for (const d of ["2026-09-23", "2026-09-24", "2026-09-25"]) {
      expect(isMainRebalanceDay(d, noHolidays)).toBe(false);
    }
  });

  test("weekends are never rebalance days", () => {
    expect(isMainRebalanceDay("2026-09-26", noHolidays)).toBe(false);
    expect(isMainRebalanceDay("2026-09-27", noHolidays)).toBe(false);
  });

  test("a Monday HOLIDAY shifts the window to Tue+Wed — the week is not skipped", () => {
    const mondayClosed = (d: string) => d === "2026-09-21";
    expect(isMainRebalanceDay("2026-09-21", mondayClosed)).toBe(false);
    expect(isMainRebalanceDay("2026-09-22", mondayClosed)).toBe(true);
    expect(isMainRebalanceDay("2026-09-23", mondayClosed)).toBe(true);
    expect(isMainRebalanceDay("2026-09-24", mondayClosed)).toBe(false);
  });

  test("Mon+Tue closed shifts the window to Wed+Thu", () => {
    const closed = (d: string) => d === "2026-09-21" || d === "2026-09-22";
    expect(isMainRebalanceDay("2026-09-23", closed)).toBe(true);
    expect(isMainRebalanceDay("2026-09-24", closed)).toBe(true);
    expect(isMainRebalanceDay("2026-09-25", closed)).toBe(false);
  });

  test("ONE failed Monday still leaves a buy window — the week is never lost", () => {
    // The reason the window is two days: a single-day window meant one failed cron gave the week
    // ZERO main-book buy opportunities, silently, with the time-stop suspended the whole time.
    expect(isMainRebalanceDay("2026-09-22", noHolidays)).toBe(true);
  });

  test("EXACTLY TWO rebalance days per week, every week of the year", () => {
    // Never zero (the book could never buy) and never more than two (daily churn returns).
    const start = Date.parse("2026-01-05T00:00:00Z");   // a Monday
    for (let w = 0; w < 52; w++) {
      let count = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(start + (w * 7 + i) * 86400000).toISOString().slice(0, 10);
        if (isMainRebalanceDay(d, noHolidays)) count++;
      }
      expect(count).toBe(2);
    }
  });
});

describe("stale clock matches the signal horizon", () => {
  test("the main-book clock is months, not weeks", () => {
    // 12-1 momentum is a months-horizon signal; the old 15-day clock evicted positions long before
    // the thesis had a chance to work (17 round-trips, 13.9-day average hold, 18% winners).
    expect(STALE_DAYS).toBe(60);
    expect(STALE_DAYS).toBeGreaterThanOrEqual(40);
  });

  test("the influencer sleeve keeps its own SHORTER clock", () => {
    // The sleeve chases fast moves with 2 scarce slots — it must not inherit the main book's patience.
    expect(INFLUENCER_STALE_DAYS).toBeLessThan(STALE_DAYS);
  });
});

describe("against the REAL holiday calendar", () => {
  test("exactly two rebalance days per week across 2026-2027", () => {
    // The previous property test used a no-holidays stub, so it only proved weekday arithmetic —
    // it could not catch a holiday interaction, which is the case that actually skips a week.
    const start = Date.parse("2026-01-05T00:00:00Z");   // a Monday
    for (let w = 0; w < 104; w++) {
      let count = 0;
      const days: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start + (w * 7 + i) * 86400000).toISOString().slice(0, 10);
        days.push(d);
        if (isMainRebalanceDay(d, isMarketHoliday)) count++;
      }
      expect({ week: days[0], count }).toEqual({ week: days[0], count: 2 });
    }
  });

  test("no rebalance day is ever itself a market holiday", () => {
    const start = Date.parse("2026-01-05T00:00:00Z");
    for (let i = 0; i < 730; i++) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      if (isMainRebalanceDay(d, isMarketHoliday)) expect(isMarketHoliday(d)).toBe(false);
    }
  });

  test("a fully-closed week yields NO rebalance day rather than picking a closed session", () => {
    const allClosed = () => true;
    for (const d of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]) {
      expect(isMainRebalanceDay(d, allClosed)).toBe(false);
    }
  });

  test("the holiday table still covers the years the rebalance relies on", () => {
    // A lapsed table silently points the rebalance at a closed Monday and skips the week.
    // Dynamic, not hardcoded years: a fixed 2026/2027 assertion would keep passing forever after
    // the table lapses, which is exactly when the rebalance window starts landing on closed days.
    const now = new Date();
    const y = now.getUTCFullYear();
    expect({ year: y, covered: holidayTableCovers(y) }).toEqual({ year: y, covered: true });
    // Next year only matters from mid-December, when a Mon-Fri window can span the boundary —
    // matching the route check. Asserting it year-round would keep the suite red for ~11 months.
    if (now.getUTCMonth() === 11 && now.getUTCDate() >= 15) {
      expect({ year: y + 1, covered: holidayTableCovers(y + 1) }).toEqual({ year: y + 1, covered: true });
    }
  });
});

describe("malformed dates cannot disable the reviewer", () => {
  test("an unparseable date returns false instead of throwing", () => {
    // isMainRebalanceDay is now called on EVERY stored run record by lib/autopilot-review. An
    // unparseable date used to reach toISOString() and throw RangeError inside buildUserPrompt,
    // silently disabling the entire skeptical-reviewer pass for that day.
    for (const bad of ["", "not-a-date", "2026-13-45", "20260921"]) {
      expect(() => isMainRebalanceDay(bad, () => false)).not.toThrow();
      expect(isMainRebalanceDay(bad, () => false)).toBe(false);
    }
  });
});

import { buildV1AnalysisPrompt } from "@/lib/strategy";

// The off-cycle regression recurred THREE times because it lives in a ~2,000-char template literal
// that no test read, and each fix was verified by grepping a phrase rather than the rendered output.
// These assertions read the actual prompt both ways.
describe("the rendered prompt honours the rebalance window", () => {
  const ctx = { buyingPower: "$100", totalValue: "$2400", positions: [] } as any;
  const render = (isRebalanceDay: boolean) =>
    buildV1AnalysisPrompt("2026-09-23", "(table)", ctx, "", "", [], [], [], {},
      new Map(), new Map(), new Map(), {}, {}, [], "", "", isRebalanceDay);
  const off = render(false);
  const on = render(true);

  test("off-cycle does NOT offer slot-freeing as a valid sell reason", () => {
    expect(off).not.toContain("or you need to free a slot for a clearly higher-conviction NEW name");
    expect(on).toContain("or you need to free a slot for a clearly higher-conviction NEW name");
  });

  test("off-cycle does NOT invite main-book buys", () => {
    expect(off).not.toContain("pick up to 6 MAIN-book names");
    expect(on).toContain("pick up to 6 MAIN-book names");
  });

  test("off-cycle does NOT ask the thesis which shortlist names are being bought", () => {
    expect(off).not.toContain("which shortlist names you're buying");
    expect(on).toContain("which shortlist names you're buying");
  });

  test("off-cycle carries the closure block; on-cycle does not", () => {
    expect(off).toContain("MAIN-BOOK BUYS ARE CLOSED TODAY");
    expect(on).not.toContain("MAIN-BOOK BUYS ARE CLOSED TODAY");
  });

  test("the override is positioned BEFORE every rule it suspends", () => {
    // It previously rendered ~11KB BELOW the MUST-rotate time-stop, so a model reading in order
    // acted on the rule long before reaching its suspension — and sells are not code-gated.
    const block = off.indexOf("NOT THE WEEKLY REBALANCE DAY");
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(off.indexOf("STRATEGY — QUALITY-MOMENTUM"));
    expect(block).toBeLessThan(off.indexOf("DEFAULT IS ROTATE"));
  });

  test("risk sells are still explicitly permitted off-cycle", () => {
    // The block must not read as "do nothing" — loss discipline must never wait for the window.
    expect(off).toContain("SELLS remain available for RISK ONLY");
    expect(off).toMatch(/loss discipline/i);
  });
});
