import { requireCronAuth } from "@/lib/auth";
import { getRuns } from "@/lib/run-store";

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "5"), 30);
  const runs = await getRuns(limit);
  return Response.json({ runs, count: runs.length });
}
