import { describe, test, expect } from "bun:test";
import { formatAnalystTag, ANALYST_LOOKBACK_DAYS } from "@/lib/analyst-tag";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

// Analyst actions are a SEPARATE channel from ⚡NEWS — lib/news deliberately excludes routine
// rating/PT notes as non-material — and they rendered ONLY in the shortlist table. So for a name
// the book HOLDS but which has fallen off the shortlist, an upgrade or downgrade was invisible in
// every surface the model reads, while the keep-exceptions accept "⚡↑" and the sell triggers
// accept "a ↓FIRM downgrade". ILMN was sold days after a UBS upgrade it could not see.
const up = { action: "upgrade", firmShort: "UBS", priceTarget: 260, pctUpside: 18, date: "2026-09-09" };
const positionLine = (ratings: unknown[]) => {
  const p = buildV1AnalysisPrompt(
    "2026-09-14", "", { buyingPower: "$100", totalValue: "$2400", positions: [{ symbol: "ILMN", quantity: "1", avgCost: "100", price: 102, heldDays: 17 }] } as never,
    undefined, undefined, [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", true, "",
    { ILMN: ratings } as never,
  );
  const l = p.split("\n").find(x => x.includes("ILMN ×"));
  if (!l) throw new Error("position line not rendered");
  return l;
};

describe("a held name's analyst action is visible where the decision is made", () => {
  test("THE ILMN CASE: the upgrade now appears on the position line", () => {
    expect(positionLine([up])).toContain("⚡↑UBS$260(+18%), 5d ago");
  });

  test("a downgrade renders too — it is a valid SELL trigger the model also could not see", () => {
    const l = positionLine([{ action: "downgrade", firmShort: "GS", priceTarget: 80, pctUpside: -12, date: "2026-09-13" }]);
    expect(l).toContain("↓GS$80(-12%), 1d ago");
    expect(l).not.toContain("⚡");   // ⚡ marks a high-upside UPGRADE only
  });

  test("⚡ marks only an upgrade with material upside", () => {
    expect(formatAnalystTag([{ ...up, pctUpside: 18 }], "2026-09-14")).toContain("⚡");
    expect(formatAnalystTag([{ ...up, pctUpside: 4 }], "2026-09-14")).not.toContain("⚡");
  });

  test("the AGE is carried — every rule framing this as a FRESH catalyst needs it", () => {
    expect(formatAnalystTag([{ ...up, date: "2026-09-14" }], "2026-09-14")).toContain(", today");
    expect(formatAnalystTag([{ ...up, date: "2026-09-08" }], "2026-09-14")).toContain("6d ago");
  });

  test("a future-dated rating is rendered UNDATED, not as fresher", () => {
    const out = formatAnalystTag([{ ...up, date: "2026-09-20" }], "2026-09-14");
    expect(out).toContain("↑UBS");
    expect(out).not.toMatch(/ago|today|-\d+d/);
  });

  test("the two most recent are shown, newest first", () => {
    const out = formatAnalystTag([
      { ...up, firmShort: "OLD", date: "2026-09-08" },
      { ...up, firmShort: "NEW", date: "2026-09-13" },
      { ...up, firmShort: "MID", date: "2026-09-10" },
    ], "2026-09-14");
    expect(out.indexOf("NEW")).toBeLessThan(out.indexOf("MID"));
    expect(out).not.toContain("OLD");
  });

  test("no ratings renders nothing at all", () => {
    expect(formatAnalystTag([], "2026-09-14")).toBe("");
    expect(formatAnalystTag(undefined, "2026-09-14")).toBe("");
    expect(positionLine([])).not.toContain("↑");
  });

  test("the lookback matches lib/analyst's own 7-day cutoff", () => {
    expect(ANALYST_LOOKBACK_DAYS).toBe(7);
  });
});
