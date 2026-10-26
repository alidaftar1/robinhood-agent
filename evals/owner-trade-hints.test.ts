import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { likelyOwnerBuys, type LiveOrder } from "@/lib/run-store";

// 2026-10-26: the 10:30 ET run started 14:30:41Z; the owner bought $150 of MU at 14:51:57Z. The
// review called it an uncaptured order + a -$150 cash gap and blamed PLTR. These pin the HINT: it
// names the likely owner trade and never removes a discrepancy or changes the status.
const TODAY = "2026-10-26";
const RUN = { timestamp: "2026-10-26T14:30:41.724Z", date: TODAY };
const MU: LiveOrder = { symbol: "MU", side: "buy", quantity: "0.17", avgPrice: "897.20", state: "filled", createdAt: TODAY, createdAtTs: "2026-10-26T14:51:57.677307Z" };

describe("likely-owner-trade hint", () => {
  test("the 2026-10-26 MU buy is hinted, with its ET time", () => {
    const r = likelyOwnerBuys([MU], RUN, TODAY);
    expect(r.map(h => h.order)).toEqual([MU]);
    expect(r[0].at).toBe("10:51 AM");
  });
  test("not hinted: inside the run window, a sell, unfilled, not today's run, or a bad timestamp", () => {
    expect(likelyOwnerBuys([{ ...MU, createdAtTs: "2026-10-26T14:34:00Z" }], RUN, TODAY)).toEqual([]);
    expect(likelyOwnerBuys([{ ...MU, side: "sell" }], RUN, TODAY)).toEqual([]);
    expect(likelyOwnerBuys([{ ...MU, state: "pending" }], RUN, TODAY)).toEqual([]);
    expect(likelyOwnerBuys([MU], { timestamp: "2026-10-23T14:31:05Z", date: "2026-10-23" }, TODAY)).toEqual([]);
    expect(likelyOwnerBuys([MU], null, TODAY)).toEqual([]);
    for (const ts of [undefined, "", "garbage", "2026-10-26T14:51:57", "2026-10-27T14:51:57Z"])
      expect(likelyOwnerBuys([{ ...MU, createdAtTs: ts }], RUN, TODAY)).toEqual([]);
  });
});

describe("wiring: the hint never touches discrepancies or status", () => {
  const verify = readFileSync(`${import.meta.dir}/../app/api/verify/route.ts`, "utf8");
  const hintBlock = verify.slice(verify.indexOf("const tradeRun = "), verify.indexOf('const status = discrepancies.length === 0 ? "ok"'));
  test("the hint block only reads — no discrepancy/uncaptured/positionIssue mutation", () => {
    expect(hintBlock).toContain("likelyOwnerBuys(uncapturedOrders, tradeRun, today)");
    expect(hintBlock).toContain('typeof r.mainBuysOpen === "boolean"');   // anchored to the TRADE run only
    expect(hintBlock).not.toMatch(/discrepancies\.(splice|push|pop|shift|length\s*=)|uncapturedOrders\s*=|positionIssues\.splice/);
  });
  test("the email and the reviewer both receive it", () => {
    const autopilot = readFileSync(`${import.meta.dir}/../app/api/autopilot/route.ts`, "utf8");
    const review = readFileSync(`${import.meta.dir}/../lib/autopilot-review.ts`, "utf8");
    expect(autopilot).toContain("Probably your own trade:");
    expect(autopilot).toContain("ownerTradeHints: verifyResult.ownerTradeHints ?? []");
    expect(review).toContain("POSSIBLE OWNER TRADES among them — UNCONFIRMED");
    expect(review).toContain("STILL state that if the owner did not make them they are an unrecorded capture gap");
  });
  test("the order read has room for the longer line (truncation would silently disable capture)", () => {
    const orders = verify.slice(verify.indexOf("LIVE_ORDERS:["), verify.indexOf("const liveOrders"));
    expect(orders).toContain("2048, 30_000");
  });
});
