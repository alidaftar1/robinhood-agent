import { describe, expect, test } from "bun:test";
import { isNoCikImplausible, NO_CIK_SUSPECT_FRACTION, isUsableTickerMap, MIN_TICKER_MAP } from "../lib/quality";

// `staleUniverse` exists to drive a manual DELETION from the tradable universe, so a false entry
// removes a LIVE name. It is derived purely from a missing CIK, and isUsableTickerMap only requires
// 1000 entries against SEC's real ~10k file — so a TRUNCATED-but-"usable" map makes hundreds of live
// tickers look dead. A stubbed map printed 449 of 449. The bound distinguishes the two causes.
describe("isNoCikImplausible", () => {
  test("the ~20 genuinely-dead names in a ~450 universe are NOT suspect", () => {
    expect(isNoCikImplausible(20, 449)).toBe(false);
  });

  test("a truncated ticker map naming most of the universe IS suspect", () => {
    expect(isNoCikImplausible(449, 449)).toBe(true);
    expect(isNoCikImplausible(200, 449)).toBe(true);
  });

  test("zero missing CIKs is never suspect", () => {
    expect(isNoCikImplausible(0, 449)).toBe(false);
  });

  test("the threshold sits ABOVE observed attrition and BELOW a truncation", () => {
    // ~22 of 449 at 5%. Must not flag normal attrition, must flag a broken read.
    expect(Math.floor(NO_CIK_SUSPECT_FRACTION * 449)).toBeGreaterThan(20);
    expect(NO_CIK_SUSPECT_FRACTION).toBeLessThan(0.5);
  });

  test("an empty universe is suspect, never reported as a clean prune list", () => {
    // Dividing by zero would otherwise yield NaN, and NaN > x is false — i.e. "not suspect",
    // which would present a bogus list as actionable.
    expect(isNoCikImplausible(0, 0)).toBe(true);
    expect(isNoCikImplausible(5, 0)).toBe(true);
  });

  test("the ticker-map floor is far looser than the SEC file, which is WHY this bound exists", () => {
    // 1000 of ~10,000 passes isUsableTickerMap while being 90% truncated.
    expect(isUsableTickerMap(Object.fromEntries(Array.from({ length: MIN_TICKER_MAP }, (_, i) => [`T${i}`, i])))).toBe(true);
    expect(MIN_TICKER_MAP).toBeLessThan(5000);
  });
});
