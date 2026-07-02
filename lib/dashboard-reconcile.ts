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

  // 2. Influencer-slot squat: sleeve at capacity while holding an S&P name that likely now stands on
  //    a main thesis — silently blocks new influencer buys (the AAPL case the owner caught by hand).
  //    LOW by design: it persists day-after-day until a slot frees, so it's an FYI nudge and must
  //    NOT flip the email to "needs attention" daily (that would desensitize the owner).
  const infl = latest.influencerPositions ?? [];
  const sp500Infl = infl.filter(p => sp500.has(p.symbol));
  if (infl.length >= MAX_INFLUENCER && sp500Infl.length > 0) {
    findings.push({
      severity: "low",
      title: "Influencer sleeve at capacity holding an S&P name",
      detail: `${sp500Infl.map(p => p.symbol).join(", ")} occupy influencer slot(s) (sleeve ${infl.length}/${MAX_INFLUENCER}) but are S&P 500 names that may now stand on a main thesis. New influencer buys are blocked until a slot frees — consider reclassifying to main.`,
    });
  }

  return findings;
}
