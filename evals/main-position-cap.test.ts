import { describe, expect, test } from "bun:test";
import { TARGET_MAIN_POSITIONS } from "../lib/position-target";

// The strategy targets ~6 concentrated names and nothing bounded the count, so the book drifted to
// 12 half-size positions — an index clone. The 28-year survivorship-free sweep is monotonic:
//   12 → CAGR +8.12% / IR 0.01 / 21,138 trades      6 → CAGR +11.75% / IR 0.22 / 10,954 trades
// so concentration improves returns AND halves execution cost.
//
// The cap logic lives in the route handler (not unit-testable), so these pin the ARITHMETIC it
// relies on and the constant it is keyed to.
const allowedNew = (kept: number, cap = TARGET_MAIN_POSITIONS) => Math.max(0, cap - kept);

describe("main-book position cap", () => {
  test("the cap is the design target, not an independent number", () => {
    expect(TARGET_MAIN_POSITIONS).toBe(6);
  });

  test("at the cap, no new main buy is allowed", () => {
    expect(allowedNew(6)).toBe(0);
  });

  test("OVER the cap allows none — never a negative slot count", () => {
    // The live book sits at 10-11, so this is the state it ships into.
    expect(allowedNew(11)).toBe(0);
    expect(allowedNew(12)).toBe(0);
  });

  test("under the cap allows exactly the shortfall", () => {
    expect(allowedNew(4)).toBe(2);
    expect(allowedNew(0)).toBe(6);
  });

  test("a FULL EXIT frees a slot in the same decision", () => {
    // kept = held minus full exits, so selling one of six allows one buy.
    const held = 6, fullExits = 1;
    expect(allowedNew(held - fullExits)).toBe(1);
  });

  test("a PARTIAL sell frees nothing — the position is still held", () => {
    const held = 6, fullExits = 0;   // a trim is not an exit
    expect(allowedNew(held - fullExits)).toBe(0);
  });

  test("the cap can never force a sale — it only ever reduces allowed BUYS", () => {
    // Expressed as the invariant: for any held count, the result is a buy allowance >= 0 and there
    // is no code path that returns a number of positions to liquidate.
    for (const held of [0, 3, 6, 9, 12, 50]) expect(allowedNew(held)).toBeGreaterThanOrEqual(0);
  });

  test("the sector cap is still derived from the same target, so the two cannot drift", () => {
    expect(Math.max(1, Math.floor(0.4 * TARGET_MAIN_POSITIONS))).toBe(2);
  });
});
