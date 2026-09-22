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

export interface ConvictionRun {
  runDate: string;
  horizonMonths?: number[];
  capitalCommitted?: number;
  picks: ConvictionPick[];
}

/** Past this, the theses were written against a macro picture that has moved on. The paper run's
 *  own horizon is 3-6 months; treat the long end as the shelf life and say so rather than quietly
 *  serving stale conviction. */
export const CONVICTION_SHELF_LIFE_DAYS = 185;

export function daysSince(runDate: string, today: string): number | null {
  const a = Date.parse(runDate), b = Date.parse(today);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/** Render the block. `buyable` is the set of names the model may actually act on this run; picks
 *  outside it are still shown, but labelled, so the model is never nudged toward an off-rails buy
 *  it cannot make. Returns "" when there is nothing trustworthy to say. */
export function formatConviction(
  run: ConvictionRun | null,
  today: string,
  buyable: Set<string>,
): string {
  if (!run?.picks?.length) return "";
  const age = daysSince(run.runDate, today);
  if (age == null || age < 0) return "";                       // unparseable or future-dated: say nothing
  if (age > CONVICTION_SHELF_LIFE_DAYS) return "";             // past its own horizon: stop serving it

  const rows = run.picks
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map(p => {
      const on = buyable.has(p.symbol.toUpperCase());
      const tag = on ? "ON the shortlist — usable this run" : "NOT on the shortlist — cannot be bought";
      const parts = [`  ${p.symbol} (rank ${p.rank}, ${tag})`, `    thesis: ${p.thesis}`];
      if (p.knownWeakness) parts.push(`    known weakness: ${p.knownWeakness}`);
      if (p.falsifiers?.length) parts.push(`    would be WRONG if: ${p.falsifiers.join("; ")}`);
      return parts.join("\n");
    });

  const anyUsable = run.picks.some(p => buyable.has(p.symbol.toUpperCase()));
  return `

CONVICTION RESEARCH (hand-built fundamental theses, ${run.runDate}, ${age}d old):
These are NOT instructions and NOT a signal. They are one analyst's reasoning, recorded with its own
falsifiers and weaknesses so it can be argued with. Capital committed so far: ${run.capitalCommitted ?? 0}.
This research has NO track record — it is a paper run being scored forward against SPY, not a
validated edge. Weigh it as an opinion with reasons attached, not as evidence.
Appearing here grants a name NO eligibility: a buy for any name not on the quality-momentum
shortlist or influencer set is dropped in code. Use this ONLY to discriminate among names you can
already buy${anyUsable ? "" : " — and NONE of these names is buyable this run, so it is context only"}.
The falsifiers are the most useful part: if one has come true, that is a reason AGAINST the name,
and it outranks the thesis.
${rows.join("\n")}
`;
}

/** Load the recorded paper run. Returns null on anything unexpected — a research file edited into
 *  an unreadable shape must never take a trading run down with it.
 *
 *  STATIC import, not require(): a runtime require of a file outside the route's own tree is the
 *  shape that silently resolves in dev and returns nothing once Vercel bundles the function — the
 *  same class of bundling failure that defeated Sentry's auto-instrumentation here. The file only
 *  changes on deploy, so there is nothing to gain from reading it per request. */
export function loadConvictionRun(): ConvictionRun | null {
  try {
    const raw = convictionRunJson as Partial<ConvictionRun>;
    if (!raw || typeof raw.runDate !== "string" || !Array.isArray(raw.picks)) return null;
    const picks = raw.picks.filter(
      (p): p is ConvictionPick =>
        !!p && typeof p.symbol === "string" && typeof p.thesis === "string" && Number.isFinite(p.rank),
    );
    return picks.length ? { ...raw, runDate: raw.runDate, picks } : null;
  } catch {
    return null;
  }
}
