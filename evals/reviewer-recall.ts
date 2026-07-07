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

export type Outcome = "TP" | "FN" | "TN" | "FP" | "skipped";
export interface ReviewerResult {
  id: string; shouldFlag: boolean; outcome: Outcome;
  concerns: ReviewConcern[]; error?: string;
}

// Grade whether the reviewer's concerns cover the expected issue (LLM-as-judge). Returns null if
// the token budget refused the grading call.
async function graded(concerns: ReviewConcern[], expected: string): Promise<boolean | null> {
  return llmJudge(
    `A skeptical reviewer audited a trading run and produced these concerns. Did ANY concern clearly flag this specific problem: "${expected}"? Answer YES only if a concern genuinely covers it (same issue, right direction), NO if it's absent or only vaguely related.`,
    JSON.stringify(concerns, null, 2),
  );
}

// Run the REAL reviewer against each fixture and score it. Every LLM call is budgeted; when the
// budget is exhausted the remaining fixtures are marked "skipped" rather than forcing spend.
export async function runReviewerRecall(anthropic: Anthropic, fixtures = FIXTURES): Promise<ReviewerResult[]> {
  const out: ReviewerResult[] = [];
  for (const f of fixtures) {
    // A should-flag fixture needs 2 calls (reviewer + judge); reserve both up front so we never
    // spend the reviewer call and then get refused the judge (which would drop the item from the
    // recall denominator and skew the reported number).
    const need = f.shouldFlag ? 2 : 1;
    if (!llmBudgetCanAfford(need) || !reserveLlmCall()) { out.push({ id: f.id, shouldFlag: f.shouldFlag, outcome: "skipped", concerns: [] }); continue; }
    const { concerns, error } = await reviewRun(anthropic, f.run, [], OK_VERIFY);
    if (error) { out.push({ id: f.id, shouldFlag: f.shouldFlag, outcome: "skipped", concerns: [], error }); continue; }
    let outcome: Outcome;
    if (f.shouldFlag) {
      const caught = await graded(concerns, f.expected!);
      outcome = caught == null ? "skipped" : caught ? "TP" : "FN";
    } else {
      // Clean run: a HIGH/MEDIUM concern is a false alarm; a bare "low" FYI is tolerated.
      outcome = concerns.some((c) => c.severity !== "low") ? "FP" : "TN";
    }
    out.push({ id: f.id, shouldFlag: f.shouldFlag, outcome, concerns });
  }
  return out;
}

export interface ReviewerScore { tp: number; fn: number; tn: number; fp: number; recall: number | null; specificity: number | null; scored: number }
export function scoreReviewer(results: ReviewerResult[]): ReviewerScore {
  const tp = results.filter((r) => r.outcome === "TP").length;
  const fn = results.filter((r) => r.outcome === "FN").length;
  const tn = results.filter((r) => r.outcome === "TN").length;
  const fp = results.filter((r) => r.outcome === "FP").length;
  return { tp, fn, tn, fp, recall: tp + fn ? tp / (tp + fn) : null, specificity: tn + fp ? tn / (tn + fp) : null, scored: tp + fn + tn + fp };
}

export function renderReviewerScoreboard(results: ReviewerResult[]): string {
  const rows = results.map((r) => `  ${r.id.padEnd(24)} ${(r.shouldFlag ? "should-flag" : "clean").padEnd(12)} ${r.outcome.padEnd(8)} ${r.error ? "(" + r.error + ")" : r.concerns.map((c) => c.title).slice(0, 2).join("; ")}`);
  const s = scoreReviewer(results);
  return [
    "  fixture                  kind         outcome  reviewer concern(s)",
    ...rows,
    "",
    `  RECALL (real problems caught): ${s.recall == null ? "n/a" : Math.round(s.recall * 100) + "%"} (${s.tp}/${s.tp + s.fn})   ·   SPECIFICITY (clean stays quiet): ${s.specificity == null ? "n/a" : Math.round(s.specificity * 100) + "%"} (${s.tn}/${s.tn + s.fp})`,
  ].join("\n");
}
