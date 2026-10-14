import { describe, test, expect } from "bun:test";
import { findUncapturedOrders, type LiveOrder, type TradeSnapshot } from "@/lib/run-store";

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-14: the autopilot email said BOTH of these about the same fill —
//   autoFixed: "Recorded 1 of your own fill(s) from the broker: buy MRVL x0.000269 @$260.12"
//   issues:    "Live verify: Uncaptured order: buy MRVL ×0.000269 @$260.12 (filled)"
// and the second set the report to NEEDS ATTENTION. Nothing was wrong: /api/verify builds the
// discrepancy list BEFORE ?capture=1 runs and computes `status` AFTER it, so a fill the same
// request had just recorded was still reported as missing. Same shape as the no-trades banner bug
// the day before: a guard doing its job, reported as a failure.
//
// Direction rule for this one: a WRONG SUPPRESSION hides a real unrecorded fill, which is the
// expensive error. So every ambiguous case here must keep REPORTING.
// ─────────────────────────────────────────────────────────────────────────────
const TODAY = "2026-10-14";
const order = (o: Partial<LiveOrder> = {}): LiveOrder =>
  ({ symbol: "MRVL", side: "buy", quantity: "0.000269", avgPrice: "260.12", state: "filled", createdAt: TODAY, ...o });
const trade = (t: Partial<TradeSnapshot> = {}): TradeSnapshot =>
  ({ symbol: "MRVL", side: "buy", quantity: "0.000269", avgPrice: "260.12", state: "filled", ...t } as TradeSnapshot);

describe("uncaptured orders are re-asked after a capture writes", () => {
  test("an unrecorded fill is reported", () => {
    expect(findUncapturedOrders([order()], [], TODAY)).toHaveLength(1);
  });

  test("once the matching trade is on file, it is NOT reported — the live 10-14 case", () => {
    expect(findUncapturedOrders([order()], [trade()], TODAY)).toHaveLength(0);
  });

  test("a trade for the same symbol on the OTHER side does not explain it", () => {
    expect(findUncapturedOrders([order()], [trade({ side: "sell" })], TODAY)).toHaveLength(1);
  });

  test("a trade for a DIFFERENT symbol does not explain it — never match on vibes", () => {
    // Registry #1: uncaptured orders were once attributed to decided buys with no symbol in common.
    expect(findUncapturedOrders([order()], [trade({ symbol: "NVDA" })], TODAY)).toHaveLength(1);
  });

  test("a quantity that differs beyond tolerance keeps REPORTING", () => {
    // Capture takes quantity from position arithmetic and only price from the broker, so the two
    // can legitimately disagree. When they do, the safe answer is to keep saying so.
    expect(findUncapturedOrders([order({ quantity: "5" })], [trade({ quantity: "1" })], TODAY)).toHaveLength(1);
  });

  test("only FILLED orders count, and only today's", () => {
    expect(findUncapturedOrders([order({ state: "cancelled" })], [], TODAY)).toHaveLength(0);
    expect(findUncapturedOrders([order({ createdAt: "2026-10-01" })], [], TODAY)).toHaveLength(0);
    // An order with no date cannot be excluded as old, so it is still checked.
    expect(findUncapturedOrders([order({ createdAt: undefined })], [], TODAY)).toHaveLength(1);
  });

  test("no live orders at all is not a discrepancy", () => {
    expect(findUncapturedOrders(null, [], TODAY)).toHaveLength(0);
    expect(findUncapturedOrders([], [trade()], TODAY)).toHaveLength(0);
  });
});
