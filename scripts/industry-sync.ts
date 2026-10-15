/**
 * INDUSTRY SYNC — regenerate lib/stock-industry.ts from Sharadar's `tickers` table.
 *
 *   bun --env-file=.env.local scripts/industry-sync.ts            # report drift, change nothing
 *   bun --env-file=.env.local scripts/industry-sync.ts --write    # rewrite the generated block
 *
 * Same contract as scripts/universe-sync.ts, and for the same two reasons: the trade path must not
 * gain a Sharadar dependency, and a classification change alters what the agent may buy, so it has
 * to arrive as a diff a human approves rather than shifting under a runtime fetch.
 *
 * REPLACED a hand-maintained SEMICONDUCTORS set on 2026-10-15, after the owner asked whether a
 * directory existed for this. It does. It also disagreed with the hand list on six of thirty-five
 * names and was right on most — SNDK is storage, FSLR is Solar, AMAT/KLAC/LRCX/TER are semi
 * EQUIPMENT rather than semis.
 */
import { SP500_UNIVERSE } from "../lib/strategy";
import { STOCK_INDUSTRY } from "../lib/stock-industry";

const WRITE = process.argv.includes("--write");
const KEY = process.env.SHARADAR_API_KEY;
if (!KEY) { console.error("SHARADAR_API_KEY is required"); process.exit(1); }

const res = await fetch("https://api.sharadar.com/v1.0/data/tickers?format=csv&table=stocks", {
  headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(120_000),
});
if (!res.ok) { console.error(`sharadar tickers: HTTP ${res.status}`); process.exit(1); }
const lines = (await res.text()).split("\n");
const hdr = lines[0].split(",");
const iT = hdr.indexOf("ticker"), iInd = hdr.indexOf("industry"),
      iDel = hdr.indexOf("isdelisted"), iTab = hdr.indexOf("table");
if ([iT, iInd, iDel, iTab].some(i => i < 0)) {
  // The schema is the contract. If a column moved, STOP — a positional parse that silently reads
  // the wrong field would rewrite every industry with plausible-looking nonsense.
  console.error("sharadar tickers: expected columns missing — schema changed, refusing to parse");
  process.exit(1);
}
const fresh = new Map<string, string>();
for (const l of lines.slice(1)) {
  const f = l.split(",");
  if (f.length < hdr.length || f[iTab] !== "stocks" || f[iDel] !== "N") continue;
  if (!fresh.has(f[iT]) && f[iInd]) fresh.set(f[iT], f[iInd]);
}

const added: string[] = [], changed: string[] = [], dropped: string[] = [];
for (const s of SP500_UNIVERSE) {
  const now = STOCK_INDUSTRY[s], next = fresh.get(s);
  if (!now && next) added.push(`${s} → ${next}`);
  else if (now && !next) dropped.push(`${s} (was ${now})`);
  else if (now && next && now !== next) changed.push(`${s}: ${now} → ${next}`);
}
const stale = Object.keys(STOCK_INDUSTRY).filter(s => !SP500_UNIVERSE.includes(s));
console.log(`universe ${SP500_UNIVERSE.length} · directory ${fresh.size} tickers · mapped ${Object.keys(STOCK_INDUSTRY).length}`);
console.log(`  added ${added.length} · changed ${changed.length} · dropped ${dropped.length} · no-longer-in-universe ${stale.length}`);
for (const x of [...added, ...changed, ...dropped, ...stale.map(s => `${s} (not in universe)`)].slice(0, 40)) console.log(`    ${x}`);

if (!WRITE) { console.log("\n(report only — pass --write to rewrite lib/stock-industry.ts)"); process.exit(0); }
const path = `${import.meta.dir}/../lib/stock-industry.ts`;
const src = await Bun.file(path).text();
const open = src.indexOf("export const STOCK_INDUSTRY: Record<string, string> = {");
if (open < 0) { console.error("marker not found — refusing to write"); process.exit(1); }
const entries = SP500_UNIVERSE.filter(s => fresh.has(s)).sort()
  .map(s => `  ${/^[A-Z][A-Z0-9]*$/.test(s) ? s : JSON.stringify(s)}: ${JSON.stringify(fresh.get(s))},`);
await Bun.write(path, src.slice(0, open) + "export const STOCK_INDUSTRY: Record<string, string> = {\n" + entries.join("\n") + "\n};\n");
console.log(`\nwrote ${entries.length} entries to lib/stock-industry.ts`);
