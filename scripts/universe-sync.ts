/**
 * UNIVERSE SYNC — propose a reviewed diff for STOCK_SECTOR from Sharadar membership.
 *
 *   bun --env-file=.env.local scripts/universe-sync.ts            # report the plan, change nothing
 *   bun --env-file=.env.local scripts/universe-sync.ts --write    # rewrite the STOCK_SECTOR block
 *
 * STOCK_SECTOR stays a HARDCODED, COMMITTED constant that this script regenerates — it is not
 * fetched at runtime. Two reasons, and they are the whole design:
 *   · the trade path must not gain a Sharadar dependency, and
 *   · CLAUDE.md gates universe changes on the owner, so every change has to arrive as a diff a human
 *     approves. A runtime fetch would silently change the tradable universe whenever Sharadar did.
 *
 * Every gate fails CLOSED (see planUniverseSync). The gates double as the artifact filter: a recent
 * spinoff with a spliced price series, or a ticker that resolves no CIK, is rejected on its own
 * merits rather than by someone adjudicating ticker-by-ticker.
 */
import { parseSp500Csv, currentMembers, planUniverseSync, sectorToEtf, type SyncCandidate } from "../lib/sharadar-universe";
import { STOCK_SECTOR } from "../lib/market-data";
import { TICKER_CIK_OVERRIDES } from "../lib/quality";
import { getRuns } from "../lib/run-store";

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const API = "https://api.sharadar.com/v1.0/data";
const RENAMES: Record<string, string> = { BK: "BNY", MMC: "MRSH", FI: "FISV", ABC: "COR" };

const key = process.env.SHARADAR_API_KEY;
if (!key) { console.error("SHARADAR_API_KEY required"); process.exit(1); }

// ── membership ───────────────────────────────────────────────────────────────
const sp500Path = `${process.env.HOME}/.cache/sharadar/sp500.csv`;
if (!(await Bun.file(sp500Path).exists())) {
  console.error(`No ${sp500Path}. Run scripts/sharadar-extract.sh first.`);
  process.exit(1);
}
const index = currentMembers(parseSp500Csv(await Bun.file(sp500Path).text()));
if (index.size === 0) { console.error("REFUSING: zero current members — bad or stale sp500 file."); process.exit(1); }

const ours = new Set(Object.keys(STOCK_SECTOR));
const wanted = [...index].filter(t => !ours.has(t));
console.error(`index ${index.size} · ours ${ours.size} · candidates to evaluate ${wanted.length}`);

// ── sectors, in one batched call ─────────────────────────────────────────────
const sectorOf = new Map<string, string>();
// Chunked small and URL-encoded: a long ticker list 400s, and dotted symbols (BRK.B, BF.B) need
// encoding or the query is rejected.
for (let i = 0; i < wanted.length; i += 20) {
  const chunk = wanted.slice(i, i + 20);
  const r = await fetch(`${API}/tickers?format=csv&ticker=${encodeURIComponent(chunk.join(","))}`, { headers: { "x-api-key": key } });
  if (!r.ok) { console.error(`tickers fetch failed: ${r.status} on chunk starting ${chunk[0]}`); process.exit(1); }
  const lines = (await r.text()).trim().split("\n");
  const h = lines[0].split(",");
  const iT = h.indexOf("ticker"), iS = h.indexOf("sector");
  for (const l of lines.slice(1)) {
    const f = l.split(",");
    if (f[iT] && !sectorOf.has(f[iT])) sectorOf.set(f[iT], f[iS] ?? "");
  }
}

// ── pricing + CIK, the two gates that need the outside world ─────────────────
// Yahoo AND SEC both use a DASH where the index uses a dot (BRK.B -> BRK-B). Querying the dotted
// form returns nothing and no error, which reads exactly like "this name does not exist" — the
// CIK gate rejected BRK.B and BF.B on the first run for precisely that reason, which is a FALSE
// rejection of the two largest names in the add list. Same normalisation for both lookups.
const dashed = (s: string) => s.replace(".", "-");
async function priced(sym: string): Promise<boolean> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${dashed(sym)}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const j = await r.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    return (j?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0) > 0;
  } catch { return false; }
}

const ua = `robinhood-agent ${process.env.ALERT_EMAIL ?? ""}`.trim();
const cikRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": ua } });
if (!cikRes.ok) { console.error(`SEC ticker map fetch failed: ${cikRes.status} (ALERT_EMAIL must be set — SEC requires a contact UA)`); process.exit(1); }
const tk2cik = new Set<string>();
for (const v of Object.values(await cikRes.json() as Record<string, { ticker?: string }>)) if (v?.ticker) tk2cik.add(v.ticker);
console.error(`SEC ticker map: ${tk2cik.size} rows`);

const candidates: SyncCandidate[] = [];
for (let i = 0; i < wanted.length; i += 8) {
  const chunk = wanted.slice(i, i + 8);
  const ok = await Promise.all(chunk.map(priced));
  chunk.forEach((t, j) => candidates.push({
    ticker: t,
    sector: sectorOf.get(t),
    priced: ok[j],
    hasCik: tk2cik.has(t) || tk2cik.has(dashed(t)) || t in TICKER_CIK_OVERRIDES,
  }));
}

// ── held names, so a removal can never liquidate a position ──────────────────
let held = new Set<string>();
try {
  const runs = await getRuns(1);
  held = new Set((runs[0]?.positions ?? []).map(p => p.symbol));
} catch { /* fall through — see the refusal below */ }
if (held.size === 0) {
  // Not a warning: without holdings the held-gate cannot protect anything, and a removal of a held
  // name reads as "fell off the shortlist", which lib/sell-rail accepts as a reason to SELL.
  console.error("REFUSING: could not read current holdings (Upstash). The held-name gate would be inert.");
  process.exit(1);
}

const plan = planUniverseSync({ indexMembers: index, ourUniverse: ours, candidates, held, renames: RENAMES });

console.log(`\nADD (${plan.add.length}):`);
for (const a of plan.add) console.log(`   ${a.ticker.padEnd(7)} ${a.etf}`);
console.log(`\nREMOVE (${plan.remove.length}):\n   ${plan.remove.join(" ") || "none"}`);
console.log(`\nHELD, removal SUPPRESSED (${plan.heldBlocked.length}):\n   ${plan.heldBlocked.join(" ") || "none"}`);
console.log(`\nREJECTED (${plan.rejected.length}) — gated out, with reasons:`);
for (const r of plan.rejected) console.log(`   ${r.ticker.padEnd(7)} ${r.reason}`);
console.log(`\nResulting universe size: ${ours.size + plan.add.length - plan.remove.length}`);

if (!WRITE) { console.log(`\n(report only — pass --write to rewrite the STOCK_SECTOR block)`); process.exit(0); }

// ── rewrite, grouped by ETF so the diff stays readable ───────────────────────
const path = "lib/market-data.ts";
const src = await Bun.file(path).text();
const start = src.indexOf("export const STOCK_SECTOR: Record<string, string> = {");
const end = src.indexOf("\n};", start);
if (start < 0 || end < 0) { console.error("Could not locate the STOCK_SECTOR block."); process.exit(1); }

const next: Record<string, string> = {};
for (const [t, etf] of Object.entries(STOCK_SECTOR)) if (!plan.remove.includes(t)) next[t] = etf;
for (const a of plan.add) next[a.ticker] = a.etf;

const byEtf = new Map<string, string[]>();
for (const [t, etf] of Object.entries(next)) byEtf.set(etf, [...(byEtf.get(etf) ?? []), t]);
const lines: string[] = [];
for (const etf of Object.keys(await import("../lib/market-data").then(m => m.SECTOR_ETFS))) {
  const syms = (byEtf.get(etf) ?? []).sort();
  if (!syms.length) continue;
  lines.push(`  // ${etf}`);
  for (let i = 0; i < syms.length; i += 8) {
    lines.push("  " + syms.slice(i, i + 8).map(s => `${/^[A-Za-z_$][\w$]*$/.test(s) ? s : JSON.stringify(s)}:"${etf}"`).join(", ") + ",");
  }
}
const rebuilt = `export const STOCK_SECTOR: Record<string, string> = {\n${lines.join("\n")}`;
await Bun.write(path, src.slice(0, start) + rebuilt + src.slice(end));
console.log(`\nWROTE ${path} — ${Object.keys(next).length} symbols. Review the diff before committing.`);
