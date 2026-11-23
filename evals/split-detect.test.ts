import { describe, expect, test } from "bun:test";
import { isForwardSplit, type PositionSnapshot } from "../lib/run-store";

const p = (symbol: string, quantity: string, avgCost: string) =>
  ({ symbol, quantity, avgCost, price: "1" } as PositionSnapshot);

describe("isForwardSplit", () => {
  test("SNDK 8:1 (real 2026-11-20 data) is a split", () => {
    expect(isForwardSplit([p("SNDK", "0.303610", "810.25")], [p("SNDK", "2.428880", "101.28")], "SNDK")).toBe(true);
  });
  test("a manual top-up (qty rises, basis rises) is NOT a split", () => {
    expect(isForwardSplit([p("MU", "0.1666", "897")], [p("MU", "0.3338", "897")], "MU")).toBe(false);
  });
  test("a small unrecorded fill near a split is NOT absorbed as part of it", () => {
    // 8:1 then the owner sells 0.02 (ratio 7.93) or buys 0.02 (8.07): both must still withhold.
    expect(isForwardSplit([p("SNDK", "0.303610", "810.25")], [p("SNDK", "2.408880", "101.28")], "SNDK")).toBe(false);
    expect(isForwardSplit([p("SNDK", "0.303610", "810.25")], [p("SNDK", "2.448880", "101.28")], "SNDK")).toBe(false);
  });
  test("a large non-whole ratio fails closed (no proportional slack)", () => {
    expect(isForwardSplit([p("X", "1", "5740")], [p("X", "57.4", "100")], "X")).toBe(false);
    expect(isForwardSplit([p("X", "1", "5700")], [p("X", "57", "100")], "X")).toBe(true);
  });
  test("non-integer ratio, missing row, bad input all fail closed", () => {
    expect(isForwardSplit([p("X", "1", "100")], [p("X", "2.5", "40")], "X")).toBe(false);
    expect(isForwardSplit([], [p("X", "2", "50")], "X")).toBe(false);
    expect(isForwardSplit([p("X", "1", "100")], [p("X", "NaN", "50")], "X")).toBe(false);
    expect(isForwardSplit([p("X", "0", "100")], [p("X", "2", "50")], "X")).toBe(false);
  });
});
