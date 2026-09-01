// Extraction of the model's trailing TRADE_DECISION payload from its analysis prose.
//
// WHY THIS EXISTS (2026-09-01, live incident): the parser used to be a single strict regex,
// `/^TRADE_DECISION:(.+)$/m`. It requires the marker to start a line AND the JSON to sit on that
// same line. On 2026-09-01 the model emitted the marker markdown-bolded — `**TRADE_DECISION:**{...}`
// — after a run that decided three full exits (LLY, AMAT, GOOGL) and three buys. The regex missed
// it, `decision` stayed `{sells:[],buys:[]}`, and the whole run silently no-opped: no orders, no
// buySizingAdjustments note, no alert. The autopilot's OWN intent-vs-execution safety net (the check
// that exists precisely to catch "decided but not executed") used a second, near-identical regex
// `/TRADE_DECISION:(\{.*\})/` and was blinded by the exact same two asterisks, so the deterministic
// layer reported nothing either — only the LLM reviewer, reading the prose, noticed.
//
// The lesson is not "handle bold". It is that a pure-formatting variation in model output must never
// be able to silently cancel a run. So: ONE tolerant extractor, shared by every caller, that
// (a) ignores markdown emphasis / code fences / list markers around the marker, (b) brace-matches
// the JSON instead of assuming it is single-line, and (c) reports the difference between "the model
// never emitted a decision" (nothing to do) and "it emitted one we could not read" (a real bug that
// must be loud) — see DecisionParseOutcome below.

export interface TradeDecisionSell {
  symbol: string;
  exit?: string;
  fraction?: number;
  quantity?: number;
  strategy?: string;
}

export interface TradeDecisionBuy {
  symbol: string;
  dollarAmount: number;
  strategy?: string;
}

export interface TradeDecision {
  thesis: string;
  sells: TradeDecisionSell[];
  buys: TradeDecisionBuy[];
}

export type DecisionParseOutcome =
  /** A TRADE_DECISION payload was found and parsed. */
  | { status: "parsed"; decision: TradeDecision; raw: string }
  /**
   * No decision payload was emitted. Covers both "the marker never appears" and "the prose mentions
   * the marker but never follows it with a payload" — those are the same real-world event (the model
   * produced no decision), and neither is evidence of a bug, so neither escalates.
   */
  | { status: "absent" }
  /** A payload WAS emitted and could not be read. This is the loud case — a bug or a truncation. */
  | { status: "unparsed"; reason: string };

/**
 * Walks a balanced-brace JSON object starting at `start` (which must index a `{`), respecting
 * string literals and escapes so a `}` inside a thesis string doesn't end the object early.
 * Returns the exclusive end index, or -1 if the braces never balance.
 */
function matchBraces(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** A place in the text where a TRADE_DECISION marker is actually followed by a payload. */
interface PayloadSite {
  start: number;        // index of the opening `{`
  json: string | null;  // the balanced span, or null when the braces never close (truncated output)
}

/**
 * Every point where a TRADE_DECISION marker is followed by an opening brace.
 *
 * Tolerated between the word and the `{`: markdown emphasis (`**`, `*`, `_`), a colon, backticks
 * and ```json fences, and any whitespace including newlines (so a pretty-printed payload works).
 * Anything else means this occurrence is prose ("output the TRADE_DECISION line"), not a payload —
 * it yields no site, so prose mentioning the marker can never be mistaken for a broken decision.
 */
function payloadSites(text: string): PayloadSite[] {
  const out: PayloadSite[] = [];
  const marker = /TRADE_DECISION/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    // Only separators — never content — may sit between the marker and the payload.
    const gap = rest.match(/^[\s:*_`]*(?:json[\s]*)?[\s`]*/);
    const offset = gap ? gap[0].length : 0;
    if (rest[offset] !== "{") continue;
    const start = m.index + m[0].length + offset;
    const end = matchBraces(text, start);
    out.push({ start, json: end === -1 ? null : text.slice(start, end) });
  }
  return out;
}

function normalize(parsed: unknown): TradeDecision | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  // A payload must at least declare its trade arrays; an object with neither is not a decision.
  if (!Array.isArray(o.sells) && !Array.isArray(o.buys)) return null;
  return {
    thesis: typeof o.thesis === "string" ? o.thesis : "",
    sells: Array.isArray(o.sells) ? (o.sells as TradeDecisionSell[]) : [],
    buys: Array.isArray(o.buys) ? (o.buys as TradeDecisionBuy[]) : [],
  };
}

/**
 * Extracts the model's decision from its analysis output.
 *
 * Reads ONLY THE LAST payload site. The model sometimes sketches a draft payload mid-reasoning and
 * then emits the final one, so the last site is the decision it stands behind — and an earlier
 * draft is emphatically NOT a fallback for it. An earlier version of this function walked the sites
 * backwards and returned the first that parsed, which meant a FINAL payload truncated mid-JSON
 * (the analysis call is capped at max_tokens) would silently hand the DRAFT's buys and sells to the
 * executor as live orders — a wrong-trade bug strictly worse than the silent no-op this module was
 * written to prevent. Refusing to read past the last site turns that case into a loud `unparsed`.
 */
export function parseTradeDecision(analysisText: string): DecisionParseOutcome {
  if (!analysisText || !analysisText.includes("TRADE_DECISION")) return { status: "absent" };

  const sites = payloadSites(analysisText);
  // The marker appears only in prose (or not at all) — the model emitted no decision. Not a bug.
  if (sites.length === 0) return { status: "absent" };

  const last = sites[sites.length - 1];
  const suffix = sites.length > 1 ? ` (last of ${sites.length} payload sites)` : "";
  if (last.json === null) {
    return {
      status: "unparsed",
      reason: `final TRADE_DECISION payload never closes its braces — output likely truncated${suffix}`,
    };
  }
  try {
    const decision = normalize(JSON.parse(last.json));
    if (!decision) {
      return { status: "unparsed", reason: `final TRADE_DECISION payload has neither a sells nor a buys array${suffix}` };
    }
    return { status: "parsed", decision, raw: last.json };
  } catch (e) {
    return { status: "unparsed", reason: `${e instanceof Error ? e.message : String(e)}${suffix}` };
  }
}
