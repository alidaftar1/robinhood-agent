/** Why was today's trade list empty while settled cash sat on hand?
 *
 *  Three outcomes, and the ORDER they are tested in is the guard:
 *
 *   · "data-failure" — at least one buy was withheld because an earnings date could NOT be
 *     established. The imminent-earnings gate fails CLOSED, so a dead Finnhub key, a spent quota or
 *     a run of timeouts drops EVERY buy and writes a DROPPED note for each one. Tested FIRST,
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
/** The earnings gate's unknown-branch wording. It is a SEPARATE sentence from the imminent one
 *  precisely so the two can be told apart here: one asserts a print, this asserts a broken input. */
const UNESTABLISHED = /could NOT establish an earnings date|could not be parsed/;

export function classifyNoTradeState(notes: readonly string[]): {
  cause: NoTradeCause;
  unestablished: number;
  note?: string;
} {
  const unestablished = notes.filter(n => UNESTABLISHED.test(n));
  if (unestablished.length > 0) {
    return { cause: "data-failure", unestablished: unestablished.length, note: unestablished[0] };
  }
  const note = notes.find(n => GUARD_DROP.test(n));
  return note
    ? { cause: "explained", unestablished: 0, note }
    : { cause: "unexplained", unestablished: 0 };
}
