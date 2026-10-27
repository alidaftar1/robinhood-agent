import { requireCronAuth } from "@/lib/auth";
import { getEarningsSkipShadowOrNull, beatClass, type BeatClass } from "@/lib/earnings-skip";
import { scoreShadowObservations } from "@/lib/shadow-scoring";

// Read-only view of the imminent-earnings SKIP shadow (lib/earnings-skip, zero capital): the names
// the no-buy-before-earnings rule kept off the shortlist on buy-open days, with their price then.
//
// `scoring` answers "does the rule help?". Skipping a buy is scored as an EXIT-direction signal: the
// rule was right when the skipped name then UNDERPERFORMED SPY (not buying avoided that move), and
// it cost money when the name outperformed. Read it after a few earnings seasons, by distinct
// symbol — consecutive days of the same name are one experiment, not several.
// Pass ?scored=0 to skip it. maxDuration as the sibling shadow routes (one quote per symbol + SPY).
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const days = await getEarningsSkipShadowOrNull();
  if (days === null) return Response.json({ error: "earnings-skip shadow read failed — not the same as an empty log" }, { status: 503 });
  const latest = days[days.length - 1];
  const wantScoring = new URL(request.url).searchParams.get("scored") !== "0";

  let scoring: unknown = null;
  if (wantScoring) {
    const today = new Date().toISOString().slice(0, 10);
    const tagged = days.flatMap(d => (d.skipped ?? []).map(k => ({ cls: beatClass(k.beat), obs: { symbol: k.symbol, price: k.price, date: d.date } })));
    const observations = tagged.map(t => t.obs);
    // Fail-safe: scoring is an observability aid — it must never break the capture's own view.
    try {
      const { scored, stats, prices } = await scoreShadowObservations(observations, today, "exit");
      // BY BEAT RECORD: does the rule help less (or hurt) on serial beaters, the names the HOLD side
      // already lets ride through? Same scoring per bucket. Entries logged before 2026-10-27 carry no
      // record and land in "unknown" — read the split only on tagged days.
      const byBeatRecord: Partial<Record<BeatClass, unknown>> = {};
      for (const cls of ["serial", "other", "unknown"] as const) {
        const obs = tagged.filter(t => t.cls === cls).map(t => t.obs);
        // Same prices as the total (no refetch), so the buckets are consistent with it.
        if (obs.length) byBeatRecord[cls] = (await scoreShadowObservations(obs, today, "exit", prices)).stats;
      }
      scoring = { ...stats, byBeatRecord, scored };
    } catch {
      scoring = { error: "scoring unavailable" };
    }
  }

  return Response.json({
    daysCaptured: days.length,
    from: days[0]?.date ?? null,
    to: latest?.date ?? null,
    latest: latest ?? null,
    scoring,
    days,
  });
}
