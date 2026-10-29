import { describe, expect, test } from "bun:test";
import { estimateSellProceeds, fitNotionalBuysToBudget, refitBuysAfterSells, SELL_PROCEEDS_HAIRCUT } from "@/lib/buy-sizing";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

// Limited margin (2026-10-24), owner decision 2026-10-29: a sale's proceeds are spendable the same
// day. 2026-10-29 is the case: FTNT, MRVL and AMZN sold for ~$605 and the only buy (COR) was sized
// at $63, the pre-sell cash, because the run budgeted as if sales settled T+1.

const held = new Map([["FTNT", "1"], ["MRVL", "1"], ["AMZN", "1"], ["LLY", "0.5"]]);
const px = new Map([["FTNT", 138], ["MRVL", 220], ["AMZN", 247], ["LLY", 1200]]);
const est = (sells: Parameters<typeof estimateSellProceeds>[0]) =>
  estimateSellProceeds(sells, s => held.get(s), s => px.get(s));

describe("estimateSellProceeds — the pre-flight's estimate of this run's sale proceeds", () => {
  test("the 2026-10-29 sells add ~$605 less the haircut", () => {
    const v = est([{ symbol: "FTNT", exit: "all" }, { symbol: "MRVL", exit: "all" }, { symbol: "AMZN", exit: "all" }]);
    expect(v).toBeCloseTo(605 * (1 - SELL_PROCEEDS_HAIRCUT), 6);
  });

  test("a trim counts only its fraction", () => {
    expect(est([{ symbol: "LLY", fraction: 0.5 }])).toBeCloseTo(0.25 * 1200 * (1 - SELL_PROCEEDS_HAIRCUT), 6);
  });

  test("errs LOW, never high: unheld, unpriced and malformed sells add nothing", () => {
    expect(est([{ symbol: "NVDA", exit: "all" }])).toBe(0);                       // not held
    expect(estimateSellProceeds([{ symbol: "FTNT", exit: "all" }], s => held.get(s), () => undefined)).toBe(0); // no price
    expect(est([{ symbol: "FTNT", fraction: 1.5 }])).toBe(0);                      // malformed fraction: not executed, so not counted
    expect(est([{ symbol: "FTNT", fraction: 0 }])).toBe(0);
  });

  test("CONTROL: with proceeds counted, the 10-29 buy is no longer squeezed to the pre-sell cash", () => {
    const buys = [{ symbol: "COR", dollarAmount: 300 }];
    const without = fitNotionalBuysToBudget(buys, 63.63).sized;
    const withProceeds = fitNotionalBuysToBudget(buys, 63.63 + est([{ symbol: "FTNT", exit: "all" }, { symbol: "MRVL", exit: "all" }, { symbol: "AMZN", exit: "all" }])).sized;
    expect(without[0].dollarAmount).toBeLessThan(64);
    expect(withProceeds[0].dollarAmount).toBe(300);
  });
});

describe("refitBuysAfterSells — the deciding fit, never borrow", () => {
  const buys = [{ symbol: "COR", dollarAmount: 300 }, { symbol: "GOOGL", dollarAmount: 250 }];
  const sum = (bs: { dollarAmount: number }[]) => bs.reduce((s, x) => s + x.dollarAmount, 0);

  test("fits to the LIVE re-read after sells (proceeds that really arrived are spent)", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: 63.63, estProceeds: 593, sellsPlaced: 3, after: { spendable: 668 } });
    expect(r.basis).toBe("live");
    expect(sum(r.buys)).toBe(550);
  });

  test("a sell that did not fill is not spent: buys shrink to the live balance", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: 63.63, estProceeds: 593, sellsPlaced: 3, after: { spendable: 300 } });
    expect(sum(r.buys)).toBeLessThanOrEqual(300);
  });

  test("re-read FAILED → pre-sell cash only, and says so", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: 63.63, estProceeds: 593, sellsPlaced: 3, after: null });
    expect(r.basis).toBe("pre-sell");
    expect(sum(r.buys)).toBeLessThanOrEqual(63.63);
    expect(r.notes[0]).toMatch(/could not re-read/);
  });

  test("proceeds were ASSUMED but every sell was dropped later → still refit (not skipped)", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: 63.63, estProceeds: 593, sellsPlaced: 0, after: null });
    expect(r.basis).toBe("pre-sell");
    expect(sum(r.buys)).toBeLessThanOrEqual(63.63);
  });

  test("no opening balance → NO buys at all", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: null, estProceeds: 0, sellsPlaced: 0, after: null });
    expect(r.buys).toEqual([]);
    expect(r.basis).toBe("none");
  });

  test("CONTROL: nothing sold and nothing assumed → unchanged (the pre-flight already fit the live cash)", () => {
    const r = refitBuysAfterSells(buys, { preSellSpendable: 1000, estProceeds: 0, sellsPlaced: 0, after: null });
    expect(r.basis).toBe("unchanged");
    expect(r.buys).toBe(buys);
  });
});

describe("the trade route wires the refit between the sells and the buy session", () => {
  test("order: sells → refit → buy session", async () => {
    const src = await Bun.file("app/api/trade/route.ts").text();
    const sells = src.indexOf("const ok = await runSellSession(sellsToExecute");
    const refit = src.indexOf("refitBuysAfterSells(decision.buys");
    const session = src.indexOf("const ok = await runBuySession(decision.buys");
    expect(sells).toBeGreaterThan(0);
    expect(refit).toBeGreaterThan(sells);
    expect(session).toBeGreaterThan(refit);
    expect(src).toContain("needsReread = agenticBalance != null && (sellsToExecute.length > 0 || estProceeds > 0)");
  });
});

describe("the prompt no longer says sale proceeds wait a day", () => {
  const prompt = buildV1AnalysisPrompt("2026-11-02", "SHORTLIST", { buyingPower: "$63.63", totalValue: "$2344", positions: [{ symbol: "FTNT", quantity: "1", avgCost: "187.5", price: 138 }] } as any);
  test("states the same-day budget and still forbids borrowing", () => {
    expect(prompt).toContain("SAME-DAY PROCEEDS");
    expect(prompt).toMatch(/never borrow/i);
    expect(prompt).not.toMatch(/T\+1 SETTLEMENT RULE|does NOT increase when you sell|Do not count sell proceeds/);
  });
});
