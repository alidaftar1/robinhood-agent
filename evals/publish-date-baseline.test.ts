import { describe, expect, test } from "bun:test";
import { firstCloseAfter, type DatedBars } from "../lib/market-data";
import { baselineForCall } from "../lib/influencer-ledger";

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

describe("firstCloseAfter — outside the bar window", () => {
  const d2 = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const bars: DatedBars = {
    ts: [d2("2026-10-01T13:30:00Z"), d2("2026-10-02T13:30:00Z")],
    closes: [100, 110],
  };

  test("a moment on an EARLIER DAY than the oldest bar yields null, not the oldest bar", () => {
    // Otherwise a stale publishedAt silently gets a baseline up to a month after the call while
    // still being labelled baselineSource "publish".
    expect(firstCloseAfter(bars, d2("2026-09-01T12:00:00Z"))).toBeNull();
  });

  test("PRE-MARKET on the oldest bar's OWN day still resolves — no session is missed", () => {
    expect(firstCloseAfter(bars, d2("2026-10-01T10:00:00Z"))).toEqual({ date: "2026-10-01", close: 100 });
  });
});

// ── The no-fallback rule ───────────────────────────────────────────────────────────────────────
// The cache cron runs at 13:00 UTC, THIRTY MINUTES BEFORE the 13:30 UTC open, so for every fresh
// pick today's bar does not exist yet. The first version of this code fell back to the live
// (pre-market) price, which baselined the channel BEFORE the session and credited it with the whole
// day's move — permanently, because the next run short-circuits on an existing entry. There must be
// no fallback: withhold, and let the next run find a settled close.
describe("baselineForCall — withholds rather than guessing", () => {
  const d3 = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const bars: DatedBars = {
    ts: [d3("2026-10-01T13:30:00Z"), d3("2026-10-02T13:30:00Z")],
    closes: [100, 110],
  };

  test("a video published after the LAST stored close is WITHHELD, not priced pre-market", () => {
    // This is the pre-market-cron case: the only honest answer is "not yet".
    expect(baselineForCall(bars, "2026-10-02T23:00:00Z")).toBeNull();
  });

  test("once that session has closed, the SAME call resolves from its close", () => {
    const next: DatedBars = { ts: [...bars.ts, d3("2026-10-05T13:30:00Z")], closes: [100, 110, 120] };
    expect(baselineForCall(next, "2026-10-02T23:00:00Z")).toEqual({
      firstSeenDate: "2026-10-05", priceAtSignal: 120, baselineSource: "publish",
    });
  });

  test("it NEVER returns a refresh/live-price baseline — the field is always \"publish\"", () => {
    const out = baselineForCall(bars, "2026-10-01T10:00:00Z");
    expect(out?.baselineSource).toBe("publish");
  });

  test("missing bars withhold (an unsupported symbol is simply unmeasurable)", () => {
    expect(baselineForCall(null, "2026-10-01T10:00:00Z")).toBeNull();
    expect(baselineForCall(undefined, "2026-10-01T10:00:00Z")).toBeNull();
  });

  test("a missing or unparseable publishedAt withholds rather than defaulting to now", () => {
    expect(baselineForCall(bars, undefined)).toBeNull();
    expect(baselineForCall(bars, "not-a-date")).toBeNull();
  });

  test("a zero/negative close withholds instead of producing an infinite return", () => {
    expect(baselineForCall({ ts: bars.ts, closes: [0, 0] }, "2026-10-01T10:00:00Z")).toBeNull();
  });
});
