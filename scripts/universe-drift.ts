/**
 * UNIVERSE DRIFT REPORT — read-only, no behaviour change.
 *
 *   bun --env-file=.env.local scripts/universe-drift.ts
 *   bun scripts/universe-drift.ts --sp500 ~/.cache/sharadar/sp500.csv   # offline, from the cache
 *
 * Compares the hardcoded STOCK_SECTOR universe against Sharadar's CURRENT S&P 500 membership.
 *
 * Why this exists: a name outside STOCK_SECTOR can never reach buildV1Shortlist, so the main book
 * cannot buy it — silently, because the quality screen only ever reports on names it already knows.
 * On 2026-10-03 that hid 122 index members including AVGO, GOOG, BRK.B, ANET and UBER. AVGO was
 * bought the day before as an INFLUENCER pick because the sleeve was its only route in — NOT because
 * a main-book buy was displaced (that day was a non-rebalance Friday, with main buys closed). The
 * point is reach: those names can only ever enter through the sleeve, and nothing reports it.
 *
 * Exits 0 even when it finds drift: this reports, it does not gate. Deciding what to add or remove
 * changes WHAT THE AGENT MAY BUY and is the owner's call — and a removal of a HELD name would read
 * as "fell off the shortlist", which lib/sell-rail accepts as a reason to SELL.
 */
import { parseSp500Csv, currentMembers, computeUniverseDrift } from "../lib/sharadar-universe";
import { STOCK_SECTOR } from "../lib/market-data";
import { TICKER_CIK_OVERRIDES } from "../lib/quality";

const argv = process.argv.slice(2);
const fileArg = argv.indexOf("--sp500");

// OUR symbol -> the index's CURRENT symbol for the same company. Sourced from the same renames the
// quality screen already carries, so the two cannot disagree about who is who.
const RENAMES: Record<string, string> = { BK: "BNY", MMC: "MRSH", FI: "FISV", ABC: "COR" };

async function loadCsv(): Promise<string> {
  if (fileArg !== -1) return Bun.file(argv[fileArg + 1]).text();
  const cached = `${process.env.HOME}/.cache/sharadar/sp500.csv`;
  if (await Bun.file(cached).exists()) return Bun.file(cached).text();
  throw new Error(`No sp500.csv. Run scripts/sharadar-extract.sh, or pass --sp500 <path>.`);
}

const rows = parseSp500Csv(await loadCsv());
const index = currentMembers(rows);
if (index.size === 0) {
  // A truncated or wrong-format read would otherwise report the ENTIRE universe as stale, which
  // looks like a catastrophic index change rather than a bad file.
  console.error("REFUSING: the sp500 file yielded zero `current` members — suspect a bad or stale file.");
  process.exit(1);
}

const ours = new Set(Object.keys(STOCK_SECTOR));
const d = computeUniverseDrift(index, ours, RENAMES);

console.log(`UNIVERSE DRIFT — index ${d.inIndex} vs STOCK_SECTOR ${d.inOurs}\n`);
console.log(`MISSING (${d.missing.length}) — in the index, NOT in our universe.`);
console.log(`  The main book cannot buy these at all; an influencer mention is their only route in.`);
console.log(`  ${d.missing.join(" ") || "none"}\n`);
console.log(`STALE (${d.stale.length}) — ours, no longer in the index.`);
console.log(`  Mixed: some delisted, some alive but dropped. Removing a live one is a STRATEGY call.`);
console.log(`  ${d.stale.join(" ") || "none"}\n`);
console.log(`RENAMED (${d.renamed.length}) — same company, new ticker. NOT additions.`);
console.log(`  ${d.renamed.map(r => `${r.ours}->${r.index}`).join(" ") || "none"}\n`);

// The known overrides should line up with what the index calls these companies now; a mismatch means
// one of the two tables has gone stale.
const overrideSyms = Object.keys(TICKER_CIK_OVERRIDES).sort();
console.log(`TICKER_CIK_OVERRIDES covers: ${overrideSyms.join(" ")}`);
const uncovered = d.renamed.filter(r => !(r.ours in TICKER_CIK_OVERRIDES)).map(r => r.ours);
if (uncovered.length) console.log(`  ⚠ renamed but NOT in the override table: ${uncovered.join(" ")}`);
