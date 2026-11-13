import { describe, it, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { KNOWN_ISSUES } from "@/lib/autopilot-known-issues";

// 2026-11-05: the prompt's LOSS DISCIPLINE rule (sell a MAIN name >10% below entry unless it cites a
// name-specific keep-reason) was REMOVED after a 1999-2026 backtest on the live rules showed it cost
// ~2.1-2.4 pp/yr (scripts/take-profit-backtest.ts, ld* variants). The same morning it had been
// tightened with a "(5d ±X%)" tag on underwater lines; that tag went with it. The same-day −10%
// crash stop (lib/stopouts, drop-check) is a separate mechanism and is unchanged.
const ctx = {
  buyingPower: "$200", totalValue: "$2100",
  positions: [{ symbol: "MU", quantity: "0.5", avgCost: "904.74", price: 692.5 }],   // -23.5%
} as any;
const p = buildV1AnalysisPrompt("2026-11-05", "(t)", ctx, "", "", [], [], [], {}, new Map(), new Map(), new Map(), {}, { MU: -13.4 });
const pOff = buildV1AnalysisPrompt("2026-11-05", "(t)", ctx, "", "", [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", false);

describe("loss from cost is not a sell reason", () => {
  it("the LOSS DISCIPLINE rule and its keep-reason demand are gone", () => {
    expect(p).not.toContain("LOSS DISCIPLINE");
    expect(p).not.toMatch(/MUST cite a NAME-SPECIFIC reason it recovers/);
    expect(pOff).not.toMatch(/loss discipline/i);
  });
  it("the prompt says plainly that a loss from cost alone is not a sell reason, and why", () => {
    expect(p).toContain("NO LOSS-FROM-COST RULE");
    expect(p).toMatch(/NOT, by itself, a reason to sell/);
    expect(p).toMatch(/backtested 1999-2026/);
  });
  it("an off-shortlist holding is still a sell — said outright (without it the model kept WDC 3/3)", () => {
    expect(p).toMatch(/does NOT appear in the shortlist table at all HAS fallen off it: that is reason \(a\), sell it/);
  });
  it("the risk sells that remain are still listed on a closed day", () => {
    expect(pOff).toMatch(/bearish ⚡NEWS↓ event that passes the NEWS SELL TEST, or a ↓FIRM/);
  });
  it("no '(5d …)' tag on an underwater line any more", () => {
    const line = p.split("\n").find((l) => l.trimStart().startsWith("MU ×")) ?? "";
    expect(line).toContain("-23.5% since entry");
    expect(line).not.toContain("(5d");
  });
  it("the reviewer now flags the opposite mistake: a sale made only on the loss from cost", () => {
    const k = KNOWN_ISSUES.find((x) => x.date === "2026-11-05");
    expect(k?.title).toMatch(/sold only because it is down from cost/);
    expect(k?.check).toMatch(/Flag it — being below cost is no longer a sell reason/);
  });
});
