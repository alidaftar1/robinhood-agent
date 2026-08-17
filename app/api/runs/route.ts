import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { getRuns } from "@/lib/run-store";

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "5"), 30);
  const runs = await getRuns(limit);
  return Response.json({ runs, count: runs.length });
}
