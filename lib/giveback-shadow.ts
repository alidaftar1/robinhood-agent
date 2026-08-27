// ─────────────────────────────────────────────────────────────────────────────
// GIVE-BACK STOP — SHADOW CAPTURE (Phase 1: zero capital, measure-first)
//
// The main-book stop is −5% INTRADAY (a CRASH). It is structurally blind to a SLOW BLEED — a name
// (or the whole book) drifting down 4–8% over a week via sub-5% daily drips never triggers (verified
// 2026-08-27: APA/LLY/AMAT/TRGP each bled 4–8% over 5d, worst single day −1.7% to −3.7%, none fired,
// −4% book week vs SPY +0.44%). A give-back stop WOULD catch these — but cutting a momentum name on a
// normal pullback WHIPSAWS (sell low, it recovers, re-buy high = the churn we fight), so we do NOT
// know if it helps. This SHADOW logs which held names WOULD trip a give-back stop each day (+ their
// price), so we can later MEASURE the forward outcome: did shadow-cut names keep falling (a stop
// helps) or bounce (a stop whipsaws)? ZERO capital — it places no orders and changes no behavior.
// ─────────────────────────────────────────────────────────────────────────────

// The give-back trigger: a MAIN holding down ≥ this over ~5 trading days (the slow bleed the −5%
// intraday stop misses). Tunable — it's a zero-capital shadow; refine from the captured outcomes.
export const GIVEBACK_5D_THRESHOLD = -5;

export interface GivebackHolding {
  symbol: string;
  price: number;
  change5d: number;              // 5-trading-day % change (the give-back signal)
  distFromHigh: number;          // % below 52-week high (context: how far it's rolled over)
  retFromCostPct: number | null; // return vs entry: >0 = giving back a WINNER; <0 = bleeding into a LOSS
}

/**
 * Pure screen: which MAIN holdings are in a give-back slow-bleed today. `retFromCostPct` is carried
 * (not filtered on) so the Phase-1b analysis can separate two very different cases — a winner giving
 * back (APA +22%, likely a pullback → whipsaw risk) vs a name bleeding into a loss (LLY, closer to
 * the LOSS-DISCIPLINE backstop). Injected values keep it unit-testable without market data.
 */
export function screenGivebackStops(
  holdings: GivebackHolding[],
  threshold: number = GIVEBACK_5D_THRESHOLD,
): GivebackHolding[] {
  return holdings
    .filter(h => Number.isFinite(h.change5d) && h.change5d <= threshold)
    .sort((a, b) => a.change5d - b.change5d); // deepest bleed first
}

// ── Shadow store: append-only daily log of give-back trigger snapshots (same Upstash REST pattern as
// the mean-reversion shadow). We snapshot the daily SET of triggered holdings + their price, so the
// forward-outcome analysis (Phase 1b) can measure each trigger's forward return from that price. ────
const SHADOW_KEY = "robinhood:giveback-shadow";
const SHADOW_MAX_DAYS = 200;

export interface GivebackDay {
  date: string;
  holdings: GivebackHolding[];
}

async function shadowGet(): Promise<GivebackDay[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${SHADOW_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as { result: string | null };
    if (json.result == null) return [];              // no log yet — an empty (not failed) read
    return JSON.parse(json.result) as GivebackDay[];
  } catch { return null; }                            // read FAILED — caller skips the write
}

async function shadowSet(days: GivebackDay[]): Promise<void> {
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
 * Append today's give-back trigger snapshot. Idempotent per date. FAIL-SAFE — never throws, never
 * clobbers accumulated history on a failed read: a shadow log must never affect the live trade run.
 */
export async function recordGivebackShadow(holdings: GivebackHolding[], today: string): Promise<{ logged: number; skipped?: boolean }> {
  const days = await shadowGet();
  if (days === null) return { logged: 0, skipped: true }; // read failed — do NOT overwrite history
  const merged = [...days.filter(d => d.date !== today), { date: today, holdings }].sort((a, b) => a.date.localeCompare(b.date));
  await shadowSet(merged);
  return { logged: holdings.length };
}

export async function getGivebackShadow(): Promise<GivebackDay[]> {
  return (await shadowGet()) ?? [];
}
