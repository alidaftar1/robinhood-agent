import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

// 2026-10-27: Supadata's monthly plan quota was exhausted — 0/25 transcripts, so 0 tickers — but five
// title-only insights made the digest non-empty, and the outage reason only rendered in the EMPTY
// branch. The email showed insights and no picks, with no hint why. These pin that an outage renders
// in BOTH branches, and that the "quiet week" fallback is never presented as an outage.
const src = readFileSync(`${import.meta.dir}/../app/api/autopilot/route.ts`, "utf8");
const reasons = src.slice(src.indexOf("const influencerOutage"), src.indexOf("const influencerEmptyReason"));
const digest = src.slice(src.indexOf("${hasInfluencerDigest"), src.indexOf("None — ${influencerEmptyReason"));
const nonEmptyBranch = digest.slice(0, digest.indexOf("\n    : `<div"));

describe("influencer outage in the email", () => {
  test("low transcript coverage is an outage reason, and the quiet-week text is not", () => {
    expect(reasons).toContain("low transcript coverage");
    expect(reasons).toContain("cov.withTranscript < cov.videos / 2");
    expect(reasons).not.toContain("creators named no qualifying picks");
    expect(src).toContain('const influencerEmptyReason = influencerOutage ?? "creators named no qualifying picks this week');
  });
  test("the NON-empty digest renders the outage (escaped) when there is one", () => {
    expect(nonEmptyBranch).toContain("${influencerOutage ? `");
    expect(nonEmptyBranch).toContain("escapeHtml(influencerOutage.replace(");
  });
  test("the empty digest still says why", () => {
    expect(src).toContain("None — ${influencerEmptyReason.replace(/\\.$/, \"\")}.");
  });
});
