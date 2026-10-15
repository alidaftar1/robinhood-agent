import { describe, test, expect } from "bun:test";
import { applySleeveSectorRule, MAX_SLEEVE_PER_SECTOR } from "@/lib/buy-sizing";
import { industryOf, STOCK_SECTOR } from "@/lib/market-data";
import { STOCK_INDUSTRY } from "@/lib/stock-industry";
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
    expect(r.notes[0]).toMatch(/already holds 1 Semiconductors name/);
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

  test("a different industry is unaffected, and SAME-industry is blocked", () => {
    expect(run([sleeveBuy("LLY")], ["NVDA"]).buys).toHaveLength(1);
    // The directory is finer than the sector map here too, and correctly so: LLY is "Drug
    // Manufacturers - General" and REGN is "Biotechnology". Both are XLV, so a sector-level rule
    // would have blocked this pair — these are not the same bet.
    expect(run([sleeveBuy("LLY")], ["REGN"]).buys).toHaveLength(1);
    // Two large-cap pharma names ARE the same bet, and are blocked.
    expect(run([sleeveBuy("MRK")], ["LLY"]).buys).toHaveLength(0);
    // Two refiners likewise — a distinction XLE cannot draw against midstream or E&P.
    expect(run([sleeveBuy("MPC")], ["VLO"]).buys).toHaveLength(0);
    expect(run([sleeveBuy("TRGP")], ["APA"]).buys).toHaveLength(1);   // midstream vs E&P
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

describe("the industry directory is generated, and cannot rot silently", () => {
  test("it covers the universe, with the known gap pinned", () => {
    // Was a hand-maintained SEMICONDUCTORS set; replaced on 2026-10-15 with lib/stock-industry,
    // generated from Sharadar's `tickers` table. Coverage is pinned so the gap cannot widen without
    // a red test — PSKY and WBD are recent ticker changes Sharadar has not reflected, and both
    // FAIL OPEN (unclassifiable, so they block nothing).
    const missing = SP500_UNIVERSE.filter(s => !STOCK_INDUSTRY[s]);
    expect(missing.sort()).toEqual(["PSKY", "WBD"]);
  });

  test("every entry is a current universe member — a delisting fails LOUDLY", () => {
    const universe = new Set(SP500_UNIVERSE);
    expect(Object.keys(STOCK_INDUSTRY).filter(s => !universe.has(s))).toEqual([]);
  });

  test("the directory is FINER than the sector map, which is the whole point", () => {
    // XLK alone is 85 names. If industryOf ever collapsed back to sector granularity the sleeve
    // rule would cap at one tech name ~60% of the time — the version the owner rejected.
    const xlk = Object.keys(STOCK_SECTOR).filter(s => STOCK_SECTOR[s] === "XLK");
    const industries = new Set(xlk.map(industryOf).filter(Boolean));
    expect(industries.size).toBeGreaterThan(5);
    expect(industries.has("XLK")).toBe(false);   // no XLK name falls back to the sector
  });

  test("it makes the distinctions the hand list got WRONG", () => {
    // Six disagreements, and the directory was right on these: storage is not a semiconductor,
    // solar is its own industry, and semi EQUIPMENT is a sibling of semis rather than the same.
    expect(industryOf("NVDA")).toBe("Semiconductors");
    expect(industryOf("AVGO")).toBe("Semiconductors");
    expect(industryOf("SNDK")).toBe("Computer Hardware");          // my list said semiconductor
    expect(industryOf("FSLR")).toBe("Solar");                      // my list said semiconductor
    expect(industryOf("AMAT")).toBe("Semiconductor Equipment & Materials");
    expect(industryOf("MSFT")).toBe("Software - Infrastructure");
    expect(industryOf("PLTR")).toBe("Software - Infrastructure");
  });

  test("an unknown symbol is null, so the caller decides the direction", () => {
    expect(industryOf("ZZZZ")).toBeNull();
  });

  test("the limit is 1 — two slots, two industries", () => {
    expect(MAX_SLEEVE_PER_SECTOR).toBe(1);
  });
});
