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
  test("non-integer ratio, missing row, bad input all fail closed", () => {
    expect(isForwardSplit([p("X", "1", "100")], [p("X", "2.5", "40")], "X")).toBe(false);
    expect(isForwardSplit([], [p("X", "2", "50")], "X")).toBe(false);
    expect(isForwardSplit([p("X", "1", "100")], [p("X", "NaN", "50")], "X")).toBe(false);
    expect(isForwardSplit([p("X", "0", "100")], [p("X", "2", "50")], "X")).toBe(false);
  });
});
