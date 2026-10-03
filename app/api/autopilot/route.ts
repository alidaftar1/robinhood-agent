import { isMainRebalanceDay } from "@/lib/strategy";
import { requireCronAuth } from "@/lib/auth";
import { parseTradeDecision, isFullExit } from "@/lib/trade-decision";
import { dashboardPublicUrl, dashboardLoginUrl, mintLoginToken, EMAIL_LOGIN_TOKEN_TTL_SECONDS } from "@/lib/dashboard-auth";
import { createAnthropic } from "@/lib/anthropic";
import { getRuns, hasAutopilotSentToday, markAutopilotSent, storeAutopilotConcerns, getStoredAutopilotConcerns, formatSummaryForEmail, escapeHtml } from "@/lib/run-store";
import { isMarketHoliday } from "@/lib/holidays";
import { reviewRun, type ReviewConcern } from "@/lib/autopilot-review";
import { reconcileDashboard, type ReconcileFinding } from "@/lib/dashboard-reconcile";
import { computeAttribution, type ChannelStats } from "@/lib/influencer-ledger";
import { computeSignalAttribution, type SignalStat } from "@/lib/signal-ledger";
import { getInfluencerSignals } from "@/lib/influencer-signals";
import { logReviewResult } from "@/lib/braintrust-trace";
import { sendAlert } from "@/lib/alert";

interface VerifyResult {
  status: string;
  discrepancies: string[];
  diff: {
    cashDiff: number | null;
    valueDiff: number | null;
    positionIssues: Array<{ type: string; symbol: string }>;
    uncapturedOrders: unknown[];
  };
  mcpAvailable: { balance: boolean; positions: boolean; orders: boolean };
}

// verify (up to 60s) + the skeptical-reviewer Sonnet pass (up to 45s) run
// sequentially, plus several debug self-fetches — give the function headroom so
// the reviewer can't push the whole autopilot over the limit (Pro allows it).
export const maxDuration = 200;

// How many of a channel's picks the ledger table lists. Enough to audit a hit rate against the
// actual names, few enough that one watchlist video (Everything Money named 17 tickers in a single
// video) does not swamp the email. The overflow is always counted, never silently truncated.
const LEDGER_PICKS_SHOWN = 14;

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

async function sendEmail(subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Robinhood Agent <alerts@agent.dencredible.com>",
      to: [process.env.ALERT_EMAIL ?? ""],
      subject,
      html,
    }),
  });
  return res.ok;
}

// Fire the GitHub Actions cloud autopilot NOW instead of waiting for its own
// schedule. GitHub delays cron-triggered runs by up to ~1.5h; triggering it here
// — right after today's report email goes out — makes the code-fixer run as soon
// as the data is ready (~8:01am PT). The 8:45am workflow cron stays as a fallback.
// Non-fatal: a dispatch failure never breaks the autopilot response. Retries on TRANSIENT errors
// (5xx / network) — GitHub's dispatch endpoint occasionally 503s — so a brief GitHub blip doesn't
// silently skip the cloud autopilot for the day. A 4xx (esp. 401/403) is a real token/perms problem
// and is NOT retried. Returns the final HTTP status so the caller can tell transient from token.
async function dispatchCloudAgent(): Promise<{ ok: boolean; detail: string; status: number }> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return { ok: false, detail: "no GH_DISPATCH_TOKEN", status: 0 };
  let status = -1, detail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        "https://api.github.com/repos/alidaftar1/robinhood-agent/actions/workflows/autopilot.yml/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "robinhood-agent-autopilot",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      status = res.status;
      if (res.status === 204) return { ok: true, detail: "HTTP 204", status: 204 }; // dispatched
      if (res.status < 500) return { ok: false, detail: `HTTP ${res.status}`, status: res.status }; // client/token error — don't retry
      detail = `HTTP ${res.status}`; // 5xx — transient, retry
    } catch (e) {
      status = -1;
      detail = e instanceof Error ? e.message : String(e); // network — transient, retry
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return { ok: false, detail: `${detail} (after 3 tries)`, status };
}

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = todayPT();

  if (isMarketHoliday(today)) {
    return Response.json({ skipped: true, reason: "market holiday" });
  }

  // Idempotency guard FIRST — the cron can retry, and everything below (auto-repair, live verify, the
  // Sonnet skeptical-reviewer + its Braintrust trace, reconcile) is expensive. If today's report
  // already went out, short-circuit before doing any of it. The "sent" mark is only set AFTER a
  // successful email, so a retry following a genuine pre-email failure still falls through and runs
  // fully. force=true bypasses the guard for a deliberate manual re-run.
  const force = new URL(request.url).searchParams.get("force") === "true";
  if (!force && await hasAutopilotSentToday(today)) {
    // Return the STORED concerns from this morning's run — the cloud fixer calls this endpoint after
    // the email already sent, and it needs the reviewConcerns/issues as its work list (not a bare skip).
    const stored = await getStoredAutopilotConcerns(today);
    return Response.json({ skipped: true, reason: "autopilot already sent today", date: today, ...(stored ?? {}) });
  }

  // Use the stable public alias for internal self-fetches. Under the Vercel cron,
  // request.url is the internal deployment URL and self-fetches to it fail (which
  // silently broke auto-repair + live verify). APP_URL/alias resolves correctly.
  const host = process.env.APP_URL || "https://robinhood-agent.vercel.app";
  const secret = process.env.CRON_SECRET ?? "";

  async function callDebug(param: string): Promise<Record<string, string> | null> {
    try {
      const res = await fetch(`${host}/api/debug?${param}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) return null;
      return res.json() as Promise<Record<string, string>>;
    } catch {
      return null;
    }
  }

  let runs = await getRuns(30);
  let todayRun = runs.find((r) => r.date === today) ?? null;

  // CONCRETE anomalies — a specific thing demonstrably went wrong (cron missing, verify
  // discrepancy, decided-vs-executed gap, extreme/impossible derived number). These gate the
  // paid cloud fixer.
  const issues: string[] = [];
  // SOFT heuristics — "this looks like it might warrant a glance." They belong in the email
  // (unchanged) but must NOT spin up a Claude Code session: they fire on perfectly normal
  // behaviour, so they held the cost gate permanently open (see cloudWorthDispatching below).
  const softIssues: string[] = [];
  const autoFixed: string[] = [];
  let selfHealed = false;

  // ─── Self-heal: trigger trade cron if today's run is missing ─────────────────

  if (!todayRun) {
    let triggerOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, 15_000));
      try {
        const tradeRes = await fetch(`${host}/api/trade`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (tradeRes.ok) { triggerOk = true; break; }
        if (attempt === 2)
          issues.push(`Trade cron missing — auto-trigger failed after 2 attempts (${tradeRes.status}).`);
      } catch {
        if (attempt === 2)
          issues.push("Trade cron missing — auto-trigger threw an error after 2 attempts.");
      }
    }
    if (triggerOk) {
      selfHealed = true;
      runs = await getRuns(30);
      todayRun = runs.find((r) => r.date === today) ?? null;
    }
    if (!todayRun) {
      issues.push("Trade cron missing and auto-trigger failed — manual intervention needed.");
    }
  }

  // ─── Auto-repair phase ────────────────────────────────────────────────────────
  // Fix issues mechanically before deciding what to alert on.

  if (todayRun) {
    // Fix 1: Positions that disappeared without a recorded sell.
    // Happens when the sell session times out after orders already landed on Robinhood.
    const prevRun = runs.find(r => r.date < today);
    if (prevRun?.positions?.length) {
      const todaySyms = new Set(todayRun.positions.map(p => p.symbol));
      // Treat existing inferred sells as unconfirmed — patchTrades will re-derive them correctly
      const confirmedSells = new Set(
        (todayRun.trades ?? []).filter(t => t.side === "sell" && t.state !== "inferred").map(t => t.symbol)
      );
      const orphaned = prevRun.positions.filter(p => !todaySyms.has(p.symbol) && !confirmedSells.has(p.symbol));
      if (orphaned.length > 0) {
        const result = await callDebug("patchTrades=1");
        const msg = result?.patchTrades ?? "";
        // Always refetch, even on "no missing sells detected" — that message doesn't mean nothing
        // changed, it can mean patchTrades' OWN independent read (a separate /api/debug call, a beat
        // later) already found the sell recorded, because a concurrently-running cron (e.g. the
        // influencer drop-check, scheduled the same 15:00 UTC minute as this route) landed its
        // saveRun between this route's initial getRuns() and the patchTrades call. Without a refetch,
        // the stale in-memory todayRun (still missing the sell) flows into verify/the reviewer below,
        // producing a false "silently dropped position" concern for a position that is, in the store,
        // already correctly reconciled. Re-derive orphaned against fresh data before flagging anything.
        runs = await getRuns(30);
        todayRun = runs.find(r => r.date === today) ?? todayRun;
        if (msg && !msg.startsWith("error") && !msg.includes("no missing")) {
          autoFixed.push(`Inferred missing sells: ${msg}`);
        } else {
          const freshConfirmedSells = new Set(
            (todayRun.trades ?? []).filter(t => t.side === "sell" && t.state !== "inferred").map(t => t.symbol)
          );
          const freshSyms = new Set(todayRun.positions.map(p => p.symbol));
          const stillOrphaned = orphaned.filter(
            p => !freshSyms.has(p.symbol) && !freshConfirmedSells.has(p.symbol)
          );
          if (stillOrphaned.length > 0) {
            issues.push(
              `Positions disappeared without sell records: ${stillOrphaned.map(p => p.symbol).join(", ")}. Auto-patch: ${msg || "failed"}.`,
            );
          }
        }
      }
    }

    // Fix 2: Today's return is null but all data needed to compute it is present.
    if (todayRun.agenticDailyReturn == null && todayRun.portfolioAfter) {
      const prevRun2 = runs.find(r => r.date < today);
      if (prevRun2?.portfolioAfter) {
        const result = await callDebug(`patchDate=${today}`);
        const msg = result?.patchDate ?? "";
        if (msg && !msg.startsWith("error") && !msg.includes("not found")) {
          autoFixed.push(`Computed missing return: ${msg}`);
          runs = await getRuns(30);
          todayRun = runs.find(r => r.date === today) ?? todayRun;
        }
      }
    }
  }

  // Fix 3: Bogus 0% return on the oldest run (first-ever run had same-day baseline).
  {
    const chronological = [...runs].reverse();
    const oldest = chronological[0];
    if (oldest && oldest.agenticDailyReturn === 0) {
      const hasPrior = runs.some(r => r.date < oldest.date);
      if (!hasPrior) {
        const result = await callDebug(`clearReturnForDate=${oldest.date}`);
        const msg = result?.clearReturnForDate ?? "";
        if (msg && !msg.startsWith("error")) {
          autoFixed.push(`Cleared bogus 0% inception return on ${oldest.date}`);
        }
      }
    }
  }

  // ─── Live Robinhood verification ─────────────────────────────────────────────
  // /api/verify runs Haiku+MCP server-side — compares live state to stored run.

  let verifyResult: VerifyResult | null = null;

  try {
    const verifyRes = await fetch(`${host}/api/verify`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (verifyRes.ok) {
      verifyResult = await verifyRes.json() as VerifyResult;
    }
  } catch {
    // Verification failed — non-fatal, note in email
  }

  if (verifyResult) {
    if (verifyResult.status === "discrepancy") {
      // Auto-fix: if position issues include missing-sell, run patchTrades
      const posIssues = verifyResult.diff?.positionIssues ?? [];
      const hasMissingSell = posIssues.some((p: any) => p.type === "missing_from_live_no_sell_record");
      if (hasMissingSell) {
        const result = await callDebug("patchTrades=1");
        const msg = result?.patchTrades ?? "";
        if (msg && !msg.startsWith("error")) {
          autoFixed.push(`Live verify found missing sells — re-patched: ${msg}`);
          runs = await getRuns(30);
          todayRun = runs.find(r => r.date === today) ?? todayRun;
        }
      }
      // Surface remaining discrepancies as issues
      const remaining = verifyResult.discrepancies.filter((d: string) => {
        if (hasMissingSell && d.includes("no sell record")) return false;
        return true;
      });
      for (const d of remaining) {
        issues.push(`Live verify: ${d}`);
      }
    } else if (verifyResult.status === "partial") {
      const missing = Object.entries(verifyResult.mcpAvailable ?? {})
        .filter(([, v]) => !v).map(([k]) => k).join(", ");
      autoFixed.push(`Live verify partial (MCP timeout on: ${missing || "unknown"}) — comparison incomplete.`);
    }
  } else {
    autoFixed.push("Live verify skipped — /api/verify unavailable.");
  }

  // ─── Derive display data from (possibly repaired) run ────────────────────────

  const trades = todayRun?.trades ?? [];
  const buyingPower = todayRun?.portfolioAfter?.cash ?? null;
  const totalValue = todayRun?.portfolioAfter?.totalValue ?? null;
  const positions = todayRun?.positions ?? [];
  const agenticReturn = todayRun?.agenticDailyReturn;
  const personalReturn = todayRun?.personalDailyReturn;
  const impliedTransfer = todayRun?.agenticImpliedTransfer;

  // ─── Validation phase (post-repair) ──────────────────────────────────────────

  // SOFT: standing pat with cash on hand is an explicitly VALID outcome (the prompt tells the
  // model buys=[] is correct on a day with no qualifying signal), so this fires on ordinary days.
  // Worth surfacing in the email, never worth a paid agentic run on its own.
  if (trades.length === 0 && buyingPower && parseFloat(buyingPower) > 50) {
    // Cadence-aware: main-book buys only run inside the weekly rebalance window, so on the other
    // three weekdays "no trades + cash" is the DESIGNED state, not a signal. Saying "possible
    // analysis issue" there is a false alarm in the email and in the cloud fixer's work list.
    // Only an ISSUE when buys were actually open. Outside the window this is the designed state on
    // 3 weekdays in 5 — pushing it regardless would flip the email to "NEEDS ATTENTION" on most days
    // (softIssues feeds allIssues -> needsAttention -> the stored work list), desensitising the
    // banner for real problems. Logged, not raised.
    if (isMainRebalanceDay(today, isMarketHoliday)) {
      softIssues.push(
        `No trades executed but buying power is $${parseFloat(buyingPower).toFixed(2)} — possible analysis issue (main-book buys were OPEN today).`,
      );
    } else {
      console.log("NO_TRADES_OUTSIDE_REBALANCE_WINDOW — expected", { buyingPower });
    }
  }

  if (agenticReturn != null && Math.abs(agenticReturn) > 0.30) {
    issues.push(
      `Extreme return (${(agenticReturn * 100).toFixed(1)}%) — likely a data error. Check implied transfer and sell records.`,
    );
  }

  if (impliedTransfer != null && Math.abs(impliedTransfer) > 300) {
    const direction = impliedTransfer > 0 ? "deposit" : "withdrawal";
    autoFixed.push(
      `Detected large ${direction} (~$${Math.abs(impliedTransfer).toFixed(0)}) — return is transfer-adjusted.`,
    );
  }

  // Intent-vs-execution: the agent DECIDED to trade something but it didn't happen.
  // Catches a silently dropped/rejected order that data-consistency checks miss —
  // the BAX case on the SELL side, the GPN case on the BUY side. Flag only; the next
  // run re-attempts (sells auto-retry in the pipeline; buys retry + shrink-to-fit).
  if (todayRun?.summary) {
    // Shared tolerant extraction (lib/trade-decision.ts). This check is the deterministic half of
    // the decided-vs-executed safety net; on 2026-09-01 its own strict regex was defeated by a
    // markdown-bolded marker at the same moment the executor's was, so the run that placed zero of
    // its three decided sells raised nothing here. Never re-inline a regex for this.
    const parsedDecision = parseTradeDecision(todayRun.summary);
    if (parsedDecision.status === "unparsed") {
      // The run's own summary contains a decision the executor could not read — meaning nothing it
      // decided was placed, for a formatting reason. Louder than any single dropped order.
      issues.push(
        `Run emitted a TRADE_DECISION that could not be read (${parsedDecision.reason}) — NO orders were placed for it. NOT a stand-pat day: either the model\u2019s output was truncated mid-payload or lib/trade-decision.ts met a shape it cannot parse.`,
      );
    } else if (parsedDecision.status === "parsed") {
      const decided = parsedDecision.decision;
      const heldSyms = new Set(todayRun.positions.map((p) => p.symbol));
      const boughtSyms = new Set((todayRun.trades ?? []).filter((t) => t.side === "buy").map((t) => t.symbol));
      // Only a FULL exit should have emptied the position. A trim deliberately leaves the symbol
      // held, so filtering on "still held" alone flagged every concentration trim as a dropped
      // order (TRGP, 2026-09-15) — and, since this list gates the paid cloud dispatch, paid for a
      // Claude Code run to investigate a non-event.
      // PRE-trade quantity: the executor clamps a numeric `quantity` against what was held BEFORE
      // the sale. Reading the post-trade snapshot instead made any numeric sell of >=50% look like
      // a full exit (10 held, sell 6, snapshot 4 -> "6 >= 4" -> full exit -> "still held!"), which
      // false-alarms a correctly executed trim and dispatches the paid cloud agent for it.
      const soldTodayQty = new Map<string, number>();
      for (const t of todayRun.trades ?? []) {
        if (t.side !== "sell") continue;
        soldTodayQty.set(t.symbol, (soldTodayQty.get(t.symbol) ?? 0) + (parseFloat(t.quantity) || 0));
      }
      const heldQtyOf = new Map(
        todayRun.positions.map((p) => [p.symbol, (parseFloat(p.quantity) || 0) + (soldTodayQty.get(p.symbol) ?? 0)]),
      );
      // A buy that a guard dropped ON PURPOSE already explains itself in buySizingAdjustments
      // (off-rails, cap, budget, dust, cooldown, did-not-confirm). Re-reporting it as an unexplained
      // anomaly is the noise registry entries #19/#25 exist to prevent — and it dispatches the paid
      // cloud agent at a guard doing its job. Only an absent buy with NO note is a real anomaly.
      // Match only notes recording a DELIBERATE guard drop. Matching "any note mentioning the
      // symbol" silently swallowed the opposite case: "<SYM> buy DID NOT CONFIRM after retry" and
      // "<SYM> $200→$150 (shrunk to fit budget)" both mention the symbol, so a genuine execution
      // failure — the AMAT 2026-08-31 case — would be suppressed by the very note added to make it
      // visible. The symbol is matched with a boundary so a note about AAPL cannot explain away a
      // dropped buy of ticker L.
      // Case-SENSITIVE on purpose: the guards emit uppercase verbs ("<SYM> buy DROPPED —",
      // "Influencer buy REJECTED —", "<SYM> re-buy BLOCKED —"), while lib/buy-sizing.ts also emits
      // lowercase prose that merely SPECULATES ("...may be rejected or crowd out later buys") for a
      // buy that was NOT dropped. Matching that case-insensitively would explain away a genuine
      // execution failure.
      const GUARD_DROP = /\b(DROPPED|BLOCKED|REJECTED)\b|off-rails/;
      const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const explained = (sym: string) => {
        // `symbol` comes straight from model output and is never validated, so an unescaped `(` or
        // `[` would throw SyntaxError here — uncaught, that 500s the whole autopilot GET and kills
        // the morning report. `BRK.B` would also compile to a wildcard matching `BRK-B`.
        const symRe = new RegExp(`(^|[^A-Z0-9.])${escapeRe(sym)}([^A-Z0-9.]|$)`);
        return (todayRun.buySizingAdjustments ?? []).some((note) => GUARD_DROP.test(note) && symRe.test(note));
      };

      const notSold = decided.sells
        .filter((s) => isFullExit(s, heldQtyOf.get(String(s.symbol))))
        .map((s) => String(s.symbol))
        .filter((sym) => heldSyms.has(sym))
        // Same treatment buys already got. A sell a guard dropped ON PURPOSE explains itself in
        // buySizingAdjustments; re-reporting it as an anomaly dispatches the paid cloud agent at a
        // guard doing its job AND tells the owner to manually place the exact sell that was
        // deliberately blocked. The sell-volume rail made that reachable — before it, no guard
        // dropped a sell, which is why this filter existed on one side only.
        .filter((sym) => !explained(sym));
      if (notSold.length > 0) {
        issues.push(
          `Decided to sell ${notSold.join(", ")} but still held — sell order(s) dropped. Next run should re-attempt; place manually if it persists.`,
        );
      }

      const notBought = decided.buys
        .map((b) => String(b.symbol))
        .filter((sym) => !boughtSyms.has(sym) && !explained(sym));
      if (notBought.length > 0) {
        issues.push(
          `Decided to buy ${notBought.join(", ")} but no confirmed buy — likely insufficient buying power (sells settle T+1) or a dropped order. Buy-sizing + retry should limit this; flag if it persists.`,
        );
      }
    }
  }

  // ─── Skeptical-reviewer pass ───────────────────────────────────────────────
  // The deterministic checks above verify the END STATE. This Sonnet pass forms a
  // JUDGMENT on the (recovered) run — falling-knife buys, derived metrics that
  // don't add up, silent self-heals, sector drift — reading a registry of things
  // the owner has caught before. Non-fatal: a failure just notes itself.

  let reviewConcerns: ReviewConcern[] = [];
  if (todayRun) {
    const anthropic = createAnthropic();
    // Hand the reviewer verify's reconciliation so it doesn't re-flag (or hallucinate)
    // cash/position/composition mismatches the deterministic layer already confirmed.
    const verifyContext = verifyResult
      ? {
          status: verifyResult.status,
          cashDiff: verifyResult.diff?.cashDiff ?? null,
          valueDiff: verifyResult.diff?.valueDiff ?? null,
          positionIssues: (verifyResult.diff?.positionIssues ?? []).length,
          uncapturedOrders: (verifyResult.diff?.uncapturedOrders ?? []).length,
        }
      : null;
    const review = await reviewRun(anthropic, todayRun, runs, verifyContext);
    reviewConcerns = review.concerns;
    if (review.error) {
      autoFixed.push(`Skeptical-reviewer pass could not run (${review.error}).`);
    }
    // Surface the reviewer's verdict + scores in Braintrust (fail-safe, never blocks the report).
    await logReviewResult({ run: todayRun, result: review }).catch(() => {});
  }
  // high/medium concerns are actionable → they flip the status; low are FYI only.
  const seriousConcerns = reviewConcerns.filter((c) => c.severity !== "low");

  // Deterministic audit of the dashboard's derived numbers — the presentation layer no other
  // reviewer checks (sleeve-return artifacts, stale sleeve membership, gaps, the influencer squat).
  // Wrapped so a bad record can never break the daily report.
  let reconcileFindings: ReconcileFinding[] = [];
  try { reconcileFindings = reconcileDashboard(runs); }
  catch (e) { autoFixed.push(`Dashboard reconciliation could not run (${e}).`); }
  const seriousReconcile = reconcileFindings.filter((f) => f.severity !== "low");

  // Influencer-pick attribution: which YouTubers' picks are actually working. Read-only,
  // fail-safe (an observability aid — must never break the report). Meaningful only once
  // picks have some age; day-0 picks read ~0% by construction.
  let ledgerChannels: ChannelStats[] = [];
  let ledgerBelowFloor: ChannelStats[] = [];
  try { ({ channels: ledgerChannels, channelsBelowFloor: ledgerBelowFloor } = await computeAttribution(today)); }
  catch { /* ledger is best-effort; skip the section if it can't compute */ }
  const agedChannels = ledgerChannels.filter((c) => c.avgReturnPct !== 0 || c.hitRatePct !== 0);

  // Signal-attribution ledger: which entry signals (★INS, ⚡NEWS, ↓FIRM, earnings record, …) have
  // predicted, from our own buys. Best-effort; empty until buys accumulate.
  let signalStats: SignalStat[] = [];
  let signalBuysLogged = 0;
  try { const a = await computeSignalAttribution(today); signalStats = a.signals; signalBuysLogged = a.picks.length; }
  catch { /* best-effort */ }

  // This week's raw influencer signals (buys / avoids / insights) from the 6am cache refresh —
  // informational visibility into what the creators are actually saying. Fail-safe.
  const influencerCache = await getInfluencerSignals().catch(() => null);
  const buyScores = influencerCache?.tickerCounts ?? {};
  const avoidScores = influencerCache?.avoidCounts ?? {};
  const topBuys = Object.entries(buyScores)
    .sort(([, a], [, b]) => b - a).slice(0, 8);
  // A ticker can be BOTH bought and avoided across DIFFERENT creators (legit disagreement — the
  // per-video extractor already bars a single video from listing it in both). Show it in Avoid ONLY
  // when the bearish signal is NET dominant (avoid count > buy score) — otherwise a strong buy with
  // one lone dissenter (MU 10-buy/1-avoid) reads as a contradictory "buy AND avoid".
  const topAvoids = Object.entries(avoidScores)
    .filter(([t, a]) => a > (buyScores[t] ?? 0))
    .sort(([, a], [, b]) => b - a).slice(0, 6);
  const insights = (influencerCache?.signals ?? [])
    .filter((s) => s.insight && s.insight.length > 0)
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
    .slice(0, 5)
    .map((s) => ({ channel: s.channelName, text: s.insight as string }));
  const hasInfluencerDigest = topBuys.length > 0 || topAvoids.length > 0 || insights.length > 0;
  // When the digest is empty, say WHY — a silently-omitted section can't distinguish "creators said
  // nothing actionable" from "the transcript pipeline is down/quota-exhausted" (they both render as
  // nothing). Coverage is the tell: 0 candidate videos = upstream YouTube fetch problem; LOW coverage
  // (transcripts on < half the videos — normally ~all, since Supadata auto-Whispers captionless ones)
  // = the transcript source is down or over quota, whether it fails from the start or trips mid-run.
  const cov = influencerCache?.transcriptCoverage;
  const yt = influencerCache?.youtubeHealth;
  const influencerEmptyReason = !influencerCache
    ? "the weekly cache is unavailable — the 6am refresh may have failed"
    // Only claim the emptiness is UNINFORMATIVE when the quota actually starved the run. A partial
    // exhaustion (3 of 9 channels) can still leave 40 videos seen, in which case an empty sleeve
    // really does say something about what creators posted.
    : yt?.quotaExceeded && (cov?.videos === 0 || yt.failed === yt.channels)
      // "quota or rate limit": the same 403 family covers a daily-quota burn and a seconds-long
      // rate limit, and telling the owner their whole day is gone when it is not sends them to
      // fix nothing. Both self-clear; that is the part they need.
      ? `the YouTube Data API returned a quota/rate-limit 403 on ${yt.quotaFailed}/${yt.channels} channels and no videos were retrieved — an empty sleeve here says nothing about what creators posted. This self-clears (a short rate limit in seconds, a spent daily quota at the reset). NOTE the quota is per-GCP-project, so it can be consumed by something that is not this system.`
      : yt && yt.channels > 0 && yt.failed > yt.channels / 2
        ? `${yt.failed}/${yt.channels} YouTube channel fetches FAILED${yt.quotaFailed ? ` (${yt.quotaFailed} quota/rate-limit)` : " (non-quota)"} — treat this as an outage, not as a quiet week`
        : cov && cov.videos === 0
          ? "no candidate videos were found this week — verify the upstream YouTube fetch isn't failing"
          : cov && cov.withTranscript < cov.videos / 2
            ? `low transcript coverage (${cov.withTranscript}/${cov.videos} videos) — the transcript source (Supadata) looks down or over its plan quota, so the sleeve ran mostly blind on titles only`
            : "creators named no qualifying picks this week — an empty sleeve is a valid outcome";

  // ─── Email ────────────────────────────────────────────────────────────────────

  // Email status — deliberately BROAD and unchanged: anything worth your glance flips the banner.
  const allIssues = [...issues, ...softIssues];
  const needsAttention = allIssues.length > 0 || seriousConcerns.length > 0 || seriousReconcile.length > 0;
  const statusLabel = needsAttention ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY";
  const statusColor = needsAttention ? "#f59e0b" : "#10b981";

  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");

  const fmt = (r: number | null | undefined) =>
    r != null ? `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%` : "—";

  const row = (label: string, value: string, bg = "transparent") =>
    `<tr style="background:${bg}">
      <td style="padding:5px 10px;color:#6b7280;white-space:nowrap">${label}</td>
      <td style="padding:5px 10px">${value}</td>
    </tr>`;

  const dashboardUrl = dashboardPublicUrl(host);
  // One-click login for the PRIVATE dashboard. mintLoginToken returns null if Redis is unavailable
  // or the write fails, in which case the private link is simply omitted — never a broken link, and
  // never a fallback that puts DASHBOARD_SECRET in an email. The token is single-use (GETDEL on
  // redeem), scrubbed from Sentry, and grants dashboard READ access only.
  // BOUNDED. redisCommand carries no timeout, so a hung Upstash would stall this await and take
  // the 8am digest with it — trading a convenience link for the day's report. On timeout we fall
  // back to exactly the documented null path: no private link, email still sends.
  const loginToken = await Promise.race([
    mintLoginToken(EMAIL_LOGIN_TOKEN_TTL_SECONDS),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 4_000)),
  ]).catch(() => null);
  const privateUrl = loginToken ? dashboardLoginUrl(loginToken, host) : null;

  const html = `
<div style="font-family:monospace;max-width:600px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 4px">Robinhood Agent — ${today} Report</h2>
  <p style="color:${statusColor};font-size:18px;font-weight:bold;margin:8px 0">${statusLabel}</p>
  ${selfHealed ? `<p style="color:#6b7280;font-size:13px;margin:4px 0">⚡ Trade cron was missing — auto-triggered and recovered.</p>` : ""}
  <hr style="border:1px solid #e5e7eb;margin:16px 0"/>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    ${row("Portfolio value", totalValue ? `$${parseFloat(totalValue).toFixed(2)}` : "—")}
    ${row("Buying power", buyingPower ? `$${parseFloat(buyingPower).toFixed(2)}` : "—", "#f9fafb")}
    ${row("Agentic return", fmt(agenticReturn))}
    ${row("Personal return", fmt(personalReturn), "#f9fafb")}
    ${row("Buys", buys.length > 0 ? buys.map((t) => `${t.symbol} ×${t.quantity} @$${t.avgPrice}`).join(", ") : "none")}
    ${row("Sells", sells.length > 0 ? sells.map((t) => `${t.symbol} ×${t.quantity} @$${t.avgPrice}${t.state === "inferred" ? " (inferred)" : ""}`).join(", ") : "none", "#f9fafb")}
    ${row("Positions", positions.length > 0 ? positions.map((p) => p.symbol).join(", ") : "none")}
  </table>

  ${autoFixed.length > 0
    ? `<div style="background:#ecfdf5;border-left:4px solid #10b981;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔧 Auto-repaired:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${autoFixed.map((f) => `<li>${f}</li>`).join("")}</ul>
  </div>`
    : ""}

  ${allIssues.length > 0
    ? `<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>⚠️ Needs attention:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${allIssues.map((i) => `<li>${i}</li>`).join("")}</ul>
  </div>`
    : ""}

  ${reviewConcerns.length > 0
    ? `<div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔍 Skeptical-reviewer concerns:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${reviewConcerns
      .map((c) => {
        const tag = c.severity === "high" ? "🔴" : c.severity === "medium" ? "🟠" : "⚪";
        // escaped: both fields are LLM prose that quotes the run summary back (see escapeHtml)
        return `<li><strong>${tag} ${escapeHtml(c.title)}</strong> — ${escapeHtml(c.detail)}</li>`;
      })
      .join("")}</ul>
  </div>`
    : ""}

  ${reconcileFindings.length > 0
    ? `<div style="background:#f5f3ff;border-left:4px solid #8b5cf6;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>📊 Dashboard reconciliation:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">${reconcileFindings
      .map((f) => {
        const tag = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟠" : "⚪";
        // deterministic text today, but it interpolates symbols and free-form detail — same rule
        return `<li><strong>${tag} ${escapeHtml(f.title)}</strong> — ${escapeHtml(f.detail)}</li>`;
      })
      .join("")}</ul>
  </div>`
    : ""}

  ${hasInfluencerDigest
    ? `<div style="background:#fefce8;border-left:4px solid #eab308;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer signals this week:</strong>
    ${topBuys.length > 0 ? `<p style="margin:6px 0 0;font-size:13px"><strong style="color:#059669">Buys:</strong> ${topBuys.map(([t, s]) => `${t} (${s})`).join(", ")}</p>` : ""}
    ${topAvoids.length > 0 ? `<p style="margin:6px 0 0;font-size:13px"><strong style="color:#dc2626">Avoid:</strong> ${topAvoids.map(([t, s]) => `${t} (${s})`).join(", ")}</p>` : ""}
    ${insights.length > 0 ? `<p style="margin:8px 0 2px;font-size:13px"><strong>Insights:</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${insights.map((i) => `<li><span style="color:#6b7280">[${escapeHtml(i.channel)}]</span> ${escapeHtml(i.text)}</li>`).join("")}</ul>` : ""}
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af">Informational — buys feed the sleeve (score ≥ 3); avoids/insights are visibility only, not wired into trades.</p>
  </div>`
    : `<div style="background:#f9fafb;border-left:4px solid #9ca3af;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer signals this week:</strong>
    <p style="margin:6px 0 0;font-size:13px;color:#6b7280">None — ${influencerEmptyReason}.</p>
  </div>`}

  ${ledgerChannels.length > 0
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🎬 Influencer-pick ledger — which channels' picks work:</strong>
    ${agedChannels.length === 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">Tracking ${ledgerChannels.length} channels — picks logged recently still read ~0%; forward returns accumulate over the coming days.</p>`
      : `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
      <tr style="color:#6b7280"><td style="padding:3px 8px">Channel</td><td style="padding:3px 8px;text-align:right">Picks</td><td style="padding:3px 8px;text-align:right">Hit</td><td style="padding:3px 8px;text-align:right">Avg ret</td><td style="padding:3px 8px;text-align:right">vs SPY</td><td style="padding:3px 8px;text-align:right">vs sector</td><td style="padding:3px 8px;text-align:right">vs peers</td></tr>
      ${agedChannels.slice(0, 8).map((c) =>
        `<tr><td style="padding:3px 8px">${escapeHtml(c.channel)}${c.picks < 4 ? ` <span style="color:#9ca3af;font-size:11px">thin</span>` : ""}${c.inheritedPicks > 0 ? ` <span style="color:#9ca3af;font-size:11px" title="credited from the ticker's first sighting, not this channel's own first mention">${c.inheritedPicks}/${c.picks} inherited</span>` : ""}${c.alphaPicks < c.picks ? ` <span style="color:#9ca3af;font-size:11px" title="picks with a SPY baseline; the rest are excluded from vs SPY">${c.alphaPicks}/${c.picks} vs-SPY</span>` : ""}${c.closedPicks > 0 ? ` <span style="color:#9ca3af;font-size:11px" title="credits frozen at the channel's own AVOID call — measured to that close, not to today">${c.closedPicks} closed</span>` : ""}${c.pendingPicks > 0 ? ` <span style="color:#9ca3af;font-size:11px" title="window not finished (no avoid yet, under 30 days old) — excluded from every stat on this row">${c.pendingPicks} pending</span>` : ""}${c.medianHoldDays != null ? ` <span style="color:#9ca3af;font-size:11px" title="median days held; earliest-wins means windows are NOT uniform, capped at 30">~${c.medianHoldDays}d</span>` : ""}</td><td style="padding:3px 8px;text-align:right">${c.picks}</td><td style="padding:3px 8px;text-align:right">${c.hitRatePct.toFixed(0)}%</td><td style="padding:3px 8px;text-align:right;color:${c.avgReturnPct >= 0 ? "#059669" : "#dc2626"}">${c.avgReturnPct >= 0 ? "+" : ""}${c.avgReturnPct.toFixed(1)}%</td><td style="padding:3px 8px;text-align:right;font-weight:bold;color:${c.avgAlphaPct == null ? "#9ca3af" : c.avgAlphaPct >= 0 ? "#059669" : "#dc2626"}">${c.avgAlphaPct != null ? `${c.avgAlphaPct >= 0 ? "+" : ""}${c.avgAlphaPct.toFixed(1)}%` : "—"}</td>` +
        `<td style="padding:3px 8px;text-align:right;font-weight:bold;color:${c.avgSectorAlphaPct == null ? "#9ca3af" : c.avgSectorAlphaPct >= 0 ? "#059669" : "#dc2626"}">${c.avgSectorAlphaPct != null ? `${c.avgSectorAlphaPct >= 0 ? "+" : ""}${c.avgSectorAlphaPct.toFixed(1)}%` : "—"}${c.sectorPicks > 0 && c.sectorPicks < c.picks ? `<span style="color:#9ca3af;font-size:10px"> ${c.sectorPicks}/${c.picks}</span>` : ""}</td>` +
        `<td style="padding:3px 8px;text-align:right;color:${c.avgPeerRelPct == null ? "#9ca3af" : c.avgPeerRelPct >= 0 ? "#059669" : "#dc2626"}">${c.avgPeerRelPct != null ? `${c.avgPeerRelPct >= 0 ? "+" : ""}${c.avgPeerRelPct.toFixed(1)}%` : "—"}</td></tr>` +
        // The constituents, so a hit rate can be checked against what the channel actually named.
        // Winners first; green/red per pick. Capped so one watchlist video naming 17 tickers cannot
        // swamp the email — the overflow count stays visible rather than the list silently ending.
        `<tr><td colspan="7" style="padding:0 8px 6px 8px;font-size:11px;color:#6b7280;line-height:1.6">${
          c.tickerReturns.slice(0, LEDGER_PICKS_SHOWN).map(t =>
            `<span style="color:${t.retPct >= 0 ? "#059669" : "#dc2626"}">${escapeHtml(t.ticker)} ${t.retPct >= 0 ? "+" : ""}${t.retPct.toFixed(0)}%${t.closed ? "⏹" : ""}</span>`
          ).join(" · ")
        }${c.tickerReturns.length > LEDGER_PICKS_SHOWN ? ` <span style="color:#9ca3af">+${c.tickerReturns.length - LEDGER_PICKS_SHOWN} more</span>` : ""}</td></tr>`
      ).join("")}
    </table>
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af"><strong>vs SPY</strong> = average return above/below the S&amp;P over each pick's own window — the real edge, stripped of the market's move (channels are ranked by it). Each pick is measured from the first close after the channel named it until the EARLIER of its own ⏹avoid call or 30 days, so a channel is neither charged for moves after it said get out nor credited for drift it never called. Unfinished windows are excluded and shown as "pending". <strong>Below the buy floor</strong> (net 1-2, tracked but never bought): ${(() => {
      const rows = ledgerBelowFloor;
      const n = rows.reduce((a, c) => a + c.picks, 0);
      if (n === 0) return "no picks yet";
      const w = (sel: (c: ChannelStats) => number | null) => {
        let num = 0, den = 0;
        for (const c of rows) { const v = sel(c); if (v != null) { num += v * c.picks; den += c.picks; } }
        return den ? num / den : null;
      };
      const sec = w(c => c.avgSectorAlphaPct);
      const above = ledgerChannels.reduce((a, c) => a + c.picks, 0);
      return `${n} picks vs ${above} at or above it; vs sector ${sec != null ? `${sec >= 0 ? "+" : ""}${sec.toFixed(1)}%` : "—"}. If this is not clearly WORSE than the ranked rows above, the floor is not earning its keep.`;
    })()}<br/><br/><strong>vs sector</strong> = the same, against the pick's OWN sector ETF — these picks are mostly AI/semis, so vs-SPY leaves a large common factor in, which is both why the noise is high and why the picks are correlated. Channels are RANKED by it. <strong>vs peers</strong> = against the average pick whose window overlaps, which differences out the regime entirely. Small, correlated samples — a ranking hint, not a verdict; "thin" = very few picks.</p>`}
  </div>`
    : ""}

  ${signalBuysLogged > 0
    ? `<div style="background:#f0fdf4;border-left:4px solid #10b981;padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>🔬 Signal ledger — which entry signals work:</strong>
    ${signalStats.length === 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">Logged ${signalBuysLogged} buy${signalBuysLogged === 1 ? "" : "s"} — forward returns accumulate over the coming days.</p>`
      : `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
      <tr style="color:#6b7280"><td style="padding:3px 8px">Signal at buy</td><td style="padding:3px 8px;text-align:right">Buys</td><td style="padding:3px 8px;text-align:right">Hit</td><td style="padding:3px 8px;text-align:right">Avg ret</td><td style="padding:3px 8px;text-align:right">vs avg pick</td></tr>
      ${signalStats.slice(0, 8).map((s) =>
        `<tr><td style="padding:3px 8px">${s.signal}${s.picks < 4 ? ` <span style="color:#9ca3af;font-size:11px">thin</span>` : ""}</td><td style="padding:3px 8px;text-align:right">${s.picks}</td><td style="padding:3px 8px;text-align:right">${s.hitRatePct.toFixed(0)}%</td><td style="padding:3px 8px;text-align:right;color:${s.avgReturnPct >= 0 ? "#059669" : "#dc2626"}">${s.avgReturnPct >= 0 ? "+" : ""}${s.avgReturnPct.toFixed(1)}%</td><td style="padding:3px 8px;text-align:right;font-weight:bold;color:${s.vsBaselinePct >= 0 ? "#059669" : "#dc2626"}">${s.vsBaselinePct >= 0 ? "+" : ""}${s.vsBaselinePct.toFixed(1)}%</td></tr>`
      ).join("")}
    </table>
    <p style="margin:6px 0 0;font-size:11px;color:#9ca3af"><strong>vs avg pick</strong> = a signal's buys' average forward return minus the average over ALL buys (positive = the signal beat the typical pick; ranked by it). From our own trades, measured forward — small, mixed-horizon samples early, so a hint not a verdict.</p>`}
  </div>`
    : ""}

  ${verifyResult ? `<div style="background:${verifyResult.status === "ok" ? "#ecfdf5" : verifyResult.status === "discrepancy" ? "#fef3c7" : "#f3f4f6"};border-left:4px solid ${verifyResult.status === "ok" ? "#10b981" : verifyResult.status === "discrepancy" ? "#f59e0b" : "#9ca3af"};padding:12px 16px;margin-bottom:16px;border-radius:4px">
    <strong>Live Robinhood verify: ${verifyResult.status.toUpperCase()}</strong>
    ${verifyResult.diff?.cashDiff != null ? `<p style="margin:6px 0 0;font-size:13px">Cash diff: ${verifyResult.diff.cashDiff >= 0 ? "+" : ""}$${verifyResult.diff.cashDiff.toFixed(2)} | Value diff: ${verifyResult.diff.valueDiff != null ? `${verifyResult.diff.valueDiff >= 0 ? "+" : ""}$${verifyResult.diff.valueDiff.toFixed(2)}` : "—"}</p>` : ""}
    ${verifyResult.status !== "ok" && verifyResult.discrepancies.length > 0 ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:13px">${verifyResult.discrepancies.map(d => `<li>${d}</li>`).join("")}</ul>` : ""}
    <p style="margin:6px 0 0;font-size:11px;color:#6b7280">MCP: balance=${verifyResult.mcpAvailable?.balance} positions=${verifyResult.mcpAvailable?.positions} orders=${verifyResult.mcpAvailable?.orders}</p>
  </div>` : `<div style="background:#f3f4f6;border-left:4px solid #9ca3af;padding:12px 16px;margin-bottom:16px;border-radius:4px"><strong>Live verify:</strong> skipped — endpoint unavailable</div>`}

  ${todayRun?.summary
    ? `<div style="background:#f3f4f6;padding:12px 16px;border-radius:4px;margin-bottom:16px">
    <strong>Run summary:</strong>
    <p style="margin:8px 0 0;white-space:pre-wrap;font-size:13px">${formatSummaryForEmail(todayRun.summary)}</p>
  </div>`
    : ""}

  <p style="font-size:12px;color:#9ca3af;margin-top:24px">
    Sent by Vercel cron at 8am PT — no Mac required.<br/>
    ${privateUrl
      ? `<a href="${privateUrl}">Open private dashboard</a> &nbsp;·&nbsp; <a href="${dashboardUrl}">public view</a><br/>
    <span style="color:#9ca3af">One-time login link — works once, expires in 12 hours. If it shows a login screen, the link was already used (a mail scanner or preview fetch can consume it) — use your dashboard key that time.</span>`
      : `<a href="${dashboardUrl}">Open dashboard</a>`}
  </p>
</div>`;

  // The already-sent short-circuit + force are handled at the top of the handler. If we reach here we
  // either haven't emailed today or force=true — so always send.
  const subject = `Robinhood Agent — ${today} ${needsAttention ? "⚠️ NEEDS ATTENTION" : "✅ HEALTHY"}`;
  const emailSent = await sendEmail(subject, html);
  if (emailSent && !force) await markAutopilotSent(today);
  // Persist the reviewer output as the cloud fixer's work list (it reads this endpoint AFTER the
  // email sent → the skip path returns these). Store regardless of email success so it's never lost.
  // allIssues, not `issues` — the cloud fixer's work list keeps the SAME contents it always had.
  // Only the dispatch DECISION is narrowed (see cloudWorthDispatching); on the days the agent does
  // run, withholding the soft heuristic would just deprive it of context it used to have.
  await storeAutopilotConcerns(today, { date: today, status: statusLabel, reviewConcerns, issues: allIssues, autoFixed, verifyStatus: verifyResult?.status ?? "skipped" });

  // Trigger the cloud code-fixer immediately, but ONLY on the scheduled cron run
  // (vercel.json sets ?cloudDispatch=1) and ONLY when a fresh email just went out.
  // The once-per-day email dedup makes this fire at most once/day, and the cloud
  // agent's own bare-path reads of this endpoint never re-trigger it (no loop).
  // Cost gate: the cloud agent is a full (Sonnet) Claude Code run — by far the largest line on
  // the Anthropic bill, and API-billed separately from the Max subscription.
  //
  // 2026-09-02 RECALIBRATION. This gate was written to fire "~1-in-5 days". It actually fired on
  // 30 of ~30 trading days (Jul 16 – Sep 1), i.e. every weekday, because it keyed off
  // `needsAttention` — which is deliberately broad for the EMAIL and was held permanently true by
  // two things that occur on ordinary days:
  //   1. `seriousConcerns` = every reviewer concern above "low". The skeptical reviewer is an LLM
  //      asked to be skeptical; it reliably produces a medium every single run. Medium is "worth
  //      your glance", not "a machine should go rewrite code about it."
  //   2. The "no trades executed but buying power > $50" heuristic, which fires whenever the agent
  //      correctly stands pat — an explicitly valid outcome. Now in `softIssues` (email only).
  // Combined with run length growing 2.4-5min (July) to 19-45min (late Aug), that is the bill.
  //
  // The gate now requires something CONCRETE: a deterministic issue (cron missing, verify
  // discrepancy, decided-vs-executed gap, impossible derived number), a HIGH-severity judgment
  // from the reviewer or reconciler, live data that doesn't match, or a self-healed morning.
  // Medium/low concerns still reach you in the email and are still recorded — they just no longer
  // spend money by themselves. If a medium turns out to matter, it recurs, and a recurring one is
  // exactly what gets promoted to high (or handled by you) rather than silently re-worked daily.
  const highConcerns = reviewConcerns.filter((c) => c.severity === "high");
  const highReconcile = reconcileFindings.filter((f) => f.severity === "high");
  const cloudWorthDispatching =
    issues.length > 0 ||
    highConcerns.length > 0 ||
    highReconcile.length > 0 ||
    (verifyResult != null && verifyResult.status !== "ok") ||
    selfHealed;
  const cloudDispatch = new URL(request.url).searchParams.get("cloudDispatch") === "1";
  let cloudDispatched: { ok: boolean; detail: string; status: number } | null = null;
  if (cloudDispatch && emailSent && cloudWorthDispatching) {
    cloudDispatched = await dispatchCloudAgent();
    console.log("CLOUD_DISPATCH", cloudDispatched);
    // Make a dispatch failure LOUD. It's otherwise swallowed (non-fatal by design) and there's
    // no schedule fallback, so an expired/revoked GH_DISPATCH_TOKEN would silently kill the cloud
    // autopilot with no warning (the "silent self-heal masks a failure" class). Alert instead.
    if (!cloudDispatched.ok) {
      // Distinguish a TRANSIENT GitHub blip (5xx / network — already retried 3×) from a real TOKEN
      // problem (401/403), so a GitHub hiccup doesn't cry "regenerate the PAT".
      const transient = cloudDispatched.status >= 500 || cloudDispatched.status < 0;
      await sendAlert(
        transient
          ? "ℹ️ Autopilot cloud-dispatch skipped (transient GitHub error)"
          : "⚠️ Autopilot cloud-dispatch FAILED — check GH_DISPATCH_TOKEN",
        transient
          ? `GitHub's workflow-dispatch API returned a transient error (${cloudDispatched.detail}) even after 3 retries — GitHub Actions was briefly unavailable. Today's cloud autopilot (deep verification, skeptical reviewer, Autopilot Journal, propose-mode PRs) did NOT run; it resumes automatically on the next weekday cron. NO ACTION NEEDED unless this recurs across multiple days — then check https://www.githubstatus.com and the GH_DISPATCH_TOKEN.`
          : `The Vercel /api/autopilot cron could not trigger the GitHub autopilot workflow (dispatch result: ${cloudDispatched.detail}). Until fixed, the cloud autopilot — deep verification, skeptical reviewer, Autopilot Journal, and propose-mode PRs — will NOT run, and there is no schedule fallback. A 4xx here is a token/perms problem: most likely GH_DISPATCH_TOKEN expired/revoked (HTTP 401/403) or the env var is missing. Fix: regenerate the PAT with the 'repo' scope, update GH_DISPATCH_TOKEN in the Vercel project env (Production) + .env.local, then redeploy.`,
      );
    }
  } else if (cloudDispatch && emailSent) {
    // Clean HEALTHY run — deliberately skipped the cloud agent to save cost. Logged so the
    // skip is visible (not a silent dispatch failure) and distinguishable in the logs.
    console.log("CLOUD_DISPATCH_SKIPPED", { reason: "clean run, nothing actionable for the cloud agent" });
  }

  return Response.json({
    date: today,
    status: statusLabel,
    ranToday: todayRun !== null,
    selfHealed,
    autoFixed,
    trades: trades.length,
    buys: buys.length,
    sells: sells.length,
    totalValue,
    issues: allIssues, // unchanged response surface — see storeAutopilotConcerns above
    reviewConcerns,
    verifyStatus: verifyResult?.status ?? "skipped",
    emailSent,
    cloudDispatched,
    cloudDispatchSkipped: cloudDispatch && emailSent && !cloudWorthDispatching,
  });
}
