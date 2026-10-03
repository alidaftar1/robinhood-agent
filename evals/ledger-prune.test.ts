import { describe, expect, test } from "bun:test";
import { pickTickersToPrune, MAX_PRUNE_FRACTION, type LedgerPick } from "../lib/influencer-ledger";

// This DELETES live history, so the selection predicate is the whole risk: one that quietly matched
// everything would be indistinguishable from the full reset the owner chose against.
const pick = (ticker: string, firstSeenDate: string): LedgerPick => ({
  ticker, channels: ["C"], maxScore: 4, maxConfidence: "high",
  firstSeenDate, lastSeenDate: "2026-10-01", priceAtSignal: 100,
});
const ledger = Object.fromEntries([
  pick("SPCX", "2026-07-28"), pick("BTC", "2026-07-28"), pick("MU", "2026-07-28"),
  pick("PLTR", "2026-07-29"), pick("AMD", "2026-07-29"),
  pick("CRWD", "2026-08-03"), pick("SK", "2026-08-04"), pick("AVGO", "2026-10-01"),
].map(p => [p.ticker, p]));

describe("pickTickersToPrune", () => {
  test("selects exactly the launch-cohort dates, nothing else", () => {
    expect(pickTickersToPrune(ledger, ["2026-07-28", "2026-07-29"]))
      .toEqual(["AMD", "BTC", "MU", "PLTR", "SPCX"]);
  });

  test("leaves genuine first-sighting rows alone", () => {
    const kept = pickTickersToPrune(ledger, ["2026-07-28", "2026-07-29"]);
    for (const t of ["CRWD", "SK", "AVGO"]) expect(kept).not.toContain(t);
  });

  test("an EMPTY date list removes nothing — it must never mean 'match all'", () => {
    expect(pickTickersToPrune(ledger, [])).toEqual([]);
  });

  test("a malformed date removes nothing rather than matching loosely", () => {
    expect(pickTickersToPrune(ledger, ["july 28", "", "2026-7-28"])).toEqual([]);
  });

  test("a date with no rows is a no-op, not an error", () => {
    expect(pickTickersToPrune(ledger, ["2026-01-01"])).toEqual([]);
  });

  test("matching is exact-date, not prefix — a month string must not take the month", () => {
    expect(pickTickersToPrune(ledger, ["2026-07"])).toEqual([]);
  });

  test("the refusal threshold is a real brake, not decoration", () => {
    // 5 of 8 here is 62.5% — above the cap, so the live path refuses it.
    const victims = pickTickersToPrune(ledger, ["2026-07-28", "2026-07-29"]);
    expect(victims.length / Object.keys(ledger).length).toBeGreaterThan(MAX_PRUNE_FRACTION);
    // Against the real 50-pick ledger the 14-row cohort is 28%, well under the cap.
    expect(14 / 50).toBeLessThan(MAX_PRUNE_FRACTION);
  });
});
