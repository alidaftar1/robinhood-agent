import { describe, expect, test } from "bun:test";
import { inferSellStrategy, type PositionSnapshot, type TradeSnapshot } from "../lib/run-store";

// 67 of 81 historical sells carried no strategy, because the original tagger looked for the
// symbol's BUY in the PREVIOUS RUN — and a position is bought days or weeks before it is sold.
// Untagged sells make per-sleeve realised P&L uncomputable: nothing nets to closed, so every
// position reads as still open.
const pos = (symbol: string): PositionSnapshot => ({ symbol, quantity: "1", avgCost: "100" } as PositionSnapshot);
const buy = (symbol: string, strategy?: "main" | "influencer"): TradeSnapshot =>
  ({ symbol, side: "buy", quantity: "1", avgPrice: "100", state: "filled", ...(strategy ? { strategy } : {}) });

describe("inferSellStrategy", () => {
  test("a symbol in the prior run's influencer positions sells as INFLUENCER", () => {
    expect(inferSellStrategy("NVDA", [pos("NVDA"), pos("AVGO")])).toBe("influencer");
  });

  test("a held symbol absent from them sells as MAIN", () => {
    expect(inferSellStrategy("KO", [pos("NVDA")])).toBe("main");
  });

  test("an EMPTY influencer-positions array is meaningful — the sleeve held nothing", () => {
    // Present-but-empty must answer "main", not fall through to a stale buy record.
    expect(inferSellStrategy("NVDA", [], [buy("NVDA", "influencer")])).toBe("main");
  });

  test("an ABSENT array falls back to buy history — those runs predate the field", () => {
    expect(inferSellStrategy("NVDA", undefined, [buy("NVDA", "influencer")])).toBe("influencer");
    expect(inferSellStrategy("KO", undefined, [buy("KO", "main")])).toBe("main");
  });

  test("it NEVER returns undefined — an untagged sell is what broke the accounting", () => {
    for (const r of [
      inferSellStrategy("ZZZZ", undefined, []),
      inferSellStrategy("ZZZZ", [], []),
      inferSellStrategy("ZZZZ", undefined, [buy("OTHER", "influencer")]),
    ]) expect(["main", "influencer"]).toContain(r);
  });

  test("an untagged buy in the fallback does not become 'influencer' by accident", () => {
    expect(inferSellStrategy("NVDA", undefined, [buy("NVDA")])).toBe("main");
  });

  test("the fallback matches on SYMBOL, not just any buy", () => {
    expect(inferSellStrategy("NVDA", undefined, [buy("AVGO", "influencer")])).toBe("main");
  });
});

// ── buildInferredSells ───────────────────────────────────────────────────────
// The sell the agent never saw. A MANUAL sell in the Robinhood app is invisible to the trade
// route, so patchTrades reconstructing it is the only record it ever gets — and until 2026-10-05
// that reconstruction wrote no `strategy` at all, re-creating the exact untagged-sell defect the
// tests above exist to prevent, in the one path where no live tagger can ever fix it.
import { buildInferredSells } from "../lib/run-store";

const held = (symbol: string, price: string, avgCost = "100"): PositionSnapshot =>
  ({ symbol, quantity: "2", avgCost, price } as PositionSnapshot);

describe("buildInferredSells", () => {
  const heldRun = {
    positions: [held("KO", "55"), held("NVDA", "180")],
    influencerPositions: [held("NVDA", "180")],
    trades: [] as TradeSnapshot[],
  };

  test("a vanished MAIN position is reconstructed and tagged main", () => {
    const out = buildInferredSells(heldRun, { positions: [held("NVDA", "180")], trades: [] });
    expect(out.map(t => [t.symbol, t.strategy])).toEqual([["KO", "main"]]);
    expect(out[0].side).toBe("sell");
    expect(out[0].quantity).toBe("2");
  });

  test("a vanished SLEEVE position is tagged influencer, NOT main", () => {
    // The defect this whole function guards: consulting the run the position is MISSING from would
    // find no influencerPositions entry and silently tag a sleeve exit "main". Mutation-checked —
    // passing the missing run as `heldRun` makes this case fail.
    const out = buildInferredSells(heldRun, { positions: [held("KO", "55")], trades: [] });
    expect(out.map(t => [t.symbol, t.strategy])).toEqual([["NVDA", "influencer"]]);
  });

  test("price is the held run's MARK, and the record stays flagged as an estimate", () => {
    // state must survive: lib/slippage's collectFills excludes `inferred`, so losing this flag
    // would feed a guessed price into the execution-cost measurement as though it were a fill.
    const out = buildInferredSells(heldRun, { positions: [held("NVDA", "180")], trades: [] });
    expect(out[0].avgPrice).toBe("55.00");
    expect(out[0].state).toBe("inferred");
  });

  test("falls back to avgCost when the held run had no usable mark", () => {
    const noMark = { ...heldRun, positions: [held("KO", "0", "41.5")] };
    const out = buildInferredSells(noMark, { positions: [], trades: [] });
    expect(out[0].avgPrice).toBe("41.50");
  });

  test("a REAL recorded sell is never duplicated", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("NVDA", "180")],
      trades: [{ symbol: "KO", side: "sell", quantity: "2", avgPrice: "54.90", state: "filled" }],
    });
    expect(out).toEqual([]);
  });

  test("a previously INFERRED sell IS re-derived, so a bad estimate can be replaced", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("NVDA", "180")],
      trades: [{ symbol: "KO", side: "sell", quantity: "2", avgPrice: "1.00", state: "inferred" }],
    });
    expect(out.map(t => [t.symbol, t.avgPrice])).toEqual([["KO", "55.00"]]);
  });

  test("CONTROL — nothing vanished, nothing is invented", () => {
    // Without this the suite could pass by fabricating sells for everything.
    expect(buildInferredSells(heldRun, { positions: heldRun.positions, trades: [] })).toEqual([]);
  });
});
