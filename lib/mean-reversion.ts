// ─────────────────────────────────────────────────────────────────────────────
// MEAN-REVERSION SIGNAL — SHADOW CAPTURE (Phase 1: zero capital, measure-first)
//
// The main book buys STRENGTH (12-1 momentum + quality). This screens the OPPOSITE — quality names
// that are OVERSOLD (beaten down recently) and stabilizing — a candidate sleeve that should, by
// construction, be UNCORRELATED with the momentum book (it harvests the short-term reversal that
// 12-1 momentum deliberately skips). SHADOW ONLY: it logs what the sleeve WOULD pick each day; it
// places no orders and holds no capital. The point is to MEASURE the correlation-vs-main-book claim
// on forward data BEFORE committing anything live (champion/challenger, measure-before-mechanism).
//
// Phase-1 signal is built from EXISTING StockData fields (non-invasive — does not touch the live
// trade-data path). RSI / distance-from-20d-MA is a Phase-2 refinement if the shadow looks promising.
// ─────────────────────────────────────────────────────────────────────────────

import type { StockData } from "./market-data";

// ── Signal thresholds (tunable — it's a zero-capital shadow; refine from the captured data) ──
export const MEANREV_MAX_DIST_FROM_HIGH = -15; // ≥15% below its 52-week high → genuinely pulled back
export const MEANREV_MAX_CHANGE5D = -5;        // down ≥5% over the last ~week → a recent loser (reversal signal)
export const MEANREV_MIN_CHANGE1D = 0;         // stabilizing: NOT still dropping today (weak "turned up" proxy)
export const MEANREV_TOP_N = 5;                // candidates logged per day

export interface MeanRevCandidate {
  symbol: string;
  price: number;
  distFrom52wHigh: number;
  change5d: number;
  change30d: number;
  quality: number;
  oversoldScore: number; // ranking key: deeper drawdown × quality (prefer oversold QUALITY, not junk)
}

/**
 * Pure screen: quality names that are oversold, stabilizing, and NOT broken. Injected closures keep
 * it unit-testable without market data / Redis.
 *  - `eligible`  : quality-eligible set (quality ≥ universe median)
 *  - `qualityOf` : 0-1 quality score (weights the oversold ranking toward quality)
 *  - `isBroken`  : true if the drop is a real negative catalyst (bearish news / downgrade / imminent
 *                  earnings) — those aren't reverting, they're broken; exclude them.
 */
export function screenMeanReversionCandidates(
  stocks: StockData[],
  eligible: Set<string>,
  qualityOf: (sym: string) => number,
  isBroken: (sym: string) => boolean,
  topN: number = MEANREV_TOP_N,
): MeanRevCandidate[] {
  return stocks
    .filter(s =>
      eligible.has(s.symbol) &&                          // quality gate — oversold QUALITY, not oversold junk
      s.distFrom52wHigh <= MEANREV_MAX_DIST_FROM_HIGH &&  // well off its highs (a real pullback)
      s.change5d <= MEANREV_MAX_CHANGE5D &&               // recent sharp drop — the short-term-reversal setup
      s.change1d >= MEANREV_MIN_CHANGE1D &&               // stabilizing — not still cratering today (anti-falling-knife)
      !isBroken(s.symbol))                                // the drop isn't a broken thesis
    .map(s => {
      const quality = qualityOf(s.symbol);
      // deeper 5-day drawdown = more oversold; scale by quality so a high-quality dip outranks a junk crash.
      const oversoldScore = -s.change5d * (0.5 + quality);
      return { symbol: s.symbol, price: s.price, distFrom52wHigh: s.distFrom52wHigh, change5d: s.change5d, change30d: s.change30d, quality, oversoldScore };
    })
    .sort((a, b) => b.oversoldScore - a.oversoldScore)
    .slice(0, topN);
}

// ── Shadow store: an append-only daily log of the candidate set (Upstash REST, same pattern as the
// other ledgers). Mean-reversion signals are EPISODIC (a name gets oversold, reverts, re-oversolds),
// so we snapshot the daily SET rather than a first-seen-per-ticker ledger — that preserves each
// episode for the forward-return + correlation analysis (Phase 1b, once data accrues). ────────────
const SHADOW_KEY = "robinhood:meanrev-shadow";
const SHADOW_MAX_DAYS = 200; // ~9 trading months; bounds the stored series

export interface ShadowDay {
  date: string; // YYYY-MM-DD
  candidates: Array<{ symbol: string; price: number; distFrom52wHigh: number; change5d: number; quality: number }>;
}

async function shadowGet(): Promise<ShadowDay[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${SHADOW_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as { result: string | null };
    if (json.result == null) return [];              // no log yet — an empty (not failed) read
    return JSON.parse(json.result) as ShadowDay[];
  } catch { return null; }                            // read FAILED — signal the caller to skip the write
}

async function shadowSet(days: ShadowDay[]): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", SHADOW_KEY, JSON.stringify(days.slice(-SHADOW_MAX_DAYS))]]),
    });
  } catch { /* best-effort */ }
}

/**
 * Append today's candidate snapshot. Idempotent per date (a re-run replaces today's entry). FAIL-SAFE
 * — never throws and never clobbers accumulated history on a failed read: a shadow log must never be
 * able to affect (or break) the live trade run.
 */
export async function recordMeanRevShadow(candidates: MeanRevCandidate[], today: string): Promise<{ logged: number; skipped?: boolean }> {
  const days = await shadowGet();
  if (days === null) return { logged: 0, skipped: true }; // read failed — do NOT overwrite the history
  const entry: ShadowDay = {
    date: today,
    candidates: candidates.map(c => ({ symbol: c.symbol, price: c.price, distFrom52wHigh: c.distFrom52wHigh, change5d: c.change5d, quality: c.quality })),
  };
  const merged = [...days.filter(d => d.date !== today), entry].sort((a, b) => a.date.localeCompare(b.date));
  await shadowSet(merged);
  return { logged: candidates.length };
}

export async function getMeanRevShadow(): Promise<ShadowDay[]> {
  return (await shadowGet()) ?? [];
}
