// ─────────────────────────────────────────────────────────────────────────────
// REPORT SELF-CONSISTENCY — does the morning report contradict itself?
//
// Four times between 2026-10-13 and 10-15 a report asserted two things that could not both be
// true, and three of the four reached the owner's inbox before anything noticed:
//
//   "Return WITHHELD … computed in the 8am capture"  vs  "permanent gap unless corrected"
//   autoFixed "Recorded 1 of your own fill(s): MRVL"  vs  issues "Uncaptured order: MRVL"
//   capture.reconciles: true                         vs  "MRVL: live 1.52 vs stored 1.11"
//   "No trades — possible analysis issue"            vs  a cap-drop note saying exactly why
//
// One class: a null or a flag with SEVERAL possible causes, narrated by a branch that assumes one,
// with the honest explanation sitting two lines away in the same output. Registry #40.
//
// The past-misses registry made the REVIEWER catch the fourth unprompted, which is real — but a
// model reading a prompt is detection after the fact, and the bad report had already been sent.
// These contradictions are deterministic and checkable, so they get a deterministic check. Same
// role lib/dashboard-reconcile plays for the presentation layer: an audit of what we are about to
// SAY, independent of the code that says it.
//
// SCOPE, deliberately narrow. Only pairs that are provably incompatible are listed. A general
// "do these sentences disagree?" check would need a model and would produce false positives, which
// is how a banner stops being read — the exact failure these entries are about.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportContradiction {
  /** Short stable id, so a recurrence is greppable. */
  id: string;
  /** What the report says, in the order it says it. */
  detail: string;
}

export interface ReportInput {
  /** buySizingAdjustments from the run. */
  notes: readonly string[];
  /** The autopilot's issues list. */
  issues: readonly string[];
  /** The autopilot's autoFixed list. */
  autoFixed: readonly string[];
  /** /api/verify discrepancies. */
  discrepancies?: readonly string[];
  /** capture.reconciles, when a capture ran. */
  captureReconciles?: boolean | null;
}

/** symbol + side + a rounded quantity — enough to say "the same fill", loose enough to survive the
 *  broker's 2dp rounding, which is what defeated an exact comparison in the capture code. */
const fillKeys = (text: string): Set<string> => {
  const out = new Set<string>();
  // "buy MRVL x0.000269" / "sell MRVL ×0.000269" / "buy MRVL 0.69"
  for (const m of text.matchAll(/\b(buy|sell)\s+([A-Z][A-Z0-9.]{0,5})\s*[x×]?\s*(\d+\.?\d*)/gi)) {
    const qty = parseFloat(m[3]);
    if (!Number.isFinite(qty)) continue;
    out.add(`${m[1].toLowerCase()}|${m[2].toUpperCase()}|${qty.toFixed(2)}`);
  }
  return out;
};

const GUARD_DROP = /\b(DROPPED|BLOCKED|REJECTED)\b|off-rails/;

export function findReportContradictions(input: ReportInput): ReportContradiction[] {
  const out: ReportContradiction[] = [];
  const notes = input.notes ?? [];
  const issues = input.issues ?? [];
  const autoFixed = input.autoFixed ?? [];
  const discrepancies = input.discrepancies ?? [];
  const has = (xs: readonly string[], re: RegExp) => xs.find(x => re.test(x));

  // 1. The 2026-10-15 instance. Withholding is SELF-HEALING (the 8am capture supplies the missing
  //    records); "permanent gap unless corrected" prescribes a manual repair for a state that
  //    repairs itself, and names the wrong cause while doing it.
  const withheld = has(notes, /Return WITHHELD/);
  const notComputed = has(notes, /DAILY RETURN NOT COMPUTED/);
  if (withheld && notComputed) {
    out.push({ id: "withheld-vs-uncomputable",
      detail: `The run says the return was WITHHELD and will be computed by the capture, and also that it is a permanent gap needing manual repair. Both cannot be true. — "${withheld.slice(0, 90)}…" / "${notComputed.slice(0, 90)}…"` });
  }

  // 2. The 2026-10-14 instance. Matched on symbol+side+quantity, never on the symbol alone —
  //    registry #1 is about exactly that join being made on vibes.
  const recorded = new Set<string>();
  for (const f of autoFixed) if (/Recorded \d+ of your own fill/.test(f)) for (const k of fillKeys(f)) recorded.add(k);
  for (const i of [...issues, ...discrepancies]) {
    if (!/Uncaptured order/.test(i)) continue;
    for (const k of fillKeys(i)) if (recorded.has(k)) {
      out.push({ id: "recorded-and-uncaptured", detail: `The same fill (${k.replace(/\|/g, " ")}) is reported as recorded in autoFixed and as uncaptured in issues.` });
    }
  }

  // 3. The other 2026-10-14 instance. `reconciles` means "the STORED records are self-consistent",
  //    and was read as "the book matches the broker". If live and stored disagree, saying the day
  //    reconciles — without that scope — is a claim the reader will take the wrong way.
  if (input.captureReconciles === true) {
    const liveVsStored = has(discrepancies, /quantity mismatch|not in stored run|not in Robinhood|Cash mismatch/);
    if (liveVsStored) {
      out.push({ id: "reconciles-vs-live-mismatch",
        detail: `capture reported reconciles=true while a live-vs-stored difference is open: "${liveVsStored.slice(0, 110)}…". If that is only about the stored records, say so.` });
    }
  }

  // 4. The 2026-10-13 instance. A guard that dropped every buy and said why EXPLAINS an empty
  //    trade list; calling it a possible analysis issue flips the banner on a healthy day.
  const noTrades = has(issues, /No trades executed but buying power/);
  if (noTrades) {
    const dropNote = has(notes, GUARD_DROP);
    if (dropNote) {
      out.push({ id: "no-trades-vs-explained",
        detail: `issues calls an empty trade list a possible analysis issue while the run records why it is empty: "${dropNote.slice(0, 110)}…".` });
    }
  }

  // 5. Not a pair, a SMELL, and it earned its place: "an unknown condition" shipped to the owner on
  //    2026-10-15 from a branch that had run out of hypotheses and guessed. If a report cannot name
  //    the cause it established, that is the defect, whatever it is describing.
  for (const t of [...notes, ...issues]) {
    if (/an unknown condition|unknown reason|something went wrong/i.test(t)) {
      out.push({ id: "unnamed-cause", detail: `A report line names no established cause: "${t.slice(0, 120)}…". Establish which branch produced the state, or do not describe it.` });
    }
  }
  return out;
}
