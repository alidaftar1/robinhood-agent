import { describe, expect, test } from "bun:test";
import { parseTradeDecision, isFullExit } from "../lib/trade-decision";

const PAYLOAD = '{"thesis":"t","sells":[{"symbol":"LLY","exit":"all"}],"buys":[{"symbol":"TER","dollarAmount":100,"strategy":"main"}]}';

describe("parseTradeDecision", () => {
  test("plain marker (the shape the prompt asks for)", () => {
    const r = parseTradeDecision(`reasoning...\n\nTRADE_DECISION:${PAYLOAD}`);
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") {
      expect(r.decision.sells.map(s => s.symbol)).toEqual(["LLY"]);
      expect(r.decision.buys[0].dollarAmount).toBe(100);
    }
  });

  // The 2026-09-01 live incident: three decided exits silently placed zero orders.
  test("markdown-bolded marker — the incident that motivated this module", () => {
    const r = parseTradeDecision(`Total: $216. ✓\n\n**TRADE_DECISION:**${PAYLOAD}`);
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") expect(r.decision.sells).toHaveLength(1);
  });

  test.each([
    ["bold outside the colon", `**TRADE_DECISION**: ${PAYLOAD}`],
    ["single asterisks", `*TRADE_DECISION:*${PAYLOAD}`],
    ["underscores", `_TRADE_DECISION:_${PAYLOAD}`],
    ["heading + list marker", `## TRADE_DECISION:\n${PAYLOAD}`],
    ["json code fence", "TRADE_DECISION:\n```json\n" + PAYLOAD + "\n```"],
    ["bare backticks", "TRADE_DECISION: `" + PAYLOAD + "`"],
    ["newline before payload", `TRADE_DECISION:\n\n${PAYLOAD}`],
    ["no colon at all", `TRADE_DECISION ${PAYLOAD}`],
  ])("tolerates %s", (_label, text) => {
    expect(parseTradeDecision(text).status).toBe("parsed");
  });

  test("multi-line pretty-printed payload (the old single-line regex could not)", () => {
    const pretty = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
    const r = parseTradeDecision(`TRADE_DECISION:\n${pretty}`);
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") expect(r.decision.buys[0].symbol).toBe("TER");
  });

  test("braces inside the thesis string do not truncate the object", () => {
    const tricky = '{"thesis":"sizing {a} and a quote \\" here","sells":[],"buys":[{"symbol":"X","dollarAmount":50}]}';
    const r = parseTradeDecision(`TRADE_DECISION:${tricky}`);
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") {
      expect(r.decision.buys).toHaveLength(1);
      expect(r.decision.thesis).toContain("{a}");
    }
  });

  test("takes the FINAL payload when the model sketches a draft first", () => {
    const draft = '{"thesis":"draft","sells":[],"buys":[{"symbol":"DRAFT","dollarAmount":50}]}';
    const r = parseTradeDecision(`TRADE_DECISION:${draft}\n\nOn reflection:\n\nTRADE_DECISION:${PAYLOAD}`);
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") expect(r.decision.buys[0].symbol).toBe("TER");
  });

  // A marker with no payload after it means the model emitted no decision — the same real-world
  // event as no marker at all. Reporting it as "unparsed" would fire an alert asserting a parser
  // bug on prose like "Output your thesis then the TRADE_DECISION line."
  test("prose mentioning the marker reads as absent, not as a bug", () => {
    expect(parseTradeDecision("Output your thesis then the TRADE_DECISION line.").status).toBe("absent");
    expect(parseTradeDecision("I will stand pat; no TRADE_DECISION needed today.").status).toBe("absent");
  });

  // The review finding this module's rewrite was driven by: the analysis call is capped at
  // max_tokens, so the FINAL payload can be truncated mid-JSON. Falling back to an earlier draft
  // would hand the draft's orders to the executor — a wrong-trade bug, worse than the no-op.
  test("a truncated FINAL payload never falls back to an earlier draft", () => {
    const draft = '{"thesis":"draft","sells":[],"buys":[{"symbol":"DRAFT","dollarAmount":50}]}';
    const r = parseTradeDecision(
      `TRADE_DECISION:${draft}\n\nOn reflection:\n\nTRADE_DECISION:{"thesis":"final","sells":[{"symbol":"REAL"`,
    );
    expect(r.status).toBe("unparsed");
    if (r.status === "unparsed") {
      expect(r.reason).toContain("truncated");
      expect(r.reason).toContain("2 payload sites");
    }
  });

  test("the reported reason describes the FINAL payload, not an earlier one", () => {
    const goodDraft = '{"thesis":"draft","sells":[],"buys":[]}';
    const r = parseTradeDecision(`TRADE_DECISION:${goodDraft}\n\nActually:\n\nTRADE_DECISION:{"sells":[,]}`);
    expect(r.status).toBe("unparsed");
    if (r.status === "unparsed") expect(r.reason).toContain("payload sites");
  });

  test("no marker at all reads as absent, not as a bug", () => {
    expect(parseTradeDecision("I considered the book and will stand pat today.").status).toBe("absent");
    expect(parseTradeDecision("").status).toBe("absent");
  });

  test("malformed JSON after the marker is unparsed (loud), never a silent no-op", () => {
    const r = parseTradeDecision('TRADE_DECISION:{"sells":[,],"buys":[}');
    expect(r.status).toBe("unparsed");
  });

  test("an object with neither sells nor buys is not a decision", () => {
    expect(parseTradeDecision('TRADE_DECISION:{"thesis":"only prose"}').status).toBe("unparsed");
  });

  test("a decision may be legitimately empty on both sides", () => {
    const r = parseTradeDecision('TRADE_DECISION:{"thesis":"stand pat","sells":[],"buys":[]}');
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") expect(r.decision.buys).toHaveLength(0);
  });

});

// A trim leaves the symbol held; a full exit does not. The autopilot's decided-vs-executed check
// flagged every trim as a dropped order until this distinction existed (TRGP, 2026-09-15).
describe("isFullExit", () => {
  test.each([
    ['{"symbol":"X","exit":"all"}', true],
    ['{"symbol":"X"}', true],
    ['{"symbol":"X","fraction":0.5}', false],
    ['{"symbol":"X","fraction":1}', true],   // executor REFUSES an invalid fraction -> nothing placed
    ['{"symbol":"X","fraction":0}', true],   // same
    ['{"symbol":"X","exit":"half"}', true],  // executor falls through to a FULL exit
    ['{"symbol":"X","quantity":2}', false],  // a trim without heldQty context
  ])("%s -> %s", (json, expected) => {
    expect(isFullExit(JSON.parse(json))).toBe(expected);
  });

  test("the real 2026-09-15 decision: ILMN is a full exit, TRGP is a trim", () => {
    const r = parseTradeDecision(
      'TRADE_DECISION:{"thesis":"t","sells":[{"symbol":"ILMN","exit":"all"},{"symbol":"TRGP","fraction":0.5}],"buys":[]}',
    );
    expect(r.status).toBe("parsed");
    if (r.status === "parsed") {
        // NOT `.filter(isFullExit)` — Array.filter passes the INDEX as the 2nd arg, which lands in
      // `heldQty` and silently changes the result. That exact slip shipped in app/api/trade and was
      // caught only in review; asserting the safe form here keeps the pattern visible.
      expect(r.decision.sells.filter(s => isFullExit(s)).map(s => s.symbol)).toEqual(["ILMN"]);
    }
  });
});

// isFullExit must mirror resolveSellQuantity exactly — a divergence silences the decided-vs-executed
// check for sells that either liquidate everything or place nothing at all.
describe("isFullExit mirrors the executor", () => {
  test("agrees with resolveSellQuantity on every intent shape", async () => {
    const { resolveSellQuantity } = await import("../lib/buy-sizing");
    const held = "2.000000";
    for (const intent of [
      { exit: "all" }, {}, { exit: "half" },
      { fraction: 0.5 }, { fraction: 1 }, { fraction: 0 }, { fraction: -1 },
      { quantity: 1 }, { quantity: 5 },
    ]) {
      const qty = resolveSellQuantity(intent as any, held);
      // Position is closed when the executor sells the whole lot, OR places nothing at all
      // (an unplaced order leaves it held, which the autopilot must still flag).
      const closes = qty === null || parseFloat(qty) >= parseFloat(held);
      expect({ intent, isFullExit: isFullExit(intent as any, parseFloat(held)) })
        .toEqual({ intent, isFullExit: closes });
    }
  });
});

describe("isFullExit is index-safe", () => {
  test("a bare .filter(isFullExit) reference would misclassify — the guarded form does not", () => {
    const sells = [{ symbol: "A", quantity: 3 }, { symbol: "B", quantity: 3 }] as any[];
    // Array.filter passes (value, index, array): at index 0 `quantity >= 0` is always true.
    const unsafe = sells.filter(isFullExit as any).map(s => s.symbol);
    const safe = sells.filter(s => isFullExit(s)).map(s => s.symbol);
    expect(unsafe).toContain("A");   // the footgun: a trim classified as a full exit
    expect(safe).toEqual([]);        // both are trims without a heldQty context
  });
});
