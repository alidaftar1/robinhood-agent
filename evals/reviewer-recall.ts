import Anthropic from "@anthropic-ai/sdk";
import { reviewRun, type ReviewConcern } from "@/lib/autopilot-review";
import type { TradeRun, PositionSnapshot } from "@/lib/run-store";
import { llmJudge } from "./llm-judge";
import { reserveLlmCall, llmBudgetCanAfford } from "./llm-budget";

// ── Reviewer-recall harness: evaluate the WATCHER, not the worker ─────────────
// The agent's normal evals check the worker (does it decide well). This checks the WATCHER: run
// the ACTUAL skeptical-reviewer (lib/autopilot-review.reviewRun — the same Sonnet pass that emails
// the owner) against real runs where a known problem existed, and measure whether it catches them.
//
//   - Recall / TPR  — of the runs that really contained a problem, how many did the reviewer flag?
//   - Specificity   — on a clean run, does it stay quiet (not manufacture a false concern)?
//
// Grading the reviewer's free-text concerns is itself a judgment, so we use an LLM-as-judge
// (evals/llm-judge). Every LLM call — the reviewer AND the judge — goes through the token budget
// (evals/llm-budget), so the harness is opt-in + hard-capped. This turns "why didn't the reviewer
// catch this?" from a recurring surprise into a measured, improvable number: add a real miss as a
// fixture, tweak the reviewer prompt/registry (or its inputs), re-measure.

// avgCost defaults ~4% below price (a realistic small unrealized gain) so positions aren't all
// "at cost" — the reviewer correctly reads price==avgCost across the board as a stale-price smell.
const p = (symbol: string, quantity: string, price: string, avgCost = (parseFloat(price) * 0.96).toFixed(2)): PositionSnapshot => ({ symbol, quantity, avgCost, price });
const equityOf = (ps: PositionSnapshot[]) => ps.reduce((s, x) => s + parseFloat(x.quantity) * parseFloat(x.price), 0);

// Build an INTERNALLY-CONSISTENT run: timestamp on the same day as `date` (no spurious "silent
// recovery" signal), equity = Σ(positions), totalValue = cash + unsettled + equity. Each fixture is
// consistent in every way EXCEPT its one intended failure — otherwise the reviewer (correctly) flags
// the fixture's own artifacts instead of the thing under test. (The first draft learned this the
// hard way: the reviewer caught equity≠Σ(positions) and date/timestamp drift in the fixtures.)
function mkRun(o: {
  date: string; positions: PositionSnapshot[]; cash: number; unsettled?: number; summary: string;
  influencerPositions?: PositionSnapshot[]; agenticDailyReturn?: number; mainDailyReturn?: number;
  influencerDailyReturn?: number; regime?: TradeRun["regime"]; bookBeta?: TradeRun["bookBeta"]; buySizingAdjustments?: string[];
}): TradeRun {
  const equity = equityOf(o.positions);
  const unsettled = o.unsettled ?? 0;
  return {
    timestamp: `${o.date}T14:30:20.000Z`, date: o.date, summary: o.summary,
    market: { stocksLoaded: 400, headlinesLoaded: 20 }, positions: o.positions,
    portfolioAfter: { totalValue: (o.cash + unsettled + equity).toFixed(2), cash: o.cash.toFixed(2), unsettledCash: unsettled.toFixed(2), equity: equity.toFixed(2) },
    ...(o.influencerPositions ? { influencerPositions: o.influencerPositions } : {}),
    ...(o.agenticDailyReturn != null ? { agenticDailyReturn: o.agenticDailyReturn } : {}),
    ...(o.mainDailyReturn != null ? { mainDailyReturn: o.mainDailyReturn } : {}),
    ...(o.influencerDailyReturn != null ? { influencerDailyReturn: o.influencerDailyReturn } : {}),
    ...(o.regime ? { regime: o.regime } : {}),
    ...(o.bookBeta ? { bookBeta: o.bookBeta } : {}),
    ...(o.buySizingAdjustments ? { buySizingAdjustments: o.buySizingAdjustments } : {}),
  };
}

export interface ReviewerFixture {
  id: string;
  shouldFlag: boolean;   // true = a real problem is present; the reviewer SHOULD raise a concern
  expected?: string;     // what a correct concern would say (fed to the grading judge)
  note: string;          // the real incident this is reconstructed from
  run: TradeRun;
}

// Reconstructed from real incidents (numbers/tickers are the real ones); labeled by hand.
export const FIXTURES: ReviewerFixture[] = [
  {
    id: "sleeve-return-artifact",
    shouldFlag: true,
    expected: "the influencer sleeve's daily return (~ -12.7%) is an implausible artifact — the account and the main sleeve are ~flat, so a value-weighted blend cannot be -12.7%",
    note: "06-30: a phantom booked a ~-12.7% influencer sleeve return while the account was ~flat.",
    run: mkRun({
      date: "2026-06-30", cash: 150,
      positions: [p("AAPL", "1", "278"), p("MRNA", "2", "80"), p("PLTR", "1", "130"), p("TROW", "2", "118"), p("AJG", "1", "250")],
      influencerPositions: [p("PLTR", "1", "130")],
      agenticDailyReturn: 0.0004, mainDailyReturn: -0.003, influencerDailyReturn: -0.1274,
      summary: "## Analysis\nAAPL, MRNA, PLTR, TROW, AJG held; all retain active momentum theses. The account finished roughly flat; no single holding moved sharply.",
    }),
  },
  {
    id: "regime-beta-mismatch",
    shouldFlag: true,
    expected: "the book beta (~0.03) is far below the risk-on regime target of ~1.0-1.3 — the book is defensive on a risk-on day",
    note: "07-07: riskOn regime but bookBeta 0.03 (sold high-beta PANW, bought negative-beta SPGI).",
    run: mkRun({
      date: "2026-07-07", cash: 110,
      regime: { riskOn: true, spy: 751, ma: 707 }, bookBeta: { beta: 0.03, coveragePct: 90 },
      // Diversified, no sector over-cap (top ~34%), no trades described → the ONLY anomaly is the beta.
      positions: [p("SPGI", "1", "443"), p("MRNA", "2", "81"), p("APD", "1", "309"), p("DXC", "6", "10"), p("PLTR", "1", "131"), p("JNJ", "1", "200")],
      agenticDailyReturn: -0.0027,
      summary: "## Analysis\nThe book's value-weighted beta is ~0.03 while the market regime is risk-on (SPY well above its 100-day average). Holdings skew low/negative beta (SPGI, APD, JNJ, DXC); the thesis acknowledged the risk-on beta target but prioritized momentum, leaving the book near market-neutral. Sector mix is diversified — top sector ~34%.",
    }),
  },
  {
    id: "sector-vs-thesis",
    shouldFlag: true,
    expected: "the book is actually ~50-57% Technology (AAPL+PANW+PLTR+DXC), over the 40% cap, while the thesis claims it is ~34-37%",
    note: "07-06: thesis computed ~37% tech using total value incl. cash; true invested-equity concentration was ~57%.",
    run: mkRun({
      date: "2026-07-06", cash: 408, unsettled: 553,
      positions: [p("AAPL", "1", "311"), p("PANW", "1", "366"), p("PLTR", "1", "130"), p("DXC", "6", "10"), p("MRNA", "2", "81"), p("TROW", "2", "118"), p("AJG", "1", "250")],
      summary: "## Analysis\nTechnology ~34-37%, within the 40% cap. Selling MOH/MKC, buying DXC (XLK, strong momentum) which nudges tech but stays under the cap.",
    }),
  },
  {
    id: "stranded-decided-buy",
    shouldFlag: true,
    expected: "a decided buy (TSLA) did not execute, leaving a large idle settled-cash balance (~$400) undeployed",
    note: "07-06: TSLA decided but dropped by buy-sizing; ~$408 sat idle.",
    run: mkRun({
      date: "2026-07-06", cash: 408.15, unsettled: 553,
      buySizingAdjustments: ["TSLA DROPPED — whole share needs ~$413 but only $40 settled buying power left; ~$413 stays idle until the next run"],
      positions: [p("AAPL", "1", "311"), p("DXC", "6", "10"), p("MRNA", "2", "81")],
      summary: "## Analysis\nBought DXC. TRADE_DECISION:{\"thesis\":\"...\",\"sells\":[],\"buys\":[{\"symbol\":\"TSLA\",\"quantity\":1,\"price\":405.22,\"strategy\":\"influencer\"},{\"symbol\":\"DXC\",\"quantity\":6,\"price\":10,\"strategy\":\"main\"}]}",
    }),
  },
  {
    id: "clean-run-control",
    shouldFlag: false,
    note: "A healthy, internally-consistent, diversified run — the reviewer should stay quiet (specificity).",
    run: mkRun({
      date: "2026-06-29", cash: 129,
      regime: { riskOn: true, spy: 748, ma: 705 }, bookBeta: { beta: 1.0, coveragePct: 92 }, // β in line with risk-on → no mismatch
      positions: [p("AAPL", "1", "300"), p("JPM", "1", "200"), p("JNJ", "1", "200"), p("MRNA", "2", "80"), p("TROW", "2", "100"), p("PLTR", "1", "130")],
      influencerPositions: [p("PLTR", "1", "130")],
      agenticDailyReturn: 0.0017, mainDailyReturn: 0.0012, influencerDailyReturn: 0.0066,
      summary: "## Analysis\nAll holdings retain active momentum theses; sector mix balanced (top sector ~36%). Book beta ~1.0, in line with the risk-on regime. Settled cash is modest (~10% of equity). Small positive day, sleeves consistent.",
    }),
  },
];

const OK_VERIFY = { status: "ok", cashDiff: 0, valueDiff: 0, positionIssues: 0, uncapturedOrders: 0 } as const;

export type Outcome = "TP" | "FN" | "TN" | "FP";

// K repeated runs per fixture. pass^K measures CONSISTENCY, not a lucky single run: a fixture only
// counts as "held" when the reviewer gets it right on ALL K runs. A run "passes" when the reviewer
// CAUGHT the planted problem (should-flag) or stayed QUIET (clean). K=5 preferred (the pass^k
// literature); env-overridable, clamped to ≥1. NOTE: a full k=5 sweep of all fixtures is ~45 LLM
// calls, so raise EVAL_LLM_MAX_CALLS accordingly — underfunded fixtures are skipped, not partial.
export const REVIEWER_RECALL_K = Math.max(1, Math.floor(Number(process.env.REVIEWER_RECALL_K ?? 5)) || 5);

export interface ReviewerResult {
  id: string;
  shouldFlag: boolean;
  kRan: number;                     // runs completed (kRan < K ⇒ skipped, excluded from pass^K)
  kPass: number;                    // of kRan, how many passed (caught if should-flag; quiet if clean)
  outcomes: Outcome[];              // per-run outcome, in order
  concernsSample: ReviewConcern[];  // concerns from the first completed run (for the scoreboard)
  skipped: boolean;                 // couldn't complete all K runs (budget exhausted or reviewer error)
  error?: string;
}

const passCount = (outcomes: Outcome[]) => outcomes.filter((o) => o === "TP" || o === "TN").length;

// Grade whether the reviewer's concerns cover the expected issue (LLM-as-judge). Returns null if
// the token budget refused the grading call.
async function graded(concerns: ReviewConcern[], expected: string): Promise<boolean | null> {
  return llmJudge(
    `A skeptical reviewer audited a trading run and produced these concerns. Did ANY concern clearly flag this specific problem: "${expected}"? Answer YES only if a concern genuinely covers it (same issue, right direction), NO if it's absent or only vaguely related.`,
    JSON.stringify(concerns, null, 2),
  );
}

// Run ONE fixture K times. The whole K-run is reserved up front (llmBudgetCanAfford), so a fixture
// runs all K times or not at all — pass^K is never computed from a partial sample. A reviewer error
// or a judge-budget refusal mid-run aborts the fixture as skipped rather than reporting a short K.
async function runFixtureKTimes(anthropic: Anthropic, f: ReviewerFixture, K: number): Promise<ReviewerResult> {
  const callsPerRun = f.shouldFlag ? 2 : 1; // reviewer (+ judge, for should-flag)
  const outcomes: Outcome[] = [];
  let concernsSample: ReviewConcern[] = [];
  const done = (skipped: boolean, error?: string): ReviewerResult =>
    ({ id: f.id, shouldFlag: f.shouldFlag, kRan: outcomes.length, kPass: passCount(outcomes), outcomes, concernsSample, skipped, error });

  if (!llmBudgetCanAfford(K * callsPerRun)) return done(true);

  for (let i = 0; i < K; i++) {
    reserveLlmCall(); // reviewer call — the whole K-run's affordability was pre-checked above
    const { concerns, error } = await reviewRun(anthropic, f.run, [], OK_VERIFY);
    if (error) return done(true, error);
    if (i === 0) concernsSample = concerns;
    let outcome: Outcome;
    if (f.shouldFlag) {
      const caught = await graded(concerns, f.expected!); // graded → llmJudge reserves its own call
      if (caught == null) return done(true); // judge refused → don't report a partial K
      outcome = caught ? "TP" : "FN";
    } else {
      // Clean run: a HIGH/MEDIUM concern is a false alarm; a bare "low" FYI is tolerated.
      outcome = concerns.some((c) => c.severity !== "low") ? "FP" : "TN";
    }
    outcomes.push(outcome);
  }
  return done(false);
}

// Run the REAL reviewer K times against each fixture. Budgeted; underfunded fixtures are skipped
// (not partially scored) and surfaced in the scoreboard so a too-low cap is obvious.
export async function runReviewerRecall(anthropic: Anthropic, fixtures = FIXTURES, K = REVIEWER_RECALL_K): Promise<ReviewerResult[]> {
  const out: ReviewerResult[] = [];
  for (const f of fixtures) out.push(await runFixtureKTimes(anthropic, f, K));
  return out;
}

export interface ReviewerScore {
  K: number;
  recallPassK: number | null;       // should-flag fixtures caught on ALL K runs / scored should-flag
  specificityPassK: number | null;  // clean fixtures quiet on ALL K runs / scored clean
  recallMean: number | null;        // Σ kPass / Σ kRan over should-flag (the per-run "pass@1" view)
  specificityMean: number | null;   // Σ kPass / Σ kRan over clean
  flaky: string[];                  // fixtures with 0 < kPass < kRan — right only sometimes
  scored: number;                   // fixtures that completed all K runs
  skipped: number;
}

// pass^K aggregation. recall*PassK* is the strict consistency bar (caught EVERY run); recall*Mean* is
// the lenient per-run view. The GAP between them is the flakiness the single-run harness hid.
export function scoreReviewer(results: ReviewerResult[]): ReviewerScore {
  const done = results.filter((r) => !r.skipped && r.kRan > 0);
  const flag = done.filter((r) => r.shouldFlag);
  const clean = done.filter((r) => !r.shouldFlag);
  const passedAll = (r: ReviewerResult) => r.kPass === r.kRan;
  const mean = (rs: ReviewerResult[]) => {
    const ran = rs.reduce((s, r) => s + r.kRan, 0);
    return ran ? rs.reduce((s, r) => s + r.kPass, 0) / ran : null;
  };
  return {
    K: done.length ? Math.max(...done.map((r) => r.kRan)) : REVIEWER_RECALL_K,
    recallPassK: flag.length ? flag.filter(passedAll).length / flag.length : null,
    specificityPassK: clean.length ? clean.filter(passedAll).length / clean.length : null,
    recallMean: mean(flag),
    specificityMean: mean(clean),
    flaky: done.filter((r) => r.kPass > 0 && r.kPass < r.kRan).map((r) => r.id),
    scored: done.length,
    skipped: results.filter((r) => r.skipped).length,
  };
}

export function renderReviewerScoreboard(results: ReviewerResult[]): string {
  const s = scoreReviewer(results);
  const pct = (x: number | null) => (x == null ? "n/a" : Math.round(x * 100) + "%");
  const rows = results.map((r) => {
    const verdict = r.skipped ? "SKIP" : r.kPass === r.kRan ? `pass^${r.kRan}` : r.kPass === 0 ? "FAIL" : "FLAKY";
    const kk = r.skipped && r.kRan === 0 ? "—" : `${r.kPass}/${r.kRan}`;
    const tail = r.error ? "(" + r.error + ")" : r.concernsSample.map((c) => c.title).slice(0, 2).join("; ");
    return `  ${r.id.padEnd(24)} ${(r.shouldFlag ? "should-flag" : "clean").padEnd(12)} ${kk.padEnd(7)} ${verdict.padEnd(8)} ${tail}`;
  });
  const needCalls = results.reduce((n, r) => n + (r.shouldFlag ? 2 : 1) * s.K, 0);
  return [
    "  fixture                  kind         k-pass  verdict  reviewer concern(s)",
    ...rows,
    "",
    `  pass^${s.K} RECALL (caught EVERY run): ${pct(s.recallPassK)}   ·   per-run recall: ${pct(s.recallMean)}`,
    `  pass^${s.K} SPECIFICITY (quiet EVERY run): ${pct(s.specificityPassK)}   ·   per-run specificity: ${pct(s.specificityMean)}`,
    s.flaky.length
      ? `  ⚠ FLAKY (right only sometimes — the pass^k gap a single run hid): ${s.flaky.join(", ")}`
      : `  no flaky fixtures — every scored fixture was consistent across ${s.K} runs`,
    s.skipped ? `  (${s.skipped} fixture(s) skipped for budget — a full k=${s.K} sweep needs ~${needCalls} calls: set EVAL_LLM_MAX_CALLS)` : "",
  ].filter(Boolean).join("\n");
}
