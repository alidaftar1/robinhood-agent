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
