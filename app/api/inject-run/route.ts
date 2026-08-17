import { requireCronAuth } from "@/lib/auth";
import { saveRun } from "@/lib/run-store";
import type { TradeRun } from "@/lib/run-store";

export async function POST(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  try {
    const run = (await request.json()) as TradeRun;
    if (!run.timestamp || !run.date || !run.summary) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }
    await saveRun(run);
    return Response.json({ success: true, date: run.date });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
