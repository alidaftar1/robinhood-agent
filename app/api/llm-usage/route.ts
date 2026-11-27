import { requireCronAuth } from "@/lib/auth";
import { getUsage, daysBefore } from "@/lib/llm-usage";

/** Token use and estimated cost per PT day, job and model (lib/llm-usage). ?days=N, max 60.
 *  A FLOOR: streamed, errored and aborted calls are not metered, nor the eval suite or cloud autopilot. */
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;
  const requested = parseInt(new URL(request.url).searchParams.get("days") ?? "7");
  const days = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 7, 60);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = daysBefore(today, i);
    const rows = await getUsage(date);
    if (rows.length === 0) continue;
    out.push({
      date,
      estCostUsd: Number(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
      allModelsPriced: rows.every(r => r.costUsd != null),
      rows,
    });
  }
  return Response.json({ since: "2026-11-27 (metering started)", note: "a floor, not the invoice", days: out });
}
