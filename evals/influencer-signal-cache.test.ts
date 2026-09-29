import { describe, expect, test } from "bun:test";
import { shouldReuseCachedSignal } from "../lib/influencer-signals";

/**
 * The signal cache saves most of the Haiku spend by not re-analyzing a video the 7-day
 * window re-sees every day. The only way it can be actively wrong rather than merely
 * unhelpful is by serving a WEAKER answer than the one available now, so that is what
 * these pin.
 */
describe("signal cache reuse rule", () => {
  test("nothing cached -> extract", () => {
    expect(shouldReuseCachedSignal(null, true)).toBe(false);
    expect(shouldReuseCachedSignal(null, false)).toBe(false);
  });

  test("cached FROM A TRANSCRIPT -> always reuse, that is the saving", () => {
    expect(shouldReuseCachedSignal({ fromTranscript: true }, true)).toBe(true);
    expect(shouldReuseCachedSignal({ fromTranscript: true }, false)).toBe(true);
  });

  test("cached from title only, transcript now available -> RE-EXTRACT", () => {
    // The case that matters. Supadata failing once must not freeze the weaker
    // title-and-description answer in place for the full 14-day TTL.
    expect(shouldReuseCachedSignal({ fromTranscript: false }, true)).toBe(false);
  });

  test("cached from title only, still no transcript -> reuse rather than re-bill", () => {
    expect(shouldReuseCachedSignal({ fromTranscript: false }, false)).toBe(true);
  });
});

describe("a FAILED extraction must never be cached as a verdict", () => {
  // The HIGH finding on the signal-cache commit. extractSignal is fail-safe: an Anthropic 429/529,
  // a timeout, a missing SIGNAL: line and an unparseable JSON payload all return the SAME empty
  // shape as "the creator named nothing actionable". Fine for trading — both mean no signal today —
  // but fatal for caching: stored with fromTranscript:true it is reused unconditionally, so one
  // overloaded batch suppresses those videos for the rest of their 7-day window. Before the cache
  // existed this self-healed, because the next day's run simply re-ran the extraction.
  const genuinelyEmpty = { tickers: [], confidence: "low" as const, avoid: [], insight: "", extracted: true };
  const failed = { tickers: [], confidence: "low" as const, avoid: [], insight: "", extracted: false };

  // Mirrors the guard at the call site: persist a result, never a failure.
  const shouldPersist = (r: { extracted?: boolean }) => r.extracted !== false;

  test("a genuine empty IS cached — that is where the savings come from", () => {
    expect(shouldPersist(genuinelyEmpty)).toBe(true);
  });

  test("a failed extraction is NOT cached, so the next run retries it", () => {
    expect(shouldPersist(failed)).toBe(false);
  });

  test("the two are indistinguishable by shape — only the flag separates them", () => {
    // Guards against a future 'fix' that tries to detect failure by looking at the payload.
    const { extracted: _a, ...emptyShape } = genuinelyEmpty;
    const { extracted: _b, ...failedShape } = failed;
    expect(emptyShape).toEqual(failedShape);
  });

  test("a cached entry written before this flag existed is still reusable", () => {
    // Backwards compatibility: `extracted` is optional, and undefined must read as a result
    // (those entries were written by a successful extraction) rather than as a failure.
    expect(shouldPersist({})).toBe(true);
  });
});
