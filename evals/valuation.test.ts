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
    expect(s).toMatch(/depressed by charges/i);
    expect(s).toMatch(/full-year/i);
    expect(s).not.toContain("null");
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

describe("silent-wrong guards — a bad TTM must be null, never a number", () => {
  const q = (start: string, end: string, val: number, form = "10-Q"): XbrlPoint =>
    ({ start, end, val, form, fy: 2026, fp: "Q1" });

  test("a GAP in the quarter series returns null, not a TTM spanning 18 months", () => {
    // slice(-4) alone takes "the four most recent quarters I could resolve" — with Q3/Q4'25
    // unresolvable that silently summed an 18-month window and reported it as trailing-twelve.
    const gapped = [
      q("2025-01-01", "2025-03-31", 1), q("2025-04-01", "2025-06-30", 1),
      q("2026-01-01", "2026-03-31", 1), q("2026-04-01", "2026-06-30", 1),
    ];
    expect(stitchTtmEps(gapped).ttm).toBeNull();
  });

  test("a discrete Q4 tagged a day off the fiscal-year end is not double-counted", () => {
    // 52/53-week filers tag Q4 as ending 12-30 while the FY says 12-31. An exact-match guard then
    // derived a SECOND Q4 — verified to overstate TTM by 30% and silently drop Q1.
    const offByOne = [
      q("2025-01-01", "2025-03-31", 1), q("2025-04-01", "2025-06-30", 2), q("2025-07-01", "2025-09-30", 3),
      q("2025-10-01", "2025-12-30", 4),                       // discrete Q4, end 12-30
      q("2025-01-01", "2025-09-30", 6), q("2025-01-01", "2025-12-31", 10, "10-K"),  // FY end 12-31
    ];
    expect(stitchTtmEps(offByOne).ttm).toBeCloseTo(10, 2);   // not 13
  });

  test("contiguous quarters still produce a TTM", () => {
    const clean = [
      q("2025-10-01", "2025-12-31", 1), q("2026-01-01", "2026-03-31", 2),
      q("2026-04-01", "2026-06-30", 3), q("2026-07-01", "2026-09-30", 4),
    ];
    expect(stitchTtmEps(clean).ttm).toBeCloseTo(10, 2);
  });
});

describe("divergence is DIRECTIONAL — growth is not distortion", () => {
  const q = (start: string, end: string, val: number, form = "10-Q"): XbrlPoint =>
    ({ start, end, val, form, fy: 2026, fp: "Q1" });
  const grower = [
    q("2025-01-01", "2025-12-31", 1.20, "10-K"),
    q("2025-10-01", "2025-12-31", 0.75), q("2026-01-01", "2026-03-31", 0.75),
    q("2026-04-01", "2026-06-30", 0.75), q("2026-07-01", "2026-09-30", 0.75),
  ];

  test("a company whose earnings TRIPLED leads with trailing, not the stale full year", () => {
    // Symmetric >2x called this "distorted" and pushed the reader to the full year — reporting
    // 100x while suppressing the correct 40x.
    const v = buildValuation("GROW", 120, grower);
    expect(v.peTTM).toBeCloseTo(40, 0);
    expect(v.peFY).toBeCloseTo(100, 0);
    expect(v.distorted).toBe(false);
    expect(v.grew).toBe(true);
    expect(v.headline).toBe("peTTM");
    expect(formatValuation(v)).toContain("earnings grew");
  });
});

describe("recency", () => {
  const q = (start: string, end: string, val: number, form = "10-Q"): XbrlPoint =>
    ({ start, end, val, form, fy: 2019, fp: "Q1" });
  test("a years-stale filing history yields no P/E rather than a confident one", () => {
    const old = [
      q("2018-10-01", "2018-12-31", 1), q("2019-01-01", "2019-03-31", 1),
      q("2019-04-01", "2019-06-30", 1), q("2019-07-01", "2019-09-30", 1),
    ];
    const v = buildValuation("STALE", 100, old, Date.parse("2026-09-21T00:00:00Z"));
    expect(v.peTTM).toBeNull();
    expect(v.headline).toBe("none");
    expect(formatValuation(v)).not.toContain("25x");
  });
});

describe("filedPoints picks the populated unit key", () => {
  test("an empty USD/shares must not mask a populated USD array", () => {
    // `units["USD/shares"] ?? units.USD` — {} is not nullish, so the real data was never reached.
    const pt = { start: "2026-01-01", end: "2026-03-31", val: 5, form: "10-K", fy: 2026, fp: "FY" };
    expect(filedPoints({ "USD/shares": {}, USD: [pt] }).length).toBe(1);
  });
});

import { formatValuations } from "@/lib/valuation";

describe("formatValuations — the prompt block", () => {
  const mk = (symbol: string, peTTM: number | null, peFY: number | null, opts: Partial<import("@/lib/valuation").Valuation> = {}) =>
    ({ symbol, price: 100, ttmEps: 1, fyEps: 1, fyEnd: "2025-12-31", peTTM, peFY,
       hasNegativeQuarter: false, distorted: false, grew: false,
       headline: (peTTM != null ? "peTTM" : "peFY") as "peTTM" | "peFY", ...opts });

  test("renders nothing when there is nothing to say", () => {
    expect(formatValuations(new Map())).toBe("");
  });

  test("sorts cheapest first so the comparison is doable at a glance", () => {
    const m = new Map<string, any>([
      ["DEARCO", mk("DEARCO", 40, 40)],
      ["CHEAPCO", mk("CHEAPCO", 10, 10)],
      ["MIDCO", mk("MIDCO", 25, 25)],
    ]);
    const out = formatValuations(m);
    expect(out.indexOf("CHEAPCO")).toBeLessThan(out.indexOf("MIDCO"));
    expect(out.indexOf("MIDCO")).toBeLessThan(out.indexOf("DEARCO"));
  });

  test("states that this is the ONLY price-based input, and why that matters", () => {
    const out = formatValuations(new Map([["ACME", mk("ACME", 20, 20)]]) as any);
    expect(out).toMatch(/only price-based/i);
    expect(out).toMatch(/no price\s+term/i);      // names the quality score's blind spot
    expect(out).toMatch(/never whether it is EXPENSIVE/i);
  });

  test("forbids the two misreadings that would do damage", () => {
    const out = formatValuations(new Map([["ACME", mk("ACME", 20, 20)]]) as any);
    // must not become a buy trigger or an eligibility override...
    expect(out).toMatch(/does NOT change eligibility/i);
    // ...and absence must not be read as cheapness.
    expect(out).toMatch(/missing name\s+means no reliable figure, NOT that it is cheap/i);
  });

  test("a charge-distorted name is sorted and shown on its FULL-YEAR figure", () => {
    const m = new Map<string, any>([
      ["CLEANCO", mk("CLEANCO", 30, 30)],
      ["CHARGEDCO", mk("CHARGEDCO", 119, 20, { distorted: true, headline: "peFY" })],
    ]);
    const out = formatValuations(m);
    // 20x (real) must sort ahead of 30x — NOT 119x behind it.
    expect(out.indexOf("CHARGEDCO")).toBeLessThan(out.indexOf("CLEANCO"));
    expect(out).toMatch(/do not quote the trailing number/i);
  });
});

describe("the block cannot be read as a sell reason", () => {
  test("states BUY-SIDE ONLY and forbids selling on a multiple", () => {
    // Main-book sells are NOT shortlist-gated in code — route.ts executes any decided sell that
    // maps to a live position. So the prompt is the only guard, and every other line in this block
    // is phrased in buy vocabulary.
    const v: any = { symbol: "RICH", price: 100, ttmEps: 1, fyEps: 1, fyEnd: "2025-12-31",
      peTTM: 60, peFY: 60, hasNegativeQuarter: false, distorted: false, grew: false, headline: "peTTM" };
    const out = formatValuations(new Map([["RICH", v]]));
    expect(out).toMatch(/BUY-SIDE ONLY/);
    expect(out).toMatch(/never on its own a reason to SELL/i);
    expect(out).toMatch(/Do not trim or exit a holding because of its P\/E/i);
  });
});
