import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { spendableFromPortfolio } from "@/lib/robinhood-balance";
import { computeT1Settling } from "@/lib/risk-metrics";

// 2026-10-24: the account moved to LIMITED MARGIN. On a margin account Robinhood's
// buying_power can include borrowing capacity, and the agent spends whatever it is told it can.
// The agent must NEVER borrow — spendable = min(buying_power, unleveraged_buying_power, cash),
// and 0 when neither limit can be read. The SNAPSHOT cash figure is kept separate.
describe("the agent never spends borrowed money", () => {
  test("live shape 2026-10-24: all three equal — nothing changes", () => {
    const r = spendableFromPortfolio({ buyingPower: "384.3000", unleveragedBuyingPower: "384.3000", cash: "384.3", totalValue: "2365.10" });
    expect(r?.spendable).toBe(384.3);
    expect(r?.buyingPower).toBe(384.3);
    expect(r?.unsettled).toBe(0);
    expect(r?.cashKnown).toBe(true);
  });

  test("margin capacity in buying_power is never spent, nor stored as cash", () => {
    const r = spendableFromPortfolio({ buyingPower: "4730.00", unleveragedBuyingPower: "384.30", cash: "384.30", totalValue: "2365" });
    expect(r?.spendable).toBe(384.3);
    expect(r?.buyingPower).toBe(384.3);      // snapshot cash: min(bp, cash), not 4730
    expect(r?.capped).toBe(true);
  });

  test("capped at cash when the unleveraged field is missing or garbled", () => {
    expect(spendableFromPortfolio({ buyingPower: "4730", cash: "384.30", totalValue: "2365" })?.spendable).toBe(384.3);
    expect(spendableFromPortfolio({ buyingPower: "4730", unleveragedBuyingPower: "n/a", cash: "384.30", totalValue: "2365" })?.spendable).toBe(384.3);
  });

  test("FAILS CLOSED: with neither unleveraged nor cash readable, raw buying_power is NOT spent", () => {
    // Raw buying_power alone may be borrowing capacity. Not buying is the safe failure.
    const r = spendableFromPortfolio({ buyingPower: "4730", totalValue: "2365" });
    expect(r?.spendable).toBe(0);
    expect(r?.cashKnown).toBe(false);
    expect(spendableFromPortfolio({ buyingPower: "200", cash: "-15", totalValue: "2365" })?.spendable).toBe(0);
  });

  test("the spend limit never lowers the stored cash figure", () => {
    // unleveraged below cash (e.g. a margin hold): spending is limited, but snapshot cash stays real,
    // so totalValue and tomorrow's return baseline are not understated.
    const r = spendableFromPortfolio({ buyingPower: "400", unleveragedBuyingPower: "250", cash: "400", totalValue: "2365" });
    expect(r?.spendable).toBe(250);
    expect(r?.buyingPower).toBe(400);
  });

  test("CONTROL: cash-account shape (unsettled proceeds excluded from buying_power) still reads unsettled", () => {
    const r = spendableFromPortfolio({ buyingPower: "223.26", unleveragedBuyingPower: "223.26", cash: "532.59", totalValue: "2364.51" });
    expect(r?.spendable).toBeCloseTo(223.26);
    expect(r?.unsettled).toBeCloseTo(309.33);
  });
});

describe("the trade route spends `spendable` and does not double-count a measured 0 unsettled", () => {
  const s = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
  test("buy sizing and the prompt budget read the never-borrow figure", () => {
    // Pre-flight: never-borrow cash + this run's ESTIMATED sale proceeds (limited margin, 2026-10-29);
    // the deciding fit is the re-read after the sells, again on `spendable`, never raw buying power.
    expect(s).toContain("fitNotionalBuysToBudget(decision.buys, agenticBalance.spendable + estProceeds)");
    expect(s).toContain("preSellSpendable: agenticBalance ? agenticBalance.spendable : null");
    expect(s).not.toContain("after.buyingPower");
    expect(s).toContain("usableNotionalBudget(agenticBalance.spendable)");
    expect(s).not.toContain("fitNotionalBuysToBudget(decision.buys, agenticBalance.buyingPower)");
  });
  test("a MEASURED live unsettled (incl. 0) wins over the sell-proceeds estimate", () => {
    // On limited margin, proceeds are already in cash; re-adding them inflated totalValue.
    expect(s).toContain("const unsettledMeasured = cashFromLiveAfter && liveBalanceAfter?.cashKnown === true;");
    // ...and ONLY when cash itself came from the live post-trade read: the reconstruction branch
    // starts from the PRE-trade balance and must keep the sell-proceeds estimate.
    expect(s.indexOf("cashFromLiveAfter = true;")).toBeGreaterThan(s.indexOf("cashAfter = liveBalanceAfter.buyingPower;"));
  });
  test("the dashboard's T+1 card trusts a MEASURED 0 instead of re-adding the day's sells", () => {
    const run = (unsettledCash: string, unsettledMeasured?: boolean) => ({
      date: "2026-10-26", trades: [{ symbol: "APA", side: "sell", quantity: "6", avgPrice: "51.5" }],
      portfolioAfter: { totalValue: "2365", cash: "693", equity: "1672", unsettledCash, ...(unsettledMeasured ? { unsettledMeasured } : {}) },
    }) as unknown as import("@/lib/run-store").TradeRun;
    expect(computeT1Settling(run("0.00", true))).toBeNull();          // limited margin: nothing settling
    expect(computeT1Settling(run("0.00"))?.amount).toBeCloseTo(309);  // CONTROL: old unmeasured run keeps the fallback
  });
});
