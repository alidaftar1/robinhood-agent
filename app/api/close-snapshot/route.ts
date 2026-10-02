/**
 * CLOSING-BELL SNAPSHOT CRON — records the book and SPY at the official close.
 *
 * NOT SCHEDULED. vercel.json carries no cron for this route and that is deliberate — the only
 * consumer is a periodic live-vs-backtest comparison, which scripts/close-reconstruct.ts serves
 * better because it needs no write path into live-money data and covers the EXISTING run history a
 * forward-only capture can never reach. Nothing writes this series today, so do not read
 * /api/close-returns as a running record. (The header previously claimed it WAS scheduled, which
 * would lead a reader — or the autopilot, which reads these files — to believe a close series is
 * being captured when nothing writes it.)
 *
 * To ENABLE it, add `{ "path": "/api/close-snapshot", "schedule": "10 21 * * 1-5" }` to vercel.json.
 * 21:10 UTC lands after the close in BOTH halves of the year: 17:10 ET under EDT and 16:10 ET under
 * EST (the close itself is 20:00 UTC in EDT, 21:00 UTC in EST), so one fixed-UTC cron is correct
 * year-round without a DST-aware scheduler. evals/close-snapshot.test.ts guards that line: its
 * config-invariant test asserts the scheduled time is post-close in January AND July *if* the cron
 * is present. The handler verifies the ET clock itself rather than trusting the schedule — a manual
 * call, a retry, or a platform change in cron semantics must not be able to write a mid-session
 * mark into the series.
 *
 * This route NEVER trades. It holds the MCP token only for two read-only calls (get_portfolio,
 * get_equity_positions) and no untrusted input reaches a model at any point.
 *
 * See lib/close-snapshot.ts for why this stores observations and not returns.
 */
import { requireCronAuth } from "@/lib/auth";
import { createAnthropic } from "@/lib/anthropic";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { fetchCurrentPrice, enrichPriceMap } from "@/lib/market-data";
import { fetchAgenticBalance, fetchAgenticPositions } from "@/lib/robinhood-balance";
import { isMarketHoliday } from "@/lib/holidays";
import {
  etParts, isAfterUsEquityClose, validateCloseSnapshot, saveCloseSnapshot, getCloseSnapshots,
  type CloseSnapshot,
} from "@/lib/close-snapshot";
import type { PositionSnapshot } from "@/lib/run-store";

export const maxDuration = 120;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const now = new Date();
  const { date, minutes } = etParts(now);

  // ── guards: refuse to write anything that is not a settled close on a trading day ──
  // There is deliberately NO override for these. A `force=1` escape hatch is how a mid-session mark
  // ends up in a close-to-close series, and the whole point of the series is that its clock is known.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return Response.json({ skipped: true, reason: "weekend", date });
  }
  if (isMarketHoliday(date)) {
    return Response.json({ skipped: true, reason: "market holiday", date });
  }
  if (!isAfterUsEquityClose(now)) {
    // Not an error — a legitimate early call. Writing here would store a mid-session price AS a close.
    console.warn("CLOSE_SNAPSHOT_TOO_EARLY", { date, etMinutes: minutes });
    return Response.json({ skipped: true, reason: "before_settled_close", date, etMinutes: minutes });
  }

  // Idempotent: the cron may fire twice, or be invoked by hand after it already ran.
  const existing = await getCloseSnapshots(5);
  if (existing.some((s) => s.date === date)) {
    return Response.json({ skipped: true, reason: "already_captured", date });
  }

  const accessToken = await getValidAccessToken();
  const anthropic = createAnthropic();
  const [spyClose, balance, livePositions] = await Promise.all([
    fetchCurrentPrice("SPY"),
    fetchAgenticBalance(anthropic, accessToken),
    fetchAgenticPositions(anthropic, accessToken),
  ]);

  // Price every holding at ITS close. enrichPriceMap returns the symbols it could not resolve; those
  // must not be stored at avgCost (see validateCloseSnapshot) so they are left unpriced on purpose
  // and the validator rejects the whole snapshot.
  const priceMap = new Map<string, number>();
  let unresolved: string[] = [];
  if (livePositions && livePositions.length > 0) {
    unresolved = await enrichPriceMap(livePositions.map((p) => p.symbol), priceMap);
  }

  const positions: PositionSnapshot[] | null = livePositions
    ? livePositions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.avgCost,
        price: String(priceMap.get(p.symbol) ?? ""),
      }))
    : null;

  const verdict = validateCloseSnapshot({
    spyClose,
    totalValue: balance?.totalValue ?? null,
    positions,
  });

  if (!verdict.ok) {
    // WITHHELD, not degraded-and-stored. A hole in the series is visible and self-heals tomorrow;
    // a snapshot with one position marked at cost silently injects a phantom move into the next
    // day's return and cannot be detected after the fact.
    console.error("CLOSE_SNAPSHOT_WITHHELD", {
      date, reason: verdict.reason, unresolved,
      spyClose, totalValue: balance?.totalValue ?? null, positionCount: positions?.length ?? null,
    });
    return Response.json(
      { stored: false, withheld: true, reason: verdict.reason, date, unresolved },
      { status: 200 },
    );
  }

  const snapshot: CloseSnapshot = {
    date,
    capturedAt: now.toISOString(),
    spyClose: spyClose as number,
    totalValue: balance!.totalValue,
    positions: positions!,
  };

  if (dryRun) {
    return Response.json({ stored: false, dryRun: true, snapshot });
  }

  await saveCloseSnapshot(snapshot);
  console.log("CLOSE_SNAPSHOT_STORED", {
    date, spyClose: snapshot.spyClose, totalValue: snapshot.totalValue, positions: snapshot.positions.length,
  });
  return Response.json({ stored: true, date, snapshot });
}
