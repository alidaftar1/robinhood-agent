/**
 * Close-to-close return series, derived on read from the stored closing-bell snapshots.
 *
 * Nothing here is persisted. See lib/close-snapshot.ts for why: a stored derived number outlives the
 * discovery that it was wrong, and this project already carries two backfill endpoints written to
 * undo exactly that mistake.
 *
 * The trade window matters and is easy to get backwards. Trades fill at ~10:30 ET, BETWEEN two
 * closes, so the fills belonging to the close(N−1) → close(N) window are date N's trades. They come
 * from the canonical merged run per date, so a day with an intraday drop-check sell (which writes a
 * second run for the same date) contributes all of its fills exactly once.
 */
import { requireCronAuth } from "@/lib/auth";
import { getRuns, mergeRunsByDate, MAX_RUNS, type TradeSnapshot } from "@/lib/run-store";
import { getCloseSnapshots, computeCloseReturns, summarizeCloseReturns } from "@/lib/close-snapshot";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const [snapshots, runs] = await Promise.all([getCloseSnapshots(), getRuns(MAX_RUNS)]);

  const tradesByDate = new Map<string, TradeSnapshot[]>();
  for (const r of mergeRunsByDate(runs)) tradesByDate.set(r.date, r.trades ?? []);

  const returns = computeCloseReturns(snapshots, tradesByDate);
  const summary = summarizeCloseReturns(returns);

  return Response.json({
    summary,
    snapshotCount: snapshots.length,
    returns: returns.map((r) => ({
      date: r.date,
      prevDate: r.prevDate,
      bookPct: r.bookReturn == null ? null : r.bookReturn * 100,
      spyPct: r.spyReturn == null ? null : r.spyReturn * 100,
      activePct: r.activeReturn == null ? null : r.activeReturn * 100,
      impliedTransfer: r.impliedTransfer,
      ...(r.withheldReason ? { withheldReason: r.withheldReason } : {}),
    })),
  });
}
