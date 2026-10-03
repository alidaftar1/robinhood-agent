import { describe, expect, test } from "bun:test";
import { computeUniverseDrift, currentMembers, parseSp500Csv } from "../lib/sharadar-universe";

// A name outside STOCK_SECTOR can never reach buildV1Shortlist, so the main book cannot buy it —
// silently, because the screen only reports on names it already knows. This report makes the gap
// visible. It changes no behaviour: both directions of an actual edit alter what the agent may buy.
describe("computeUniverseDrift", () => {
  test("names in the index but not ours are MISSING — the unreachable set", () => {
    const d = computeUniverseDrift(new Set(["AAPL", "AVGO"]), new Set(["AAPL"]));
    expect(d.missing).toEqual(["AVGO"]);
    expect(d.stale).toEqual([]);
  });

  test("names of ours no longer in the index are STALE", () => {
    const d = computeUniverseDrift(new Set(["AAPL"]), new Set(["AAPL", "ANSS"]));
    expect(d.stale).toEqual(["ANSS"]);
    expect(d.missing).toEqual([]);
  });

  test("a RENAME is neither — reporting it as both would double-count one company", () => {
    // We carry BK; the index carries BNY. Same filer. Adding BNY while removing BK would churn the
    // universe for a ticker change, and importing both spellings would count it twice.
    const d = computeUniverseDrift(new Set(["AAPL", "BNY"]), new Set(["AAPL", "BK"]), { BK: "BNY" });
    expect(d.renamed).toEqual([{ ours: "BK", index: "BNY" }]);
    expect(d.missing).toEqual([]);
    expect(d.stale).toEqual([]);
  });

  test("a rename only counts when BOTH spellings are present", () => {
    // We carry BK but the index does not carry BNY → BK is genuinely stale, not renamed.
    const d = computeUniverseDrift(new Set(["AAPL"]), new Set(["AAPL", "BK"]), { BK: "BNY" });
    expect(d.renamed).toEqual([]);
    expect(d.stale).toEqual(["BK"]);
  });

  test("counts report both sides, so a drift of 0 is distinguishable from an empty read", () => {
    const d = computeUniverseDrift(new Set(["AAPL", "MSFT"]), new Set(["AAPL", "MSFT"]));
    expect(d).toMatchObject({ missing: [], stale: [], inIndex: 2, inOurs: 2 });
  });

  test("an EMPTY index read reports everything stale rather than silently matching", () => {
    // Guards the caller: a failed/truncated fetch must look alarming, not clean.
    const d = computeUniverseDrift(new Set(), new Set(["AAPL", "MSFT"]));
    expect(d.stale).toEqual(["AAPL", "MSFT"]);
    expect(d.inIndex).toBe(0);
  });
});

describe("currentMembers", () => {
  const csv = [
    "date,action,ticker,name,contraticker,contraname,note",
    "2026-09-29,current,AAPL,APPLE INC,N/A,N/A,",
    "2026-09-29,current,AVGO,BROADCOM INC,N/A,N/A,",
    "2008-09-15,historical,LEHMQ,LEHMAN BROTHERS,N/A,N/A,",
    "2026-03-01,removed,ANSS,ANSYS INC,N/A,N/A,",
    "2026-03-01,added,PLTR,PALANTIR,N/A,N/A,",
  ].join("\n");

  test("takes ONLY the current snapshot — historical/added/removed rows are not membership", () => {
    expect([...currentMembers(parseSp500Csv(csv))].sort()).toEqual(["AAPL", "AVGO"]);
  });

  test("an 'added' row is not membership on its own — the current snapshot is the authority", () => {
    expect(currentMembers(parseSp500Csv(csv)).has("PLTR")).toBe(false);
  });
});
