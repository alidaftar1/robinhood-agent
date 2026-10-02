/**
 * Print the FULL stored reasoning for a run — the text the 8am email truncates.
 *
 *   bun --env-file=.env.local scripts/show-run-reasoning.ts            # latest runs
 *   bun --env-file=.env.local scripts/show-run-reasoning.ts 2026-10-02 # one date
 *
 * Read-only: one authenticated GET against /api/runs. No writes, no orders.
 * `summary` is stored un-truncated (app/api/trade/route.ts stores `textContent + reentryNote`),
 * so this is the whole thesis including the influencer/buy reasoning the email cuts.
 */
import { SUMMARY_EMAIL_LIMIT } from "../lib/run-store";

const want = process.argv[2];
const secret = process.env.CRON_SECRET ?? "";
if (!secret) {
  console.error("CRON_SECRET is not set. Run with: bun --env-file=.env.local scripts/show-run-reasoning.ts");
  process.exit(1);
}

const res = await fetch(`https://robinhood-agent.vercel.app/api/runs?limit=${want ? 30 : 5}`, {
  headers: { authorization: `Bearer ${secret}` },
});
if (!res.ok) {
  console.error("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const { runs } = (await res.json()) as { runs: Array<{ date: string; summary?: string }> };
const picked = want ? runs.filter(r => r.date === want) : runs;
if (!picked.length) {
  console.error(want ? `No run stored for ${want}. Dates available: ${runs.map(r => r.date).join(", ")}` : "No runs returned.");
  process.exit(1);
}

for (const r of picked) {
  console.log("=".repeat(72));
  console.log(`DATE: ${r.date}   (summary is ${r.summary?.length ?? 0} chars; the email shows the first ${SUMMARY_EMAIL_LIMIT})`);
  console.log("=".repeat(72));
  console.log(r.summary ?? "(no summary stored)");
  console.log();
}
