import { saveRun } from "@/lib/run-store";
import type { TradeRun } from "@/lib/run-store";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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
