import { requireCronAuth } from "@/lib/auth";
import { getGivebackShadow } from "@/lib/giveback-shadow";

// Read-only view of the give-back stop SHADOW capture (Phase 1, zero capital). Returns the daily log
// of which MAIN holdings WOULD have tripped a give-back stop (down ≥5% over 5d) + their price, so the
// forward outcome (did they keep falling or bounce?) can be analysed as data accrues. No trading.
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const days = await getGivebackShadow();
  const latest = days[days.length - 1];
  return Response.json({
    daysCaptured: days.length,
    from: days[0]?.date ?? null,
    to: latest?.date ?? null,
    latest: latest ?? null,
    days,
  });
}
