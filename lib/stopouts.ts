import { redisCommand } from "@/lib/run-store";

// Recent stop-out registry. When a name is stopped out (drop-check −5% exit), the
// next analysis run is otherwise BLIND to it — the name vanishes from positions and
// reappears on the shortlist as a fresh candidate, so the book re-buys the thing it
// just dumped at a loss (the GOOGL 07-23→07-24 whipsaw). This surfaces recent
// stop-outs to the analysis so it can REASON about re-entry (skip the churn, or
// re-enter only with a specific justification), and lets the run deterministically
// FLAG a re-buy of a recently-stopped name for the owner/reviewer to audit.
//
// Design note (LLM-vs-code boundary): tracking + the re-entry FLAG are deterministic
// (membership — code); the keep/skip/re-enter DECISION is a context-dependent
// judgment (sympathy-dip vs real breakdown — the LLM), verified by the flag.

const KEY = "stopouts";
const RECENT_DAYS = 10; // surface stop-outs from the last ~10 calendar days

export interface Stopout {
  symbol: string;
  date: string;      // YYYY-MM-DD the stop fired
  changePct: number; // the drop that triggered it (negative)
}

// Record a stop-loss exit. Non-fatal on failure — a missed record just means the
// next run won't see this one (it degrades to today's blind behavior, never worse).
export async function recordStopout(symbol: string, date: string, changePct: number): Promise<void> {
  try {
    await redisCommand("HSET", KEY, symbol, JSON.stringify({ symbol, date, changePct } satisfies Stopout));
  } catch (e) {
    console.warn("STOPOUT_RECORD_FAILED", symbol, e instanceof Error ? e.message : String(e));
  }
}

// Recent stop-outs (within RECENT_DAYS of `today`), pruning stale entries as it reads.
// Returns [] on any failure so the trade pipeline is never blocked by this.
export async function getRecentStopouts(today: string): Promise<Stopout[]> {
  try {
    const res = await redisCommand("HGETALL", KEY);
    const flat = Array.isArray(res) ? (res as string[]) : []; // Upstash: [field, val, field, val, …]
    const fresh: Stopout[] = [];
    const stale: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = flat[i];
      try {
        const s = JSON.parse(flat[i + 1]) as Stopout;
        const daysAgo = (new Date(today).getTime() - new Date(s.date).getTime()) / 86_400_000;
        if (daysAgo >= 0 && daysAgo <= RECENT_DAYS) fresh.push(s);
        else stale.push(field);
      } catch {
        stale.push(field);
      }
    }
    if (stale.length) {
      try { await redisCommand("HDEL", KEY, ...stale); } catch { /* prune is best-effort */ }
    }
    return fresh.sort((a, b) => (a.date < b.date ? 1 : -1)); // most recent first
  } catch {
    return [];
  }
}

// Human-readable "N days ago" for the prompt/flag.
export function daysAgo(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

// ── Recent DISCRETIONARY sells (rotation-churn guard) ────────────────────────
// Companion to the stop-out registry above, for the OTHER re-entry blind spot: a
// main-book name the analysis SOLD as a discretionary/rotation exit (NOT a −5% stop)
// vanishes from positions and reappears on the shortlist, so the model re-buys it a
// day later at ~the same price/momentum for no strategic gain (the ILMN 08-06→08-07
// churn; registry #14). Same hybrid: tracking + the churn FLAG are deterministic
// (code); whether a re-buy is justified by a genuine fresh catalyst is the LLM's call.
const SELLS_KEY = "recent-sells";
const RECENT_SELL_DAYS = 5; // churn is a within-a-few-days re-buy; an exit re-bought weeks later isn't churn

export interface RecentSell {
  symbol: string;
  date: string;  // YYYY-MM-DD the discretionary sell executed
  price: number; // the sell fill (for the "sold at $X" round-trip context)
}

// Record a discretionary main-book sell. Non-fatal — a missed record degrades to
// today's blind behavior, never worse.
export async function recordSell(symbol: string, date: string, price: number): Promise<void> {
  try {
    await redisCommand("HSET", SELLS_KEY, symbol, JSON.stringify({ symbol, date, price } satisfies RecentSell));
  } catch (e) {
    console.warn("RECENT_SELL_RECORD_FAILED", symbol, e instanceof Error ? e.message : String(e));
  }
}

// Recent discretionary sells (within RECENT_SELL_DAYS of `today`), pruning stale entries
// as it reads. Returns [] on any failure so the pipeline is never blocked.
export async function getRecentSells(today: string): Promise<RecentSell[]> {
  try {
    const res = await redisCommand("HGETALL", SELLS_KEY);
    const flat = Array.isArray(res) ? (res as string[]) : [];
    const fresh: RecentSell[] = [];
    const stale: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = flat[i];
      try {
        const s = JSON.parse(flat[i + 1]) as RecentSell;
        const ago = (new Date(today).getTime() - new Date(s.date).getTime()) / 86_400_000;
        if (ago >= 0 && ago <= RECENT_SELL_DAYS) fresh.push(s);
        else stale.push(field);
      } catch {
        stale.push(field);
      }
    }
    if (stale.length) { try { await redisCommand("HDEL", SELLS_KEY, ...stale); } catch { /* best-effort */ } }
    return fresh.sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch {
    return [];
  }
}

// Resolve a drop-check trigger set into what to SELL vs HOLD, given the reasoning model's
// sympathy-hold list. Pure + deterministic — the two invariants that must never regress:
//   1. TAKE-PROFITS ALWAYS SELL — never held on sympathy (a winner locking its gain is not a
//      thesis-breakdown judgment call), even if the model erroneously lists it as a hold.
//   2. A STOP-LOSS is SOLD unless the model explicitly held it on sympathy.
// Buys are impossible here — the caller only ever builds sell orders from `exiting`.
export function resolveDropCheckExits<T extends { position: { symbol: string }; reason: "stop" | "profit" }>(
  dropped: T[],
  sympathyHolds: Set<string>,
): { exiting: T[]; heldOnSympathy: string[] } {
  const exiting = dropped.filter((e) => e.reason === "profit" || !sympathyHolds.has(e.position.symbol));
  const heldOnSympathy = dropped
    .filter((e) => e.reason === "stop" && sympathyHolds.has(e.position.symbol))
    .map((e) => e.position.symbol);
  return { exiting, heldOnSympathy };
}
