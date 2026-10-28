import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { screenImminentEarningsBuys, beatClass, type EarningsBeatRecord } from "@/lib/earnings";
import { buildV1Shortlist, formatV1Shortlist, type StockData } from "@/lib/market-data";
import { shortlistAroundEarnings, type EarningsLookup } from "@/lib/earnings-skip";
import { buildV1AnalysisPrompt, buildSystemPrompt } from "@/lib/strategy";

// 2026-10-28 (owner decision): the blanket "never buy ≤3d before earnings" tested neutral
// (2004-2026), so the buy side now uses the HOLD side's own bar — a SERIAL beater (beat ≥3/4,
// avg surprise ≥ +5%) may be bought into its print. Everything else stays blocked, and the
// direction that matters is fail-CLOSED: a missing record must never open the gate.
const TODAY = "2026-10-28";
const SERIAL: EarningsBeatRecord = { beats: 4, total: 4, avgSurprisePct: 15 };
const MIXED: EarningsBeatRecord = { beats: 2, total: 4, avgSurprisePct: 1 };
const buys = [{ symbol: "PLTR" }, { symbol: "AMZN" }, { symbol: "NOREC" }, { symbol: "FAR" }];
const dates = { PLTR: "2026-10-29", AMZN: "2026-10-29", NOREC: "2026-10-30", FAR: "2026-12-01" };
const asked = new Set(["PLTR", "AMZN", "NOREC", "FAR"]);

describe("buy gate — serial beaters only", () => {
  test("serial beater KEPT with a note; mixed and missing record DROPPED; far date untouched", () => {
    const r = screenImminentEarningsBuys(buys, dates, asked, TODAY, 3, new Map([["PLTR", SERIAL], ["AMZN", MIXED]]));
    expect(r.kept.map(b => b.symbol).sort()).toEqual(["FAR", "PLTR"]);
    expect(r.imminent.sort()).toEqual(["AMZN", "NOREC"]);
    expect(r.notes.find(n => n.startsWith("PLTR"))).toContain("ALLOWED");
    expect(r.notes.find(n => n.startsWith("AMZN"))).toContain("not serial");
    expect(r.notes.find(n => n.startsWith("NOREC"))).toContain("could NOT establish a beat record");
  });
  test("FAIL CLOSED: no beat map (fetch failed) = every imminent buy dropped, as before", () => {
    const r = screenImminentEarningsBuys(buys, dates, asked, TODAY);
    expect(r.kept.map(b => b.symbol)).toEqual(["FAR"]);
    expect(screenImminentEarningsBuys(buys, dates, asked, TODAY, 3, new Map()).kept.map(b => b.symbol)).toEqual(["FAR"]);
  });
  test("a serial record does NOT override an unknown earnings date (that is a different failure)", () => {
    const r = screenImminentEarningsBuys([{ symbol: "PLTR" }], {}, new Set(), TODAY, 3, new Map([["PLTR", SERIAL]]));
    expect(r.kept).toEqual([]);
    expect(r.unknown).toEqual(["PLTR"]);
  });
  test("the bar is exactly the hold side's: ≥3/4 AND avg ≥ +5%", () => {
    expect(beatClass({ beats: 3, total: 4, avgSurprisePct: 5 })).toBe("serial");
    expect(beatClass({ beats: 3, total: 4, avgSurprisePct: 4.9 })).toBe("other");
    expect(beatClass({ beats: 2, total: 4, avgSurprisePct: 20 })).toBe("other");
    expect(beatClass(undefined)).toBe("unknown");
    // review 2026-10-28: a short history is not a "≥3/4" record — 2/2 and 3/3 do not open the gate
    expect(beatClass({ beats: 2, total: 2, avgSurprisePct: 10 })).toBe("unknown");   // too short to judge,
    expect(beatClass({ beats: 3, total: 3, avgSurprisePct: 10 })).toBe("unknown");   // not a weak record
  });
});

describe("shortlist backfill — a serial beater keeps its slot", () => {
  const mk = (sym: string, mom: number): StockData => ({ symbol: sym, price: 100, mom12_1: mom } as unknown as StockData);
  const stocks = [mk("SNDK", 800), mk("STX", 300), mk("WDC", 250), mk("DELL", 240), mk("MRVL", 200)];
  const eligible = new Set(stocks.map(s => s.symbol));
  const build = (skip: Set<string>) => buildV1Shortlist(stocks, eligible, { skipForBuy: skip });
  const lookup = async (syms: string[]): Promise<EarningsLookup> => {
    const d: Record<string, string> = { SNDK: "2026-10-29", STX: "2026-10-30" };
    const up = new Map(syms.filter(s => d[s]).map(s => [s, d[s]]));
    return { upcoming: up, upcomingHour: new Map(), recent: new Map(), lastReport: new Map(), asked: new Set(syms) };
  };
  test("SNDK serial → kept and reported; STX mixed → skipped; the next name takes STX's slot", async () => {
    const r = await shortlistAroundEarnings(build, lookup, new Set(), TODAY, {}, 3, async () => new Map([["SNDK", SERIAL], ["STX", MIXED]]));
    const tech = r.buy.map(s => s.symbol);
    expect(tech).toContain("SNDK");
    expect(tech).not.toContain("STX");
    expect(r.skipped.map(k => k.symbol)).toEqual(["STX"]);
    expect([...r.serialImminent.keys()]).toEqual(["SNDK"]);
    expect(r.beats.get("SNDK")).toEqual(SERIAL);
  });
  test("FAIL CLOSED: a beat lookup that throws skips them all, exactly as before", async () => {
    const r = await shortlistAroundEarnings(build, lookup, new Set(), TODAY, {}, 3, async () => { throw new Error("finnhub down"); });
    expect(r.skipped.map(k => k.symbol).sort()).toEqual(["SNDK", "STX"]);
    expect(r.serialImminent.size).toBe(0);
  });
});

describe("the model sees the record and the rule", () => {
  test("an imminent shortlist row shows its 📈EARN-RECORD (it decides the buy)", () => {
    const row = formatV1Shortlist([{ symbol: "SNDK", price: 100, mom12_1: 800, earningsDate: "2026-10-29" } as unknown as StockData],
      {}, {}, {}, new Set(), new Map(), new Map(), undefined, new Map([["SNDK", SERIAL]]), TODAY);
    expect(row).toContain("📈EARN-RECORD beat 4/4");
    expect(row).toContain("✓SERIAL");
  });
  test("the row's ✓SERIAL is the gate's verdict — 3/4 at +4.6% shows 'avg +5%' but NOT ✓SERIAL", async () => {
    const { formatEarningsRecord } = await import("@/lib/earnings");
    const f = formatEarningsRecord({ beats: 3, total: 4, avgSurprisePct: 4.6 });
    expect(f).toContain("avg +5%");
    expect(f).not.toContain("✓SERIAL");
  });
  test("prompt: the blanket ban is gone; every statement of the rule names the serial exception", () => {
    const p = buildV1AnalysisPrompt(TODAY, "", { buyingPower: "$100", totalValue: "$2400", positions: [] } as never,
      undefined, undefined, [], [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", true, "", {} as never);
    const sys = buildSystemPrompt(TODAY);
    for (const text of [p, sys]) {
      expect(text).not.toContain("do NOT buy under any circumstances");
      expect(text).not.toContain("No exceptions regardless of momentum");
    }
    // a missing-record drop must read as a DATA failure to lib/no-trade-cause (its UNESTABLISHED)
    expect("we could NOT establish a beat record").toMatch(/could NOT establish|could not be parsed/);
    const RULE = "📈EARN-RECORD marked ✓SERIAL (beat ≥3 of ≥4 quarters, avg surprise ≥ +5%)";
    expect(p).toContain(RULE);                                   // the analysis (buy) prompt
    expect(sys.split(RULE).length - 1).toBe(2);                  // the system prompt's two statements
    const infl = readFileSync(`${import.meta.dir}/../lib/influencer-signals.ts`, "utf8");
    expect(infl).toContain("UNLESS it shows a 📈EARN-RECORD marked ✓SERIAL");
    expect(infl).toContain("⚠⚠ imminent earnings without a ✓SERIAL 📈EARN-RECORD");
  });
  test("wiring: the gate is fed the beat map, and the shortlist the beat lookup", () => {
    const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    expect(route).toContain("screenImminentEarningsBuys(decision.buys, earningsDatesMap, earningsAsked, today, IMMINENT_EARNINGS_DAYS, gateBeats)");
    expect(route).toContain("(syms) => fetchEarningsBeatHistory(syms),");
    expect(route).toContain("...imminentCandidates]");
  });
});

describe("review 2026-10-28 fixes (wiring)", () => {
  const route = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
  test("a name the shortlist SKIPPED stays blocked at the gate, even if a later fetch is serial", () => {
    expect(route).toContain("for (const k of shortlistEarn.skipped) gateBeats.delete(k.symbol);");
    expect(route).toContain("IMMINENT_EARNINGS_DAYS, gateBeats)");
  });
  test("candidates use the EARLIER of the two date sources (what the row shows)", () => {
    expect(route).toContain("[earningsDatesMap[sym], stockDate.get(sym)]");
  });
  test("the shadow reuses the shortlist's records and logs KEPT serial names, scored as entries", () => {
    expect(route).toContain("recordEarningsSkipShadow(tagBeatRecords(shortlistEarn.skipped, esBeat), today, kept)");
    const shadow = readFileSync(`${import.meta.dir}/../app/api/earnings-skip-shadow/route.ts`, "utf8");
    expect(shadow).toContain('scoreShadowObservations(keptObs, today, "entry", prices)');
  });
});
