import { describe, test, expect } from "bun:test";
import { applySectorBudget, MIN_BUY_DOLLARS } from "@/lib/buy-sizing";

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-SLEEVE SECTOR BUDGET.
//
// 2026-10-14: XLK reached 44.5% of the book — NVDA $356 and AVGO $329 in the
// influencer sleeve, MRVL $386 in the main book — and every XLK dollar was a
// semiconductor. No guard registered a breach, because there wasn't one: the
// only sector control was <=floor(0.4*N) buyable NAMES inside the MAIN
// shortlist, which is a count standing in for a value cap, ignores held
// positions, and cannot see the sleeve. The sleeve picks on a YouTube signal
// with no sector awareness and its own 2 slots, so two individually-compliant
// sleeves stacked one industry past the stated 40% cap.
//
// Direction rule: this gate REFUSES money. Where it cannot establish a budget
// or a sector it must withhold, never wave the batch through.
// ─────────────────────────────────────────────────────────────────────────────
const SECTORS: Record<string, string> = { NVDA: "XLK", AVGO: "XLK", MRVL: "XLK", APA: "XLE", LLY: "XLV" };
const opts = (held: Record<string, number>, totalValue = 1000, capPct = 0.4) => ({
  heldValueBySector: new Map(Object.entries(held)),
  sectorOf: (s: string) => SECTORS[s] ?? null,
  totalValue, capPct,
});
const buy = (symbol: string, dollarAmount: number) => ({ symbol, dollarAmount });

describe("the sector budget counts both sleeves and refuses safely", () => {
  test("a sector already over budget takes no new money, whichever sleeve holds it", () => {
    // The live shape: XLK at 44.5% against a 40% cap.
    const r = applySectorBudget([buy("MRVL", 100)], opts({ XLK: 445 }));
    expect(r.buys).toHaveLength(0);
    expect(r.notes[0]).toContain("XLK is already");
    expect(r.notes[0]).toContain("counting BOTH sleeves");
  });

  test("a TOP-UP is not exempt — a slot cap counts names, this counts dollars", () => {
    // Repeated top-ups are exactly how the largest XLK position got there.
    expect(applySectorBudget([buy("MRVL", 100)], opts({ XLK: 445 })).buys).toHaveLength(0);
  });

  test("a buy that would cross the line is TRIMMED to the remaining headroom", () => {
    const r = applySectorBudget([buy("MRVL", 200)], opts({ XLK: 300 }));   // budget 400, room 100
    expect(r.buys).toHaveLength(1);
    expect(r.buys[0].dollarAmount).toBeCloseTo(100, 2);
    expect(r.notes[0]).toMatch(/trimmed \$200→\$100/);
  });

  test("headroom below the minimum buy is dropped as dust, not sized to a stub", () => {
    const r = applySectorBudget([buy("MRVL", 200)], opts({ XLK: 400 - (MIN_BUY_DOLLARS - 1) }));
    expect(r.buys).toHaveLength(0);
    expect(r.notes[0]).toMatch(/below the \$50 minimum/);
  });

  test("TWO buys in one sector cannot each spend the SAME headroom", () => {
    // The classic batch hole: a per-item check that never accumulates.
    const r = applySectorBudget([buy("MRVL", 300), buy("NVDA", 300)], opts({ XLK: 0 }));
    const spent = r.buys.reduce((a, b) => a + b.dollarAmount, 0);
    expect(spent).toBeCloseTo(400, 2);        // the whole budget, not 600
    expect(r.buys).toHaveLength(2);
    expect(r.buys[1].dollarAmount).toBeCloseTo(100, 2);
  });

  test("an unestablished SECTOR withholds the buy — dropping the check is the fail-open branch", () => {
    const r = applySectorBudget([buy("WXYZ", 100)], opts({}));
    expect(r.buys).toHaveLength(0);
    expect(r.notes[0]).toMatch(/could NOT establish its sector/);
    expect(r.notes[0]).toContain("NOT that WXYZ is over-concentrated");
  });

  test("an unestablished TOTAL VALUE withholds the whole batch", () => {
    for (const total of [0, NaN]) {
      const r = applySectorBudget([buy("MRVL", 100), buy("APA", 100)], opts({}, total));
      expect(r.buys).toHaveLength(0);
      expect(r.notes).toHaveLength(2);
      expect(r.notes[0]).toMatch(/could NOT establish the sector budget/);
    }
  });

  test("CONTROLS: an underweight sector buys normally and is untouched", () => {
    const r = applySectorBudget([buy("APA", 100)], opts({ XLK: 445, XLE: 50 }));
    expect(r.buys).toHaveLength(1);
    expect(r.buys[0].dollarAmount).toBe(100);     // not trimmed
    expect(r.notes).toHaveLength(0);              // and not narrated
    // An empty book buys freely.
    expect(applySectorBudget([buy("LLY", 300)], opts({})).buys).toHaveLength(1);
  });

  test("CONTROL: one sector being full does not block a different one", () => {
    const r = applySectorBudget([buy("MRVL", 100), buy("APA", 100)], opts({ XLK: 445 }));
    expect(r.buys.map(b => b.symbol)).toEqual(["APA"]);
  });
});
