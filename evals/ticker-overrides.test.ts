import { describe, expect, test } from "bun:test";
import { applyTickerOverrides, TICKER_CIK_OVERRIDES, MIN_TICKER_MAP } from "../lib/quality";

// Three LIVE S&P names (BK, MMC, FI) were withheld from the quality screen — and so unbuyable —
// purely over a symbol mismatch with SEC's ticker file. Verified 2026-10-02 against SEC's own data:
// AAPL/MSFT/NVDA/PLTR resolve (parser is fine), while these three are absent by ticker AND by
// company name, because each company renamed its ticker in one direction or the other.
/** A map that clears the usability floor, since applyTickerOverrides refuses to touch a truncated one. */
function usableMap(extra: Record<string, number> = {}): Record<string, number> {
  const m: Record<string, number> = {};
  for (let i = 0; i < MIN_TICKER_MAP; i++) m[`FILLER${i}`] = 100000 + i;
  return { ...m, ...extra };
}

describe("applyTickerOverrides", () => {
  test("fills a symbol SEC has no row for", () => {
    const map = usableMap({ AAPL: 320193 });
    const r = applyTickerOverrides(map, { BK: 1390777 });
    expect(map.BK).toBe(1390777);
    expect(r.applied).toEqual(["BK"]);
    expect(r.shadowed).toEqual([]);
  });

  test("NEVER overrides a symbol SEC already carries — SEC always wins", () => {
    // The dangerous case: a ticker gets REUSED by a different company. If SEC maps BK itself, that
    // mapping is current and ours is stale; scoring the wrong company's fundamentals under our
    // symbol would produce a wrong BUY, not merely a missing one.
    const map = usableMap({ BK: 999999 });
    const r = applyTickerOverrides(map, { BK: 1390777 });
    expect(map.BK).toBe(999999);
    expect(r.applied).toEqual([]);
    expect(r.shadowed).toEqual(["BK"]);
  });

  test("reports shadowed overrides so a stale entry can be retired", () => {
    const map = usableMap({ MMC: 62709 });
    expect(applyTickerOverrides(map, { MMC: 62709 }).shadowed).toEqual(["MMC"]);
  });

  test("leaves every other symbol untouched", () => {
    const map = usableMap({ AAPL: 320193, MSFT: 789019 });
    applyTickerOverrides(map, { BK: 1390777 });
    expect(map.AAPL).toBe(320193);
    expect(map.MSFT).toBe(789019);
    expect(map.BK).toBe(1390777);
  });

  test("the shipped table covers exactly the three verified renames, with real CIKs", () => {
    expect(Object.keys(TICKER_CIK_OVERRIDES).sort()).toEqual(["BK", "FI", "MMC"]);
    // Read from SEC's own rows: BNY / MRSH / FISV.
    expect(TICKER_CIK_OVERRIDES.BK).toBe(1390777);
    expect(TICKER_CIK_OVERRIDES.MMC).toBe(62709);
    expect(TICKER_CIK_OVERRIDES.FI).toBe(798354);
  });

  test("every override is a plausible CIK — a zero or negative would resolve to nothing", () => {
    for (const [sym, cik] of Object.entries(TICKER_CIK_OVERRIDES)) {
      expect(Number.isInteger(cik)).toBe(true);
      expect(cik).toBeGreaterThan(0);
      expect(sym).toMatch(/^[A-Z.-]{1,6}$/);
    }
  });

  test("an empty override table is a no-op, not a wipe", () => {
    const map = usableMap({ AAPL: 320193 });
    const r = applyTickerOverrides(map, {});
    expect(map.AAPL).toBe(320193);
    expect(r).toEqual({ applied: [], shadowed: [] });
  });
});

// A truncated SEC read must not be topped up into looking healthy. The call site sits after the
// usability check, but that is line ORDERING — a mutation sweep moved the call above the check and
// no test could see it. The refusal lives in the function so the ordering cannot matter.
describe("applyTickerOverrides refuses a truncated map", () => {
  test("a map below the usability floor is left completely untouched", () => {
    const tiny: Record<string, number> = { AAPL: 320193 };
    const r = applyTickerOverrides(tiny, { BK: 1390777 });
    expect(r.refused).toBe(true);
    expect(r.applied).toEqual([]);
    expect(tiny.BK).toBeUndefined();
    expect(Object.keys(tiny)).toEqual(["AAPL"]);
  });

  test("so overrides can never lift a truncated map over the floor", () => {
    const justUnder: Record<string, number> = {};
    for (let i = 0; i < MIN_TICKER_MAP - 1; i++) justUnder[`T${i}`] = i + 1;
    applyTickerOverrides(justUnder, { BK: 1390777, MMC: 62709, FI: 798354 });
    expect(Object.keys(justUnder).length).toBe(MIN_TICKER_MAP - 1);
  });

  test("a healthy map is still served", () => {
    const ok = usableMap();
    expect(applyTickerOverrides(ok, { BK: 1390777 }).refused).toBeUndefined();
    expect(ok.BK).toBe(1390777);
  });
});
