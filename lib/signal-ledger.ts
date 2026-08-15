// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL-ATTRIBUTION LEDGER
//
// Logs every BUY with the signals present at buy time, then measures each signal's
// forward return — so we can eventually see which signals (★INS insider, ⚡NEWS, ↑/↓FIRM
// analyst, earnings-beat record, influencer backing) actually predict, from our OWN trades.
//
// Forward-only: signals can't be reconstructed for past trades, so it accumulates from the
// first record. Same honesty caveats as the influencer ledger — small samples early,
// correlation ≠ causation, regime-dependent. This is a MEASUREMENT layer: it surfaces which
// signals have edge; a human decides what to do about it. Nothing here changes a trade.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchQuoteLite } from "@/lib/market-data";

const LEDGER_KEY = "robinhood:signal-ledger";

export interface SignalSnapshot {
  mom12_1: number | null;          // 12-1 momentum %
  quality: number | null;          // quality score 0–1
  beta: number | null;
  insider: boolean;                // ★INS recent insider buying
  analyst: "up" | "down" | null;   // most recent analyst action (upgrade/raise → up)
  news: "up" | "down" | null;      // ⚡NEWS material-event direction
  earnBeatRate: number | null;     // beats/total from the earnings-beat record
  influencerNet: number | null;    // influencer cross-signal net (weighted-buy − avoid)
}

export interface SignalPick {
  symbol: string;
  date: string;                    // buy date (YYYY-MM-DD)
  strategy: string;                // "main" | "influencer"
  priceAtBuy: number;              // baseline for the forward return
  signals: SignalSnapshot;
}

export interface SignalPickOutcome extends SignalPick {
  currentPrice: number | null;
  returnPct: number | null;        // (current / priceAtBuy − 1) × 100
  daysElapsed: number;
}

export interface SignalStat {
  signal: string;                  // human label, e.g. "★INS insider buying"
  picks: number;                   // measurable picks that carried this signal
  avgReturnPct: number;            // mean forward return of those picks
  hitRatePct: number;              // % of them positive
  vsBaselinePct: number;           // avgReturnPct − baseline (mean over ALL measurable picks)
}

const keyOf = (p: { symbol: string; date: string }) => `${p.symbol}|${p.date}`;

// ── Redis (persistent, NOT TTL'd — the historical record). One JSON blob keyed by symbol|date;
// single writer (/api/trade on a confirmed buy), so read-modify-write is safe. Same null-on-read-
// error contract as the influencer ledger: a transient hiccup must never be treated as empty and
// overwritten (that would wipe accumulated history). ─────────────────────────────────────────────
async function ledgerGet(): Promise<Record<string, SignalPick> | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${LEDGER_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: string | null };
    if (json.result == null) return {};
    return JSON.parse(json.result) as Record<string, SignalPick>;
  } catch {
    return null;
  }
}

async function ledgerSet(data: Record<string, SignalPick>): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", LEDGER_KEY, JSON.stringify(data)]]),
  });
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

// Log each buy's signal snapshot ONCE (first time it's seen, so the baseline price + signals are
// the ones at entry). Fail-safe: a read error skips the write rather than clobbering history.
export async function recordSignalPicks(picks: SignalPick[]): Promise<{ recorded: number; skipped?: boolean }> {
  if (picks.length === 0) return { recorded: 0 };
  const ledger = await ledgerGet();
  if (ledger === null) return { recorded: 0, skipped: true };
  let recorded = 0;
  for (const p of picks) {
    if (!p.priceAtBuy || p.priceAtBuy <= 0) continue;
    const k = keyOf(p);
    if (ledger[k]) continue; // already logged this buy event
    ledger[k] = p;
    recorded++;
  }
  if (recorded > 0) await ledgerSet(ledger);
  return { recorded };
}

// The binary signal flags we attribute. Continuous signals (momentum/quality/beta) are stored on
// each pick for future binned analysis but not aggregated here yet (binning needs more picks).
const SIGNAL_FLAGS: Array<{ label: string; has: (s: SignalSnapshot) => boolean }> = [
  { label: "★INS insider buying", has: (s) => s.insider },
  { label: "↑FIRM analyst upgrade", has: (s) => s.analyst === "up" },
  { label: "↓FIRM analyst downgrade", has: (s) => s.analyst === "down" },
  { label: "⚡NEWS↑ bullish event", has: (s) => s.news === "up" },
  { label: "⚡NEWS↓ bearish event", has: (s) => s.news === "down" },
  { label: "📈 strong earnings record", has: (s) => s.earnBeatRate != null && s.earnBeatRate >= 0.6 },
  { label: "🎬 influencer-backed (net≥3)", has: (s) => s.influencerNet != null && s.influencerNet >= 3 },
];

// PURE: given scored picks, attribute forward return to each signal flag — with-signal average vs
// the baseline (all-picks average). Positive vsBaseline = picks carrying that signal beat the
// typical pick. Exported for testing without Redis.
export function attributeSignals(picks: Array<{ returnPct: number | null; signals: SignalSnapshot }>): SignalStat[] {
  const measurable = picks.filter((p): p is { returnPct: number; signals: SignalSnapshot } => p.returnPct != null);
  if (measurable.length === 0) return [];
  const baseline = measurable.reduce((a, p) => a + p.returnPct, 0) / measurable.length;
  return SIGNAL_FLAGS.map((f) => {
    const g = measurable.filter((p) => f.has(p.signals));
    const n = g.length;
    const avg = n ? g.reduce((a, p) => a + p.returnPct, 0) / n : 0;
    const hit = n ? (g.filter((p) => p.returnPct > 0).length / n) * 100 : 0;
    return { signal: f.label, picks: n, avgReturnPct: avg, hitRatePct: hit, vsBaselinePct: avg - baseline };
  })
    .filter((s) => s.picks > 0)
    .sort((a, b) => b.vsBaselinePct - a.vsBaselinePct);
}

// Read-only: score every logged pick's forward return, then attribute per signal.
export async function computeSignalAttribution(today: string): Promise<{ picks: SignalPickOutcome[]; signals: SignalStat[]; baselineReturnPct: number }> {
  const ledger = await ledgerGet();
  const entries = Object.values(ledger ?? {});
  const picks: SignalPickOutcome[] = await Promise.all(
    entries.map(async (p) => {
      const currentPrice = (await fetchQuoteLite(p.symbol))?.price ?? null;
      const returnPct = currentPrice != null && p.priceAtBuy > 0 ? (currentPrice / p.priceAtBuy - 1) * 100 : null;
      return { ...p, currentPrice, returnPct, daysElapsed: daysBetween(p.date, today) };
    }),
  );
  const measurable = picks.filter((p) => p.returnPct != null);
  const baselineReturnPct = measurable.length ? measurable.reduce((a, p) => a + (p.returnPct as number), 0) / measurable.length : 0;
  picks.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
  return { picks, signals: attributeSignals(picks), baselineReturnPct };
}
