import { describe, test, expect } from "bun:test";
import { buildFeatureRows, recordFeatureCapture, storedLengthOf, missingCaptureWeekdays, CAPTURE_COLUMNS, CAPTURE_KEY_PREFIX } from "@/lib/feature-capture";
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
    expect(recordFeatureCapture([], "2026-09-29", { capturedAt: "2026-09-29T14:30:00Z", spyPrice: 773.5 }))
      .resolves.toMatchObject({ written: 0, skipped: "no rows" });
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

  test("EVERY column lands in its declared position — a reorder must fail this", () => {
    // The previous version of this file only caught a LENGTH mismatch: nine columns shared the
    // value 0 in the fixture, so any permutation among them passed. Give every field a distinct
    // value and assert the whole row, which is the only thing that catches an insertion or swap.
    const rows = buildFeatureRows(
      [stock({
        symbol: "UNIQ", price: 1, change5d: 2, change14d: 3, change30d: 4,
        volatility30d: 5, beta: 6, sharpe5d: 7, sharpe14d: 8, sharpe30d: 9,
        distFrom52wHigh: 10, relStrength5d: 11, relStrength30d: 12, mom12_1: 13,
      })],
      () => 14, () => ({ peTTM: 15, peFY: 16 }), () => 17,
    );
    expect(rows[0]).toEqual([
      "UNIQ", 1,          // symbol, price
      13, 2, 3, 4,        // mom12_1, change5d, change14d, change30d
      5, 6,               // volatility30d, beta
      7, 8, 9,            // sharpe5d, sharpe14d, sharpe30d
      10, 11, 12,         // distFrom52wHigh, relStrength5d, relStrength30d
      14, 15, 16, 17,     // qualityPct, peTTM, peFY, daysToEarnings
    ]);
    // And the labels must still describe those positions.
    expect([...CAPTURE_COLUMNS]).toEqual([
      "symbol", "price", "mom12_1", "change5d", "change14d", "change30d",
      "volatility30d", "beta", "sharpe5d", "sharpe14d", "sharpe30d",
      "distFrom52wHigh", "relStrength5d", "relStrength30d",
      "qualityPct", "peTTM", "peFY", "daysToEarnings",
    ]);
  });

  test("zero volatility is recorded as NULL — it is a broken-series sentinel, not a fact", () => {
    // annualizedVol returns 0 for a series with <3 closes, and market-data coerces the change and
    // distFrom52wHigh columns to 0 too. Left as-is that row reads "flat and at its 52-week high":
    // the strongest momentum signal in the set, manufactured from missing data.
    const rows = buildFeatureRows([stock({ volatility30d: 0 })], noQuality, noPe, noEarn);
    expect(rows[0][CAPTURE_COLUMNS.indexOf("volatility30d")]).toBeNull();
  });

  test("a real distFrom52wHigh of 0 is KEPT — a new high is not missing data", () => {
    // Deliberately not nulled: 0 there is genuinely common (a name printing a new high), so
    // mapping it would destroy real signal to catch a rare sentinel.
    const rows = buildFeatureRows([stock({ distFrom52wHigh: 0, volatility30d: 25 })], noQuality, noPe, noEarn);
    expect(rows[0][CAPTURE_COLUMNS.indexOf("distFrom52wHigh")]).toBe(0);
  });

  test("an unverified write is detectable — storedLengthOf reads the pipeline's STRLEN", () => {
    // redisPost never checks res.ok and a pipeline response is an ARRAY, so a 429/413 resolves
    // normally. Without this the log would report "503 rows written" on a day nothing was stored.
    expect(storedLengthOf([{ result: "OK" }, { result: 1234 }])).toBe(1234);
    expect(storedLengthOf([{ result: "OK" }, 1234])).toBe(1234);
    // Every shape that does NOT prove a write must read as unverified, never as success.
    expect(storedLengthOf([{ error: "ERR max requests" }])).toBeNull();
    expect(storedLengthOf({ error: "429" })).toBeNull();
    expect(storedLengthOf(null)).toBeNull();
    expect(storedLengthOf([{ result: "OK" }, { result: null }])).toBeNull();
  });
});

describe("capture health must not cry wolf", () => {
  // A stalled capture has no error and no alert — a thinner dataset months later is its only
  // symptom. But a card that lights red on weekends, holidays, launch week, or every morning
  // before the cron trains you to ignore the one signal that matters. These test the REAL
  // function, not a re-implementation of its predicate.
  const probe = (from: string, n = 14) =>
    Array.from({ length: n }, (_, i) =>
      new Date(Date.parse(`${from}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));

  test("a genuine weekday stall IS reported", () => {
    // Captured Mon 09-28, nothing Tue 09-29 — and "today" is Wed 09-30, so Tuesday is a real gap.
    const gaps = missingCaptureWeekdays(probe("2026-09-30"), new Set(["2026-09-28"]), "2026-09-30");
    expect(gaps).toContain("2026-09-29");
  });

  test("weekends are never gaps", () => {
    const gaps = missingCaptureWeekdays(probe("2026-09-30"), new Set(["2026-09-25"]), "2026-09-30");
    expect(gaps).not.toContain("2026-09-26");   // Sat
    expect(gaps).not.toContain("2026-09-27");   // Sun
  });

  test("TODAY is never a gap — the cron runs at 14:30 UTC", () => {
    // Otherwise the card is red from midnight UTC until mid-morning ET on every trading day:
    // roughly 14 hours out of every 24, with nothing wrong.
    const gaps = missingCaptureWeekdays(probe("2026-09-30"), new Set(["2026-09-29"]), "2026-09-30");
    expect(gaps).not.toContain("2026-09-30");
  });

  test("days BEFORE the first capture are not gaps", () => {
    // Without this the card opens on ~21 missing weekdays the day the feature ships, and decays
    // red for a month.
    const gaps = missingCaptureWeekdays(probe("2026-09-30"), new Set(["2026-09-29"]), "2026-09-30");
    expect(gaps).toEqual([]);
    expect(gaps).not.toContain("2026-09-21");
  });

  test("nothing captured at all reads as 'never', not as a stall", () => {
    expect(missingCaptureWeekdays(probe("2026-09-30"), new Set(), "2026-09-30")).toEqual([]);
  });

  test("a market holiday is not a gap", () => {
    // ~10 a year; a naive weekday test would keep the card red for 30 days after each one.
    const thanksgiving = "2026-11-26";
    const gaps = missingCaptureWeekdays(
      probe("2026-11-30"), new Set(["2026-11-25", "2026-11-27"]), "2026-11-30",
    );
    expect(gaps).not.toContain(thanksgiving);
  });
});
