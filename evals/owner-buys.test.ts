import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sortOwnerBuys, confirmMisfits } from "../lib/owner-buys";
import { ownerBuysFromOrders } from "../lib/robinhood-balance";
import { planCapture, type LiveOrder, type PositionSnapshot, type TradeSnapshot } from "../lib/run-store";

// 2026-10-30: the owner bought AMD on 10-29 for the influencer sleeve. The 10-30 07:30 run saw a
// holding not in the sleeve, judged it as MAIN, found it off the main shortlist and sold it (−$32).
// The 08:00 capture and any manual tag come after that run, so they can never fix it.

const base = {
  heldNow: ["MU", "STX", "AMD"],
  prevHeld: ["MU"],
  prevAgentBuys: [] as string[],
  onMainList: (s: string) => ["MU", "STX"].includes(s),
  mainUnknown: () => false,
  mainStrong: (s: string) => ["MU", "STX"].includes(s),
  influencer: {
    qualifies: (s: string) => s === "AMD",
    describe: (s: string) => (s === "AMD" ? "net 5, 2 channels" : "net 0, 0 channels"),
  },
};
const sleeveOf = (r: ReturnType<typeof sortOwnerBuys>) => Object.fromEntries(r.map(x => [x.symbol, x.sleeve]));

describe("sortOwnerBuys", () => {
  test("the 10-30 book: STX → main, AMD → influencer, an already-held name is not touched", () => {
    expect(sleeveOf(sortOwnerBuys(base))).toEqual({ STX: "main", AMD: "influencer" });
  });

  test("a name that fits neither book is a MISFIT (the run sells it)", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["MU", "COR"] });
    expect(r).toEqual([{ symbol: "COR", sleeve: "misfit", why: expect.stringContaining("net 0") }]);
  });

  test("fits both and in the main list's top → main", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["STX"], influencer: { ...base.influencer, qualifies: () => true } });
    expect(sleeveOf(r)).toEqual({ STX: "main" });
  });

  // 2026-10-30: GOOGL was on the main list only for its sector's slot (+23%, 11th of 14) but net 8
  // across 4 channels — the owner's call: a weak main pick and a strong sleeve one.
  test("fits both but only in the lower part of the main list → influencer (GOOGL)", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["GOOGL"], prevHeld: [],
      onMainList: s => s === "GOOGL", mainStrong: () => false, influencer: { ...base.influencer, qualifies: s => s === "GOOGL" } });
    expect(sleeveOf(r)).toEqual({ GOOGL: "influencer" });
  });

  test("lower part of the main list and NOT a sleeve pick → still main, never sold", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["SPG"], prevHeld: [],
      onMainList: s => s === "SPG", mainStrong: () => false });
    expect(sleeveOf(r)).toEqual({ SPG: "main" });
  });

  // FAIL-CLOSED: an outage must never turn into a sale. Each of these breaks one data source and
  // checks the would-be misfit is "unknown", not sold.
  test("influencer signals unavailable → unknown, never misfit", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["COR"], prevHeld: [], influencer: null });
    expect(sleeveOf(r)).toEqual({ COR: "unknown" });
  });

  test("main quality data unavailable → unknown, never misfit", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["COR"], prevHeld: [], onMainList: null });
    expect(sleeveOf(r)).toEqual({ COR: "unknown" });
  });

  test("quality unmeasurable for THIS name → unknown, never misfit", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["COR"], prevHeld: [], mainUnknown: s => s === "COR" });
    expect(sleeveOf(r)).toEqual({ COR: "unknown" });
  });

  test("main data down still lets a sleeve-qualified buy into the sleeve", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["AMD"], prevHeld: [], onMainList: null });
    expect(sleeveOf(r)).toEqual({ AMD: "influencer" });
  });

  test("the agent's own late-filling buy is not an owner buy", () => {
    const r = sortOwnerBuys({ ...base, heldNow: ["MU", "COR"], prevAgentBuys: ["COR"] });
    expect(r).toEqual([]);
  });

  test("no previous run → nothing is new, nothing is sorted", () => {
    expect(sortOwnerBuys({ ...base, prevHeld: null })).toEqual([]);
  });
});

describe("planCapture tags a captured buy with the sleeve the trade run sorted it into", () => {
  const pos = (symbol: string, quantity: string, price: string): PositionSnapshot =>
    ({ symbol, quantity, avgCost: price, price } as PositionSnapshot);
  const order = (side: string, symbol: string, quantity: string, avgPrice: string): LiveOrder =>
    ({ side, symbol, quantity, avgPrice, state: "filled", createdAt: "2026-10-29" });
  const held = { positions: [pos("MU", "1", "900")], influencerPositions: [] as PositionSnapshot[], trades: [] as TradeSnapshot[] };
  const T = { from: "2026-10-29", to: "2026-10-30" };
  const latestWith = (infl: PositionSnapshot[]) => ({
    positions: [pos("MU", "1", "900"), pos("AMD", "0.524764", "571.68")], trades: [] as TradeSnapshot[], influencerPositions: infl,
  });

  test("in the repaired run's sleeve → influencer", () => {
    const p = planCapture(held, latestWith([pos("AMD", "0.524764", "571.68")]), [order("buy", "AMD", "0.52", "571.68")], T);
    expect(p.record.map(t => [t.symbol, t.side, t.strategy])).toEqual([["AMD", "buy", "influencer"]]);
  });

  test("not in it → main, as before (control)", () => {
    const p = planCapture(held, latestWith([]), [order("buy", "AMD", "0.52", "571.68")], T);
    expect(p.record.map(t => [t.symbol, t.side, t.strategy])).toEqual([["AMD", "buy", "main"]]);
  });
});

describe("wiring: the trade run uses the sorted sleeve everywhere", () => {
  const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
  const sortAt = route.indexOf("sortOwnerBuys({");

  test("no read of the stored sleeve after the sort — every later reader sees the sorted one", () => {
    expect(sortAt).toBeGreaterThan(0);
    expect(route.slice(sortAt).includes("previousRun?.influencerPositions")).toBe(false);
  });

  test("the sort runs before the model prompt, and misfit sells join the sells before the sell rail", () => {
    expect(sortAt).toBeLessThan(route.indexOf("system: buildV1AnalysisPrompt(today, shortlistTable"));
    const misfit = route.indexOf('reason: "owner-misfit"');
    expect(misfit).toBeGreaterThan(sortAt);
    expect(misfit).toBeLessThan(route.indexOf("applySellRail("));
  });
});

// Review finding (2026-10-30): "new and not bought by the agent" is not proof the OWNER bought it —
// spin-off shares, merger stock, a dropped snapshot row or the agent's own late fill all look new.
describe("confirmMisfits: a misfit is sold only with the broker's word that the owner bought it", () => {
  const misfit = sortOwnerBuys({ ...base, heldNow: ["MU", "COR"] });

  test("owner-placed filled buy found → stays a misfit", () => {
    expect(sleeveOf(confirmMisfits(misfit, new Set(["COR"])))).toEqual({ COR: "misfit" });
  });

  test("no such order (spin-off, merger, data gap) → unknown, not sold", () => {
    expect(sleeveOf(confirmMisfits(misfit, new Set()))).toEqual({ COR: "unknown" });
  });

  test("order history unreadable → unknown, not sold", () => {
    expect(sleeveOf(confirmMisfits(misfit, null))).toEqual({ COR: "unknown" });
  });

  test("main / influencer sorts are untouched", () => {
    const r = sortOwnerBuys(base);
    expect(confirmMisfits(r, null)).toEqual(r);
  });
});

describe("ownerBuysFromOrders", () => {
  const row = (over: Record<string, string>) => ({ symbol: "COR", side: "buy", state: "filled", createdAtTs: "2026-10-29T17:12:03.123456Z", placedBy: "user", ...over });

  test("a filled buy the owner placed in the window counts", () => {
    expect([...ownerBuysFromOrders([row({})], ["COR"], "2026-10-29")]).toEqual(["COR"]);
  });

  test.each([
    ["the agent placed it", { placedBy: "agentic" }],
    ["origin missing", { placedBy: "" }],
    ["a sell", { side: "sell" }],
    ["not filled", { state: "cancelled" }],
    ["before the window", { createdAtTs: "2026-10-28T17:12:03Z" }],
    ["no parseable timestamp", { createdAtTs: "2026-10-29" + "?" }],
    ["timestamp missing", { createdAtTs: "" }],
    ["another symbol", { symbol: "AMD" }],
  ])("does not count when %s", (_why, over) => {
    expect(ownerBuysFromOrders([row(over as Record<string, string>)], ["COR"], "2026-10-29").size).toBe(0);
  });
});

describe("wiring: missing data never reads as 'not on the main list'", () => {
  const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
  test("an S&P name without momentum this morning is main-UNKNOWN", () => {
    expect(route).toContain("mainUnknown: (sym) => qualityUnknown.has(sym) || (sp500Set.has(sym) && !hasMomentum.has(sym))");
  });
  test("misfits pass through confirmMisfits with the owner's order evidence before any sell", () => {
    const confirm = route.indexOf("confirmMisfits(firstSort, await fetchOwnerBuyEvidence(");
    expect(confirm).toBeGreaterThan(0);
    expect(confirm).toBeLessThan(route.indexOf('reason: "owner-misfit"'));
  });
});

describe("wiring: the top of the main list is the first TARGET_MAIN_POSITIONS of the ranked buy list", () => {
  test("mainStrong reads v1Buy's head", () => {
    const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    expect(route).toContain("mainStrong: (sym) => v1Buy.slice(0, TARGET_MAIN_POSITIONS).some(s => s.symbol === sym)");
  });
});
