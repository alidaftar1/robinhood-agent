// ─────────────────────────────────────────────────────────────────────────────
// CONVICTION RESEARCH — hand-built fundamental theses, exposed to the analysis
// model as a DISCRIMINATOR, never as an instruction.
//
// What this is: a dated, falsifiable research run (docs/conviction-paper-run.json)
// naming a handful of S&P names with a thesis, evidence read out of primary
// filings, explicit falsifiers, and a stated weakness.
//
// What it is NOT, and the code enforces this rather than trusting the prose:
// appearing here confers NO eligibility. A buy for a name that is not on the
// quality-momentum shortlist or in the influencer signal set is DROPPED in code
// (see the off-rails filter in /api/trade), so this block cannot originate a
// position. Its only reachable effect is to inform a choice among names that
// are ALREADY buyable — the same role the valuation block plays.
//
// Why it is worth showing at all: the shortlist is built from price behaviour
// (12-1 momentum) and accounting ratios (ROE/ROA/leverage). Neither reads a
// filing. Where a shortlisted name also has a thesis here, the model gets the
// falsifiers and the known weakness — the two things most likely to be missing
// from a purely quantitative view, and the two most likely to argue AGAINST a
// name rather than for it.
// ─────────────────────────────────────────────────────────────────────────────

import convictionRunJson from "@/docs/conviction-paper-run.json";

export interface ConvictionPick {
  rank: number;
  symbol: string;
  entry: number;
  beta?: number;
  thesis: string;
  verifiedFromFilings?: string;
  falsifiers?: string[];
  knownWeakness?: string;
  thesisRevised?: string;
}

export interface RejectedThesis { thesis: string; why: string }

/** The macro picture BOTH halves of the research were reasoned from. Free-form on purpose — the
 *  fields change as the regime does, and a fixed schema would quietly drop whatever was added. */
export type MacroSnapshot = Record<string, unknown>;

export interface ConvictionRun {
  runDate: string;
  horizonMonths?: number[];
  capitalCommitted?: number;
  picks: ConvictionPick[];
  /** Themes the SAME research run examined and argued AGAINST. Not an afterthought: these are the
   *  half that can only ever REDUCE buying, and the half the ranking most needs. */
  rejectedTheses?: RejectedThesis[];
  macroAsOf?: MacroSnapshot;
  spyEntry?: number;
}

/** Past this, the theses were written against a macro picture that has moved on. The paper run's
 *  own horizon is 3-6 months; treat the long end as the shelf life and say so rather than quietly
 *  serving stale conviction. */
export const CONVICTION_SHELF_LIFE_DAYS = 185;

/** Per-field cap. These strings reach a live-money system prompt verbatim, and the file is editable
 *  by anything that can open a PR. A bound is not injection DEFENCE — it is a blast radius. */
const MAX_FIELD = 400;
const MAX_FALSIFIERS = 6;
/** Bound the block itself, not just each field. Per-field caps do nothing against a 50-pick file. */
const MAX_PICKS = 8;
const MAX_REJECTED = 8;
const MAX_MACRO_ROWS = 12;
/** Macro ages far faster than a company thesis. "The Fed hiked last week" is useful; the same
 *  sentence five months on is a false present tense. Picks outlive it — they have a 3-6 month
 *  horizon — so the macro block drops out on its own while the theses stay. */
export const MACRO_SHELF_LIFE_DAYS = 45;

/** Flatten to a single prompt-safe line: no newlines (so a field cannot fake a section break or a
 *  role marker), no backticks, bounded length. */
function safeText(raw: unknown, max = MAX_FIELD): string {
  const flat = String(raw ?? "").replace(/[\r\n\u2028\u2029`]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…[truncated]` : flat;
}

export function daysSince(runDate: string, today: string): number | null {
  const a = Date.parse(runDate), b = Date.parse(today);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/** What a pick's membership actually means for THIS run. Deliberately more conservative than the
 *  off-rails filter: that filter is not the last gate, and a label that over-promises is the
 *  dangerous direction — it invites a buy the model will watch get dropped. */
export interface ConvictionContext {
  /** The main-book buy allowlist (v1ShortlistSet). Excludes ◆HELD retained names ON PURPOSE. */
  mainShortlist: Set<string>;
  /** Off-shortlist names the sleeve may buy, ALREADY filtered to those clearing the net-score
   *  floor — a name below it is hard-rejected in code, so listing it as buyable over-promises. */
  influencerCandidates: Set<string>;
  /** Main-book buys only run in the weekly rebalance window — 2 of 5 weekdays. */
  isRebalanceDay: boolean;
}

const hasSym = (set: Set<string>, sym: string) => set.has(sym) || set.has(sym.toUpperCase());

/** Render the block. Returns "" when there is nothing trustworthy to say. */
export function formatConviction(
  run: ConvictionRun | null,
  today: string,
  ctx: ConvictionContext,
): string {
  if (!run?.picks?.length) return "";
  const age = daysSince(run.runDate, today);
  if (age == null || age < 0) return "";                       // unparseable or future-dated: say nothing
  if (age > CONVICTION_SHELF_LIFE_DAYS) return "";             // past its own horizon: stop serving it

  const statusOf = (sym: string): { tag: string; usable: boolean } => {
    if (hasSym(ctx.mainShortlist, sym)) {
      return ctx.isRebalanceDay
        // Honest about the one gate not modelled here: a name sold or stopped inside the cooldown
        // window is blocked in code unless a post-exit catalyst exists, which this block cannot supply.
        ? { tag: "on the main shortlist — buyable this run if it also clears the re-buy cooldown", usable: true }
        // The off-rails filter would pass it, but the cadence gate drops EVERY main-book buy
        // outside the window. Labelling it "usable" contradicts the BUY: CLOSED line in the same
        // prompt, on 3 of 5 weekdays.
        : { tag: "on the main shortlist, but main-book buys are CLOSED today (weekly rebalance window)", usable: false };
    }
    if (hasSym(ctx.influencerCandidates, sym)) {
      // Clearing the floor still leaves the slot cap, downtrend screen, and re-buy cooldown, all
      // of which reject in code — so name them rather than saying "the sleeve caps".
      return { tag: "in the influencer set — still subject to the sleeve slot cap, the downtrend screen and the re-buy cooldown", usable: true };
    }
    // Deliberately NOT "not on the shortlist": that is the literal wording of a SELL condition in
    // the strategy prompt, and the buy allowlist excludes ◆HELD retained names, so a name you hold
    // can land here while the shortlist table shows it ◆HELD. Sells have NO code filter behind
    // them, so this phrasing is the one most likely to cause real harm.
    return { tag: "not on THIS RUN'S BUYABLE LIST — note a name you hold can be ◆HELD and still not buyable; that is not a signal to sell", usable: false };
  };

  const picks = run.picks.slice().sort((a, b) => a.rank - b.rank).slice(0, MAX_PICKS);
  const rows = picks.map(p => {
    const { tag } = statusOf(p.symbol);
    const parts = [`  ${safeText(p.symbol, 12)} (rank ${p.rank}, ${tag})`, `    thesis: ${safeText(p.thesis)}`];
    if (p.knownWeakness) parts.push(`    known weakness: ${safeText(p.knownWeakness)}`);
    if (Array.isArray(p.falsifiers) && p.falsifiers.length) {
      parts.push(`    would be WRONG if: ${p.falsifiers.slice(0, MAX_FALSIFIERS).map(f => safeText(f, 200)).join("; ")}`);
    }
    return parts.join("\n");
  });

  const anyUsable = picks.some(p => statusOf(p.symbol).usable);
  const omitted = run.picks.length > picks.length ? ` (${run.picks.length - picks.length} further picks not shown)` : "";
  return `

CONVICTION RESEARCH (hand-built fundamental theses, ${run.runDate}, ${age}d old)${omitted}:
These are NOT instructions and NOT a signal. They are one analyst's reasoning, recorded with its own
falsifiers and weaknesses so it can be argued with.${Number.isFinite(run.capitalCommitted as number) ? ` Capital committed so far: ${run.capitalCommitted}.` : ""}
This research has NO track record — it is a paper run being scored forward against SPY, not a
validated edge. Weigh it as an opinion with reasons attached, not as evidence.
Appearing here grants a name NO eligibility: a buy for any name not on the quality-momentum
shortlist or influencer set is dropped in code. Use this ONLY to discriminate among names you can
already buy${anyUsable ? "" : " — and NONE of these names is buyable this run, so it is context only"}.
The falsifiers are the most useful part: if one has come true, that is a reason AGAINST BUYING the
name, and it outranks the thesis.
NEW BUYS ONLY, and nothing else. The code's off-rails filter guards BUYS — every other use of this
block has no check behind it but your own judgement, so treat each of these as closed:
 · Never sell, trim, or exit a holding because of anything here. A thesis recorded here is not a
   thesis the portfolio holds, and a falsifier firing is not a thesis break in your position.
 · Nothing here counts as "a fresh catalyst ON THAT NAME", "a confirmed reversal", or "specific
   evidence its own thesis is intact" for the LOSS-DISCIPLINE keep-exception, nor as a valid
   exception for either TIME-STOP, main or sleeve, numbered or not. Those require a named LIVE signal — ★INS, ⚡↑,
   ⚡NEWS↑, ↑RECOVERING, or fresh momentum rank — not a thesis written weeks ago. Unvalidated
   research must never be what keeps a losing or dead-money position alive.
 · Nothing here is "a SPECIFIC reason the breakdown no longer applies" for re-entering a recently
   STOPPED name. That also requires a live signal; the rails would allow such a buy, so this one is
   on you.
 · This block does NOT make a name "a clearly higher-conviction NEW name" for freeing a ◆HELD
   slot, and does NOT make a holding "high-conviction" for riding it through earnings. Those rules
   key on the same word this block uses; the word here means "an analyst argued for it", not
   "the evidence is strong".
${formatMacro(run.macroAsOf, run.runDate, age)}
PICKS — names argued FOR (the constraints above govern these):
${rows.join("\n")}${formatRejected(run.rejectedTheses, ctx.isRebalanceDay)}
`;
}

/** The macro backdrop both halves were reasoned from. Shown so the model can judge the reasoning
 *  rather than just the conclusions — and so it can notice when the world has moved. */
function formatMacro(macro: MacroSnapshot | undefined, runDate: string, age: number): string {
  if (!macro || typeof macro !== "object" || Array.isArray(macro)) return "";
  if (age > MACRO_SHELF_LIFE_DAYS) return "";
  // Only string/number values: the type is deliberately open so new regime fields survive, but an
  // object or array would stringify to "[object Object]" in a live-money prompt. And an EMPTY value
  // must drop the whole row — "brent:" with nothing after it is a bare assertion, not data.
  const all = Object.entries(macro);
  const entries = all.filter(([k, v]) =>
    safeText(k, 32) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && safeText(v, 260));
  const rows = entries.slice(0, MAX_MACRO_ROWS).map(([k, v]) => `  ${safeText(k, 32)}: ${safeText(v, 260)}`);
  if (!rows.length) return "";
  // Count BOTH kinds of loss — over the cap, and filtered for an unrenderable value. The type is
  // deliberately open so new regime fields survive; a field vanishing with no trace defeats that.
  const dropped = all.length - rows.length;
  const omitted = dropped > 0 ? ` (+${dropped} more not shown)` : "";
  return `
MACRO AS OF ${runDate} (${age}d ago — a SNAPSHOT that was already ${age}d stale when you read it)${omitted}:
This is the backdrop both the picks and the rejections were reasoned from, here so you can judge the
REASONING and not only the conclusions. You have NO live feed for most of these numbers and no way
to check them — so treat every line as possibly superseded, and do not lean on any of them as a
current fact. Where a line overlaps something you CAN see in today's data, today's data wins.
This is NOT a de-risking instruction. A hawkish rate path or a thin risk premium is context for
choosing AMONG the buys you were going to make; it is not a reason to raise cash, hedge, sit out
the rebalance, or trim the book. Nor is it a reason to SIZE THEM SMALLER — conviction goes into
size here, so systematically undersizing on a macro read is the same portfolio-level de-risk by
another route, and it ends the rebalance in cash just as surely. This does NOT touch name-specific
risk sizing: sizing down or skipping an ⚠EARN name, or any other per-name risk rule, is correct and
unaffected — what is ruled out is shrinking the whole book because of a macro view. This strategy has no cash or
hedge action — de-risking happens through the per-name stops, and nothing here overrides that.
${rows.join("\n")}
`;
}

/** The half of the research that argues AGAINST buying something.
 *
 *  Worth more than the picks here, and shipped later than it should have been. The shortlist sorts
 *  by 12-month momentum, so a sector that has already run is exactly what floats to the TOP of the
 *  buy list — which is the moment a "this has already happened" argument is most useful and least
 *  likely to be reached by any other input the model gets. Momentum cannot tell a durable trend
 *  from a spike that already peaked; that is what this is for. */
function formatRejected(rejected: RejectedThesis[] | undefined, isRebalanceDay: boolean): string {
  if (!Array.isArray(rejected) || !rejected.length) return "";
  const valid = rejected.filter(r => r && typeof r.thesis === "string" && typeof r.why === "string");
  const rows = valid.slice(0, MAX_REJECTED).map(r => `  AGAINST ${safeText(r.thesis, 120)} — ${safeText(r.why, 300)}`);
  if (!rows.length) return "";
  // Say what was dropped. This half's whole purpose is to REDUCE buying, so a silent cap is the
  // fail-open direction for it — the picks half already reports its own omissions.
  const omitted = valid.length > rows.length ? ` (${valid.length - rows.length} further rejections not shown)` : "";
  return `

ARGUED AGAINST by the same research run — themes examined and REJECTED${omitted}:
Read these the same way as the picks: an opinion with reasons, no track record. They matter most
where the shortlist and this list disagree, which is the normal case, not a conflict to explain
away — a name ranks on 12-month momentum, and "it has already run" is a reason the ranking cannot
express. Treat a rejection as a reason to PREFER ANOTHER shortlist name when choosing what to BUY.
It is never a reason to sell or trim something you hold, and specifically it is NOT:
  · a bearish ⚡NEWS↓ material event — this is a months-old thematic view, not news on a name;
  · a "sector-cap trim" — that is mechanical, computed from position sizes, not from an opinion;
  · evidence a name has "FALLEN OFF the shortlist" — that is momentum and quality eligibility,
    also computed;
  · evidence that a ⚠CONCEN holding's "thesis has WEAKENED" — when you must reduce an over-cap
    position, nothing here may push you from a TRIM to a FULL exit. Code trims to the cap; a full
    exit is yours alone, and nothing here may cause one;
${isRebalanceDay ? `  · evidence that a holding is "the weakest holding" when freeing a slot. That trigger needs BOTH
    a higher-conviction new name AND a weakest holding — this block supplies NEITHER half.
` : ""}
If you hold a name in a rejected theme, this block changes nothing about that position.
A rejection MAY argue against a PICK above whose thesis leans on the same theme — the falsifiers are
where to look. That is a BUY-side comparison only: it can move a name down your buy ranking, and it
is never a reason to sell or trim one you already hold, including a pick that is itself a holding.
${rows.join("\n")}`;
}

/** One-line audit trail of what research the model was actually shown. */
export function convictionAuditNote(run: ConvictionRun | null, today: string, ctx: ConvictionContext): string | null {
  const rendered = run ? formatConviction(run, today, ctx) : "";
  if (!run || !rendered) return null;
  // Same sort-then-slice as the renderer: slicing the RAW order would let the note name a
  // different set of picks than the model actually saw.
  const shown = run.picks.slice().sort((a, b) => a.rank - b.rank).slice(0, MAX_PICKS);
  const age = daysSince(run.runDate, today);
  const rejected = Array.isArray(run.rejectedTheses) ? run.rejectedTheses.length : 0;
  // Record the WHOLE block, not just the picks — the rejections and the macro are most of it, and
  // the macro's day-46 expiry would otherwise change the prompt with no trace in any stored run.
  // Derived from the ACTUAL render, not re-guessed: formatMacro also returns "" for an array, a
  // snapshot whose values are all non-scalar, or one that is entirely empty — each of which
  // previously logged "macro shown" while the prompt carried no macro at all.
  const macroState = rendered.includes("MACRO AS OF") ? "macro shown"
    : !run.macroAsOf ? "no macro"
    : (age != null && age > MACRO_SHELF_LIFE_DAYS) ? "macro DROPPED (past its 45d shelf life)"
    : "macro present but not rendered (no usable rows)";
  return `CONTEXT — conviction research shown to the model: ${run.runDate} (${age}d old), picks ${shown.map(p => safeText(p.symbol, 12)).join(", ")}; ${rejected} rejected theme(s); ${macroState}. Advisory only; it confers no eligibility and every buy still passed the code gates. It CAN influence which of the already-eligible names was chosen and at what size — that is its purpose, so treat a buy citing it as conviction-driven.`;
}

/** Load the recorded paper run. Returns null on anything unexpected — a research file edited into
 *  an unreadable shape must never take a trading run down with it.
 *
 *  STATIC import, not require(): a runtime require of a file outside the route's own tree resolves
 *  in dev and can silently return nothing once Vercel bundles the function — the same class of
 *  bundling failure that defeated Sentry's auto-instrumentation in this repo. The file only changes
 *  on deploy, so there is nothing to gain from reading it per request. */
export function loadConvictionRun(): ConvictionRun | null {
  try {
    const raw = convictionRunJson as Partial<ConvictionRun>;
    if (!raw || typeof raw.runDate !== "string" || !Array.isArray(raw.picks)) return null;
    const picks = raw.picks
      .filter((p): p is ConvictionPick =>
        !!p && typeof p.symbol === "string" && typeof p.thesis === "string" && Number.isFinite(p.rank))
      // Normalise the shapes the renderer trusts, so ONE malformed field degrades to "drop that
      // field" rather than throwing and silently dropping the entire block.
      .map(p => ({ ...p, falsifiers: Array.isArray(p.falsifiers) ? p.falsifiers.filter(f => typeof f === "string") : undefined }));
    if (!picks.length) return null;
    const rejectedTheses = Array.isArray(raw.rejectedTheses)
      ? raw.rejectedTheses.filter((r): r is RejectedThesis =>
          !!r && typeof r.thesis === "string" && typeof r.why === "string")
      : undefined;
    // capitalCommitted reaches the prompt: keep it a number or drop it. Everything else the
    // renderer touches goes through safeText.
    const capitalCommitted = Number.isFinite(raw.capitalCommitted as number) ? (raw.capitalCommitted as number) : 0;
    return { ...raw, runDate: raw.runDate, capitalCommitted, picks, rejectedTheses };
  } catch {
    return null;
  }
}
