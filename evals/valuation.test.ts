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

import { pointsIncludeReport, getValuations } from "@/lib/valuation";
import { hasPrintedBySession, selectPastReport, RECENT_FLAG_DAYS } from "@/lib/earnings";

describe("a P/E must never mix a post-print price with pre-print earnings", () => {
  const pt = (end: string, filed: string): XbrlPoint =>
    ({ start: "2026-01-01", end, val: 1, form: "10-Q", fy: 2026, fp: "Q2", filed });

  test("keying on CACHE WRITE TIME does not work — the data is what matters", () => {
    // The 10-Q lags the press release (weeks, for many filers). A refetch triggered by "cached
    // before the print" returns the SAME pre-print points and re-stamps the timestamp, so two runs
    // later the write-time test passes and serves pre-print EPS against a post-print price for the
    // rest of the TTL — the failure reintroduced by its own fix.
    const prePrint = [pt("2026-06-30", "2026-07-20")];
    expect(pointsIncludeReport(prePrint, "2026-09-15")).toBe(false);   // refetching cannot change this
  });

  test("a filing at or after the report date carries the print", () => {
    expect(pointsIncludeReport([pt("2026-09-30", "2026-09-22")], "2026-09-15")).toBe(true);
    expect(pointsIncludeReport([pt("2026-09-30", "2026-09-15")], "2026-09-15")).toBe(true);  // same day
  });

  test("no recent report means there is nothing to miss", () => {
    expect(pointsIncludeReport([pt("2026-06-30", "2026-07-20")], undefined)).toBe(true);
  });

  test("an unparseable report date fails SAFE — assumed not covered", () => {
    expect(pointsIncludeReport([pt("2026-09-30", "2026-09-22")], "garbage")).toBe(false);
  });

  test("points with no filed date cannot prove coverage", () => {
    const noFiled = [{ start: "2026-04-01", end: "2026-06-30", val: 1, form: "10-Q", fy: 2026, fp: "Q2" }];
    expect(pointsIncludeReport(noFiled, "2026-09-15")).toBe(false);
  });

  test("only ONE point needs to post-date the report", () => {
    const mixed = [pt("2026-03-31", "2026-04-20"), pt("2026-09-30", "2026-09-22")];
    expect(pointsIncludeReport(mixed, "2026-09-15")).toBe(true);
  });

  test("a post-print filing carrying ONLY a year-ago comparative does not prove coverage", () => {
    // Every 10-Q ships the fresh quarter AND its year-ago comparative under one accession, so this
    // shape does not arise from a normal 10-Q. It arises from an amendment or an S-8 landing after
    // the print: filed late, but the periods inside are stale. Post-date alone would say "covered".
    const comparativeOnly = [pt("2025-09-30", "2026-09-22")];
    expect(pointsIncludeReport(comparativeOnly, "2026-09-15")).toBe(false);
  });

  test("real SEC shapes: the 10-Q's own comparative does not rescue a pre-print cache", () => {
    // AAPL 0000320193-26-000020, filed 2026-07-31, verified live: the accession carries BOTH
    // end=2026-06-27 (lag 34d) and end=2025-06-28 (lag 398d). Whichever the cache happens to hold,
    // only the fresh period may vouch for the print.
    const fresh = { start: "2026-03-29", end: "2026-06-27", val: 2.02, form: "10-Q", fy: 2026, fp: "Q3", filed: "2026-07-31" };
    const comparative = { start: "2025-03-30", end: "2025-06-28", val: 1.57, form: "10-Q", fy: 2026, fp: "Q3", filed: "2026-07-31" };
    expect(pointsIncludeReport([fresh, comparative], "2026-07-30")).toBe(true);
    expect(pointsIncludeReport([comparative], "2026-07-30")).toBe(false);
  });

  test("a late filer still passes — the window is ~4x the observed 23-38 day lag", () => {
    // Guard against tightening REPORTED_PERIOD_MAX_AGE_DAYS into a check that suppresses every
    // slow filer. A quarter ending 100 days before the print is unusual but legitimate.
    expect(pointsIncludeReport([pt("2026-06-07", "2026-09-16")], "2026-09-15")).toBe(true);
  });

  test("a point with no period end cannot vouch for the print", () => {
    const noEnd = [{ start: "2026-07-01", val: 1, form: "10-Q", fy: 2026, fp: "Q3", filed: "2026-09-22" } as unknown as XbrlPoint];
    expect(pointsIncludeReport(noEnd, "2026-09-15")).toBe(false);
  });
});

describe("widening the valuation window must NOT widen the 📊REPORTED flag", () => {
  // The two horizons were one number until the P/E guard needed 60 days while the display flag had
  // to stay at 7. Nothing pinned the split, and it is invisible if it breaks: a six-week-old print
  // would silently start rendering as "just reported" on the shortlist, influencer, and held tables.
  const today = "2026-09-21";
  const cutoff = "2026-09-14";   // today - RECENT_FLAG_DAYS
  const row = (date: string, hour?: string) => ({ symbol: "XYZ", date, hour });

  test("a print exactly at the cutoff is still 'recent' — the boundary is inclusive both sides", () => {
    const got = selectPastReport([row("2026-09-14")], "XYZ", today, cutoff);
    expect(got.recent?.date).toBe("2026-09-14");
    expect(got.last?.date).toBe("2026-09-14");
  });

  test("a print one day past the cutoff drives suppression but NOT the flag", () => {
    const got = selectPastReport([row("2026-09-13")], "XYZ", today, cutoff);
    expect(got.recent).toBeUndefined();          // would have over-claimed "just reported"
    expect(got.last?.date).toBe("2026-09-13");   // but the P/E guard still needs it
  });

  test("a six-week-old print reaches suppression only — the case the split exists for", () => {
    const got = selectPastReport([row("2026-08-10")], "XYZ", today, cutoff);
    expect(got.recent).toBeUndefined();
    expect(got.last?.date).toBe("2026-08-10");
  });

  test("the amc shift still applies to daysAgo, and is NOT applied to the cutoff", () => {
    const got = selectPastReport([row("2026-09-14", "amc")], "XYZ", today, cutoff);
    expect(got.recent?.daysAgo).toBe(6);         // reacted 09-15, not 09-14
    expect(got.last?.hour).toBe("amc");
  });

  test("the most recent past print wins, and today's print is not a PAST one", () => {
    const got = selectPastReport([row("2026-08-10"), row("2026-09-16"), row(today)], "XYZ", today, cutoff);
    expect(got.last?.date).toBe("2026-09-16");
    expect(got.recent?.date).toBe("2026-09-16");
  });

  test("rows for other symbols are ignored", () => {
    const got = selectPastReport([{ symbol: "OTHER", date: "2026-09-16" }], "XYZ", today, cutoff);
    expect(got.last).toBeUndefined();
  });

  test("the flag horizon is 7 days", () => expect(RECENT_FLAG_DAYS).toBe(7));
});

describe("only a name that has ALREADY printed may suppress its P/E", () => {
  test("an after-close reporter has not printed when the 10:30 ET run happens", () => {
    // Roughly half of S&P reporters are amc. At 10:30 ET its price has not gapped, so its pre-print
    // EPS is still the right denominator — suppressing it discards a correct P/E and tells the
    // model something false about the name.
    expect(hasPrintedBySession("2026-09-21", "amc", "2026-09-21")).toBe(false);
  });

  test("before-open and unspecified have printed by mid-session", () => {
    expect(hasPrintedBySession("2026-09-21", "bmo", "2026-09-21")).toBe(true);
    expect(hasPrintedBySession("2026-09-21", undefined, "2026-09-21")).toBe(true);
    expect(hasPrintedBySession("2026-09-21", "dmh", "2026-09-21")).toBe(true);
  });

  test("yesterday's amc report HAS printed; tomorrow's has not", () => {
    expect(hasPrintedBySession("2026-09-18", "amc", "2026-09-21")).toBe(true);
    expect(hasPrintedBySession("2026-09-22", "bmo", "2026-09-21")).toBe(false);
  });
});

describe("an expired time budget must never become a fact about a company", () => {
  // Round 4 found the one path in this feature that could put a WRONG number in front of the
  // model rather than withholding one, and it hinged entirely on abort handling. These pin the
  // observable half without a network: with an already-aborted signal nothing may be fetched, no
  // valuation may be produced, and the note must blame the budget, not the filer.
  const priceOf = () => 100;

  test("an already-expired budget yields no valuations and blames itself", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { valuations, notes } = await getValuations(["AAPL", "MSFT"], priceOf, ctrl.signal, {
      reportedOn: new Map([["AAPL", "2026-09-15"]]),
    });
    expect(valuations.size).toBe(0);
    const joined = notes.join(" ");
    expect(joined).toMatch(/time budget/i);
    // The dangerous misread: absence rendered as a statement about the business.
    expect(joined).not.toMatch(/no SEC EPS data/i);
    expect(joined).toMatch(/do NOT read it as a fact about the company/i);
  });

  test("an aborted run never claims SEC has not filed", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { notes } = await getValuations(["AAPL"], priceOf, ctrl.signal, {
      reportedOn: new Map([["AAPL", "2026-09-15"]]),
    });
    // prePrint asserts EDGAR's state. We never reached EDGAR, so that claim must not appear.
    expect(notes.join(" ")).not.toMatch(/filings do not yet carry/i);
  });
});

describe("a truncated read must not be cached as a complete one", () => {
  // THE defect round 4 found, and the one my first two abort tests could not reach: fetchEpsPoints
  // sweeps three EPS tags keeping the most recent, and concept() swallows AbortError per tag — so
  // an abort PARTWAY returns a non-empty series that is missing the tag the sweep exists to prefer.
  // Aborting before the call cannot exercise this; the loop returns earlier. Abort DURING it.
  const priceOf = () => 100;
  // NOT a real ticker. The success path reaches cachePoints, which SETs valuation:eps:<symbol> for
  // 7 days — with real Upstash credentials a fabricated fixture under "AAPL" would serve a made-up
  // TTM EPS into the live trade prompt for a week.
  // Per-run suffix: the control's success path writes valuation:eps:<SYM> with a 7-day TTL, so a
  // fixed name would be served from cache on the NEXT run with creds loaded — the abort test would
  // then skip the fetch path entirely and pass without exercising anything.
  const SYM = `ZZTEST${process.pid}`;

  // Derived from today, not hardcoded: buildValuation drops anything older than MAX_STALENESS_DAYS,
  // so fixed dates quietly rot into "headline: none" and the assertions start passing for the
  // wrong reason — the vacuity this block exists to avoid.
  const qEnd = (quartersAgo: number) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 3 * quartersAgo);
    return d.toISOString().slice(0, 10);
  };
  const quarter = (n: number, val: number) => ({
    start: qEnd(n + 1), end: qEnd(n), val, form: "10-Q", fy: 2026, fp: `Q${(n % 4) + 1}`, filed: qEnd(n),
  });

  test("points returned by a sweep that aborted mid-flight are discarded, not valued", async () => {
    const ctrl = new AbortController();
    const { valuations, notes } = await getValuations([SYM], priceOf, ctrl.signal, {
      // The SAME four quarters the control values successfully. With a single quarter the
      // withheld-assertion below was vacuous — stitchTtmEps returns null for one, so no valuation
      // appears whether or not the guard runs: exactly the wrong-reason pass the control rules out.
      fetchPoints: async () => { ctrl.abort(); return [quarter(0, 2), quarter(1, 2), quarter(2, 2), quarter(3, 2)]; },
    });
    expect(valuations.has(SYM)).toBe(false);
    expect(notes.join(" ")).toMatch(/time budget/i);
  });

  test("the SAME four quarters from a sweep that COMPLETED are valued normally", async () => {
    // The control, and it must be load-bearing: without it the test above could pass merely because
    // the fixture was unusable, and would keep passing if the guard became a blanket discard.
    const ctrl = new AbortController();
    const complete = [quarter(0, 2), quarter(1, 2), quarter(2, 2), quarter(3, 2)];
    const { valuations, notes } = await getValuations([SYM], priceOf, ctrl.signal, {
      fetchPoints: async () => complete,
    });
    expect(notes.join(" ")).not.toMatch(/time budget/i);
    expect(valuations.has(SYM)).toBe(true);   // proves the fixture itself is valuable
  });
});
