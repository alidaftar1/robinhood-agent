import Anthropic from "@anthropic-ai/sdk";
import type { TradeRun } from "@/lib/run-store";
import { formatKnownIssues } from "@/lib/autopilot-known-issues";

// ─────────────────────────────────────────────────────────────────────────────
// SKEPTICAL-REVIEWER PASS
//
// The deterministic autopilot checks verify the END STATE (run present, cash
// reconciles, no extreme return). They can't form a JUDGMENT — "this buy was a
// falling knife", "this derived metric doesn't add up", "this run recovered from
// a failed morning". This pass is one Sonnet call, prompted adversarially, that
// reads the run + recent history + the past-misses registry and returns ranked
// concerns. Its output is appended to the autopilot email so a judgment actually
// reaches the owner. Non-fatal by design: any failure returns an empty review.
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "high" | "medium" | "low";

export interface ReviewConcern {
  severity: Severity;
  title: string;
  detail: string;
}

export interface ReviewResult {
  concerns: ReviewConcern[];
  /** Set when the reviewer itself couldn't run — surfaced so a silent skip is visible. */
  error?: string;
}

const SCHEDULED_TRADE_CRON_UTC = "14:30 UTC (7:30am PT)";

// Feed the reviewer the FULL run summary. It's bounded by the analysis call's
// max_tokens (~3k tokens ≈ ≤12k chars), so this captures the entire thesis plus
// the trailing TRADE_DECISION line. The old 2000-char slice cut off before the
// decision and the per-name buy theses, which made the reviewer hallucinate
// "summary truncated / buy thesis missing" false positives even though the
// stored summary was complete (the model never actually hit its token limit).
const SUMMARY_CHAR_LIMIT = 16000;

// Trim a run to just what the reviewer needs — keeps the prompt small and cheap.
function compactRun(r: TradeRun) {
  return {
    date: r.date,
    timestamp: r.timestamp,
    agenticDailyReturn: r.agenticDailyReturn ?? null,
    impliedTransfer: r.agenticImpliedTransfer ?? null,
    portfolioAfter: {
      totalValue: r.portfolioAfter?.totalValue ?? null,
      settledCash: r.portfolioAfter?.cash ?? null,
      unsettledCash: r.portfolioAfter?.unsettledCash ?? null,
      equity: r.portfolioAfter?.equity ?? null,
    },
    trades: (r.trades ?? []).map((t) => ({
      symbol: t.symbol,
      side: t.side,
      qty: t.quantity,
      price: t.avgPrice,
      state: t.state,
      strategy: t.strategy ?? "main",
    })),
    positions: (r.positions ?? []).map((p) => ({
      symbol: p.symbol,
      qty: p.quantity,
      avgCost: p.avgCost,
      price: p.price,
    })),
    influencerPositions: (r.influencerPositions ?? []).map((p) => p.symbol),
  };
}

const SYSTEM_PROMPT = `You are a skeptical quant risk reviewer auditing a live autonomous trading agent's daily run BEFORE its owner sees it. The owner keeps catching problems the automated checks miss — your job is to catch them first.

You are reviewing a recovered, reconciled run, so do NOT re-report things the deterministic layer already handles (cash reconciliation, missing-sell patching, extreme >30% returns). Look for JUDGMENT-level problems: bad entries, derived numbers that don't add up, concentration drift, signs the morning silently failed and recovered, anything that smells wrong.

You will be given a registry of past misses — explicitly check the current run for a recurrence of each one, but also reason beyond the list.

Be precise and quantitative; cite the actual numbers/tickers from the data. Do not invent data you weren't given. If nothing is wrong, return an empty concerns array — do not manufacture concerns to seem useful.

INSTRUMENT IDENTITY: every symbol here is a U.S.-listed EQUITY or ETF (the S&P 500 plus an expanded universe of liquid stocks/ETFs, including a few influencer picks). NONE are crypto, futures, forex, or indices. Do NOT assume a ticker is its famous namesake and then call a price "wrong" — e.g. "ES" is Eversource Energy (a ~$70 utility stock), NOT E-mini S&P 500 futures; "BTC" here is a Bitcoin ETF trading at ~$26, NOT bitcoin itself. A low or unfamiliar share price is normal for an equity/ETF; only flag a price as a data error if it's internally inconsistent (e.g. contradicts the same symbol's other figures in this run), never just because it doesn't match a crypto/futures instrument that shares the ticker.

Respond with ONLY a JSON object, no prose, in this exact shape:
{"concerns":[{"severity":"high|medium|low","title":"short label","detail":"one or two sentences citing specifics"}]}

Severity: high = likely real money/data error or bad trade needing action today; medium = probable issue worth a look; low = FYI / minor.`;

function buildUserPrompt(todayRun: TradeRun, recentRuns: TradeRun[]): string {
  const history = recentRuns
    .filter((r) => r.date !== todayRun.date)
    .slice(0, 7)
    .map(compactRun);

  return `SCHEDULED trade cron time: ${SCHEDULED_TRADE_CRON_UTC}. A today timestamp materially later than that implies the morning failed at least once and silently recovered.

TODAY'S RUN:
${JSON.stringify(compactRun(todayRun), null, 2)}

TODAY'S RUN SUMMARY (full — includes the per-name thesis and the trailing TRADE_DECISION line):
${(todayRun.summary ?? "").slice(0, SUMMARY_CHAR_LIMIT)}

RECENT RUNS (newest first, for trend/comparison):
${JSON.stringify(history, null, 2)}

PAST-MISSES REGISTRY — check the current run for a recurrence of each:
${formatKnownIssues()}

Audit today's run now. Return the JSON object.`;
}

function parseConcerns(text: string): ReviewConcern[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const raw = (parsed as { concerns?: unknown }).concerns;
  if (!Array.isArray(raw)) return [];
  const allowed: Severity[] = ["high", "medium", "low"];
  return raw
    .filter((c): c is ReviewConcern => {
      const o = c as Partial<ReviewConcern>;
      return (
        !!o &&
        allowed.includes(o.severity as Severity) &&
        typeof o.title === "string" &&
        typeof o.detail === "string"
      );
    })
    .map((c) => ({ severity: c.severity, title: c.title.trim(), detail: c.detail.trim() }));
}

export async function reviewRun(
  anthropic: Anthropic,
  todayRun: TradeRun,
  recentRuns: TradeRun[],
): Promise<ReviewResult> {
  try {
    const resp = await (anthropic.messages as any).create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(todayRun, recentRuns) }],
      },
      { timeout: 45_000 },
    );
    const text = (resp.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    return { concerns: parseConcerns(text) };
  } catch (e) {
    return { concerns: [], error: e instanceof Error ? e.message : String(e) };
  }
}
