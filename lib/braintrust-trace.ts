import { initLogger } from "braintrust";
import type { TradeRun } from "./run-store";

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

type Logger = ReturnType<typeof initLogger>;
let cached: Logger | null = null;
function getLogger(): Logger | null {
  if (!process.env.BRAINTRUST_API_KEY) return null;
  if (!cached) cached = initLogger({ projectName: "robinhood-agent", apiKey: process.env.BRAINTRUST_API_KEY });
  return cached;
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
    });
    // Serverless: flush before the function returns, but never let it hang the trade. Clear the timer
    // so a fast flush doesn't leave a dangling 5s timeout keeping the lambda alive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      lg.flush(),
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("flush timeout")), 5000); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    console.warn("BRAINTRUST_TRACE_SKIPPED", e instanceof Error ? e.message : String(e));
  }
}
