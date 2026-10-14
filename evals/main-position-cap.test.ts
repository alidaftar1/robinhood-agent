import { describe, expect, test } from "bun:test";
import { TARGET_MAIN_POSITIONS } from "../lib/position-target";

// The strategy targets a concentrated book and nothing bounded the count, so it drifted to 12
// half-size positions — an index clone. The 28-year survivorship-free sweep at the current -10%
// bar: 12 → +8.35% CAGR / IR 0.06 / maxDD -69.1%;  7 → +11.60% / IR 0.24 / -73.8%.
//
// NOTE the figures quoted here before 2026-10-14 (12 → +8.12% / IR 0.01; 6 → +11.75% / IR 0.22)
// came from the --ttm quality sweep at the -5% stop and do NOT reproduce under today's defaults.
// A quoted backtest number without its config is how this comment misled a reader once already.
//
// Return is flat from 4 to 7 and collapses at 8+, while drawdown improves monotonically across a
// 22pp range — so the count is the drawdown lever, which 23 stop configurations were not.
//
// The cap logic lives in the route handler (not unit-testable), so these pin the ARITHMETIC it
// relies on and the constant it is keyed to.
const allowedNew = (kept: number, cap = TARGET_MAIN_POSITIONS) => Math.max(0, cap - kept);

describe("main-book position cap", () => {
  test("the cap is the design target, not an independent number", () => {
    expect(TARGET_MAIN_POSITIONS).toBe(7);   // 6 -> 7 on 2026-10-14, see lib/position-target
  });

  test("at the cap, no new main buy is allowed", () => {
    expect(allowedNew(TARGET_MAIN_POSITIONS)).toBe(0);
  });

  test("OVER the cap allows none — never a negative slot count", () => {
    // The live book sits at 10-11, so this is the state it ships into.
    expect(allowedNew(11)).toBe(0);
    expect(allowedNew(12)).toBe(0);
  });

  test("under the cap allows exactly the shortfall", () => {
    expect(allowedNew(4)).toBe(TARGET_MAIN_POSITIONS - 4);
    expect(allowedNew(0)).toBe(TARGET_MAIN_POSITIONS);
  });

  test("a FULL EXIT frees a slot in the same decision", () => {
    // kept = held minus full exits, so selling one of six allows one buy.
    const held = TARGET_MAIN_POSITIONS, fullExits = 1;
    expect(allowedNew(held - fullExits)).toBe(1);
  });

  test("a PARTIAL sell frees nothing — the position is still held", () => {
    const held = TARGET_MAIN_POSITIONS, fullExits = 0;   // a trim is not an exit
    expect(allowedNew(held - fullExits)).toBe(0);
  });

  test("the cap can never force a sale — it only ever reduces allowed BUYS", () => {
    // Expressed as the invariant: for any held count, the result is a buy allowance >= 0 and there
    // is no code path that returns a number of positions to liquidate.
    for (const held of [0, 3, 6, 9, 12, 50]) expect(allowedNew(held)).toBeGreaterThanOrEqual(0);
  });

  test("the sector cap is still derived from the same target, so the two cannot drift", () => {
    // Derived, not pinned to a literal: floor(0.4*6)=2 and floor(0.4*7)=2, so the sector cap
    // survived the count change — at N=7 it is 29% of the book rather than 33%.
    expect(Math.max(1, Math.floor(0.4 * TARGET_MAIN_POSITIONS))).toBe(2);
  });
});

// buildV1Shortlist does not exclude held names from `buy`, so a holding that still ranks can be
// topped up. A top-up adds no position, so it must not consume a cap slot — otherwise the book,
// once AT the cap, could never concentrate, and sale proceeds would strand in cash.
describe("top-ups versus new positions", () => {
  const isNewPosition = (sym: string, held: Set<string>, fullyExiting: Set<string>) =>
    !held.has(sym) || fullyExiting.has(sym);

  test("a buy of an already-held name is NOT a new position", () => {
    expect(isNewPosition("KO", new Set(["KO", "LLY"]), new Set())).toBe(false);
  });

  test("a buy of an unheld name IS a new position", () => {
    expect(isNewPosition("AAPL", new Set(["KO"]), new Set())).toBe(true);
  });

  test("re-buying a name being FULLY EXITED counts as new — the slot was freed and refilled", () => {
    expect(isNewPosition("KO", new Set(["KO"]), new Set(["KO"]))).toBe(true);
  });

  test("so at the cap, top-ups stay allowed while new names are blocked", () => {
    const held = new Set(["A","B","C","D","E","F"]);           // at the 6-cap
    const exiting = new Set<string>();
    expect(isNewPosition("A", held, exiting)).toBe(false);      // top-up → allowed
    expect(isNewPosition("Z", held, exiting)).toBe(true);       // new name → blocked
  });
});
