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
