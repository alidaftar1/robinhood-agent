/**
 * Braintrust eval runner — analysis path (Sonnet + buildAnalysisPrompt).
 * Matches the actual production decision-making path, not the Haiku execution layer.
 *
 * Usage:
 *   bun --env-file=.env.local evals/braintrust.eval.ts
 *
 * Results appear at https://www.braintrust.dev under project "robinhood-agent".
 */

import { initExperiment } from "braintrust";
import { SCENARIOS, formatFixtureMarketData } from "./fixtures";
import { runAnalysisAgent } from "./agent";
import { runAllDecisionChecks } from "./checks";
import { scoreInsiderAwareness } from "./scorers";
import { buildAnalysisPrompt } from "@/lib/strategy";

const _d = new Date();
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
const EXPERIMENT_NAME = `eval-${TODAY}-analysis`;

const experiment = await initExperiment("robinhood-agent", {
  apiKey: process.env.BRAINTRUST_API_KEY,
  experiment: EXPERIMENT_NAME,
  update: true,
});

console.log(`Running ${SCENARIOS.length} scenarios → ${EXPERIMENT_NAME}`);

let passed = 0;
let total = 0;

for (const scenario of SCENARIOS) {
  process.stdout.write(`  ${scenario.name} ... `);

  const insiderBuys = scenario.insiderBuys ?? {};
  const earningsOverrides = scenario.earningsOverrides ?? {};
  const analystRatings = scenario.analystRatings ?? {};

  const systemPrompt = buildAnalysisPrompt(
    TODAY,
    formatFixtureMarketData(
      scenario.marketState ?? "default",
      insiderBuys,
      earningsOverrides,
      analystRatings,
      scenario.stockOverrides ?? {},
    ),
    {
      buyingPower: scenario.buyingPower,
      totalValue: scenario.totalValue,
      positions: scenario.positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.average_buy_price,
      })),
    },
  );

  const span = experiment.startSpan({ name: scenario.name });

  try {
    const { text, decision } = await runAnalysisAgent(systemPrompt);
    const checks = runAllDecisionChecks(text, decision, scenario);
    const checkScores = Object.fromEntries(
      checks.map((c) => [c.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase(), c.passed ? 1 : 0])
    );

    // LLM judge: only runs for scenarios with insider buys.
    // scoreInsiderAwareness falls back to TRADE_DECISION parsing when toolCalls=[].
    const insiderScore = await scoreInsiderAwareness(text, insiderBuys, []);
    const scores = {
      ...checkScores,
      ...(Object.keys(insiderBuys).length > 0
        ? { [insiderScore.name]: insiderScore.score }
        : {}),
    };

    const scenarioPassed = checks.every((c) => c.passed);
    passed += scenarioPassed ? 1 : 0;
    total += 1;

    span.log({
      input: {
        scenario: scenario.name,
        buyingPower: scenario.buyingPower,
        totalValue: scenario.totalValue,
        positions: scenario.positions,
        marketState: scenario.marketState ?? "default",
        insiderSymbols: Object.keys(insiderBuys),
      },
      expected: {
        allChecksPassed: true,
        insider_signal_awareness: Object.keys(insiderBuys).length > 0 ? 0.7 : null,
      },
      output: {
        thesis: decision?.thesis?.slice(0, 300) ?? null,
        sells: decision?.sells ?? [],
        buys: decision?.buys ?? [],
        textSnippet: text.slice(0, 300),
      },
      scores,
      metadata: {
        failedChecks: checks.filter((c) => !c.passed).map((c) => ({
          check: c.name,
          detail: c.detail,
        })),
        insiderJudge: Object.keys(insiderBuys).length > 0
          ? { score: insiderScore.score, rationale: insiderScore.rationale }
          : null,
      },
    });

    const icon = scenarioPassed ? "✓" : "✗";
    const failCount = checks.filter((c) => !c.passed).length;
    const n = checks.length;
    const checkStr = scenarioPassed ? `${n}/${n}` : `${n - failCount}/${n}`;
    const judgeStr = Object.keys(insiderBuys).length > 0
      ? ` | insider=${insiderScore.score.toFixed(2)}`
      : "";
    console.log(`${icon} ${checkStr}${judgeStr}`);
  } catch (err) {
    total += 1;
    span.log({
      input: { scenario: scenario.name },
      output: { error: String(err) },
      scores: {},
      metadata: { error: true },
    });
    console.log(`✗ error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    span.end();
  }
}

await experiment.flush();

const url = `https://www.braintrust.dev/app/Yogi's%20Insight/p/robinhood-agent/experiments/${EXPERIMENT_NAME}`;
console.log(`\n${passed}/${total} scenarios passed`);
console.log(`Dashboard: ${url}`);
