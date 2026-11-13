import { describe, it, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { formatV1Shortlist } from "@/lib/market-data";

// 2026-11-13: the 7:30 run sold GOOGL (influencer sleeve, +4.8%) on a ⚡NEWS↓ for "Google faces
// renewed challenge over $1.66bn advertising fine" — a non-binding EU court adviser's opinion on a
// fine annulled in 2024. The model wrote "lean hold — an ongoing legal matter", then reversed on the
// rule that a ⚡NEWS↓ "is a real reason to trim/exit". A ⚡NEWS↓ is now a reason to CONSIDER a sale,
// sold on only if the thesis can say why the event is material for the company.
// Sonnet A/B (sleeve AAPL+GOOGL, PLTR qualifying as a replacement, N=8): old wording sold GOOGL 6/8,
// new 0/8. Controls with a real guidance cut (sleeve GOOGL, main REGN, N=6 each): sold 6/6 under both.
const ctx = { buyingPower: "$18.45", totalValue: "$2200", positions: [
  { symbol: "REGN", quantity: "0.37", avgCost: "772", price: 920 },
  { symbol: "GOOGL", quantity: "1", avgCost: "282", price: 295.6 },
] } as any;
const on = buildV1AnalysisPrompt("2026-11-13", "(t)", ctx, "INFLUENCER SIGNALS", "", ["GOOGL"]);
const off = buildV1AnalysisPrompt("2026-11-13", "(t)", ctx, "INFLUENCER SIGNALS", "", ["GOOGL"], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", false);

describe("a ⚡NEWS↓ tag is a reason to consider a sale, not a sell signal", () => {
  it("states the NEWS SELL TEST once, for both books, with the hold default", () => {
    expect(on.match(/- NEWS SELL TEST \(applies to every sell for news, main book AND influencer sleeve\)/g)?.length).toBe(1);
    expect(on).toMatch(/never a sell signal by itself/);
    expect(on).toMatch(/If you cannot say that, HOLD/);
    expect(on).toMatch(/Do not reason past your own judgment because the tag exists/);
  });
  it("every news sell path points at it — main rule, sleeve exception, closed-day risk sells", () => {
    expect(on).toContain("a bearish ⚡NEWS↓ event that passes the NEWS SELL TEST below");
    expect(on).toContain("(2) NEWS — a bearish ⚡NEWS↓ that passes the NEWS SELL TEST below");
    expect(off).toContain("Sell if a bearish ⚡NEWS↓ event that passes the NEWS SELL TEST");
    expect(off).toContain("a ⚡NEWS↓ that passes the NEWS SELL TEST / ↓FIRM");
  });
  it("no wording left that makes the tag itself an exit reason", () => {
    for (const p of [on, off]) {
      expect(p).not.toMatch(/that is a real reason to trim\/exit/);
      expect(p).not.toMatch(/real trim\/avoid reason/);
    }
    const legend = formatV1Shortlist([], {}, {}, {}, new Set(), new Map(), new Map(), new Map(), new Map(), "2026-11-13");
    expect(legend).toContain("on a holding a reason to CONSIDER selling under the NEWS SELL TEST");
  });
});
