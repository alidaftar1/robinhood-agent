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

// ── the repair must fix the SLEEVE split too ─────────────────────────────────
// patchTrades recomputed only the whole-account return, so computeSleeveReturns still ran against
// the unrepaired trade list: the sold position vanished from the main book with no offsetting sell
// and its ENTIRE value booked as a phantom loss for that sleeve. Live on 2026-10-06 that stored
// mainDailyReturn -27.65% beside a correct whole-account +1.12% — the whole-account figure divides
// by TOTAL value including the cash the sale produced, so it absorbed what the sleeve could not —
// and it compounded into the dashboard's headline Main Book Return as -30.90%. Nothing clamped it
// (SLEEVE_EXTREME_RETURN is 50%) and no reviewer check covers it.
import { computeSleeveReturns, clampSleeveReturn } from "../lib/run-store";

describe("inferred sells repair the sleeve returns, not just the headline", () => {
  const p = (symbol: string, quantity: string, price: string): PositionSnapshot =>
    ({ symbol, quantity, avgCost: price, price } as PositionSnapshot);
  // Yesterday: main KO (2 x $55 = $110) + APA (4 x $50 = $200) + sleeve NVDA (2 x $180).
  // Today KO is gone, sold by hand. APA survives on purpose: selling the ONLY main position empties
  // the sleeve, and computeSleeveReturns nulls a sleeve whose book collapses (the rebuilt-from-cash
  // guard), which would mask the bug instead of exposing it. Prices are flat, so the true main
  // return is 0 and anything else is an artifact.
  const prevPositions = [p("KO", "2", "55"), p("APA", "4", "50"), p("NVDA", "2", "180")];
  const prevInfluencer = [p("NVDA", "2", "180")];
  const positions = [p("APA", "4", "50"), p("NVDA", "2", "180")];
  const influencer = [p("NVDA", "2", "180")];

  test("WITHOUT the inferred sell the main sleeve books a phantom total loss", () => {
    // Characterises the bug, so the fix below is measured against a real baseline.
    const raw = computeSleeveReturns(positions, [], influencer, prevInfluencer, prevPositions);
    // KO's $110 against a $310 main book = -35.5%, on a day the main book did not move at all.
    expect(raw.mainDailyReturn!).toBeCloseTo(-110 / 310, 6);
  });

  test("WITH it the main sleeve is flat, and the clamp is NOT what saves us", () => {
    const { sells } = buildInferredSells(
      { positions: prevPositions, influencerPositions: prevInfluencer, trades: [] },
      { positions, trades: [] });
    expect(sells.map(t => [t.symbol, t.strategy])).toEqual([["KO", "main"]]);
    const raw = computeSleeveReturns(positions, sells, influencer, prevInfluencer, prevPositions);
    expect(raw.mainDailyReturn).toBeCloseTo(0, 6);
    // The phantom was -27.65% live — well inside the 50% clamp, which is why it reached the
    // dashboard. Pinning this stops anyone concluding the clamp covers this class of bug.
    expect(clampSleeveReturn(-0.2765)).toBe(-0.2765);
  });

  test("the influencer sleeve is untouched by a MAIN-book repair", () => {
    const { sells } = buildInferredSells(
      { positions: prevPositions, influencerPositions: prevInfluencer, trades: [] },
      { positions, trades: [] });
    const raw = computeSleeveReturns(positions, sells, influencer, prevInfluencer, prevPositions);
    expect(raw.influencerDailyReturn).toBeCloseTo(0, 6);
  });
});

// ── an exit day is a real day ────────────────────────────────────────────────
// computeSleeveReturns used to require positions TODAY, which deleted every day a sleeve was fully
// closed out. A 2-name sleeve empties precisely when its positions are stopped out at -5%, knocked
// out by the drop-check, or exited on bad news — loss days by construction — so the holding days
// kept their gains while the exits that paid for them vanished. Over the 30 stored runs the
// influencer sleeve read +2.87% with those days dropped and -6.79% with them counted.
describe("computeSleeveReturns — a fully-closed sleeve still has a return", () => {
  const p = (symbol: string, quantity: string, price: string): PositionSnapshot =>
    ({ symbol, quantity, avgCost: price, price } as PositionSnapshot);
  const sell = (symbol: string, quantity: string, avgPrice: string): TradeSnapshot =>
    ({ symbol, side: "sell", quantity, avgPrice, state: "filled" });
  // Yesterday the sleeve held CRM 2 @ $100. Today it is empty: stopped out at $90, a REAL -10% day.
  const prevPositions = [p("CRM", "2", "100"), p("APA", "4", "50")];
  const prevInfluencer = [p("CRM", "2", "100")];

  test("the stop-out day is COUNTED, not discarded", () => {
    const r = computeSleeveReturns(
      [p("APA", "4", "50")], [sell("CRM", "2", "90")], [], prevInfluencer, prevPositions);
    expect(r.influencerDailyReturn).not.toBeNull();
    expect(r.influencerDailyReturn!).toBeCloseTo(-0.10, 6);   // (180 - 200) / 200
  });

  test("the MAIN book gets the same treatment — one rule, both sleeves", () => {
    const r = computeSleeveReturns(
      [p("CRM", "2", "100")], [sell("APA", "4", "45")],
      [p("CRM", "2", "100")], prevInfluencer, prevPositions);
    expect(r.mainDailyReturn!).toBeCloseTo(-0.10, 6);         // (180 - 200) / 200
  });

  test("a sleeve empty on BOTH days is still null — that is a zero denominator", () => {
    const r = computeSleeveReturns([p("APA", "4", "50")], [], [], [], [p("APA", "4", "50")]);
    expect(r.influencerDailyReturn).toBeNull();
  });

  test("an exit with NO sell on record reads ~-100% and the clamp nulls it", () => {
    // The backstop: counting exit days must not turn an unrecorded sale into a published -100%.
    const r = computeSleeveReturns([p("APA", "4", "50")], [], [], prevInfluencer, prevPositions);
    expect(clampSleeveReturn(r.influencerDailyReturn)).toBeNull();
  });

  test("a sleeve REBUILT from cash is still null — the tiny-denominator guard", () => {
    // Pre-existing and load-bearing, and nothing covered it. 2026-07-09 liquidated the main book to
    // ~$33.60 and 07-10 rebuilt it to ~$2,038 from settled cash; a sub-dollar real P&L over a $33.60
    // base amplified into a phantom -2.05%, which compounded the dashboard's Main Book Return from
    // -4.25% to -6.22%. A prior book under 10% of today's is a rebuild, not a day's performance.
    const yst = [p("APA", "1", "33.60")];
    const today = [p("APA", "1", "33.60"), p("MRK", "20", "100")];
    const r = computeSleeveReturns(today, [], [], [], yst);
    expect(r.mainDailyReturn).toBeNull();
  });

  test("but a LIQUIDATION is not a rebuild — the guard is directional", () => {
    // The mirror of the case above, and the reason the guard compares yesterday to TODAY rather
    // than taking an absolute floor: shrinking to nothing must still produce a number.
    const yst = [p("APA", "1", "33.60"), p("MRK", "20", "100")];
    const r = computeSleeveReturns([], [sell("APA", "1", "33.60"), sell("MRK", "20", "100")], [], [], yst);
    expect(r.mainDailyReturn!).toBeCloseTo(0, 6);
  });

  test("CONTROL — an ordinary holding day is unaffected", () => {
    const r = computeSleeveReturns(
      [p("CRM", "2", "110"), p("APA", "4", "50")], [],
      [p("CRM", "2", "110")], prevInfluencer, prevPositions);
    expect(r.influencerDailyReturn!).toBeCloseTo(0.10, 6);
  });
});

// ── planCapture: the owner's own trades become real records ──────────────────
// /api/verify has detected the owner's manual fills every day and nothing ever wrote them down, so
// patchTrades estimated the sells at the previous mark ($5.07 of permanent error across KO and NEM
// on 2026-10-05) and REFUSED on the buys, withholding the day's return entirely.
import { planCapture, type LiveOrder } from "../lib/run-store";

describe("planCapture", () => {
  const pos = (symbol: string, quantity: string, price: string): PositionSnapshot =>
    ({ symbol, quantity, avgCost: price, price } as PositionSnapshot);
  const order = (side: string, symbol: string, quantity: string, avgPrice: string, over: Partial<LiveOrder> = {}): LiveOrder =>
    ({ side, symbol, quantity, avgPrice, state: "filled", createdAt: "2026-10-06", ...over });
  const held = {
    positions: [pos("KO", "0.637741", "85.86"), pos("APA", "11.787693", "43.52")],
    influencerPositions: [] as PositionSnapshot[], trades: [] as TradeSnapshot[],
  };
  const T = { from: "2026-10-05", to: "2026-10-06" };

  test("the QUANTITY comes from positions, the PRICE from the broker", () => {
    // The whole design. The broker's reader rounds to 2dp, so KO came back as both "0.64" and
    // "0.637741"; trusting it would leave the book 0.0023 out — 20x QTY_EPSILON — forever.
    const latest = { positions: [pos("APA", "11.787693", "43.52")], trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "KO", "0.64", "86.4219")], T);
    expect(p.record.map(t => [t.symbol, t.quantity, t.avgPrice, t.state])).toEqual([
      ["KO", "0.637741", "86.42", "filled"],   // exact quantity, real price, real state
    ]);
    expect(p.reconciles).toBe(true);
  });

  test("an unrecorded BUY is recorded instead of refused", () => {
    // patchTrades can only refuse this: inventing a buy fabricates a cost basis. A filled buy order
    // IS the cost basis, so the refusal becomes a recording.
    const latest = { positions: [pos("KO", "0.637741", "85.86"), pos("APA", "11.787693", "43.52"), pos("HWM", "0.5", "227.80")],
                     trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("buy", "HWM", "0.50", "227.80")], T);
    expect(p.record.map(t => [t.side, t.symbol, t.quantity, t.avgPrice])).toEqual([["buy", "HWM", "0.500000", "227.80"]]);
    expect(p.residual).toEqual([]);
    expect(p.reconciles).toBe(true);
  });

  test("a PARTIAL sale is captured at the exact shortfall", () => {
    const latest = { positions: [pos("KO", "0.637741", "85.86"), pos("APA", "6", "43.52")], trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "APA", "5.79", "44.14")], T);
    expect(p.record.map(t => [t.symbol, t.quantity, t.avgPrice])).toEqual([["APA", "5.787693", "44.14"]]);
  });

  test("a real fill SUPERSEDES the estimate patchTrades already wrote", () => {
    const latest = {
      positions: [pos("APA", "11.787693", "43.52")],
      trades: [{ symbol: "KO", side: "sell", quantity: "0.637741", avgPrice: "85.86", state: "inferred", strategy: "main" as const }],
    };
    const p = planCapture(held, latest, [order("sell", "KO", "0.637741", "86.4219")], T);
    expect(p.supersede.map(t => t.state)).toEqual(["inferred"]);
    expect(p.record[0].avgPrice).toBe("86.42");
  });

  test("NOTHING is invented — an order that matches no position change is ignored", () => {
    // The safety property. This can only PRICE a change the book already shows.
    const latest = { positions: held.positions, trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "TSLA", "3", "400")], T);
    expect(p.record).toEqual([]);
    expect(p.reconciles).toBe(true);
  });

  test("an order whose quantity is nowhere near the shortfall is not evidence of it", () => {
    const latest = { positions: [pos("KO", "0.637741", "85.86"), pos("APA", "6", "43.52")], trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "APA", "1.0", "44.14")], T);  // 1.0 vs 5.79
    expect(p.record).toEqual([]);
    expect(p.reconciles).toBe(false);  // still unexplained — must not read as clean
  });

  test("a fill from the PREVIOUS day is in the window, not stale", () => {
    // The lag is structural: a run snapshots at 07:30, so a trade made during 2026-10-06 is only
    // visible in 10-07's positions and is reconciled then. Filtering to the calendar day rejected
    // exactly the orders being reconciled — this is the case that caught it live.
    const latest = { positions: [pos("APA", "11.787693", "43.52")], trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "KO", "0.637741", "86.4219", { createdAt: "2026-10-05" })],
                          { from: "2026-10-05", to: "2026-10-06" });
    expect(p.record.map(t => [t.symbol, t.avgPrice])).toEqual([["KO", "86.42"]]);
  });

  test("only FILLED orders INSIDE the window count", () => {
    const latest = { positions: [pos("APA", "11.787693", "43.52")], trades: [] as TradeSnapshot[] };
    for (const bad of [order("sell", "KO", "0.64", "86.42", { state: "cancelled" }),
                       order("sell", "KO", "0.64", "86.42", { createdAt: "2026-09-30" })]) {  // before the window
      expect(planCapture(held, latest, [bad], T).record).toEqual([]);
    }
  });

  test("reconciles is FALSE when something is still unexplained after writing", () => {
    // Writing something must not make the day read as clean. Here the KO sell is captured but an
    // unexplained HWM arrival remains.
    const latest = { positions: [pos("APA", "11.787693", "43.52"), pos("HWM", "0.5", "227.80")], trades: [] as TradeSnapshot[] };
    const p = planCapture(held, latest, [order("sell", "KO", "0.637741", "86.4219")], T);
    expect(p.record.length).toBe(1);
    expect(p.reconciles).toBe(false);
    expect(p.residual.map(r => [r.symbol, r.reason])).toEqual([["HWM", "shares-appeared"]]);
  });

  test("IDEMPOTENT — a second pass records nothing", () => {
    const latest = { positions: [pos("APA", "11.787693", "43.52")], trades: [] as TradeSnapshot[] };
    const first = planCapture(held, latest, [order("sell", "KO", "0.637741", "86.4219")], T);
    const after = { positions: latest.positions, trades: [...latest.trades, ...first.record] };
    const second = planCapture(held, after, [order("sell", "KO", "0.637741", "86.4219")], T);
    expect(second.record).toEqual([]);
    expect(second.reconciles).toBe(true);
  });

});
