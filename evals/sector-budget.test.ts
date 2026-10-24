import { describe, test, expect } from "bun:test";
import { applySectorBudget, MIN_BUY_DOLLARS } from "@/lib/buy-sizing";
import { sectorBudgetFraction, sectorMaxNames, sectorCapSummary, sectorSoftTrimPct, SPY_SECTOR_WEIGHTS, SECTOR_DISPLAY_NAMES } from "@/lib/sector-cap";
import { maxPositionDollars } from "@/lib/strategy";
import { formatSectorExposure } from "@/lib/risk-metrics";
import { buildV1Shortlist, STOCK_SECTOR, SECTOR_ETFS, type StockData } from "@/lib/market-data";

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
  // Mechanics are tested against a FLAT cap here; the per-sector 3x-S&P rule is tested below.
  totalValue, capPctOf: () => capPct,
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

// ─────────────────────────────────────────────────────────────────────────────
// 3x-S&P SECTOR CAP (lib/sector-cap), adopted 2026-10-23 from scripts/sector-cap-backtest.ts.
// 2026-10-23 is the worked case: Energy — 3.7% of the S&P 500 — reached 40% of this book (44% of
// the invested part) with APA, TRGP and a VLO buy the flat 40% cap trimmed but allowed.
// ─────────────────────────────────────────────────────────────────────────────
describe("each sector is capped at 3x its S&P weight, in names and in dollars", () => {
  test("at 7 names: Tech 4, Financials/Health Care 2, everything else 1; unknown is strictest", () => {
    expect(sectorMaxNames("XLK", 7)).toBe(4);   // 3 x 37.6% x 7 = 7.9 -> the 4-name bound
    expect(sectorMaxNames("XLF", 7)).toBe(2);
    expect(sectorMaxNames("XLV", 7)).toBe(2);
    expect(sectorMaxNames("XLE", 7)).toBe(1);   // 3 x 3.7% x 7 = 0.8 -> min 1
    expect(sectorMaxNames("XLU", 7)).toBe(1);
    expect(sectorMaxNames("?", 7)).toBe(1);     // missing from the table: never uncapped
    expect(sectorBudgetFraction("XLE", 7)).toBeCloseTo(0.2);   // 1 name = 1 full position
    expect(sectorBudgetFraction("XLK", 7)).toBeCloseTo(0.8);
  });

  test("every sector code the stock map uses has a weight — none silently falls to the 1-name minimum", () => {
    const codes = new Set([...Object.values(STOCK_SECTOR), ...Object.keys(SECTOR_ETFS)]);
    expect([...codes].filter(c => !(c in SPY_SECTOR_WEIGHTS))).toEqual([]);
    expect(Object.keys(SPY_SECTOR_WEIGHTS).sort()).toEqual(Object.keys(SECTOR_ETFS).sort());
  });

  test("the weight table covers all 11 GICS sectors and sums to ~100%", () => {
    const w = Object.values(SPY_SECTOR_WEIGHTS);
    expect(w.length).toBe(11);
    expect(w.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.99);
    expect(w.reduce((a, b) => a + b, 0)).toBeLessThan(1.01);
  });

  test("the 2026-10-23 VLO buy: Energy already at 40% takes NO new money under the new cap", () => {
    // Live numbers: APA $309 + TRGP $285 = $594 Energy held, $2,364.51 total. Old cap: trimmed to $351.
    const r = applySectorBudget([buy("APA", 472)], {
      heldValueBySector: new Map([["XLE", 594]]), sectorOf: () => "XLE",
      totalValue: 2364.51, capPctOf: (sec) => sectorBudgetFraction(sec, 7),
    });
    expect(r.buys).toEqual([]);
    expect(r.notes[0]).toContain("DROPPED");
    expect(r.notes[0]).toContain("20% cap");
  });

  test("CONTROL: Tech, the big sector, now has MORE room than the old flat 40%", () => {
    const r = applySectorBudget([buy("NVDA", 300)], {
      heldValueBySector: new Map([["XLK", 1000]]), sectorOf: () => "XLK",   // 42% held, over the old cap
      totalValue: 2364.51, capPctOf: (sec) => sectorBudgetFraction(sec, 7),
    });
    expect(r.buys).toEqual([buy("NVDA", 300)]);
  });

  test("a full-size buy ALWAYS fits a 1-name sector's budget — no rounding false-trims (sweep)", () => {
    // The review's catch: budget = total x (maxPos/total) could land 1 ulp under maxPos (~2% of
    // totals), logging a "trimmed $414→$414" that never happened. A fixed fraction can't.
    for (let t = 2000; t <= 10000; t += 0.07) {
      const maxPos = maxPositionDollars(`$${t.toFixed(2)}`);
      const r = applySectorBudget([buy("XOM", maxPos)], {
        heldValueBySector: new Map(), sectorOf: () => "XLE", totalValue: Number(t.toFixed(2)),
        capPctOf: (sec) => sectorBudgetFraction(sec, 7),
      });
      if (r.notes.length) throw new Error(`total ${t.toFixed(2)}: ${r.notes[0]}`);
    }
  });

  test("the budget does NOT loosen on a small account (no $400-floor inheritance)", () => {
    // At $1,600 maxPositionDollars hits its $400 floor (25%); the sector budget must stay 20%/name.
    expect(sectorBudgetFraction("XLK", 7)).toBeCloseTo(0.8);
    expect(sectorBudgetFraction("XLE", 7)).toBeCloseTo(0.2);
  });

  test("display names match the SECTOR EXPOSURE block's, so one prompt never names a sector twice", () => {
    expect(SECTOR_DISPLAY_NAMES).toEqual(SECTOR_ETFS);
  });

  test("a 1-name sector's single allowed name can be bought at FULL position size", () => {
    // The review's catch: a names/N budget (14% at N=7) sat under the 20% position cap and trimmed
    // every such buy. One name = one full position.
    const r = applySectorBudget([buy("LLY", 472.9)], {
      heldValueBySector: new Map(), sectorOf: () => "XLI",
      totalValue: 2364.51, capPctOf: (sec) => sectorBudgetFraction(sec, 7),
    });
    expect(r.buys).toEqual([buy("LLY", 472.9)]);
    expect(r.notes).toEqual([]);
  });

  test.each([NaN, Infinity, 0, -0.2])("a per-sector cap of %p is WITHHELD, never waved through", (cap) => {
    const r = applySectorBudget([buy("NVDA", 100)], {
      heldValueBySector: new Map(), sectorOf: () => "XLK", totalValue: 1000, capPctOf: () => cap,
    });
    expect(r.buys).toEqual([]);
    expect(r.notes[0]).toContain("could NOT establish the sector budget");
  });

  test("the SELL nudge stays 40% everywhere except where the buy budget is higher (Tech)", () => {
    expect(sectorSoftTrimPct("XLE", 7)).toBe(40);   // never LOWERED by the tighter buy cap
    expect(sectorSoftTrimPct("XLV", 7)).toBe(40);
    expect(sectorSoftTrimPct("XLK", 7)).toBeCloseTo(80);
    const slices = [
      { etf: "XLK", name: "Technology", value: 500, pct: 50 },
      { etf: "XLE", name: "Energy", value: 440, pct: 44 },
    ];
    const out = formatSectorExposure(slices, (etf) => sectorSoftTrimPct(etf, 7));
    expect(out).not.toContain("OVER");   // Tech is the largest and within its 80% buy budget
    // Largest-sector-only, as before: a non-largest sector over 40% gets NO new nudge.
    // Energy as the LARGEST sector keeps the unchanged 40% line.
    const energyTop = formatSectorExposure([{ etf: "XLE", name: "Energy", value: 440, pct: 44 }, { etf: "XLV", name: "Health Care", value: 300, pct: 30 }],
      (etf) => sectorSoftTrimPct(etf, 7));
    expect(energyTop).toContain("44% in Energy — OVER the 40% soft cap");
    // Default (no per-sector fn) is the unchanged flat 40%.
    expect(formatSectorExposure(slices)).toContain("50% in Technology — OVER the 40% soft cap");
  });

  test("the shortlist and the dollar budget read the SAME rule", () => {
    // 6 energy names with the strongest momentum: only ONE may reach the buyable shortlist.
    const mk = (symbol: string, mom: number) => ({ symbol, price: 100, mom12_1: mom } as unknown as StockData);
    const stocks = [mk("XOM", 90), mk("CVX", 80), mk("COP", 70), mk("EOG", 60), mk("NVDA", 50), mk("AAPL", 40), mk("MSFT", 30), mk("AVGO", 20), mk("ORCL", 10)];
    const { buy: list } = buildV1Shortlist(stocks, new Set(stocks.map(s => s.symbol)), { N: 7 });
    const syms = list.map(s => s.symbol);
    expect(syms.filter(s => ["XOM", "CVX", "COP", "EOG"].includes(s))).toEqual(["XOM"]);
    expect(syms.filter(s => ["NVDA", "AAPL", "MSFT", "AVGO", "ORCL"].includes(s)).length).toBe(sectorMaxNames("XLK", 7));
  });

  test("the prompt line is generated from the rule", () => {
    expect(sectorCapSummary(7)).toBe("Technology ≤4 names (4 full positions); Financials, Health Care ≤2 names (2 full positions); every other sector ≤1 name (1 full position)");
  });
});
