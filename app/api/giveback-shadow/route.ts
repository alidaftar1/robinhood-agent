import { requireCronAuth } from "@/lib/auth";
import { getGivebackShadow } from "@/lib/giveback-shadow";
import { scoreShadowObservations } from "@/lib/shadow-scoring";

// Read-only view of the give-back stop SHADOW capture (Phase 1, zero capital). Returns the daily log
// of which MAIN holdings WOULD have tripped a give-back stop (down ≥5% over 5d) + their price, so the
// forward outcome (did they keep falling or bounce?) can be analysed as data accrues. No trading.
//
// `scoring` answers that forward-outcome question directly. Give-back is an EXIT signal, so it was
// right when the name kept FALLING relative to the market — selling would have avoided that loss — and
// wrong when the name bounced (a whipsaw: stopped out just before the recovery). Note this reads the
// OPPOSITE way to the mean-reversion capture's scoring, which is why direction is explicit.
// Pass ?scored=0 to skip it (the capture itself is unchanged).
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const days = await getGivebackShadow();
  const latest = days[days.length - 1];
  const wantScoring = new URL(request.url).searchParams.get("scored") !== "0";

  let scoring: unknown = null;
  if (wantScoring) {
    const today = new Date().toISOString().slice(0, 10);
    const observations = days.flatMap(d =>
      (d.holdings ?? []).map(h => ({ symbol: h.symbol, price: h.price, date: d.date })),
    );
    // Fail-safe: scoring is an observability aid — it must never break the capture's own view.
    try {
      const { scored, stats } = await scoreShadowObservations(observations, today, "exit");
      scoring = { ...stats, scored };
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
