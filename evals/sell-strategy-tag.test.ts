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
// that reconstruction wrote no `strategy` at all, re-creating the untagged-sell defect the tests
// above exist to prevent. NOT an otherwise-unfixable hole: planSellTagBackfill tags any untagged
// sell by the same rule and ignores `state`, so /api/debug?backfillSellTags=1&write=1 would have
// reached these too. The point of tagging at write time is that the two paths cannot drift and no
// manual step is needed — not that nothing else could ever repair it.
//
// The same reconstruction also keyed on symbol MEMBERSHIP until 2026-10-05, so a partial sale
// reconstructed nothing and the day's return was published wrong (measured: -25.00% on a flat day
// for 5 of 10 shares). It now works from a quantity identity, and these tests pin both directions.
import { buildInferredSells, computeDailyReturn } from "../lib/run-store";

const held = (symbol: string, price: string, quantity = "2", avgCost = "100"): PositionSnapshot =>
  ({ symbol, quantity, avgCost, price } as PositionSnapshot);
const sell = (symbol: string, quantity: string, state = "filled"): TradeSnapshot =>
  ({ symbol, side: "sell", quantity, avgPrice: "50.00", state });

describe("buildInferredSells", () => {
  const heldRun = {
    positions: [held("KO", "55"), held("NVDA", "180")],
    influencerPositions: [held("NVDA", "180")],
    trades: [] as TradeSnapshot[],
  };
  const pairs = (p: ReturnType<typeof buildInferredSells>) =>
    p.sells.map(t => [t.symbol, t.quantity, t.avgPrice, t.strategy]);

  test("a vanished MAIN position is reconstructed and tagged main", () => {
    const out = buildInferredSells(heldRun, { positions: [held("NVDA", "180")], trades: [] });
    expect(pairs(out)).toEqual([["KO", "2.000000", "55.00", "main"]]);
    expect(out.sells[0].side).toBe("sell");
    expect(out.unreconstructable).toEqual([]);
  });

  test("a vanished SLEEVE position is tagged influencer, NOT main", () => {
    // Consulting the run the position is MISSING from would find no influencerPositions entry and
    // silently tag a sleeve exit "main". Mutation-checked: passing the missing run flips this.
    const out = buildInferredSells(heldRun, { positions: [held("KO", "55")], trades: [] });
    expect(pairs(out)).toEqual([["NVDA", "2.000000", "180.00", "influencer"]]);
  });

  test("price is the held run's MARK, and the record stays flagged as an estimate", () => {
    // state must survive: lib/slippage's collectFills excludes `inferred`, so losing this flag
    // would feed a guessed price into the execution-cost measurement as though it were a fill.
    const out = buildInferredSells(heldRun, { positions: [held("NVDA", "180")], trades: [] });
    expect(out.sells[0].avgPrice).toBe("55.00");
    expect(out.sells[0].state).toBe("inferred");
  });

  test("falls back to avgCost when the held run had no usable mark", () => {
    const noMark = { ...heldRun, positions: [held("KO", "0", "2", "41.5")] };
    const out = buildInferredSells(noMark, { positions: [], trades: [] });
    expect(out.sells[0].avgPrice).toBe("41.50");
  });

  test("a REAL recorded sell is never duplicated", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("NVDA", "180")], trades: [sell("KO", "2")],
    });
    expect(out.sells).toEqual([]);
  });

  test("a previously INFERRED sell IS re-derived, so a bad estimate can be replaced", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("NVDA", "180")],
      trades: [{ symbol: "KO", side: "sell", quantity: "2", avgPrice: "1.00", state: "inferred" }],
    });
    expect(pairs(out)).toEqual([["KO", "2.000000", "55.00", "main"]]);
  });

  test("a recorded BUY of a vanished symbol does NOT suppress the inferred sell", () => {
    // Same-day round trip, buy recorded and sell not. The buy raises the expected holding, so the
    // shortfall grows to cover it: 2 held + 2 bought - 0 sold - 0 now = 4.
    const out = buildInferredSells(heldRun, {
      positions: [held("NVDA", "180")],
      trades: [{ symbol: "KO", side: "buy", quantity: "2", avgPrice: "54.00", state: "filled" }],
    });
    expect(pairs(out)).toEqual([["KO", "4.000000", "55.00", "main"]]);
  });

  // ── the partial-exit fix (these two were pinned as a KNOWN GAP until 2026-10-05) ──
  test("an unrecorded PARTIAL exit reconstructs a sell for the SHORTFALL", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("KO", "55", "0.5"), held("NVDA", "180")], trades: [],
    });
    expect(pairs(out)).toEqual([["KO", "1.500000", "55.00", "main"]]);
  });

  test("and the day's return is then CORRECT rather than wrongly published", () => {
    // 2 KO @ $55 + 2 NVDA @ $180 = $470, flat prices, 1 KO sold => the true return is 0.
    const yesterday = [held("KO", "55"), held("NVDA", "180")];
    const today = [held("KO", "55", "1"), held("NVDA", "180")];
    const plan = buildInferredSells({ ...heldRun, positions: yesterday }, { positions: today, trades: [] });
    const r = computeDailyReturn(470, 470, today, yesterday, plan.sells);
    expect(r!.dailyReturn).toBeCloseTo(0, 10);      // was -11.7% before the fix
    expect(r!.impliedTransfer).toBeCloseTo(0, 6);   // was a phantom +$55
  });

  test("a partial sale the records ALREADY explain infers nothing", () => {
    // The agent sold 1 and recorded it. Nothing is missing, so nothing may be invented.
    const out = buildInferredSells(heldRun, {
      positions: [held("KO", "55", "1"), held("NVDA", "180")], trades: [sell("KO", "1")],
    });
    expect(out.sells).toEqual([]);
  });

  test("a PARTIALLY recorded sale infers only the remainder", () => {
    // The agent sold 0.5 and recorded it; the owner sold another 1 by hand. Keying on "is there a
    // sell on record" (the pre-fix test) would suppress the whole thing and lose the owner's share.
    const out = buildInferredSells(heldRun, {
      positions: [held("KO", "55", "0.5"), held("NVDA", "180")], trades: [sell("KO", "0.5")],
    });
    expect(pairs(out)).toEqual([["KO", "1.000000", "55.00", "main"]]);
  });

  test("float dust is not a trade", () => {
    const out = buildInferredSells(heldRun, {
      positions: [held("KO", "55", "1.9999999"), held("NVDA", "180")], trades: [],
    });
    expect(out.sells).toEqual([]);
  });

  test("duplicate position rows are SUMMED, not indexed", () => {
    // Taking the first row would under-count the holding and invent a sell for the difference.
    const dup = { ...heldRun, positions: [held("KO", "55", "1"), held("KO", "55", "1")] };
    const out = buildInferredSells(dup, { positions: [held("KO", "55", "2")], trades: [] });
    expect(out.sells).toEqual([]);
    // Must assert BOTH sides: indexing the first row under-counts the holding to 1, which makes the
    // discrepancy NEGATIVE and files it as unreconstructable rather than as a sell — so checking
    // only `sells` lets that mutation pass. It did, until this line.
    expect(out.unreconstructable).toEqual([]);
  });

  // ── the mirror case: shares that APPEARED ──
  test("an unexplained INCREASE is reported, never reconstructed as a buy", () => {
    // Inventing a buy would fabricate a cost basis and spend cash nothing accounted for.
    const out = buildInferredSells(heldRun, {
      positions: [held("KO", "55", "5"), held("NVDA", "180")], trades: [],
    });
    expect(out.sells).toEqual([]);
    expect(out.unreconstructable).toEqual([{ symbol: "KO", reason: "shares-appeared", excessQty: 3 }]);
  });

  test("a wholly NEW position with no buy on record is unreconstructable", () => {
    const out = buildInferredSells(heldRun, {
      positions: [...heldRun.positions, held("TSLA", "400", "1")], trades: [],
    });
    expect(out.unreconstructable).toEqual([{ symbol: "TSLA", reason: "shares-appeared", excessQty: 1 }]);
  });

  test("a new position WITH its buy recorded is fine", () => {
    const out = buildInferredSells(heldRun, {
      positions: [...heldRun.positions, held("TSLA", "400", "1")],
      trades: [{ symbol: "TSLA", side: "buy", quantity: "1", avgPrice: "400", state: "filled" }],
    });
    expect(out.sells).toEqual([]);
    expect(out.unreconstructable).toEqual([]);
  });

  test("IDEMPOTENT — re-deriving after a write converges on the same plan", () => {
    const today = [held("KO", "55", "0.5"), held("NVDA", "180")];
    const first = buildInferredSells(heldRun, { positions: today, trades: [] });
    // The caller strips prior inferred sells before re-deriving, which is what makes this hold.
    const second = buildInferredSells(heldRun, { positions: today, trades: first.sells });
    expect(pairs(second)).toEqual(pairs(first));
  });


  // ── cases the first mutation battery MISSED ───────────────────────────────
  test("the quantity is the broker's own 6-decimal format, not raw float noise", () => {
    // String(10 - 9.1) is "0.9000000000000004". That reached permanent trade records, the owner's
    // email (rendered unformatted) and the reviewer's prompt, and findReRecordedSells compares
    // quantity strings by exact equality, so a noisy one could never twin a real fill.
    const out = buildInferredSells(
      { positions: [held("KO", "55", "10")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "55", "9.1")], trades: [] });
    expect(out.sells[0].quantity).toBe("0.900000");
    expect(/e|\d{10,}/.test(out.sells[0].quantity)).toBe(false);
  });

  test("a FULL exit's quantity string is byte-identical to the broker's", () => {
    // The regression guard on the path that already worked: the old code wrote pos.quantity
    // verbatim, so any reformatting here would silently change every historical-shaped record.
    for (const q of ["1.743251", "0.561499", "2.000000", "13.482910"]) {
      const out = buildInferredSells(
        { positions: [held("KO", "55", q)], influencerPositions: [], trades: [] },
        { positions: [], trades: [] });
      expect(out.sells[0].quantity).toBe(q);
    }
  });

  test("the price comes from the HELD run even when the two runs disagree", () => {
    // Pins price PROVENANCE for the partial path. Every other test uses the same price in both
    // runs, so taking today's mark instead was indistinguishable — and since these sells are
    // overwhelmingly declines, that mutation biases proceeds down systematically.
    const out = buildInferredSells(
      { positions: [held("KO", "60", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "40", "0.5")], trades: [] });
    expect(out.sells[0].avgPrice).toBe("60.00");
  });

  test("the epsilon's MAGNITUDE is pinned, not merely its existence", () => {
    // Widening QTY_EPSILON 1000x shipped green: the dust test only proved *an* epsilon existed.
    // A 0.05-share sale of a $550 stock is ~$27 of real money and must be reconstructed.
    const out = buildInferredSells(
      { positions: [held("KO", "550", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "550", "1.95")], trades: [] });
    expect(out.sells.map(t => t.quantity)).toEqual(["0.050000"]);
  });

  test("NEGATIVE dust is not an unexplained arrival", () => {
    // The dust test only probed the positive side, so tightening the negative branch to `< 0` made
    // every run refuse every repair — and that mutation passed the whole suite.
    const out = buildInferredSells(
      { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "55", "2.00000001")], trades: [] });
    expect(out.unreconstructable).toEqual([]);
    expect(out.sells).toEqual([]);
  });

  // ── fail-closed on input we cannot read ───────────────────────────────────
  test("an UNREADABLE quantity withholds; it must never be read as zero", () => {
    // The fail-open trap CLAUDE.md names. Treating an unparseable count as 0 turns "we cannot read
    // the holding" into "the holding is gone" — measured, it fabricated a full exit of a position
    // that was still held.
    for (const bad of ["", "abc", "-1", "NaN"]) {
      const out = buildInferredSells(
        { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
        { positions: [held("KO", "55", bad)], trades: [] });
      expect(out.sells).toEqual([]);
      expect(out.unreconstructable).toEqual([{ symbol: "KO", reason: "unreadable-quantity" }]);
    }
  });

  test('a quantity of "0" is a real count, not unreadable', () => {
    // The control for the case above: 0 parses, and a zero row genuinely means the position left.
    const out = buildInferredSells(
      { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "55", "0")], trades: [] });
    expect(out.sells.map(t => t.quantity)).toEqual(["2.000000"]);
  });

  test("an unreadable TRADE quantity also withholds", () => {
    const out = buildInferredSells(
      { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
      { positions: [], trades: [{ symbol: "KO", side: "sell", quantity: "", avgPrice: "55", state: "filled" }] });
    expect(out.unreconstructable).toEqual([{ symbol: "KO", reason: "unreadable-quantity" }]);
  });

  test("a trade-only symbol is VISITED, and unpriceable rather than written as NaN", () => {
    // Two defects at once. Positions-only symbol enumeration never examined a recorded buy with no
    // position row, so the day booked the whole purchase as a loss while this said "nothing to do"
    // (~-10% on a $2,000 book — under the |return| > 30% alarm). And once visited, there is no held
    // row to price it from, which previously persisted avgPrice:"NaN".
    const out = buildInferredSells(
      { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "55", "2")],
        trades: [{ symbol: "TSLA", side: "buy", quantity: "2", avgPrice: "400", state: "filled" }] });
    expect(out.sells).toEqual([]);
    expect(out.unreconstructable).toEqual([{ symbol: "TSLA", reason: "no-usable-price", excessQty: 2 }]);
  });

  test("buys are counted in EVERY state, in step with computeDailyReturn", () => {
    // Pins a deliberate trade-off that nothing pinned before: counting only `filled` buys passed
    // the entire suite. The two must agree — if they disagree, the sell records and the day's
    // arithmetic describe different books. A recorded-but-unfilled buy therefore enlarges the
    // shortfall, which is the known cost of keeping them in step.
    const out = buildInferredSells(
      { positions: [held("KO", "55", "2")], influencerPositions: [], trades: [] },
      { positions: [held("KO", "55", "2")],
        trades: [{ symbol: "KO", side: "buy", quantity: "1", avgPrice: "54", state: "submitted" }] });
    expect(out.sells.map(t => t.quantity)).toEqual(["1.000000"]);
  });

  test("with duplicate rows, the PRICED one supplies the mark", () => {
    // Pins the `price > 0` row preference. Taking the first row regardless falls through to
    // avgCost, so a real mark sitting on the second row is discarded in favour of cost basis —
    // which on a loser overstates the proceeds and on a winner understates them.
    const dup = {
      positions: [held("KO", "0", "1", "41.5"), held("KO", "57", "1", "41.5")],
      influencerPositions: [], trades: [] as TradeSnapshot[],
    };
    const out = buildInferredSells(dup, { positions: [], trades: [] });
    expect(out.sells.map(t => [t.quantity, t.avgPrice])).toEqual([["2.000000", "57.00"]]);
  });

  test("CONTROL — nothing changed, nothing is invented", () => {
    // Without this the suite could pass by fabricating sells for everything.
    const out = buildInferredSells(heldRun, { positions: heldRun.positions, trades: [] });
    expect(out.sells).toEqual([]);
    expect(out.unreconstructable).toEqual([]);
  });
});
