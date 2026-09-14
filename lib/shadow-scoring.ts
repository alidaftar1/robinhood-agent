// ─────────────────────────────────────────────────────────────────────────────
// SHADOW SCORING — turns a Phase-1 capture into something you can actually read.
//
// Both shadow captures (lib/mean-reversion.ts, lib/giveback-shadow.ts) log the ENTRY STATE of a
// signal — symbol, price, date — and nothing else. That is enough to instrument but not to measure:
// as of 2026-09-14 the mean-reversion capture held 34 candidate-observations and the give-back
// capture 21 trigger-events, and neither could answer "did the signal work?" because no forward
// return was ever recorded. Waiting longer would only have produced more unanalysable rows.
//
// The stored price + date are sufficient to compute the outcome on READ, exactly the way
// lib/signal-ledger.ts already does. Nothing new is stored and no capture is changed — this module
// is pure measurement over data that already exists, so it cannot affect trading.
//
// TWO THINGS THIS DELIBERATELY GETS RIGHT:
//
// 1. DIRECTION. Mean-reversion is an ENTRY signal (buy the oversold name) — it was right when the
//    price went UP afterwards. Give-back is an EXIT signal (sell the bleeding name) — it was right
//    when the price went DOWN afterwards, because selling avoided that loss. The same +3% forward
//    return is a win for one and a whipsaw for the other. Scoring them with one sign convention
//    would make the give-back numbers read backwards, so `direction` is required, not optional.
//
// 2. BENCHMARK. "AMGN rose 2%" means nothing if the market rose 3%. Each observation is measured
//    against SPY over ITS OWN window (capture date → today), so a signal isn't credited for beta it
//    would have got from any long position. One extra fetch covers every observation.
//
// It also reports `distinctSymbols` alongside `observations`, because these samples are heavily
// correlated — the same few holdings recur on consecutive days in one regime (ILMN and AMAT each
// appear 5× in the give-back capture). Reading 21 as 21 independent experiments would badly
// overstate the evidence; the distinct count is the honest denominator.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchQuoteLite } from "./market-data";

export interface ShadowObservation {
  symbol: string;
  price: number;  // price at capture — the baseline for the forward return
  date: string;   // YYYY-MM-DD capture date
}

export interface ScoredShadowObservation extends ShadowObservation {
  currentPrice: number | null;
  forwardReturnPct: number | null;  // (current / capture − 1) × 100
  spyReturnPct: number | null;      // SPY over the SAME window
  excessReturnPct: number | null;   // forwardReturn − spyReturn (the signal's own contribution)
  daysElapsed: number;
  /** Direction-aware: did the signal call it correctly? null when unmeasurable. */
  correct: boolean | null;
}

export interface ShadowStats {
  direction: "entry" | "exit";
  observations: number;      // raw rows captured
  distinctSymbols: number;   // the honest denominator — see header note on correlation
  measurable: number;        // rows with a live quote (the rest are excluded, never counted as 0)
  avgForwardReturnPct: number;
  avgSpyReturnPct: number;
  avgExcessReturnPct: number;
  hitRatePct: number;        // % of measurable rows where the signal was RIGHT
  verdict: string;
}

const UNMEASURABLE: ShadowStats = {
  direction: "entry", observations: 0, distinctSymbols: 0, measurable: 0,
  avgForwardReturnPct: 0, avgSpyReturnPct: 0, avgExcessReturnPct: 0, hitRatePct: 0,
  verdict: "No measurable observations yet.",
};

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/**
 * SPY close per calendar day, from one fetch. Used to benchmark each observation over its own
 * window. Falls back to the nearest PRIOR close when a capture date isn't a trading day (holiday),
 * which is the correct reference for a position opened on that date.
 */
async function fetchSpyCloses(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return out;
    const data = await res.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> } };
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && isFinite(c)) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
    }
  } catch { /* fail-safe: no benchmark rather than no scoring */ }
  return out;
}

function spyCloseOnOrBefore(closes: Map<string, number>, date: string): number | null {
  if (closes.size === 0) return null;
  const direct = closes.get(date);
  if (direct != null) return direct;
  // Walk back up to ~10 days for a holiday / weekend capture date.
  const d = Date.parse(date);
  if (!Number.isFinite(d)) return null;
  for (let back = 1; back <= 10; back++) {
    const prior = new Date(d - back * 86_400_000).toISOString().slice(0, 10);
    const c = closes.get(prior);
    if (c != null) return c;
  }
  return null;
}

/**
 * Scores captured observations against live prices and SPY. One quote per DISTINCT symbol — the
 * same name recurring across days shares today's price, so repeated captures cost nothing extra.
 */
export async function scoreShadowObservations(
  observations: ShadowObservation[],
  today: string,
  direction: "entry" | "exit",
): Promise<{ scored: ScoredShadowObservation[]; stats: ShadowStats }> {
  if (observations.length === 0) return { scored: [], stats: { ...UNMEASURABLE, direction } };

  const symbols = [...new Set(observations.map(o => o.symbol))];
  const priceBySymbol = new Map<string, number | null>();
  const BATCH = 8;
  for (let i = 0; i < symbols.length; i += BATCH) {
    await Promise.all(symbols.slice(i, i + BATCH).map(async sym => {
      priceBySymbol.set(sym, (await fetchQuoteLite(sym).catch(() => null))?.price ?? null);
    }));
  }
  const spyCloses = await fetchSpyCloses();
  const spyNow = spyCloseOnOrBefore(spyCloses, today);

  const scored: ScoredShadowObservation[] = observations.map(o => {
    const currentPrice = priceBySymbol.get(o.symbol) ?? null;
    const forwardReturnPct = currentPrice != null && o.price > 0
      ? (currentPrice / o.price - 1) * 100
      : null;
    const spyThen = spyCloseOnOrBefore(spyCloses, o.date);
    const spyReturnPct = spyNow != null && spyThen != null && spyThen > 0
      ? (spyNow / spyThen - 1) * 100
      : null;
    const excessReturnPct = forwardReturnPct != null && spyReturnPct != null
      ? forwardReturnPct - spyReturnPct
      : null;
    // An entry signal is right when the name rose; an exit signal is right when it kept falling
    // (selling avoided that loss). Judged on EXCESS return where the benchmark is available, so a
    // signal isn't credited for a market-wide move it had nothing to do with.
    const basis = excessReturnPct ?? forwardReturnPct;
    const correct = basis == null ? null : direction === "entry" ? basis > 0 : basis < 0;
    return { ...o, currentPrice, forwardReturnPct, spyReturnPct, excessReturnPct, daysElapsed: daysBetween(o.date, today), correct };
  });

  const measurable = scored.filter(s => s.forwardReturnPct != null);
  if (measurable.length === 0) {
    return { scored, stats: { ...UNMEASURABLE, direction, observations: observations.length, distinctSymbols: symbols.length } };
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgForwardReturnPct = mean(measurable.map(s => s.forwardReturnPct as number));
  const withSpy = measurable.filter(s => s.excessReturnPct != null);
  const avgSpyReturnPct = withSpy.length ? mean(withSpy.map(s => s.spyReturnPct as number)) : 0;
  const avgExcessReturnPct = withSpy.length ? mean(withSpy.map(s => s.excessReturnPct as number)) : 0;
  const judged = scored.filter(s => s.correct != null);
  const hitRatePct = judged.length ? (judged.filter(s => s.correct).length / judged.length) * 100 : 0;

  return {
    scored,
    stats: {
      direction,
      observations: observations.length,
      distinctSymbols: symbols.length,
      measurable: measurable.length,
      avgForwardReturnPct,
      avgSpyReturnPct,
      avgExcessReturnPct,
      hitRatePct,
      verdict: buildVerdict(direction, observations.length, symbols.length, avgExcessReturnPct, hitRatePct),
    },
  };
}

/**
 * Plain-language read that refuses to overclaim. The sample gate is deliberately strict: these
 * captures produce heavily correlated rows, so a flattering average over a handful of names in one
 * regime is noise, and the verdict says so rather than inviting a decision.
 */
function buildVerdict(direction: "entry" | "exit", observations: number, distinctSymbols: number, avgExcess: number, hitRate: number): string {
  const action = direction === "entry" ? "buying these" : "selling these";
  const sign = avgExcess >= 0 ? "+" : "";
  const measured = `${action} averaged ${sign}${avgExcess.toFixed(1)}% vs SPY over each observation's own window, right ${hitRate.toFixed(0)}% of the time`;
  if (distinctSymbols < 20) {
    return `TOO EARLY — ${observations} observations across only ${distinctSymbols} distinct names, heavily correlated (the same holdings recur across consecutive days in one market regime). ${measured}. Not a result; do not act on it.`;
  }
  return `${measured}. Still a small, single-regime sample — treat as a hint, not a verdict.`;
}
