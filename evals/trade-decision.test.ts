import { describe, expect, test } from "bun:test";
import { parseTradeDecision, extractTradeDecision } from "../lib/trade-decision";

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

  test("prose mentioning the marker is not a payload", () => {
    // The user turn literally says "Output your thesis then the TRADE_DECISION line."
    expect(parseTradeDecision("Output your thesis then the TRADE_DECISION line.").status).toBe("unparsed");
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

  test("extractTradeDecision returns null for both failure modes", () => {
    expect(extractTradeDecision("nothing here")).toBeNull();
    expect(extractTradeDecision("TRADE_DECISION:{oops")).toBeNull();
  });
});
