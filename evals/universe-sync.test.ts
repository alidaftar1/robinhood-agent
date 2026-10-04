import { describe, expect, test } from "bun:test";
import { sectorToEtf, planUniverseSync, SHARADAR_SECTOR_TO_ETF, type SyncCandidate } from "../lib/sharadar-universe";
import { SECTOR_ETFS } from "../lib/market-data";

// STOCK_SECTOR is the BUY universe and its value feeds the sector cap, so every gate here fails
// closed: a name that cannot be placed, priced or CIK-resolved is rejected WITH a reason rather than
// added on partial information.
describe("sectorToEtf", () => {
  test("every Sharadar sector maps to a REAL ETF the sector cap knows about", () => {
    for (const [sector, etf] of Object.entries(SHARADAR_SECTOR_TO_ETF)) {
      expect(SECTOR_ETFS[etf], `${sector} -> ${etf} must exist in SECTOR_ETFS`).toBeDefined();
    }
    // All 11 ETFs covered, so no sector silently has nowhere to go.
    expect(new Set(Object.values(SHARADAR_SECTOR_TO_ETF)).size).toBe(Object.keys(SECTOR_ETFS).length);
  });

  test("an unknown or missing sector yields null, never a default bucket", () => {
    expect(sectorToEtf("Crypto")).toBeNull();
    expect(sectorToEtf(undefined)).toBeNull();
    expect(sectorToEtf("")).toBeNull();
  });

  test("tolerates surrounding whitespace from a CSV field", () => {
    expect(sectorToEtf(" Technology ")).toBe("XLK");
  });
});

describe("planUniverseSync", () => {
  const ok = (ticker: string, sector: string): SyncCandidate => ({ ticker, sector, priced: true, hasCik: true });
  const base = {
    indexMembers: new Set(["AAPL", "AVGO"]),
    ourUniverse: new Set(["AAPL", "ANSS"]),
    candidates: [ok("AVGO", "Technology")],
    held: new Set<string>(),
  };

  test("adds an index member we lack, with its mapped ETF", () => {
    const p = planUniverseSync(base);
    expect(p.add).toEqual([{ ticker: "AVGO", etf: "XLK" }]);
  });

  test("removes one of ours no longer in the index", () => {
    expect(planUniverseSync(base).remove).toEqual(["ANSS"]);
  });

  test("a HELD name is never removed — that would read as 'fell off the shortlist' and authorise a SELL", () => {
    const p = planUniverseSync({ ...base, held: new Set(["ANSS"]) });
    expect(p.remove).toEqual([]);
    expect(p.heldBlocked).toEqual(["ANSS"]);
  });

  test("an unmapped sector is REJECTED with a reason, not added to a default bucket", () => {
    const p = planUniverseSync({ ...base, candidates: [{ ticker: "AVGO", sector: "Crypto", priced: true, hasCik: true }] });
    expect(p.add).toEqual([]);
    expect(p.rejected[0]).toMatchObject({ ticker: "AVGO" });
    expect(p.rejected[0].reason).toContain("unmapped sector");
  });

  test("an unpriceable name is rejected — it could never be ranked", () => {
    const p = planUniverseSync({ ...base, candidates: [{ ticker: "AVGO", sector: "Technology", priced: false, hasCik: true }] });
    expect(p.add).toEqual([]);
    expect(p.rejected[0].reason).toContain("no live quote");
  });

  test("a name with no CIK is rejected — the quality screen would withhold it forever", () => {
    const p = planUniverseSync({ ...base, candidates: [{ ticker: "AVGO", sector: "Technology", priced: true, hasCik: false }] });
    expect(p.add).toEqual([]);
    expect(p.rejected[0].reason).toContain("no CIK");
  });

  test("a candidate with no Sharadar row at all is rejected, not skipped silently", () => {
    const p = planUniverseSync({ ...base, candidates: [] });
    expect(p.add).toEqual([]);
    expect(p.rejected).toEqual([{ ticker: "AVGO", reason: "no Sharadar row" }]);
  });

  test("a RENAME is neither added nor removed — it is one company under two spellings", () => {
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL", "BNY"]),
      ourUniverse: new Set(["AAPL", "BK"]),
      candidates: [ok("BNY", "Financial Services")],
      held: new Set(),
      renames: { BK: "BNY" },
    });
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  // Nothing re-validated KEPT entries, which is how BK/MMC/FI/ABC sat in the universe 404ing on
  // every quote with no sync ever saying so.
  test("a kept entry that no longer prices is REPORTED as degraded", () => {
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL"]),
      ourUniverse: new Set(["AAPL"]),
      candidates: [{ ticker: "AAPL", sector: "Technology", priced: false, hasCik: true }],
      held: new Set(),
    });
    expect(p.degraded).toEqual([{ ticker: "AAPL", reason: "no live quote" }]);
  });

  test("a kept entry that no longer resolves a CIK is reported too", () => {
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL"]),
      ourUniverse: new Set(["AAPL"]),
      candidates: [{ ticker: "AAPL", sector: "Technology", priced: true, hasCik: false }],
      held: new Set(),
    });
    expect(p.degraded[0].reason).toContain("no CIK");
  });

  test("a degraded KEPT entry is never auto-removed — it is still an index member", () => {
    // priced:false cannot tell a 404 from a timeout, and dropping an index member on a flaky fetch
    // is worse than carrying it. Report, do not act.
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL"]),
      ourUniverse: new Set(["AAPL"]),
      candidates: [{ ticker: "AAPL", sector: "Technology", priced: false, hasCik: false }],
      held: new Set(),
    });
    expect(p.remove).toEqual([]);
    expect(p.degraded.length).toBe(1);
  });

  test("a healthy kept entry is not reported", () => {
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL"]),
      ourUniverse: new Set(["AAPL"]),
      candidates: [{ ticker: "AAPL", sector: "Technology", priced: true, hasCik: true }],
      held: new Set(),
    });
    expect(p.degraded).toEqual([]);
  });

  test("no candidate row for a kept entry means NOT CHECKED, never a failure", () => {
    const p = planUniverseSync({
      indexMembers: new Set(["AAPL"]), ourUniverse: new Set(["AAPL"]), candidates: [], held: new Set(),
    });
    expect(p.degraded).toEqual([]);
  });

  test("nothing to do is an empty plan, not an error", () => {
    const p = planUniverseSync({ indexMembers: new Set(["AAPL"]), ourUniverse: new Set(["AAPL"]), candidates: [], held: new Set() });
    expect(p).toEqual({ add: [], remove: [], rejected: [], heldBlocked: [], degraded: [] });
  });
});
