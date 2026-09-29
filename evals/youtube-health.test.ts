import { describe, test, expect } from "bun:test";
import { isTransientYoutube403, type InfluencerCache } from "@/lib/influencer-signals";

// A 403 quotaExceeded and "these creators posted nothing this week" were the SAME observable:
// every channel returns [], the sleeve trades nothing, and the only message a human got was
// "verify the upstream YouTube fetch isn't failing" — a guess, when the API says so plainly.
// The quota is per-GCP-PROJECT, so it can be spent by something that isn't this system at all.
// Mirrors the branch in app/api/autopilot/route.ts so the distinction cannot silently collapse.
function emptyReason(cache: Partial<InfluencerCache> | null): string {
  const cov = cache?.transcriptCoverage;
  const yt = cache?.youtubeHealth;
  return !cache
    ? "the weekly cache is unavailable — the 6am refresh may have failed"
    : yt?.quotaExceeded && (cov?.videos === 0 || yt.failed === yt.channels)
      ? `quota/rate-limit 403 on ${yt.quotaFailed}/${yt.channels} channels and no videos were retrieved — self-clears`
      : yt && yt.channels > 0 && yt.failed > yt.channels / 2
        ? `${yt.failed}/${yt.channels} YouTube channel fetches FAILED — outage`
        : cov && cov.videos === 0
          ? "no candidate videos were found this week"
          : "creators named no qualifying picks this week — an empty sleeve is a valid outcome";
}

describe("an empty sleeve must say WHY, not leave a human to guess", () => {
  const noVideos = { transcriptCoverage: { videos: 0, withTranscript: 0 } };

  test("quota exhaustion is reported as a FACT, not as a quiet week", () => {
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 10, quotaFailed: 10, quotaExceeded: true } });
    expect(out).toMatch(/quota\/rate-limit 403/);
    expect(out).toMatch(/self-clears/);
    expect(out).not.toMatch(/no qualifying picks|valid outcome/);
  });

  test("a total non-quota outage is distinguished from quota exhaustion", () => {
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 10, quotaFailed: 0, quotaExceeded: false } });
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/outage/);
    expect(out).not.toMatch(/self-clears/);   // a non-quota outage does NOT clear on its own
  });

  test("a genuinely quiet week still reads as a valid outcome", () => {
    // The case that must NOT be alarmed on: every fetch succeeded, creators just named nothing.
    const out = emptyReason({
      transcriptCoverage: { videos: 4, withTranscript: 4 },
      youtubeHealth: { channels: 10, failed: 0, quotaFailed: 0, quotaExceeded: false },
    });
    expect(out).toMatch(/valid outcome/);
  });

  test("a PARTIAL failure does not masquerade as an outage", () => {
    // 3 of 10 channels failing is degraded, not down — it must not claim a total outage.
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 3, quotaFailed: 0, quotaExceeded: false } });
    expect(out).not.toMatch(/FAILED \(non-quota\)/);
    expect(out).toMatch(/no candidate videos/);
  });

  test("an older cache with no health field still produces the previous message", () => {
    // Backwards compatibility: youtubeHealth is optional, and a cache written before this change
    // must not throw or render undefined into the email.
    const out = emptyReason(noVideos);
    expect(out).toMatch(/no candidate videos/);
    expect(out).not.toMatch(/undefined/);
  });

  test("a transient 403 must not be reported as a billing problem", () => {
    // YouTube returns 403 for quotaExceeded, dailyLimitExceeded, userRateLimitExceeded AND
    // rateLimitExceeded. The last two are transient like quota; classifying them as a key or
    // billing fault sends a human to fix something that clears on its own.
    // Imports the real predicate rather than copying the regex — a literal copy here would drift
    // silently the next time the lib-side pattern changes, which is what just happened.
    const isTransient = isTransientYoutube403;
    for (const reason of ["quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded", "rateLimitExceeded"]) {
      expect(isTransient(`{"error":{"errors":[{"reason":"${reason}"}],"code":403}}`)).toBe(true);
    }
    // These genuinely do NOT self-heal and must stay distinguishable.
    for (const reason of ["forbidden", "accessNotConfigured", "keyInvalid", "ipRefererBlocked"]) {
      expect(isTransient(`{"error":{"errors":[{"reason":"${reason}"}],"code":403}}`)).toBe(false);
    }
  });

  test("a PARTIAL quota exhaustion does not claim the emptiness is uninformative", () => {
    // 3 of 10 channels exhausted but 40 videos still retrieved: creators genuinely named nothing,
    // and saying otherwise tells the owner to discount a real result.
    const out = emptyReason({
      transcriptCoverage: { videos: 40, withTranscript: 38 },
      youtubeHealth: { channels: 10, failed: 3, quotaFailed: 3, quotaExceeded: true },
    });
    expect(out).toMatch(/valid outcome/);
    expect(out).not.toMatch(/self-clears/);
  });

  test("a MAJORITY non-quota failure is an outage, not a vague 'no videos' message", () => {
    // 8 of 10 failing previously fell past an all-or-nothing test to the old vague wording.
    const out = emptyReason({
      transcriptCoverage: { videos: 0, withTranscript: 0 },
      youtubeHealth: { channels: 10, failed: 8, quotaFailed: 0, quotaExceeded: false },
    });
    expect(out).toMatch(/outage/);
  });

  test("the quota count excludes channels that failed for other reasons", () => {
    const out = emptyReason({
      transcriptCoverage: { videos: 0, withTranscript: 0 },
      youtubeHealth: { channels: 9, failed: 3, quotaFailed: 1, quotaExceeded: true },
    });
    expect(out).toMatch(/1\/9/);      // not 3/9
  });
});
