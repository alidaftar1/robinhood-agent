import { describe, test, expect } from "bun:test";
import { mainBuysOpen, isMainRebalanceDay, OFF_WINDOW_MIN_CASH, SPY_SELLOFF_PCT } from "@/lib/strategy";

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-21, owner's request: Wed-Fri the main book also opens when idle
// SETTLED cash clears the floor — UNLESS the market is risk-off.
//
// The cadence rule exists to stop re-deciding a months-horizon signal every
// morning, not to strand capital: on 2026-10-13 $174.68 (7.2% of equity) sat
// idle through a full open window while the model kept proposing buys the cap
// then dropped.
//
// DIRECTION RULE. This gate OPENS a window that was shut, so every input it
// cannot establish must keep it shut. Refusing an extra window costs a deferred
// buy; opening one into a downtrend buys a falling knife with money the weekly
// cadence would have held anyway. The controls matter more than the openings.
// ─────────────────────────────────────────────────────────────────────────────
const noHoliday = () => false;
const WED = "2026-10-21";              // mid-week, outside the window
const MON = "2026-10-19";              // first trading day of that week
const risky = { settledCash: 500, regimeRiskOn: true, spyChange1d: 0.4 };

describe("main-book buys: the weekly window, plus an idle-cash exception", () => {
  test("the weekly window is unconditional — cash and regime cannot close it", () => {
    expect(isMainRebalanceDay(MON, noHoliday)).toBe(true);
    // Risk-off, a steep selloff and no cash at all: still open, because a scheduled rebalance in a
    // downtrend is still a rebalance. This must not quietly tighten.
    const r = mainBuysOpen({ date: MON, isHoliday: noHoliday, settledCash: 0, regimeRiskOn: false, spyChange1d: -3 });
    expect(r.open).toBe(true);
    expect(r.reason).toMatch(/weekly rebalance window/);
  });

  test("off-window WITH idle cash and a risk-on market: OPEN", () => {
    const r = mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky });
    expect(r.open).toBe(true);
    expect(r.reason).toMatch(/\$500\.00 settled cash is idle and the market is risk-on/);
  });

  test("off-window below the cash floor: closed, and the floor is inclusive", () => {
    for (const cash of [0, 50, OFF_WINDOW_MIN_CASH]) {
      const r = mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky, settledCash: cash });
      expect(r.open).toBe(false);
      expect(r.reason).toMatch(/at or below the \$100 floor/);
    }
    expect(mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky, settledCash: OFF_WINDOW_MIN_CASH + 0.01 }).open).toBe(true);
  });

  test("RISK-OFF closes it however much cash is idle", () => {
    const r = mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky, settledCash: 5000, regimeRiskOn: false });
    expect(r.open).toBe(false);
    expect(r.reason).toMatch(/RISK-OFF/);
  });

  test("a steep selloff closes it even in a risk-on trend — regime is the trend, this is the day", () => {
    const r = mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky, spyChange1d: SPY_SELLOFF_PCT - 0.1 });
    expect(r.open).toBe(false);
    expect(r.reason).toMatch(/selloff floor/);
    // A mild down day is NOT a selloff — the floor is a threshold, not a sign test.
    expect(mainBuysOpen({ date: WED, isHoliday: noHoliday, ...risky, spyChange1d: -0.3 }).open).toBe(true);
  });

  test("FAILS CLOSED on every unestablished input", () => {
    const cases: Array<[string, Parameters<typeof mainBuysOpen>[0]]> = [
      ["cash",   { date: WED, isHoliday: noHoliday, ...risky, settledCash: null }],
      ["regime", { date: WED, isHoliday: noHoliday, ...risky, regimeRiskOn: null }],
      ["spy",    { date: WED, isHoliday: noHoliday, ...risky, spyChange1d: null }],
    ];
    for (const [what, args] of cases) {
      const r = mainBuysOpen(args);
      expect(r.open).toBe(false);
      expect(r.reason).toMatch(/could not be established/);
      expect(what).toBeTruthy();
    }
  });

  test("the reason always says WHY, so a closed day is never unexplained", () => {
    // "an unknown condition" shipped to the owner once already (registry #40). Every branch names
    // the input that decided it.
    for (const args of [
      { date: WED, isHoliday: noHoliday, ...risky, settledCash: 10 },
      { date: WED, isHoliday: noHoliday, ...risky, regimeRiskOn: false },
      { date: WED, isHoliday: noHoliday, ...risky, spyChange1d: -5 },
      { date: WED, isHoliday: noHoliday, ...risky },
      { date: MON, isHoliday: noHoliday, ...risky },
    ]) {
      const r = mainBuysOpen(args);
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.reason).not.toMatch(/unknown condition/);
    }
  });

  test("a holiday-shifted week still gets its window, and the exception is separate", () => {
    // Monday holiday → the window moves to Tue+Wed. That Wednesday is open on the CALENDAR, so it
    // must not depend on cash or regime.
    const mondayOff = (d: string) => d === "2026-10-19";
    const r = mainBuysOpen({ date: "2026-10-21", isHoliday: mondayOff, settledCash: 0, regimeRiskOn: false, spyChange1d: -4 });
    expect(r.open).toBe(true);
    expect(r.reason).toMatch(/weekly rebalance window/);
  });
});

// ── the reviewer must read the DECISION, not recompute the calendar ──────────
import { readFileSync } from "node:fs";
describe("the recorded decision is what downstream reads", () => {
  test("the run stores mainBuysOpen, so the reviewer never recomputes it from the date alone", () => {
    // Since 2026-10-21 "were buys open?" is not a function of the date: it also depends on settled
    // cash and the market regime, neither of which is in a stored run. A calendar-only answer would
    // tell the reviewer the book was SHUT on a day it bought, and it would file concerns about the
    // buys it then saw.
    const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    expect(route).toContain("mainBuysOpen: buysOpen,");

    const review = readFileSync(`${import.meta.dir}/../lib/autopilot-review.ts`, "utf8");
    expect(review).toContain("function buysOpenFor(r: TradeRun)");
    expect(review).toMatch(/if \(typeof r\.mainBuysOpen === "boolean"\) return r\.mainBuysOpen;/);
    // No call site may go straight to the calendar any more.
    expect(review).not.toMatch(/compactRun\([^)]*isMainRebalanceDay\(/);
  });

  test("the trade route gates on the live decision, not the calendar value", () => {
    const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    // isRebalanceDay survives ONLY for the dry-run path, which runs before any live data exists.
    for (const gate of ["const flagBuys = buysOpen ?", "if (!buysOpen) {", "const railMax = buysOpen"]) {
      expect(route).toContain(gate);
    }
    expect(route).not.toMatch(/const flagBuys = isRebalanceDay \?/);
  });
});
