import { describe, test, expect } from "bun:test";
import { computeSleeveReturns, type PositionSnapshot, type TradeSnapshot } from "@/lib/run-store";

// The owner's between-run fills must enter the sleeve's BASE, not just its P&L.
// Fixture is the real 2026-11-23 main book (stored +12.24%, correct +7.59%).

const pos = (symbol: string, quantity: string, price: string): PositionSnapshot =>
  ({ symbol, quantity, price, avgCost: price });
const trade = (side: string, symbol: string, quantity: string, avgPrice: string, actor?: TradeSnapshot["actor"]): TradeSnapshot =>
  ({ symbol, side, quantity, avgPrice, state: "filled", strategy: "main", ...(actor ? { actor } : {}) });

const prev = [pos("LLY", "0.261883", "1351.685"), pos("REGN", "0.373943", "927.12"), pos("PM", "0.873316", "186.07")];
const today = [
  pos("LLY", "0.261883", "1371.895"), pos("TGT", "1.502990", "166.115"), pos("REGN", "0.258021", "936.279"),
  pos("DELL", "1.000000", "346.305"), pos("PM", "0.873316", "183.13"), pos("SNDK", "3.000000", "94.4"),
  pos("CBOE", "0.692252", "360.775"),
];
const agentTrades = [
  trade("sell", "REGN", "0.115922", "936.898100", "agent"),
  trade("buy", "TGT", "1.502990", "166.335000", "agent"),
  trade("buy", "CBOE", "0.692252", "361.140000", "agent"),
];
const ownerBuys = [trade("buy", "DELL", "1.000000", "285.90", "human"), trade("buy", "SNDK", "3.000000", "81.19", "human")];
const main = (p: PositionSnapshot[], t: TradeSnapshot[], y = prev) => computeSleeveReturns(p, t, [], [], y).mainDailyReturn;

describe("sleeve base includes the owner's between-run capital", () => {
  test("2026-11-23: +7.59%, not the +12.24% that left $529 of owner buys out of the base", () => {
    const r = main(today, [...agentTrades, ...ownerBuys])!;
    expect(r).toBeCloseTo(105.67 / 1392.64, 4);
    expect(r).toBeLessThan(0.08); // the flattering 0.1224 must not come back
  });

  test("control: a day with only the agent's own run-time trades is unchanged (base = yesterday)", () => {
    const t = today.filter(p => p.symbol !== "DELL" && p.symbol !== "SNDK");
    const pnl = (359.28 + 249.67 + 241.58 + 159.93 + 249.75) - (353.98 + 346.69 + 162.50) - (250.00 + 250.00 - 108.61);
    expect(main(t, agentTrades)!).toBeCloseTo(pnl / 863.17, 3);
  });

  test("actor-less legacy trades keep weight 0, so stored history does not shift", () => {
    const legacy = ownerBuys.map(({ actor: _a, ...t }) => t);
    expect(main(today, [...agentTrades, ...legacy])!).toBeCloseTo(105.67 / 863.17, 3);
  });

  test("owner sells between runs: base stays yesterday's book (end-weighted, never shrinks)", () => {
    const t = today.filter(p => p.symbol !== "PM" && p.symbol !== "DELL" && p.symbol !== "SNDK");
    const r = main(t, [...agentTrades, trade("sell", "PM", "0.873316", "186.07", "human")])!;
    const pnl = (359.28 + 249.67 + 241.58 + 249.75) - (353.98 + 346.69 + 162.50) - (500.00 - 108.61 - 162.50);
    expect(r).toBeCloseTo(pnl / 863.17, 3);
  });

  test("an owner buy with no fill price is priced at today's mark, like computeDailyReturn", () => {
    const noPx = [trade("buy", "DELL", "1.000000", "", "human"), ownerBuys[1]];
    // DELL then contributes 0 gain and 346.305 of base
    const r = main(today, [...agentTrades, ...noPx])!;
    expect(r).toBeCloseTo((105.67 - 60.405) / (863.17 + 346.305 + 243.57), 3);
  });

  test("a large owner buy into a small sleeve is computable now that its cost is in the base", () => {
    const y = [pos("BTC", "0.0003", "100000")];             // $30 sleeve
    const r = main([pos("BTC", "0.0003", "100000"), pos("PLTR", "2", "260")], [trade("buy", "PLTR", "2", "250", "human")], y)!;
    expect(r).toBeCloseTo(20 / 530, 4);
  });
});
