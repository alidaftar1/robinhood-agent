import { describe, it, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { KNOWN_ISSUES } from "@/lib/autopilot-known-issues";

// 2026-11-05: MU was kept at -23.5% from cost on its 12-month momentum rank, cited as "fresh
// momentum". The rule now defines the reversal keep-reason as a POSITIVE 5-day return, and shows that
// 5d figure on each underwater MAIN line — the shortlist row carries only 12-1 momentum.
const ctx = {
  buyingPower: "$200", totalValue: "$2100",
  positions: [
    { symbol: "MU", quantity: "0.5", avgCost: "904.74", price: 692.5 },   // -23.5%: underwater main
    { symbol: "LLY", quantity: "0.4", avgCost: "800", price: 940 },       // +17.5%: not underwater
    { symbol: "NVDA", quantity: "1", avgCost: "206", price: 185 },        // -10.2%: influencer sleeve
  ],
} as any;
const build = (c5: Record<string, number>) => buildV1AnalysisPrompt(
  "2026-11-05", "(t)", ctx, "", "", ["NVDA"], [], [], {}, new Map(), new Map(), new Map(), {}, c5,
);

describe("loss discipline: the reversal keep-reason is visible and is not the 12-month rank", () => {
  const p = build({ MU: -13.4, LLY: 2.1, NVDA: -9.5 });
  const line = (sym: string) => p.split("\n").find((l) => l.trimStart().startsWith(`${sym} ×`)) ?? "";

  it("an underwater MAIN line shows its 5d return", () => {
    expect(line("MU")).toContain("(5d -13.4%)");
  });
  it("a main name that is not >10% under cost, and a sleeve name, show no 5d tag", () => {
    expect(line("LLY")).not.toContain("(5d");
    expect(line("NVDA")).not.toContain("(5d");
  });
  it("no 5d data → no tag (never a made-up 0%)", () => {
    expect(build({}).split("\n").find((l) => l.trimStart().startsWith("MU ×"))).not.toContain("(5d");
  });
  it("the rule no longer offers 'ranks near the TOP on fresh momentum', and names the 5d test", () => {
    expect(p).not.toContain("ranks near the TOP on fresh momentum");
    expect(p).toContain("its 5-day return, shown as \"5d\" on its position line, is now POSITIVE");
    expect(p).toContain("the 12-month momentum figure is NOT fresh momentum");
  });
  it("the reviewer registry checks for it", () => {
    expect(KNOWN_ISSUES.some((k) => k.date === "2026-11-05" && /12-month/.test(k.title) && /5d/.test(k.check))).toBe(true);
  });
});
