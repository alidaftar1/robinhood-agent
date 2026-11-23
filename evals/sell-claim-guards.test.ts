import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyNoRotationBelowTarget, dropUnverifiedStaleSells, type SellRailContext } from "@/lib/sell-rail";
import { staleReasonOf } from "@/lib/strategy";

// 2026-11-16 BE and 2026-11-19 AAPL: two sells the rules did not allow, with no code check behind
// them. These guards verify the model's "free a slot" and "stale" claims from run data.

type Pos = { avgCost: number; price: number; quantity: number };
const ctxOf = (positions: Record<string, Pos>, over: Partial<SellRailContext> = {}): SellRailContext => ({
  positionOf: (s) => positions[s],
  stillRanked: () => true,
  hasBearishNews: () => false,
  hasDowngrade: () => false,
  daysToEarnings: () => null,
  isStale: () => false,
  isOverConcentrationCap: () => false,
  reportedRecently: () => false,
  ...over,
});

// 11-16 book: BE ◆HELD at +1.4% after 6 days, no news, 6 main names of a 7 target.
const BE = { avgCost: 172.38, price: 174.83, quantity: 1.371183 };
const beSell = { symbol: "BE", exit: "all", reason: "discretionary" };

describe("applyNoRotationBelowTarget", () => {
  test("11-16 replay: BE sold to fund SNDK with a slot already free is DROPPED", () => {
    const r = applyNoRotationBelowTarget([beSell], ctxOf({ BE }), { mainHeld: 6, target: 7 });
    expect(r.sells).toEqual([]);
    expect(r.dropped).toEqual(["BE"]);
    expect(r.notes[0]).toContain("SELL DROPPED");
    expect(r.notes[0]).toContain("6 of a ~7 target");
  });
  test("at or above target the same sell passes (the rebalance-day slot clause applies there)", () => {
    expect(applyNoRotationBelowTarget([beSell], ctxOf({ BE }), { mainHeld: 7, target: 7 }).sells).toEqual([beSell]);
    expect(applyNoRotationBelowTarget([beSell], ctxOf({ BE }), { mainHeld: 9, target: 7 }).sells).toEqual([beSell]);
  });
  test("below target, a sell the data can justify still passes", () => {
    const justified: Array<Partial<SellRailContext>> = [
      { stillRanked: () => false },
      { hasBearishNews: () => true },
      { hasDowngrade: () => true },
      { daysToEarnings: () => 2 },
      { isStale: () => true },
      { isOverConcentrationCap: () => true },
      { reportedRecently: () => true },
    ];
    for (const over of justified) {
      expect(applyNoRotationBelowTarget([beSell], ctxOf({ BE }, over), { mainHeld: 6, target: 7 }).sells).toEqual([beSell]);
    }
    const underwater = { ...BE, price: BE.avgCost * 0.85 };
    expect(applyNoRotationBelowTarget([beSell], ctxOf({ BE: underwater }), { mainHeld: 6, target: 7 }).sells).toEqual([beSell]);
  });
  test("at target, ONE unproven rotation passes; the next ones ride on a slot already open and are dropped", () => {
    const positions = { A: BE, B: BE, C: BE };
    const sells = ["A", "B", "C"].map((symbol) => ({ symbol, exit: "all", reason: "discretionary" }));
    const r = applyNoRotationBelowTarget(sells, ctxOf(positions), { mainHeld: 7, target: 7 });
    expect(r.sells.map((x) => x.symbol)).toEqual(["A"]);
    expect(r.dropped).toEqual(["B", "C"]);
  });
  test("a PROVEN exit in the same batch opens the slot first, so an unproven rotation alongside it is dropped", () => {
    const positions = { OFF: BE, BE };
    const ctx = ctxOf(positions, { stillRanked: (s) => s !== "OFF" });
    const r = applyNoRotationBelowTarget([beSell, { symbol: "OFF", exit: "all", reason: "shortlist-drop" }], ctx, { mainHeld: 7, target: 7 });
    expect(r.dropped).toEqual(["BE"]);
    expect(r.sells.map((x) => x.symbol)).toEqual(["OFF"]);
  });
  test("a duplicated exit of one name frees ONE slot and does not drop a later legitimate rotation", () => {
    const positions = { BE, A: BE };
    const sells = [beSell, { ...beSell }, { symbol: "A", exit: "all", reason: "discretionary" }];
    const r = applyNoRotationBelowTarget(sells, ctxOf(positions), { mainHeld: 8, target: 7 });
    expect(r.dropped).toEqual([]);
    expect(r.sells.length).toBe(3);
  });
  test("when a duplicated exit is dropped, EVERY copy is reported dropped (nothing vanishes silently)", () => {
    const r = applyNoRotationBelowTarget([beSell, { ...beSell }], ctxOf({ BE }), { mainHeld: 6, target: 7 });
    expect(r.sells).toEqual([]);
    expect(r.dropped).toEqual(["BE", "BE"]);
    expect(r.notes.length).toBe(1);
  });
  test("an UNPRICED full exit is kept AND opens a slot, so a ranking rotation alongside it is judged below target", () => {
    const positions = { X: { ...BE, price: NaN }, BE };
    const r = applyNoRotationBelowTarget([{ symbol: "X", exit: "all" }, beSell], ctxOf(positions), { mainHeld: 7, target: 7 });
    expect(r.sells.map((x) => x.symbol)).toEqual(["X"]);
    expect(r.dropped).toEqual(["BE"]);
  });
  test("trims, unheld names and unpriced holdings pass (same edges as the rail)", () => {
    const trim = { symbol: "BE", fraction: 0.5 };
    expect(applyNoRotationBelowTarget([trim], ctxOf({ BE }), { mainHeld: 6, target: 7 }).sells).toEqual([trim]);
    expect(applyNoRotationBelowTarget([{ symbol: "ZZZ", exit: "all" }], ctxOf({}), { mainHeld: 6, target: 7 }).dropped).toEqual([]);
    const unpriced = { ...BE, price: NaN };
    expect(applyNoRotationBelowTarget([beSell], ctxOf({ BE: unpriced }), { mainHeld: 6, target: 7 }).dropped).toEqual([]);
  });
  test("fails OPEN on a throw", () => {
    const boom = ctxOf({ BE }, { stillRanked: () => { throw new Error("x"); } });
    expect(applyNoRotationBelowTarget([beSell], boom, { mainHeld: 6, target: 7 }).sells).toEqual([beSell]);
  });
});

describe("dropUnverifiedStaleSells", () => {
  const FULL = () => true;
  // 11-19 AAPL: sleeve, held 10 trading days, -0.1% since entry. The sleeve's down-clock needs < -2%.
  const aaplStale = staleReasonOf(true, 10, -0.1) != null;
  const aaplSell = { symbol: "AAPL", exit: "all", reason: "stale", strategy: "influencer" };

  test("11-19 replay: the code does not call AAPL stale, so the 'stale' sell is DROPPED", () => {
    expect(aaplStale).toBe(false);
    const r = dropUnverifiedStaleSells([aaplSell], FULL, () => aaplStale, () => false);
    expect(r.sells).toEqual([]);
    expect(r.dropped).toEqual(["AAPL"]);
    expect(r.notes[0]).toContain("SELL DROPPED");
  });
  test("a genuinely stale holding passes (sleeve past -2% at 10 days)", () => {
    const stale = staleReasonOf(true, 10, -2.5) != null;
    expect(stale).toBe(true);
    expect(dropUnverifiedStaleSells([aaplSell], FULL, () => stale, () => false).sells).toEqual([aaplSell]);
  });
  test("the token is read only to BLOCK: any other reason passes untouched", () => {
    for (const reason of ["news-down", "firm-down", "shortlist-drop", "concentration", "discretionary", undefined]) {
      const s = { symbol: "AAPL", exit: "all", reason };
      expect(dropUnverifiedStaleSells([s], FULL, () => false, () => false).sells).toEqual([s]);
    }
  });
  test("a trim beside a bogus 'stale' FULL exit does not carry the whole position out", () => {
    const isFull = (x: { fraction?: number }) => x.fraction == null;
    const trim = { symbol: "AAPL", fraction: 0.3, reason: "news-down" };
    const r = dropUnverifiedStaleSells([trim, aaplSell], isFull, () => false, () => false);
    expect(r.sells).toEqual([trim]);
    expect(r.dropped).toEqual(["AAPL"]);
  });
  test("a TRIM labelled 'stale' passes — the stale clock governs full exits only", () => {
    const trim = { symbol: "AAPL", fraction: 0.5, reason: "stale" };
    expect(dropUnverifiedStaleSells([trim], () => false, () => false, () => false).sells).toEqual([trim]);
  });
  test("unknown staleness (no price or age) passes — unknown is not 'not stale'", () => {
    expect(dropUnverifiedStaleSells([aaplSell], FULL, () => null, () => false).sells).toEqual([aaplSell]);
  });
  test("judged per NAME: a 'stale' copy is not reported dropped when another copy of the name sells anyway", () => {
    const r = dropUnverifiedStaleSells([aaplSell, { ...aaplSell, reason: "news-down" }], FULL, () => false, () => false);
    expect(r.dropped).toEqual([]);
    expect(r.sells.length).toBe(2);
  });
  test("a mislabelled token never blocks an exit with another PROVABLE reason", () => {
    // e.g. a main name that fell off the shortlist, or a sleeve name 2 days before earnings, tagged "stale".
    expect(dropUnverifiedStaleSells([aaplSell], FULL, () => false, () => true).sells).toEqual([aaplSell]);
  });
  test("the token is normalised like the exit ledger's: 'Stale' and ' stale ' are caught", () => {
    for (const reason of ["Stale", " stale ", "STALE"]) {
      expect(dropUnverifiedStaleSells([{ ...aaplSell, reason }], FULL, () => false, () => false).dropped).toEqual(["AAPL"]);
    }
  });
  test("fails OPEN on a throw", () => {
    expect(dropUnverifiedStaleSells([aaplSell], FULL, () => { throw new Error("x"); }, () => false).sells).toEqual([aaplSell]);
  });
});

describe("trade route wiring", () => {
  const s = readFileSync("app/api/trade/route.ts", "utf8");
  const guardAt = s.indexOf("applyNoRotationBelowTarget(proposed, railCtx, { mainHeld: mainHeldForRail, target: TARGET_MAIN_POSITIONS })");
  const staleAt = s.indexOf("dropUnverifiedStaleSells(");
  const sleeveCapAt = s.indexOf("const MAX_INFLUENCER_POSITIONS = 2;");
  const mainCapAt = s.indexOf("const mainSoldSet = new Set(");
  const execAt = s.indexOf("const sellsToExecute");
  test("both guards run BEFORE the slot caps read decision.sells (a later drop over-filled the sleeve and book)", () => {
    expect(guardAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(guardAt);
    expect(sleeveCapAt).toBeGreaterThan(staleAt);
    expect(mainCapAt).toBeGreaterThan(staleAt);
    expect(execAt).toBeGreaterThan(staleAt);
  });
  test("the sell-volume rail ALSO runs before the slot caps and buy sizing (same defect class)", () => {
    const railAt = s.indexOf("const rail = applySellRail(mainSells, railCtx, railMax, { evidenceDegraded });");
    expect(railAt).toBeGreaterThan(-1);
    expect(railAt).toBeLessThan(sleeveCapAt);
    expect(railAt).toBeLessThan(mainCapAt);
    expect(railAt).toBeLessThan(s.indexOf("estProceeds = estimateSellProceeds("));
  });
  test("the rotation guard runs on rebalance days only; the stale guard every day", () => {
    expect(s).toMatch(/const rotation = buysOpen\s*\?\s*applyNoRotationBelowTarget\(/);
  });
  test("bearish news is NOT accepted as the other reason for a 'stale' sell (the 11-19 AAPL shape)", () => {
    expect(s).toContain("justifiedReason(sym, { ...railCtx, hasBearishNews: () => false, isStale: () => false }) != null");
  });
  test("one staleness derivation, on the sleeve clock for a sleeve name, shared with the rail", () => {
    expect(s).toContain("(sym) => staleOf(sym, influencerHeld.has(sym)),");
    expect(s).toContain("isStale: (sym: string) => staleOf(sym, false) === true,");
    expect(s.match(/staleReasonOf\(/g)?.length).toBe(1);
  });
  test("the book is counted as the prompt and the slot cap count it (owner misfits included)", () => {
    expect(s).toContain("{ mainHeld: mainHeldForRail, target: TARGET_MAIN_POSITIONS }");
    expect(s).not.toContain("misfitsLeaving");
  });
  test("the sleeve's other reasons: the shared IMMINENT_EARNINGS_DAYS, or past its own -10% stop from buy", () => {
    expect(s).toContain("if (d != null && d >= 0 && d <= IMMINENT_EARNINGS_DAYS) return true;");
    expect(s).toContain("((p.price - p.avgCost) / p.avgCost) * 100 <= INFLUENCER_DROP_THRESHOLD_PCT");
  });
  test("with no sleeve list the stale guard stands down (the clock is unknown)", () => {
    expect(s).toMatch(/const staleClaims = !sleeveListKnown\s*\?/);
  });
  test("ONE ownership rule for every guard and the rail — never the model's strategy tag", () => {
    expect(s).toContain("influencerHeld.has(x.symbol) || (!sleeveListKnown && x.strategy === \"influencer\");");
    expect(s).toContain("const sleeveListKnown = Array.isArray(sleevePositions);");
    expect(s).toContain("const proposed = decision.sells.filter(x => !isSleeveOwned(x));");
    expect(s).toContain("[...rotation.sells, ...decision.sells.filter(isSleeveOwned)],");
    expect(s).not.toMatch(/x\.strategy === "influencer" \|\| influencerHeld\.has/);   // the tag never overrides a known list
  });
  test("claim guards run BEFORE the rail (a bogus claim must not use up a rail slot), and the rail keeps the model's order", () => {
    expect(staleAt).toBeLessThan(s.indexOf("const rail = applySellRail(mainSells, railCtx, railMax, { evidenceDegraded });"));
    expect(s).toContain("decision.sells = decision.sells.filter(x => railKept.has(x));");
  });
  test("a dropped sell is written to the run AND alerted, not just logged; the model's order is kept", () => {
    expect(s).toContain("buySizingAdjustments.push(...rotation.notes, ...staleClaims.notes);");
    expect(s).toContain("decision.sells = decision.sells.filter(x => keptSells.has(x));");
    expect(s).toContain("Sell claim guard dropped");
  });
});

describe("prompt states the rules the guards enforce", () => {
  const p = readFileSync("lib/strategy.ts", "utf8");
  test("the slot clause applies only at or above target", () => {
    expect(p).toContain("ONLY when the main book is already at or above its ~${TARGET_MAIN_POSITIONS} target");
  });
  test("the sleeve stale rule states the -2% band and that only a shown ⏳STALE tag counts", () => {
    expect(p).toContain("down MORE than ${Math.abs(INFLUENCER_STALE_RETURN_PCT)}% since entry");
    expect(p).toContain("This exception applies ONLY to a holding whose line SHOWS the ⏳STALE tag");
  });
});
