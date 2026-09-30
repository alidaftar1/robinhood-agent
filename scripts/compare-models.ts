/**
 * Model comparison for the ANALYSIS path — the one call that actually decides trades.
 *
 *   bun --env-file=.env.local scripts/compare-models.ts
 *   bun --env-file=.env.local scripts/compare-models.ts claude-sonnet-4-6 claude-opus-5
 *
 * Runs every eval scenario against each candidate model through the LIVE V1 prompt and the same
 * deterministic checks the Braintrust eval uses, then reports pass rates and per-scenario deltas.
 *
 * WHAT THIS MEASURES — and the limit is the point, not a disclaimer. These checks score PROCESS:
 * does the model stay inside the rails, cite the evidence it was handed, honour the loss-discipline
 * and time-stop exceptions, avoid the failure classes in the past-misses registry. That is
 * observable in one run.
 *
 * WHAT IT CANNOT MEASURE: whether a model makes more money. With ~60 days of live history and
 * returns dominated by market direction, a model swap's P&L effect is undetectable, and any
 * backtest over the same scenarios is survivorship-inflated. A model that scores better here is
 * better at FOLLOWING ITS OWN RULES — which is where this system's documented failures actually
 * live — and that is the claim to make, not a profit claim.
 *
 * Deliberately NOT writing to Braintrust: that project tracks the production model over time, and
 * pushing candidate runs into it would corrupt the series this is meant to be compared against.
 *
 * RESULT, 2026-09-29 — sonnet-4-6 (production) vs sonnet-5 vs opus-5, 12 scenarios each:
 *   sonnet-4-6  11/12 scenarios, 119/120 checks
 *   sonnet-5    12/12 scenarios, 120/120 checks
 *   opus-5      12/12 scenarios, 120/120 checks
 * The single difference (sonnet-4-6 on earnings-exit) did NOT reproduce: 0/5 on repeat runs. The
 * eval agent sets no temperature, so one pass is one sample — that delta was noise.
 *
 * The more useful finding is about the SUITE, not the models: at 99-100% it is SATURATED and has
 * no headroom to detect an improvement. Any future model comparison run against it will also come
 * back "indistinguishable", because every scenario already passes. To justify a model change you
 * would first need scenarios PRODUCTION CURRENTLY FAILS — the past-misses registry is the obvious
 * source, since every row there is a real failure this suite does not capture.
 */
import { SCENARIOS, buildV1PromptFromScenario } from "../evals/fixtures";
import { runAnalysisAgent, PRODUCTION_ANALYSIS_MODEL } from "../evals/agent";
import { runAllDecisionChecks } from "../evals/checks";

const _d = new Date();
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [PRODUCTION_ANALYSIS_MODEL, "claude-sonnet-5", "claude-opus-5"];

interface ModelResult {
  model: string;
  scenarioPassed: number;
  checksPassed: number;
  checksTotal: number;
  failuresByScenario: Map<string, string[]>;
  errors: string[];
  ms: number;
}

async function runModel(model: string): Promise<ModelResult> {
  const r: ModelResult = {
    model, scenarioPassed: 0, checksPassed: 0, checksTotal: 0,
    failuresByScenario: new Map(), errors: [], ms: 0,
  };
  const t0 = Date.now();
  for (const scenario of SCENARIOS) {
    try {
      const prompt = buildV1PromptFromScenario(scenario, TODAY);
      const { text, decision } = await runAnalysisAgent(prompt, model);
      const checks = runAllDecisionChecks(text, decision, scenario);
      r.checksTotal += checks.length;
      r.checksPassed += checks.filter(c => c.passed).length;
      const failed = checks.filter(c => !c.passed).map(c => c.name);
      if (failed.length === 0) r.scenarioPassed++;
      else r.failuresByScenario.set(scenario.name, failed);
      process.stdout.write(failed.length === 0 ? "." : "x");
    } catch (e) {
      // One scenario erroring must not lose the other eleven — a partial comparison is still
      // informative, a crashed one is not.
      r.errors.push(`${scenario.name}: ${e instanceof Error ? e.message : String(e)}`);
      process.stdout.write("!");
    }
  }
  r.ms = Date.now() - t0;
  return r;
}

const results: ModelResult[] = [];
for (const model of CANDIDATES) {
  process.stdout.write(`\n${model.padEnd(24)} `);
  results.push(await runModel(model));
}

console.log("\n\n=== PROCESS ADHERENCE (not profitability) ===\n");
console.log("model".padEnd(24) + "scenarios".padEnd(12) + "checks".padEnd(14) + "errors  time");
for (const r of results) {
  const pct = r.checksTotal ? ((r.checksPassed / r.checksTotal) * 100).toFixed(0) : "—";
  console.log(
    r.model.padEnd(24) +
    `${r.scenarioPassed}/${SCENARIOS.length}`.padEnd(12) +
    `${r.checksPassed}/${r.checksTotal} (${pct}%)`.padEnd(14) +
    `${r.errors.length}`.padEnd(8) +
    `${(r.ms / 1000).toFixed(0)}s`,
  );
}

// Per-scenario deltas are the useful part: an aggregate that moves by one check is noise, but a
// scenario one model fails and another passes names a specific behaviour to go and read.
console.log("\n=== WHERE THEY DIFFER (per scenario) ===\n");
const baseline = results[0];
let anyDiff = false;
for (const scenario of SCENARIOS) {
  const row = results.map(r => (r.failuresByScenario.has(scenario.name) ? "FAIL" : "pass"));
  if (new Set(row).size > 1) {
    anyDiff = true;
    console.log(`  ${scenario.name.padEnd(28)} ${row.map((v, i) => `${results[i].model.split("-").slice(1).join("-")}:${v}`).join("  ")}`);
    for (const r of results) {
      const f = r.failuresByScenario.get(scenario.name);
      if (f?.length) console.log(`      ${r.model} failed: ${f.join(", ")}`);
    }
  }
}
if (!anyDiff) {
  console.log("  No scenario differs between models — on this suite they are indistinguishable.");
  console.log("  That is a real result: it argues AGAINST switching, since you would be paying");
  console.log("  for a change you cannot verify.");
}

for (const r of results) {
  if (r.errors.length) console.log(`\n${r.model} errors:\n  ${r.errors.join("\n  ")}`);
}

console.log(
  `\nBaseline is ${baseline.model} (production). A model is worth switching to only if it fixes` +
  `\nscenarios the baseline fails — an equal or noisier score is a reason to stay put.`,
);
