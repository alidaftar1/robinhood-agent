import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sectorPeerMove, heldBySectorRule, MAIN_SECTOR_EXCESS_PCT, MIN_SECTOR_PEERS, MAIN_DROP_THRESHOLD_PCT, stopBarFor, buildExitContext, sectorRuleApplies, judgeSectorStops } from "@/lib/stopouts";

// 2026-11-05: the main book's same-day crash stop became SECTOR-RELATIVE (owner decision after
// scripts/take-profit-backtest.ts sd10-rel10). A -10% day is sold only if the name also fell 10+
// points more than its sector's other S&P members. MU (-11%, memory-wide fall) would be held; BE
// (-15% while its sector was about flat) would still be sold.
const SECTOR: Record<string, string> = { MU: "XLK", SNDK: "XLK", WDC: "XLK", STX: "XLK", NVDA: "XLK", BE: "XLI", GE: "XLI", CAT: "XLI", HON: "XLI" };
const sec = (s: string) => SECTOR[s];
const stocks = [
  { symbol: "MU", change1d: -11.4 }, { symbol: "SNDK", change1d: -14 }, { symbol: "WDC", change1d: -7 },
  { symbol: "STX", change1d: -8 }, { symbol: "NVDA", change1d: -3 },
  { symbol: "BE", change1d: -15.3 }, { symbol: "GE", change1d: -0.5 }, { symbol: "CAT", change1d: 0.8 }, { symbol: "HON", change1d: -1.1 },
];

describe("sector-relative crash stop", () => {
  it("peer move is the equal-weight mean of the OTHER names in the sector", () => {
    expect(sectorPeerMove("MU", stocks, sec)).toBeCloseTo((-14 - 7 - 8 - 3) / 4, 6);
    expect(sectorPeerMove("BE", stocks, sec)).toBeCloseTo((-0.5 + 0.8 - 1.1) / 3, 6);
  });
  it("MU falling with memory is HELD; BE falling alone is SOLD", () => {
    expect(heldBySectorRule(-11.4, sectorPeerMove("MU", stocks, sec))).toBe(true);
    expect(heldBySectorRule(-15.3, sectorPeerMove("BE", stocks, sec))).toBe(false);
  });
  it("exactly 10 points worse than the sector is SOLD (the bar is inclusive)", () => {
    expect(heldBySectorRule(-12, -2)).toBe(false);
    expect(heldBySectorRule(-11.99, -2)).toBe(true);
  });
  it("an unknown sector move never holds — the plain bar applies", () => {
    expect(heldBySectorRule(-11, null)).toBe(false);
    expect(sectorPeerMove("ZZZ", stocks, sec)).toBeNull();
    const thin = [{ symbol: "BE", change1d: -15 }, { symbol: "GE", change1d: -14 }];
    expect(sectorPeerMove("BE", thin, sec)).toBeNull();                  // < MIN_SECTOR_PEERS
    expect(MIN_SECTOR_PEERS).toBeGreaterThanOrEqual(3);
  });
  it("non-finite peer readings are skipped, not averaged in", () => {
    const withNaN = [...stocks, { symbol: "XNAN", change1d: NaN }];
    SECTOR.XNAN = "XLK";
    expect(sectorPeerMove("MU", withNaN, sec)).toBeCloseTo((-14 - 7 - 8 - 3) / 4, 6);
    delete SECTOR.XNAN;
  });
  it("constants: still a -10% day, plus 10 points of excess", () => {
    expect(MAIN_DROP_THRESHOLD_PCT).toBe(-10);
    expect(MAIN_SECTOR_EXCESS_PCT).toBe(-10);
  });
});

describe("which stops the sector rule may hold (sectorRuleApplies)", () => {
  const ctx = (a: { isInfluencer: boolean; mainOwned: boolean; boughtToday: boolean; canMeasureFromBuy: boolean }) =>
    sectorRuleApplies(buildExitContext(a));
  it("an established main-book holding — the 2026-11-20 MU/DELL case — is eligible", () => {
    expect(ctx({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: true })).toBe(true);
    expect(ctx({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: false })).toBe(true);
  });
  it("no sleeve row is eligible — pure, mixed with main, or with an unreadable basis", () => {
    expect(ctx({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: true })).toBe(false);
    expect(ctx({ isInfluencer: true, mainOwned: true, boughtToday: false, canMeasureFromBuy: true })).toBe(false);
    expect(ctx({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: false })).toBe(false);
  });
  it("a name bought today is not eligible, even when its basis is unreadable and it fell back to same-day", () => {
    expect(ctx({ isInfluencer: false, mainOwned: true, boughtToday: true, canMeasureFromBuy: true })).toBe(false);
    expect(ctx({ isInfluencer: false, mainOwned: true, boughtToday: true, canMeasureFromBuy: false })).toBe(false);
  });
  it("a hand-built context without `established` is not eligible (fail-closed)", () => {
    expect(sectorRuleApplies({ isInfluencer: false, measuredFromBuy: false, mixedWithMain: false })).toBe(false);
  });
});

describe("judgeSectorStops — the 2026-11-20 replay", () => {
  // 1pm ET 11-20: equal-weight tech peers about -4.4%. MU and DELL fell WITH the sector; SNDK fell
  // 10.4 points worse. Before the fix all three were sold; MU and DELL must be held, SNDK sold.
  // A small illustrative sector, built so the excesses land where the 11-20 ones did (MU ~-9.5, DELL
  // ~-6.8 — held; SNDK ~-11.8 — sold). The live sector had 84 peers averaging about -4.4%.
  const T: Record<string, string> = Object.fromEntries(["MU", "DELL", "SNDK", "PLTR", "A1", "A2", "A3", "A4", "A5", "A6"].map((s) => [s, "XLK"]));
  const snap = [
    { symbol: "MU", change1d: -12.5 }, { symbol: "DELL", change1d: -10.1 }, { symbol: "SNDK", change1d: -14.5 }, { symbol: "PLTR", change1d: -2 },
    ...["A1", "A2", "A3", "A4", "A5", "A6"].map((symbol) => ({ symbol, change1d: 0 })),
  ];
  const main = buildExitContext({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: true });
  const sleeve = buildExitContext({ isInfluencer: true, mainOwned: false, boughtToday: false, canMeasureFromBuy: true });
  const e = (symbol: string, change1d: number, ctx = main) => ({ symbol, reason: "stop" as const, change1d, ctx });
  const peerOf = (s: string) => sectorPeerMove(s, snap, (x) => T[x])!;

  it("holds MU and DELL, sells SNDK, and leaves the sleeve name to its own rule", () => {
    const j = judgeSectorStops([e("MU", -12.5), e("DELL", -10.1), e("SNDK", -14.5), e("PLTR", -11.3, sleeve)], snap, (x) => T[x]);
    expect(j.map((x) => [x.symbol, x.held])).toEqual([["MU", true], ["DELL", true], ["SNDK", false]]);
    expect(-14.5 - peerOf("SNDK")).toBeLessThanOrEqual(MAIN_SECTOR_EXCESS_PCT);
  });
  it("a stop with an unknown sector move is RETURNED (not held), so the run can say so", () => {
    const j = judgeSectorStops([e("ZZZ", -12)], [], () => undefined);
    expect(j).toEqual([{ symbol: "ZZZ", change: -12, peer: null, held: false }]);
  });
  it("the name is judged on its TRIGGER move, never on the snapshot's row for it", () => {
    // market-data writes change1d 0 for a missing prev close; reading that would turn a -15% crash
    // into "flat" and hold it. The figure that breached the bar is the one judged.
    const broken = snap.map((r) => (r.symbol === "SNDK" ? { ...r, change1d: 0 } : r));
    const [j] = judgeSectorStops([e("SNDK", -14.5)], broken, (x) => T[x]);
    expect(j.change).toBe(-14.5);
    expect(j.held).toBe(false);
  });
  it("take-profits are never judged", () => {
    expect(judgeSectorStops([{ ...e("MU", 45), reason: "profit" as const }], snap, (x) => T[x])).toEqual([]);
  });
});

describe("drop-check wiring", () => {
  const s = readFileSync("app/api/drop-check/route.ts", "utf8");
  it("routes the sector pass through judgeSectorStops on each entry's ctx, before the sympathy call", () => {
    // 2026-11-20: the gate read `e.bar !== "main"`, the label came from comparing two equal (-10)
    // thresholds, every name read "influencer", and the hold never ran. Routing must not read a label.
    const at = s.indexOf("judgeSectorStops(");
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 300)).toContain("ctx: e.ctx");
    expect(s).not.toMatch(/e\.bar\s*[!=]==|e\.basis\s*[!=]==/);
    expect(s).not.toMatch(/stopThresholdFor\(ctx\)\s*===/);
    expect(at).toBeLessThan(s.indexOf("RISK-EXIT DECISION"));
  });
  it("the run summary names the stops the sector rule did NOT hold, with the figures", () => {
    expect(s).toContain("NOT held by the sector-relative stop");
    expect(s).toContain("(sector move unknown)");
  });
  it("sector-held names are excluded from the model's list and seeded into the holds", () => {
    expect(s).toMatch(/filter\(\(e\) => e\.reason === "stop" && !sectorHolds\.has\(e\.position\.symbol\)\)/);
    expect(s).toContain("new Set<string>(sectorHolds.keys())");
  });
  it("the run summary says which names the sector rule held", () => {
    expect(s).toContain("HELD by the sector-relative stop");
  });
  it("the prompt's bar label names a main-book holding 'main' (it read 'influencer' for every name before 2026-11-20)", () => {
    const main = buildExitContext({ isInfluencer: false, mainOwned: true, boughtToday: false, canMeasureFromBuy: true });
    expect(stopBarFor(main)).toBe("main");
    expect(s).toMatch(/const bar = stopBarFor\(ctx\) === "sleeve" \? "influencer" : "main";/);
  });
});
