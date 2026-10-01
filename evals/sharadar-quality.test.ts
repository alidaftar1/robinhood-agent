import { describe, test, expect } from "bun:test";
import {
  parseFundamentalsCsv, buildFundamentalIndex, latestFilingAsOf, qualityAsOf,
  type FundamentalRow,
} from "@/lib/sharadar-quality";

// Three ways to get point-in-time quality wrong, ALL of which look like alpha:
//   1. keying on the period end instead of the FILING date (Apple's FY2008 ended 2008-09-27 but was
//      filed 2008-11-05 — a 39-day window in which you'd be trading an unpublished report)
//   2. using RESTATED (MR*) figures, which embed revisions made later
//   3. scoring the percentile against the wrong cohort
// Each gets a test that fails if the guard is removed.

const row = (
  ticker: string, filed: string, period: string,
  assets: number | null, equity: number | null, liabilities: number | null, netinc: number | null,
  ncfo: number | null = null,
): FundamentalRow => ({ ticker, filed, period, assets, equity, liabilities, netinc, ncfo });

describe("trap 1: availability is decided by the FILING date, never the period end", () => {
  const list = [
    row("AAPL", "2007-11-15", "2007-12-31", 25347, 14532, 10815, 3496),
    row("AAPL", "2008-11-05", "2008-12-31", 39572, 21030, 18542, 4834),
    row("AAPL", "2009-10-27", "2009-12-31", 53851, 27832, 26019, 5704),
  ];

  test("on a date between period end and filing, the OLDER filing is used", () => {
    // 2008-10-01: FY2008 period has ended but the 10-K is not filed until 2008-11-05.
    const f = latestFilingAsOf(list, "2008-10-01")!;
    expect(f.filed).toBe("2007-11-15");
    expect(f.netinc).toBe(3496);          // FY2007's number, which is what was actually public
  });

  test("on the filing date itself the new filing becomes available", () => {
    expect(latestFilingAsOf(list, "2008-11-05")!.netinc).toBe(4834);
    expect(latestFilingAsOf(list, "2008-11-04")!.netinc).toBe(3496);
  });

  test("before ANY filing, returns null — never the earliest row", () => {
    // Reaching for the earliest row would be the forward-looking mistake in miniature.
    expect(latestFilingAsOf(list, "2000-01-01")).toBeNull();
  });

  test("an empty or absent history returns null rather than throwing", () => {
    expect(latestFilingAsOf([], "2008-01-01")).toBeNull();
    expect(latestFilingAsOf(undefined, "2008-01-01")).toBeNull();
  });
});

describe("trap 2: only AS-REPORTED annual rows are parsed", () => {
  const CSV = [
    "ticker,dimension,date,calendardate,assets,equity,liabilities,netinc",
    "ILMN,ARY,2009-02-26,2008-12-31,1377100000,848596000,528504000,50477000",
    "ILMN,MRY,2009-02-26,2008-12-31,1377100000,848596000,528504000,99999999",   // RESTATED
    "ILMN,ARQ,2009-02-26,2008-12-31,1377100000,848596000,528504000,12000000",   // quarterly
    "AAPL,ARY,2008-11-05,2008-12-31,39572000000,21030000000,18542000000,4834000000",
  ].join("\n");

  test("MR* (restated) and ARQ (quarterly) rows are excluded", () => {
    const rows = parseFundamentalsCsv(CSV);
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.ticker === "ILMN" ? r.netinc === 50477000 : true)).toBe(true);
    // The restated net income must not appear anywhere.
    expect(rows.some(r => r.netinc === 99999999)).toBe(false);
  });

  test("a ticker filter narrows the parse without changing semantics", () => {
    const rows = parseFundamentalsCsv(CSV, { tickers: new Set(["AAPL"]) });
    expect(rows.map(r => r.ticker)).toEqual(["AAPL"]);
  });

  test("a MISSING required column throws rather than silently yielding no fundamentals", () => {
    // Returning [] would read downstream as "no fundamentals" — the screen would quietly degrade to
    // momentum-only and the entire point of this module would evaporate with no error anywhere.
    const bad = "ticker,dimension,date,calendardate,assets,equity\nAAPL,ARY,2008-11-05,2008-12-31,1,1";
    expect(() => parseFundamentalsCsv(bad)).toThrow(/missing required columns/);
  });

  test("blank numeric cells parse as null, not 0", () => {
    const csv = [
      "ticker,dimension,date,calendardate,assets,equity,liabilities,netinc",
      "XYZ,ARY,2008-11-05,2008-12-31,1000,,500,100",
    ].join("\n");
    expect(parseFundamentalsCsv(csv)[0].equity).toBeNull();
  });
});

describe("the composite mirrors lib/quality.ts term for term", () => {
  // AAPL/MSFT = XLK, JPM = XLF (leverage dropped), AMT = XLRE (leverage dropped).
  const index = buildFundamentalIndex([
    row("AAPL", "2008-01-01", "2007-12-31", 1000, 500, 500, 200),   // roa .20 roe .40 lev .50
    row("MSFT", "2008-01-01", "2007-12-31", 1000, 500, 500, 100),   // roa .10 roe .20 lev .50
    row("KO", "2008-01-01", "2007-12-31", 1000, 500, 500, 50),      // roa .05 roe .10 lev .50
    row("JPM", "2008-01-01", "2007-12-31", 1000, 100, 900, 80),     // financial: lev dropped
  ]);

  test("higher ROA/ROE ranks higher, and eligibility splits at the cohort median", () => {
    const q = qualityAsOf(["AAPL", "MSFT", "KO", "JPM"], index, "2008-06-01");
    expect(q.cohortSize).toBe(4);
    expect(q.quality.get("AAPL")!).toBeGreaterThan(q.quality.get("MSFT")!);
    expect(q.quality.get("MSFT")!).toBeGreaterThan(q.quality.get("KO")!);
    expect(q.quality.get("AAPL")!).toBeGreaterThanOrEqual(q.median);
    expect(q.quality.get("KO")!).toBeLessThan(q.median);
  });

  test("ROE is DROPPED when equity is non-positive, and the name is still scored", () => {
    // A buyback-heavy negative-equity name must not be penalised out of the universe.
    const idx = buildFundamentalIndex([
      row("DPZ", "2008-01-01", "2007-12-31", 1000, -200, 1200, 350),   // negative equity, ROA .35
      row("KO", "2008-01-01", "2007-12-31", 1000, 500, 500, 50),
    ]);
    const q = qualityAsOf(["DPZ", "KO"], idx, "2008-06-01");
    expect(q.quality.has("DPZ")).toBe(true);
    // Scored on ROA alone; its 35% ROA is the best in the cohort, so it must rank top.
    expect(q.quality.get("DPZ")!).toBeGreaterThan(q.quality.get("KO")!);
  });

  test("a name with NO filing yet is ABSENT from the map, not scored 0", () => {
    // 0 is a real (worst) percentile — assigning it would rank an unknown name as definitively
    // low quality rather than unknown.
    const q = qualityAsOf(["AAPL", "NEWCO"], index, "2008-06-01");
    expect(q.quality.has("AAPL")).toBe(true);
    expect(q.quality.has("NEWCO")).toBe(false);
  });

  test("a name with zero or missing assets is skipped rather than dividing by zero", () => {
    const idx = buildFundamentalIndex([
      row("BAD", "2008-01-01", "2007-12-31", 0, 100, 100, 50),
      row("ALSOBAD", "2008-01-01", "2007-12-31", null, 100, 100, 50),
      row("KO", "2008-01-01", "2007-12-31", 1000, 500, 500, 50),
    ]);
    const q = qualityAsOf(["BAD", "ALSOBAD", "KO"], idx, "2008-06-01");
    expect(q.quality.has("BAD")).toBe(false);
    expect(q.quality.has("ALSOBAD")).toBe(false);
    expect(q.cohortSize).toBe(1);
  });
});

describe("trap 3: the percentile cohort is the point-in-time universe", () => {
  const index = buildFundamentalIndex([
    row("AAPL", "2008-01-01", "2007-12-31", 1000, 500, 500, 200),
    row("MSFT", "2008-01-01", "2007-12-31", 1000, 500, 500, 100),
    row("KO", "2008-01-01", "2007-12-31", 1000, 500, 500, 50),
  ]);

  test("the SAME name's percentile changes with the cohort it is measured against", () => {
    // Measured on KO, the WORST name in the cohort. Using AAPL here proves nothing: it is top on
    // both ROA and ROE, so its percentile is 1.0 whether measured against three names or one, and
    // the assertion passed for a reason unrelated to the cohort. KO discriminates — bottom of the
    // full cohort, top of a cohort containing only itself.
    const full = qualityAsOf(["AAPL", "MSFT", "KO"], index, "2008-06-01");
    const alone = qualityAsOf(["KO"], index, "2008-06-01");
    expect(alone.cohortSize).toBe(1);
    expect(full.quality.get("KO")!).toBeLessThan(alone.quality.get("KO")!);
  });

  test("a thin cohort is reported via cohortSize so a meaningless percentile is visible", () => {
    expect(qualityAsOf(["AAPL"], index, "2008-06-01").cohortSize).toBe(1);
    expect(qualityAsOf([], index, "2008-06-01").cohortSize).toBe(0);
  });
});

// The staleness finding, encoded as a test so it cannot silently regress. Real DVN figures.
// ARY refreshes ONCE a year, so on 2022-01-03 the newest annual filing was 2021-02-17 carrying
// FY2020's -$2.68B COVID loss. ART refreshes each QUARTER and had already caught DVN turning
// profitable (+$1.205B TTM, filed 2021-11-03). The gate excluded energy on stale losses exactly as
// energy began its best year in a decade — a 22-point effect in the 2022 backtest window.
describe("dimension freshness: ARY is stale in Q1 where ART is not", () => {
  const CSV = [
    "ticker,dimension,date,calendardate,assets,equity,liabilities,netinc",
    // annual: two refreshes across 18 months
    "DVN,ARY,2021-02-17,2020-12-31,9912000000,2885000000,6893000000,-2680000000",
    "DVN,ARY,2022-02-16,2021-12-31,21025000000,9262000000,11626000000,2813000000",
    // TTM: quarterly refreshes through the same turn
    "DVN,ART,2021-02-17,2020-12-31,9912000000,2885000000,6893000000,-2680000000",
    "DVN,ART,2021-05-05,2021-03-31,20457000000,8353000000,11971000000,-651000000",
    "DVN,ART,2021-08-04,2021-06-30,20065000000,8399000000,11530000000,275000000",
    "DVN,ART,2021-11-03,2021-09-30,21057000000,8924000000,11996000000,1205000000",
    "DVN,ART,2022-02-16,2021-12-31,21025000000,9262000000,11626000000,2813000000",
  ].join("\n");

  test("on 2022-01-03 ARY still reports a LOSS while ART reports a PROFIT", () => {
    const ary = buildFundamentalIndex(parseFundamentalsCsv(CSV, { dimension: "ARY" }));
    const art = buildFundamentalIndex(parseFundamentalsCsv(CSV, { dimension: "ART" }));
    const a = latestFilingAsOf(ary.get("DVN"), "2022-01-03")!;
    const t = latestFilingAsOf(art.get("DVN"), "2022-01-03")!;
    expect(a.filed).toBe("2021-02-17");
    expect(a.netinc).toBeLessThan(0);          // FY2020 COVID loss, 10+ months stale
    expect(t.filed).toBe("2021-11-03");
    expect(t.netinc).toBeGreaterThan(0);       // TTM had already turned
  });

  test("ART yields strictly more refreshes over the same span", () => {
    const ary = parseFundamentalsCsv(CSV, { dimension: "ARY" });
    const art = parseFundamentalsCsv(CSV, { dimension: "ART" });
    expect(art.length).toBeGreaterThan(ary.length);
  });

  test("both dimensions still agree on a date where the SAME filing is newest", () => {
    // Control: the freshness difference must come from refresh CADENCE, not from the two
    // dimensions disagreeing about a period they both report.
    const ary = buildFundamentalIndex(parseFundamentalsCsv(CSV, { dimension: "ARY" }));
    const art = buildFundamentalIndex(parseFundamentalsCsv(CSV, { dimension: "ART" }));
    expect(latestFilingAsOf(ary.get("DVN"), "2021-03-01")!.netinc)
      .toBe(latestFilingAsOf(art.get("DVN"), "2021-03-01")!.netinc);
  });
});
