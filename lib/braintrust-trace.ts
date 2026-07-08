import { initLogger } from "braintrust";
import type { TradeRun } from "./run-store";
import type { ReviewResult } from "./autopilot-review";
import { maxPositionDollars } from "./strategy";

// ── Production observability ──────────────────────────────────────────────────
// Logs each daily trade run to Braintrust as an ONLINE trace, in the same project as the offline
// evals — so live decisions are searchable/monitorable next to the eval scores (the two halves of
// LLM ops: offline evals + online tracing).
//
// FAIL-SAFE BY DESIGN: this must NEVER affect the live trade. Every call is wrapped in try/catch with
// a short flush timeout, runs AFTER the run is already saved + orders executed, and skips silently
// when BRAINTRUST_API_KEY is absent. It logs decision + portfolio context only — never account IDs or
// secrets. In serverless we must flush before the function returns, so the flush is explicitly awaited.

// Whitelist the fields we log from a model-decided order — never spread the raw object.
const projectOrder = (o: any) => ({ symbol: o?.symbol, quantity: o?.quantity, price: o?.price, strategy: o?.strategy });

const num = (x: unknown): number => {
  if (typeof x === "number") return x;
  const n = parseFloat(String(x ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

// Deterministic decision scores attached to each online trace (0 = fail, 1 = pass). These are the
// SAME invariants the offline evals check (evals/checks.ts), recomputed here against the REAL run so
// production doesn't import test fixtures. They grade the model's PROPOSED decision (decidedRaw),
// before buy-sizing trims it — same object the offline evals score, so online/offline are comparable.
// Only invariants that map cleanly to prod semantics are included; each score is OMITTED (not logged
// as 0) when its inputs are absent, so a missing field never reads as a real failure.
export function computeDecisionScores(
  run: TradeRun,
  decision: { thesis?: string; buys?: unknown[]; sells?: unknown[] } | null,
  buyingPower?: string | null,
): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!decision) return scores;
  const buys = (Array.isArray(decision.buys) ? decision.buys : []) as Array<{ symbol?: unknown; quantity?: unknown; price?: unknown }>;
  const sells = (Array.isArray(decision.sells) ? decision.sells : []) as Array<{ quantity?: unknown }>;

  // Whole, positive share quantities across all orders.
  const orders = [...buys, ...sells];
  if (orders.length > 0) {
    scores.whole_shares = orders.every((o) => { const q = num(o.quantity); return Number.isInteger(q) && q > 0; }) ? 1 : 0;
  }

  // Position sizing + budget — only over buys that carry a usable price.
  const priced = buys.filter((b) => Number.isFinite(num(b.price)) && num(b.price) > 0);
  if (priced.length > 0) {
    const cap = maxPositionDollars(run?.portfolioAfter?.totalValue);        // dynamic prod cap, not the eval's fixed $400
    scores.position_cap = priced.every((b) => num(b.quantity) * num(b.price) <= cap + 1) ? 1 : 0;
    scores.min_position_size = priced.every((b) => num(b.quantity) * num(b.price) >= 50 - 1) ? 1 : 0;
    const bp = num(buyingPower);
    if (Number.isFinite(bp)) {
      const spend = priced.reduce((s, b) => s + num(b.quantity) * num(b.price), 0);
      scores.buys_within_budget = spend <= bp + 1 ? 1 : 0;                  // sell proceeds don't count — same HARD LIMIT as the prompt
    }
  }

  // Thesis is substantive (non-trivial length + at least one signal keyword).
  const thesis = typeof decision.thesis === "string" ? decision.thesis : "";
  const kw = ["momentum", "sector", "mom5", "alpha", "earnings", "insider", "upgrade", "thesis", "rotation", "signal", "conviction", "beta"];
  scores.has_thesis = thesis.length >= 50 && kw.some((k) => thesis.toLowerCase().includes(k)) ? 1 : 0;

  return scores;
}

type Logger = ReturnType<typeof initLogger>;
let cached: Logger | null = null;
function getLogger(): Logger | null {
  if (!process.env.BRAINTRUST_API_KEY) return null;
  if (!cached) cached = initLogger({ projectName: "robinhood-agent", apiKey: process.env.BRAINTRUST_API_KEY });
  return cached;
}

// Serverless: flush before the function returns, but never let it hang the caller. Clear the timer so
// a fast flush doesn't leave a dangling 5s timeout keeping the lambda alive.
async function flushSafely(lg: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    lg.flush(),
    new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("flush timeout")), 5000); }),
  ]).finally(() => clearTimeout(timer));
}

export async function logTradeRun(args: {
  run: TradeRun;
  decision: { thesis?: string; buys?: unknown[]; sells?: unknown[] } | null;
  buyingPower?: string | null;
}): Promise<void> {
  try {
    const lg = getLogger();
    if (!lg) return;
    const { run, decision } = args;
    lg.log({
      input: {
        date: run.date,
        buyingPower: args.buyingPower ?? null,
        totalValue: run.portfolioAfter?.totalValue ?? null,
        heldSymbols: (run.positions ?? []).map((p) => p.symbol),
        regime: run.regime ? (run.regime.riskOn ? "risk-on" : "risk-off") : null,
        bookBeta: run.bookBeta?.beta ?? null,
      },
      output: {
        // Full Sonnet reasoning (the point of tracing an LLM agent) — thesis is often the terse
        // JSON field and can be empty; the prose reasoning lives in run.summary.
        reasoning: run.summary?.slice(0, 2000) ?? null,
        thesis: decision?.thesis?.slice(0, 500) ?? null,
        // Whitelist the fields (don't spread the model object verbatim) so a future decision-schema
        // change can't forward something sensitive to Braintrust.
        buys: (decision?.buys ?? []).map(projectOrder),
        sells: (decision?.sells ?? []).map(projectOrder),
      },
      metadata: {
        executedTrades: (run.trades ?? []).map((t) => `${t.side} ${t.symbol} x${t.quantity} @ ${t.avgPrice}`),
        buySizingAdjustments: run.buySizingAdjustments ?? [],
        agenticDailyReturn: run.agenticDailyReturn ?? null,
        influencerDailyReturn: run.influencerDailyReturn ?? null,
      },
      // Deterministic guardrail scores on the model's proposed decision — surfaced next to each live
      // trace in the Logs tab (and averageable across runs), reusing the offline evals' invariants.
      scores: computeDecisionScores(run, decision, args.buyingPower),
    });
    await flushSafely(lg);
  } catch (e) {
    console.warn("BRAINTRUST_TRACE_SKIPPED", e instanceof Error ? e.message : String(e));
  }
}

// Surfaces the Sonnet skeptical-reviewer's verdict on a run as its own scored Braintrust event, in the
// same project/Logs as the trade trace (joinable by date). The reviewer is a SEPARATE post-hoc pass
// (8am autopilot, after the 7:30am trade), so it logs its own event rather than patching the trade
// trace. Scores are 0–1, higher = better; omitted entirely if the reviewer itself errored, so a failed
// pass never reads as "clean". Fail-safe: wrapped in try/catch, never affects the autopilot report.
export async function logReviewResult(args: { run: TradeRun; result: ReviewResult }): Promise<void> {
  try {
    const lg = getLogger();
    if (!lg) return;
    const { run, result } = args;
    const concerns = result.concerns ?? [];
    const high = concerns.filter((c) => c.severity === "high").length;
    const medium = concerns.filter((c) => c.severity === "medium").length;
    const low = concerns.filter((c) => c.severity === "low").length;
    const scores: Record<string, number> = result.error ? {} : {
      reviewer_clean: concerns.length === 0 ? 1 : 0,           // nothing flagged at all
      reviewer_no_high: high === 0 ? 1 : 0,                    // no high-severity concern
      reviewer_no_serious: high === 0 && medium === 0 ? 1 : 0, // no actionable (high/medium) concern
    };
    lg.log({
      input: { date: run.date, heldSymbols: (run.positions ?? []).map((p) => p.symbol) },
      output: {
        concerns: concerns.map((c) => ({ severity: c.severity, title: c.title, detail: (c.detail ?? "").slice(0, 300) })),
        error: result.error ?? null,
      },
      metadata: { pass: "skeptical-reviewer", high, medium, low, total: concerns.length },
      scores,
    });
    await flushSafely(lg);
  } catch (e) {
    console.warn("BRAINTRUST_REVIEW_TRACE_SKIPPED", e instanceof Error ? e.message : String(e));
  }
}
