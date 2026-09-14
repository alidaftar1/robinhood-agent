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
  distinctSymbols: number;   // distinct names across those rows
  measurable: number;        // rows with a live quote (the rest are excluded, never counted as 0)
  matured: number;           // measurable rows old enough to have a forward window (see MIN_DAYS_ELAPSED)
  benchmarked: number;       // matured rows that also have a SPY reference
  symbolsScored: number;     // THE HEADLINE DENOMINATOR — one vote per name, not per row
  avgForwardReturnPct: number;
  /** null when the SPY benchmark was unavailable — never 0, which would read as "no alpha". */
  avgSpyReturnPct: number | null;
  avgExcessReturnPct: number | null;
  hitRatePct: number;        // % of scored SYMBOLS where the signal was right
  verdict: string;
}

/**
 * Rows younger than this don't vote. The captures are written on every /api/trade run, so today's
 * rows have daysElapsed 0 and spyThen === spyNow — they'd enter the hit rate as a coin flip on
 * intraday drift with no forward window at all, and a 0-day return would be averaged against a
 * 60-day one as if comparable.
 */
export const MIN_DAYS_ELAPSED = 5;

const UNMEASURABLE: ShadowStats = {
  direction: "entry", observations: 0, distinctSymbols: 0, measurable: 0, matured: 0,
  benchmarked: 0, symbolsScored: 0, avgForwardReturnPct: 0, avgSpyReturnPct: null,
  avgExcessReturnPct: null, hitRatePct: 0,
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
    // WHICH BASIS, AND WHY IT DIFFERS BY DIRECTION:
    //   ENTRY is a RELATIVE choice — you bought this name instead of the market, so it earns credit
    //     only for beating the market. Judged on EXCESS return.
    //   EXIT is an ABSOLUTE one — a give-back stop sells to CASH, and cash doesn't track SPY. If a
    //     stopped name falls 6% while SPY falls 10%, selling genuinely avoided a 6% loss and the
    //     stop was RIGHT, even though its excess is +4%. Judging exits on excess inverts exactly
    //     that case (and credits a stop that sold right before a rally, whenever the rally lagged
    //     SPY). Judged on ABSOLUTE forward return.
    // Caught in review 2026-09-14; the original code used excess for both, and the tests missed it
    // because their SPY stub was flat, making excess ≡ forward.
    const basis = direction === "entry" ? (excessReturnPct ?? forwardReturnPct) : forwardReturnPct;
    const correct = basis == null ? null : direction === "entry" ? basis > 0 : basis < 0;
    return { ...o, currentPrice, forwardReturnPct, spyReturnPct, excessReturnPct, daysElapsed: daysBetween(o.date, today), correct };
  });

  const measurable = scored.filter(s => s.forwardReturnPct != null);
  // Only matured rows vote — see MIN_DAYS_ELAPSED.
  const matured = measurable.filter(s => s.daysElapsed >= MIN_DAYS_ELAPSED);
  if (matured.length === 0) {
    return {
      scored,
      stats: {
        ...UNMEASURABLE, direction,
        observations: observations.length, distinctSymbols: symbols.length, measurable: measurable.length,
        verdict: measurable.length === 0
          ? "No measurable observations yet."
          : `${measurable.length} observations captured but none has a ${MIN_DAYS_ELAPSED}-day forward window yet — nothing to measure.`,
      },
    };
  }

  // ONE VOTE PER NAME. Averaging raw rows lets a single holding that recurs on consecutive days
  // cast several votes over near-identical overlapping windows from near-identical prices — with 21
  // give-back rows across 7 names, one trending name would set the headline. `distinctSymbols` is
  // the denominator this file calls honest, so the headline is computed on it rather than merely
  // disclosing it alongside a row-weighted number.
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const bySymbol = new Map<string, ScoredShadowObservation[]>();
  for (const row of matured) {
    const list = bySymbol.get(row.symbol) ?? [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  const perSymbol = [...bySymbol.values()].map(rows => ({
    forward: mean(rows.map(r => r.forwardReturnPct as number)),
    spy: rows.some(r => r.spyReturnPct != null) ? mean(rows.filter(r => r.spyReturnPct != null).map(r => r.spyReturnPct as number)) : null,
    excess: rows.some(r => r.excessReturnPct != null) ? mean(rows.filter(r => r.excessReturnPct != null).map(r => r.excessReturnPct as number)) : null,
    correct: rows.filter(r => r.correct != null).length
      ? rows.filter(r => r.correct).length / rows.filter(r => r.correct != null).length >= 0.5
      : null,
  }));

  const benchmarkedSymbols = perSymbol.filter(p => p.excess != null);
  // null, never 0 — a silent SPY-fetch failure must not print as "+0.0% vs SPY", a fabricated
  // benchmark claim from a module whose whole point is refusing to overclaim.
  const avgSpyReturnPct = benchmarkedSymbols.length ? mean(benchmarkedSymbols.map(p => p.spy as number)) : null;
  const avgExcessReturnPct = benchmarkedSymbols.length ? mean(benchmarkedSymbols.map(p => p.excess as number)) : null;
  const avgForwardReturnPct = mean(perSymbol.map(p => p.forward));
  const judged = perSymbol.filter(p => p.correct != null);
  const hitRatePct = judged.length ? (judged.filter(p => p.correct).length / judged.length) * 100 : 0;

  return {
    scored,
    stats: {
      direction,
      observations: observations.length,
      distinctSymbols: symbols.length,
      measurable: measurable.length,
      matured: matured.length,
      benchmarked: matured.filter(r => r.excessReturnPct != null).length,
      symbolsScored: perSymbol.length,
      avgForwardReturnPct,
      avgSpyReturnPct,
      avgExcessReturnPct,
      hitRatePct,
      verdict: buildVerdict(direction, matured.length, perSymbol.length, avgForwardReturnPct, avgExcessReturnPct, hitRatePct),
    },
  };
}

/**
 * Plain-language read that refuses to overclaim. Two guards: it never says "vs SPY" unless a
 * benchmark actually exists (a failed SPY fetch must not surface as a confident +0.0% alpha), and
 * it gates on the number of distinct NAMES, because these captures produce heavily correlated rows.
 */
function buildVerdict(
  direction: "entry" | "exit",
  maturedRows: number,
  symbolsScored: number,
  avgForward: number,
  avgExcess: number | null,
  hitRate: number,
): string {
  const action = direction === "entry" ? "buying these" : "selling these";
  const sign = (n: number) => (n >= 0 ? "+" : "");
  // Exits are judged absolutely (they go to cash), so lead with the absolute number for them and
  // the benchmark-relative one for entries — matching how `correct` is decided above.
  const headline = direction === "exit" || avgExcess == null
    ? `${action} averaged ${sign(avgForward)}${avgForward.toFixed(1)}% absolute${avgExcess != null ? ` (${sign(avgExcess)}${avgExcess.toFixed(1)}% vs SPY)` : " — SPY benchmark unavailable, so no market-relative claim"}`
    : `${action} averaged ${sign(avgExcess)}${avgExcess.toFixed(1)}% vs SPY over each observation's own window`;
  const measured = `${headline}, right ${hitRate.toFixed(0)}% of the time across ${symbolsScored} name${symbolsScored === 1 ? "" : "s"}`;
  if (symbolsScored < 20) {
    return `TOO EARLY — ${maturedRows} matured observations across only ${symbolsScored} distinct name${symbolsScored === 1 ? "" : "s"}, heavily correlated (the same holdings recur across consecutive days in one market regime). ${measured}. Not a result; do not act on it.`;
  }
  return `${measured}. Still a small, single-regime sample — treat as a hint, not a verdict.`;
}
