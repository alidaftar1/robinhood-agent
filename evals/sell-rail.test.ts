import { describe, test, expect } from "bun:test";
import { applySellRail, justifiedReason, MAX_DISCRETIONARY_EXITS, LOSS_DISCIPLINE_PCT, type SellRailContext } from "@/lib/sell-rail";

// Measured 2026-09-29: with a count target pointed at the free-a-slot judgment, the production
// model proposed selling the ENTIRE main book in 1 of 4 runs. Under T+1 the paired buys cannot
// settle the same day, so that decision liquidates into cash and buys nothing. Sells passed one
// filter (is it held) while buys passed six. This bounds the discretionary half.
const ctx = (over: Partial<SellRailContext> = {}): SellRailContext => ({
  positionOf: () => ({ avgCost: 100, price: 101, quantity: 1 }),   // healthy by default
  stillRanked: () => true,
  hasBearishNews: () => false,
  hasDowngrade: () => false,
  daysToEarnings: () => null,
  isStale: () => false,
  isOverConcentrationCap: () => false,
  reportedRecently: () => false,
  ...over,
});
const exits = (n: number) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}`, exit: "all" }));

describe("the rail bounds restructuring, never risk", () => {
  test("THE CASE IT EXISTS FOR: 11 unjustified exits are cut to the cap", () => {
    const r = applySellRail(exits(11), ctx());
    expect(r.sells).toHaveLength(MAX_DISCRETIONARY_EXITS);
    expect(r.dropped).toHaveLength(11 - MAX_DISCRETIONARY_EXITS);
  });

  test("a PROVABLE risk exit is never capped, however many there are", () => {
    // A bad week can breach loss discipline on every name at once. Blocking that would be far
    // worse than the problem this solves.
    const r = applySellRail(exits(11), ctx({ positionOf: () => ({ avgCost: 100, price: 80, quantity: 1 }) }));
    expect(r.sells).toHaveLength(11);
    expect(r.dropped).toHaveLength(0);
  });

  test("justification is VERIFIED, not read from the thesis", () => {
    expect(justifiedReason("X", ctx({ positionOf: () => ({ avgCost: 100, price: 89, quantity: 1 }) }))).toMatch(/loss discipline/);
    expect(justifiedReason("X", ctx({ isStale: () => true }))).toMatch(/STALE/);
    expect(justifiedReason("X", ctx({ stillRanked: () => false }))).toMatch(/fell off/);
    expect(justifiedReason("X", ctx({ hasDowngrade: () => true }))).toMatch(/downgrade/);
    expect(justifiedReason("X", ctx({ hasBearishNews: () => true }))).toMatch(/bearish/);
    expect(justifiedReason("X", ctx({ daysToEarnings: () => 2 }))).toMatch(/earnings in 2d/);
    expect(justifiedReason("X", ctx({ isOverConcentrationCap: () => true }))).toMatch(/CONCEN/);
    expect(justifiedReason("X", ctx({ reportedRecently: () => true }))).toMatch(/just reported/);
    expect(justifiedReason("X", ctx())).toBeNull();
  });

  test("a prompt-MANDATED exit is never capped", () => {
    // "You cannot KEEP a ⚠CONCEN name over the cap; if you believe its thesis has WEAKENED,
    // FULL-exit it yourself." Such a name is a WINNER that grew past the cap, so no distress test
    // fires for it — the rail would otherwise block an exit the prompt required.
    const r = applySellRail(exits(11), ctx({ isOverConcentrationCap: () => true }));
    expect(r.dropped).toHaveLength(0);
  });

  test("an earnings-reaction exit is not capped for being only mildly down", () => {
    // A post-print drop can be far less than 10% below ENTRY and so invisible to loss discipline,
    // while the prompt tells the model to reassess or exit on exactly that.
    const r = applySellRail(exits(5), ctx({ reportedRecently: () => true }));
    expect(r.dropped).toHaveLength(0);
  });

  test("the loss-discipline bar matches the prompt's −10%, not something stricter", () => {
    // Code and prompt disagreeing about what counts as justified is how a guard starts dropping
    // exits the model was correctly told to make.
    expect(justifiedReason("X", ctx({ positionOf: () => ({ avgCost: 100, price: 100 + LOSS_DISCIPLINE_PCT, quantity: 1 }) }))).toMatch(/loss discipline/);
    expect(justifiedReason("X", ctx({ positionOf: () => ({ avgCost: 100, price: 91, quantity: 1 }) }))).toBeNull();
  });

  test("TRIMS are never counted — a partial reduction is not a liquidation", () => {
    // applyConcentrationTrim already issues partial sells in code; the rail must not interfere.
    const trims = Array.from({ length: 11 }, (_, i) => ({ symbol: `S${i}`, fraction: 0.5 }));
    expect(applySellRail(trims, ctx()).sells).toHaveLength(11);
  });

  test("a mix keeps every justified exit and caps only the rest", () => {
    const underwater = new Set(["A", "B", "C", "D"]);
    const r = applySellRail(
      [...["A", "B", "C", "D"], ...["W", "X", "Y", "Z"]].map(symbol => ({ symbol, exit: "all" })),
      ctx({ positionOf: (s) => ({ avgCost: 100, price: underwater.has(s) ? 80 : 101, quantity: 1 }) }),
    );
    expect(r.sells.map(s => s.symbol)).toEqual(["A", "B", "C", "D", "W", "X", "Y"]);
    expect(r.dropped).toEqual(["Z"]);
  });

  test("a drop is RECORDED, never silent", () => {
    // The autopilot's decided-vs-executed check treats an absent trade with no note as an
    // unexplained anomaly and escalates — a guard doing its job would look like a bug.
    const r = applySellRail(exits(6), ctx());
    expect(r.notes).toHaveLength(r.dropped.length);
    expect(r.notes[0]).toContain("SELL DROPPED");
    expect(r.notes[0]).toMatch(/Risk exits are never capped/);
  });

  test("it FAILS OPEN — a rail that blocks every sell on its own bug is worse than none", () => {
    const exploding = ctx({ positionOf: () => { throw new Error("boom"); } });
    const r = applySellRail(exits(11), exploding);
    expect(r.sells).toHaveLength(11);
    expect(r.dropped).toHaveLength(0);
  });

  test("under the cap nothing is touched", () => {
    const r = applySellRail(exits(MAX_DISCRETIONARY_EXITS), ctx());
    expect(r.dropped).toHaveLength(0);
    expect(r.notes).toHaveLength(0);
  });
});
