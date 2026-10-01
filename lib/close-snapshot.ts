/**
 * CLOSING-BELL SNAPSHOT — a second observation of the book, taken after the US equity close.
 *
 * WHY THIS EXISTS. The trade cron fires at 14:30 UTC (10:30 ET) and the run it writes is the only
 * observation of the portfolio, so the stored "daily return" series is measured 10:30→10:30. The
 * 28-year backtest (scripts/full-period.ts) is measured close→close, like every published SPY
 * statistic. Those are not the same series: over the 29 stored days, SPY's 10:30-sampled returns
 * correlate only 0.668 with its close-to-close returns. Until the clocks match, any verdict on
 * "is live tracking the backtest?" is partly an artefact of sampling time.
 *
 * This ADDS an observation; it does not move the existing one. The 10:30 run is the POST-TRADE state
 * that /api/verify reconciles against live Robinhood (autopilot Step 3) — moving it would break that.
 *
 * TWO DELIBERATE DESIGN CHOICES, both about failing in the safe direction:
 *
 * 1. The write path stores OBSERVATIONS ONLY — priced positions, total value, SPY's close. No return
 *    is computed or stored. Returns are derived at READ time by computeCloseReturns. A stored
 *    derived number is a cached judgement: when the input turns out to be wrong, the bad output
 *    survives in Redis and needs a backfill endpoint to repair (the project already carries two of
 *    those, /api/debug?recomputeSleeves and ?patchDate, for exactly this mistake). Deriving on read
 *    means a fix to the formula fixes history for free.
 *
 * 2. Returns reuse computeDailyReturn from lib/run-store rather than diffing total value. That
 *    function is position-level on purpose: pnl = ΔpositionValue − tradeNetCash, with the residual
 *    falling out as impliedTransfer. A naive (todayValue/yesterdayValue − 1) would book the owner's
 *    next DEPOSIT as a gain — deposits are expected here, and the 10:30 series already learned this
 *    the expensive way. It also inherits that function's unpriceable-trade rule, which returns null
 *    rather than silently erasing a stop-out's loss.
 */
import {
  computeDailyReturn,
  redisCommand,
  redisPost,
  type PositionSnapshot,
  type TradeSnapshot,
} from "./run-store";

const CLOSES_KEY = "robinhood:closes";

/** ~1.5 years of trading days. Long enough to outlive any statistical question being asked of it. */
export const MAX_CLOSE_SNAPSHOTS = 400;

/**
 * Minutes past ET midnight before the official closing print is trustworthy. The regular session
 * ends at 16:00; the consolidated close takes a moment to settle, and Yahoo's regularMarketPrice —
 * the field fetchCurrentPrice reads — only stops moving once it has. Sampling at 16:00:00 sharp can
 * catch the last tick instead of the close.
 */
export const CLOSE_SETTLE_MINUTES = 16 * 60 + 5;

/**
 * A pair of snapshots further apart than this is NOT a daily return. Normal gaps are 1 day, or 3-4
 * over a weekend plus a holiday. Anything longer means the cron was down, and compounding a
 * multi-week move into a "daily" series would corrupt the volatility and every statistic built on
 * it. Withhold the pair instead — a hole is visible, a wrong number is not.
 */
export const MAX_PAIR_GAP_DAYS = 10;

export interface CloseSnapshot {
  /** ET trading date (YYYY-MM-DD). The key; one snapshot per date. */
  date: string;
  capturedAt: string;
  /** SPY's regular-session close. */
  spyClose: number;
  /** Live account total value from the broker, including cash and unsettled proceeds. */
  totalValue: number;
  /** Held positions with `price` set to that symbol's CLOSE, not a mid-session mark. */
  positions: PositionSnapshot[];
}

/**
 * ET wall-clock date and minutes-past-midnight for an instant.
 *
 * Uses Intl with an explicit timeZone rather than a fixed UTC offset, so it is correct across the
 * DST boundary. That matters: the close is 20:00 UTC in EDT and 21:00 UTC in EST, so any guard
 * written against a hardcoded offset is wrong for ~4 months of the year.
 */
export function etParts(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // en-CA renders hour 24 for midnight in some ICU versions; normalise so 24:00 reads as 0.
  const hour = parseInt(get("hour"), 10) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + parseInt(get("minute"), 10),
  };
}

/** True once the closing print for that ET day can be trusted. See CLOSE_SETTLE_MINUTES. */
export function isAfterUsEquityClose(now: Date): boolean {
  return etParts(now).minutes >= CLOSE_SETTLE_MINUTES;
}

/**
 * Is this snapshot fit to store? Fails CLOSED on anything unestablished.
 *
 * The expensive case to get right is an unpriceable position. computeDailyReturn's priceOf falls
 * back to avgCost when `price` is absent, so a position stored without a real close silently
 * becomes "price == cost" — which injects a phantom day-over-day move the next time the series is
 * read. That is not hypothetical: it is the PLTR 2026-07-08 bug recorded in enrichPriceMap's
 * comment, a bogus +8% from exactly this substitution. One unpriceable holding therefore withholds
 * the WHOLE snapshot. A missing day is a visible hole; a priced-at-cost day is an invisible lie.
 */
export function validateCloseSnapshot(s: {
  spyClose: number | null;
  totalValue: number | null;
  positions: PositionSnapshot[] | null;
}): { ok: true } | { ok: false; reason: string } {
  if (s.spyClose == null || !(s.spyClose > 0)) return { ok: false, reason: "no_spy_close" };
  if (s.totalValue == null || !(s.totalValue > 0)) return { ok: false, reason: "no_total_value" };
  if (s.positions == null) return { ok: false, reason: "no_positions" };
  const unpriced = s.positions.filter((p) => !(parseFloat(p.price) > 0)).map((p) => p.symbol);
  if (unpriced.length > 0) return { ok: false, reason: `unpriced:${unpriced.join(",")}` };
  const badQty = s.positions.filter((p) => !(parseFloat(p.quantity) > 0)).map((p) => p.symbol);
  if (badQty.length > 0) return { ok: false, reason: `bad_quantity:${badQty.join(",")}` };
  return { ok: true };
}

export async function saveCloseSnapshot(snapshot: CloseSnapshot): Promise<void> {
  await redisPost("pipeline", [
    ["LPUSH", CLOSES_KEY, JSON.stringify(snapshot)],
    ["LTRIM", CLOSES_KEY, 0, MAX_CLOSE_SNAPSHOTS - 1],
  ]);
}

/** Newest-first, as stored. */
export async function getCloseSnapshots(limit = MAX_CLOSE_SNAPSHOTS): Promise<CloseSnapshot[]> {
  const raw = (await redisCommand("lrange", CLOSES_KEY, 0, limit - 1)) as string[] | null;
  if (!raw) return [];
  const out: CloseSnapshot[] = [];
  for (const r of raw) {
    try {
      const parsed = JSON.parse(r) as CloseSnapshot;
      if (parsed && typeof parsed.date === "string") out.push(parsed);
    } catch {
      // A single corrupt entry must not blind the whole series.
      console.warn("CLOSE_SNAPSHOT_UNPARSEABLE");
    }
  }
  return out;
}

export interface CloseReturn {
  date: string;
  prevDate: string;
  /** null = withheld; the day could not be established. Never substitute 0. */
  bookReturn: number | null;
  spyReturn: number | null;
  activeReturn: number | null;
  impliedTransfer: number | null;
  withheldReason?: string;
}

const dayGap = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Pair consecutive snapshots into close-to-close returns.
 *
 * `tradesByDate` must map an ET date to the trades that FILLED that day. Every trade strictly after
 * prevDate and up to and including date belongs in the window, which is why a gap is still handled
 * correctly rather than approximated: the union over the intervening dates is the real trade set.
 */
export function computeCloseReturns(
  snapshots: CloseSnapshot[],
  tradesByDate: Map<string, TradeSnapshot[]>,
): CloseReturn[] {
  const chron = [...snapshots]
    .filter((s) => typeof s.date === "string" && s.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date));
  // One snapshot per date; a duplicate write must not create a 0% day between two copies.
  const deduped: CloseSnapshot[] = [];
  for (const s of chron) {
    if (deduped.length > 0 && deduped[deduped.length - 1].date === s.date) deduped[deduped.length - 1] = s;
    else deduped.push(s);
  }

  const out: CloseReturn[] = [];
  for (let i = 1; i < deduped.length; i++) {
    const prev = deduped[i - 1], cur = deduped[i];
    const base: CloseReturn = {
      date: cur.date, prevDate: prev.date,
      bookReturn: null, spyReturn: null, activeReturn: null, impliedTransfer: null,
    };

    const gap = dayGap(prev.date, cur.date);
    if (!(gap > 0) || gap > MAX_PAIR_GAP_DAYS) {
      out.push({ ...base, withheldReason: `gap_${gap}d` });
      continue;
    }

    const trades: TradeSnapshot[] = [];
    for (const [d, ts] of tradesByDate) if (d > prev.date && d <= cur.date) trades.push(...ts);

    const r = computeDailyReturn(cur.totalValue, prev.totalValue, cur.positions, prev.positions, trades);
    if (!r) {
      out.push({ ...base, withheldReason: "unpriceable" });
      continue;
    }
    const spyReturn = prev.spyClose > 0 ? cur.spyClose / prev.spyClose - 1 : null;
    out.push({
      ...base,
      bookReturn: r.dailyReturn,
      spyReturn,
      activeReturn: spyReturn == null ? null : r.dailyReturn - spyReturn,
      impliedTransfer: r.impliedTransfer,
    });
  }
  return out;
}

export interface CloseSeriesSummary {
  /** Days where BOTH legs were established — the only days any statistic may use. */
  pairedDays: number;
  withheldDays: number;
  cumulativeBookPct: number | null;
  cumulativeSpyPct: number | null;
  /** Compounded book vs compounded SPY, in percentage points. */
  cumulativeActivePct: number | null;
  /** Daily active-return standard deviation, in percent. null until there are 2+ paired days. */
  dailyActiveVolPct: number | null;
  /** ±1σ band on the cumulative active return, in points — the "is this diagnosable?" number. */
  activeOneSigmaPct: number | null;
  firstDate: string | null;
  lastDate: string | null;
}

export function summarizeCloseReturns(returns: CloseReturn[]): CloseSeriesSummary {
  const paired = returns.filter(
    (r): r is CloseReturn & { bookReturn: number; spyReturn: number; activeReturn: number } =>
      r.bookReturn != null && r.spyReturn != null && r.activeReturn != null,
  );
  const empty: CloseSeriesSummary = {
    pairedDays: 0, withheldDays: returns.length - paired.length,
    cumulativeBookPct: null, cumulativeSpyPct: null, cumulativeActivePct: null,
    dailyActiveVolPct: null, activeOneSigmaPct: null, firstDate: null, lastDate: null,
  };
  if (paired.length === 0) return empty;

  let book = 1, spy = 1;
  for (const r of paired) { book *= 1 + r.bookReturn; spy *= 1 + r.spyReturn; }

  const act = paired.map((r) => r.activeReturn);
  let vol: number | null = null;
  if (act.length >= 2) {
    const m = act.reduce((a, b) => a + b, 0) / act.length;
    vol = Math.sqrt(act.reduce((a, b) => a + (b - m) ** 2, 0) / (act.length - 1));
  }

  return {
    pairedDays: paired.length,
    withheldDays: returns.length - paired.length,
    cumulativeBookPct: (book - 1) * 100,
    cumulativeSpyPct: (spy - 1) * 100,
    cumulativeActivePct: (book - spy) * 100,
    dailyActiveVolPct: vol == null ? null : vol * 100,
    activeOneSigmaPct: vol == null ? null : vol * Math.sqrt(act.length) * 100,
    firstDate: paired[0].prevDate,
    lastDate: paired[paired.length - 1].date,
  };
}
