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
import { ttmFromFacts, parseConceptUnits, parseConceptResponse, shouldCache, resolveSecStatus, isUsableTickerMap, MIN_TICKER_MAP, MAX_WINDOW_AGE_DAYS, type ConceptFact, type QualityData } from "@/lib/quality";

const f = (start: string, end: string, val: number, filed: string, form = "10-K"): ConceptFact =>
  ({ start, end, val, filed, form });

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
  // SHAPES MEASURED AGAINST LIVE SEC on 2026-09-30, not assumed. The previous version of this suite
  // asserted `parseConceptUnits({}) === null` — and `{}` is literally V's live payload, so the test
  // LOCKED IN a bug that made every healthy run report degraded and disabled the cache entirely.
  // An assertion is only as good as the observation behind it.
  test("units.USD present as an EMPTY OBJECT is genuinely empty — V, VFC and CDNS really do this", () => {
    expect(parseConceptUnits({})).toEqual([]);
  });

  test("an absent units.USD key is also genuinely empty", () => {
    expect(parseConceptUnits(undefined)).toEqual([]);
    expect(parseConceptUnits(null)).toEqual([]);
  });

  test("a scalar payload is still treated as nothing-reported, never as a transient failure", () => {
    // Reserving null strictly for network/timeout/non-404 means no SHAPE can mark a run degraded.
    // The cost of being wrong here is one unbuyable name; the cost of the other direction was the
    // whole cache.
    expect(parseConceptUnits("nope")).toEqual([]);
    expect(parseConceptUnits(42)).toEqual([]);
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

// ── BOUNDARY constraints on the contiguity window ────────────────────────────────────────────────
// Review 3 mutation-tested the shipped suite and found the guard's EXISTENCE was tested but its
// NUMBERS were not: gapMax anywhere in 4..91 passed (including 80 — an 80-day hole), and gapMin
// anywhere in -182..+1 passed (including -180 — a six-month OVERLAP, which is the exact GIS/STZ
// double-count this guard exists to stop). There were no fixtures between +5 and +89, or between
// -2 and -89. CLAUDE.md requires breaking a guard and seeing the test fail; for the boundaries that
// was unmet. These pin them.
describe("the contiguity window is pinned, not merely present", () => {
  const C = 320193;
  const dvv = (val: number, start: string, end: string) => ({ val, start, end });
  const annual = { [C]: dvv(100, "2025-01-01", "2025-12-31") };
  const prior = { [C]: dvv(20, "2025-01-01", "2025-03-31") };
  /** A quarter starting `gap` days after the annual ends. */
  const at = (gap: number) => {
    const start = new Date(Date.parse("2025-12-31T00:00:00Z") + gap * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.parse(start + "T00:00:00Z") + 90 * 86_400_000).toISOString().slice(0, 10);
    return { [C]: dvv(30, start, end) };
  };

  test("accepts the real calendar-filer gap of +1 and the 53-week spread up to +5", () => {
    for (const g of [0, 1, 2, 3, 4, 5]) {
      const r = combineTtm(annual, [at(g)], [prior]);
      expect(r.ni[C]).toBe(110);
      expect(r.misalignedCount).toBe(0);
    }
  });

  test("REJECTS +6, so the upper bound cannot be widened toward a real hole", () => {
    // The smallest genuine hole measured live is 89 days, but a test that passes at gapMax=80 does
    // not constrain anything. +6 must fail for the bound to mean +5.
    for (const g of [6, 10, 45, 89, 92]) {
      const r = combineTtm(annual, [at(g)], [prior]);
      expect(r.ni[C]).toBeUndefined();
      expect(r.misalignedCount).toBe(1);
    }
  });

  test("REJECTS -3 and beyond, so overlap cannot creep back in", () => {
    // -89 and -188 were GIS and STZ live: the added quarter overlapped the annual and double-counted.
    for (const g of [-3, -10, -89, -188]) {
      const r = combineTtm(annual, [at(g)], [prior]);
      expect(r.ni[C]).toBeUndefined();
      expect(r.misalignedCount).toBe(1);
    }
  });

  test("tolerates -1 and -2 only — the documented slack, and no more", () => {
    for (const g of [-1, -2]) expect(combineTtm(annual, [at(g)], [prior]).ni[C]).toBe(110);
  });
});

// Review 3 also found QTR_MAX = 9999 passed every test, i.e. the duration filter in ttmFromFacts was
// unconstrained, and that the "YTD facts are excluded" test was vacuous (it compared 133.75 against
// 199.95, which almost any value satisfies).
describe("ttmFromFacts duration bands are pinned", () => {
  const g = (start: string, end: string, val: number, filed: string, form = "10-K") => ({ start, end, val, filed, form });

  test("a 183-day YTD fact is NOT treated as a quarter — asserted by VALUE, not by inequality", () => {
    // annual 100 (ends 2025-12-31) + a real 91d quarter 30, netting a prior 91d quarter 20 → 110.
    // A 183d YTD fact of 999 sits in the data and must be ignored entirely; if the duration band let
    // it through, the result would be a specific wrong number, so assert the exact right one.
    const facts = [
      g("2025-01-01", "2025-12-31", 100, "2026-02-01"),
      g("2026-01-01", "2026-03-31", 30, "2026-05-01"),
      g("2025-01-01", "2025-03-31", 20, "2025-05-01"),
      g("2026-01-01", "2026-06-30", 999, "2026-08-01"),   // YTD — must be invisible
    ];
    const r = ttmFromFacts(facts, "2026-09-01")!;
    expect(r.val).toBe(110);
    expect(r.quartersAdded).toBe(1);
  });

  test("a 180-day period is rejected as a quarter even when it is the ONLY candidate", () => {
    const facts = [
      g("2025-01-01", "2025-12-31", 100, "2026-02-01"),
      g("2026-01-01", "2026-06-29", 50, "2026-08-01"),    // 179d — outside [80,100]
      g("2025-01-01", "2025-06-29", 40, "2025-08-01"),
    ];
    const r = ttmFromFacts(facts, "2026-09-01")!;
    expect(r.val).toBe(100);           // annual only; the half-year was not rolled in
    expect(r.quartersAdded).toBe(0);
  });

  test("a 500-day period is rejected as an annual", () => {
    const facts = [g("2025-01-01", "2026-05-15", 100, "2026-06-01")];   // ~500d
    expect(ttmFromFacts(facts, "2026-09-01")).toBeNull();
  });
});

// Two guards review-3's mutation sweep showed were unconstrained after the first fix round:
// QTR_MIN could drop to 1 and the 404 path could flip to null, both with every test still green.
describe("the remaining unconstrained guards are pinned", () => {
  const g = (start: string, end: string, val: number, filed: string, form = "10-K") => ({ start, end, val, filed, form });

  test("a 30-day period is NOT a quarter — pins QTR_MIN, not just QTR_MAX", () => {
    const facts = [
      g("2025-01-01", "2025-12-31", 100, "2026-02-01"),
      g("2026-01-01", "2026-01-31", 7, "2026-03-01"),    // 30d — a month, not a quarter
      g("2025-01-01", "2025-01-31", 5, "2025-03-01"),
    ];
    const r = ttmFromFacts(facts, "2026-09-01")!;
    expect(r.val).toBe(100);            // the month was not rolled in
    expect(r.quartersAdded).toBe(0);
  });

  test("a 404 from SEC is genuinely-empty, NOT could-not-ask", () => {
    // SPG returns 404 for us-gaap:NetIncomeLoss — it has simply never tagged the concept. Routing
    // that to null marks the whole run degraded and disables the cache; routing it to [] withholds
    // just that one name, which is correct and cacheable.
    expect(parseConceptResponse(undefined, true)).toEqual([]);
    expect(parseConceptResponse({ nonsense: 1 }, true)).toEqual([]);
  });

  test("a non-404 response still goes through the shape decision", () => {
    expect(parseConceptResponse({}, false)).toEqual([]);
    expect(parseConceptResponse([g("2025-01-01", "2025-12-31", 1, "2026-01-01")], false)!.length).toBe(1);
  });
});

// ── Proxy statements must never override the financial statements ────────────────────────────────
// Verified on FedEx: the SAME period 2025-06-01 → 2026-05-31 appears as 10-K `4433000000` (filed
// 2026-07-20) and DEF 14A `4433` (filed 2026-08-17). Proxies restate figures in millions because they
// are prose for shareholders, and they are filed LATER — so "keep the latest filed value" picked the
// proxy and FDX's net income resolved to $4,433, a factor of a million out. 39 of 131 recovery
// candidates were anchored on a proxy fact.
//
// Why that was dangerous rather than merely wrong: understatement wrongly EXCLUDES from buying (the
// safe side), but the name is still SCORED — so it is "measured and failed", not quality-unknown, and
// a HELD one drops out of `retained`, reads as "fell off the shortlist", and lib/sell-rail accepts
// that as a code-verifiable exit. A units error could authorise a liquidation.
describe("non-financial-statement forms are dropped", () => {
  const ff = (start: string, end: string, val: number, filed: string, form: string): ConceptFact =>
    ({ start, end, val, filed, form });

  test("THE FDX CASE: a later DEF 14A does not override the 10-K for the same period", () => {
    const facts = [
      ff("2025-06-01", "2026-05-31", 4_433_000_000, "2026-07-20", "10-K"),
      ff("2025-06-01", "2026-05-31", 4_433, "2026-08-17", "DEF 14A"),     // filed LATER, scaled
    ];
    const r = ttmFromFacts(facts, "2026-09-30")!;
    expect(r.val).toBe(4_433_000_000);
    expect(r.val).not.toBe(4_433);
  });

  test("a period reported ONLY by a proxy is unusable — withheld, not scaled-guessed", () => {
    // Trusting it would mean publishing a figure whose units we cannot verify.
    const facts = [ff("2025-06-01", "2026-05-31", 4_433, "2026-08-17", "DEF 14A")];
    expect(ttmFromFacts(facts, "2026-09-30")).toBeNull();
  });

  test("8-K, S-1 and ARS are dropped too — the allowlist is forms, not a DEF 14A special case", () => {
    for (const form of ["8-K", "S-1", "ARS", "DEFA14A", ""]) {
      expect(ttmFromFacts([ff("2025-01-01", "2025-12-31", 100, "2026-02-01", form)], "2026-06-01")).toBeNull();
    }
  });

  test("the real statement forms all pass, including foreign filers and amendments", () => {
    for (const form of ["10-K", "10-K/A", "10-Q", "20-F", "40-F", "10-KT"]) {
      const r = ttmFromFacts([ff("2025-01-01", "2025-12-31", 100, "2026-02-01", form)], "2026-06-01");
      expect(r?.val).toBe(100);
    }
  });

  test("a 10-K/A amendment still wins over an earlier 10-K — restatements are legitimate", () => {
    const facts = [
      ff("2025-01-01", "2025-12-31", 100, "2026-02-01", "10-K"),
      ff("2025-01-01", "2025-12-31", 120, "2026-05-01", "10-K/A"),
    ];
    expect(ttmFromFacts(facts, "2026-09-01")!.val).toBe(120);
  });

  test("a proxy does not block the roll-forward either — quarters are form-filtered too", () => {
    const facts = [
      ff("2025-01-01", "2025-12-31", 100, "2026-02-01", "10-K"),
      ff("2026-01-01", "2026-03-31", 30, "2026-05-01", "10-Q"),
      ff("2026-01-01", "2026-03-31", 30_000_000, "2026-06-01", "DEF 14A"),   // same quarter, scaled up
      ff("2025-01-01", "2025-03-31", 20, "2025-05-01", "10-Q"),
    ];
    expect(ttmFromFacts(facts, "2026-09-01")!.val).toBe(110);
  });
});

// ── The cache-write guard ────────────────────────────────────────────────────────────────────────
// A mutation sweep found `if (data.degraded)` in getQualityScores could be DELETED with the entire
// suite still green — the highest-stakes invariant in the module, unpinned through three review
// rounds. Caching a degraded result freezes a transient fault for 8 days, and because WHICH names are
// withheld depends on how much data arrived, it would redefine the tradable universe for that window.
describe("shouldCache refuses to persist a result that is not an answer", () => {
  const base = (over: Partial<QualityData> = {}): QualityData => ({
    scores: { AAPL: { quality: 0.8, roe: 0.3, roa: 0.2, lev: null, eligible: true } },
    median: 0.5, period: "TTM through CY2026Q2", asOf: "2026-09-30",
    withheld: [], degraded: false,
    basis: { ttmFromFrames: 4000, recoveredPerCompany: 100, withheld: 0, withheldNoCik: 0 },
    ...over,
  });

  test("a healthy result IS cacheable", () => {
    expect(shouldCache(base())).toBe(true);
  });

  test("a DEGRADED result is never cached, however complete it looks", () => {
    expect(shouldCache(base({ degraded: true }))).toBe(false);
  });

  test("an EMPTY score set is never cached — that is what a broken ticker map looks like", () => {
    // The concrete failure this closes: a 404 on company_tickers.json yielded an empty CIK map, so
    // every name was withheld, `degraded` stayed false, and the empty result was cached for 8 days —
    // after which the trade route tripped its shortlist floor and self-skipped every run for a week.
    expect(shouldCache(base({ scores: {}, withheld: ["AAPL", "MSFT"] }))).toBe(false);
  });

  test("both conditions independently block — neither masks the other", () => {
    expect(shouldCache(base({ degraded: true, scores: {} }))).toBe(false);
  });
});

// Review 4's fifth unconstrained guard: ttmFromFacts has its OWN contiguity bound, and fixing the
// bound in combineTtm left this one free — a mutant widening ±5 to ±50 survived the whole suite.
// The recovery path now serves ~100 names including MSFT, so it is not a backwater.
describe("ttmFromFacts' contiguity bound is pinned too", () => {
  const q = (start: string, end: string, val: number, filed: string): ConceptFact =>
    ({ start, end, val, filed, form: "10-Q" });
  const annual: ConceptFact = { start: "2025-01-01", end: "2025-12-31", val: 100, filed: "2026-02-01", form: "10-K" };

  test("a quarter starting 20 days after the fiscal year is NOT rolled in", () => {
    // Inside a ±50 tolerance, outside ±5. Pins the bound against being widened.
    const facts = [annual, q("2026-01-20", "2026-04-20", 30, "2026-06-01"), q("2025-01-20", "2025-04-20", 20, "2025-06-01")];
    const r = ttmFromFacts(facts, "2026-09-01")!;
    expect(r.quartersAdded).toBe(0);
    expect(r.val).toBe(100);
  });

  test("a quarter starting 40 days BEFORE the year end is not rolled in either", () => {
    const facts = [annual, q("2025-11-21", "2026-02-21", 30, "2026-04-01"), q("2024-11-21", "2025-02-21", 20, "2025-04-01")];
    expect(ttmFromFacts(facts, "2026-09-01")!.quartersAdded).toBe(0);
  });

  test("the legitimate +1 day case still rolls", () => {
    const facts = [annual, q("2026-01-01", "2026-04-01", 30, "2026-06-01"), q("2025-01-01", "2025-04-01", 20, "2025-06-01")];
    expect(ttmFromFacts(facts, "2026-09-01")!.quartersAdded).toBe(1);
  });
});

// ── The two H-1 guards, made testable ────────────────────────────────────────────────────────────
// H-1: `secGet` returned the 404 sentinel UNCONDITIONALLY, which re-claimed meaning for a caller that
// never tested for it. The tickers fetch then produced an empty CIK map (Object.keys(Symbol()) is [],
// not a throw), every name was withheld, `degraded` stayed false, and that empty result was CACHED for
// 8 days — after which the trade route tripped its shortlist floor and self-skipped every run for a
// week while blaming "a Yahoo/SEC hiccup". Both guards lived in network-bound code no test could
// reach, which is precisely how it shipped.
describe("resolveSecStatus: 404 handling is OPT-IN", () => {
  test("404 is 'not-found' ONLY when the caller asked for that", () => {
    expect(resolveSecStatus(404, true)).toBe("not-found");
    expect(resolveSecStatus(404, false)).toBe("error");
  });

  test("a 2xx is ok and other failures are errors, regardless of the flag", () => {
    for (const ok of [true, false]) {
      expect(resolveSecStatus(200, ok)).toBe("ok");
      expect(resolveSecStatus(204, ok)).toBe("ok");
      expect(resolveSecStatus(500, ok)).toBe("error");
      expect(resolveSecStatus(429, ok)).toBe("error");
      expect(resolveSecStatus(403, ok)).toBe("error");
    }
  });

  test("notFoundOk does NOT soften anything other than 404", () => {
    // The bug was a widening; this pins how narrow the widening is allowed to be.
    expect(resolveSecStatus(410, true)).toBe("error");
    expect(resolveSecStatus(451, true)).toBe("error");
  });
});

describe("isUsableTickerMap refuses to score an empty universe", () => {
  const mapOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`T${i}`, i + 1]));

  test("an empty or tiny map is rejected — the concrete H-1 failure", () => {
    expect(isUsableTickerMap({})).toBe(false);
    expect(isUsableTickerMap(mapOf(1))).toBe(false);
    expect(isUsableTickerMap(mapOf(999))).toBe(false);
  });

  test("a real-sized map passes", () => {
    expect(isUsableTickerMap(mapOf(1000))).toBe(true);
    expect(isUsableTickerMap(mapOf(10_000))).toBe(true);
  });

  test("the floor is high enough to catch a near-empty read, not merely a zero one", () => {
    // A floor of 1 would pass a map containing a single junk entry.
    expect(MIN_TICKER_MAP).toBeGreaterThan(100);
  });
});
