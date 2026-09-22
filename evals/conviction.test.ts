import { describe, test, expect } from "bun:test";
import { formatConviction, daysSince, CONVICTION_SHELF_LIFE_DAYS, type ConvictionRun } from "@/lib/conviction";

const run: ConvictionRun = {
  runDate: "2026-09-21",
  capitalCommitted: 0,
  picks: [
    { rank: 1, symbol: "MRK", entry: 149.5, thesis: "defensive cash generator", knownWeakness: "entry above target", falsifiers: ["Phase 3 misses"] },
    { rank: 2, symbol: "ROST", entry: 231.25, thesis: "trade-down beneficiary", falsifiers: ["tariff relief"] },
  ],
};

describe("conviction research is exposed as opinion, never as instruction", () => {
  test("a pick NOT on the shortlist is labelled unbuyable rather than hidden", () => {
    // Hiding it would be worse: the model would have no idea the research exists and might
    // independently surface the name. Showing it WITH the constraint is the honest version.
    const out = formatConviction(run, "2026-09-22", new Set());
    expect(out).toContain("MRK");
    expect(out).toContain("cannot be bought");
    expect(out).toContain("NONE of these names is buyable this run");
  });

  test("a pick on the shortlist is marked usable", () => {
    const out = formatConviction(run, "2026-09-22", new Set(["MRK"]));
    expect(out).toContain("usable this run");
    expect(out).not.toContain("NONE of these names is buyable");
  });

  test("it always states it has no track record and confers no eligibility", () => {
    // The two claims that keep this from being read as a signal. If either is ever dropped, the
    // block silently changes from "an opinion" into "an instruction with reasons".
    const out = formatConviction(run, "2026-09-22", new Set(["MRK"]));
    expect(out).toMatch(/NO track record/);
    expect(out).toMatch(/NO eligibility/);
    expect(out).toMatch(/not a validated edge|NOT a signal/i);
  });

  test("falsifiers are rendered — the part that can argue AGAINST the name", () => {
    const out = formatConviction(run, "2026-09-22", new Set(["MRK"]));
    expect(out).toContain("would be WRONG if");
    expect(out).toContain("Phase 3 misses");
    expect(out).toContain("known weakness");
  });

  test("stale research is DROPPED, not served with a caveat", () => {
    // A thesis written against a macro picture that has moved on is worse than no thesis: it reads
    // as current reasoning. Past its own horizon it stops being shown at all.
    const stale = formatConviction(run, "2027-09-21", new Set(["MRK"]));
    expect(stale).toBe("");
    expect(daysSince("2026-09-21", "2027-09-21")).toBeGreaterThan(CONVICTION_SHELF_LIFE_DAYS);
  });

  test("missing, empty, or future-dated research renders nothing", () => {
    expect(formatConviction(null, "2026-09-22", new Set())).toBe("");
    expect(formatConviction({ runDate: "2026-09-21", picks: [] }, "2026-09-22", new Set())).toBe("");
    expect(formatConviction(run, "2026-01-01", new Set())).toBe("");   // future-dated
    expect(formatConviction({ runDate: "garbage", picks: run.picks }, "2026-09-22", new Set())).toBe("");
  });
});
