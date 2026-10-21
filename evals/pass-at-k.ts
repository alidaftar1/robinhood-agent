// ─────────────────────────────────────────────────────────────────────────────
// PASS@K for sampled assertions.
//
// Across five scheduled eval runs (2026-10-13 .. 10-21) exactly ONE of six
// distinct failures was a real regression. Four of the other five were the same
// shape: "the execution model should acknowledge X in its reasoning" —
// analyst-upgrade and insider-signal are literally the same assertion on
// different signals, and both flake. insider-signal re-ran 2/3 pass; the
// PORTFOLIO_SNAPSHOT one re-ran 3/3 pass.
//
// A prose assertion against a sampled model is a BERNOULLI TRIAL, not a
// pass/fail. Scoring one draw as a verdict is a category error, and the cost is
// not cosmetic: a suite that is red most mornings for a different reason each
// time stops being read, which is the exact failure three of this week's
// incidents were about.
//
// WHAT THIS IS NOT. It is not a way to make a failing test green. A genuine
// regression fails every attempt and still goes red on the first run of K. What
// it absorbs is the single unlucky draw.
//
// EARLY EXIT on the first success, so a healthy suite costs exactly what it
// costs today and only a flake pays for retries. The attempts used are
// reported, which is the part that matters more than the verdict: a test
// drifting from 1-of-1 to 3-of-3 is degrading long before it goes red, and a
// binary pass could never show that.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttemptLog {
  label: string;
  attempts: number;
  passed: boolean;
  /** Why each failed attempt failed, in order — so a flake and a real break read differently. */
  failures: string[];
}

/** Collected across a run so the suite can print how hard each sampled test had to work. */
export const attemptLog: AttemptLog[] = [];

/**
 * Run `attempt` until it succeeds or `k` tries are exhausted. `attempt` should THROW on failure,
 * which is what an expect() does — so a test body can be passed in unchanged.
 */
export async function passAtK(label: string, k: number, attempt: () => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (let i = 1; i <= k; i++) {
    try {
      await attempt();
      attemptLog.push({ label, attempts: i, passed: true, failures });
      if (i > 1) console.log(`  ⟳ ${label}: passed on attempt ${i}/${k} (sampled assertion — see pass-at-k)`);
      return;
    } catch (e) {
      failures.push(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }
  attemptLog.push({ label, attempts: k, passed: false, failures });
  // Every attempt failed. That is not a flake — surface all of them, because K identical messages
  // say "broken" while K different ones say something stranger is going on.
  throw new Error(
    `${label}: failed all ${k} attempts — not a sampled flake.\n` +
    failures.map((f, i) => `  attempt ${i + 1}: ${f}`).join("\n"),
  );
}

/** One line per sampled test, for the CI summary. Sorted worst-first: the ones needing the most
 *  attempts are the ones drifting toward a real failure. */
export function formatAttemptLog(log: AttemptLog[] = attemptLog): string {
  if (log.length === 0) return "";
  const rows = [...log].sort((a, b) => b.attempts - a.attempts || Number(a.passed) - Number(b.passed));
  return ["sampled assertions (attempts used — a rising number is a test degrading before it goes red):",
    ...rows.map(r => `  ${r.passed ? "✓" : "✗"} ${r.attempts} attempt(s)  ${r.label}`)].join("\n");
}
