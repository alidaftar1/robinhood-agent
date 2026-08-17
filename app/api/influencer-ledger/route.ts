import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { computeAttribution, recordPicks } from "@/lib/influencer-ledger";
import { getInfluencerSignals } from "@/lib/influencer-signals";

export const maxDuration = 60;

// Per-pick / per-channel attribution for the influencer sleeve.
//   GET /api/influencer-ledger          → scored picks + per-channel edge stats
//   GET /api/influencer-ledger?seed=1    → first log today's picks from the CURRENT cache
//        (no YouTube/Haiku refresh — reuses the cached signals), then return the stats.
//        Use once to seed; the daily /api/influencer-cache cron keeps it current after.
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().split("T")[0];
  const seed = new URL(request.url).searchParams.get("seed") === "1";

  let seeded: { recorded: number; updated: number } | null = null;
  if (seed) {
    const cache = await getInfluencerSignals();
    if (cache) seeded = await recordPicks(cache, today);
  }

  const { picks, channels } = await computeAttribution(today);

  return Response.json({
    asOf: today,
    seeded,
    note:
      "Returns measured from each pick's FIRST-LOGGED price (baseline). Horizons vary per pick (see daysElapsed). avgReturnPct is RAW; avgAlphaPct is the return above/below SPY over each pick's own window (the edge, stripped of market beta) — channels are ranked by alpha. Small, correlated samples: a ranking hint, not a verdict.",
    pickCount: picks.length,
    channels,
    picks,
  });
}
