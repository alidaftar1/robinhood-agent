import { STALE_DAYS } from "@/lib/strategy";
import { isMainRebalanceDay } from "@/lib/strategy";
import { isMarketHoliday } from "@/lib/holidays";
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
export const REVIEW_HISTORY_DAYS = 15;
/** Date the weekly main-book buy gate went live; runs before this ran buys every weekday.
 *  If the deploy slips past this date, bump it — otherwise a pre-gate run gets stamped with the
 *  new rule and its own main-book buy reads as a bypassed guardrail. */
export const WEEKLY_GATE_EFFECTIVE = "2026-09-22";

function compactRun(r: TradeRun, isRebalanceDay?: boolean) {
  // Cadence context: without it, zero main-book buys plus rising settled cash reads as a broken
  // guardrail rather than the weekly rebalance working as designed.
  return {
    mainBookBuysOpen: isRebalanceDay ?? null,   // per-record, not "today" — history rows carry their own value
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
    // Pre-flight sizing notes: present when a decided buy was shrunk or DROPPED to fit settled
    // buying power. Lets the reviewer cite the exact sizing reason for a missing buy / idle cash
    // instead of inferring "the guardrail isn't deployed" (which mis-reads a working guardrail).
    buySizingAdjustments: r.buySizingAdjustments ?? [],
    // Book β = the book's market sensitivity, INFORMATIONAL only. V1 does NOT target a
    // regime β (the β-overlay trial was retired). Do NOT flag β for "ignoring a regime
    // target" — that was a persistent false positive on a book that is intentionally not
    // beta-targeted (β naturally sits low, dragged by inverse-β names like APA). Only note
    // an extreme β if it signals real concentration risk, not a target mismatch.
    bookBeta: r.bookBeta ? { beta: Number(r.bookBeta.beta.toFixed(2)), coveragePct: Math.round(r.bookBeta.coveragePct) } : null,
  };
}

const SYSTEM_PROMPT = `You are a skeptical quant risk reviewer auditing a live autonomous trading agent's daily run BEFORE its owner sees it.

CADENCE — READ FIRST: the MAIN BOOK rebalances WEEKLY, over a TWO-DAY window: the first two trading
days of the week. Outside that window its BUYS are closed in code. Read "mainBookBuysOpen" on
the run — do not assume which day it is:
  · false (3 weekdays in 5) — zero main-book buys, an unchanged main book and settled cash building
    up are the EXPECTED, CORRECT state. Do NOT raise them as idle-capital, missed-opportunity or
    broken-guardrail concerns. Sells, risk exits and the influencer sleeve still run daily.
  · true (2 weekdays in 5) — buys are OPEN, but zero buys is STILL usually correct: hysteresis keeps
    ◆HELD names, the ${STALE_DAYS}-day time-stop rarely fires, and a whole-share remainder is normally idle.
    Only raise it when MATERIAL settled cash (> ~5% of equity) sat unused across an ENTIRE open
    window with buyable shortlist names present — a single quiet open day is not evidence of
    anything.
  · null — the row predates the weekly gate (it ran under daily buys). Its cadence is unknown; do
    not reason about it, and do not treat a main-book buy on such a row as a bypassed guardrail.
Idle cash is worth raising when it persists THROUGH a full rebalance window with buyable names
available. The owner keeps catching problems the automated checks miss — your job is to catch them first.

You are reviewing a recovered, reconciled run, so do NOT re-report things the deterministic layer already handles (cash reconciliation, missing-sell patching, extreme >30% returns). Look for JUDGMENT-level problems: bad entries, derived numbers that don't add up, concentration drift, signs the morning silently failed and recovered, anything that smells wrong.

You will be given a registry of past misses — explicitly check the current run for a recurrence of each one, but also reason beyond the list.

Be precise and quantitative; cite the actual numbers/tickers from the data. Do not invent data you weren't given. If nothing is wrong, return an empty concerns array — do not manufacture concerns to seem useful.

GROUNDING — never hallucinate absence or mismatch. The TODAY'S RUN JSON gives you the COMPLETE positions and trades arrays. A symbol is held if and only if it appears in the positions array — never claim a position is "missing" or "dropped" unless you have confirmed it is absent from that array; if it is present, it is held. Before asserting any number is wrong, quote the exact field you are citing. A hallucinated "missing position / equity mismatch" concern on data that is actually present is worse than staying silent — it erodes trust in every other concern.

DEFER TO RECONCILIATION — a separate /api/verify pass has already reconciled the stored run against LIVE Robinhood (cash, positions, orders) this morning, and you are given its result below. When verify status is "ok" (or cashDiff ≈ 0 with no position issues), treat stored cash, positions, holdings, and totalValue composition as CONFIRMED CORRECT — do NOT raise cash-reconciliation, missing-position, or composition-mismatch concerns; that is verify's job, not yours. Your job is the JUDGMENT reconciliation cannot make: bad entries, falling-knife buys, concentration drift, a silently self-healed morning, a thesis that contradicts the trades.

INSTRUMENT IDENTITY: every symbol here is a U.S.-listed EQUITY or ETF (the S&P 500 plus an expanded universe of liquid stocks/ETFs, including a few influencer picks). NONE are crypto, futures, forex, or indices. Do NOT assume a ticker is its famous namesake and then call a price "wrong" — e.g. "ES" is Eversource Energy (a ~$70 utility stock), NOT E-mini S&P 500 futures; "BTC" here is a Bitcoin ETF trading at ~$26, NOT bitcoin itself. A low or unfamiliar share price is normal for an equity/ETF; only flag a price as a data error if it's internally inconsistent (e.g. contradicts the same symbol's other figures in this run), never just because it doesn't match a crypto/futures instrument that shares the ticker.

PRICE MAGNITUDE vs. YOUR OWN MEMORY: do not flag a per-share price as a data error just because it sits far outside what you recall that ticker "should" trade at from training-era knowledge — a real, sustained rally (or a reverse split) can genuinely move a familiar name's price far from any prior figure you remember, and a stale mental price range is not evidence of a bug. When /api/verify has already reconciled the run (see DEFER TO RECONCILIATION above) and a position's qty × price matches Robinhood's own live avgCost for that exact symbol, the price came from a real broker fill — do not second-guess it on memorized-price grounds alone, and do not hypothesize that the per-share price field itself is secretly a misrecorded total-dollar-amount when the reconciliation already confirms it. Only flag a price as a genuine anomaly when it's internally inconsistent within THIS run's own data (e.g. it contradicts another figure for the same symbol, or the qty×price math itself doesn't reconcile) — never solely because it's unfamiliar or far from what you'd expect.

Respond with ONLY a JSON object, no prose, in this exact shape:
{"concerns":[{"severity":"high|medium|low","title":"short label","detail":"one or two sentences citing specifics"}]}

Severity: high = likely real money/data error or bad trade needing action today; medium = probable issue worth a look; low = FYI / minor.`;

/** Compact reconciliation result from /api/verify, fed to the reviewer so it
 *  doesn't re-flag (or hallucinate) cash/position/composition mismatches that
 *  the deterministic layer already confirmed against live Robinhood. */
export interface VerifyContext {
  status: string; // "ok" | "discrepancy" | "partial" | "skipped"
  cashDiff: number | null;
  valueDiff: number | null;
  positionIssues: number;
  uncapturedOrders: number;
}

function formatVerify(v?: VerifyContext | null): string {
  if (!v || v.status === "skipped") {
    return `LIVE ROBINHOOD RECONCILIATION: not available this run — you have no live confirmation, so reason from the stored data alone (but still do not invent absences/mismatches).`;
  }
  const reconciled = v.status === "ok" || (v.cashDiff != null && Math.abs(v.cashDiff) < 1 && v.positionIssues === 0);
  return `LIVE ROBINHOOD RECONCILIATION (/api/verify, already run against live Robinhood this morning):
- status: ${v.status}
- cash diff vs live: ${v.cashDiff == null ? "n/a" : `$${v.cashDiff.toFixed(2)}`}
- value diff: ${v.valueDiff == null ? "n/a" : `$${v.valueDiff.toFixed(2)}`} (intraday price drift — informational)
- position issues: ${v.positionIssues}
- uncaptured orders: ${v.uncapturedOrders}
${reconciled
  ? "→ Stored cash, positions, holdings and totalValue composition are CONFIRMED CORRECT against live Robinhood. Do NOT raise cash-reconciliation, missing-position, or composition-mismatch concerns."
  : "→ Reconciliation flagged the discrepancies above; the deterministic layer already patches these — only corroborate, don't duplicate."}`;
}

function buildUserPrompt(todayRun: TradeRun, recentRuns: TradeRun[], verify?: VerifyContext | null): string {
  // History window: a too-short window cannot tell a genuinely unverifiable ancient lot apart from
  // one it simply was not shown — that produced a false "impossible to verify" concern on 08-14
  // when this window was a flat 7 runs.
  const history = recentRuns
    .filter((r) => r.date !== todayRun.date)
    // Pinned to a REVIEWER window, deliberately not STALE_DAYS: that constant moved to 60 while the
    // caller still passes getRuns(30), which made this slice a no-op and roughly doubled the daily
    // reviewer prompt. A held name older than this window shows no buy trade here — the reviewer is
    // told not to treat that as unverifiable (registry #18), so the window is a cost/benefit choice,
    // not a correctness one.
    .slice(0, REVIEW_HISTORY_DAYS)
    // null for dates BEFORE the weekly gate shipped: stamping today's rule on older runs makes a
    // Wed/Thu/Fri row claim "buys closed" while its own trades contain a main-book buy, which reads
    // as a bypassed guardrail rather than as history.
    .map((r) => compactRun(r, r.date >= WEEKLY_GATE_EFFECTIVE ? isMainRebalanceDay(r.date, isMarketHoliday) : undefined));

  return `SCHEDULED trade cron time: ${SCHEDULED_TRADE_CRON_UTC}. A today timestamp materially later than that implies the morning failed at least once and silently recovered.

${formatVerify(verify)}

TODAY'S RUN:
${JSON.stringify(compactRun(todayRun, todayRun.date >= WEEKLY_GATE_EFFECTIVE ? isMainRebalanceDay(todayRun.date, isMarketHoliday) : undefined), null, 2)}

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
  verify?: VerifyContext | null,
): Promise<ReviewResult> {
  try {
    const resp = await (anthropic.messages as any).create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(todayRun, recentRuns, verify) }],
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
