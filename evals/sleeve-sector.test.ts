import { describe, test, expect } from "bun:test";
import { applySleeveSectorRule, MAX_SLEEVE_PER_SECTOR } from "@/lib/buy-sizing";
import { SEMICONDUCTORS, industryOf, STOCK_SECTOR } from "@/lib/market-data";
import { SP500_UNIVERSE } from "@/lib/strategy";

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-15: both influencer slots sat in semiconductors — NVDA and AVGO. Two
// names, one industry, in a 2-slot sleeve whose purpose is to catch moves the
// main book cannot. That is one bet with extra commission, and NO guard saw it:
// the sleeve picks on a YouTube signal with no sector awareness, and the
// cross-sleeve VALUE budget never fired because the book was under 40%.
//
// Granularity is INDUSTRY, not sector, and that was the owner's call against my
// recommendation — correctly, on the data: 60% of influencer mentions are XLK,
// so a sector rule would cap the sleeve at one name most of the time and would
// block PLTR+NVDA and MSFT+AMD, which are different businesses.
// ─────────────────────────────────────────────────────────────────────────────
const sleeveBuy = (symbol: string) => ({ symbol });
const run = (buys: { symbol: string }[], heldSyms: string[]) =>
  applySleeveSectorRule(buys, {
    heldSectors: heldSyms.map(industryOf),
    sectorOf: industryOf,
    isSleeveBuy: () => true,
  });

describe("the influencer sleeve cannot put both slots in one industry", () => {
  test("the live case: holding NVDA, an AVGO buy is dropped", () => {
    const r = run([sleeveBuy("AVGO")], ["NVDA"]);
    expect(r.buys).toHaveLength(0);
    expect(r.notes[0]).toMatch(/already holds 1 XLK:semis name/);
    expect(r.notes[0]).toMatch(/one bet, not two/);
  });

  test("...but a non-semi tech name IS allowed — the reason for industry granularity", () => {
    // 60% of mentions are XLK. A sector rule would block both of these and leave the sleeve at one
    // position most of the time; these are genuinely different businesses.
    for (const sym of ["MSFT", "PLTR", "CRM", "ORCL", "AAPL"]) {
      if (!STOCK_SECTOR[sym]) continue;
      expect(run([sleeveBuy(sym)], ["NVDA"]).buys).toHaveLength(1);
    }
  });

  test("two semis in the SAME batch cannot both pass", () => {
    // The batch hole: a per-item check that never accumulates. Nothing is held here.
    const r = run([sleeveBuy("NVDA"), sleeveBuy("AMD")], []);
    expect(r.buys.map(b => b.symbol)).toEqual(["NVDA"]);
  });

  test("a different sector is unaffected", () => {
    expect(run([sleeveBuy("LLY")], ["NVDA"]).buys).toHaveLength(1);
    expect(run([sleeveBuy("LLY")], ["REGN"]).buys).toHaveLength(0);   // both XLV
  });

  test("a buy whose industry cannot be established is WITHHELD, not waved through", () => {
    const r = applySleeveSectorRule([sleeveBuy("ZZZZ")], {
      heldSectors: [], sectorOf: industryOf, isSleeveBuy: () => true });
    expect(r.buys).toHaveLength(0);
    expect(r.notes[0]).toMatch(/could NOT establish its sector/);
    expect(r.notes[0]).toContain("NOT that ZZZZ is concentrated");
  });

  test("an unclassifiable HELD name is announced, because it cannot block anything", () => {
    // Fail-open by necessity: a grandfathered off-index sleeve hold has no sector, so the rule is
    // weaker than it looks while one exists. Silence would be the dangerous version.
    const r = applySleeveSectorRule([sleeveBuy("NVDA")], {
      heldSectors: [null], sectorOf: industryOf, isSleeveBuy: () => true });
    expect(r.buys).toHaveLength(1);
    expect(r.notes.some(n => /no sector mapping/.test(n))).toBe(true);
  });

  test("CONTROL: main-book buys are untouched by a sleeve rule", () => {
    const r = applySleeveSectorRule([sleeveBuy("AVGO"), sleeveBuy("AMD")], {
      heldSectors: [industryOf("NVDA")], sectorOf: industryOf, isSleeveBuy: () => false });
    expect(r.buys).toHaveLength(2);
    expect(r.notes).toHaveLength(0);
  });
});

describe("the semiconductor list cannot rot silently", () => {
  test("every member is still in the S&P universe", () => {
    // The whole objection to a hand-maintained list is that it goes stale invisibly. A delisting or
    // a ticker change makes an entry a no-op — this turns that into a RED TEST instead.
    const universe = new Set(SP500_UNIVERSE);
    expect([...SEMICONDUCTORS].filter(s => !universe.has(s))).toEqual([]);
  });

  test("every member is mapped to XLK, so the refinement sits inside its sector", () => {
    expect([...SEMICONDUCTORS].filter(s => STOCK_SECTOR[s] !== "XLK")).toEqual([]);
  });

  test("the names that have actually reached the sleeve are covered", () => {
    for (const s of ["NVDA", "AVGO", "MRVL", "MU", "AMD", "LRCX"]) expect(industryOf(s)).toBe("XLK:semis");
  });

  test("the documented EXCLUSIONS stay excluded — the boundary is deliberate", () => {
    // EDA software, storage, servers, components. If one of these should be in, that is a decision,
    // not a drift.
    for (const s of ["CDNS", "SNPS", "STX", "WDC", "DELL", "SMCI", "ANET", "APH", "GLW", "KEYS"]) {
      if (!STOCK_SECTOR[s]) continue;
      expect(industryOf(s)).toBe("XLK");
    }
  });

  test("the limit is 1 — two slots, two industries", () => {
    expect(MAX_SLEEVE_PER_SECTOR).toBe(1);
  });
});
