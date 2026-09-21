#!/usr/bin/env bun
/**
 * Score the conviction paper run (docs/conviction-paper-run.json) forward against SPY.
 *
 * Research-driven selection cannot be backtested — a model already knows the outcome of any
 * historical date — so forward scoring is the only honest evidence this approach can generate.
 * Excess return vs SPY is the measure that matters: beating the market, not merely going up.
 *
 *   bun --env-file=.env.local scripts/score-paper-run.ts
 */
import { fetchQuoteLite } from "@/lib/market-data";

const run = await Bun.file("docs/conviction-paper-run.json").json();
const spyNow = (await fetchQuoteLite("SPY"))?.price;
if (!spyNow) { console.error("could not price SPY — aborting rather than reporting a partial scorecard"); process.exit(1); }
const spyRet = (spyNow / run.spyEntry - 1) * 100;

const days = Math.round((Date.now() - Date.parse(`${run.runDate}T00:00:00Z`)) / 86_400_000);
console.log(`Conviction paper run — entered ${run.runDate}, ${days} days elapsed`);
console.log(`SPY ${run.spyEntry.toFixed(2)} -> ${spyNow.toFixed(2)}  (${spyRet >= 0 ? "+" : ""}${spyRet.toFixed(2)}%)`);
console.log(`\nrank sym     entry     now       return    vs SPY`);

const scored: { sym: string; ret: number; excess: number }[] = [];
for (const p of run.picks) {
  const q = await fetchQuoteLite(p.symbol);
  if (!q) { console.log(`  #${p.rank} ${p.symbol.padEnd(6)} — price unavailable`); continue; }
  const ret = (q.price / p.entry - 1) * 100;
  const excess = ret - spyRet;
  scored.push({ sym: p.symbol, ret, excess });
  console.log(`  #${p.rank} ${p.symbol.padEnd(6)} ${p.entry.toFixed(2).padStart(8)}  ${q.price.toFixed(2).padStart(8)}  ${(ret >= 0 ? "+" : "") + ret.toFixed(2) + "%"}`.padEnd(52)
    + `${(excess >= 0 ? "+" : "") + excess.toFixed(2)}pp`);
}

if (scored.length) {
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const beat = scored.filter(s => s.excess > 0).length;
  console.log(`\nbasket avg return ${avg(scored.map(s => s.ret)).toFixed(2)}%  |  avg excess vs SPY ${avg(scored.map(s => s.excess)).toFixed(2)}pp  |  beat SPY ${beat}/${scored.length}`);
  console.log(`\nn=${scored.length} over ${days} days. This is far too small and too short to be evidence of skill —`);
  console.log(`it is a record that makes the claim CHECKABLE, which is the only thing it is for.`);
  console.log(`Re-read the falsifiers in the JSON before concluding anything from the numbers above.`);
}
