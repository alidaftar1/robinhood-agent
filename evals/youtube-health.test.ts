import { describe, test, expect } from "bun:test";
import type { InfluencerCache } from "@/lib/influencer-signals";

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
    : yt?.quotaExceeded
      ? `the YouTube Data API returned quotaExceeded on ${yt.failed}/${yt.channels} channels — the daily quota is SPENT`
      : yt && yt.channels > 0 && yt.failed === yt.channels
        ? `every one of the ${yt.channels} YouTube channel fetches FAILED (non-quota)`
        : cov && cov.videos === 0
          ? "no candidate videos were found this week"
          : "creators named no qualifying picks this week — an empty sleeve is a valid outcome";
}

describe("an empty sleeve must say WHY, not leave a human to guess", () => {
  const noVideos = { transcriptCoverage: { videos: 0, withTranscript: 0 } };

  test("quota exhaustion is reported as a FACT, not as a quiet week", () => {
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 10, quotaExceeded: true } });
    expect(out).toMatch(/quotaExceeded/);
    expect(out).toMatch(/SPENT/);
    expect(out).not.toMatch(/no qualifying picks|valid outcome/);
  });

  test("a total non-quota outage is distinguished from quota exhaustion", () => {
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 10, quotaExceeded: false } });
    expect(out).toMatch(/FAILED \(non-quota\)/);
    expect(out).not.toMatch(/quotaExceeded/);
  });

  test("a genuinely quiet week still reads as a valid outcome", () => {
    // The case that must NOT be alarmed on: every fetch succeeded, creators just named nothing.
    const out = emptyReason({
      transcriptCoverage: { videos: 4, withTranscript: 4 },
      youtubeHealth: { channels: 10, failed: 0, quotaExceeded: false },
    });
    expect(out).toMatch(/valid outcome/);
  });

  test("a PARTIAL failure does not masquerade as an outage", () => {
    // 3 of 10 channels failing is degraded, not down — it must not claim a total outage.
    const out = emptyReason({ ...noVideos, youtubeHealth: { channels: 10, failed: 3, quotaExceeded: false } });
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
});
