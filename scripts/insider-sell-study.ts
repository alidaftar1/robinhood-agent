// RESEARCH ONLY — does a CLUSTER of insider selling predict that an S&P 500 stock underperforms?
//
//   bun scripts/insider-sell-study.ts
//
// Owner's question (2026-10-27): "when I see spikes in sales from insiders that is a warning for me to
// avoid those stocks and consider selling them". Event study on Sharadar SF2 (Form 4), 2008+.
//
// EVENT. On filing date d, for a name in the S&P 500 on d: K or more DISTINCT officers/directors
// (10%-owner-only filers excluded) filed open-market sales (code S, non-derivative) in the 30
// calendar days ending d. One event per name per 90 days (the first day the cluster forms).
//
// "OPPORTUNISTIC" (Cohen, Malloy & Pomorski 2012): an insider's sale is ROUTINE when that insider
// also sold in the same calendar month in each of the 3 prior years (scheduled diversification /
// 10b5-1-like). The rest are opportunistic. SF2 carries no 10b5-1 flag, so this is the proxy.
// SF2 filings start 2008, so 3 prior years of history means opportunistic variants start 2011.
//
// ENTRY. Close of the first trading day AFTER the filing date (filings land after hours).
// CONTROL. The obvious confound: insiders sell AFTER run-ups, and run-ups (momentum) predict
// returns themselves. So each event is compared to the equal-weight mean of S&P members on the same
// entry day in the SAME 12-1 momentum quintile. Also shown vs SPY. Adjusted closes (closeadj).
// A delisted name keeps its last price (no survivorship drop). Overlapping windows mean the
// t-stats overstate significance; read them as rough.
//
// RESULT (2026-10-27, 2008-01 → 2026-09): NO usable signal. Clusters of insider selling did NOT
// predict underperformance vs momentum-matched peers at 20/60/120d, in any variant:
//   ≥3 sellers / 30d: 11,972 events, +0.03% / +0.05% / +0.14%, 50-51% underperformed.
//   ≥5 sellers:        6,097 events, −0.03% / −0.05% / −0.06%.
//   opportunistic ≥2 / ≥3 (2011+): 13,885 / 9,922 events, all within ±0.25%.
//   Top-momentum-quintile events (the agent's buy zone): all within ±0.3%, |t| < 1.8.
// The sign flips between halves (slightly negative < 2017, slightly positive ≥ 2017). The ONLY
// negative-looking number is vs SPY (−0.4% to −1.4% at 120d) — and that is the equal-weight S&P lagging
// cap-weighted SPY since 2017, not insiders: the momentum-matched peers lagged by the same amount.
// Positive control (CODE=P, insider BUY clusters): weakly positive at 20d only (+0.6%, t 1.5;
// +1.2% before 2017), consistent with the literature that the buy effect lives mainly in small caps.
//
// Data lives in ~/.cache/sharadar (licensed, outside the repo): sp500_insider_sp.csv is SF2 filtered
// to S&P tickers and transaction codes S/P.
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const PRICE_FROM = "2006-06-01";
const HORIZONS = [20, 60, 120];
const COOLDOWN_DAYS = 90, WINDOW_DAYS = 30;
// CODE=P runs the same study on insider BUY clusters — the POSITIVE CONTROL: the literature finds
// they predict outperformance, so a method that cannot see that cannot be trusted to report a null.
const CODE = process.env.CODE === "P" ? "P" : "S";

// ── prices: closeadj on one global calendar (SPY's trading days) ─────────────
const spyRows = (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)
  .map(l => l.split(",")).filter(f => f.length >= 8 && f[1] >= PRICE_FROM && +f[7] > 0)
  .map(f => ({ d: f[1], c: +f[7] })).sort((a, b) => a.d.localeCompare(b.d));
const days = spyRows.map(r => r.d);
const dayIx = new Map(days.map((d, i) => [d, i]));
const spy = Float64Array.from(spyRows.map(r => r.c));
const N = days.length;
const px = new Map<string, Float64Array>();
{
  const dec = new TextDecoder(); let carry = "", head = false;
  const ingest = (line: string) => {
    const f = line.split(","); if (f.length < 8) return;
    const i = dayIx.get(f[1]); if (i === undefined) return;
    const c = +f[7] > 0 ? +f[7] : +f[5]; if (!(c > 0)) return;
    let a = px.get(f[0]); if (!a) { a = new Float64Array(N).fill(NaN); px.set(f[0], a); }
    a[i] = c;
  };
  for await (const chunk of Bun.file(`${CACHE}/sp500_prices.csv`).stream() as unknown as AsyncIterable<Uint8Array>) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) { const l = carry.slice(0, nl); carry = carry.slice(nl + 1); if (!head) { head = true; continue; } ingest(l); }
  }
  if (carry) ingest(carry);
}
/** Last price at or before day i (carries a delisted name's final price forward). */
const at = (a: Float64Array, i: number, lookback = 10) => { for (let j = i; j >= 0 && j > i - lookback; j--) if (a[j] > 0) return a[j]; return NaN; };
const lastAt = (a: Float64Array, i: number) => { for (let j = Math.min(i, N - 1); j >= 0; j--) if (a[j] > 0) return a[j]; return NaN; };
const fwd = (a: Float64Array, i: number, h: number) => {
  const p0 = a[i]; if (!(p0 > 0) || i + h >= N) return NaN;
  return lastAt(a, i + h) / p0 - 1;
};
const mom = (a: Float64Array, i: number) => { const p1 = at(a, i - 21), p12 = at(a, i - 252); return p1 > 0 && p12 > 0 ? p1 / p12 - 1 : NaN; };

const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const memberCache = new Map<string, Set<string> | null>();
const members = (d: string) => { if (!memberCache.has(d)) memberCache.set(d, membersAsOfPrecise(universe, sp500Rows, d)); return memberCache.get(d)!; };

// ── insider sales ────────────────────────────────────────────────────────────
interface Sale { t: string; filed: string; owner: string; month: string; year: number; value: number }
const sales: Sale[] = [];
{
  // Quoted fields (owner names / titles with commas) — minimal CSV split.
  const split = (l: string) => { const o: string[] = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; } o.push(cur); return o; };
  const lines = (await Bun.file(`${CACHE}/sp500_insider_sp.csv`).text()).split("\n");
  const H = split(lines[0]); const c = (n: string) => H.indexOf(n);
  const [iT, iD, iO, iDir, iOff, iTd, iSec, iCode, iVal] = ["ticker", "date", "ownername", "isdirector", "isofficer", "transactiondate", "securityadcode", "transactioncode", "transactionvalue"].map(c);
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const f = split(l);
    if (f[iCode] !== CODE || !f[iSec].startsWith("N")) continue; // ND/NA = non-derivative disposed/acquired
    if (f[iDir] !== "Y" && f[iOff] !== "Y") continue;
    const td = f[iTd] || f[iD];
    sales.push({ t: f[iT], filed: f[iD], owner: f[iO], month: td.slice(5, 7), year: +td.slice(0, 4), value: Math.abs(+f[iVal] || 0) });
  }
}
// Routine = same insider sold in the same calendar month in EACH of the 3 prior years.
const soldIn = new Set(sales.map(s => `${s.t}|${s.owner}|${s.year}|${s.month}`));
const routine = (s: Sale) => [1, 2, 3].every(k => soldIn.has(`${s.t}|${s.owner}|${s.year - k}|${s.month}`));
const firstYear = Math.min(...sales.map(s => s.year));

// ── events ───────────────────────────────────────────────────────────────────
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
interface Event { t: string; filed: string; entry: number; sellers: number; value: number }
function findEvents(k: number, opportunisticOnly: boolean, from: string): Event[] {
  const byT = new Map<string, Sale[]>();
  for (const s of sales) {
    if (s.filed < from) continue;
    if (opportunisticOnly && routine(s)) continue;
    let a = byT.get(s.t); if (!a) { a = []; byT.set(s.t, a); } a.push(s);
  }
  const out: Event[] = [];
  for (const [t, arr] of byT) {
    arr.sort((a, b) => a.filed.localeCompare(b.filed));
    let lastEvent = "1900-01-01";
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i].filed;
      // Evaluate a day once, at its LAST filing, so every same-day seller is counted.
      if (i + 1 < arr.length && arr[i + 1].filed === d) continue;
      if (d < addDays(lastEvent, COOLDOWN_DAYS)) continue;
      const lo = addDays(d, -WINDOW_DAYS);
      const owners = new Set<string>(); let value = 0;
      for (let j = i; j >= 0 && arr[j].filed > lo; j--) { owners.add(arr[j].owner); value += arr[j].value; }
      if (owners.size < k) continue;
      if (!members(d)?.has(t)) continue;
      // entry = first trading day strictly after the filing date
      let e = days.findIndex(x => x > d); // linear is fine: called once per event
      if (e < 0) continue;
      const a = px.get(t); if (!a || !(a[e] > 0)) continue;
      out.push({ t, filed: d, entry: e, sellers: owners.size, value });
      lastEvent = d;
    }
  }
  return out;
}

// ── control: same-day, same-momentum-quintile S&P members ───────────────────
const ctrlCache = new Map<number, { cut: number[]; mean: Map<string, number[]> }>();
function control(e: number) {
  let c = ctrlCache.get(e);
  if (c) return c;
  const mem = members(days[e]) ?? new Set<string>();
  const rows: { m: number; r: number[] }[] = [];
  for (const t of mem) {
    const a = px.get(t); if (!a || !(a[e] > 0)) continue;
    const m = mom(a, e); if (!Number.isFinite(m)) continue;
    rows.push({ m, r: HORIZONS.map(h => fwd(a, e, h)) });
  }
  const ms = rows.map(r => r.m).sort((a, b) => a - b);
  const cut = [0.2, 0.4, 0.6, 0.8].map(q => ms[Math.floor(q * (ms.length - 1))]);
  const qOf = (m: number) => cut.filter(x => m > x).length;
  const mean = new Map<string, number[]>();
  for (let q = 0; q < 5; q++) {
    const inQ = rows.filter(r => qOf(r.m) === q);
    mean.set(String(q), HORIZONS.map((_, h) => { const v = inQ.map(r => r.r[h]).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; }));
  }
  c = { cut, mean }; ctrlCache.set(e, c);
  return c;
}

const stat = (xs: number[]) => {
  const v = xs.filter(Number.isFinite); const n = v.length; if (!n) return { n: 0, mean: NaN, med: NaN, t: NaN, under: NaN };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const sorted = [...v].sort((a, b) => a - b);
  return { n, mean, med: sorted[Math.floor(n / 2)], t: mean / (sd / Math.sqrt(n)), under: v.filter(x => x < 0).length / n };
};
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%` : "   —  ");

function report(label: string, evs: Event[]) {
  console.log(`\n${label}  —  ${evs.length} events, ${new Set(evs.map(e => e.t)).size} names, ${evs[0] ? evs.map(e => e.filed).sort()[0] : "—"} → ${evs.map(e => e.filed).sort().at(-1) ?? "—"}`);
  console.log(`  horizon   vs momentum-matched peers (mean / median / t / % underperform)     vs SPY (mean)   top-momentum-quintile events only (mean / t / n)`);
  for (let h = 0; h < HORIZONS.length; h++) {
    const exM: number[] = [], exS: number[] = [], exTop: number[] = [];
    for (const ev of evs) {
      const a = px.get(ev.t)!; const r = fwd(a, ev.entry, HORIZONS[h]); if (!Number.isFinite(r)) continue;
      const c = control(ev.entry); const m = mom(a, ev.entry); if (!Number.isFinite(m)) continue;
      const q = c.cut.filter(x => m > x).length;
      const base = c.mean.get(String(q))![h];
      exM.push(r - base);
      exS.push(r - (spy[Math.min(ev.entry + HORIZONS[h], N - 1)] / spy[ev.entry] - 1));
      if (q === 4) exTop.push(r - base);
    }
    const a = stat(exM), s = stat(exS), top = stat(exTop);
    console.log(`  ${String(HORIZONS[h]).padStart(3)}d      ${pct(a.mean).padStart(8)} / ${pct(a.med).padStart(8)} / ${a.t.toFixed(2).padStart(5)} / ${(a.under * 100).toFixed(0)}%  (n=${a.n})`.padEnd(84) + `${pct(s.mean).padStart(8)}        ${pct(top.mean)} / ${top.t.toFixed(2)} / ${top.n}`);
  }
}

console.log(`Insider sales loaded: ${sales.length} (officer/director, open-market, from ${firstYear}); prices ${days[0]} → ${days[N - 1]}`);
const split = (evs: Event[], cut: string) => [evs.filter(e => e.filed < cut), evs.filter(e => e.filed >= cut)];
for (const [label, k, opp, from] of [
  ["ALL SELLERS, ≥3 in 30d", 3, false, "2008-01-01"],
  ["ALL SELLERS, ≥5 in 30d", 5, false, "2008-01-01"],
  ["OPPORTUNISTIC SELLERS (non-routine), ≥2 in 30d", 2, true, "2011-01-01"],
  ["OPPORTUNISTIC SELLERS (non-routine), ≥3 in 30d", 3, true, "2011-01-01"],
] as const) {
  const evs = findEvents(k, opp, from);
  report(label, evs);
  const [a, b] = split(evs, "2017-01-01");
  report(`  ↳ first half (< 2017)`, a);
  report(`  ↳ second half (≥ 2017)`, b);
}

// SPOT CHECK (SAMPLE=1): print a few events with their raw inputs so one can be recomputed by hand
// from sp500_prices.csv — guards against an indexing bug hiding behind an all-zero result.
if (process.env.SAMPLE) {
  const evs = findEvents(3, false, "2024-01-01").slice(0, 3);
  for (const ev of evs) {
    const a = px.get(ev.t)!;
    console.log(`SAMPLE ${ev.t} filed ${ev.filed} sellers=${ev.sellers} entry ${days[ev.entry]} @ ${a[ev.entry]} → ${days[ev.entry + 20]} @ ${lastAt(a, ev.entry + 20)} = ${pct(fwd(a, ev.entry, 20))}; SPY ${pct(spy[ev.entry + 20] / spy[ev.entry] - 1)}`);
  }
}
