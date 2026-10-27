import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { buildV1Shortlist, type StockData } from "@/lib/market-data";
import { formatConviction } from "@/lib/conviction";
import { shortlistAroundEarnings, emptyEarningsLookup, mergeEarningsLookups, beatClass, tagBeatRecords, type EarningsLookup } from "@/lib/earnings-skip";

// 2026-10-26: the Tech slots (cap 3) went to MU (held), SNDK and STX — both reporting within 3 days,
// so the buy gate dropped them — and DELL/WDC, eligible and unblocked, were never shown. Nothing was
// bought. These pin the backfill: a KNOWN imminent date frees the slot; nothing else does.

const TODAY = "2026-10-26";
const mk = (syms: string[]) =>
  syms.map((symbol, i) => ({
    symbol, price: 100 + i, mom12_1: 1000 - i * 10,
    beta: 1, change1d: 0, change5d: 0, change14d: 0, change30d: 0, distFrom52wHigh: 0,
    volatility30d: 0.2, sharpe5d: 0, sharpe14d: 0, relStrength1d: 0, earningsDate: null,
  })) as unknown as StockData[];

// Momentum order: SNDK, MU, STX, DELL, WDC (all XLK) then one name in each of two other sectors.
const SYMS = ["SNDK", "MU", "STX", "DELL", "WDC", "XOM", "JPM"];
const stocks = mk(SYMS);
const eligible = new Set(SYMS);
const HELD = new Set(["MU"]);
const build = (skip: Set<string>) => buildV1Shortlist(stocks, eligible, { held: HELD, skipForBuy: skip });

/** A lookup that answers for every symbol, with these upcoming dates. */
const lookupWith = (dates: Record<string, string>, calls?: string[][]) => async (syms: string[]): Promise<EarningsLookup> => {
  calls?.push(syms);
  const out = emptyEarningsLookup();
  for (const s of syms) { out.asked.add(s); if (dates[s]) out.upcoming.set(s, dates[s]); }
  return out;
};
const tech = (r: { buy: StockData[] }) => r.buy.map(s => s.symbol).filter(s => ["SNDK", "MU", "STX", "DELL", "WDC"].includes(s));

describe("imminent-earnings names do not occupy shortlist slots", () => {
  test("the 2026-10-26 case: SNDK and STX skipped, DELL and WDC take the Tech slots", async () => {
    expect(tech(build(new Set()))).toEqual(["SNDK", "MU", "STX"]);   // CONTROL: the old list
    const r = await shortlistAroundEarnings(build, lookupWith({ SNDK: "2026-10-29", STX: "2026-10-27" }), HELD, TODAY);
    expect(tech(r)).toEqual(["MU", "DELL", "WDC"]);
    expect(r.skipped.map(k => k.symbol).sort()).toEqual(["SNDK", "STX"]);
    expect(r.skipped.find(k => k.symbol === "SNDK")).toEqual({ symbol: "SNDK", earningsDate: "2026-10-29", price: 100 });
  });

  test("a promoted name that is ALSO imminent is skipped in the next round", async () => {
    const r = await shortlistAroundEarnings(build, lookupWith({ SNDK: "2026-10-29", STX: "2026-10-27", DELL: "2026-10-28" }), HELD, TODAY);
    expect(r.buy.map(s => s.symbol)).not.toContain("DELL");
    expect(r.skipped.map(k => k.symbol).sort()).toEqual(["DELL", "SNDK", "STX"]);
  });

  test("a HELD name reporting imminently is NEVER skipped — missing from the list reads as a sell reason", async () => {
    const r = await shortlistAroundEarnings(build, lookupWith({ MU: "2026-10-27" }), HELD, TODAY);
    expect(r.buy.map(s => s.symbol)).toContain("MU");
    expect(r.skipped).toEqual([]);
    expect(buildV1Shortlist(stocks, eligible, { held: HELD, skipForBuy: new Set(["MU"]) }).buy.map(s => s.symbol)).toContain("MU");
  });

  test("FAIL-SAFE: an earnings outage skips NOTHING (the list is not emptied into the degenerate-data guard)", async () => {
    const r = await shortlistAroundEarnings(build, async () => { throw new Error("finnhub down"); }, HELD, TODAY);
    expect(r.buy.map(s => s.symbol)).toEqual(build(new Set()).buy.map(s => s.symbol));
    expect(r.skipped).toEqual([]);
    expect(r.earnings.asked.size).toBe(0);   // nothing established → the buy gate still withholds them
  });

  test("an UNANSWERED symbol keeps its slot (the gate drops it later, as before)", async () => {
    const partial = async (syms: string[]) => { const o = emptyEarningsLookup(); for (const s of syms) if (s !== "SNDK") o.asked.add(s); return o; };
    const r = await shortlistAroundEarnings(build, partial, HELD, TODAY);
    expect(r.buy.map(s => s.symbol)).toContain("SNDK");
  });

  test("a date OUTSIDE the window (4d) or in the past skips nothing", async () => {
    const r = await shortlistAroundEarnings(build, lookupWith({ SNDK: "2026-10-30", STX: "2026-10-23" }), HELD, TODAY);
    expect(r.skipped).toEqual([]);
    expect(tech(r)).toEqual(["SNDK", "MU", "STX"]);
  });

  test("each symbol is asked at most once, held names are not asked here, and rounds are bounded", async () => {
    const calls: string[][] = [];
    const r = await shortlistAroundEarnings(build, lookupWith({ SNDK: "2026-10-29", STX: "2026-10-27" }, calls), HELD, TODAY);
    const asked = calls.flat();
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).not.toContain("MU");
    expect([...r.attempted].sort()).toEqual([...new Set(asked)].sort());
    const one = await shortlistAroundEarnings(build, lookupWith({ SNDK: "2026-10-29", STX: "2026-10-27", DELL: "2026-10-28" }), HELD, TODAY, {}, 1);
    expect(one.skipped.map(k => k.symbol).sort()).toEqual(["SNDK", "STX"]);   // 1 round: DELL promoted, not screened
  });

  test("a print known only to the BULK calendar also frees the slot (the gate reads it too)", async () => {
    const r = await shortlistAroundEarnings(build, lookupWith({}), HELD, TODAY, { SNDK: "2026-10-28" });
    expect(r.skipped).toEqual([{ symbol: "SNDK", earningsDate: "2026-10-28", price: 100 }]);
    expect(r.buy.map(s => s.symbol)).not.toContain("SNDK");
  });

  test("merge unions disjoint lookups", () => {
    const a = emptyEarningsLookup(); a.asked.add("A"); a.upcoming.set("A", "2026-10-27");
    const b = emptyEarningsLookup(); b.asked.add("B");
    const m = mergeEarningsLookups(a, b);
    expect([...m.asked].sort()).toEqual(["A", "B"]);
    expect(m.upcoming.get("A")).toBe("2026-10-27");
  });
});

describe("conviction labels never call an earnings-skipped name buyable", () => {
  const run = { runDate: "2026-10-20", picks: [{ symbol: "MU", rank: 1, thesis: "t" }, { symbol: "WDC", rank: 2, thesis: "t" }] } as any;
  const base = { mainShortlist: new Set(["WDC"]), influencerCandidates: new Set(["MU"]), earningsBlocked: new Map([["MU", "2026-10-28"]]) };
  test.each([true, false])("a skipped name that is ALSO an influencer candidate is NOT buyable (rebalance day: %p)", (isRebalanceDay) => {
    const out = formatConviction(run, TODAY, { ...base, isRebalanceDay });
    const muLine = out.split("\n").find(l => l.includes("MU (rank 1"))!;
    expect(muLine).toContain("NOT buyable this run");
    expect(muLine).not.toContain("influencer set");
  });
  test("CONTROL: without the block, the same name reads as a usable sleeve pick", () => {
    const out = formatConviction(run, TODAY, { ...base, earningsBlocked: undefined, isRebalanceDay: true });
    expect(out.split("\n").find(l => l.includes("MU (rank 1"))).toContain("influencer set");
  });
});

describe("wiring: /api/trade builds the shortlist through the backfill", () => {
  const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
  test("the live shortlist passes skipForBuy via shortlistAroundEarnings, with held names protected", () => {
    expect(route).toContain("shortlistAroundEarnings(");
    expect(route).toMatch(/buildV1Shortlist\(marketData\.stocks, eligible, \{ held: heldMainSymbols, qualityUnknown, skipForBuy: skip \}\)/);
    expect(route).not.toMatch(/=\s*buildV1Shortlist\(marketData\.stocks, eligible, \{ held: heldMainSymbols, qualityUnknown \}\)/);
  });
  test("the main earnings lookup merges the shortlist pass, so the buy gate sees every answer", () => {
    expect(route).toContain("mergeEarningsLookups(shortlistEarn.earnings, mainEarnings)");
  });
  test("the shadow is recorded only on buy-open days", () => {
    expect(route).toMatch(/if \(buysOpen && !mainBuysBlocked && shortlistEarn\.skipped\.length\)/);
  });
  test("the conviction block is told the SHOWN shortlist, never the skipped names", () => {
    expect(route).toContain("mainShortlist: new Set(v1Buy.map(s => s.symbol))");
    expect(route).toContain("earningsBlocked: new Map(shortlistEarn.skipped.map(k => [k.symbol, k.earningsDate]))");
    expect(route).not.toContain("mainShortlist: v1ShortlistSet");
  });
  test("skipped names stay in the allowlist that classifies main vs influencer buys", () => {
    expect(route).toContain("...shortlistEarn.skipped.map(k => k.symbol)]);");
  });
});

describe("beat-record tagging on the shadow (2026-10-27)", () => {
  test("serial = the prompt's bar (beat >=3/4, avg >= +5%); a missing record is UNKNOWN, never 'other'", () => {
    expect(beatClass({ beats: 4, total: 4, avgSurprisePct: 15 })).toBe("serial");      // PLTR
    expect(beatClass({ beats: 3, total: 4, avgSurprisePct: 5 })).toBe("serial");       // the bar itself
    expect(beatClass({ beats: 6, total: 8, avgSurprisePct: 5 })).toBe("serial");
    expect(beatClass({ beats: 2, total: 4, avgSurprisePct: 20 })).toBe("other");       // too few beats
    expect(beatClass({ beats: 4, total: 4, avgSurprisePct: 4.9 })).toBe("other");      // surprise too small
    expect(beatClass(undefined)).toBe("unknown");
    expect(beatClass({ beats: 0, total: 0, avgSurprisePct: 0 })).toBe("unknown");
  });
  test("tagging attaches records where present and leaves the rest untouched", () => {
    const sk = [{ symbol: "SNDK", earningsDate: "2026-10-29", price: 100 }, { symbol: "STX", earningsDate: "2026-10-27", price: 50 }];
    const out = tagBeatRecords(sk, new Map([["SNDK", { beats: 4, total: 4, avgSurprisePct: 12 }]]));
    expect(out[0].beat).toEqual({ beats: 4, total: 4, avgSurprisePct: 12 });
    expect("beat" in out[1]).toBe(false);
    expect(sk[0]).not.toHaveProperty("beat");   // pure
  });
  test("wiring: the trade route records TAGGED names; the shadow route scores by bucket", () => {
    const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    expect(route).toContain("recordEarningsSkipShadow(tagBeatRecords(shortlistEarn.skipped, esBeat), today)");
    expect(route).toContain("fetchEarningsBeatHistory(shortlistEarn.skipped.map(k => k.symbol)).catch(");
    const shadow = readFileSync(`${import.meta.dir}/../app/api/earnings-skip-shadow/route.ts`, "utf8");
    expect(shadow).toContain("cls: beatClass(k.beat)");
    expect(shadow).toContain('for (const cls of ["serial", "other", "unknown"] as const)');
  });
});

describe("a same-day re-run cannot erase beat tags (2026-10-27 review)", () => {
  test("a name re-logged WITHOUT a record keeps the morning's record; a fresh record wins", async () => {
    const { recordEarningsSkipShadow } = await import("@/lib/earnings-skip");
    const env = { u: process.env.UPSTASH_REDIS_REST_URL, t: process.env.UPSTASH_REDIS_REST_TOKEN };
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.invalid"; process.env.UPSTASH_REDIS_REST_TOKEN = "stub";
    let stored: string | null = JSON.stringify([{ date: TODAY, skipped: [
      { symbol: "SNDK", earningsDate: "2026-10-29", price: 100, beat: { beats: 4, total: 4, avgSurprisePct: 12 } },
      { symbol: "STX", earningsDate: "2026-10-27", price: 50, beat: { beats: 1, total: 4, avgSurprisePct: -2 } },
    ] }]);
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).includes("/get/")) return new Response(JSON.stringify({ result: stored }), { status: 200 });
      stored = JSON.parse(init.body)[0][2];
      return new Response("[]", { status: 200 });
    }) as any;
    try {
      await recordEarningsSkipShadow([
        { symbol: "SNDK", earningsDate: "2026-10-29", price: 101 },                                        // fetch failed
        { symbol: "STX", earningsDate: "2026-10-27", price: 51, beat: { beats: 2, total: 4, avgSurprisePct: 1 } }, // fresh
      ], TODAY);
      const day = JSON.parse(stored!).find((d: any) => d.date === TODAY);
      expect(day.skipped.find((k: any) => k.symbol === "SNDK").beat).toEqual({ beats: 4, total: 4, avgSurprisePct: 12 });
      expect(day.skipped.find((k: any) => k.symbol === "STX").beat).toEqual({ beats: 2, total: 4, avgSurprisePct: 1 });
      expect(day.skipped.find((k: any) => k.symbol === "SNDK").price).toBe(101);
    } finally {
      globalThis.fetch = saved;
      process.env.UPSTASH_REDIS_REST_URL = env.u; process.env.UPSTASH_REDIS_REST_TOKEN = env.t;
    }
  });
});
