import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sectorPeerMove, heldBySectorRule, MAIN_SECTOR_EXCESS_PCT, MIN_SECTOR_PEERS, MAIN_DROP_THRESHOLD_PCT } from "@/lib/stopouts";

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

describe("drop-check wiring", () => {
  const s = readFileSync("app/api/drop-check/route.ts", "utf8");
  it("applies the sector rule only to MAIN same-day stops, before the model's sympathy call", () => {
    const at = s.indexOf("heldBySectorRule(e.change1d, peer)");
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at - 500, at)).toMatch(/e\.reason !== "stop" \|\| e\.bar !== "main" \|\| e\.basis !== "same-day"/);
    expect(at).toBeLessThan(s.indexOf("RISK-EXIT DECISION"));
  });
  it("sector-held names are excluded from the model's list and seeded into the holds", () => {
    expect(s).toMatch(/filter\(\(e\) => e\.reason === "stop" && !sectorHolds\.has\(e\.position\.symbol\)\)/);
    expect(s).toContain("new Set<string>(sectorHolds.keys())");
  });
  it("the run summary says which names the sector rule held", () => {
    expect(s).toContain("HELD by the sector-relative stop");
  });
});
