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
  /** No TRADE_DECISION marker anywhere — the model produced prose only. */
  | { status: "absent" }
  /** The marker IS present but no candidate parsed into a usable decision. This is the loud case. */
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

/**
 * Every `{...}` that follows a TRADE_DECISION marker, in the order they appear.
 *
 * Tolerated between the word and the `{`: markdown emphasis (`**`, `*`, `_`), a colon, backticks
 * and ```json fences, and any whitespace including newlines (so a pretty-printed payload works).
 * Anything else means this occurrence is prose ("output the TRADE_DECISION line"), not a payload.
 */
function decisionCandidates(text: string): string[] {
  const out: string[] = [];
  const marker = /TRADE_DECISION/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    // Only separators — never content — may sit between the marker and the payload.
    const gap = rest.match(/^[\s:*_`]*(?:json[\s]*)?[\s`]*/);
    const offset = gap ? gap[0].length : 0;
    if (rest[offset] !== "{") continue;
    const absoluteStart = m.index + m[0].length + offset;
    const end = matchBraces(text, absoluteStart);
    if (end === -1) continue;
    out.push(text.slice(absoluteStart, end));
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
 * Takes the LAST parseable candidate: the model sometimes sketches a draft payload mid-reasoning
 * and then emits the final one, and the final word is the decision it stands behind.
 */
export function parseTradeDecision(analysisText: string): DecisionParseOutcome {
  if (!analysisText || !analysisText.includes("TRADE_DECISION")) return { status: "absent" };

  const candidates = decisionCandidates(analysisText);
  if (candidates.length === 0) {
    return {
      status: "unparsed",
      reason: "TRADE_DECISION marker present but no JSON object follows it",
    };
  }

  let lastError = "";
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const decision = normalize(JSON.parse(candidates[i]));
      if (decision) return { status: "parsed", decision, raw: candidates[i] };
      lastError = "parsed JSON has neither a sells nor a buys array";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { status: "unparsed", reason: lastError || "no candidate parsed" };
}

/** Convenience for read-only consumers (reviewers, audits) that just want the decision or nothing. */
export function extractTradeDecision(analysisText: string): TradeDecision | null {
  const outcome = parseTradeDecision(analysisText);
  return outcome.status === "parsed" ? outcome.decision : null;
}
