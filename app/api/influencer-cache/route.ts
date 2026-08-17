import { requireCronAuth } from "@/lib/auth";
import { refreshInfluencerSignals } from "@/lib/influencer-signals";
import { recordPicks } from "@/lib/influencer-ledger";

export const maxDuration = 300; // transcripts (Supadata, incl. Whisper fallback) add latency per video

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  if (!process.env.YOUTUBE_API_KEY) {
    return Response.json({ skipped: true, reason: "YOUTUBE_API_KEY not configured" });
  }

  try {
    const cache = await refreshInfluencerSignals();
    // Log today's qualifying picks to the attribution ledger (which channels picked what,
    // at what price) so per-channel edge can be measured over time. Fail-safe — the ledger
    // is an observability aid and must never break the signal refresh the sleeve depends on.
    const today = new Date().toISOString().split("T")[0];
    const ledger = await recordPicks(cache, today).catch((e) => {
      console.error("INFLUENCER_LEDGER_ERROR", e instanceof Error ? e.message : String(e));
      return null;
    });
    return Response.json({
      success: true,
      refreshedAt: cache.refreshedAt,
      signalCount: cache.signals.length,
      ledger,
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
