import { describe, test, expect } from "bun:test";
import { combineTtm } from "@/lib/quality";

// TTM = annual + Σ(currentQ − priorQ). The construction deliberately avoids Q4 duration frames,
// which are structurally sparse because companies file a 10-K for the year rather than a 10-Q for
// Q4 — so summing four quarters would fail the population floor for the whole universe.
//
// The guard that matters most is the per-company fail-safe: a missing quarter must cause the company
// to be WITHHELD — dropped entirely — not scored on a partial sum and not scored on its stale annual
// figure.
//
// Why withholding rather than falling back, since the annual IS a real number: the fallback's error
// is asymmetric. A stale annual can wrongly EXCLUDE a company that has since recovered (a missed
// opportunity — safe) but it can equally wrongly INCLUDE one that has since DETERIORATED, whose
// year-old figures still look strong while recent quarters collapsed. That branch puts money into a
// name for a reason no longer true. These tests were originally written asserting the FALLBACK and
// were flipped when the direction was corrected.

const CIK = 320193;

describe("combineTtm arithmetic", () => {
  test("adds the year-to-date stub and subtracts the same quarters a year earlier", () => {
    // annual 100; this year Q1 30 Q2 40; last year Q1 20 Q2 25 → 100 + (30−20) + (40−25) = 125
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: 30 }, { [CIK]: 40 }], [{ [CIK]: 20 }, { [CIK]: 25 }]);
    expect(r.ni[CIK]).toBe(125);
    expect(r.ttmCount).toBe(1);
    expect(r.withheldCount).toBe(0);
  });

  test("a DECLINING business produces a TTM BELOW its annual", () => {
    // The direction has to work both ways, or the change would only ever flatter.
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: 5 }], [{ [CIK]: 30 }]);
    expect(r.ni[CIK]).toBe(75);
  });

  test("a swing from loss to profit is reflected — the 2022 energy case", () => {
    // DVN-shaped: a big annual loss, with recent quarters sharply positive.
    const r = combineTtm({ [CIK]: -2680 }, [{ [CIK]: 900 }, { [CIK]: 1000 }], [{ [CIK]: -700 }, { [CIK]: -400 }]);
    expect(r.ni[CIK]).toBe(-2680 + (900 - -700) + (1000 - -400));   // = +320, now profitable
    expect(r.ni[CIK]).toBeGreaterThan(0);
  });

  test("exact match against the verified NVDA case", () => {
    // Cross-checked against Sharadar ART on 2026-09-30: SEC-derived TTM matched to 0.0%.
    const annual = 120.07, c1 = 44.0, c2 = 46.0, p1 = 8.0, p2 = 9.19;
    const r = combineTtm({ [CIK]: annual }, [{ [CIK]: c1 }, { [CIK]: c2 }], [{ [CIK]: p1 }, { [CIK]: p2 }]);
    expect(r.ni[CIK]).toBeCloseTo(annual + (c1 - p1) + (c2 - p2), 6);
  });
});

describe("the per-company fail-safe", () => {
  test("a missing CURRENT quarter WITHHOLDS the company — no annual fallback, no partial sum", () => {
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: 30 }, {}], [{ [CIK]: 20 }, { [CIK]: 25 }]);
    expect(r.ni[CIK]).toBeUndefined();   // not 110 (partial), and not 100 (stale annual)
    expect(r.withheldCount).toBe(1);
    expect(r.ttmCount).toBe(0);
  });

  test("a missing PRIOR-year quarter also withholds", () => {
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: 30 }], [{}]);
    expect(r.ni[CIK]).toBeUndefined();
  });

  test("a non-finite value withholds rather than producing NaN", () => {
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: NaN }], [{ [CIK]: 20 }]);
    expect(r.ni[CIK]).toBeUndefined();
    // And nothing NaN leaks into the map at all — a NaN ratio would poison the percentile sort.
    expect(Object.values(r.ni).every(Number.isFinite)).toBe(true);
  });

  test("THE DANGEROUS CASE the withholding exists for: a DETERIORATING company is not admitted on its stale annual", () => {
    // Annual was strongly profitable; the recent quarter that would reveal the collapse is missing.
    // Falling back would score it on last year's strength and could make it ELIGIBLE to buy.
    const r = combineTtm({ [CIK]: 5000 }, [{}], [{ [CIK]: 1200 }]);
    expect(r.ni[CIK]).toBeUndefined();
    expect(r.withheldCount).toBe(1);
  });

  test("zero quarters means combineTtm withholds everyone — the uniform-annual case is handled upstream", () => {
    // buildIncomeFrames returns the annual map directly when k === 0, BEFORE reaching here, because
    // then no company has anything fresher and the annual is simply the freshest data that exists,
    // applied uniformly. Reaching combineTtm with no quarters is therefore not a production path;
    // asserted so the two layers cannot silently disagree about who owns that case.
    const r = combineTtm({ [CIK]: 100, 789: 50 }, [], []);
    expect(Object.keys(r.ni)).toEqual([]);
    expect(r.withheldCount).toBe(2);
    expect(r.ttmCount).toBe(0);
  });

  test("a company present in the quarters but ABSENT from the annual is not invented", () => {
    // Without an annual baseline there is no TTM to compute, and fabricating one from two quarters
    // would put a name in the cohort on a number that means something else.
    const r = combineTtm({ [CIK]: 100 }, [{ [CIK]: 30, 999: 7 }], [{ [CIK]: 20, 999: 5 }]);
    expect(Object.keys(r.ni)).toEqual([String(CIK)]);
  });

  test("companies are scored independently — one gap does not spoil the rest", () => {
    const r = combineTtm(
      { 1: 100, 2: 200 },
      [{ 1: 30, 2: 60 }], [{ 1: 20 }],          // cik 2 missing its prior quarter
    );
    expect(r.ni[1]).toBe(110);
    expect(r.ni[2]).toBeUndefined();     // withheld, not scored on its annual
    expect(r.ttmCount).toBe(1);
    expect(r.withheldCount).toBe(1);
  });
});

// ── Per-company recovery, for filers the CALENDAR frames cannot serve ────────────────────────────
// SEC maps Microsoft's July-to-June fiscal year into CY2025 and then has no calendar-Q1/Q2-2026 stub
// for it, so the frames path withheld MSFT — excluding it for an accounting-calendar reason rather
// than anything to do with quality. Its own 10-K covers 2025-07-01 → 2026-06-30 and is three months
// old. These use MSFT's REAL reported facts, taken from the live SEC API.
import { ttmFromFacts, MAX_WINDOW_AGE_DAYS, type ConceptFact } from "@/lib/quality";

const f = (start: string, end: string, val: number, filed: string): ConceptFact => ({ start, end, val, filed });

// Abridged from data.sec.gov companyconcept CIK0000789019 NetIncomeLoss, values in $B.
const MSFT: ConceptFact[] = [
  f("2024-07-01", "2024-12-31", 48.77, "2025-01-29"),   // YTD — must be ignored (183d)
  f("2024-10-01", "2024-12-31", 24.11, "2025-01-29"),   // quarter
  f("2025-01-01", "2025-03-31", 25.82, "2025-04-30"),   // quarter
  f("2024-07-01", "2025-06-30", 101.83, "2025-07-30"),  // FY2025 annual
  f("2025-07-01", "2025-09-30", 27.75, "2025-10-29"),   // quarter
  f("2025-10-01", "2025-12-31", 38.46, "2026-01-28"),   // quarter
  f("2025-07-01", "2025-12-31", 66.20, "2026-01-28"),   // YTD — ignored
  f("2026-01-01", "2026-03-31", 31.78, "2026-04-29"),   // quarter
  f("2025-07-01", "2026-03-31", 97.98, "2026-04-29"),   // YTD — ignored
  f("2025-07-01", "2026-06-30", 133.75, "2026-07-29"),  // FY2026 annual — the freshest window
];

describe("ttmFromFacts recovers off-calendar filers", () => {
  test("MSFT resolves to its own latest fiscal year, matching Sharadar ART exactly", () => {
    const r = ttmFromFacts(MSFT, "2026-09-30")!;
    expect(r.val).toBeCloseTo(133.75, 6);     // independently confirmed against Sharadar ART
    expect(r.windowEnd).toBe("2026-06-30");   // 92 days old — not stale
    expect(r.quartersAdded).toBe(0);          // no quarter filed after FY2026 yet
  });

  test("year-to-date facts are excluded — only ~quarterly and ~annual durations count", () => {
    // 66.20 (183d) and 97.98 (273d) are cumulative. Summing them with quarters would double-count.
    const r = ttmFromFacts(MSFT, "2026-09-30")!;
    expect(r.val).not.toBeCloseTo(133.75 + 66.20, 3);
  });

  test("rolls the window FORWARD when a quarter is filed after the fiscal year", () => {
    // Add Q1 FY2027 plus the year-earlier quarter it nets against.
    const rolled = [...MSFT, f("2026-07-01", "2026-09-30", 30.0, "2026-10-28")];
    const r = ttmFromFacts(rolled, "2026-11-15")!;
    expect(r.quartersAdded).toBe(1);
    expect(r.windowEnd).toBe("2026-09-30");
    expect(r.val).toBeCloseTo(133.75 + (30.0 - 27.75), 6);   // nets off Q1 FY2026
  });

  test("a NON-CONTIGUOUS quarter is not rolled in — a gap would drop earnings", () => {
    // A quarter that does not abut the fiscal-year end (skips a period) must be ignored.
    const gapped = [...MSFT, f("2026-10-01", "2026-12-31", 30.0, "2027-01-28")];
    const r = ttmFromFacts(gapped, "2027-02-15")!;
    expect(r.quartersAdded).toBe(0);
    expect(r.windowEnd).toBe("2026-06-30");
  });

  test("facts ending AFTER asOf are invisible — no look-ahead", () => {
    const r = ttmFromFacts(MSFT, "2026-05-01")!;
    // FY2026 (ending 2026-06-30) had not closed yet, so the base is FY2025.
    expect(r.windowEnd).toBe("2025-06-30");
    // And the roll HALTS rather than skipping: advancing past FY2025 needs the quarter ending
    // 2025-09-30, which nets against the quarter ending 2024-09-30 — absent from this abridged
    // fixture. Jumping to a later quarter instead would silently drop a quarter of earnings, so
    // stopping is correct. Asserted explicitly because "returns the annual" and "rolled forward but
    // lost a quarter" would otherwise be indistinguishable from the value alone.
    expect(r.quartersAdded).toBe(0);
    expect(r.val).toBeCloseTo(101.83, 6);
  });

  test("a genuinely STALE window is WITHHELD rather than used", () => {
    const r = ttmFromFacts(MSFT, "2028-01-01");   // freshest window now >400 days old
    expect(r).toBeNull();
  });

  test("the staleness threshold is the documented one, not an accident", () => {
    const justInside = ttmFromFacts(MSFT, "2027-07-01");   // ~366 days after 2026-06-30
    expect(justInside).not.toBeNull();
    expect(MAX_WINDOW_AGE_DAYS).toBeGreaterThan(365);      // must span a full filing cycle
  });

  test("no annual at all means WITHHELD — quarters alone are never assembled into a year", () => {
    const quartersOnly = MSFT.filter(x => x.val < 50);
    expect(ttmFromFacts(quartersOnly, "2026-09-30")).toBeNull();
  });

  test("a restated period keeps the LATEST FILED value, since that is what is known today", () => {
    const restated = [...MSFT, f("2025-07-01", "2026-06-30", 140.0, "2026-10-01")];
    expect(ttmFromFacts(restated, "2026-11-01")!.val).toBeCloseTo(140.0, 6);
  });

  test("empty or malformed facts withhold rather than throw", () => {
    expect(ttmFromFacts([], "2026-09-30")).toBeNull();
    expect(ttmFromFacts([f("", "", NaN, "")], "2026-09-30")).toBeNull();
  });
});
