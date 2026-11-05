/**
 * SLEEVE EXIT EXPERIMENT (PROXY) — would a trailing stop help the influencer sleeve?
 *
 *   bun scripts/sleeve-exit-backtest.ts [--from YYYY-MM-DD]
 *
 * Asked 2026-11-03 (owner). The live sleeve's best holdings peaked +10..16% (closes) and were sold
 * near flat (PLTR +16% → −0.2%, NVDA +11% → +1.4%, CAKE +11% → +0.9%); none ever reached the +40%
 * take-profit. The real signal (YouTube mentions) has only ~4 months of history, so this runs the
 * sleeve's EXIT rules on PROXY entries across 1999-2026. It answers "does a trailing stop help on
 * names like these?", NOT "does it help on influencer picks" — the proxy is a stand-in.
 *
 * Book: 2 slots, like the sleeve. A free slot is filled at the close with the top-ranked candidate
 * that passes the live ⛔DOWNTREND screen (lib/influencer-signals: 5d ≥ −8% and within 15% of the
 * 10-day high, or above its 5-day average). Popular-name universe: the 100 S&P members with the
 * highest 60-day average dollar volume (influencers talk about big, liquid names). Each proxy ranks
 * that universe differently:
 *   hot     highest 20-day return             (what a YouTube buzz cycle chases)
 *   vol     highest 60-day volatility, 20d > 0 (the speculative end)
 *   random  seeded random pick                 (no signal — is the exit effect generic?)
 *
 * Live exits, every variant (closes; the live drop-check runs intraday, so this is milder):
 *   −10% from buy (INFLUENCER_DROP_THRESHOLD_PCT), +40% take-profit (TAKE_PROFIT_PCT),
 *   stale-down: ≥10 days held and < −2%; no-move: ≥25 days held and < +8% (lib/strategy; live
 *   lets the model keep a re-accelerating name, here they are forced).
 * Variants add ONE rule on top:
 *   trail15          sell when the close falls 15% below the peak close since buy
 *   a10-trail7/10    once the peak is ≥ +10%, sell on a 7% / 10% drop from the peak close
 *   a15-trail10      once the peak is ≥ +15%, sell on a 10% drop from the peak
 *   a10-lock2        once the peak is ≥ +10%, sell if the gain falls back to +2% (keep a small win)
 *   tp15 / tp20      a lower fixed take-profit instead of +40%
 * A sold name may not be re-bought for 10 trading days (so a stop is not undone the next day).
 *
 * Research only: reads the local Sharadar cache, writes nothing, touches no live code path.
 */
import { parseSp500Csv, buildUniverseIndex, membersAsOfPrecise } from "../lib/sharadar-universe";
import { INFLUENCER_DROP_THRESHOLD_PCT, TAKE_PROFIT_PCT } from "../lib/stopouts";
import { INFLUENCER_STALE_DAYS, INFLUENCER_STALE_RETURN_PCT, INFLUENCER_ZOMBIE_DAYS, INFLUENCER_ZOMBIE_RETURN_PCT } from "../lib/strategy";
import { MOMENTUM_FLOOR_PCT, DIST_FROM_HIGH_FLOOR } from "../lib/influencer-signals";

const CACHE = process.env.SHARADAR_CACHE_DIR ?? `${process.env.HOME}/.cache/sharadar`;
const DATA_FROM = "1998-06-01", TEST_TO = "2026-09-29";
const TEST_FROM = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : "1999-01-04";
const SLOTS = 2, UNIVERSE_TOP = 100, COOLDOWN = 10, COST_BPS = 5;

// ── data: adjusted closes + dollar volume, columnar per ticker ──────────────
type Bars = { dates: string[]; px: number[]; dv: number[] };
const series = new Map<string, Bars>();
{
  const dec = new TextDecoder(); let carry = "", header = true;
  const ingest = (line: string) => {
    const f = line.split(","); if (f.length < 9) return;
    const date = f[1]; if (date < DATA_FROM || date > TEST_TO) return;
    const close = +f[5], vol = +f[6], ca = +f[7];
    const px = Number.isFinite(ca) && ca > 0 ? ca : close;
    if (!Number.isFinite(px) || px <= 0) return;
    let b = series.get(f[0]); if (!b) { b = { dates: [], px: [], dv: [] }; series.set(f[0], b); }
    b.dates.push(date); b.px.push(px); b.dv.push(Number.isFinite(vol) && close > 0 ? vol * close : 0);
  };
  for await (const chunk of Bun.file(`${CACHE}/sp500_prices.csv`).stream() as unknown as AsyncIterable<Uint8Array>) {
    carry += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) { const l = carry.slice(0, nl); carry = carry.slice(nl + 1); if (header) { header = false; continue; } ingest(l); }
  }
  if (carry) ingest(carry);
  for (const [t, b] of series) {
    const o = b.dates.map((_, i) => i).sort((x, y) => b.dates[x].localeCompare(b.dates[y]));
    series.set(t, { dates: o.map(i => b.dates[i]), px: o.map(i => b.px[i]), dv: o.map(i => b.dv[i]) });
  }
}
const idxOf = new Map<string, Map<string, number>>();   // ticker -> date -> bar index
for (const [t, b] of series) idxOf.set(t, new Map(b.dates.map((d, i) => [d, i])));
const spy = new Map<string, number>();
for (const line of (await Bun.file(`${CACHE}/spy.csv`).text()).split("\n").slice(1)) {
  const f = line.split(","); if (f.length < 8) continue;
  const v = +f[7]; if (f[1] && Number.isFinite(v) && v > 0) spy.set(f[1], v);
}
const sp500Rows = parseSp500Csv(await Bun.file(`${CACHE}/sp500.csv`).text());
const universe = buildUniverseIndex(sp500Rows);
const days = [...spy.keys()].filter(d => d >= TEST_FROM && d <= TEST_TO).sort();
const priceAt = (t: string, d: string) => { const i = idxOf.get(t)?.get(d); return i == null ? null : series.get(t)!.px[i]; };

// ── per-day candidate lists (computed once, shared by every variant) ────────
type Cand = { sym: string; r20: number; vol: number };
function candidatesOn(d: string, members: Set<string>): Cand[] {
  const rows: Array<Cand & { adv: number }> = [];
  for (const t of members) {
    const b = series.get(t); const i = idxOf.get(t)?.get(d);
    if (!b || i == null || i < 60) continue;
    const p = b.px[i];
    let adv = 0; for (let k = i - 59; k <= i; k++) adv += b.dv[k]; adv /= 60;
    const r20 = (p / b.px[i - 20] - 1) * 100, c5 = (p / b.px[i - 5] - 1) * 100;
    const hi10 = Math.max(...b.px.slice(i - 9, i + 1));
    const dist = (p / hi10 - 1) * 100;
    const ma5 = b.px.slice(i - 4, i + 1).reduce((a, x) => a + x, 0) / 5;
    const downtrend = (c5 < MOMENTUM_FLOOR_PCT || dist < DIST_FROM_HIGH_FLOOR) && !(p > ma5);
    if (downtrend) continue;
    const rets: number[] = []; for (let k = i - 59; k <= i; k++) rets.push(b.px[k] / b.px[k - 1] - 1);
    const m = rets.reduce((a, x) => a + x, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / rets.length);
    rows.push({ sym: t, r20, vol, adv });
  }
  rows.sort((a, b) => b.adv - a.adv);
  return rows.slice(0, UNIVERSE_TOP);
}
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ranked = { hot: new Map<string, string[]>(), vol: new Map<string, string[]>(), random: new Map<string, string[]>() };
for (const d of days) {
  const c = candidatesOn(d, membersAsOfPrecise(universe, sp500Rows, d) ?? new Set());
  ranked.hot.set(d, [...c].sort((a, b) => b.r20 - a.r20).slice(0, 20).map(x => x.sym));
  ranked.vol.set(d, c.filter(x => x.r20 > 0).sort((a, b) => b.vol - a.vol).slice(0, 20).map(x => x.sym));
  const sh = c.map(x => ({ s: x.sym, k: rnd() })).sort((a, b) => a.k - b.k);
  ranked.random.set(d, sh.slice(0, 20).map(x => x.s));
  if (d.endsWith("-01-0") || d.slice(5, 10) === "01-02" || d.slice(5, 10) === "01-03") console.error(`  … ${d}`);
}

// ── simulation ──────────────────────────────────────────────────────────────
type Rule = { id: string; trail?: number; activate?: number; lock?: number; tp?: number; holdOnly?: number; keepStop?: boolean; stop?: number | null };
const RULES: Rule[] = [
  { id: "live" },
  { id: "trail15", trail: 15, activate: 0 },
  { id: "a10-trail7", trail: 7, activate: 10 },
  { id: "a10-trail10", trail: 10, activate: 10 },
  { id: "a15-trail10", trail: 10, activate: 15 },
  { id: "a10-lock2", lock: 2, activate: 10 },
  { id: "tp15", tp: 15 },
  { id: "tp20", tp: 20 },
  // CONTROL, not a candidate: no stop, no take-profit, no clocks — sell after N days. Checks the
  // simulator (a random 2-name book held 60 days should earn roughly the market, with high spread).
  { id: "ctl-hold60", holdOnly: 60 },
  // ADDED 2026-11-03 (owner: "how about 30 days for influencers?"): a plain time exit instead of
  // the two stale clocks. -stop keeps the −10% stop and +40% take-profit; the bare ones keep nothing.
  { id: "hold20", holdOnly: 20 },
  { id: "hold30", holdOnly: 30 },
  { id: "hold30-stop", holdOnly: 30, keepStop: true },
  { id: "hold60-stop", holdOnly: 60, keepStop: true },
  // ADDED 2026-11-05 (owner): the sleeve's -10%-from-buy stop ISOLATED — every other live exit
  // (+40% take-profit, both stale clocks) unchanged. null = no stop at all.
  { id: "no-stop", stop: null },
  { id: "stop15", stop: -15 },
  { id: "stop20", stop: -20 },
];
const stopOf = (rule: Rule): number | null => rule.stop === undefined ? INFLUENCER_DROP_THRESHOLD_PCT : rule.stop;
type Pos = { sym: string; entry: number; shares: number; peak: number; held: number; last: number; missing: number };
type Trade = { ret: number; peak: number; days: number; why: string; year: string };
function simulate(pick: Map<string, string[]>, rule: Rule) {
  let cash = 10_000; let book: Pos[] = [];
  const lastSold = new Map<string, number>(); const trades: Trade[] = []; const eq: Array<{ d: string; e: number; s: number }> = [];
  const cost = (n: number) => n * COST_BPS / 10_000;
  days.forEach((d, di) => {
    // exits on today's close
    const keep: Pos[] = [];
    for (const p of book) {
      const px = priceAt(p.sym, d);
      // No bar: hold at the last price, but a name gone 5 days (delisted, merged) is closed at that
      // price — otherwise it squats a slot forever and the 2-slot book silently stops trading.
      if (px == null) {
        if (++p.missing < 5) { keep.push(p); continue; }
        cash += p.shares * p.last - cost(p.shares * p.last); lastSold.set(p.sym, di);
        trades.push({ ret: (p.last / p.entry - 1) * 100, peak: (p.peak / p.entry - 1) * 100, days: p.held, why: "gone", year: d.slice(0, 4) });
        continue;
      }
      p.missing = 0; p.last = px; p.held++; p.peak = Math.max(p.peak, px);
      const ret = (px / p.entry - 1) * 100, peakRet = (p.peak / p.entry - 1) * 100, fromPeak = (px / p.peak - 1) * 100;
      let why = "";
      if (rule.holdOnly != null) {
        if (rule.keepStop && ret <= INFLUENCER_DROP_THRESHOLD_PCT) why = "stop";
        else if (rule.keepStop && ret >= TAKE_PROFIT_PCT) why = "tp";
        else if (p.held >= rule.holdOnly) why = "no-move";
      }
      else if (stopOf(rule) != null && ret <= stopOf(rule)!) why = "stop";
      else if (ret >= (rule.tp ?? TAKE_PROFIT_PCT)) why = "tp";
      else if (rule.trail != null && peakRet >= (rule.activate ?? 0) && fromPeak <= -rule.trail) why = "trail";
      else if (rule.lock != null && peakRet >= (rule.activate ?? 0) && ret <= rule.lock) why = "trail";
      else if (p.held >= INFLUENCER_STALE_DAYS && ret < INFLUENCER_STALE_RETURN_PCT) why = "stale";
      else if (p.held >= INFLUENCER_ZOMBIE_DAYS && ret < INFLUENCER_ZOMBIE_RETURN_PCT) why = "no-move";
      if (why) {
        cash += p.shares * px - cost(p.shares * px); lastSold.set(p.sym, di);
        trades.push({ ret, peak: peakRet, days: p.held, why, year: d.slice(0, 4) });
      } else keep.push(p);
    }
    book = keep;
    // fill free slots at today's close
    for (const sym of pick.get(d) ?? []) {
      if (book.length >= SLOTS) break;
      if (book.some(p => p.sym === sym)) continue;
      const ls = lastSold.get(sym); if (ls != null && di - ls < COOLDOWN) continue;
      const px = priceAt(sym, d); if (px == null) continue;
      const amt = cash / (SLOTS - book.length);
      cash -= amt; book.push({ sym, entry: px, shares: (amt - cost(amt)) / px, peak: px, held: 0, last: px, missing: 0 });
    }
    const e = cash + book.reduce((a, p) => a + p.shares * (priceAt(p.sym, d) ?? p.last), 0);
    eq.push({ d, e, s: spy.get(d)! });
  });
  return { eq, trades };
}

// ── report ──────────────────────────────────────────────────────────────────
const pct = (n: number, k = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(k)}%`;
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length || 1)); };
const med = (x: number[]) => { const y = [...x].sort((a, b) => a - b); return y[Math.floor(y.length / 2)] ?? NaN; };
const cagrOf = (eq: Array<{ d: string; e: number }>, from: string, to: string) => {
  const ms = eq.filter(m => m.d >= from && m.d <= to);
  const y = (Date.parse(ms[ms.length - 1].d) - Date.parse(ms[0].d)) / (365.25 * 86_400_000);
  return (Math.pow(ms[ms.length - 1].e / ms[0].e, 1 / y) - 1) * 100;
};
const ddOf = (e: number[]) => { let pk = e[0], dd = 0; for (const x of e) { pk = Math.max(pk, x); dd = Math.min(dd, x / pk - 1); } return dd * 100; };

console.log(`\nSLEEVE EXIT EXPERIMENT (proxy entries) — ${SLOTS} slots, top-${UNIVERSE_TOP} by dollar volume, ${TEST_FROM} → ${TEST_TO}, cost ${COST_BPS}bps`);
console.log(`Live exits in every variant: stop ${INFLUENCER_DROP_THRESHOLD_PCT}%, TP +${TAKE_PROFIT_PCT}%, stale ≥${INFLUENCER_STALE_DAYS}d & <${INFLUENCER_STALE_RETURN_PCT}%, no-move ≥${INFLUENCER_ZOMBIE_DAYS}d & <+${INFLUENCER_ZOMBIE_RETURN_PCT}%`);
for (const [proxy, pick] of Object.entries(ranked)) {
  console.log(`\n=== proxy: ${proxy} ===`);
  console.log(`  ${"variant".padEnd(13)}${"CAGR".padStart(9)}${"Sharpe".padStart(8)}${"maxDD".padStart(8)}${"→2012".padStart(9)}${"2013→".padStart(9)}${"trades".padStart(7)}${"avgTrade".padStart(10)}${"win%".padStart(6)}${"days".padStart(6)}  exits (stop/tp/trail/stale/no-move)   paired vs live`);
  let ref: Map<string, number> | null = null;
  for (const rule of RULES) {
    const { eq, trades } = simulate(pick, rule);
    const rs: number[] = []; const dm = new Map<string, number>();
    for (let i = 1; i < eq.length; i++) { const r = eq[i].e / eq[i - 1].e - 1; rs.push(r); dm.set(eq[i].d, r); }
    const sharpe = sd(rs) > 0 ? mean(rs) / sd(rs) * Math.sqrt(252) : 0;
    const cnt = (w: string) => trades.filter(t => t.why === w).length;
    let paired = "";
    if (!ref) ref = dm;
    else {
      const d: number[] = []; for (const [k, x] of dm) { const b = ref.get(k); if (b != null) d.push(x - b); }
      paired = `${pct(mean(d) * 252 * 100)} t=${(mean(d) / (sd(d) / Math.sqrt(d.length))).toFixed(2)}`;
    }
    console.log(`  ${rule.id.padEnd(13)}${pct(cagrOf(eq, TEST_FROM, TEST_TO)).padStart(9)}${sharpe.toFixed(2).padStart(8)}${pct(ddOf(eq.map(m => m.e)), 0).padStart(8)}${(TEST_FROM < "2013" ? pct(cagrOf(eq, TEST_FROM, "2012-12-31")) : "—").padStart(9)}${pct(cagrOf(eq, "2013-01-01", TEST_TO)).padStart(9)}${String(trades.length).padStart(7)}${pct(mean(trades.map(t => t.ret))).padStart(10)}${(100 * trades.filter(t => t.ret > 0).length / trades.length).toFixed(0).padStart(5)}%${mean(trades.map(t => t.days)).toFixed(0).padStart(6)}  ${["stop", "tp", "trail", "stale", "no-move"].map(cnt).join("/").padEnd(32)}  ${paired}`);
    if (rule.id === "live") {
      const pk = trades.map(t => t.peak);
      const gaveBack = trades.filter(t => t.peak >= 10);
      console.log(`  ${"".padEnd(13)}fidelity: median peak ${pct(med(pk), 1)}, ${(100 * pk.filter(x => x >= 10).length / pk.length).toFixed(0)}% of trades peak ≥+10%, ${(100 * pk.filter(x => x >= 40).length / pk.length).toFixed(1)}% reach +40%; trades that peaked ≥+10% exited at avg ${pct(mean(gaveBack.map(t => t.ret)), 1)}   (live sleeve: median peak ~+4%, 6/20 ≥+10%, 0/20 ≥+40%)`);
    }
  }
  const s = days.map(d => spy.get(d)!);
  const y = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / (365.25 * 86_400_000);
  console.log(`  ${"SPY".padEnd(13)}${pct((Math.pow(s[s.length - 1] / s[0], 1 / y) - 1) * 100).padStart(9)}${"".padStart(8)}${pct(ddOf(s), 0).padStart(8)}`);
}

// ── EVENT STUDY: same entries, every exit rule ──────────────────────────────
// The 2-slot book is path-dependent (one different exit changes every later pick), so its paired
// numbers are noisy. Here the ENTRIES are fixed: every ${STEP} trading days, the top ${TOPK} names of
// the proxy's ranking. Each entry is run under each rule for ${H} trading days; after an exit the
// money earns SPY's return until day ${H}. The difference vs live isolates the exit rule.
// Entries ${STEP} days apart with a ${H}-day window overlap ~${H / STEP}x, so the t-stat is computed on
// per-date means with the standard error inflated by sqrt(H/STEP).
const STEP = 20, TOPK = 10, H = 60;
function exitRun(sym: string, di: number, rule: Rule): number | null {
  const p0 = priceAt(sym, days[di]); if (p0 == null) return null;
  let peak = p0, last = p0;
  for (let k = 1; k <= H && di + k < days.length; k++) {
    const px = priceAt(sym, days[di + k]); if (px == null) continue;
    last = px; peak = Math.max(peak, px);
    const ret = (px / p0 - 1) * 100, peakRet = (peak / p0 - 1) * 100, fromPeak = (px / peak - 1) * 100;
    const out = rule.holdOnly != null
      ? (k >= rule.holdOnly || (!!rule.keepStop && (ret <= INFLUENCER_DROP_THRESHOLD_PCT || ret >= TAKE_PROFIT_PCT))) :
      (stopOf(rule) != null && ret <= stopOf(rule)!) || ret >= (rule.tp ?? TAKE_PROFIT_PCT) ||
      (rule.trail != null && peakRet >= (rule.activate ?? 0) && fromPeak <= -rule.trail) ||
      (rule.lock != null && peakRet >= (rule.activate ?? 0) && ret <= rule.lock) ||
      (k >= INFLUENCER_STALE_DAYS && ret < INFLUENCER_STALE_RETURN_PCT) ||
      (k >= INFLUENCER_ZOMBIE_DAYS && ret < INFLUENCER_ZOMBIE_RETURN_PCT);
    if (out) {
      // Proceeds ride SPY to day H, so an early exit is not charged the market's drift for sitting
      // in cash (the first version did that, which biased every comparison toward holding).
      const s0 = spy.get(days[di + k]), s1 = spy.get(days[Math.min(di + H, days.length - 1)]);
      const after = s0 && s1 ? s1 / s0 : 1;
      return ((1 + ret / 100) * after - 1) * 100 - 2 * COST_BPS / 100;
    }
  }
  return (last / p0 - 1) * 100 - 2 * COST_BPS / 100;
}
console.log(`\nEVENT STUDY — fixed entries (top ${TOPK} every ${STEP} days), ${H}-day window, proceeds in SPY after exit. Mean trade return; diff vs live with overlap-adjusted t`);
for (const [proxy, pick] of Object.entries(ranked)) {
  console.log(`\n=== proxy: ${proxy} ===`);
  const perRule = new Map<string, Map<number, number[]>>();
  for (const rule of RULES) {
    const m = new Map<number, number[]>();
    for (let di = 0; di + 1 < days.length; di += STEP) {
      const xs: number[] = [];
      for (const sym of (pick.get(days[di]) ?? []).slice(0, TOPK)) { const r = exitRun(sym, di, rule); if (r != null) xs.push(r); }
      if (xs.length) m.set(di, xs);
    }
    perRule.set(rule.id, m);
  }
  const live = perRule.get("live")!;
  const allLive = [...live.values()].flat();
  console.log(`  ${"variant".padEnd(13)}${"n".padStart(6)}${"mean".padStart(9)}${"win%".padStart(6)}${"diff".padStart(9)}${"t".padStart(7)}${"→2012".padStart(9)}${"2013→".padStart(9)}`);
  for (const rule of RULES) {
    const m = perRule.get(rule.id)!; const all = [...m.values()].flat();
    const diffs = (pred: (di: number) => boolean) => { const d: number[] = []; for (const [di, xs] of m) if (pred(di)) { const b = live.get(di)!; d.push(mean(xs) - mean(b)); } return d; };
    const t = (d: number[]) => sd(d) > 0 ? mean(d) / (sd(d) / Math.sqrt(d.length) * Math.sqrt(H / STEP)) : 0;
    const dAll = diffs(() => true), d1 = diffs(di => days[di] < "2013"), d2 = diffs(di => days[di] >= "2013");
    console.log(`  ${rule.id.padEnd(13)}${String(all.length).padStart(6)}${pct(mean(all)).padStart(9)}${(100 * all.filter(x => x > 0).length / all.length).toFixed(0).padStart(5)}%${(rule.id === "live" ? "" : pct(mean(dAll))).padStart(9)}${(rule.id === "live" ? "" : t(dAll).toFixed(2)).padStart(7)}${(rule.id === "live" ? "" : pct(mean(d1))).padStart(9)}${(rule.id === "live" ? "" : pct(mean(d2))).padStart(9)}`);
  }
  void allLive;
}
