import { describe, test, expect } from "bun:test";
import { buildFeatureRows, recordFeatureCapture, CAPTURE_COLUMNS, CAPTURE_KEY_PREFIX } from "@/lib/feature-capture";
import type { StockData } from "@/lib/market-data";

// Phase 0 of docs/experiment-nori-tail-risk.md. The capture exists because the run computes these
// features and discards them, and a clock like this cannot be started retroactively — so the thing
// that matters most is that a row, once written, is still readable and correctly labelled later.
const stock = (o: Partial<StockData>): StockData => ({
  symbol: "AAA", price: 100, change1d: 0, change5d: 0, change14d: 0, change30d: 0,
  distFrom52wHigh: -5, volatility30d: 20, sharpe5d: 0, sharpe14d: 0, sharpe30d: 0,
  mom12_1: 10, beta: 1, earningsDate: null,
  relStrength1d: 0, relStrength5d: 0, relStrength14d: 0, relStrength30d: 0, ...o,
});
const noQuality = () => null;
const noPe = () => ({ peTTM: null, peFY: null });
const noEarn = () => null;

describe("feature capture preserves what the run would otherwise throw away", () => {
  test("a row is positional and matches the column list exactly", () => {
    // Rows are stored WITHOUT field names, so a length mismatch silently shifts every value.
    const rows = buildFeatureRows([stock({})], noQuality, noPe, noEarn);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(CAPTURE_COLUMNS.length);
    expect(rows[0][CAPTURE_COLUMNS.indexOf("symbol")]).toBe("AAA");
    expect(rows[0][CAPTURE_COLUMNS.indexOf("price")]).toBe(100);
  });

  test("symbol and price lead the columns — the two a forward return cannot be scored without", () => {
    expect(CAPTURE_COLUMNS[0]).toBe("symbol");
    expect(CAPTURE_COLUMNS[1]).toBe("price");
  });

  test("a row with no usable price is dropped, not stored unscoreable", () => {
    const rows = buildFeatureRows(
      [stock({ symbol: "OK" }), stock({ symbol: "ZERO", price: 0 }), stock({ symbol: "NAN", price: NaN })],
      noQuality, noPe, noEarn,
    );
    expect(rows.map(r => r[0])).toEqual(["OK"]);
  });

  test("nulls are preserved as null, never coerced to 0", () => {
    // mom12_1 null means "insufficient history"; 0 means "flat over a year". Collapsing them
    // would silently teach a model that new listings are flat performers.
    const rows = buildFeatureRows([stock({ mom12_1: null, beta: null })], noQuality, noPe, noEarn);
    expect(rows[0][CAPTURE_COLUMNS.indexOf("mom12_1")]).toBeNull();
    expect(rows[0][CAPTURE_COLUMNS.indexOf("beta")]).toBeNull();
    expect(rows[0][CAPTURE_COLUMNS.indexOf("qualityPct")]).toBeNull();
  });

  test("a missing P/E reads as null — most universe rows will have none, and that is accurate", () => {
    // Valuation covers shortlist + held only, so a null here is the true state, not a gap.
    const withPe = buildFeatureRows([stock({ symbol: "HAS" })], noQuality,
      () => ({ peTTM: 21.5, peFY: 24 }), noEarn);
    expect(withPe[0][CAPTURE_COLUMNS.indexOf("peTTM")]).toBe(21.5);
    const without = buildFeatureRows([stock({ symbol: "NONE" })], noQuality, noPe, noEarn);
    expect(without[0][CAPTURE_COLUMNS.indexOf("peTTM")]).toBeNull();
  });

  test("an empty universe writes NOTHING rather than an empty day", () => {
    // An empty day would read later as "the market had no names", which is never true — it means
    // the upstream fetch failed. Absence is the honest record.
    expect(recordFeatureCapture([], "2026-09-29")).resolves.toMatchObject({ written: 0, skipped: "no rows" });
  });

  test("the payload stays small enough to be worth doing daily", () => {
    // The whole argument for Phase 0 is that it is cheap. ~500 rows must stay well inside a single
    // Redis value; if this ever fails, the capture has grown into something needing its own case.
    const rows = buildFeatureRows(
      Array.from({ length: 500 }, (_, i) => stock({ symbol: `S${i}`, price: 123.4567, mom12_1: 12.3456 })),
      () => 0.5123, () => ({ peTTM: 20.1234, peFY: 22.5 }), () => 14,
    );
    const bytes = JSON.stringify({ v: 1, date: "2026-09-29", columns: CAPTURE_COLUMNS, rows }).length;
    expect(rows).toHaveLength(500);
    expect(bytes).toBeLessThan(150_000);   // ~75KB expected; 150KB is the alarm, not the target
  });

  test("the key is per-DAY, so one bad write cannot damage the history", () => {
    // Deliberately unlike the meanrev/giveback shadows, which read-modify-write one growing blob.
    expect(`${CAPTURE_KEY_PREFIX}2026-09-29`).toBe("robinhood:feature-capture:2026-09-29");
  });
});
