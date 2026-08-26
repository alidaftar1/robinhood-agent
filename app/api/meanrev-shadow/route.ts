import { requireCronAuth } from "@/lib/auth";
import { getMeanRevShadow } from "@/lib/mean-reversion";

// Read-only view of the mean-reversion SHADOW capture (Phase 1, zero capital). Returns the daily
// candidate log the /api/trade run accumulates, so the diversification thesis (is this uncorrelated
// with the momentum book?) can be inspected + analysed as data accrues. No trading, no capital.
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const days = await getMeanRevShadow();
  const latest = days[days.length - 1];
  return Response.json({
    daysCaptured: days.length,
    from: days[0]?.date ?? null,
    to: latest?.date ?? null,
    latest: latest ?? null,
    days, // full series (bounded to ~200 days server-side)
  });
}
