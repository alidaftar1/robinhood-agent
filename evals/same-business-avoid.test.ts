import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

// 2026-10-27 (owner decisions): the sector cap counts Technology as one bucket, so MU (held) and
// WDC/STX/SNDK could fill all three Tech slots with one memory/storage bet. A deterministic version
// (one slot per 60d-correlated cluster) cost 0.7-2.2pp/yr in the backtest with no reliable drawdown
// benefit. The owner first chose a TIEBREAKER (between otherwise-close names only), then the same
// day an AVOID: the model reasons about each company's business and does not buy a Tech name that
// repeats one already held or bought today, even a stronger one. These pin its scope and limits.
const prompt = (buysOpen: boolean) => buildV1AnalysisPrompt(
  "2026-10-27", "", { buyingPower: "$100", totalValue: "$2400", positions: [] } as never,
  undefined, undefined, [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", buysOpen, "",
  {} as never,
);
const rule = (p: string) => p.split("\n").find(l => l.startsWith("SAME-BUSINESS AVOID"));

describe("same-business avoid (Technology)", () => {
  test("rendered once, on buy-open and closed days alike; the old tiebreaker is gone", () => {
    for (const open of [true, false]) {
      const p = prompt(open);
      expect(p.split("SAME-BUSINESS AVOID").length - 1).toBe(1);
      expect(p).not.toContain("SAME-BUSINESS TIEBREAKER");
      expect(p).not.toContain("never pass over a clearly stronger name to diversify");
    }
  });
  test("it is an avoid: binds even over stronger momentum and the confirming tags", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("Do NOT open a main-book position in a Technology name that is the SAME BET as a holding that STAYS");
    expect(r).toContain("even when it has stronger momentum or carries ⚡/🎬INFL✓");
    expect(r).toContain("take the next shortlisted Technology name that is not the same bet");
    expect(r).toContain("give the slot to another sector or hold the cash");
  });
  test("scope (review 2026-10-27): main-book NEW names only — top-ups, the sleeve and sells are untouched", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("MAIN-book buys");
    expect(r).toContain("NOT affected: a top-up of a name you already hold, influencer-sleeve buys");
    // a same-run rotation (sell stale MU, buy WDC) is not a double bet
    expect(r).toContain("only a name you are FULLY exiting today does not count — a trim still counts");
    // two overlapping buys on one day must not disqualify EACH OTHER
    expect(r).toContain("Among today's main-book Technology buys, if two are the same bet, buy only the stronger");
    expect(r).toContain("an influencer-sleeve buy made today counts like a holding");
  });
  test("buys only: never sells, never widens eligibility or the caps", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("never sell or trim a holding because of overlap");
    expect(r).toContain("changes neither what is eligible nor the caps");
    expect(r).toContain("choose only among shortlisted names");
  });
  test("held names count, and the business — not the label — decides", () => {
    const r = rule(prompt(true))!;
    expect(r).toContain("STAYS in the account after today (either sleeve");
    expect(r).toContain("what each company actually sells");
    // review 2026-10-27: "same business" alone let MU (chips) vs WDC (drives) read as DIFFERENT — the
    // exact pair the rule exists for. The group is named so product differences cannot unlock it.
    expect(r).toContain("MU, WDC, STX and SNDK are ONE group");
    expect(r).toContain("holding any one of them rules out buying the others");
    // review pass 3: a demand-cycle test applied to ALL Tech would make NVDA/AVGO/MU/ANET "one AI bet"
    // and shut out most Tech buys — the broad clustering the backtest priced at 0.7-2.2pp/yr. The
    // cycle test is confined to the named group; everything else is same-business.
    expect(r).toContain("The same bet means the SAME BUSINESS — with one named exception");
    expect(r).toContain("that alone does NOT make two names the same bet");
    expect(r).not.toContain("what drives its demand");
    expect(r).toContain("WDC spun off its flash business as SanDisk/SNDK in 2025");
  });
  test("its use is auditable: the thesis names the skipped name, the businesses and the overlap", () => {
    expect(rule(prompt(true))).toContain("say in your thesis which name you skipped, what each company does, and the overlap");
  });
});
