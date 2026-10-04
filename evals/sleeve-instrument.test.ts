import { describe, expect, test } from "bun:test";
import { isSleeveEligibleInstrument, SLEEVE_ALLOWED_INSTRUMENTS, fetchMomentum } from "../lib/market-data";
import { SP500_UNIVERSE } from "../lib/strategy";

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
    // (SPCX used to be asserted allowed here as an off-index EQUITY. It is now excluded by S&P
    // MEMBERSHIP instead — see the universe test below. The instrument check still stands on its
    // own for malformed or untyped responses.)
  }, 30_000);
});

// S&P-ONLY, owner's call 2026-10-04 on the realised split once sell tagging was fixed (+$35.06 on
// S&P names, -$8.22 off-index across nine closed positions — thin, and recorded as a judgement).
// Independent of the P&L it also makes every sleeve name inherit the main book's data: a CIK and so
// a quality score, analyst actions, earnings signals, and a sector for the risk panel.
describe("the sleeve universe is the S&P universe", () => {
  test("an off-index equity is no longer a candidate", async () => {
    const aapl = await fetchMomentum("AAPL");
    if (!aapl) return; // Yahoo unreachable
    // NBIS is a real company that quotes fine — excluded now by MEMBERSHIP, not by type. (SK turned
    // out to be an ETF, so it is caught a step earlier; SPCX is the clean membership-only case.)
    for (const t of ["NBIS", "SPCX"]) {
      expect(await fetchMomentum(t), `${t} is off-index and must not be a sleeve candidate`).toBeNull();
    }
  }, 30_000);

  test("S&P members still resolve", async () => {
    const nvda = await fetchMomentum("NVDA");
    if (!nvda) return;
    expect(nvda.price).toBeGreaterThan(0);
    expect((await fetchMomentum("AVGO"))?.price ?? 0).toBeGreaterThan(0);
  }, 30_000);

  test("every current sleeve holding is inside the new universe — nothing is orphaned", () => {
    // A universe rule must never force a sale; this pins that the restriction was safe to apply.
    const u = new Set(SP500_UNIVERSE);
    for (const held of ["NVDA", "AVGO"]) expect(u.has(held), `${held} is held by the sleeve`).toBe(true);
  });
});
