import { requireCronAuth } from "@/lib/auth";
import { getRuns, MAX_RUNS } from "@/lib/run-store";

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;
  const url = new URL(request.url);
  // Cap is MAX_RUNS, not 30. The old 30 silently truncated: a caller asking for 400 got 30 with no
  // indication, and on 2026-10-19 that produced a confident analysis of the influencer sleeve over
  // the wrong window AND a false conclusion that the June-August history had been deleted. The
  // dashboard reads the store directly and was never affected, which is exactly why the truncation
  // went unnoticed.
  const requested = parseInt(url.searchParams.get("limit") ?? "5");
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 5, MAX_RUNS);
  const runs = await getRuns(limit);
  // SAY SO when the answer is shorter than the question. A silent cap is how a truncated series
  // reads as a complete one.
  return Response.json({
    runs, count: runs.length,
    ...(Number.isFinite(requested) && requested > limit
      ? { truncated: true, requested, cap: MAX_RUNS, note: `asked for ${requested}, capped at MAX_RUNS=${MAX_RUNS}` }
      : {}),
  });
}
