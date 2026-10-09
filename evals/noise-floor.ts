// ─────────────────────────────────────────────────────────────────────────────
// NOISE FLOOR — how much does a measurement move when NOTHING changes?
//
// Three identical runs of the LLM suite, same commit, no edits, produced 3 / 3 / 1 failures out of
// ~190 checks. So a 2-test "improvement" is the suite breathing. Accept one and you have recorded
// a false finding; keep accepting them and the harness is tuned to randomness, each step
// individually justified and the aggregate meaningless.
//
// This is the same rule lib/slippage already applies to execution cost — `significant: |mean| >
// 1.96 * se` — which is why slippage reports "noise" until ~20 fills instead of printing a number
// it cannot distinguish from zero. The eval layer had the measurement and not the rule.
//
// TWO DIFFERENT BOUNDS, and conflating them is the classic error:
//   · Judging ONE new run against a baseline → the spread of INDIVIDUAL runs (a prediction
//     interval, 1.96·sd). A single run is a draw from the distribution, not an estimate of it.
//   · Judging the MEAN of K new runs → the standard error (1.96·se), which shrinks with K.
// Using se where sd belongs declares victory on noise; it is the error that makes this whole
// exercise backfire, so both are computed and named separately.
// ─────────────────────────────────────────────────────────────────────────────

export interface FloorStats {
  runs: number;
  mean: number;
  /** Spread of individual runs. 0 for a genuinely deterministic suite. */
  sd: number;
  /** Uncertainty of the MEAN — sd / sqrt(n). */
  se: number;
  /** How far a SINGLE new run may land from the mean and still be noise (1.96·sd). */
  singleRunFloor: number;
  /** How far the MEAN of the same number of runs may land and still be noise (1.96·se). */
  meanFloor: number;
}

export function noiseFloor(results: number[]): FloorStats {
  const n = results.length;
  if (n === 0) return { runs: 0, mean: NaN, sd: NaN, se: NaN, singleRunFloor: NaN, meanFloor: NaN };
  const mean = results.reduce((a, b) => a + b, 0) / n;
  // SAMPLE sd (n-1). With n=1 the spread is unknown, NOT zero — reporting 0 would declare a
  // single run perfectly repeatable and make every later comparison "significant".
  const sd = n < 2 ? NaN : Math.sqrt(results.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { runs: n, mean, sd, se, singleRunFloor: 1.96 * sd, meanFloor: 1.96 * se };
}

export interface Verdict {
  distinguishable: boolean;
  delta: number;
  /** The bound the delta had to clear. */
  floor: number;
  reason: string;
}

/**
 * Is `candidate` distinguishable from `baseline`, or is the difference inside the noise?
 *
 * Fails CLOSED: an unknown floor (fewer than two baseline runs) returns NOT distinguishable. The
 * whole point is to stop a change being accepted on evidence that cannot support it, so missing
 * evidence must not read as a pass.
 */
export function compareToBaseline(baseline: number[], candidate: number[]): Verdict {
  const b = noiseFloor(baseline);
  const c = noiseFloor(candidate);
  const delta = c.mean - b.mean;

  if (!(baseline.length >= 2)) {
    return { distinguishable: false, delta, floor: NaN,
      reason: `baseline has ${baseline.length} run(s) — the floor is unknown, so nothing can be called significant. Re-run the baseline at least twice.` };
  }
  // Pooled over both samples; with K=1 candidate runs the single-run spread is the right bound.
  const floor = candidate.length < 2
    ? b.singleRunFloor
    : 1.96 * Math.sqrt(b.se ** 2 + c.se ** 2);
  const distinguishable = Math.abs(delta) > floor;
  return {
    distinguishable, delta, floor,
    reason: distinguishable
      ? `|${delta.toFixed(2)}| exceeds the ${floor.toFixed(2)} floor — a real change`
      : `|${delta.toFixed(2)}| is inside the ${floor.toFixed(2)} floor — indistinguishable from the measurement moving on its own`,
  };
}

/**
 * Runs needed per arm to resolve an effect of `effect` at this spread.
 *
 * Exists so "not distinguishable" comes with a price rather than a shrug: it is the difference
 * between "this did not work" and "we cannot afford to find out", and those lead to different
 * decisions. Same arithmetic as the ~43-years-to-significance figure on the trading side.
 */
export function runsNeeded(sd: number, effect: number): number {
  if (!(effect > 0) || !(sd >= 0)) return NaN;
  if (sd === 0) return 1;                       // deterministic: one run settles it
  return Math.ceil(2 * ((1.96 * sd) / effect) ** 2);
}
