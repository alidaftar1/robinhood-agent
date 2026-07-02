import { mergeRunsByDate, type TradeRun } from "./run-store";
import { SP500_UNIVERSE } from "./strategy";

// Deterministic audit of the DASHBOARD's derived state — the one layer no other reviewer looks
// at (code-review sees diffs, the skeptical reviewer sees the trade run, evals see decision
// logic). Scoped deliberately to checks that are ROBUST (no false positives) — a reviewer that
// cries wolf gets ignored. Sleeve-return *artifacts* are handled upstream (computeSleeveReturns +
// the backfill) rather than detected here by recompute, which was too false-positive-prone (a
// recompute can't reliably match how each stored value's prev-day baseline was selected/clamped).

export interface ReconcileFinding {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

const MAX_INFLUENCER = 2; // mirror the trade route's hard cap
const sp500 = new Set(SP500_UNIVERSE);

export function reconcileDashboard(runsNewestFirst: TradeRun[]): ReconcileFinding[] {
  const merged = mergeRunsByDate(runsNewestFirst); // one canonical run per date, newest-first
  const findings: ReconcileFinding[] = [];
  const latest = merged[0];
  if (!latest) return findings;

  // 1. Every influencer-tagged position must actually be held. A stale sleeve entry (a name that
  //    left the account but is still in influencerPositions) inflates the influencer sleeve's value
  //    AND return with a phantom holding. influencerPositions is written as a subset of positions,
  //    so any divergence is a genuine inconsistency, not noise.
  const heldSyms = new Set((latest.positions ?? []).map(p => p.symbol));
  const orphan = (latest.influencerPositions ?? []).filter(p => !heldSyms.has(p.symbol));
  if (orphan.length > 0) {
    findings.push({
      severity: "medium",
      title: "Influencer position not in the account",
      detail: `${orphan.map(p => p.symbol).join(", ")} tagged influencer but not in current holdings — stale sleeve membership inflates the influencer value/return.`,
    });
  }

  // 2. Influencer sleeve at capacity with dual-nature (S&P) holdings. An S&P name shows up in BOTH
  //    the momentum table and the influencer sleeve, so it's easy to misread which bucket it's in.
  //    Flag it NEUTRALLY: a full sleeve blocks new influencer buys, but that's often the cap correctly
  //    holding a winner (e.g. AAPL entered on an influencer signal while DOWN 7% on 5d — a name main
  //    would never have bought — then rallied; its gain is a real influencer win, NOT a "main" name to
  //    reclassify). Do NOT prescribe reclassifying — that would mis-credit the main book. LOW by design
  //    (persists daily until a slot frees, so it must not flip the email to "needs attention").
  const infl = latest.influencerPositions ?? [];
  const sp500Infl = infl.filter(p => sp500.has(p.symbol));
  if (infl.length >= MAX_INFLUENCER && sp500Infl.length > 0) {
    findings.push({
      severity: "low",
      title: "Influencer sleeve at capacity holding an S&P name",
      detail: `${sp500Infl.map(p => p.symbol).join(", ")} fill influencer slot(s) (sleeve ${infl.length}/${MAX_INFLUENCER}) — S&P names, so they appear in both the momentum table and the sleeve. No new influencer pick can be bought until a slot frees. Often fine (the cap holding a winner) — only worth acting on if it's blocking a stronger signal.`,
    });
  }

  return findings;
}
