import { describe, test, expect } from "bun:test";
import { scorePick } from "@/lib/signal-ledger";

// 2026-11-23: SNDK bought 11-16 at $810.25, 8:1 split 11-20, scored at $87.71 as −89.2%.
describe("signal ledger: stored split factor", () => {
  test("SNDK with splitFactor 8 scores ≈ −13%, not −89%", () => {
    expect(scorePick({ priceAtBuy: 810.2499, splitFactor: 8 }, 87.71)!).toBeCloseTo(-13.4, 1);
  });
  test("CONTROL: no factor scores raw", () => {
    expect(scorePick({ priceAtBuy: 100 }, 110)!).toBeCloseTo(10, 6);
  });
  test("a bad stored factor is unmeasurable, never silently 1", () => {
    for (const f of [0, -2, NaN, Infinity]) expect(scorePick({ priceAtBuy: 810.25, splitFactor: f }, 87.71)).toBeNull();
  });
  test("a 1:10 REVERSE split (factor 0.1) is not read as +900%", () => {
    expect(scorePick({ priceAtBuy: 5, splitFactor: 0.1 }, 52)!).toBeCloseTo(4, 6);
  });
  test("wiring: suspect splits reach the email", () => {
    const src = require("node:fs").readFileSync(`${import.meta.dir}/../app/api/autopilot/route.ts`, "utf8");
    expect(src).toContain("a.picks.filter((p) => p.suspectSplit)");
    expect(src).toContain("${suspectSplits.join(\", \")}");
  });
});
