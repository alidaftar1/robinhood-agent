import { refreshInfluencerSignals } from "@/lib/influencer-signals";

export const maxDuration = 120;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.YOUTUBE_API_KEY) {
    return Response.json({ skipped: true, reason: "YOUTUBE_API_KEY not configured" });
  }

  try {
    const cache = await refreshInfluencerSignals();
    return Response.json({
      success: true,
      refreshedAt: cache.refreshedAt,
      signalCount: cache.signals.length,
      topTickers: Object.entries(cache.tickerCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([t, s]) => `${t}(${s})`),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("INFLUENCER_CACHE_ERROR", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
