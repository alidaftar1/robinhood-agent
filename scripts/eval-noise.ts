/**
 * MEASURE a suite's noise floor by running it repeatedly with nothing changed.
 *
 *   bun scripts/eval-noise.ts --suite fast --runs 3
 *   bun scripts/eval-noise.ts --suite llm  --runs 3     # ~55 min per run
 *
 * The floor is not a constant to hardcode — it is a property of the suite as it stands today, and
 * it moves when tests are added or a model changes. Re-measure rather than trusting a number
 * written down last month.
 *
 * "test:fast is deterministic" is a CLAIM. This is how it gets checked: if a suite advertised as
 * reproducible has a non-zero floor, that is a finding in itself — a flaky test hiding in the gate
 * that blocks deploys.
 */
import { $ } from "bun";
import { noiseFloor, runsNeeded } from "../evals/noise-floor";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const suite = arg("suite", "fast");
const runs = parseInt(arg("runs", "3"), 10);
const root = new URL("..", import.meta.url).pathname;

const cmd = suite === "llm"
  ? ["bun", "test", "evals/eval.test.ts", "evals/reviewer-recall.test.ts", "--timeout", "180000"]
  : ["bash", `${root}scripts/test-fast.sh`];

console.log(`measuring the ${suite} suite over ${runs} identical runs (nothing changes between them)\n`);
const failures: number[] = [];
for (let i = 1; i <= runs; i++) {
  const t0 = Date.now();
  const res = await $`${cmd}`.cwd(root).nothrow().quiet();
  const out = res.stdout.toString() + res.stderr.toString();
  // bun prints a summary line; absence of it means the run did not complete, which must NOT be
  // silently counted as zero failures.
  const m = out.match(/^\s*(\d+)\s+fail$/m);
  if (!m) {
    console.error(`  run ${i}: NO SUMMARY LINE — the run did not complete. Aborting rather than scoring a partial run.`);
    process.exit(1);
  }
  failures.push(parseInt(m[1], 10));
  console.log(`  run ${i}: ${m[1]} failures  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const f = noiseFloor(failures);
console.log(`\n  mean ${f.mean.toFixed(2)} failures · sd ${f.sd.toFixed(2)}`);
console.log(`  FLOOR for a single new run : ±${f.singleRunFloor.toFixed(2)} tests`);
console.log(`  FLOOR for a mean of ${runs}      : ±${f.meanFloor.toFixed(2)} tests`);
if (f.sd === 0) {
  console.log(`\n  Deterministic — every run identical. Any difference is real; no floor to clear.`);
} else {
  console.log(`\n  NOT deterministic. A change smaller than ±${f.singleRunFloor.toFixed(1)} tests on one run is noise.`);
  console.log(`  Resolving a 1-test effect would need ~${runsNeeded(f.sd, 1)} runs per arm.`);
  if (suite === "fast") {
    console.log(`  ⚠ This suite GATES DEPLOYS and is supposed to be reproducible — a non-zero floor`);
    console.log(`    means a flaky test is sitting in the gate. Find it before trusting the gate.`);
  }
}
