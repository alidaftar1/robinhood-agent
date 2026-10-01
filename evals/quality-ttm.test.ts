import { describe, test, expect } from "bun:test";
import { combineTtm, type DatedValue } from "@/lib/quality";

// TTM = annual + Σ(currentQ − priorQ). The construction deliberately avoids Q4 duration frames,
// which are structurally sparse because companies file a 10-K for the year rather than a 10-Q for
// Q4 — so summing four quarters would fail the population floor for the whole universe.
//
// TWO GUARDS MATTER, and the second was missing until a review caught it.
//
// 1. WITHHOLD, never fall back. A missing quarter must drop the company, not score it on a partial
//    sum and not on its stale annual. The fallback's error is asymmetric: a stale annual can wrongly
//    EXCLUDE a recovered company (safe) but equally wrongly INCLUDE a DETERIORATED one whose
//    year-old figures still look strong. These tests originally asserted the FALLBACK and were
//    flipped when the direction was corrected.
//
// 2. CONTIGUITY. The formula is only a trailing twelve months when each added quarter BEGINS where
//    the previous period ENDED. For an off-calendar filer it does not: SEC assigns AAPL's FY2025
//    (2024-09-29 → 2025-09-27) to frame CY2025 and its next quarter to CY2025Q4, which the loop
//    never reads — so adding CY2026Q1/Q2 and subtracting CY2025Q1/Q2 operates INSIDE the base annual
//    and yields a twelve-month-DURATION sum with a hole. This was invisible to the original tests
//    because they passed undated `cik → val` maps, mirroring a `frame()` that discarded start/end.
//    The code could not see the misalignment and neither could its tests.

const CIK = 320193;
const dv = (val: number, start: string, end: string): DatedValue => ({ val, start, end });

// A CALENDAR-year filer: annual ends 31 Dec, quarters abut it cleanly.
const CAL = {
  annual: (v: number) => ({ [CIK]: dv(v, "2025-01-01", "2025-12-31") }),
  curQ1: (v: number) => ({ [CIK]: dv(v, "2026-01-01", "2026-03-31") }),
  curQ2: (v: number) => ({ [CIK]: dv(v, "2026-04-01", "2026-06-30") }),
  priQ1: (v: number) => ({ [CIK]: dv(v, "2025-01-01", "2025-03-31") }),
  priQ2: (v: number) => ({ [CIK]: dv(v, "2025-04-01", "2025-06-30") }),
};

describe("combineTtm arithmetic", () => {
  test("adds the year-to-date stub and subtracts the same quarters a year earlier", () => {
    // annual 100; this year Q1 30 Q2 40; last year Q1 20 Q2 25 → 100 + (30−20) + (40−25) = 125
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(30), CAL.curQ2(40)], [CAL.priQ1(20), CAL.priQ2(25)]);
    expect(r.ni[CIK]).toBe(125);
    expect(r.ttmCount).toBe(1);
    expect(r.withheldCount).toBe(0);
    expect(r.misalignedCount).toBe(0);
  });

  test("a DECLINING business produces a TTM BELOW its annual", () => {
    // The direction has to work both ways, or the change would only ever flatter.
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(5)], [CAL.priQ1(30)]);
    expect(r.ni[CIK]).toBe(75);
  });

  test("a swing from loss to profit is reflected — the 2022 energy case", () => {
    // DVN-shaped: a big annual loss, with recent quarters sharply positive.
    const r = combineTtm(CAL.annual(-2680), [CAL.curQ1(900), CAL.curQ2(1000)], [CAL.priQ1(-700), CAL.priQ2(-400)]);
    expect(r.ni[CIK]).toBe(-2680 + (900 - -700) + (1000 - -400));   // = +320, now profitable
    expect(r.ni[CIK]).toBeGreaterThan(0);
  });

  test("exact match against the verified NVDA case", () => {
    // Cross-checked against Sharadar ART on 2026-09-30: SEC-derived TTM matched to 0.0%.
    const annual = 120.07, c1 = 44.0, c2 = 46.0, p1 = 8.0, p2 = 9.19;
    const r = combineTtm(CAL.annual(annual), [CAL.curQ1(c1), CAL.curQ2(c2)], [CAL.priQ1(p1), CAL.priQ2(p2)]);
    expect(r.ni[CIK]).toBeCloseTo(annual + (c1 - p1) + (c2 - p2), 6);
  });
});

describe("CONTIGUITY: an off-calendar filer is WITHHELD, not published with a hole", () => {
  // AAPL's real frame assignments. FY2025 ends 2025-09-27; the quarter that follows it
  // (2025-09-28 → 2025-12-27) lands in CY2025Q4 and is never read here.
  const aaplAnnual = { [CIK]: dv(112.01, "2024-09-29", "2025-09-27") };
  const aaplCurQ1 = { [CIK]: dv(29.58, "2025-12-28", "2026-03-28") };   // CY2026Q1
  const aaplCurQ2 = { [CIK]: dv(29.79, "2026-03-29", "2026-06-27") };   // CY2026Q2
  const aaplPriQ1 = { [CIK]: dv(23.64, "2024-12-29", "2025-03-29") };
  const aaplPriQ2 = { [CIK]: dv(21.45, "2025-03-30", "2025-06-28") };

  test("THE H-1 CASE: AAPL is withheld rather than scored on a 12-month sum with a hole", () => {
    // The naive formula would return 112.01 + (29.58−23.64) + (29.79−21.45) = 126.29, which is NOT a
    // trailing twelve months — the Sept–Dec 2025 quarter is missing and Sept–Dec 2024 is wrongly
    // retained. Correct per-company TTM is 128.93 (verified against SEC's own quarters), so the naive
    // figure is wrong in the OVERSTATING direction for 16 of the 34 affected names.
    const r = combineTtm(aaplAnnual, [aaplCurQ1, aaplCurQ2], [aaplPriQ1, aaplPriQ2]);
    expect(r.ni[CIK]).toBeUndefined();
    expect(r.misalignedCount).toBe(1);
    expect(r.withheldCount).toBe(1);
    expect(r.ttmCount).toBe(0);
    // Specifically NOT the hole-bearing value.
    expect(r.ni[CIK]).not.toBe(112.01 + (29.58 - 23.64) + (29.79 - 21.45));
  });

  test("an OVERLAPPING quarter is also withheld — the GIS/STZ double-count", () => {
    // Two names had NEGATIVE gaps live, meaning the added quarter overlaps the annual.
    const overlapping = { [CIK]: dv(50, "2025-07-01", "2025-09-30") };   // starts BEFORE annual end
    const r = combineTtm(CAL.annual(100), [overlapping], [CAL.priQ1(20)]);
    expect(r.ni[CIK]).toBeUndefined();
    expect(r.misalignedCount).toBe(1);
  });

  test("a calendar filer with a small weekend gap still passes — the tolerance is not zero", () => {
    // 52/53-week filers abut within a few days; requiring an exact match would withhold everyone.
    const nearly = { [CIK]: dv(30, "2026-01-04", "2026-04-04") };        // 3 days after 2025-12-31
    const r = combineTtm(CAL.annual(100), [nearly], [CAL.priQ1(20)]);
    expect(r.ni[CIK]).toBe(110);
    expect(r.misalignedCount).toBe(0);
  });

  test("contiguity is checked at EVERY step, not just the first", () => {
    const jump = { [CIK]: dv(40, "2026-09-01", "2026-11-30") };          // skips Q2
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(30), jump], [CAL.priQ1(20), CAL.priQ2(25)]);
    expect(r.ni[CIK]).toBeUndefined();
    expect(r.misalignedCount).toBe(1);
  });
});

describe("the per-company fail-safe", () => {
  test("a missing CURRENT quarter WITHHOLDS the company — no annual fallback, no partial sum", () => {
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(30), {}], [CAL.priQ1(20), CAL.priQ2(25)]);
    expect(r.ni[CIK]).toBeUndefined();   // not 110 (partial), and not 100 (stale annual)
    expect(r.withheldCount).toBe(1);
    expect(r.ttmCount).toBe(0);
  });

  test("a missing PRIOR-year quarter also withholds", () => {
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(30)], [{}]);
    expect(r.ni[CIK]).toBeUndefined();
  });

  test("a non-finite value withholds rather than producing NaN", () => {
    const r = combineTtm(CAL.annual(100), [CAL.curQ1(NaN)], [CAL.priQ1(20)]);
    expect(r.ni[CIK]).toBeUndefined();
    // And nothing NaN leaks into the map at all — a NaN ratio would poison the percentile sort.
    expect(Object.values(r.ni).every(Number.isFinite)).toBe(true);
  });

  test("THE DANGEROUS CASE the withholding exists for: a DETERIORATING company is not admitted on its stale annual", () => {
    // Annual was strongly profitable; the recent quarter that would reveal the collapse is missing.
    // Falling back would score it on last year's strength and could make it ELIGIBLE to buy.
    const r = combineTtm(CAL.annual(5000), [{}], [CAL.priQ1(1200)]);
    expect(r.ni[CIK]).toBeUndefined();
    expect(r.withheldCount).toBe(1);
  });

  test("zero quarters means combineTtm withholds everyone — the uniform-annual case is handled upstream", () => {
    // buildIncomeFrames returns the annual map directly when k === 0, BEFORE reaching here, because
    // then no company has anything fresher and the annual is simply the freshest data that exists,
    // applied uniformly. Reaching combineTtm with no quarters is therefore not a production path;
    // asserted so the two layers cannot silently disagree about who owns that case.
    const r = combineTtm({ ...CAL.annual(100), 789: dv(50, "2025-01-01", "2025-12-31") }, [], []);
    expect(Object.keys(r.ni)).toEqual([]);
    expect(r.withheldCount).toBe(2);
    expect(r.ttmCount).toBe(0);
  });

  test("a company present in the quarters but ABSENT from the annual is not invented", () => {
    // Without an annual baseline there is no TTM to compute, and fabricating one from two quarters
    // would put a name in the cohort on a number that means something else.
    const r = combineTtm(CAL.annual(100),
      [{ ...CAL.curQ1(30), 999: dv(7, "2026-01-01", "2026-03-31") }],
      [{ ...CAL.priQ1(20), 999: dv(5, "2025-01-01", "2025-03-31") }]);
    expect(Object.keys(r.ni)).toEqual([String(CIK)]);
  });

  test("companies are scored independently — one gap does not spoil the rest", () => {
    const other = 789;
    const r = combineTtm(
      { ...CAL.annual(100), [other]: dv(200, "2025-01-01", "2025-12-31") },
      [{ ...CAL.curQ1(30), [other]: dv(60, "2026-01-01", "2026-03-31") }],
      [CAL.priQ1(20)],                               // `other` missing its prior quarter
    );
    expect(r.ni[CIK]).toBe(110);
    expect(r.ni[other]).toBeUndefined();             // withheld, not scored on its annual
    expect(r.ttmCount).toBe(1);
    expect(r.withheldCount).toBe(1);
  });
});

// ── Per-company recovery, for filers the CALENDAR frames cannot serve ────────────────────────────
// SEC maps Microsoft's July-to-June fiscal year into CY2025 and then has no calendar-Q1/Q2-2026 stub
// for it, so the frames path withheld MSFT — excluding it for an accounting-calendar reason rather
// than anything to do with quality. Its own 10-K covers 2025-07-01 → 2026-06-30 and is three months
// old. These use MSFT's REAL reported facts, taken from the live SEC API.
import { ttmFromFacts, parseConceptUnits, MAX_WINDOW_AGE_DAYS, type ConceptFact } from "@/lib/quality";

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

// ── "could not ask" vs "the answer is empty" ─────────────────────────────────────────────────────
// I collapsed these two THREE times in one day: lib/news.ts fetchCompanyNews, lib/news.ts
// extractMaterialNews, and conceptFacts here. Both directions are wrong and each one caused real
// damage. Treating a FAILURE as empty silently shrinks the tradable universe during an outage.
// Treating genuinely-EMPTY as a failure marks every run degraded, so nothing is ever cached and the
// full ~130-request sweep repeats on every trade run forever. A comment was not enough; this is a test.
describe("parseConceptUnits distinguishes could-not-ask from genuinely-empty", () => {
  test("a 200 with units:{} is EMPTY, not a failure — those companies really report nothing", () => {
    // Confirmed real for CDNS, CTSH, ENPH, NXPI.
    expect(parseConceptUnits(undefined)).toEqual([]);
    expect(parseConceptUnits(null)).toEqual([]);
  });

  test("a payload of the wrong SHAPE is a FAILURE, never an empty company", () => {
    expect(parseConceptUnits({})).toBeNull();
    expect(parseConceptUnits("nope")).toBeNull();
    expect(parseConceptUnits(42)).toBeNull();
  });

  test("a real array parses, and malformed rows degrade to unusable rather than throwing", () => {
    const out = parseConceptUnits([
      { start: "2025-01-01", end: "2025-12-31", val: 100, filed: "2026-02-01" },
      { val: "not a number" },
    ])!;
    expect(out.length).toBe(2);
    expect(out[0].val).toBe(100);
    expect(Number.isNaN(out[1].val)).toBe(true);   // ttmFromFacts drops non-finite vals
  });

  test("an empty array stays EMPTY — it is an answer, not an absence of one", () => {
    expect(parseConceptUnits([])).toEqual([]);
  });

  test("a NaN-valued row cannot reach a TTM figure", () => {
    const facts = parseConceptUnits([{ start: "2025-01-01", end: "2025-12-31", val: null, filed: "2026-02-01" }])!;
    expect(ttmFromFacts(facts, "2026-06-01")).toBeNull();
  });
});
