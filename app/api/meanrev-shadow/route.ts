import { requireCronAuth } from "@/lib/auth";
import { getMeanRevShadow } from "@/lib/mean-reversion";
import { scoreShadowObservations } from "@/lib/shadow-scoring";

// Read-only view of the mean-reversion SHADOW capture (Phase 1, zero capital). Returns the daily
// candidate log the /api/trade run accumulates, so the diversification thesis (is this uncorrelated
// with the momentum book?) can be inspected + analysed as data accrues. No trading, no capital.
//
// `scoring` answers the question the raw capture could not: did the signal WORK? Each candidate's
// forward return is computed on read from its stored capture price and benchmarked against SPY over
// its own window. Mean-reversion is an ENTRY signal, so it was right when the name subsequently
// ROSE relative to the market. Pass ?scored=0 to skip it (the capture itself is unchanged).
// Scoring fans out one quote per distinct symbol plus a SPY fetch; without an explicit duration the
// platform default (10-15s) can 504 with NO body, which the try/catch below cannot rescue — the
// capture view would become unreadable, not merely unscored. Matches the sibling ledger routes.
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const days = await getMeanRevShadow();
  const latest = days[days.length - 1];
  const wantScoring = new URL(request.url).searchParams.get("scored") !== "0";

  let scoring: unknown = null;
  if (wantScoring) {
    const today = new Date().toISOString().slice(0, 10);
    const observations = days.flatMap(d =>
      (d.candidates ?? []).map(c => ({ symbol: c.symbol, price: c.price, date: d.date })),
    );
    // Fail-safe: scoring is an observability aid — it must never break the capture's own view.
    try {
      const { scored, stats } = await scoreShadowObservations(observations, today, "entry");
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
    days, // full series (bounded to ~200 days server-side)
  });
}
