import { describe, expect, test } from "bun:test";
import { GUARD_DROP, notesForSymbol, unconfirmedBuysIssue } from "../lib/no-trade-cause";

// 2026-11-12: the unconfirmed-buy alert guessed its cause three times ("sells settle T+1", then
// "the post-sell re-read", then "execution") and each guess was wrong for some path — a DEFERRED or
// WITHHELD buy was never placed at all. It now quotes what the run recorded for the symbol.
describe("unconfirmed-buy alert quotes the run's notes, never a guessed cause", () => {
  test("a DEFERRED buy (not a guard drop) is reported with its own note", () => {
    const notes = ["LLY main-book buy DEFERRED — buys open on the rebalance days only"];
    expect(notes.some((n) => GUARD_DROP.test(n))).toBe(false);   // so it reaches the alert
    const msg = unconfirmedBuysIssue(["LLY"], notes);
    expect(msg).toContain('LLY: "LLY main-book buy DEFERRED');
    expect(msg).not.toMatch(/T\+1|settle|execution|insufficient/i);
  });

  test("no note at all → says so and points at the broker order history", () => {
    expect(unconfirmedBuysIssue(["SNDK"], [])).toContain("SNDK: no note recorded for it — check the broker order history");
  });

  test("each symbol gets only its own notes (ticker boundary: AAPL's note is not L's)", () => {
    const msg = unconfirmedBuysIssue(["L", "AAPL"], ["AAPL sized as-is — no usable price estimate"]);
    expect(msg).toContain("L: no note recorded");
    expect(msg).toContain('AAPL: "AAPL sized as-is');
  });

  test("a regex-hostile symbol from model output does not throw, and BRK.B is not BRK-B", () => {
    expect(() => notesForSymbol(["x"], "A(B[")).not.toThrow();
    expect(notesForSymbol(["BRK-B buy DROPPED — cap"], "BRK.B")).toEqual([]);
    expect(notesForSymbol(["BRK.B buy DROPPED — cap"], "BRK.B")).toHaveLength(1);
  });
});
