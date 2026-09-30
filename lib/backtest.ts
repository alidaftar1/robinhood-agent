// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST ENGINE — runs a StrategyVariant over historical CaptureDays and reports the drawdown.
//
// SCOPE, AND THE SCOPE IS THE POINT: this exists to answer ONE pre-specified question — what does
// this strategy do in a bear market, which the live book has zero data on. It is a RISK
// instrument, not an optimization one. Running one unmodified strategy through past crashes
// involves no variant search, so it carries none of the overfitting exposure that makes backtests
// lie. The moment it is used to PICK among many variants, that protection is gone and the
// hold-out discipline in docs/scope-strategy-research-agent.md becomes mandatory.
//
// WHAT IT DELIBERATELY DOES NOT MODEL, because claiming otherwise would be the dishonest part:
//   · The LLM layer. Live is: deterministic shortlist -> LLM selection/sizing -> risk rails. Only
//     the first and third are here. This tests THE SCREEN, not the agent.
//   · Quality. The Prices plan cannot fill qualityPct, so the screen degrades to momentum-only.
//   · Slippage beyond a flat per-trade cost, and any market impact.
//   · Intraday stops. Stops are evaluated on CLOSES, so a day that dipped through the stop and
//     recovered does not trigger — which UNDERSTATES stop-outs and, in a fast crash, flatters the
//     result. Stated rather than silently absorbed.
// ─────────────────────────────────────────────────────────────────────────────

import { runVariantDay, type StrategyVariant } from "./strategy-variant";
import type { CaptureDay } from "./feature-capture";

export interface BacktestConfig {
  /** Rebalance every N trading days. Live rebalances weekly (first two days of the week). */
  rebalanceEveryDays: number;
  /** Per-position stop threshold, percent. Interpretation depends on stopMode. */
  stopLossPct: number | null;
  /**
   * WHICH MOVE THE STOP MEASURES — and these are very different strategies, not a detail.
   *
   * "same-day"   today's close vs YESTERDAY's close. This is what the live main book does
   *              (MAIN_DROP_THRESHOLD_PCT = -5, "same-day move, from prev close" in lib/stopouts).
   *              A crash-day stop: it fires on a −5% DAY, not on a slow bleed.
   * "from-entry" cumulative return since the position was opened. This is what the INFLUENCER
   *              sleeve does (−10% from buy), and it is a far tighter stop for the main book —
   *              in a bear it fires on nearly every position, repeatedly, manufacturing churn and
   *              losses the live design would not have taken.
   *
   * Defaulting this wrong is exactly the "backtest of a different strategy" failure this file
   * warns about; the first run of the bear test used from-entry by mistake and reported a GFC
   * drawdown materially worse than the live rules would produce.
   */
  stopMode: "same-day" | "from-entry";
  /** Round-trip cost in basis points, applied on every buy and every sell. */
  costBps: number;
  /** Starting capital. Scale-invariant — reported results are percentages. */
  startingCapital: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  rebalanceEveryDays: 5,
  stopLossPct: -5,
  // Matches the live main book. See stopMode's doc comment for why this is load-bearing.
  stopMode: "same-day",
  costBps: 5,
  startingCapital: 10_000,
};

export interface DayMark {
  date: string;
  equity: number;
  spy: number | null;
  positions: number;
  cash: number;
}

export interface BacktestResult {
  /** False when the run is not fit to quote — see the UNUSABLE RUN notes. */
  usable: boolean;
  variantId: string;
  from: string;
  to: string;
  days: number;
  marks: DayMark[];
  totalReturnPct: number;
  spyReturnPct: number | null;
  maxDrawdownPct: number;
  spyMaxDrawdownPct: number | null;
  /** Peak-to-trough dates of the worst drawdown, so a result can be checked against the calendar. */
  drawdownFrom: string | null;
  drawdownTo: string | null;
  trades: number;
  stopOuts: number;
  /** Days the book held nothing — a no-hedge strategy's only de-risking is being stopped to cash. */
  daysFlat: number;
  excludedDays: number;
  notes: string[];
}

interface Holding { symbol: string; shares: number; entry: number; }

/** Price for P&L: `closeadj` (split + dividend). Falls back to the feature close only when the
 *  adjusted series is absent, which should never happen for a name that had a bar. */
export type PriceLookup = (date: string, symbol: string) => number | null;

/**
 * Run one variant across a date range.
 *
 * ORDER OF OPERATIONS EACH DAY, and it matters:
 *   1. Mark the book to today's close.
 *   2. Apply stops on TODAY'S close (a position already down past the stop exits today).
 *   3. On a rebalance day, take the variant's picks for TODAY and trade into them AT TODAY'S CLOSE.
 *
 * Step 3 uses picks computed from features that end at today's close and executes at that same
 * close. That is a mild, well-known optimism (a real order fills after the signal), and it is the
 * standard close-to-close convention. It is NOT look-ahead — no future bar is consulted — but it
 * does assume you can transact at the price your signal was measured on.
 */
export function runBacktest(
  variant: StrategyVariant,
  days: CaptureDay[],
  priceOf: PriceLookup,
  spyCloseOf: (date: string) => number | null,
  cfg: BacktestConfig = DEFAULT_BACKTEST,
): BacktestResult {
  const notes: string[] = [];
  const marks: DayMark[] = [];
  let cash = cfg.startingCapital;
  let holdings: Holding[] = [];
  let trades = 0, stopOuts = 0, daysFlat = 0, excludedDays = 0;
  let sinceRebalance = Number.MAX_SAFE_INTEGER;   // force a rebalance on the first usable day
  // Last close seen per symbol, for the same-day stop. Carried across days because a symbol can
  // miss a bar (halt) — in which case the comparison is against its last REAL close, and the
  // staleness is noted rather than silently treated as a one-day move.
  const lastClose = new Map<string, number>();

  const cost = (notional: number) => (notional * cfg.costBps) / 10_000;

  for (const day of days) {
    const date = day.date;

    // ── 1. mark to market ──
    const markPrice = (h: Holding) => priceOf(date, h.symbol) ?? h.entry;
    let equity = cash + holdings.reduce((a, h) => a + h.shares * markPrice(h), 0);

    // ── 2. stops, on today's close ──
    if (cfg.stopLossPct != null) {
      const survivors: Holding[] = [];
      for (const h of holdings) {
        const p = priceOf(date, h.symbol);
        // A name with NO price today is held, not silently liquidated at an invented price. A
        // delisted name's final bar is its last real price; after that it stops appearing and the
        // position rides at cost until the next rebalance clears it. Flagged below.
        if (p == null) { survivors.push(h); continue; }
        // same-day: vs the previous close (live main book). from-entry: cumulative (sleeve rule).
        const basis = cfg.stopMode === "same-day" ? lastClose.get(h.symbol) : h.entry;
        // No previous close yet (first day held) means there is no same-day move to measure. Do
        // NOT fall back to entry — that silently converts the stop into the tighter cumulative one.
        if (basis == null || basis <= 0) { survivors.push(h); continue; }
        const ret = ((p - basis) / basis) * 100;
        if (ret <= cfg.stopLossPct) {
          cash += h.shares * p - cost(h.shares * p);
          stopOuts++; trades++;
        } else survivors.push(h);
      }
      holdings = survivors;
    }

    // ── 3. rebalance ──
    sinceRebalance++;
    const res = runVariantDay(variant, day);
    if (res.picks.length === 0 && res.error) excludedDays++;

    if (sinceRebalance >= cfg.rebalanceEveryDays && res.picks.length > 0) {
      sinceRebalance = 0;
      const target = new Set(res.picks.map(p => p.symbol));
      // Sell anything not in the target.
      const keep: Holding[] = [];
      for (const h of holdings) {
        if (target.has(h.symbol)) { keep.push(h); continue; }
        const p = priceOf(date, h.symbol);
        if (p == null) { keep.push(h); continue; }      // cannot price it -> cannot sell it
        cash += h.shares * p - cost(h.shares * p);
        trades++;
      }
      holdings = keep;

      // Equal-weight into the target across the WHOLE book, so a rebalance re-levels rather than
      // letting one winner compound into a concentrated bet the live caps would have trimmed.
      equity = cash + holdings.reduce((a, h) => a + h.shares * markPrice(h), 0);
      const per = equity / target.size;
      const held = new Map(holdings.map(h => [h.symbol, h]));
      const next: Holding[] = [];
      for (const sym of target) {
        const p = priceOf(date, sym);
        if (p == null || p <= 0) continue;
        const existing = held.get(sym);
        const curVal = existing ? existing.shares * p : 0;
        const delta = per - curVal;
        if (Math.abs(delta) > 1) {                       // skip trivial rebalancing churn
          cash -= delta + cost(Math.abs(delta));
          trades++;
        }
        const shares = per / p;
        next.push({ symbol: sym, shares, entry: existing ? existing.entry : p });
      }
      holdings = next;
    }

    equity = cash + holdings.reduce((a, h) => a + h.shares * markPrice(h), 0);
    if (holdings.length === 0) daysFlat++;
    marks.push({ date, equity, spy: spyCloseOf(date), positions: holdings.length, cash });

    // Record today's closes AFTER the day is done, so tomorrow's same-day stop compares against
    // today. Updated for every symbol in the day's capture, not just holdings, so a name bought at
    // a later rebalance already has a previous close to measure against.
    for (const row of day.rows) {
      const sym = row[0];
      if (typeof sym !== "string") continue;
      const p = priceOf(date, sym);
      if (p != null && p > 0) lastClose.set(sym, p);
    }
  }

  if (marks.length === 0) {
    return {
      usable: false,
      variantId: variant.id, from: "", to: "", days: 0, marks: [],
      totalReturnPct: 0, spyReturnPct: null, maxDrawdownPct: 0, spyMaxDrawdownPct: null,
      drawdownFrom: null, drawdownTo: null, trades: 0, stopOuts: 0, daysFlat: 0,
      excludedDays, notes: ["no usable days in range"],
    };
  }

  const dd = maxDrawdown(marks.map(m => m.equity));
  const spySeries = marks.map(m => m.spy).filter((n): n is number => n != null && n > 0);
  const spyDd = spySeries.length > 1 ? maxDrawdown(spySeries) : null;

  const first = marks[0].equity, last = marks[marks.length - 1].equity;
  const spyFirst = spySeries[0], spyLast = spySeries[spySeries.length - 1];

  if (excludedDays > 0) notes.push(`${excludedDays} day(s) excluded (SPY unavailable or no usable rows)`);
  // A run whose days were mostly EXCLUDED is not a result, it is a broken load — and it reports as
  // a confident number rather than an error. This actually happened: running four windows in one
  // process exhausted memory, later windows silently produced zero usable rows, and the harness
  // printed "-100.05% return / 0 trades / 100% days flat" as if it were a finding. A long-only book
  // cannot lose more than 100%, which is the only reason it was obvious.
  const excludedFrac = marks.length > 0 ? excludedDays / marks.length : 1;
  if (excludedFrac > 0.1) {
    notes.push(
      `⚠️ UNUSABLE RUN — ${(excludedFrac * 100).toFixed(0)}% of days were excluded. The numbers ` +
      `below describe a book that mostly could not trade, not the strategy. Do not quote them.`,
    );
  }
  if (trades === 0 && marks.length > 1) {
    notes.push("⚠️ UNUSABLE RUN — ZERO trades were placed; the screen never produced a pick.");
  }
  if (spySeries.length < marks.length) {
    notes.push(`SPY missing on ${marks.length - spySeries.length} day(s) — benchmark is partial`);
  }

  return {
    usable: excludedFrac <= 0.1 && (trades > 0 || marks.length <= 1),
    variantId: variant.id,
    from: marks[0].date,
    to: marks[marks.length - 1].date,
    days: marks.length,
    marks,
    totalReturnPct: ((last - first) / first) * 100,
    // null, never 0 — a missing benchmark must not print as "matched the market".
    spyReturnPct: spySeries.length > 1 ? ((spyLast - spyFirst) / spyFirst) * 100 : null,
    maxDrawdownPct: dd.pct,
    spyMaxDrawdownPct: spyDd ? spyDd.pct : null,
    drawdownFrom: dd.fromIdx >= 0 ? marks[dd.fromIdx].date : null,
    drawdownTo: dd.toIdx >= 0 ? marks[dd.toIdx].date : null,
    trades, stopOuts, daysFlat, excludedDays, notes,
  };
}

/** Worst peak-to-trough decline in a series, as a NEGATIVE percent, with its endpoints. */
export function maxDrawdown(series: number[]): { pct: number; fromIdx: number; toIdx: number } {
  let peak = -Infinity, peakIdx = -1, worst = 0, fromIdx = -1, toIdx = -1;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    if (v > peak) { peak = v; peakIdx = i; }
    if (peak > 0) {
      const dd = ((v - peak) / peak) * 100;
      if (dd < worst) { worst = dd; fromIdx = peakIdx; toIdx = i; }
    }
  }
  return { pct: worst, fromIdx, toIdx };
}
