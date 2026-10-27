// RESEARCH ONLY — does a big quarterly DROP in institutional (13F) holdings predict that an S&P 500
// stock underperforms?
//
//   bun scripts/institutional-flow-study.ts
//
// Owner's question (2026-10-27): "spikes in sales from hedge funds are a warning to avoid / sell".
// Companion to scripts/insider-sell-study.ts, same method. Data: Sharadar SF3A (per-ticker 13F
// aggregates, 2013-Q2+), at ~/.cache/sharadar/holdings_ticker.csv (licensed, outside the repo).
//
// SIGNAL. Per name per quarter: change in institutional shares held (shrunits) vs the prior quarter,
// and change in the number of holders. Each quarter, S&P members (as of quarter end) are ranked; the
// bottom decile = "institutions sold the most", top decile = "bought the most".
// SPLITS. shrunits is in shares AS OF the quarter, so a 10:1 split reads as a 10x buying spree (NVDA
// 2024-06). Units are restated to today's split basis with closeunadj/close on the quarter-end day.
// LAG. 13Fs are due 45 days after quarter end, so the signal is only KNOWN then: entry = close of the
// first trading day ≥ quarter end + 46 days. Sharadar's history includes late filings/amendments,
// which a live reader would not have had on day 46 — a small look-ahead in the signal's favour.
// WHAT 13F CANNOT SEE: short positions, and it mixes index funds/pensions with hedge funds.
// CONTROL. As the insider study: same-day S&P members in the same 12-1 momentum quintile.
//
// RESULT (2026-10-27, quarters 2013-09 → 2026-06, 25,800 S&P name-quarters; t = per-quarter, ~50 obs):
//   Biggest institutional SELLING (bottom decile Δshares): NO signal. +0.03% / +0.27% / +0.23% vs
//     momentum-matched peers at 20/60/120d; sign flips by period (−0.7% <2020, +1.2% ≥2020 at 120d).
//   Most HOLDERS LEFT (bottom decile Δholder count): −0.43% / −0.52% / −0.68% (t −2.1 / −1.6 / −1.6),
//     but almost all of it before 2020 (−0.6..−1.1%); since 2020 −0.1..−0.3%, t > −1. In the
//     top-momentum quintile (the agent's buy zone) only ~2 names a quarter qualify, and they did BETTER.
//   Most HOLDERS ARRIVED: +1.2% at 120d only (t 2.0), nothing at 20/60d.
//   ~18 variant×horizon cells were tested, so one or two |t|≈2 results are expected by chance.
//   Verdict: no warning signal usable by this strategy.
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const PRICE_FROM = "2012-01-01";
const HORIZONS = [20, 60, 120];
const LAG_DAYS = 46;
const MAX_ABS_CHANGE = 0.5; // |Δunits| > 50% in a quarter is a data/corporate-action artefact, not flow

// ── prices on one calendar ───────────────────────────────────────────────────
const spyRows = (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)
  .map(l => l.split(",")).filter(f => f.length >= 8 && f[1] >= PRICE_FROM && +f[7] > 0)
  .map(f => ({ d: f[1], c: +f[7] })).sort((a, b) => a.d.localeCompare(b.d));
const days = spyRows.map(r => r.d);
const dayIx = new Map(days.map((d, i) => [d, i]));
const spy = Float64Array.from(spyRows.map(r => r.c));
const N = days.length;
const px = new Map<string, Float64Array>();
const splitF = new Map<string, Float64Array>(); // closeunadj / close → multiply old units to today's basis
{
  const dec = new TextDecoder(); let carry = "", head = false;
  const ingest = (line: string) => {
    const f = line.split(","); if (f.length < 9) return;
    const i = dayIx.get(f[1]); if (i === undefined) return;
    const close = +f[5], adj = +f[7] > 0 ? +f[7] : close, unadj = +f[8];
    if (!(close > 0)) return;
    let a = px.get(f[0]); if (!a) { a = new Float64Array(N).fill(NaN); px.set(f[0], a); splitF.set(f[0], new Float64Array(N).fill(NaN)); }
    a[i] = adj;
    if (unadj > 0) splitF.get(f[0])![i] = unadj / close;
  };
  for await (const chunk of Bun.file(`${CACHE}/sp500_prices.csv`).stream() as unknown as AsyncIterable<Uint8Array>) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) { const l = carry.slice(0, nl); carry = carry.slice(nl + 1); if (!head) { head = true; continue; } ingest(l); }
  }
  if (carry) ingest(carry);
}
const at = (a: Float64Array, i: number, lookback = 10) => { for (let j = i; j >= 0 && j > i - lookback; j--) if (a[j] > 0) return a[j]; return NaN; };
const lastAt = (a: Float64Array, i: number) => { for (let j = Math.min(i, N - 1); j >= 0; j--) if (a[j] > 0) return a[j]; return NaN; };
const fwd = (a: Float64Array, i: number, h: number) => { const p0 = a[i]; if (!(p0 > 0) || i + h >= N) return NaN; return lastAt(a, i + h) / p0 - 1; };
const mom = (a: Float64Array, i: number) => { const p1 = at(a, i - 21), p12 = at(a, i - 252); return p1 > 0 && p12 > 0 ? p1 / p12 - 1 : NaN; };
const ixOnOrBefore = (d: string) => { let lo = 0, hi = N - 1, b = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] <= d) { b = m; lo = m + 1; } else hi = m - 1; } return b; };
const ixOnOrAfter = (d: string) => { const i = ixOnOrBefore(d); return i >= 0 && days[i] === d ? i : i + 1 < N ? i + 1 : -1; };
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const memberCache = new Map<string, Set<string> | null>();
const members = (d: string) => { if (!memberCache.has(d)) memberCache.set(d, membersAsOfPrecise(universe, sp500Rows, d)); return memberCache.get(d)!; };

// ── 13F aggregates, split-restated ──────────────────────────────────────────
interface Q { q: string; units: number; holders: number }
const hold = new Map<string, Q[]>();
{
  const lines = (await Bun.file(`${CACHE}/holdings_ticker.csv`).text()).split("\n");
  const H = lines[0].split(","); const iD = H.indexOf("date"), iT = H.indexOf("ticker"), iH = H.indexOf("shrholders"), iU = H.indexOf("shrunits");
  for (const l of lines.slice(1)) {
    if (!l) continue;
    // name may contain quoted commas — read the fixed leading/trailing columns around it
    const f = l.split(",");
    const off = f.length - H.length; // extra fields from a quoted name shift everything after it
    const t = f[iT], q = f[iD], holders = +f[iH + off], units = +f[iU + off];
    if (!px.has(t) || !(units > 0)) continue;
    const sf = splitF.get(t)!; const i = ixOnOrBefore(q); if (i < 0) continue;
    const factor = at(sf, i); if (!(factor > 0)) continue;
    let a = hold.get(t); if (!a) { a = []; hold.set(t, a); } a.push({ q, units: units * factor, holders });
  }
  for (const a of hold.values()) a.sort((x, y) => x.q.localeCompare(y.q));
}

interface Obs { t: string; q: string; entry: number; dUnits: number; dHolders: number }
const obs: Obs[] = [];
let artefacts = 0;
for (const [t, a] of hold) {
  for (let k = 1; k < a.length; k++) {
    const prev = a[k - 1], cur = a[k];
    if (addDays(prev.q, 100) < cur.q) continue;              // not consecutive quarters
    const dU = cur.units / prev.units - 1, dH = cur.holders / prev.holders - 1;
    if (Math.abs(dU) > MAX_ABS_CHANGE) { artefacts++; continue; }
    if (!members(cur.q)?.has(t)) continue;
    const e = ixOnOrAfter(addDays(cur.q, LAG_DAYS)); if (e < 0) continue;
    if (!(px.get(t)![e] > 0)) continue;
    obs.push({ t, q: cur.q, entry: e, dUnits: dU, dHolders: dH });
  }
}

// ── control ──────────────────────────────────────────────────────────────────
const ctrlCache = new Map<number, { cut: number[]; mean: number[][] }>();
function control(e: number) {
  const hit = ctrlCache.get(e); if (hit) return hit;
  const rows: { m: number; r: number[] }[] = [];
  for (const t of members(days[e]) ?? []) {
    const a = px.get(t); if (!a || !(a[e] > 0)) continue;
    const m = mom(a, e); if (!Number.isFinite(m)) continue;
    rows.push({ m, r: HORIZONS.map(h => fwd(a, e, h)) });
  }
  const ms = rows.map(r => r.m).sort((x, y) => x - y);
  const cut = [0.2, 0.4, 0.6, 0.8].map(q => ms[Math.floor(q * (ms.length - 1))]);
  const qOf = (m: number) => cut.filter(x => m > x).length;
  const mean = [0, 1, 2, 3, 4].map(q => HORIZONS.map((_, h) => { const v = rows.filter(r => qOf(r.m) === q).map(r => r.r[h]).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; }));
  const c = { cut, mean }; ctrlCache.set(e, c); return c;
}
const stat = (xs: number[]) => {
  const v = xs.filter(Number.isFinite); const n = v.length; if (!n) return { n: 0, mean: NaN, t: NaN, under: NaN };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: mean / (sd / Math.sqrt(n)), under: v.filter(x => x < 0).length / n };
};
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%` : "   —  ");

function report(label: string, sel: Obs[]) {
  console.log(`\n${label} — ${sel.length} name-quarters, ${new Set(sel.map(o => o.t)).size} names`);
  console.log(`  horizon   vs momentum-matched peers (mean / t / % underperform)   vs SPY    top-momentum-quintile only (mean / t / n)`);
  for (let h = 0; h < HORIZONS.length; h++) {
    const exM: number[] = [], exS: number[] = [], top: number[] = [];
    const byQ = new Map<string, number[]>();
    for (const o of sel) {
      const a = px.get(o.t)!; const r = fwd(a, o.entry, HORIZONS[h]); const m = mom(a, o.entry);
      if (!Number.isFinite(r) || !Number.isFinite(m)) continue;
      const c = control(o.entry); const q = c.cut.filter(x => m > x).length; const ex = r - c.mean[q][h];
      exM.push(ex); (byQ.get(o.q) ?? byQ.set(o.q, []).get(o.q)!).push(ex); exS.push(r - (spy[Math.min(o.entry + HORIZONS[h], N - 1)] / spy[o.entry] - 1));
      if (q === 4) top.push(ex);
    }
    const s = stat(exM), sp = stat(exS), tp = stat(top);
    // Every name in a quarter enters on the SAME day, so they are not independent draws: the honest
    // t treats each quarter's mean as ONE observation (~50 of them), and counts how many quarters agree.
    const qm = stat([...byQ.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length));
    console.log(`  ${String(HORIZONS[h]).padStart(3)}d      ${pct(s.mean).padStart(8)} / ${s.t.toFixed(2).padStart(5)} / ${(s.under * 100).toFixed(0)}%  (n=${s.n})`.padEnd(70) + `${pct(sp.mean).padStart(8)}    ${pct(tp.mean)} / ${tp.t.toFixed(2)} / ${tp.n}    per-quarter t ${qm.t.toFixed(2)}, ${(qm.under * 100).toFixed(0)}% of ${qm.n} quarters negative`);
  }
}

/** Per quarter, rank by `key` and keep the bottom (or top) decile. */
function decile(key: "dUnits" | "dHolders", side: "bottom" | "top", from = "", to = "9999"): Obs[] {
  const byQ = new Map<string, Obs[]>();
  for (const o of obs) { if (o.q < from || o.q >= to) continue; let a = byQ.get(o.q); if (!a) { a = []; byQ.set(o.q, a); } a.push(o); }
  const out: Obs[] = [];
  for (const a of byQ.values()) {
    const s = [...a].sort((x, y) => x[key] - y[key]); const n = Math.max(1, Math.floor(s.length / 10));
    out.push(...(side === "bottom" ? s.slice(0, n) : s.slice(-n)));
  }
  return out;
}

const qs = [...new Set(obs.map(o => o.q))].sort();
console.log(`13F name-quarters: ${obs.length} (S&P members, consecutive quarters), ${qs[0]} → ${qs.at(-1)}; dropped ${artefacts} with |Δunits| > ${MAX_ABS_CHANGE * 100}%`);
const med = (k: "dUnits" | "dHolders") => { const v = obs.map(o => o[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`median quarterly Δ: units ${pct(med("dUnits"))}, holders ${pct(med("dHolders"))}`);
report("BIGGEST INSTITUTIONAL SELLING (bottom decile Δshares held)", decile("dUnits", "bottom"));
report("  ↳ quarters < 2020", decile("dUnits", "bottom", "", "2020-01-01"));
report("  ↳ quarters ≥ 2020", decile("dUnits", "bottom", "2020-01-01"));
report("BIGGEST INSTITUTIONAL BUYING (top decile Δshares held) — for symmetry", decile("dUnits", "top"));
report("MOST HOLDERS LEFT (bottom decile Δnumber of holders)", decile("dHolders", "bottom"));
report("  ↳ quarters < 2020", decile("dHolders", "bottom", "", "2020-01-01"));
report("  ↳ quarters ≥ 2020", decile("dHolders", "bottom", "2020-01-01"));
report("MOST HOLDERS ARRIVED (top decile Δnumber of holders)", decile("dHolders", "top"));
report("  ↳ quarters < 2020", decile("dHolders", "top", "", "2020-01-01"));
report("  ↳ quarters ≥ 2020", decile("dHolders", "top", "2020-01-01"));

// SPOT CHECK (SAMPLE=1): raw inputs for one observation, to recompute by hand.
if (process.env.SAMPLE) {
  for (const t of ["NVDA", "MU"]) {
    for (const o of obs.filter(o => o.t === t && o.q >= "2024-03-31").slice(0, 3))
      console.log(`SAMPLE ${t} ${o.q} Δunits ${pct(o.dUnits)} Δholders ${pct(o.dHolders)} entry ${days[o.entry]}`);
  }
}
