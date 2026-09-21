import { describe, expect, test } from "bun:test";
import { stitchTtmEps, latestFyEps, buildValuation, formatValuation, filedPoints, type XbrlPoint } from "@/lib/valuation";

const p = (start: string, end: string, val: number, form = "10-Q"): XbrlPoint =>
  ({ start, end, val, form, fy: 2026, fp: "Q1" });

// Real MRK shape: Q4 is never reported discretely, and 2026 has two loss-making quarters.
const MRK: XbrlPoint[] = [
  p("2025-01-01", "2025-09-30", 6.08), p("2025-07-01", "2025-09-30", 2.32),
  p("2025-01-01", "2025-12-31", 7.28, "10-K"),
  p("2026-01-01", "2026-03-31", -1.72), p("2026-01-01", "2026-06-30", -2.26),
  p("2026-04-01", "2026-06-30", -0.54),
];
const GOOGL: XbrlPoint[] = [
  p("2025-01-01", "2025-09-30", 7.99), p("2025-07-01", "2025-09-30", 2.87),
  p("2025-01-01", "2025-12-31", 10.81, "10-K"),
  p("2026-01-01", "2026-03-31", 5.11), p("2026-01-01", "2026-06-30", 14.24),
  p("2026-04-01", "2026-06-30", 9.11),
];

describe("TTM stitching", () => {
  test("derives the never-reported Q4 from (full year minus nine months)", () => {
    // MRK Q4'25 = 7.28 - 6.08 = 1.20. Summing raw datapoints instead would double-count the
    // overlapping cumulative windows and produce nonsense.
    const { ttm } = stitchTtmEps(MRK);
    expect(ttm).toBeCloseTo(1.26, 2);   // 2.32 + 1.20 - 1.72 - 0.54
  });

  test("matches an independently computed TTM for a clean filer", () => {
    // 2.87 + 2.82 + 5.11 + 9.11 = 19.91. NOTE the filer's own 6-month cumulative (14.24) differs
    // from its two discrete quarters (14.22) by a cent — EPS is rounded per period, so discrete
    // quarters and cumulative windows do not reconcile exactly. Discrete is the right basis here.
    expect(stitchTtmEps(GOOGL).ttm).toBeCloseTo(19.91, 2);
  });

  test("ignores overlapping cumulative periods rather than summing them", () => {
    // The 6-month and 9-month rows must never be added to the discrete quarters.
    const { quarters } = stitchTtmEps(GOOGL);
    expect(quarters.length).toBe(4);
    expect(quarters).not.toContain(14.24);   // the 6-month cumulative
    expect(quarters).not.toContain(7.99);    // the 9-month cumulative
  });

  test("flags a loss-making quarter inside the TTM window", () => {
    expect(stitchTtmEps(MRK).negative).toBe(true);
    expect(stitchTtmEps(GOOGL).negative).toBe(false);
  });

  test("returns null rather than a partial sum when quarters are missing", () => {
    expect(stitchTtmEps([p("2026-01-01", "2026-03-31", 1)]).ttm).toBeNull();
  });
});

describe("latestFyEps", () => {
  test("picks the most recent 12-month period", () => {
    expect(latestFyEps(MRK)).toEqual({ eps: 7.28, end: "2025-12-31" });
  });
});

describe("buildValuation — the rule is never a single number", () => {
  test("MRK: trailing P/E is arithmetically right and badly misleading", () => {
    const v = buildValuation("MRK", 149.50, MRK);
    expect(v.peTTM).toBeCloseTo(118.7, 0);   // correct, and useless on its own
    expect(v.peFY).toBeCloseTo(20.5, 0);     // the charge-insensitive reference
    expect(v.distorted).toBe(true);
    expect(v.hasNegativeQuarter).toBe(true);
    expect(v.headline).toBe("peFY");          // must NOT lead with the trailing figure
  });

  test("GOOGL: undistorted, so trailing leads", () => {
    const v = buildValuation("GOOGL", 354.97, GOOGL);
    expect(v.peTTM).toBeCloseTo(17.8, 1);
    expect(v.distorted).toBe(false);
    expect(v.headline).toBe("peTTM");
  });

  test("a negative TTM returns NULL, never a negative P/E", () => {
    // A negative P/E sorts as "cheapest" in any ranking — it must never enter one.
    const loss = [p("2025-01-01","2025-12-31",-4,"10-K"),
                  p("2025-10-01","2025-12-31",-1), p("2026-01-01","2026-03-31",-1),
                  p("2026-04-01","2026-06-30",-1), p("2026-07-01","2026-09-30",-1)];
    const v = buildValuation("X", 100, loss);
    expect(v.peTTM).toBeNull();
    expect(v.peFY).toBeNull();
    expect(v.headline).toBe("none");
  });

  test("zero or missing price never yields a P/E", () => {
    expect(buildValuation("X", 0, GOOGL).peTTM).toBeNull();
  });
});

describe("formatValuation", () => {
  test("a distorted name carries the warning and both figures", () => {
    const s = formatValuation(buildValuation("MRK", 149.50, MRK));
    expect(s).toContain("⚠");
    expect(s).toContain("20.54x");           // the usable number
    expect(s).toMatch(/distorted/i);
    expect(s).toMatch(/full-year/i);
  });

  test("a clean name reads plainly", () => {
    const s = formatValuation(buildValuation("GOOGL", 354.97, GOOGL));
    expect(s).toContain("17.83x");
    expect(s).not.toContain("⚠");
  });
});

describe("filedPoints — the empty-object trap", () => {
  test("SEC returns {} for a concept with no data, and {} is NOT null", () => {
    // The original guard was `units["USD/shares"] ?? []`. An empty OBJECT is not null, so it passed
    // straight through and the caller's .filter threw — swallowed by a catch and surfaced only as a
    // silent "unavailable". Verified live against KO on 2026-09-21.
    expect(filedPoints({ "USD/shares": {} })).toEqual([]);
    expect(filedPoints({ "USD/shares": {}, pure: {} })).toEqual([]);
  });

  test("handles missing, null and malformed units without throwing", () => {
    for (const bad of [undefined, null, {}, { USD: "text" }, { "USD/shares": 42 }]) {
      expect(() => filedPoints(bad)).not.toThrow();
      expect(filedPoints(bad)).toEqual([]);
    }
  });

  test("keeps only 10-Q and 10-K datapoints", () => {
    const pts = [
      { start: "2026-01-01", end: "2026-03-31", val: 1, form: "10-Q", fy: 2026, fp: "Q1" },
      { start: "2026-01-01", end: "2026-03-31", val: 9, form: "8-K", fy: 2026, fp: "Q1" },
    ];
    expect(filedPoints({ "USD/shares": pts }).map(p => p.val)).toEqual([1]);
  });

  test("drops null entries inside an otherwise valid array", () => {
    expect(filedPoints({ "USD/shares": [null, { form: "10-K", val: 2, start: "a", end: "b", fy: 1, fp: "FY" }] }).length).toBe(1);
  });
});
