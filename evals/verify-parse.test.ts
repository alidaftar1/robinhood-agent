import { describe, expect, test } from "bun:test";
import { extractJsonArray } from "@/lib/trade-decision";

// This parser decides a MONEY question: its return value distinguishes "the broker confirms these
// fills" from "we could not verify" — and the latter means record nothing, retry nothing, reconcile
// by hand. A parse bug in either direction is expensive.
describe("extractJsonArray", () => {
  const M = "VERIFIED_BUYS:";

  test("parses the normal single-line form", () => {
    expect(extractJsonArray(`${M}[{"symbol":"NVDA","quantity":"2"}]`, M))
      .toEqual([{ symbol: "NVDA", quantity: "2" }]);
  });

  test("tolerates the model pretty-printing across lines", () => {
    expect(extractJsonArray(`${M}[\n  {"symbol":"NVDA"},\n  {"symbol":"SPCX"}\n]`, M))
      .toEqual([{ symbol: "NVDA" }, { symbol: "SPCX" }]);
  });

  test("TRAILING PROSE does not destroy a successful verification", () => {
    // The greedy /\[[\s\S]*\]/ ran to the LAST "]", swallowing this sentence and throwing — which
    // under the new semantics downgrades a clean verification to "unknown broker state".
    expect(extractJsonArray(`${M}[{"symbol":"NVDA"}]\nAll 2 orders confirmed [2 of 2].`, M))
      .toEqual([{ symbol: "NVDA" }]);
  });

  test("a genuinely empty result is an empty array, NOT null", () => {
    // Critical distinction: [] means "verified, nothing filled"; null means "could not verify".
    expect(extractJsonArray(`${M}[]`, M)).toEqual([]);
  });

  test("brackets inside string values do not end the array early", () => {
    expect(extractJsonArray(`${M}[{"symbol":"NVDA","state":"filled [partial]"}]`, M))
      .toEqual([{ symbol: "NVDA", state: "filled [partial]" }]);
  });

  test("an escaped quote does not break string tracking", () => {
    expect(extractJsonArray(`${M}[{"note":"say \\"hi\\" ]"}]`, M)).toEqual([{ note: 'say "hi" ]' }]);
  });

  test("nested arrays are spanned, not truncated", () => {
    expect(extractJsonArray(`${M}[{"legs":[1,2]}]`, M)).toEqual([{ legs: [1, 2] }]);
  });

  test("returns null when it genuinely cannot parse", () => {
    expect(extractJsonArray("no marker here", M)).toBeNull();          // marker absent
    expect(extractJsonArray(`${M} pending...`, M)).toBeNull();          // no array
    expect(extractJsonArray(`${M}[{"symbol":`, M)).toBeNull();          // unterminated
    expect(extractJsonArray(`${M}[{"symbol" "NVDA"}]`, M)).toBeNull();  // malformed JSON
    expect(extractJsonArray(`${M}{"symbol":"NVDA"}`, M)).toBeNull();    // object, not array
  });

  test("ignores an earlier unrelated bracket before the marker", () => {
    expect(extractJsonArray(`[ignore me]\n${M}[{"symbol":"NVDA"}]`, M)).toEqual([{ symbol: "NVDA" }]);
  });

  test("a TEMPLATE restated mid-line cannot hijack the parse", () => {
    // The executor's own system prompt contains this template, so the model echoing it is routine.
    // An unanchored indexOf returned the placeholder row -> every real fill looked unconfirmed ->
    // the whole decided list was re-placed against a broker that had already filled it.
    const txt = `Format: ${M}[{"symbol":"XX","quantity":"X"}]\nResult:\n${M}[{"symbol":"NVDA","quantity":"3"}]`;
    expect(extractJsonArray(txt, M)).toEqual([{ symbol: "NVDA", quantity: "3" }]);
  });

  test("a mid-line template echo is ignored; the anchored answer wins", () => {
    expect(extractJsonArray(`I will output ${M}[...] as required.\n${M}[{"symbol":"NVDA"}]`, M))
      .toEqual([{ symbol: "NVDA" }]);
  });

  test("a TRUNCATED final line yields null — it must NOT fall back to an earlier marker", () => {
    // verifyBuys caps the model at 512 tokens, so a cut-off final line is routine. Falling back
    // to a preamble template echo returns the placeholder row, which reads as "nothing filled"
    // and re-places the entire decided list against a broker that already filled it.
    const txt = `${M}[{"symbol":"XX","quantity":"X"}]\n${M}[{"symbol":"NVDA","quantity":"3","avgPri`;
    expect(extractJsonArray(txt, M)).toBeNull();
  });

  test("a final marker with no array yields null, not an earlier marker's array", () => {
    expect(extractJsonArray(`${M}[{"symbol":"XX"}]\n${M} could not read orders`, M)).toBeNull();
  });

  test("an array further down the text is NOT adopted as the payload", () => {
    // The payload must belong to this marker; an unbounded scan returned unrelated arrays.
    expect(extractJsonArray(`${M}\nnothing filled today\nids: [{"symbol":"AAPL","quantity":"9"}]`, M)).toBeNull();
    expect(extractJsonArray(`${M} none\nVERIFIED_SELLS:[{"symbol":"TSLA"}]`, M)).toBeNull();
  });

  test("a stray bracket in the payload yields null, never a wrong array", () => {
    // Payload DOES start with `[`, so this exercises the bracket scan rather than the `[` check.
    expect(extractJsonArray(`${M}[a1b2 -> [{"symbol":"NVDA"}]`, M)).toBeNull();
    expect(extractJsonArray(`${M} order id [a1b2 filled -> [{"symbol":"NVDA"}]`, M)).toBeNull();
  });

  test("a newline between the marker and its array is tolerated", () => {
    // Both callers advertise tolerance for the model pretty-printing across lines.
    expect(extractJsonArray(`${M}\n[{"symbol":"NVDA"}]`, M)).toEqual([{ symbol: "NVDA" }]);
  });

  test("a leading BOM does not defeat line anchoring", () => {
    expect(extractJsonArray(`\uFEFF${M}[{"symbol":"NVDA"}]`, M)).toEqual([{ symbol: "NVDA" }]);
  });

  test("CRLF line endings still anchor", () => {
    expect(extractJsonArray(`preamble\r\n${M}[{"symbol":"NVDA"}]`, M)).toEqual([{ symbol: "NVDA" }]);
  });

  test("leading spaces/tabs before the array are tolerated", () => {
    expect(extractJsonArray(`${M} \t [{"symbol":"NVDA"}]`, M)).toEqual([{ symbol: "NVDA" }]);
  });

  test("a mid-line marker alone yields null, matching the old anchored regex", () => {
    expect(extractJsonArray(`see ${M}[{"symbol":"NVDA"}] above`, M)).toBeNull();
  });

  test("TWO anchored marker lines are ambiguous — null, never a guess", () => {
    // Picking a side cannot be made safe: the winner is a template echo in one direction and the
    // real answer in the other, and a wrong array re-places orders the broker already filled.
    expect(extractJsonArray(`${M}[]\n${M}[{"symbol":"NVDA"}]`, M)).toBeNull();
    expect(extractJsonArray(`${M}[{"symbol":"NVDA"}]\n${M}[]`, M)).toBeNull();
    expect(extractJsonArray(`${M}[{"symbol":"NVDA"}]\n\nFormat used:\n${M}[{"symbol":"XX"}]`, M)).toBeNull();
  });

  test("a single empty array is a genuine 'nothing filled', not unknown state", () => {
    expect(extractJsonArray(`${M}[]`, M)).toEqual([]);
  });

  test("the prompt TEMPLATE is unparseable, so any echo of it yields null", () => {
    // Root cause of three separate duplicate-order findings: the template used to be valid JSON
    // ({"symbol":"XX",...}), so a model echoing its own instructions was indistinguishable from an
    // answer. Angle-bracket placeholders cannot parse, so every echo degrades to unknown state.
    const TPL = `${M}[{"symbol":<TICKER>,"quantity":<QTY>,"avgPrice":<PRICE>,"state":<STATE>}]`;
    expect(extractJsonArray(TPL, M)).toBeNull();                                   // echo only
    expect(extractJsonArray(`I will output:\n${TPL}`, M)).toBeNull();
    expect(extractJsonArray(`${TPL}\nResult: ${M}[{"symbol":"NVDA"}]`, M)).toBeNull();  // mid-line answer
    expect(extractJsonArray(`${TPL}\n${M}[{"symbol":"NVDA"}]`, M)).toBeNull();          // two anchored
    // A clean answer is unaffected.
    expect(extractJsonArray(`${M}[{"symbol":"NVDA","quantity":"3"}]`, M)).toEqual([{ symbol: "NVDA", quantity: "3" }]);
  });
});
