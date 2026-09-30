import { describe, test, expect } from "bun:test";
import { formatAnalystTag, ANALYST_LOOKBACK_DAYS } from "@/lib/analyst-tag";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { parseAction } from "@/lib/analyst";

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

/** Same line, but the name is owned by the influencer sleeve. */
const sleeveLine = (ratings: unknown[]) => {
  const p = buildV1AnalysisPrompt(
    "2026-09-14", "", { buyingPower: "$100", totalValue: "$2400", positions: [{ symbol: "ILMN", quantity: "1", avgCost: "100", price: 102, heldDays: 17 }] } as never,
    undefined, undefined, ["ILMN"], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", true, "",
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

  // Was `expect(ANALYST_LOOKBACK_DAYS).toBe(7)` — a literal compared to a literal, which could not
  // fail for the reason its name gave: lib/analyst hard-coded its own cutoff independently, so
  // changing the window there left this green while the tag went on promising the old one. The
  // constant is now the single source (lib/analyst imports it); this guards that it stays so.
  test("lib/analyst derives its cutoff from the constant, not a second hard-coded window", async () => {
    const src = await Bun.file(new URL("../lib/analyst.ts", import.meta.url)).text();
    expect(src).toContain("ANALYST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000");
    expect(src).not.toMatch(/\b7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    // A THIRD hard-coded 7 survived the first pass, 18 lines from the one that was fixed: the
    // EMPTY-state branch of the ANALYST ACTIONS ternary. That branch is what renders during an FMP
    // outage — precisely when a reader is most likely to check what window was searched.
    const md = await Bun.file(new URL("../lib/market-data.ts", import.meta.url)).text();
    expect(md).not.toMatch(/last 7 days/);
  });

  // The sleeve authorises exactly three exits (⚠⚠ IMMINENT earnings, bearish ⚡NEWS↓, ⏳STALE). A
  // ↓FIRM downgrade is a MAIN-book trigger that is NOT on that list, and sleeve sells bypass the
  // sell rail entirely (route.ts partitions them out before applySellRail), so no code check
  // downstream would catch an exit taken on it. The keep side is worse: an ⚡↑ on a ⏳STALE sleeve
  // line offers a keep-reason absent from the sleeve's re-acceleration list.
  test("a SLEEVE line carries no analyst tag — the rules there do not authorise acting on one", () => {
    const down = { action: "downgrade", firmShort: "Mizu", priceTarget: 150, pctUpside: -8, date: "2026-09-13" };
    expect(sleeveLine([down])).toContain("[INFLUENCER SLEEVE");
    expect(sleeveLine([down])).not.toContain("Mizu");
    expect(sleeveLine([up])).not.toContain("UBS");
    expect(sleeveLine([up])).not.toContain("⚡");
    // Control — the SAME rating on a main-book line must still render, so this cannot pass by
    // suppressing the tag everywhere (which is how the ILMN case happened in the first place).
    expect(positionLine([down])).toContain("Mizu");
    expect(positionLine([up])).toContain("⚡↑UBS");
  });

  // Tests the CLASSIFIER, not just the renderer. The renderer test below passes action:"initiate"
  // by hand, so on its own it cannot catch parseAction mapping initiations back onto "upgrade" —
  // which is exactly the defect, and a mutation run proved the renderer test stayed green through it.
  test("parseAction classifies an INITIATION as its own action, not an upgrade", () => {
    expect(parseAction("Wolfe Research initiates coverage on ILMN with Peer Perform rating")).toBe("initiate");
    expect(parseAction("Wolfe Research initiated ILMN at Underweight")).toBe("initiate");
    // Controls: the real directional actions are unchanged.
    expect(parseAction("Goldman Sachs upgrades ILMN to Buy")).toBe("upgrade");
    expect(parseAction("Goldman Sachs downgrades ILMN to Sell")).toBe("downgrade");
    expect(parseAction("Mizuho raises ILMN PT to $260 from $200")).toBe("raise_pt");
    expect(parseAction("UBS maintains ILMN at Neutral")).toBeNull();
  });

  test("an INITIATION is neutral — never ↑, never ⚡, however large the implied upside", () => {
    // A firm can initiate at Neutral/Underweight, and the upside is largest on a name that has
    // already fallen — exactly the population loss discipline and the time-stop target, where ⚡↑
    // is the documented escape hatch.
    const out = formatAnalystTag(
      [{ action: "initiate", firmShort: "Wolf", priceTarget: 122, pctUpside: 22, date: "2026-09-28" }],
      "2026-09-30",
    );
    expect(out).toContain("◦NEW");
    expect(out).not.toContain("⚡");
    expect(out).not.toContain("↑");
    // Control: a real upgrade with the same upside DOES earn the hatch, so this cannot pass by
    // suppressing everything.
    const upgrade = formatAnalystTag(
      [{ action: "upgrade", firmShort: "Wolf", priceTarget: 122, pctUpside: 22, date: "2026-09-28" }],
      "2026-09-30",
    );
    expect(upgrade).toContain("⚡↑");
  });

  test("two actions are separated unambiguously once each carries an age", () => {
    const out = formatAnalystTag(
      [
        { action: "upgrade", firmShort: "UBS", priceTarget: 260, pctUpside: 18, date: "2026-09-25" },
        { action: "downgrade", firmShort: "GS", priceTarget: 80, pctUpside: -12, date: "2026-09-29" },
      ],
      "2026-09-30",
    );
    // A plain space would let "1d ago" attach to the UBS action — freshness is the one field the
    // keep/sell rules judge these on.
    expect(out).toContain(" · ");
    const [first, second] = out.split(" · ");
    expect(first).toContain("GS");
    expect(first).toContain("1d ago");
    expect(second).toContain("UBS");
    expect(second).toContain("5d ago");
  });
});

// The SECOND renderer. lib/market-data keeps its own inline analyst flag for the legacy momentum
// table, and adding a third action to a two-way `isPositive ? "↑" : "↓"` made it render new
// coverage as a DOWNGRADE — the opposite error to the one the change was fixing, and invisible to
// every test above because they only exercise lib/analyst-tag.
describe("the legacy momentum-table flag handles the same three-way action", () => {
  test("an initiation is not rendered as a downgrade there either", async () => {
    const { formatCompactMarketData } = await import("./fixtures");
    const sym = "AAPL";
    const out = formatCompactMarketData("default", {}, {}, {
      [sym]: [{
        symbol: sym, action: "initiate", firm: "Wolfe Research", firmShort: "Wolf",
        priceTarget: 300, pctUpside: 22, date: "2026-09-28",
      }],
    } as never);
    expect(out).toContain("◦NEW Wolf");
    expect(out).not.toContain("↓Wolf");
    expect(out).not.toContain("⚡↑Wolf");
  });
});
