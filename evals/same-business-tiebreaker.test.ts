import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

// 2026-10-27 (owner decision): the sector cap counts Technology as one bucket, so MU (held) and
// WDC/STX/SNDK could fill all three Tech slots with one memory/storage bet. A deterministic version
// (one slot per 60d-correlated cluster) cost 0.7-2.2pp/yr in the backtest with no reliable drawdown
// benefit, so the owner chose a TIEBREAKER: the model reasons about each company's business and
// prefers the non-overlapping name only between otherwise-close candidates. (Briefly an AVOID, 507f063,
// reverted the same day: the backtest put a hard one-memory-name limit at −0.7pp/yr, no drawdown help.)
// These pin its limits.
const prompt = (buysOpen: boolean) => buildV1AnalysisPrompt(
  "2026-10-27", "", { buyingPower: "$100", totalValue: "$2400", positions: [] } as never,
  undefined, undefined, [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", buysOpen, "",
  {} as never,
);
const rule = (p: string) => p.split("\n").find(l => l.startsWith("SAME-BUSINESS TIEBREAKER"));

describe("same-business tiebreaker (Technology)", () => {
  test("rendered once, on buy-open and closed days alike", () => {
    for (const open of [true, false]) {
      const p = prompt(open);
      expect(p.split("SAME-BUSINESS TIEBREAKER").length - 1).toBe(1);
      // the reverted AVOID (507f063) contradicts this rule ("skip it even when stronger") — never both
      expect(p).not.toContain("SAME-BUSINESS AVOID");
      expect(rule(p)).toBeDefined();
    }
  });
  test("it is a tiebreaker, not a cap: never skip a stronger name, never sell, never changes eligibility", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("otherwise CLOSE");
    expect(r).toContain("never pass over a clearly stronger name to diversify");
    expect(r).toContain("never sell a holding because of overlap");
    expect(r).toContain("changes neither what is eligible nor the caps");
  });
  test("held names count, and the business — not the label — decides", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("held names count");
    expect(r).toContain("what each company actually sells");
    expect(r).toContain("WDC spun off its flash business as SanDisk/SNDK in 2025");
    // Carried over from the AVOID rule's review (2026-10-27): "same business" alone let MU (chips) vs
    // WDC (drives) read as DIFFERENT — the very pair the rule exists for — and a demand-cycle test
    // applied to all of Tech would make NVDA/AVGO/ANET "one AI bet". Name the group; exclude the theme.
    expect(r).toContain("MU, WDC, STX and SNDK count as ONE business here");
    expect(r).toContain("does NOT make two names the same business");
  });
  test("its use is auditable: the thesis must name the businesses and the overlap", () => {
    expect(rule(prompt(true))).toContain("say in your thesis what each company does and which overlap you avoided");
  });
});
