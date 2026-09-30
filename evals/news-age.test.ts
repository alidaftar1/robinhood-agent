import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { FAILED } from "@/lib/news";

// THE ILMN FLIP, 2026-09-14/15. The prompt asks the model to justify keeping an underwater or
// ⏳STALE name with a "FRESH catalyst" — a freshness judgment — while NewsSignal.date was dropped
// at this boundary, so it could not see when the catalyst happened. News also runs on a ROLLING
// 5-day window, so the same catalyst silently vanishes between runs. ILMN was KEPT on 09-14 citing
// a UBS upgrade, SOLD on 09-15 for "no fresh catalyst", then rose ~21% vs SPY over ten days.
const line = (newsDate: string | undefined, today = "2026-09-15") => {
  const prompt = buildV1AnalysisPrompt(
    today, "",
    { buyingPower: "$100", totalValue: "$2400", positions: [{ symbol: "ILMN", quantity: "1", avgCost: "100", price: 102, heldDays: 18 }] } as never,
    undefined, undefined, [], [], [], {},
    new Map([["ILMN", { direction: "+", summary: "UBS upgrade to Buy, $260 PT", date: newsDate }]]),
  );
  return prompt.split("\n").find(l => l.includes("ILMN ×")) ?? "";
};

describe("a catalyst's AGE must be visible, not just its existence", () => {
  test("the catalyst carries its age", () => {
    expect(line("2026-09-12")).toContain("3d ago");
    expect(line("2026-09-15")).toContain("today");
  });

  test("NO expiry warning — it argued against bearish exits and invited pre-emptive selling", () => {
    // An earlier version warned when a catalyst neared the window edge. It rendered identically on
    // ⚡NEWS↓ ("this bad news is old and will drop off"), arguing against one of the few sells
    // allowed off-cycle — and telling a model a keep-justification has a deadline invites acting
    // before it expires, which off-cycle can only surface as a reframed risk sell.
    for (const d of ["2026-09-10", "2026-09-11", "2026-09-13"]) {
      expect(line(d)).not.toMatch(/window edge|drop off/);
    }
  });

  test("the summary and direction still render — this ADDS a fact, it does not replace one", () => {
    const l = line("2026-09-12");
    expect(l).toContain("⚡NEWS↑");
    expect(l).toContain("UBS upgrade to Buy, $260 PT");
  });

  test("a signal with no date renders exactly as before", () => {
    // date is optional on NewsSignal; an older cached entry must not render "undefined" or break.
    const l = line(undefined);
    expect(l).toContain("⚡NEWS↑");
    expect(l).not.toContain("undefined");
    expect(l).not.toMatch(/\dd ago/);
  });

  test("an unparseable date is ignored rather than rendered", () => {
    expect(line("not-a-date")).not.toContain("NaN");
    expect(line("not-a-date")).toContain("⚡NEWS↑");
  });
});

describe("a news fetch that FAILED is not a verdict of 'no news'", () => {
  // The traced ILMN flip was NOT a rolling-window expiry — lib/news explicitly excludes routine
  // analyst rating/PT notes as non-material, so 09-15 was correct and 09-14 was the leak. Two real
  // causes remained, both of which make a catalyst appear and vanish on unchanged facts.
  test("FAILED is distinguishable from null", () => {
    // null = "asked, nothing material" (safe to cache for 12h).
    // FAILED = "could not ask" (a 429 or timeout) — caching it turns a transient failure into a
    // 12-hour verdict, the exact doctrine recorded in CLAUDE.md after the signal-cache incident.
    expect(FAILED).not.toBeNull();
    expect(typeof FAILED).toBe("symbol");
  });
});
