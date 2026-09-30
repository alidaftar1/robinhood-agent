import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

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

  test("a catalyst about to fall out of the window says so", () => {
    // This is the ILMN case: on 09-14 the upgrade was inside the window and the model kept the
    // name; one day later the rolling window dropped it and the same facts read as "no catalyst".
    expect(line("2026-09-10")).toMatch(/near the 5-day news window edge/);
    expect(line("2026-09-11")).toMatch(/near the 5-day news window edge/);
    expect(line("2026-09-13")).not.toMatch(/window edge/);
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
