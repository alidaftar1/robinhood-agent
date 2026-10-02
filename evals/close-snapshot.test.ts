/**
 * Tests for the closing-bell snapshot: the ET clock (DST), the fail-closed validator, and the
 * close-to-close return derivation.
 *
 * Written adversarially on purpose. Per CLAUDE.md's data-integrity section, a test authored next to
 * the code inherits the code's blind spot, so the cases here are the ones where a plausible
 * implementation is WRONG rather than the ones where it works:
 *   - the ET date at 21:00 UTC is the PREVIOUS calendar day in UTC terms (date rollover)
 *   - a deposit must read as a transfer, not a +51% day
 *   - the trade window is (prevDate, date], so a fill dated prevDate must be EXCLUDED
 *   - an unpriceable position withholds the whole snapshot rather than marking it at cost
 * Each assertion below was mutation-checked: the guard was broken and the test confirmed failing.
 *
 * There is also a CONTROL (`stores a fully priced snapshot`) so the validator suite cannot pass by
 * rejecting everything.
 */
import { describe, it, expect } from "bun:test";
import {
  etParts, isAfterUsEquityClose, validateCloseSnapshot, computeCloseReturns, summarizeCloseReturns,
  CLOSE_SETTLE_MINUTES, MAX_PAIR_GAP_DAYS, type CloseSnapshot,
} from "../lib/close-snapshot";
import type { PositionSnapshot, TradeSnapshot } from "../lib/run-store";

const pos = (symbol: string, quantity: number, avgCost: number, price: number | ""): PositionSnapshot =>
  ({ symbol, quantity: String(quantity), avgCost: String(avgCost), price: String(price) });

// state is "submitted", not "filled": Claude emits submitted orders and computeDailyReturn counts
// ALL placed trades on purpose — filtering by state would zero out tradeNetCash on trade days.
const trade = (symbol: string, side: string, quantity: number, avgPrice: number | ""): TradeSnapshot =>
  ({ symbol, side, quantity: String(quantity), avgPrice: String(avgPrice), state: "submitted" });

const snap = (date: string, spyClose: number, totalValue: number, positions: PositionSnapshot[]): CloseSnapshot =>
  ({ date, capturedAt: `${date}T21:10:00.000Z`, spyClose, totalValue, positions });

describe("etParts — ET wall clock across DST", () => {
  it("reads 21:10 UTC as 17:10 ET under EDT", () => {
    expect(etParts(new Date("2026-10-01T21:10:00Z"))).toEqual({ date: "2026-10-01", minutes: 17 * 60 + 10 });
  });

  it("reads the same UTC time as 16:10 ET under EST", () => {
    expect(etParts(new Date("2026-01-15T21:10:00Z"))).toEqual({ date: "2026-01-15", minutes: 16 * 60 + 10 });
  });

  it("uses the ET calendar date, not the UTC one, after 20:00 ET", () => {
    // 01:00 UTC on the 2nd is still 21:00 ET on the 1st. Using the UTC date here would file the
    // snapshot under tomorrow and produce a phantom extra day in the series.
    expect(etParts(new Date("2026-10-02T01:00:00Z")).date).toBe("2026-10-01");
  });

  it("reads the 10:30 ET trade-cron instant as mid-session", () => {
    expect(etParts(new Date("2026-10-01T14:30:00Z")).minutes).toBe(10 * 60 + 30);
  });
});

describe("isAfterUsEquityClose", () => {
  it("rejects the instant one minute before the settle buffer", () => {
    // 16:04 ET under EDT = 20:04 UTC
    expect(isAfterUsEquityClose(new Date("2026-10-01T20:04:00Z"))).toBe(false);
  });

  it("accepts the settle buffer itself", () => {
    expect(isAfterUsEquityClose(new Date("2026-10-01T20:05:00Z"))).toBe(true);
  });

  it("rejects the trade cron's own 10:30 ET instant", () => {
    expect(isAfterUsEquityClose(new Date("2026-10-01T14:30:00Z"))).toBe(false);
  });

  it("accepts the scheduled 21:10 UTC firing in BOTH DST halves", () => {
    expect(isAfterUsEquityClose(new Date("2026-07-15T21:10:00Z"))).toBe(true);  // EDT → 17:10
    expect(isAfterUsEquityClose(new Date("2026-01-15T21:10:00Z"))).toBe(true);  // EST → 16:10
  });

  it("keeps the buffer after the close, not before it", () => {
    expect(CLOSE_SETTLE_MINUTES).toBeGreaterThanOrEqual(16 * 60);
  });
});

describe("IF the capture cron is scheduled, it fires after the close year-round", () => {
  // A config invariant, not a unit test of logic. The cron is currently NOT scheduled: the
  // close-to-close series is reconstructed on demand by scripts/close-reconstruct.ts instead, which
  // needs no new write path into live-money data AND covers the existing run history, which a
  // forward-only capture never could. The route stays built and tested so enabling it later is a
  // one-line vercel.json change — and this test guards that line. Someone adding it as 20:10 UTC
  // would silently sample 50 minutes BEFORE the EST close and the series would quietly go back to
  // being mid-session marks.
  it("fires after the settled close in January and July", async () => {
    const cfg = await Bun.file(`${import.meta.dir}/../vercel.json`).json();
    const cron = cfg.crons.find((c: { path: string }) => c.path.startsWith("/api/close-snapshot"));
    if (!cron) return;  // not scheduled — nothing to assert, see the note above
    const [min, hour] = cron.schedule.split(" ");
    const hh = String(hour).padStart(2, "0"), mm = String(min).padStart(2, "0");
    for (const day of ["2026-01-15", "2026-07-15"]) {
      expect(isAfterUsEquityClose(new Date(`${day}T${hh}:${mm}:00Z`))).toBe(true);
    }
  });
});

describe("validateCloseSnapshot — fails closed", () => {
  const good = [pos("AAA", 10, 100, 101), pos("BBB", 2, 50, 49)];

  it("CONTROL: stores a fully priced snapshot", () => {
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: 2000, positions: good })).toEqual({ ok: true });
  });

  it("withholds when any single position could not be priced", () => {
    // The one that matters. computeDailyReturn's priceOf silently substitutes avgCost for a missing
    // price, so storing this would mark BBB at cost and inject a phantom move into tomorrow's return.
    const r = validateCloseSnapshot({ spyClose: 760, totalValue: 2000, positions: [pos("AAA", 10, 100, 101), pos("BBB", 2, 50, "")] });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe("unpriced:BBB");
  });

  it("withholds on a missing SPY close", () => {
    expect(validateCloseSnapshot({ spyClose: null, totalValue: 2000, positions: good }).ok).toBe(false);
  });

  it("withholds on a non-positive SPY close", () => {
    expect(validateCloseSnapshot({ spyClose: 0, totalValue: 2000, positions: good }).ok).toBe(false);
  });

  it("withholds on a missing or zero total value", () => {
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: null, positions: good }).ok).toBe(false);
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: 0, positions: good }).ok).toBe(false);
  });

  it("withholds when the positions fetch failed entirely", () => {
    // null (fetch failed) is NOT the same as [] (genuinely flat), and must not be treated as flat:
    // an empty book would value the account at 0 and read as a −100% day.
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: 2000, positions: null }).ok).toBe(false);
  });

  it("accepts a genuinely empty book", () => {
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: 2000, positions: [] })).toEqual({ ok: true });
  });

  it("withholds on a zero-quantity position", () => {
    expect(validateCloseSnapshot({ spyClose: 760, totalValue: 2000, positions: [pos("AAA", 0, 100, 101)] }).ok).toBe(false);
  });
});

describe("computeCloseReturns — transfers, trades, and withholding", () => {
  it("books a DEPOSIT as a transfer, not as return", () => {
    // AAA 10 shares 100 → 101 is a genuine +1% on a 1000 book. The account also received $500.
    // A naive totalValue diff would report 1510/1000 − 1 = +51%.
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 760, 1510, [pos("AAA", 10, 100, 101)]),
    ], new Map());
    expect(r).toHaveLength(1);
    expect(r[0].bookReturn).toBeCloseTo(0.01, 10);
    expect(r[0].impliedTransfer).toBeCloseTo(500, 6);
    expect(r[0].bookReturn).not.toBeCloseTo(0.51, 2);
  });

  it("does not book deploying cash into a new position as a gain", () => {
    const trades = new Map([["2026-10-02", [trade("BBB", "buy", 2, 50)]]]);
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1200, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 760, 1200, [pos("AAA", 10, 100, 100), pos("BBB", 2, 50, 50)]),
    ], trades);
    expect(r[0].bookReturn).toBeCloseTo(0, 10);
  });

  it("includes trades dated the CLOSING day and excludes trades dated the opening one", () => {
    // The window is (prevDate, date]. Fills happen ~10:30 ET, between two closes, so date N's fills
    // belong to the close(N−1)→close(N) window. Wrongly including prevDate's AAA purchase here would
    // add 1000 to tradeNetCash and report roughly −83% instead of 0%.
    const trades = new Map([
      ["2026-10-01", [trade("AAA", "buy", 10, 100)]],
      ["2026-10-02", [trade("BBB", "buy", 2, 50)]],
    ]);
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1200, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 760, 1200, [pos("AAA", 10, 100, 100), pos("BBB", 2, 50, 50)]),
    ], trades);
    expect(r[0].bookReturn).toBeCloseTo(0, 10);
  });

  it("computes the active return against SPY's own closes", () => {
    const r = computeCloseReturns([
      snap("2026-10-01", 100, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 102, 1020, [pos("AAA", 10, 100, 102)]),
    ], new Map());
    expect(r[0].bookReturn).toBeCloseTo(0.02, 10);
    expect(r[0].spyReturn).toBeCloseTo(0.02, 10);
    expect(r[0].activeReturn).toBeCloseTo(0, 10);
  });

  it("withholds rather than returning 0 when the day is unpriceable", () => {
    // A sell that CLOSED the position with no fill price has no honest proxy: substituting
    // yesterday's price would book exactly zero and erase a stop-out's loss.
    const trades = new Map([["2026-10-02", [trade("AAA", "sell", 10, "")]]]);
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 760, 900, []),
    ], trades);
    expect(r[0].bookReturn).toBeNull();
    expect(r[0].withheldReason).toBe("unpriceable");
  });

  it("withholds a pair separated by more than the allowed gap", () => {
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-20", 760, 1000, [pos("AAA", 10, 100, 100)]),
    ], new Map());
    expect(r[0].bookReturn).toBeNull();
    expect(r[0].withheldReason).toBe(`gap_19d`);
    expect(19).toBeGreaterThan(MAX_PAIR_GAP_DAYS);
  });

  it("allows a normal weekend gap", () => {
    const r = computeCloseReturns([
      snap("2026-10-02", 100, 1000, [pos("AAA", 10, 100, 100)]),   // Friday
      snap("2026-10-05", 101, 1010, [pos("AAA", 10, 100, 101)]),   // Monday
    ], new Map());
    expect(r[0].bookReturn).toBeCloseTo(0.01, 10);
  });

  it("collapses a duplicate date instead of emitting a phantom 0% day", () => {
    const r = computeCloseReturns([
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
      snap("2026-10-02", 760, 1010, [pos("AAA", 10, 100, 101)]),
    ], new Map());
    expect(r).toHaveLength(1);
    expect(r[0].bookReturn).toBeCloseTo(0.01, 10);
  });

  // The dedupe DIRECTION was untestable before: both fixtures above are byte-identical, so keeping
  // the earlier or the later copy looked the same. getCloseSnapshots returns newest-first, so the
  // old code kept the one captured EARLIEST — discarding a correction written by a retry (the
  // already_captured guard is a read-then-write, not atomic).
  it("keeps the LATER capture of a duplicate date, so a correction wins", () => {
    const stale = { ...snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]), capturedAt: "2026-10-01T21:10:00.000Z" };
    const fixed = { ...snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 50)]),  capturedAt: "2026-10-01T22:30:00.000Z" };
    // newest-first, as the store returns them
    const r = computeCloseReturns([
      snap("2026-10-02", 760, 1010, [pos("AAA", 10, 100, 101)]),
      fixed,
      stale,
    ], new Map());
    expect(r).toHaveLength(1);
    // The corrected baseline must be the one used. With the stale copy (AAA @100, equity 1000)
    // the next day at @101 is +1%; with the correction (@50, equity 500) the same next day is a
    // large positive move. Asserting the VALUE pins which copy survived.
    expect(r[0].bookReturn).not.toBeCloseTo(0.01, 6);
    expect(r[0].bookReturn!).toBeGreaterThan(0.5);
  });

  // This test used byte-identical fixtures at first, which made it vacuous in precisely the way
  // the comment above describes: whichever copy survived, bookReturn was the same, so it could not
  // fail if the tie-break inverted. The fixtures now DIFFER, so the resolution is pinned.
  it("resolves a capturedAt tie deterministically to the last-seen copy", () => {
    const first  = { ...snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]), capturedAt: "2026-10-01T21:10:00.000Z" };
    const second = { ...snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100,  50)]), capturedAt: "2026-10-01T21:10:00.000Z" };
    const r = computeCloseReturns([first, second, snap("2026-10-02", 760, 1010, [pos("AAA", 10, 100, 101)])], new Map());
    expect(r).toHaveLength(1);
    // Tie → the later-encountered copy wins (equity 500 @50), so the next day at @101 is a large
    // positive move rather than +1%. An inverted tie-break changes this number.
    expect(r[0].bookReturn!).toBeGreaterThan(0.5);
  });

  it("sorts out-of-order snapshots rather than producing a negative gap", () => {
    const r = computeCloseReturns([
      snap("2026-10-02", 760, 1010, [pos("AAA", 10, 100, 101)]),
      snap("2026-10-01", 760, 1000, [pos("AAA", 10, 100, 100)]),
    ], new Map());
    expect(r[0].prevDate).toBe("2026-10-01");
    expect(r[0].date).toBe("2026-10-02");
    expect(r[0].bookReturn).toBeCloseTo(0.01, 10);
  });

  it("produces nothing from a single snapshot", () => {
    expect(computeCloseReturns([snap("2026-10-01", 760, 1000, [])], new Map())).toHaveLength(0);
  });
});

describe("summarizeCloseReturns", () => {
  const series = (...rows: Array<[string, number | null, number | null]>) =>
    rows.map(([date, b, s]) => ({
      date, prevDate: "x",
      bookReturn: b, spyReturn: s,
      activeReturn: b == null || s == null ? null : b - s,
      impliedTransfer: 0,
    }));

  it("compounds both legs and reports the active gap in points", () => {
    const sum = summarizeCloseReturns(series(["d1", 0.01, 0.005], ["d2", 0.01, 0.005]));
    expect(sum.pairedDays).toBe(2);
    expect(sum.cumulativeBookPct).toBeCloseTo((1.01 * 1.01 - 1) * 100, 8);
    expect(sum.cumulativeSpyPct).toBeCloseTo((1.005 * 1.005 - 1) * 100, 8);
    expect(sum.cumulativeActivePct).toBeCloseTo((1.01 * 1.01 - 1.005 * 1.005) * 100, 8);
  });

  it("excludes withheld days from the statistics but counts them", () => {
    const sum = summarizeCloseReturns(series(["d1", 0.01, 0.005], ["d2", null, null], ["d3", 0.01, 0.005]));
    expect(sum.pairedDays).toBe(2);
    expect(sum.withheldDays).toBe(1);
    // A withheld day treated as 0% would still give 2 paired days' worth of compounding — assert the
    // count, which is the only thing that distinguishes "skipped" from "counted as flat".
    expect(sum.cumulativeBookPct).toBeCloseTo((1.01 * 1.01 - 1) * 100, 8);
  });

  it("reports no volatility from a single paired day", () => {
    const sum = summarizeCloseReturns(series(["d1", 0.01, 0.005]));
    expect(sum.dailyActiveVolPct).toBeNull();
    expect(sum.activeOneSigmaPct).toBeNull();
  });

  it("scales the 1σ band by √n", () => {
    const sum = summarizeCloseReturns(series(["d1", 0.02, 0.0], ["d2", 0.0, 0.0], ["d3", 0.02, 0.0], ["d4", 0.0, 0.0]));
    expect(sum.dailyActiveVolPct).not.toBeNull();
    expect(sum.activeOneSigmaPct!).toBeCloseTo(sum.dailyActiveVolPct! * 2, 8);  // √4 = 2
  });

  it("returns an all-null summary with nothing paired", () => {
    const sum = summarizeCloseReturns(series(["d1", null, null]));
    expect(sum.pairedDays).toBe(0);
    expect(sum.withheldDays).toBe(1);
    expect(sum.cumulativeActivePct).toBeNull();
    expect(sum.firstDate).toBeNull();
  });
});
