import { describe, expect, test } from "bun:test";
import { firstCloseAfter, type DatedBars } from "../lib/market-data";

// A daily bar's timestamp is the session OPEN (~13:30 UTC in EDT), not the close. So "the first
// close after time T" means the first bar whose session had not yet started when T happened.
const d = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Thu 2026-10-01, Fri 2026-10-02, Mon 2026-10-05 (weekend gap is real — no Sat/Sun bars).
const bars: DatedBars = {
  ts: [d("2026-10-01T13:30:00Z"), d("2026-10-02T13:30:00Z"), d("2026-10-05T13:30:00Z")],
  closes: [100, 110, 120],
};

describe("firstCloseAfter — no look-ahead on the baseline", () => {
  test("a PRE-MARKET video baselines at that same day's close (the session hadn't happened yet)", () => {
    // 2026-10-01 10:00Z = 6am ET, before the 13:30Z open.
    expect(firstCloseAfter(bars, d("2026-10-01T10:00:00Z"))).toEqual({ date: "2026-10-01", close: 100 });
  });

  test("an AFTER-HOURS video baselines at the NEXT session, never the close already printed", () => {
    // 2026-10-01 23:00Z = 7pm ET. Using 100 here would credit a move that predates the video.
    expect(firstCloseAfter(bars, d("2026-10-01T23:00:00Z"))).toEqual({ date: "2026-10-02", close: 110 });
  });

  test("a WEEKEND video baselines at Monday — the first price anyone could act on", () => {
    expect(firstCloseAfter(bars, d("2026-10-03T15:00:00Z"))).toEqual({ date: "2026-10-05", close: 120 });
  });

  // Both boundaries are CONSERVATIVE on purpose: skipping a session can only under-credit the
  // recommender, while accepting one can credit a move that preceded the call.
  test("published EXACTLY at an open skips that session (boundary is t > after, not >=)", () => {
    // Pins `<=` vs `<` in the guard. Without this, flipping it survives every other test here.
    expect(firstCloseAfter(bars, d("2026-10-01T13:30:00Z"))).toEqual({ date: "2026-10-02", close: 110 });
  });

  test("published MID-session skips that session rather than claiming its close", () => {
    expect(firstCloseAfter(bars, d("2026-10-02T14:00:00Z"))).toEqual({ date: "2026-10-05", close: 120 });
  });

  test("a video newer than every stored bar yields null, so the caller falls back explicitly", () => {
    expect(firstCloseAfter(bars, d("2026-10-06T12:00:00Z"))).toBeNull();
  });

  test("a null close (Yahoo hole) is SKIPPED, never interpolated or treated as zero", () => {
    const holed: DatedBars = { ts: bars.ts, closes: [100, null, 120] };
    expect(firstCloseAfter(holed, d("2026-10-01T23:00:00Z"))).toEqual({ date: "2026-10-05", close: 120 });
  });

  test("an empty series yields null rather than throwing", () => {
    expect(firstCloseAfter({ ts: [], closes: [] }, d("2026-10-01T10:00:00Z"))).toBeNull();
  });

  test("the returned date is the BAR's session date, so it pairs with the SPY series by date", () => {
    const hit = firstCloseAfter(bars, d("2026-10-01T23:00:00Z"))!;
    expect(hit.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hit.date).toBe("2026-10-02");
  });
});
