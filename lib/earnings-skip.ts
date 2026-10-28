// ─────────────────────────────────────────────────────────────────────────────
// IMMINENT-EARNINGS SKIP — shortlist backfill + SHADOW measurement (added 2026-10-26)
//
// 1. BACKFILL. The shortlist hands each sector a few slots (lib/sector-cap: Tech 3, most sectors 1)
//    and was filled BEFORE the imminent-earnings no-buy gate ran. In peak earnings season the slots
//    went to names the gate then dropped: 2026-10-26 the Tech slots were MU (held), SNDK and STX
//    (both reporting within 3 days), so DELL/WDC/MRVL — eligible, unblocked — were never shown and
//    the run bought nothing. Now a non-held name with a KNOWN earnings date inside the window is
//    skipped while filling slots, and the next eligible name moves up. Nothing about the gate, the
//    caps or sizing changes: the skipped names were unbuyable today either way.
//
//    FAIL-SAFE DIRECTION. Only `imminent` (a date we HAVE, inside the window) skips a name. A name
//    whose date could not be established keeps its slot and is dropped later by the gate, as
//    before — otherwise an earnings-API outage would empty the shortlist, trip the degenerate-data
//    guard and skip the whole run, risk sells included.
//
// 1b. SERIAL-BEATER EXCEPTION (owner decision 2026-10-28). The blanket rule tested neutral (backtest,
//    2004-2026: skipping vs not, +7.34% vs +7.39%), so the buy side now uses the hold side's own bar:
//    a name with a serial 📈EARN-RECORD (beatClass "serial") is NOT skipped and may be bought into its
//    print. A mixed OR UNKNOWN record (fetch failed, < 2 quarters) is still skipped — fail closed, so a
//    Finnhub outage can only make the rule stricter, never open it.
//
// 2. SHADOW. Whether the rule itself helps is unmeasured: the backtest never modelled it, and the
//    literature's earnings-announcement premium points the other way. So every skipped name is
//    logged with its price; /api/earnings-skip-shadow scores the forward return vs SPY. The rule
//    was RIGHT for a name that then underperformed (it is scored as an EXIT-direction signal: not
//    buying avoided that move). ZERO capital — the log places no orders and changes no behavior.
// ─────────────────────────────────────────────────────────────────────────────
import { screenImminentEarningsBuys, beatClass, type EarningsBeatRecord, type RecentEarnings } from "./earnings";
import type { StockData } from "./market-data";

export interface EarningsLookup {
  upcoming: Map<string, string>;
  upcomingHour: Map<string, string | undefined>;
  recent: Map<string, RecentEarnings>;
  lastReport: Map<string, { date: string; hour?: string }>;
  asked: Set<string>;
}

/** The failure value of a lookup: an EMPTY `asked` means nothing was established, which the buy
 *  gate reads as "unknown → withhold" and the backfill reads as "skip nothing". */
export const emptyEarningsLookup = (): EarningsLookup => ({
  upcoming: new Map(), upcomingHour: new Map(), recent: new Map(), lastReport: new Map(), asked: new Set(),
});

/** Union of lookups over DISJOINT symbol sets (each symbol is asked at most once per run). */
export function mergeEarningsLookups(...parts: EarningsLookup[]): EarningsLookup {
  const out = emptyEarningsLookup();
  for (const p of parts) {
    for (const [k, v] of p.upcoming) out.upcoming.set(k, v);
    for (const [k, v] of p.upcomingHour) out.upcomingHour.set(k, v);
    for (const [k, v] of p.recent) out.recent.set(k, v);
    for (const [k, v] of p.lastReport) out.lastReport.set(k, v);
    for (const k of p.asked) out.asked.add(k);
  }
  return out;
}

export interface EarningsSkipped {
  symbol: string;
  earningsDate: string;
  price: number;
  /** Beat record at skip time (added 2026-10-27), so the shadow can score serial beaters apart from
   *  the rest — the held-side rule already lets a serial beater ride through its print, and whether
   *  the buy side should do the same is unmeasured. Absent = not fetched or Finnhub had < 2 quarters. */
  beat?: EarningsBeatRecord;
}

// beatClass / BeatClass live in lib/earnings (the buy gate uses them too); re-exported for callers.
export { beatClass, type BeatClass } from "./earnings";

/** Attach beat records to skipped names. Pure; a name without a record is left untagged. */
export function tagBeatRecords(skipped: EarningsSkipped[], records: Map<string, EarningsBeatRecord>): EarningsSkipped[] {
  return skipped.map(k => (records.has(k.symbol) ? { ...k, beat: records.get(k.symbol) } : k));
}

/** Bounded: each round can only promote names, and one more round costs a few per-symbol lookups.
 *  Names promoted by the LAST rebuild are not screened here; the buy gate still drops them. */
export const EARNINGS_SKIP_ROUNDS = 3;

/**
 * Build the shortlist, look up earnings for its non-held names, skip any reporting inside the
 * window, rebuild, repeat. `build` is buildV1Shortlist with the run's other options bound;
 * `lookup` is fetchEarningsForSymbols. Returns the final shortlist, the skipped names, the merged
 * lookup and every symbol it ASKED about (so the caller's main lookup does not ask twice).
 */
export async function shortlistAroundEarnings(
  build: (skip: Set<string>) => { buy: StockData[]; retained: StockData[] },
  lookup: (symbols: string[]) => Promise<EarningsLookup>,
  held: Set<string>,
  today: string,
  /** Dates from the bulk calendar, which the buy gate also reads; per-symbol answers override. */
  baseDates: Record<string, string> = {},
  rounds = EARNINGS_SKIP_ROUNDS,
  /** Beat records for imminent names (fetchEarningsBeatHistory). A serial beater keeps its slot.
   *  Absent (or failing) = no exceptions: every imminent name is skipped, as before. */
  beatLookup?: (symbols: string[]) => Promise<Map<string, EarningsBeatRecord>>,
): Promise<{ buy: StockData[]; retained: StockData[]; skipped: EarningsSkipped[]; earnings: EarningsLookup; attempted: Set<string>; serialImminent: Map<string, EarningsBeatRecord>; beats: Map<string, EarningsBeatRecord> }> {
  let earnings = emptyEarningsLookup();
  const attempted = new Set<string>();
  const skipped = new Map<string, EarningsSkipped>();
  const serialImminent = new Map<string, EarningsBeatRecord>();
  const beats = new Map<string, EarningsBeatRecord>();
  const beatAsked = new Set<string>();
  let res = build(new Set());
  for (let r = 0; r < rounds; r++) {
    const cands = res.buy.filter(s => !held.has(s.symbol));
    const need = cands.map(s => s.symbol).filter(s => !attempted.has(s));
    if (need.length) {
      for (const s of need) attempted.add(s);
      earnings = mergeEarningsLookups(earnings, await lookup(need).catch(() => emptyEarningsLookup()));
    }
    // The gate's predicate over the gate's date sources (bulk calendar, overridden per symbol). Only
    // `imminent` skips — `unknown` keeps its slot (see the header).
    const dates = { ...baseDates, ...Object.fromEntries(earnings.upcoming) };
    const { imminent } = screenImminentEarningsBuys(cands, dates, earnings.asked, today);
    const newlyImminent = imminent.filter(s => !skipped.has(s) && !serialImminent.has(s));
    const toAsk = newlyImminent.filter(s => !beatAsked.has(s));
    if (beatLookup && toAsk.length) {
      for (const s of toAsk) beatAsked.add(s);
      const got = await beatLookup(toAsk).catch(() => new Map<string, EarningsBeatRecord>());
      for (const [k, v] of got) beats.set(k, v);
    }
    for (const s of newlyImminent) if (beatClass(beats.get(s)) === "serial") serialImminent.set(s, beats.get(s)!);
    const fresh = newlyImminent.filter(s => !serialImminent.has(s));
    if (!fresh.length) break;
    for (const sym of fresh) {
      const st = cands.find(s => s.symbol === sym)!;
      skipped.set(sym, { symbol: sym, earningsDate: dates[sym], price: st.price });
    }
    res = build(new Set(skipped.keys()));
  }
  return { ...res, skipped: [...skipped.values()], earnings, attempted, serialImminent, beats };
}

// ── Shadow store: append-only daily log (same Upstash REST pattern as lib/giveback-shadow). ──────
const SHADOW_KEY = "robinhood:earnings-skip-shadow";
const SHADOW_MAX_DAYS = 400;

export interface EarningsSkipDay {
  date: string;
  skipped: EarningsSkipped[];
  /** Since 2026-10-28: imminent names KEPT as serial beaters (buyable into the print). Scored as
   *  ENTRY signals (excess vs SPY) while skipped names are EXIT signals (raw forward return), so read
   *  each bucket on its own verdict — they are not one comparable number. Absent on earlier days. */
  kept?: EarningsSkipped[];
}

async function shadowGet(): Promise<EarningsSkipDay[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${SHADOW_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = await res.json() as { result: string | null };
    if (json.result == null) return [];              // no log yet — an empty (not failed) read
    return JSON.parse(json.result) as EarningsSkipDay[];
  } catch { return null; }                            // read FAILED — caller skips the write
}

async function shadowSet(days: EarningsSkipDay[]): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", SHADOW_KEY, JSON.stringify(days.slice(-SHADOW_MAX_DAYS))]]),
    });
    return res.ok;
  } catch { return false; }
}

/** Append today's skipped names. Idempotent per date. FAIL-SAFE — never throws, never clobbers
 *  accumulated history on a failed read: a shadow log must never affect the live trade run. */
export async function recordEarningsSkipShadow(skipped: EarningsSkipped[], today: string, kept: EarningsSkipped[] = []): Promise<{ logged: number; skipped?: boolean }> {
  try {
    const days = await shadowGet();
    if (days === null) return { logged: 0, skipped: true };
    // A same-day re-run whose beat fetch failed must not erase the morning's tags: keep a prior
    // record for any name now logged without one.
    const prior = new Map((days.find(d => d.date === today)?.skipped ?? []).map(k => [k.symbol, k.beat]));
    const tagged = skipped.map(k => (k.beat || !prior.get(k.symbol) ? k : { ...k, beat: prior.get(k.symbol) }));
    // A same-day re-run that kept nothing must not erase the morning's kept names either.
    // ...but a name the re-run SKIPPED (e.g. its record fetch failed) is no longer kept: one name, one list.
    const skippedNow = new Set(skipped.map(k => k.symbol));
    const keptNames = (kept.length ? kept : (days.find(d => d.date === today)?.kept ?? [])).filter(k => !skippedNow.has(k.symbol));
    const day: EarningsSkipDay = { date: today, skipped: tagged, ...(keptNames.length ? { kept: keptNames } : {}) };
    const merged = [...days.filter(d => d.date !== today), day].sort((a, b) => a.date.localeCompare(b.date));
    if (!(await shadowSet(merged))) return { logged: 0, skipped: true };
    return { logged: skipped.length + keptNames.length };
  } catch {
    return { logged: 0, skipped: true };
  }
}

/** Raw read. null = the READ FAILED, distinct from [] = nothing captured yet. */
export async function getEarningsSkipShadowOrNull(): Promise<EarningsSkipDay[] | null> {
  return shadowGet();
}
