import { describe, expect, test } from "bun:test";
import { vsSpyLabel } from "@/lib/dashboard-labels";

describe("vs-SPY label", () => {
  test("an exact tie is 'tied', not 'ahead'", () => {
    // The original test was `ours >= theirs ? "ahead" : "behind"`, which rendered a tie as a win.
    expect(vsSpyLabel(0.5, 0.5)).toBe("tied");
  });

  test("a difference invisible at the shown precision is 'tied'", () => {
    // Both render 0.50; claiming an edge here is what produced "0.50 (ahead) · ~49% beats SPY".
    expect(vsSpyLabel(0.5034, 0.4996)).toBe("tied");
    expect(vsSpyLabel(0.4996, 0.5034)).toBe("tied");
  });

  test("a real, visible difference still reads correctly", () => {
    expect(vsSpyLabel(0.62, 0.5)).toBe("ahead");
    expect(vsSpyLabel(0.38, 0.5)).toBe("behind");
    expect(vsSpyLabel(-3.88, -2.19)).toBe("behind"); // negative Sharpes compare the same way
  });

  test("the boundary of visibility is one displayed unit", () => {
    expect(vsSpyLabel(0.505, 0.5)).toBe("ahead"); // renders 0.51 vs 0.50
    expect(vsSpyLabel(0.504, 0.5)).toBe("tied");  // both render 0.50
  });

  test("signed zero does not leak a direction", () => {
    // (-0.004).toFixed(2) is "-0.00" but (0.004).toFixed(2) is "0.00" — without normalizing,
    // the card reads "-0.00 vs SPY 0.00 (behind)" off two numbers that are both zero on screen.
    expect(vsSpyLabel(-0.004, 0.004)).toBe("tied");
    expect(vsSpyLabel(0.004, -0.004)).toBe("tied");
    expect(vsSpyLabel(-0.004, -0.004)).toBe("tied");
  });

  test("respects a caller-supplied precision", () => {
    expect(vsSpyLabel(0.504, 0.5, 3)).toBe("ahead"); // 0.504 vs 0.500 is visible at 3dp
  });
});
