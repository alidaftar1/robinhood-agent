import { describe, test, expect } from "bun:test";
import {
  parseSp500Csv, splitCsvLine, buildUniverseIndex, membersAsOf, membersAsOfPrecise,
  lastSnapshotOnOrBefore, reconcileDeltas, snapshotAgeDays, removalsBetween,
} from "@/lib/sharadar-universe";

// This file decides whether a backtest is survivorship-free. Get it wrong and every result is
// flattering nonsense — you'd be testing "the companies that made it to 2026", a universe selected
// on the very outcome being measured. So these tests are about DIRECTION (never resolve forward)
// and about not silently dropping the failed companies.

const CSV = [
  "date,action,ticker,name,contraticker,contraname,note",
  "2008-06-30,historical,AAPL,APPLE INC,N/A,N/A,",
  "2008-06-30,historical,LEHMQ,LEHMAN BROTHERS HOLDINGS INC,N/A,N/A,",
  "2008-06-30,historical,WB1,WACHOVIA CORP,N/A,N/A,",
  '2008-09-22,removed,LEHMQ,LEHMAN BROTHERS HOLDINGS INC,LHX,L3HARRIS,"Lehman Brothers Holdings filed for bankruptcy. Announced 2008-09-15."',
  "2008-09-22,added,LHX,L3HARRIS TECHNOLOGIES INC,LEHMQ,LEHMAN,",
  "2008-09-30,historical,AAPL,APPLE INC,N/A,N/A,",
  "2008-09-30,historical,WB1,WACHOVIA CORP,N/A,N/A,",
  "2008-09-30,historical,LHX,L3HARRIS TECHNOLOGIES INC,N/A,N/A,",
].join("\n");

const rows = parseSp500Csv(CSV);
const idx = buildUniverseIndex(rows);

describe("CSV parsing survives real company names", () => {
  test("a quoted field containing commas does not shift every later column", () => {
    const f = splitCsvLine('2008-09-22,removed,LEHMQ,"LEHMAN BROTHERS, INC",LHX,L3,"note, with comma"');
    expect(f[2]).toBe("LEHMQ");
    expect(f[3]).toBe("LEHMAN BROTHERS, INC");
    expect(f[4]).toBe("LHX");
  });

  test("escaped double-quotes inside a quoted field", () => {
    expect(splitCsvLine('a,"say ""hi""",b')[1]).toBe('say "hi"');
  });
});

describe("membership resolution is BACKWARD-LOOKING ONLY", () => {
  test("a date before coverage returns null, NOT the first snapshot", () => {
    // Reaching forward here is the look-ahead that makes backtests lie.
    expect(membersAsOf(idx, "1990-01-01")).toBeNull();
    expect(lastSnapshotOnOrBefore(idx, "1990-01-01")).toBeNull();
  });

  test("resolves to the most recent snapshot ON OR BEFORE the date", () => {
    expect(lastSnapshotOnOrBefore(idx, "2008-08-15")).toBe("2008-06-30");
    expect(lastSnapshotOnOrBefore(idx, "2008-09-30")).toBe("2008-09-30");   // inclusive
    expect(lastSnapshotOnOrBefore(idx, "2030-01-01")).toBe("2008-09-30");   // latest available
  });

  test("a mid-quarter date does not see a company that only joined LATER", () => {
    // LHX joined 2008-09-22. On 2008-08-15 it must be invisible, from either resolver.
    expect(membersAsOf(idx, "2008-08-15")!.has("LHX")).toBe(false);
    expect(membersAsOfPrecise(idx, rows, "2008-08-15")!.has("LHX")).toBe(false);
  });

  test("snapshot staleness is reported, not hidden", () => {
    expect(snapshotAgeDays(idx, "2008-07-30")).toBe(30);
    expect(snapshotAgeDays(idx, "1990-01-01")).toBeNull();
  });
});

describe("the failed companies are retained — the whole point", () => {
  test("Lehman IS a member before its bankruptcy and is NOT after", () => {
    expect(membersAsOfPrecise(idx, rows, "2008-09-12")!.has("LEHMQ")).toBe(true);
    expect(membersAsOfPrecise(idx, rows, "2008-09-25")!.has("LEHMQ")).toBe(false);
  });

  test("dated deltas apply STRICTLY between the snapshot and the date", () => {
    const before = membersAsOfPrecise(idx, rows, "2008-09-21")!;   // day before the removal
    const after = membersAsOfPrecise(idx, rows, "2008-09-22")!;    // day of
    expect(before.has("LEHMQ")).toBe(true);
    expect(after.has("LEHMQ")).toBe(false);
    expect(after.has("LHX")).toBe(true);
  });

  test("removals carry their stated reason, so a run can PROVE it saw the failures", () => {
    const r = removalsBetween(rows, "2008-01-01", "2008-12-31");
    expect(r.length).toBe(1);
    expect(r[0].ticker).toBe("LEHMQ");
  });

  test("the ticker universe includes delisted names under their SUFFIXED symbols", () => {
    // LEHMQ not LEH, WB1 not WB. Querying the symbol you'd expect returns zero rows and NO error,
    // which reads exactly like "no data" while actually dropping the bankruptcy.
    expect(idx.allTickers.has("LEHMQ")).toBe(true);
    expect(idx.allTickers.has("WB1")).toBe(true);
    expect(idx.allTickers.has("LEH")).toBe(false);
  });
});

describe("delta reconciliation is what makes the precise resolver trustworthy", () => {
  test("deltas reproduce the next snapshot exactly on this fixture", () => {
    const rec = reconcileDeltas(idx, rows);
    expect(rec.length).toBe(1);
    expect(rec[0].missing).toBe(0);
    expect(rec[0].extra).toBe(0);
  });

  test("a DROPPED delta row is caught by reconciliation rather than silently drifting", () => {
    // Remove the 'removed' row: the predicted 2008-09-30 set now wrongly retains LEHMQ.
    const broken = rows.filter(r => !(r.action === "removed" && r.ticker === "LEHMQ"));
    const rec = reconcileDeltas(buildUniverseIndex(broken), broken);
    expect(rec[0].extra).toBeGreaterThan(0);
  });
});
