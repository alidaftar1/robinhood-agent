// ─────────────────────────────────────────────────────────────────────────────
// VARIANT REPLAY — Tier 0 evaluation. Pure measurement over data that already exists.
//
// Reads stored CaptureDays, runs each variant's pure pick() over them, and scores the resulting
// picks through lib/shadow-scoring — the SAME scorer the mean-reversion and give-back shadows use,
// deliberately not a second one. A research harness that grades itself with its own bespoke metric
// is how a strategy comes to look good only under the measurement it shipped with.
//
// THE SPLIT THIS FILE EXISTS FOR. Because picks are recomputed on read, a variant written today can
// be replayed over days that already happened — which is exactly the look-ahead that makes
// backtests lie. So every day is classified against the variant's own registeredAt:
//
//   date <  registeredAt  →  IN-SAMPLE      (the variant was written knowing these days)
//   date >= registeredAt  →  OUT-OF-SAMPLE  (genuine forward evidence)
//
// They are reported separately and NEVER merged, and promotion is judged on out-of-sample only.
// In-sample results are still worth showing — a variant that fails in-sample is dead without
// spending a single forward day — but they can only ever DISQUALIFY, never promote.
//
// WRITES NOTHING. No new Redis key, no cron, no hook in the trade run.
// ─────────────────────────────────────────────────────────────────────────────

import { CAPTURE_KEY_PREFIX, getFeatureCaptureStatus, type CaptureDay } from "./feature-capture";
import { redisPipeline } from "./run-store";
import { scoreShadowObservations, type ShadowObservation, type ShadowStats } from "./shadow-scoring";
import { runVariantDay, type StrategyVariant, type VariantPick } from "./strategy-variant";

/** Bound the read. Scoring costs one live quote per DISTINCT symbol, so this grows with history. */
export const REPLAY_WINDOW_DAYS = 60;
const READ_TIMEOUT_MS = 8_000;

/** Read specific capture days by EXPLICIT key. Never KEYS/SCAN — same reasoning as
 *  getFeatureCaptureStatus: a pattern sweep on a shared Redis is the operation most likely to be
 *  slow or, worse, copied into something that deletes. */
/**
 * Pure, and exported SEPARATELY because this response shape has bitten this repo before: Upstash's
 * `/pipeline` returns a TOP-LEVEL ARRAY while every other endpoint returns `{result}`, and reading
 * it wrong yields `undefined` per entry — which here would look exactly like "no capture days
 * stored yet" rather than like a bug. Handles both entry shapes so a change in either direction
 * degrades to skipping a day, never to silently replaying an empty universe.
 */
export function parseCaptureDaysResponse(res: unknown): CaptureDay[] {
  const arr = Array.isArray(res) ? res : [];
  const out: CaptureDay[] = [];
  for (const entry of arr) {
    const raw = typeof entry === "object" && entry !== null ? (entry as { result?: unknown }).result : entry;
    if (typeof raw !== "string" || !raw) continue;
    try {
      const parsed = JSON.parse(raw) as CaptureDay;
      // A malformed day is SKIPPED WHOLE, never partially trusted. It cannot be distinguished from
      // a truncated write, and scoring half a day's universe would silently change the strategy
      // under test into a different one.
      if (parsed && typeof parsed.date === "string" && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        out.push(parsed);
      }
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function readCaptureDays(dates: string[]): Promise<CaptureDay[]> {
  if (dates.length === 0) return [];
  const res = await redisPipeline(
    dates.map(d => ["GET", `${CAPTURE_KEY_PREFIX}${d}`]),
    AbortSignal.timeout(READ_TIMEOUT_MS),
  );
  return parseCaptureDaysResponse(res);
}

export interface VariantWindowResult {
  /** Days actually evaluated in this window (after exclusions). */
  days: number;
  picks: number;
  stats: ShadowStats | null;
}

export interface VariantReplayResult {
  id: string;
  description: string;
  registeredAt: string;
  /** Days present in the capture but NOT evaluated, with the reason — a silently shrinking
   *  denominator is how a replay comes to describe a different experiment than it claims. */
  excludedDays: Array<{ date: string; reason: string }>;
  inSample: VariantWindowResult;
  outOfSample: VariantWindowResult;
  /** Criteria verdict, judged on OUT-OF-SAMPLE only. null when there is not yet enough to judge. */
  promotion: { eligible: boolean; reasons: string[] } | null;
  errors: string[];
}

function toObservations(results: Array<{ date: string; picks: VariantPick[] }>, priceOf: Map<string, Map<string, number>>): ShadowObservation[] {
  const obs: ShadowObservation[] = [];
  for (const r of results) {
    const prices = priceOf.get(r.date);
    if (!prices) continue;
    for (const p of r.picks) {
      const price = prices.get(p.symbol);
      if (price != null && price > 0) obs.push({ symbol: p.symbol, price, date: r.date });
    }
  }
  return obs;
}

/** Capture price per symbol for one day — the forward-return baseline. */
function priceMapOf(day: CaptureDay): Map<string, number> {
  const cols: readonly string[] = day.columns ?? [];
  const symIdx = cols.indexOf("symbol"), priceIdx = cols.indexOf("price");
  const m = new Map<string, number>();
  if (symIdx < 0 || priceIdx < 0) return m;
  for (const row of day.rows ?? []) {
    const s = row[symIdx], p = row[priceIdx];
    if (typeof s === "string" && typeof p === "number" && Number.isFinite(p) && p > 0) m.set(s, p);
  }
  return m;
}

/**
 * Judge the pre-registered criteria. OUT-OF-SAMPLE ONLY, and it reports every reason rather than
 * short-circuiting, so a near-miss is legible instead of just "not eligible".
 */
function judge(variant: StrategyVariant, oos: VariantWindowResult): { eligible: boolean; reasons: string[] } | null {
  const s = oos.stats;
  if (!s || s.symbolsScored === 0) return null;
  const c = variant.criteria;
  const reasons: string[] = [];
  let ok = true;
  if (s.symbolsScored < c.minSymbolsScored) {
    ok = false;
    reasons.push(`${s.symbolsScored} names scored, needs ${c.minSymbolsScored}`);
  }
  // null excess means the SPY benchmark was unavailable — that is NOT a pass. The objective is
  // excess return vs SPY; with no benchmark there is no excess, and treating null as 0 would
  // manufacture "matched the market" out of a failed fetch.
  if (s.avgExcessReturnPct == null) {
    ok = false;
    reasons.push("no SPY benchmark — excess vs SPY is unmeasurable, which is not a pass");
  } else if (s.avgExcessReturnPct < c.minExcessReturnPct) {
    ok = false;
    reasons.push(`${s.avgExcessReturnPct.toFixed(2)}% excess vs SPY, needs ≥ ${c.minExcessReturnPct}%`);
  }
  if (s.hitRatePct < c.minHitRatePct) {
    ok = false;
    reasons.push(`${s.hitRatePct.toFixed(0)}% hit rate, needs ≥ ${c.minHitRatePct}%`);
  }
  if (ok) reasons.push("meets every pre-registered criterion — a TIER 1 CANDIDATE, not a validated strategy; see the scope doc on why forward evidence confirms slowly");
  return { eligible: ok, reasons };
}

/** Replay one variant across already-read capture days. */
export async function replayVariant(
  variant: StrategyVariant,
  days: CaptureDay[],
  today: string,
): Promise<VariantReplayResult> {
  const excludedDays: Array<{ date: string; reason: string }> = [];
  const errors: string[] = [];
  const priceOf = new Map<string, Map<string, number>>();
  const inDays: Array<{ date: string; picks: VariantPick[] }> = [];
  const outDays: Array<{ date: string; picks: VariantPick[] }> = [];

  for (const day of days) {
    const r = runVariantDay(variant, day);
    if (r.error && r.picks.length === 0) {
      excludedDays.push({ date: day.date, reason: r.error });
      continue;
    }
    if (r.error) errors.push(`${day.date}: ${r.error}`);
    priceOf.set(day.date, priceMapOf(day));
    (day.date < variant.registeredAt ? inDays : outDays).push({ date: day.date, picks: r.picks });
  }

  const score = async (rows: Array<{ date: string; picks: VariantPick[] }>): Promise<VariantWindowResult> => {
    const obs = toObservations(rows, priceOf);
    const picks = rows.reduce((n, r) => n + r.picks.length, 0);
    if (obs.length === 0) return { days: rows.length, picks, stats: null };
    // "entry" — a variant pick is a RELATIVE choice (this name instead of the market), so it earns
    // credit only for beating SPY. lib/shadow-scoring is explicit that entry and exit signals must
    // not share a sign convention.
    const { stats } = await scoreShadowObservations(obs, today, "entry");
    return { days: rows.length, picks, stats };
  };

  // Sequential on purpose: each call fetches one live quote per distinct symbol, and the two
  // windows overlap heavily in names. Running them concurrently would double the burst against the
  // quote source for no wall-clock gain worth the rate-limit risk.
  const inSample = await score(inDays);
  const outOfSample = await score(outDays);

  return {
    id: variant.id,
    description: variant.description,
    registeredAt: variant.registeredAt,
    excludedDays,
    inSample,
    outOfSample,
    promotion: judge(variant, outOfSample),
    errors,
  };
}

export interface ReplayAllResult {
  today: string;
  captureDays: number;
  windowDays: number;
  variants: VariantReplayResult[];
}

/**
 * Replay every registered variant over the recent capture window. Reads the capture ONCE and
 * shares it across variants — the read is the same for all of them, and re-reading per variant
 * would multiply a multi-megabyte fetch by the registry size.
 */
export async function replayAllVariants(
  variants: StrategyVariant[],
  today: string,
  windowDays = REPLAY_WINDOW_DAYS,
): Promise<ReplayAllResult> {
  const status = await getFeatureCaptureStatus(today, windowDays);
  const dates = status.days.map(d => d.date).sort();
  const days = await readCaptureDays(dates);
  const results: VariantReplayResult[] = [];
  // Sequential across variants for the same rate-limit reason as above.
  for (const v of variants) {
    results.push(await replayVariant(v, days, today));
  }
  return { today, captureDays: days.length, windowDays, variants: results };
}
