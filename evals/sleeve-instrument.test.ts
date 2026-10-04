import { describe, expect, test } from "bun:test";
import { isSleeveEligibleInstrument, SLEEVE_ALLOWED_INSTRUMENTS, fetchMomentum } from "../lib/market-data";

// The sleeve was buying ETFs and trusts on YouTube conviction. Of 50 tracked picks, QQQ/SCHD/VTWO
// are index funds and BTC resolves to the Grayscale Bitcoin Mini Trust — none has fundamentals,
// none can be quality-screened, and "a creator mentioned the Nasdaq" is not a stock pick.
describe("isSleeveEligibleInstrument", () => {
  test("EQUITY is allowed", () => {
    expect(isSleeveEligibleInstrument("EQUITY")).toBe(true);
  });

  test("ETFs, crypto and indices are not", () => {
    for (const t of ["ETF", "CRYPTOCURRENCY", "INDEX", "MUTUALFUND", "CURRENCY", "FUTURE"]) {
      expect(isSleeveEligibleInstrument(t), `${t} must not be sleeve-eligible`).toBe(false);
    }
  });

  test("an ABSENT type is rejected — admitting an untyped instrument is the fail-open direction", () => {
    expect(isSleeveEligibleInstrument(undefined)).toBe(false);
    expect(isSleeveEligibleInstrument(null)).toBe(false);
    expect(isSleeveEligibleInstrument("")).toBe(false);
  });

  test("the allowlist is exactly EQUITY — widening it is a deliberate act, not a typo", () => {
    expect([...SLEEVE_ALLOWED_INSTRUMENTS]).toEqual(["EQUITY"]);
  });

  test("matching is exact, not case- or prefix-insensitive", () => {
    expect(isSleeveEligibleInstrument("equity")).toBe(false);
    expect(isSleeveEligibleInstrument("EQUITY_FUND")).toBe(false);
  });
});

// Live check against the real symbols that motivated this. Skipped automatically if Yahoo is
// unreachable, so a network blip cannot fail CI.
describe("fetchMomentum rejects non-equities end to end", () => {
  test("ETFs return null while real stocks return a signal", async () => {
    const aapl = await fetchMomentum("AAPL");
    if (!aapl) return; // Yahoo unreachable — nothing to assert
    expect(aapl.price).toBeGreaterThan(0);
    for (const etf of ["QQQ", "SCHD", "VTWO", "BTC"]) {
      expect(await fetchMomentum(etf), `${etf} is not an equity and must not become a sleeve candidate`).toBeNull();
    }
    // An off-index single stock is still allowed — that is what the sleeve is for.
    const spcx = await fetchMomentum("SPCX");
    expect(spcx?.price ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
