import { describe, expect, test } from "bun:test";
import { STOCK_SECTOR } from "../lib/market-data";
import { SP500_UNIVERSE } from "../lib/strategy";

// TWO lists describe the same universe and nothing kept them in step. Regenerating STOCK_SECTOR
// alone (2026-10-04) left SP500_UNIVERSE 119 names short and carrying 65 dead ones, which silently
// made every added name second-class:
//   · lib/analyst.ts filters analyst ratings to SP500_UNIVERSE  -> no ↑FIRM signal
//   · lib/earnings-release.ts filters to it                     -> no earnings-release signal
//   · lib/dashboard-reconcile.ts uses it to tell S&P from not   -> AVGO, held in the influencer
//     sleeve, was not recognised as an S&P name, so that check misfired
// They cannot be derived from one another (market-data imports strategy, so it would be circular),
// so this test is the guard.
describe("the two universe lists agree", () => {
  const sector = new Set(Object.keys(STOCK_SECTOR));
  const universe = new Set(SP500_UNIVERSE);

  test("SP500_UNIVERSE contains every STOCK_SECTOR symbol", () => {
    const missing = [...sector].filter(t => !universe.has(t)).sort();
    expect(missing, `in STOCK_SECTOR but not SP500_UNIVERSE: ${missing.join(" ")}`).toEqual([]);
  });

  test("SP500_UNIVERSE carries nothing STOCK_SECTOR has dropped", () => {
    const extra = [...universe].filter(t => !sector.has(t)).sort();
    expect(extra, `in SP500_UNIVERSE but not STOCK_SECTOR: ${extra.join(" ")}`).toEqual([]);
  });

  test("both are non-trivially sized — an empty list would pass the set checks vacuously", () => {
    expect(sector.size).toBeGreaterThan(400);
    expect(universe.size).toBeGreaterThan(400);
  });

  test("SP500_UNIVERSE has no duplicates", () => {
    expect(SP500_UNIVERSE.length).toBe(universe.size);
  });
});
