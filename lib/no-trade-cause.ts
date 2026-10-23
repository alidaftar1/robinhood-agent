/** Why was today's trade list empty while settled cash sat on hand?
 *
 *  Three outcomes, and the ORDER they are tested in is the guard:
 *
 *   · "data-failure" — at least one buy was withheld because an INPUT OF OURS could NOT be
 *     established: an earnings date, a sector, or a momentum reading. Those gates fail CLOSED, so a
 *     dead Finnhub key, a spent quota, a missing sector row or a run of timeouts drops EVERY buy and
 *     writes a DROPPED note for each one. Tested FIRST,
 *     because the generic rule below would otherwise read those notes as "guards working" and log
 *     them away — making the day the data source dies the day the report goes quiet.
 *   · "explained" — a guard dropped the buys on purpose (cap, budget, off-rails, cooldown) and said
 *     so. The analysis produced buys; the code refused them. "Possible analysis issue" is false.
 *   · "unexplained" — no note accounts for it. This is the real anomaly.
 *
 *  Case-SENSITIVE on the verbs, and GUARD_DROP below is the single definition: lib/buy-sizing also
 *  emits lowercase prose SPECULATING that a buy "may be rejected", about a buy that was not dropped.
 */
export type NoTradeCause = "data-failure" | "explained" | "unexplained";

/** A note recording a DELIBERATE guard drop, as opposed to a failure. Exported because the
 *  autopilot's per-SYMBOL check asks the same question of one note that classifyNoTradeState asks
 *  of the whole list, and two copies of this pattern would drift — the case rules above are exactly
 *  the kind lost in a re-type. Callers that need it per symbol must still match the symbol with a
 *  boundary, so a note about AAPL cannot explain away a dropped buy of ticker L. */
export const GUARD_DROP = /\b(DROPPED|BLOCKED|REJECTED)\b|off-rails/;
/** The "we could not establish an input" wording, in any gate that fails closed. It is always a
 *  SEPARATE sentence from the one asserting a real condition, precisely so the two can be told apart
 *  here: one asserts a fact about the company, this asserts a broken input of ours.
 *
 *  WIDENED 2026-10-22 from the earnings-date wording alone to the general "could NOT establish"
 *  form, because three gates now share the shape and only one was recognised: the earnings date, the
 *  sector budget ("could NOT establish its sector", lib/buy-sizing) and the sleeve momentum reading
 *  ("could NOT establish a momentum/trend reading", app/api/trade). The other two matched GUARD_DROP
 *  instead, so an outage in either read as "a guard did its job" — the exact outcome the ordering in
 *  this file exists to prevent, and the reason a 2026-10-22 sleeve drop was reported as a sector
 *  concentration decision when the real cause was that the name was off-index with no data at all.
 *
 *  It moves affected days from "explained" to "data-failure", which SURFACES them in the report
 *  rather than logging them away — the fail-safe direction for a diagnostic. But it DID re-claim
 *  something: the autopilot's message went on telling the reader every data-failure was a missing
 *  earnings date and to check FINNHUB_API_KEY (also dispatching the paid cloud fixer at Finnhub) for
 *  what could be a Yahoo momentum outage or a missing sector row. So the DECISION (this predicate)
 *  and the CLAIM (unestablishedInputOf below, which names the input and its source) are now
 *  separate — widening one cannot widen the other. */
const UNESTABLISHED = /could NOT establish|could not be parsed/;

/** WHICH input could not be established, read from one data-failure note. The claim half of the
 *  split above: changing when a day counts as a data failure cannot change what it is blamed on.
 *  An unrecognised wording maps to "unrecognised input", never to a guess — a new gate must not
 *  inherit another gate's diagnosis. Order matters: the sector-BUDGET note also says "sector". */
export type UnestablishedInput =
  "earnings date" | "portfolio total value" | "sector" | "momentum reading" | "unrecognised input";
export function unestablishedInputOf(note: string): UnestablishedInput {
  if (/earnings date/.test(note)) return "earnings date";
  if (/sector budget \(total value unreadable\)/.test(note)) return "portfolio total value";
  if (/establish its sector/.test(note)) return "sector";
  if (/momentum\/trend reading/.test(note)) return "momentum reading";
  return "unrecognised input";
}

const INPUT_SOURCE: Record<UnestablishedInput, string> = {
  "earnings date": "Finnhub key/quota/timeouts — check FINNHUB_API_KEY and the earnings lookup",
  "portfolio total value": "the account total-value read — check the Robinhood portfolio snapshot for this run",
  "sector": "our sector data has no row for the name — check the sector lookup, not the market",
  "momentum reading": "the Yahoo price/momentum fetch (fetchMomentum, lib/market-data) failed or returned nothing",
  "unrecognised input": "a fail-closed gate whose wording lib/no-trade-cause does not recognise — read the run's buySizingAdjustments",
};

/** The human/cloud-fixer message for a data-failure day. Names every failed input with its own
 *  source, so the reader is sent to the system that actually broke. */
export function dataFailureMessage(cash: number, r: { unestablished: number; inputs: readonly UnestablishedInput[] }): string {
  const what = r.inputs.map(i => `${i} (${INPUT_SOURCE[i]})`).join("; ");
  return `No trades executed with $${cash.toFixed(2)} on hand, and ${r.unestablished} buy(s) were withheld because an input could NOT be established: ${what}. That is a DATA failure, not a strategy decision.`;
}

export function classifyNoTradeState(notes: readonly string[]): {
  cause: NoTradeCause;
  unestablished: number;
  /** Distinct failed inputs, in first-seen order. Empty unless cause is "data-failure". */
  inputs: UnestablishedInput[];
  note?: string;
} {
  const unestablished = notes.filter(n => UNESTABLISHED.test(n));
  if (unestablished.length > 0) {
    const inputs = [...new Set(unestablished.map(unestablishedInputOf))];
    return { cause: "data-failure", unestablished: unestablished.length, inputs, note: unestablished[0] };
  }
  const note = notes.find(n => GUARD_DROP.test(n));
  return note
    ? { cause: "explained", unestablished: 0, inputs: [], note }
    : { cause: "unexplained", unestablished: 0, inputs: [] };
}
