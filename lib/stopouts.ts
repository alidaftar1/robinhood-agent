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
