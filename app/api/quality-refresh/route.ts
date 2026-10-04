/**
 * QUALITY REFRESH CRON — warms the SEC quality cache ahead of the trade run.
 *
 * Same shape as /api/influencer-cache -> /api/trade: a slow, cacheable computation runs in its own
 * request so the latency-critical one only reads.
 *
 * WHY IT EXISTS. fetchQualityFromSEC is bounded at QUALITY_FRAMES_BUDGET_MS (75s) +
 * RECOVERY_BUDGET_MS (45s), so a cold refresh can legitimately take over two minutes. The trade run
 * has maxDuration 300 for EVERYTHING including the risk sells, and its declared caps already exceed
 * that — which is why valuation was cut to 20s, explicitly because "a run that times out DURING
 * order placement leaves partially-executed trades". So there was no correct budget for a cold
 * quality fetch inside /api/trade: large enough to let it finish endangered the sells, small enough
 * to be safe discarded a slow-but-correct result. With the screen failing CLOSED, discarding it
 * stops main-book buying.
 *
 * And it would not have self-healed. recoverWithheld sets `degraded` on a SINGLE failed fetch among
 * ~130 per-company requests, and shouldCache refuses to persist a degraded result — so one bad SEC
 * day meant every subsequent run started cold, hit the budget, and withheld buys again.
 *
 * Running here instead: this request does nothing else, so the full internal budget fits. The 8-day
 * TTL means a good cached result survives while this retries daily — roughly eight attempts to land
 * one success before anything expires. A degraded result is still never cached; that invariant is
 * untouched.
 *
 * NEVER TRADES. No MCP, no token, no orders — it writes one Redis key.
 */
import { requireCronAuth } from "@/lib/auth";
import { getQualityScores } from "@/lib/quality";
import { sendAlert } from "@/lib/alert";

// The internal ceilings (75s frames + 45s recovery + the ticker-map fetch) need room, and unlike
// the trade run there is nothing else competing for it.
export const maxDuration = 300;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const started = Date.now();
  // force=true: the point is to REFRESH, not to confirm a hit. A warm cache would otherwise return
  // instantly and the entry would expire without ever being renewed.
  const data = await getQualityScores(true).catch((e) => {
    console.error("QUALITY_REFRESH_THREW", { error: String(e) });
    return null;
  });
  const elapsedMs = Date.now() - started;

  if (!data) {
    // Not fatal to trading on its own — the previous cached result is still live until its TTL. It
    // becomes fatal only if every attempt fails until expiry, which is what this alert is for.
    console.error("QUALITY_REFRESH_FAILED", { elapsedMs });
    await sendAlert(
      "⚠️ Quality refresh failed",
      `getQualityScores(force) returned nothing after ${(elapsedMs / 1000).toFixed(0)}s. The previously cached result stays live until its 8-day TTL, so trading is unaffected for now — but if this keeps failing until expiry the main book will stop buying (the screen fails closed). Check SEC reachability.`,
    ).catch(() => {});
    return Response.json({ ok: false, elapsedMs }, { status: 200 });
  }

  const eligible = Object.values(data.scores).filter((v) => v.eligible).length;
  console.log("QUALITY_REFRESH_OK", {
    elapsedMs, scored: Object.keys(data.scores).length, eligible,
    withheld: data.withheld.length, degraded: data.degraded,
  });
  // `degraded` here means the result was NOT cached, so the next trade run still reads the older
  // entry. Surfaced because a run of these is the early warning before an expiry stops buying.
  return Response.json({
    ok: true, elapsedMs, scored: Object.keys(data.scores).length, eligible,
    withheld: data.withheld.length, degraded: data.degraded, cached: !data.degraded,
  });
}
