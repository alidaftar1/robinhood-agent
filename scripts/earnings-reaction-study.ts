// RESEARCH ONLY — do PRE-PRINT signals (revenue deceleration, stretched valuation, run-up) predict a
// bad earnings reaction / post-earnings drift among S&P 500 stocks, especially high-momentum ones?
//
//   ARQ_CSV=/path/to/sp500_arq.csv bun scripts/earnings-reaction-study.ts      (fast: pre-extracted)
//   bun scripts/earnings-reaction-study.ts                                     (streams the 2.4GB zip, ~4 min)
//   SAMPLE=1 ...                                                               (spot-check sample events)
//
// Owner's question (2026-10-28, after FTNT beat EPS and fell ~26% on slowing growth): the agent
// holds momentum names through earnings and may buy into them on a "serial beat" record. Are there
// other pre-print signals worth adding? We have NO historical consensus estimates, so the beat record
// itself (and "beat but guided down") cannot be replicated here and no proxy is attempted.
//
// EVENTS. 8-K Item 2.02 filings (Sharadar EVENTS code 22), 2008+, for names in the S&P 500 on that date.
// Each event is tied to the quarter it announces: the first ARQ row whose reportperiod is before the
// 8-K and whose filing date (`date` column = Sharadar datekey, the 10-Q/10-K filing date — verified:
// AAPL 2026-Q3 reportperiod 2026-06-27, 8-K 2026-07-30, row date 2026-07-31) is ON/AFTER the 8-K and
// within 100 days. One event per (ticker, announced quarter): the first 2.02 after the quarter ends.
// FUNDAMENTALS. SF1 dimension ARQ (as originally reported, no restatement look-ahead). The provided
// sp500_fund_all.csv holds only ART/ARY, so ARQ is extracted from fundamentals.csv.zip (all of SF1).
// POINT-IN-TIME. "Known" fundamentals = ARQ rows with date STRICTLY BEFORE the 8-K date.
// RETURNS (closeadj). Timing (bmo/amc) is unknown, so REACTION = close of the trading day BEFORE the
// 8-K date → close of the first trading day AFTER it (covers both). DRIFT = from that close +20/+60d.
// Excess vs SPY, and vs MOMENTUM-MATCHED PEERS: same-day S&P members in the same 12-1 momentum
// quintile (measured at the pre-event close), excluding names with an 8-K 2.02 within ±3 calendar days.
// PREDICTORS (quintiles formed WITHIN each calendar quarter, and within the subset being studied):
//   dGrowth1  known YoY revenue growth of the latest known quarter minus that of the quarter before.
//             Q1 = most DECELERATING.
//   dGrowth2  same, vs two quarters before.
//   ps        price/sales on the pre-event close: marketcap at the known row's filing date, rolled to the
//             pre-event close by the closeadj ratio, over the sum of the last 4 known quarterly revenues.
//   evebitda  Sharadar's evebitda of the latest known row (stale by up to a quarter; ≤0 dropped).
//   runup60   60-trading-day return to the pre-event close.
//   stretch   mean of within-quarter percentile ranks of ps and runup60.
//   POSITIVE CONTROL (NOT TRADEABLE — uses the quarter being announced): revealed dGrowth = YoY growth
//   of the announced quarter minus that of the latest known quarter.
// SUBSETS. ALL; HIGH-MOM = top 12-1 momentum quintile of S&P members on the pre-event close;
// HIGH-MOM+QUALITY = HIGH-MOM and above-median (within quarter, within high-mom) quality, quality =
// percentile(ROE = netinccmn/equity of the latest known quarter; Sharadar leaves ARQ roe blank, and
// equity ≤ 0 → missing) minus percentile(debt/equity) — a crude proxy; financials'
// high D/E penalises banks.
// STATS. Means per quintile, Q5−Q1 spread with standard errors CLUSTERED BY CALENDAR QUARTER of the
// event (OLS sandwich), P(raw reaction ≤ −10%). Drift windows overlap across events → t is rough.
//
// RESULT (2026-10-28, 8-Ks 2008-01 → 2026-09: 35,662 events / 834 names; HIGH-MOM 7,195; HIGH-MOM+QUAL
// 3,399). Base rates: 2-day |reaction| ≈ 4.5%, P(reaction ≤ −10%) = 4.9% all, 5.1% high-mom.
// Cells = REACTION excess vs momentum peers; Q5−Q1 spread (t clustered by calendar quarter); drop = P(≤−10%).
//
//   HIGH-MOM (what the strategy holds)       Q1          Q5         Q5−Q1 (t)     drop Q1 → Q5
//   revealed Δgrowth  [CONTROL, untradeable] −1.09%      +1.00%     +2.09% (8.4)   7.0% → 3.5%
//   dG1 known decel (Q1 = most decel)        +0.21%      −0.25%     −0.45% (−1.9)  4.4% → 5.8%
//   dG2 known decel vs 2q back               +0.28%      −0.49%     −0.78% (−3.7)  4.4% → 6.7%
//   P/S (Q5 = richest)                       −0.27%      +0.15%     +0.42% (1.8)   6.2% → 6.0%
//   EV/EBITDA                                −0.19%      +0.32%     +0.51% (2.3)   5.1% → 6.6%
//   runup60                                  +0.05%      +0.14%     +0.09% (0.3)   5.9% → 6.7%
//   stretch (P/S + runup rank)               −0.14%      +0.19%     +0.32% (1.4)   5.5% → 5.9%
//   Drift +20d/+60d after the print: no predictor has |t| ≥ 2 in HIGH-MOM, and the control's drift is ~0.
//
//   POSITIVE CONTROL passes: ALL +1.87% (t 15.2), drop 7.2% → 3.5%; HIGH-MOM+QUAL +2.64% (t 7.5), drop
//   7.8% → 3.4%; same sign and size in both halves (HIGH-MOM +1.79% / +2.35%). Dates/joins are sane.
//   Spot checks (SAMPLE=1) match public numbers: AAPL Dec-23 qtr rev +2.1% YoY; META Q4-21 −25.5%
//   reaction with growth 35% → 20%; NFLX Apr-22 −33%; INTC Aug-24 −30%.
//
//   STABILITY (HIGH-MOM, reaction spread, 2008-16 / 2017+): dG1 −0.71% (−2.2) / −0.23% (−0.6);
//   dG2 −0.50% (−1.8) / −1.01% (−3.4), drop +2.2pp / +2.5pp; P/S +0.72% (2.4) / +0.16% (0.4);
//   EV/EBITDA +0.41% / +0.60% (t 1.7 each); runup60 −0.52% / +0.62% (sign flips).
//   ALL events: rich P/S and big run-ups have a LOWER tail risk (drop 4.9% vs 7.1-7.2% in cheap /
//   beaten-down names, t ≈ −5, both halves) — cheap/falling names are the volatile ones, not rich ones.
//
// VERDICT.
//   • Known revenue DECELERATION: NONE as a warning — it goes the OTHER way. Among momentum names the
//     most-decelerated quintile had the best reactions (+0.2-0.3%) and the fewest ≥10% drops (4.4%).
//     The deceleration you can see is already in the price; what hurts is NEW deceleration at the print.
//   • The reverse (known ACCELERATION over 2 quarters, dG2 Q5): WEAK but consistent. HIGH-MOM reaction
//     −0.5% vs +0.3% for decelerators (spread −0.8%, t −3.7, same sign both halves), ≥10%-drop odds
//     6.7% vs 4.4%. Plausibly "hot growth → high bar". Small: ~0.8pp of a 2-day move, ~+2pp drop odds;
//     ~100 cells were examined, so treat as a candidate tiebreaker, not a rule.
//   • STRETCHED valuation (P/S, EV/EBITDA): NONE — if anything rich momentum names reacted slightly
//     BETTER (+0.4-0.5%, t ≈ 2, P/S effect gone after 2017), with no tail difference for P/S.
//   • RUN-UP into the print (60d): NONE (|t| < 1, sign flips between halves). Combination: NONE.
//   • The real driver is what is REVEALED at the print (control: ~2pp spread, 2x the drop odds), and
//     nothing pre-print here forecasts it. FTNT-type outcomes (beat, then −26% on slowing growth) are
//     the control effect, not something these inputs could have flagged.
// CANNOT TEST: consensus EPS/revenue beat/miss, guidance vs consensus, the serial-beat rule itself
// (no historical estimates — no proxy attempted), bmo/amc timing, options-implied move.
// CAVEATS: the 8-K 2.02 date stands in for the release date (a few are pre-announcements; one event per
// announced quarter = first 2.02 after quarter end; 1,531 8-Ks had no ARQ quarter match); quality =
// ROE − D/E rank, crude (banks penalised); S&P membership is point-in-time and delisted names keep
// their last price (no survivorship drop); overlapping drift windows make drift t-stats rough.
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const PRICE_FROM = "2006-06-01";
const EVENT_FROM = "2008-01-01";
const DRIFT = [20, 60];
const SAMPLE = !!process.env.SAMPLE;

// ── streaming line reader ─────────────────────────────────────────────────────
async function eachLine(stream: AsyncIterable<Uint8Array>, fn: (l: string) => void) {
  const dec = new TextDecoder(); let carry = "";
  for await (const chunk of stream) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number, start = 0;
    while ((nl = carry.indexOf("\n", start)) !== -1) { fn(carry.slice(start, nl)); start = nl + 1; }
    carry = carry.slice(start);
  }
  if (carry) fn(carry);
}

// ── prices: closeadj on SPY's calendar ───────────────────────────────────────
const spyRows = (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)
  .map(l => l.split(",")).filter(f => f.length >= 8 && f[1] >= PRICE_FROM && +f[7] > 0)
  .map(f => ({ d: f[1], c: +f[7] })).sort((a, b) => a.d.localeCompare(b.d));
const days = spyRows.map(r => r.d);
const dayIx = new Map(days.map((d, i) => [d, i]));
const spy = Float64Array.from(spyRows.map(r => r.c));
const N = days.length;
const px = new Map<string, Float64Array>();
{
  let head = false;
  await eachLine(Bun.file(`${CACHE}/sp500_prices.csv`).stream() as unknown as AsyncIterable<Uint8Array>, line => {
    if (!head) { head = true; return; }
    const f = line.split(","); if (f.length < 8) return;
    const i = dayIx.get(f[1]); if (i === undefined) return;
    const c = +f[7] > 0 ? +f[7] : +f[5]; if (!(c > 0)) return;
    let a = px.get(f[0]); if (!a) { a = new Float64Array(N).fill(NaN); px.set(f[0], a); }
    a[i] = c;
  });
}
const at = (a: Float64Array, i: number, lookback = 10) => { for (let j = i; j >= 0 && j > i - lookback; j--) if (a[j] > 0) return a[j]; return NaN; };
const lastAt = (a: Float64Array, i: number) => { for (let j = Math.min(i, N - 1); j >= 0; j--) if (a[j] > 0) return a[j]; return NaN; };
/** Return from day i to day j (j may run past a delisting: last price carried). */
const ret = (a: Float64Array, i: number, j: number) => { const p0 = a[i]; if (!(p0 > 0) || j >= N) return NaN; return lastAt(a, j) / p0 - 1; };
const mom = (a: Float64Array, i: number) => { const p1 = at(a, i - 21), p12 = at(a, i - 252); return p1 > 0 && p12 > 0 ? p1 / p12 - 1 : NaN; };
const ixBefore = (d: string) => { let lo = 0, hi = N - 1, b = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] < d) { b = m; lo = m + 1; } else hi = m - 1; } return b; };
const ixAfter = (d: string) => { let lo = 0, hi = N - 1, b = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] > d) { b = m; hi = m - 1; } else lo = m + 1; } return b; };
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const memberCache = new Map<string, Set<string> | null>();
const members = (d: string) => { if (!memberCache.has(d)) memberCache.set(d, membersAsOfPrecise(universe, sp500Rows, d)); return memberCache.get(d)!; };

// ── earnings 8-Ks ────────────────────────────────────────────────────────────
const EARN = new Map<string, string[]>();
const earnByDate = new Map<string, Set<string>>();
for (const l of (await Bun.file(`${CACHE}/events.csv`).text()).split("\n").slice(1)) {
  const [t, d, codes] = l.split(",");
  if (!codes || !codes.split("|").includes("22") || !px.has(t)) continue;
  (EARN.get(t) ?? EARN.set(t, []).get(t)!).push(d);
  (earnByDate.get(d) ?? earnByDate.set(d, new Set()).get(d)!).add(t);
}
for (const a of EARN.values()) a.sort();

// ── ARQ fundamentals ─────────────────────────────────────────────────────────
interface Row { cd: string; date: string; rp: string; rev: number; mcap: number; evebitda: number; roe: number; de: number }
const fund = new Map<string, Row[]>();
{
  const tickers = new Set((await Bun.file(`${CACHE}/sp500_tickers.txt`).text()).split("\n").filter(Boolean));
  let H: string[] | null = null; let ix: Record<string, number> = {};
  const ingest = (l: string) => {
    if (!H) { H = l.split(","); for (const k of ["ticker", "dimension", "calendardate", "date", "reportperiod", "revenue", "marketcap", "evebitda", "netinccmn", "equity", "de"]) { ix[k] = H.indexOf(k); if (ix[k] < 0) throw new Error(`ARQ column ${k} missing`); } return; }
    const f = l.split(",");
    if (f[ix.dimension] !== "ARQ" || !tickers.has(f[ix.ticker])) return;
    const num = (k: string) => (f[ix[k]] === "" ? NaN : +f[ix[k]]);
    (fund.get(f[ix.ticker]) ?? fund.set(f[ix.ticker], []).get(f[ix.ticker])!).push({
      cd: f[ix.calendardate], date: f[ix.date], rp: f[ix.reportperiod], rev: num("revenue"), mcap: num("marketcap"),
      evebitda: num("evebitda"), roe: num("equity") > 0 ? num("netinccmn") / num("equity") : NaN, de: num("de"),
    });
  };
  if (process.env.ARQ_CSV) await eachLine(Bun.file(process.env.ARQ_CSV).stream() as unknown as AsyncIterable<Uint8Array>, ingest);
  else {
    console.error("streaming ARQ rows out of fundamentals.csv.zip (~4 min; set ARQ_CSV to a pre-filtered extract to skip)…");
    const p = Bun.spawn(["unzip", "-p", `${CACHE}/fundamentals.csv.zip`], { stdout: "pipe" });
    await eachLine(p.stdout as unknown as AsyncIterable<Uint8Array>, ingest);
  }
  for (const a of fund.values()) a.sort((x, y) => x.cd.localeCompare(y.cd) || x.date.localeCompare(y.date));
}
const byCd = new Map<string, Map<string, Row>>();
for (const [t, a] of fund) { const m = new Map<string, Row>(); for (const r of a) if (!m.has(r.cd)) m.set(r.cd, r); byCd.set(t, m); }
/** Calendar-quarter end shifted by k quarters (calendardate is always a quarter end). */
const cdShift = (cd: string, k: number) => {
  let y = +cd.slice(0, 4), q = Math.round(+cd.slice(5, 7) / 3) + k;
  while (q <= 0) { q += 4; y--; } while (q > 4) { q -= 4; y++; }
  return `${y}-${["03-31", "06-30", "09-30", "12-31"][q - 1]}`;
};
/** YoY revenue growth of quarter cd, using only rows filed strictly before `asOf` (or any if null). */
function yoy(t: string, cd: string, asOf: string | null): number {
  const m = byCd.get(t); if (!m) return NaN;
  const a = m.get(cd), b = m.get(cdShift(cd, -4));
  if (!a || !b || (asOf && (a.date >= asOf || b.date >= asOf))) return NaN;
  return a.rev > 0 && b.rev > 0 ? a.rev / b.rev - 1 : NaN;
}

// ── build events ─────────────────────────────────────────────────────────────
interface Ev {
  t: string; d: string; q: string; b: number; r: number;
  mom: number; momQ: number; quality: number;
  dG1: number; dG2: number; ps: number; evebitda: number; runup60: number; revealed: number; roe: number; de: number;
  react: number; reactSpy: number; reactPeer: number; drift: number[]; driftSpy: number[]; driftPeer: number[];
  gKnown: number; gRev: number; knownCd: string; revCd: string;
}
const peerCache = new Map<string, { cut: number[]; rows: { t: string; m: number; r: number[] }[] }>();
function peers(b: number, r: number) {
  const key = `${b}|${r}`; const hit = peerCache.get(key); if (hit) return hit;
  const rows: { t: string; m: number; r: number[] }[] = [];
  for (const t of members(days[b]) ?? []) {
    const a = px.get(t); if (!a || !(a[b] > 0)) continue;
    const m = mom(a, b); if (!Number.isFinite(m)) continue;
    rows.push({ t, m, r: [ret(a, b, r), ...DRIFT.map(h => ret(a, r, r + h))] });
  }
  const ms = rows.map(x => x.m).sort((x, y) => x - y);
  const cut = [0.2, 0.4, 0.6, 0.8].map(q => ms[Math.floor(q * (ms.length - 1))]);
  const v = { cut, rows }; peerCache.set(key, v); return v;
}
const qOfCut = (cut: number[], m: number) => cut.filter(x => m > x).length;

const events: Ev[] = [];
let noMatch = 0, notMember = 0;
for (const [t, dates] of EARN) {
  const rows = fund.get(t); const a = px.get(t); if (!rows || !a) continue;
  const used = new Set<string>();
  for (const d of dates) {
    if (d < EVENT_FROM) continue;
    // announced quarter: earliest-reportperiod row with rp < d ≤ date ≤ d+100
    const rev = rows.filter(x => x.rp < d && x.date >= d && dayDiff(d, x.date) <= 100 && dayDiff(x.rp, d) <= 120)
      .sort((x, y) => x.rp.localeCompare(y.rp))[0];
    if (!rev) { noMatch++; continue; }
    if (used.has(rev.cd)) continue; // first 2.02 after the quarter ends
    used.add(rev.cd);
    if (!members(d)?.has(t)) { notMember++; continue; }
    const known = rows.filter(x => x.date < d).sort((x, y) => x.date.localeCompare(y.date) || x.cd.localeCompare(y.cd)).at(-1);
    const b = ixBefore(d), r = ixAfter(d);
    if (b < 260 || r < 0 || !(a[b] > 0)) continue;
    const react = ret(a, b, r); if (!Number.isFinite(react)) continue;
    const m = mom(a, b); if (!Number.isFinite(m)) continue;
    const P = peers(b, r); const momQ = qOfCut(P.cut, m);
    const excl = new Set<string>(); for (let k = -3; k <= 3; k++) for (const x of earnByDate.get(addDays(d, k)) ?? []) excl.add(x);
    const pr = P.rows.filter(x => !excl.has(x.t) && qOfCut(P.cut, x.m) === momQ);
    const pm = [0, 1, 2].map(k => { const v = pr.map(x => x.r[k]).filter(Number.isFinite); return v.length >= 5 ? v.reduce((s, x) => s + x, 0) / v.length : NaN; });
    const drift = DRIFT.map(h => ret(a, r, r + h));
    const spyR = (i: number, j: number) => (j < N ? spy[j] / spy[i] - 1 : NaN);
    // predictors
    let dG1 = NaN, dG2 = NaN, ps = NaN, evebitda = NaN, roe = NaN, de = NaN, gKnown = NaN, gRev = NaN, revealed = NaN;
    if (known && known.rp < rev.rp) {
      gKnown = yoy(t, known.cd, d);
      dG1 = gKnown - yoy(t, cdShift(known.cd, -1), d);
      dG2 = gKnown - yoy(t, cdShift(known.cd, -2), d);
      const m4 = [0, 1, 2, 3].map(k => byCd.get(t)!.get(cdShift(known.cd, -k)));
      if (m4.every(x => x && x.date < d && x.rev > 0) && known.mcap > 0) {
        const ki = ixBefore(addDays(known.date, 1)); // close on/before the filing date
        const p0 = ki >= 0 ? at(a, ki) : NaN;
        if (p0 > 0) ps = known.mcap * (a[b] / p0) / m4.reduce((s, x) => s + x!.rev, 0);
      }
      evebitda = known.evebitda > 0 ? known.evebitda : NaN;
      roe = known.roe; de = known.de;
      // POSITIVE CONTROL — uses the announced quarter (not knowable before the print)
      if (cdShift(known.cd, 1) === rev.cd) { gRev = yoy(t, rev.cd, null); revealed = gRev - gKnown; }
    }
    const runup60 = ret(a, b - 60, b);
    events.push({
      t, d, q: `${d.slice(0, 4)}Q${Math.ceil(+d.slice(5, 7) / 3)}`, b, r, mom: m, momQ, quality: NaN,
      dG1, dG2, ps, evebitda, runup60, revealed, roe, de,
      react, reactSpy: react - spyR(b, r), reactPeer: react - pm[0],
      drift, driftSpy: DRIFT.map((h, k) => drift[k] - spyR(r, r + h)), driftPeer: DRIFT.map((_, k) => drift[k] - pm[k + 1]),
      gKnown, gRev, knownCd: known?.cd ?? "", revCd: rev.cd,
    });
  }
}

// ── quintiles within (calendar quarter × subset) ─────────────────────────────
type Key = "dG1" | "dG2" | "ps" | "evebitda" | "runup60" | "stretch" | "revealed";
const pctRank = (evs: Ev[], get: (e: Ev) => number) => {
  const out = new Map<Ev, number>();
  const byQ = new Map<string, Ev[]>(); for (const e of evs) if (Number.isFinite(get(e))) (byQ.get(e.q) ?? byQ.set(e.q, []).get(e.q)!).push(e);
  for (const a of byQ.values()) { const s = [...a].sort((x, y) => get(x) - get(y)); s.forEach((e, i) => out.set(e, s.length > 1 ? i / (s.length - 1) : 0.5)); }
  return out;
};
function getter(evs: Ev[], k: Key): (e: Ev) => number {
  if (k !== "stretch") return e => e[k];
  const a = pctRank(evs, e => e.ps), b = pctRank(evs, e => e.runup60);
  return e => (a.has(e) && b.has(e) ? (a.get(e)! + b.get(e)!) / 2 : NaN);
}
function quintiles(evs: Ev[], k: Key) {
  const g = getter(evs, k); const rk = pctRank(evs, g);
  const q = new Map<Ev, number>();
  const cnt = new Map<string, number>(); for (const e of rk.keys()) cnt.set(e.q, (cnt.get(e.q) ?? 0) + 1);
  for (const [e, p] of rk) if (cnt.get(e.q)! >= 10) q.set(e, Math.min(4, Math.floor(p * 5)));
  return q;
}

// ── stats ────────────────────────────────────────────────────────────────────
/** Cluster-robust (by calendar quarter) mean and t. */
function cmean(xs: { v: number; c: string }[]) {
  const v = xs.filter(x => Number.isFinite(x.v)); const n = v.length; if (n < 2) return { n, mean: NaN, t: NaN };
  const mean = v.reduce((s, x) => s + x.v, 0) / n;
  const g = new Map<string, number>(); for (const x of v) g.set(x.c, (g.get(x.c) ?? 0) + x.v - mean);
  const G = g.size; const se = Math.sqrt([...g.values()].reduce((s, x) => s + x * x, 0) * (G / Math.max(1, G - 1))) / n;
  return { n, mean, t: mean / se };
}
/** Difference of means (hi − lo) via OLS on a dummy with cluster-robust SE. */
function cdiff(hi: { v: number; c: string }[], lo: { v: number; c: string }[]) {
  const H = hi.filter(x => Number.isFinite(x.v)), L = lo.filter(x => Number.isFinite(x.v));
  if (H.length < 2 || L.length < 2) return { diff: NaN, t: NaN };
  const mh = H.reduce((s, x) => s + x.v, 0) / H.length, ml = L.reduce((s, x) => s + x.v, 0) / L.length;
  // X = [1, D]; (X'X)^-1 rows for b1: [-1/nL, 1/nL + 1/nH]... use the closed form: b1 = mh − ml,
  // influence of obs i on b1 = (D/nH − (1−D)/nL)·resid_i.
  const g = new Map<string, number>();
  for (const x of H) g.set(x.c, (g.get(x.c) ?? 0) + (x.v - mh) / H.length);
  for (const x of L) g.set(x.c, (g.get(x.c) ?? 0) - (x.v - ml) / L.length);
  const G = g.size; const se = Math.sqrt([...g.values()].reduce((s, x) => s + x * x, 0) * (G / Math.max(1, G - 1)));
  return { diff: mh - ml, t: (mh - ml) / se };
}
const pct = (x: number, dp = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%` : "—");
const fx = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

const METRICS: { name: string; get: (e: Ev) => number }[] = [
  { name: "react xPeer", get: e => e.reactPeer },
  { name: "react xSPY", get: e => e.reactSpy },
  { name: "+20d xPeer", get: e => e.driftPeer[0] },
  { name: "+60d xPeer", get: e => e.driftPeer[1] },
];
const drop = (e: Ev) => (e.react <= -0.10 ? 1 : 0);

function table(label: string, evs: Ev[], k: Key, brief = false) {
  const q = quintiles(evs, k);
  const cells = [0, 1, 2, 3, 4].map(i => [...q].filter(([, x]) => x === i).map(([e]) => e));
  if (!brief) {
    console.log(`\n  ${label} — ${k}  (n with predictor ${q.size} of ${evs.length})`);
    console.log(`    quintile     n    median-pred   ${METRICS.map(m => m.name.padStart(16)).join("")}   P(react≤−10%)`);
    cells.forEach((c, i) => {
      const g = getter(evs, k); const pv = c.map(g).sort((a, b) => a - b)[Math.floor(c.length / 2)];
      const ms = METRICS.map(m => { const s = cmean(c.map(e => ({ v: m.get(e), c: e.q }))); return `${pct(s.mean)} (${s.t.toFixed(1)})`.padStart(16); }).join("");
      console.log(`    Q${i + 1}${i === 0 ? " low " : i === 4 ? " high" : "     "}   ${String(c.length).padStart(5)}   ${(k === "ps" || k === "evebitda" || k === "stretch" ? fx(pv) : pct(pv, 1)).padStart(10)}   ${ms}   ${pct(c.reduce((s, e) => s + drop(e), 0) / Math.max(1, c.length), 1).padStart(7)}`);
    });
  }
  const sp = METRICS.map(m => { const s = cdiff(cells[4].map(e => ({ v: m.get(e), c: e.q })), cells[0].map(e => ({ v: m.get(e), c: e.q }))); return `${pct(s.diff)} (${s.t.toFixed(1)})`.padStart(16); }).join("");
  const dd = cdiff(cells[4].map(e => ({ v: drop(e), c: e.q })), cells[0].map(e => ({ v: drop(e), c: e.q })));
  console.log(`    ${brief ? label.padEnd(28) : "Q5−Q1 (t, clustered by qtr)".padEnd(28)}${sp}   ${pct(dd.diff, 1)} (${dd.t.toFixed(1)})  [n ${cells[0].length}/${cells[4].length}]`);
}

// ── subsets ──────────────────────────────────────────────────────────────────
const all = events;
const hiMom = all.filter(e => e.momQ === 4);
{
  const qr = pctRank(hiMom, e => e.roe), dr = pctRank(hiMom, e => e.de);
  for (const e of hiMom) if (qr.has(e) && dr.has(e)) e.quality = qr.get(e)! - dr.get(e)!;
}
const qualRank = pctRank(hiMom, e => e.quality);
const hiMomQual = hiMom.filter(e => (qualRank.get(e) ?? 0) > 0.5);

const span = (evs: Ev[]) => `${evs.length} events, ${new Set(evs.map(e => e.t)).size} names, ${evs.map(e => e.d).sort()[0]} → ${evs.map(e => e.d).sort().at(-1)}`;
console.log(`Prices ${days[0]} → ${days[N - 1]}. Earnings 8-Ks with no ARQ quarter match: ${noMatch}; not an S&P member that day: ${notMember}.`);
console.log(`ALL: ${span(all)}\nHIGH-MOM (top 12-1 quintile): ${span(hiMom)}\nHIGH-MOM + above-median quality: ${span(hiMomQual)}`);
const cov = (k: keyof Ev) => `${k} ${(100 * all.filter(e => Number.isFinite(e[k] as number)).length / all.length).toFixed(0)}%`;
console.log(`Predictor coverage (ALL): ${["dG1", "dG2", "ps", "evebitda", "runup60", "revealed", "roe", "de"].map(k => cov(k as keyof Ev)).join(", ")}`);
const base = (evs: Ev[], l: string) => { const s = cmean(evs.map(e => ({ v: e.reactPeer, c: e.q }))); console.log(`  ${l}: mean reaction xPeer ${pct(s.mean)}, mean |reaction| ${pct(evs.reduce((s, e) => s + Math.abs(e.react), 0) / evs.length)}, P(react≤−10%) ${pct(evs.reduce((s, e) => s + drop(e), 0) / evs.length, 1)}`); };
base(all, "ALL"); base(hiMom, "HIGH-MOM"); base(hiMomQual, "HIGH-MOM+QUAL");
console.log(`\nCells: mean (clustered t). Quintiles formed within each calendar quarter within the subset; Q1 = lowest predictor value.`);
console.log(`For dG1/dG2/revealed, Q1 = most DECELERATING growth. For ps/evebitda/runup60/stretch, Q5 = most STRETCHED.`);

const KEYS: Key[] = ["revealed", "dG1", "dG2", "ps", "evebitda", "runup60", "stretch"];
for (const [label, evs] of [["HIGH-MOM", hiMom], ["HIGH-MOM+QUAL", hiMomQual], ["ALL", all]] as const) {
  console.log(`\n════════ ${label} ════════`);
  for (const k of KEYS) table(label, evs, k);
}
console.log(`\n════════ STABILITY: Q5−Q1 spreads by half (cols: ${METRICS.map(m => m.name).join(" | ")} | ΔP(drop)) ════════`);
for (const k of KEYS) {
  console.log(`  ${k}${k === "revealed" ? "  (POSITIVE CONTROL — not tradeable)" : ""}`);
  for (const [label, evs] of [["HIGH-MOM", hiMom], ["ALL", all]] as const) {
    table(`${label} 2008-2016`, evs.filter(e => e.d < "2017-01-01"), k, true);
    table(`${label} 2017-latest`, evs.filter(e => e.d >= "2017-01-01"), k, true);
  }
}

// SPOT CHECK (SAMPLE=1): raw inputs per event so dates/returns can be recomputed by hand.
if (SAMPLE) {
  console.log(`\nSPOT CHECK`);
  const pick: [string, string][] = [["AAPL", "2024-"], ["NFLX", "2022-04"], ["META", "2022-02"], ["NVDA", "2023-05"], ["MSFT", "2025-"], ["FTNT", "2022-"], ["INTC", "2024-08"]];
  for (const [t, pre] of pick) for (const e of all.filter(e => e.t === t && e.d.startsWith(pre)).slice(0, 2)) {
    const a = px.get(t)!;
    console.log(`  ${t} 8-K ${e.d} (quarter ${e.revCd}, known ${e.knownCd}) | close ${days[e.b]} ${a[e.b].toFixed(2)} → ${days[e.r]} ${a[e.r].toFixed(2)} react ${pct(e.react)} xSPY ${pct(e.reactSpy)} xPeer ${pct(e.reactPeer)} | +20d ${pct(e.drift[0])} | mom ${pct(e.mom, 0)} (Q${e.momQ + 1}) run60 ${pct(e.runup60, 1)} | gKnown ${pct(e.gKnown, 1)} dG1 ${pct(e.dG1, 1)} dG2 ${pct(e.dG2, 1)} | gRevealed ${pct(e.gRev, 1)} revealed Δ ${pct(e.revealed, 1)} | P/S ${fx(e.ps)} EV/EBITDA ${fx(e.evebitda)}`);
  }
}
