import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { sectorPeerMove } from "@/lib/stopouts";
import { buildV1AnalysisPrompt } from "@/lib/strategy";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("an unmeasured same-day move is neither a stop nor a flat peer", () => {
  const sec = () => "Technology";
  test("a placeholder-0 peer is left out of the sector move", () => {
    const stocks = [{ symbol: "A", change1d: -6 }, { symbol: "B", change1d: -6 }, { symbol: "C", change1d: -6 },
      { symbol: "D", change1d: 0, change1dUnknown: true as const }];
    expect(sectorPeerMove("X", stocks, sec)).toBe(-6);
  });
  test("control: measured peers all count", () => {
    expect(sectorPeerMove("X", [{ symbol: "A", change1d: -6 }, { symbol: "B", change1d: -6 }, { symbol: "C", change1d: 0 }], sec)).toBe(-4);
  });
  test("drop-check: a null move is not judged, and is reported", () => {
    const d = src("app/api/drop-check/route.ts");
    expect(d).toContain("const reason = measured == null ? null : classifyExit(change1d, ctx);");
    expect(d).toContain(": (q?.change1d ?? null);");
    // the second source runs BEFORE judging, only for quoted names, and only through the checker
    expect(d.indexOf("fetchRobinhoodPrevCloses(")).toBeLessThan(d.indexOf("const droppedPositions = positionsToCheck"));
    expect(d).toContain("r.q != null && r.q.change1d == null && !influencerSymbols.has(r.symbol) && !boughtTodaySymbols.has(r.symbol)");
    expect(d).toContain('&& new URL(request.url).searchParams.get("dryRun") !== "1") {');
    expect(d).toContain("const closes = robinhoodPrevCloses(rows ?? [], needBaseline,");
    expect(d).toContain("held: worst, unjudged, unquoted });");
    expect(d).toContain('redisCommand("set", `dropcheck:unjudged-alert:${today}:${names}`, "1", "NX"');
    expect(d.indexOf("Drop-check could not judge")).toBeLessThan(d.indexOf("if (droppedPositions.length === 0) {"));
    expect(d.match(/\$\{staleNote\}\$\{unjudgedNote\}/g)?.length).toBeGreaterThanOrEqual(2);
  });
  test("fetchQuoteLite has no 0% fallback and the prompt shows n/a", () => {
    const m = src("lib/market-data.ts");
    expect(m).toContain("const change1d = prevClose ? ((price - prevClose) / prevClose) * 100 : null;");
    expect(m).toContain('s.change1dUnknown ? "n/a"');
    expect(m).not.toMatch(/resolvePrevClose\([^)]*chartPreviousClose/);
  });
});

describe("an analyst action must pass the NEWS SELL TEST", () => {
  const ctx = { buyingPower: "$18", totalValue: "$2000", positions: [{ symbol: "MU", quantity: "0.23", avgCost: "703.75", price: 564 }] } as any;
  const on = buildV1AnalysisPrompt("2026-11-25", "(t)", ctx, "INFLUENCER SIGNALS", "", []);
  const off = buildV1AnalysisPrompt("2026-11-25", "(t)", ctx, "INFLUENCER SIGNALS", "", [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", false);
  const legend = src("lib/market-data.ts").match(/↓FIRM = downgrade\/PT-cut \([^)]*\)/)?.[0] ?? "";
  // Every ↓FIRM offered as a reason to sell/trim/exit must carry the test within the same clause.
  // OK only when the test is attached to THIS ↓FIRM: named just before it, or reached from it
  // without passing a list separator (", ↓FIRM, a ⚡NEWS↓ that passes…" ties the test to the news item only).
  const bare = (text: string) => [...text.matchAll(/↓FIRM/g)].filter(m => {
    const i = m.index!;
    const around = text.slice(Math.max(0, i - 120), i + 140);
    if (!/\b(sell|sells|selling|trim|trimming|exit)\b/i.test(around)) return false;
    if (text.slice(Math.max(0, i - 60), i).endsWith("to every MAIN-book sell for an analyst action — a ")) return false; // the test's own definition
    if (/tiebreaker\/conviction input like ★INS\/↓FIRM/.test(text.slice(i - 60, i + 6))) return false; // a BUY-side tiebreaker
    const j = text.indexOf("NEWS SELL TEST", i);
    return !(j >= 0 && j - i <= 60 && !/[,;]/.test(text.slice(i, j)));
  }).map(m => text.slice(Math.max(0, m.index! - 60), m.index! + 80));
  test("rendered prompts, both cadences, and the shortlist legend", () => {
    expect(legend).toContain("needs the NEWS SELL TEST");
    expect(bare(on)).toEqual([]);
    expect(bare(off)).toEqual([]);
    expect(on).toContain("is itself a non-binding opinion and passes only when the thesis names the MATERIAL company development");
  });
  test("control: the old wording is caught", () => {
    expect(bare("Sell if a ↓FIRM downgrade lands, or a holding fell off the shortlist.").length).toBe(1);
    expect(bare("the SELL list above (fell off the shortlist, ↓FIRM, a ⚠ sector trim)").length).toBe(1);
    expect(bare("the SELL list above (fell off the shortlist, ↓FIRM, a bearish ⚡NEWS↓ event that passes the NEWS SELL TEST)").length).toBe(1);
  });
});
