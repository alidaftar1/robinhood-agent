// Set a split factor on one stored signal-ledger pick (see SignalPick.splitFactor).
//   bun --env-file=.env.local scripts/set-split-factor.ts SNDK 2026-11-16 8      # 8:1 forward
//   bun --env-file=.env.local scripts/set-split-factor.ts XYZ 2026-10-01 0.1     # 1:10 reverse
//   bun --env-file=.env.local scripts/set-split-factor.ts XYZ 2026-10-01 1       # checked: genuine move
// Refuses anything that does not match exactly one existing pick; never creates one.
import { redisCommand } from "@/lib/run-store";
const [sym, date, f] = process.argv.slice(2);
const factor = Number(f);
if (!sym || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !(Number.isFinite(factor) && factor > 0)) {
  console.error("usage: set-split-factor.ts SYMBOL YYYY-MM-DD FACTOR(>0)"); process.exit(1);
}
const KEY = "robinhood:signal-ledger";
const raw = await redisCommand("GET", KEY) as string | null;
if (!raw) { console.error("ledger read failed — refusing to write"); process.exit(1); }
const ledger = JSON.parse(raw);
const k = `${sym}|${date}`;
if (!ledger[k]) { console.error(`no pick ${k}`); process.exit(1); }
ledger[k].splitFactor = factor;
await redisCommand("SET", KEY, JSON.stringify(ledger));
console.log(`set ${k} splitFactor = ${factor} (${Object.keys(ledger).length} picks)`);
