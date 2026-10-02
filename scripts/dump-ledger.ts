/**
 * Snapshot the influencer ledger to a JSON file BEFORE a reset, so the reset is reversible.
 *
 *   bun --env-file=.env.local scripts/dump-ledger.ts [outfile]
 *
 * Default outfile: ~/Desktop/influencer-ledger-snapshot-<today>.json
 *
 * Read-only against prod. Writes one local file. The dump carries each pick's channelEntries
 * (including `inherited` flags), so the pre-reset state can be reconstructed if the reset turns
 * out to be the wrong call.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const secret = process.env.CRON_SECRET ?? "";
if (!secret) {
  console.error("CRON_SECRET is not set. Run with: bun --env-file=.env.local scripts/dump-ledger.ts");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const out = process.argv[2] ?? join(homedir(), "Desktop", `influencer-ledger-snapshot-${today}.json`);

const res = await fetch("https://robinhood-agent.vercel.app/api/influencer-ledger", {
  headers: { authorization: `Bearer ${secret}` },
});
if (!res.ok) {
  console.error("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const body = await res.text();
let parsed: { picks?: unknown[]; channels?: unknown[] };
try {
  parsed = JSON.parse(body);
} catch {
  console.error("Response was not JSON — refusing to write a snapshot that may not restore.");
  process.exit(1);
}
if (!Array.isArray(parsed.picks)) {
  console.error("No `picks` array in the response — refusing to write an incomplete snapshot.");
  process.exit(1);
}

writeFileSync(out, body);
console.log(`Snapshot written: ${out}`);
console.log(`  picks:    ${parsed.picks.length}`);
console.log(`  channels: ${Array.isArray(parsed.channels) ? parsed.channels.length : "?"}`);
console.log(`\nSafe to reset once this file exists and the counts above look right.`);
