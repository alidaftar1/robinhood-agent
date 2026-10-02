/**
 * Answer "how long has the influencer ledger been capturing, and over what windows?"
 *
 *   bun --env-file=.env.local scripts/show-ledger-window.ts
 *
 * Read-only: one authenticated GET against /api/influencer-ledger.
 *
 * Why this is worth printing rather than reading off the email: the email shows per-CHANNEL
 * rollups, which hide the two things that decide whether those numbers mean anything —
 * each pick's OWN measurement window (avgReturn averages a 60-day pick with a 3-day one)
 * and how much the picks overlap (9 "independent" picks can be one sector bet).
 */
import { INFLUENCER_BUY_FLOOR } from "../lib/influencer-signals";

const secret = process.env.CRON_SECRET ?? "";
if (!secret) {
  console.error("CRON_SECRET is not set. Run with: bun --env-file=.env.local scripts/show-ledger-window.ts");
  process.exit(1);
}

const res = await fetch("https://robinhood-agent.vercel.app/api/influencer-ledger", {
  headers: { authorization: `Bearer ${secret}` },
});
if (!res.ok) {
  console.error("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

type Pick = {
  ticker: string;
  channels: string[];
  firstSeenDate: string;
  lastSeenDate: string;
  daysElapsed: number;
  returnPct: number | null;
  alphaPct: number | null;
  maxScore: number;
  channelEntries?: Record<string, { firstSeenDate: string; priceAtSignal: number; inherited?: boolean }>;
};
const { picks } = (await res.json()) as { picks: Pick[] };

if (!picks?.length) {
  console.log("Ledger is empty — nothing has been recorded yet.");
  process.exit(0);
}

const dates = picks.map(p => p.firstSeenDate).sort();
const earliest = dates[0];
const spanDays = Math.round((Date.now() - new Date(earliest).getTime()) / 86_400_000);

console.log(`CAPTURE WINDOW`);
console.log(`  earliest firstSeenDate : ${earliest}  (${spanDays} calendar days ago)`);
console.log(`  latest firstSeenDate   : ${dates[dates.length - 1]}`);
console.log(`  tracked tickers        : ${picks.length}   (one entry per TICKER, net score >= ${INFLUENCER_BUY_FLOOR})`);
console.log(`  never closed: every return is firstSeen -> NOW, with no exit and no stop.\n`);

const measurable = picks.filter(p => p.returnPct != null);
const withAlpha = picks.filter(p => p.alphaPct != null);
console.log(`  priced today           : ${measurable.length} of ${picks.length}`);
console.log(`  have a SPY baseline    : ${withAlpha.length} of ${picks.length}  (no baseline -> alpha is null and the pick is dropped from "vs SPY")\n`);

const horizons = measurable.map(p => p.daysElapsed).sort((a, b) => a - b);
if (horizons.length) {
  console.log(`HORIZON SPREAD (these are averaged together in "Avg ret")`);
  console.log(`  min ${horizons[0]}d | median ${horizons[Math.floor(horizons.length / 2)]}d | max ${horizons[horizons.length - 1]}d\n`);
}

console.log(`PER PICK`);
console.log(`  ticker  firstSeen   days   return    alpha   channels credited`);
for (const p of [...picks].sort((a, b) => a.firstSeenDate.localeCompare(b.firstSeenDate))) {
  const r = p.returnPct == null ? "    —" : `${p.returnPct >= 0 ? "+" : ""}${p.returnPct.toFixed(1)}%`;
  const a = p.alphaPct == null ? "    —" : `${p.alphaPct >= 0 ? "+" : ""}${p.alphaPct.toFixed(1)}%`;
  console.log(`  ${p.ticker.padEnd(7)} ${p.firstSeenDate}  ${String(p.daysElapsed).padStart(4)}  ${r.padStart(7)}  ${a.padStart(7)}   ${p.channels.length} (${p.channels.join(", ")})`);
}

// Only INHERITED entries still carry the old union credit; entries written after the per-channel
// fix are baselined at the channel's own first mention, so counting multi-channel tickers would
// overstate it.
const inheritedPairs = picks.flatMap(p =>
  Object.entries(p.channelEntries ?? {}).filter(([, e]) => e.inherited).map(([ch]) => `${p.ticker}:${ch}`),
);
const unmigrated = picks.filter(p => !p.channelEntries);
if (inheritedPairs.length || unmigrated.length) {
  console.log(`\nSTILL UNION-CREDITED`);
  console.log(`  ${inheritedPairs.length} channel-credit(s) are flagged inherited — baselined at the TICKER's`);
  console.log(`  first sighting rather than that channel's own first mention, because the per-channel`);
  console.log(`  dates were never recorded. These cannot be corrected, only aged out or reset.`);
  if (unmigrated.length) {
    console.log(`  ${unmigrated.length} ticker(s) have no channelEntries yet (not re-touched since the fix shipped).`);
  }
} else {
  console.log(`\nAll channel credits are baselined at the channel's OWN first mention.`);
}
