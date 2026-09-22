// Earnings-date source. Yahoo's chart API stopped returning meta.earningsTimestamp
// (verified absent for all names 2026-07-23), which had silently left the daily
// analysis blind to earnings — the ⚠EARN / ⚠⚠ IMMINENT flags never fired.
//
// PRIMARY source is now FINNHUB (2026-07-31): its earnings calendar covers the whole
// universe INCLUDING the mid-caps FMP misses — the FMP-only backfill left PLTR (reporting
// in 3 days) unflagged, so the earnings judgment never activated on a held name. Finnhub's
// /calendar/earnings returns the entire market in one call. FMP is kept as a secondary
// backstop; the two are unioned, nearest upcoming date wins. Fail-safe: any source that
// errors just contributes nothing (a name we can't resolve shows no flag — no false signal).

interface FmpEarningsRow { symbol: string; date: string }
interface FinnhubEarningsRow { symbol: string; date: string; hour?: string }

// Days since the market could REACT to a report. An AMC (after-close) report is digested the NEXT
// session, so "how fresh" should count from the reaction day (date+1), not the announcement day; BMO
// (before-open) and unspecified are same-day. (Weekend edge deliberately ignored — a rough freshness
// indicator for an advisory flag.) e.g. PLTR reported 08-03 amc, reacted 08-04 → 2d ago on 08-06, not 3.
export function earningsDaysAgo(date: string, hour: string | undefined, today: string): number {
  const effectiveMs = Date.parse(date) + (hour === "amc" ? 86_400_000 : 0);
  return Math.round((Date.parse(today) - effectiveMs) / 86_400_000);
}

/** Has a name scheduled for `date` already printed, as of a mid-session run on `today`?
 *  Only "amc" is treated as not-yet-printed: it lands after the close, so on the day itself the
 *  price has not moved and the pre-print figures are still the right ones to show. "dmh" (during
 *  market hours) is deliberately counted as PRINTED even though a 13:00 ET print has not happened
 *  at a 10:30 ET run — the two errors are not symmetric. Calling a printed name unprinted serves a
 *  post-print price over pre-print earnings (a confident wrong number); calling an unprinted name
 *  printed merely suppresses a P/E for a few hours. dmh is rare; take the lossy side. */
export function hasPrintedBySession(date: string, hour: string | undefined, today: string): boolean {
  if (date < today) return true;
  if (date > today) return false;
  return hour !== "amc";
}

function windowDates(days: number): { from: string; to: string } {
  return {
    from: new Date().toISOString().split("T")[0],
    to: new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0],
  };
}

// Keep the nearest UPCOMING date per symbol as we merge sources.
function addNearest(out: Map<string, string>, symbol: string, date: string, from: string, hours?: Map<string, string | undefined>, hour?: string) {
  if (!symbol || !date || date < from) return; // upcoming only
  const prev = out.get(symbol);
  if (!prev || date < prev) { out.set(symbol, date); hours?.set(symbol, hour); return; }
  // Same date seen twice (Finnhub emits an estimate row AND a confirmed row). Let a later row fill
  // in an hour the first one left blank — otherwise a blank-then-"amc" pair reads as already
  // printed and suppresses a P/E that is still correct until the close.
  if (date === prev && hour && !hours?.get(symbol)) hours?.set(symbol, hour);
}

// Finnhub earnings calendar — whole market in one call. Never throws.
async function fetchFinnhubEarnings(out: Map<string, string>, from: string, to: string): Promise<void> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return;
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return;
    const data = await res.json() as { earningsCalendar?: FinnhubEarningsRow[] };
    for (const row of data.earningsCalendar ?? []) addNearest(out, row.symbol, row.date, from);
  } catch { /* fail-safe */ }
}

// FMP earnings calendar (secondary backstop). Never throws.
async function fetchFmpEarnings(out: Map<string, string>, from: string, to: string): Promise<void> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return;
  try {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return; // FMP returns an error object on failure
    for (const row of data as FmpEarningsRow[]) addNearest(out, row.symbol, row.date, from);
  } catch { /* fail-safe */ }
}

// symbol → nearest UPCOMING earnings date (YYYY-MM-DD) within `days` ahead, from Finnhub ∪ FMP.
// BULK backfill for broad coverage — BUT the Finnhub bulk calendar caps at 1500 rows and, in peak
// earnings season, that truncation drops the NEAREST dates (verified 2026-07-31: PLTR 08-03 / APA
// 08-05 were cut, ROST 08-19 kept). So the bulk is unreliable for imminent names — use
// fetchEarningsForSymbols() for the shortlist + held names that actually drive the ⚠⚠ judgment.
export async function fetchUpcomingEarnings(days = 30): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { from, to } = windowDates(days);
  await Promise.all([fetchFinnhubEarnings(out, from, to), fetchFmpEarnings(out, from, to)]);
  return out;
}

/** A name that just REPORTED earnings — the backward-looking companion to the ⚠EARN (upcoming)
 *  flag. Surfaced on every decision surface so a buy/hold/sell can SEE that a print just landed. */
export interface RecentEarnings { date: string; daysAgo: number }

// PER-SYMBOL earnings (Finnhub) for a specific set — reliable near-term coverage the bulk cap drops.
// ONE call per symbol over a window [today-lookback, today+days] yields BOTH the nearest UPCOMING
// date (⚠EARN) AND the most-recent PAST report (📊REPORTED) — so we never fetch the same symbol
// twice. Batched to respect the free-tier rate limit. Fail-safe: a symbol that errors is just absent.
/** Normalise a third-party report date for use as a SUPPRESSION key.
 *
 *  Fail-CLOSED by construction, and the direction is the whole point: downstream,
 *  `pointsIncludeReport(points, undefined)` returns TRUE and PUBLISHES the multiple, so dropping a
 *  date we cannot read does not suppress the name — it un-suppresses it. Anything unreadable must
 *  therefore come back NON-FALSY, so it survives to fail Date.parse and withhold the P/E.
 *
 *  Also bounded: the result is interpolated into the live-money prompt, so an unbounded vendor
 *  string must never reach it. Returns either a 10-char ISO date or the literal "unparseable".
 *
 *  I got this backwards twice in one session, in both directions, while believing each version was
 *  the safety fix. If you are about to change it, the invariant is: NEVER return something falsy,
 *  and never return something Date.parse can read unless it is genuinely the report date. */
export function normalizeReportDate(raw: unknown): string {
  const trimmed = String(raw ?? "").slice(0, 10);   // "2026-09-15T00:00:00" -> "2026-09-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // Observable on purpose: if the vendor ever changes format (single-digit months, say), EVERY
  // reported name suppresses at once and the only trace would be "(reported unparseable)" buried
  // in the prompt. This file's whole doctrine is that silent degradation is the real failure.
  console.warn("EARNINGS_REPORT_DATE_UNPARSEABLE — suppressing this name's P/E", { raw: String(raw ?? "").slice(0, 40) });
  return "unparseable";
}

/** How recent a print must be to earn the 📊REPORTED flag — independent of how far back we LOOK. */
export const RECENT_FLAG_DAYS = 7;

/** Split the most-recent PAST report into its two horizons. Pure and exported because these two
 *  were one number until the valuation guard needed a 60-day window while 📊REPORTED had to stay a
 *  7-day flag: `last` drives P/E suppression (the 10-Q lands 23-38 days after the press release, so
 *  a 7-day guard expires weeks before the filing that resolves it), `recent` drives the display
 *  flag on the shortlist, influencer, and held tables. Widening the fetch window must never widen
 *  `recent` — that is the regression this function exists to pin. */
export function selectPastReport(
  rows: FinnhubEarningsRow[], symbol: string, today: string, recentCutoff: string,
): { last?: { date: string; hour?: string }; recent?: RecentEarnings } {
  let best: string | null = null, bestHour: string | undefined; // most-recent PAST report (< today)
  for (const row of rows) {
    if (row.symbol !== symbol || !row.date) continue;
    if (row.date < today && (!best || row.date > best)) { best = row.date; bestHour = row.hour; }
  }
  if (!best) return {};
  const out: { last?: { date: string; hour?: string }; recent?: RecentEarnings } = {
    last: { date: best, hour: bestHour },
  };
  if (best >= recentCutoff) out.recent = { date: best, daysAgo: earningsDaysAgo(best, bestHour, today) };
  return out;
}

export async function fetchEarningsForSymbols(symbols: string[], days = 30, lookbackDays = 60): Promise<{ upcoming: Map<string, string>; upcomingHour: Map<string, string | undefined>; recent: Map<string, RecentEarnings>; lastReport: Map<string, { date: string; hour?: string }> }> {
  const upcoming = new Map<string, string>();
  // Session timing for the nearest upcoming date. A name printing TODAY has only gapped if it
  // printed BEFORE the open — an "amc" name has not reported yet when the 10:30 ET cron runs, so
  // its pre-print EPS still matches its pre-print price. Same amc convention as earningsDaysAgo.
  const upcomingHour = new Map<string, string | undefined>();
  // The most recent PAST report over the WHOLE lookback, which is now much wider than the 7-day
  // 📊REPORTED flag. Valuation needs the wide one: the 10-Q lands 23-38 days after the press
  // release, so a 7-day window stops suppressing a pre-print P/E weeks before the filing that
  // would fix it — the guard expiring reintroduces exactly the failure it exists to prevent.
  const lastReport = new Map<string, { date: string; hour?: string }>();
  const recent = new Map<string, RecentEarnings>();
  const key = process.env.FINNHUB_API_KEY;
  const uniq = [...new Set(symbols)].filter(Boolean);
  if (!key || uniq.length === 0) return { upcoming, upcomingHour, recent, lastReport };
  const today = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().split("T")[0];
  const to = new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0];
  const recentCutoff = new Date(Date.now() - RECENT_FLAG_DAYS * 86_400_000).toISOString().split("T")[0];
  const BATCH = 10; // well under Finnhub's 60/min
  for (let i = 0; i < uniq.length; i += BATCH) {
    await Promise.all(uniq.slice(i, i + BATCH).map(async sym => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/calendar/earnings?symbol=${sym}&from=${from}&to=${to}&token=${key}`,
          { signal: AbortSignal.timeout(6000) },
        );
        if (!res.ok) return;
        const data = await res.json() as { earningsCalendar?: FinnhubEarningsRow[] };
        for (const row of data.earningsCalendar ?? []) {
          if (row.symbol !== sym || !row.date) continue;
          addNearest(upcoming, row.symbol, row.date, today, upcomingHour, row.hour); // nearest date >= today
        }
        const past = selectPastReport(data.earningsCalendar ?? [], sym, today, recentCutoff);
        if (past.last) lastReport.set(sym, past.last);
        if (past.recent) recent.set(sym, past.recent);
      } catch { /* fail-safe per symbol */ }
    }));
  }
  return { upcoming, upcomingHour, recent, lastReport };
}

// Shared render for the "just reported" flag, used on the shortlist, influencer, and held surfaces.
// Shows recency + the single-day (and, when available, 5-day) reaction so a post-earnings gap is
// visible to every decision. change values optional — render what the surface has.
export function formatPostEarnings(r: RecentEarnings, change1d?: number | null, change5d?: number | null): string {
  const parts: string[] = [];
  if (change1d != null) parts.push(`1d ${change1d >= 0 ? "+" : ""}${change1d.toFixed(0)}%`);
  if (change5d != null) parts.push(`5d ${change5d >= 0 ? "+" : ""}${change5d.toFixed(0)}%`);
  const moves = parts.length ? ` (${parts.join(", ")})` : "";
  return `  📊REPORTED ${r.daysAgo}d ago${moves}`;
}

/** A name's recent earnings-surprise track record — the base rate for "beat vs coin flip"
 *  when deciding whether to ride a HELD name through its earnings (PEAD favors serial beaters). */
export interface EarningsBeatRecord { beats: number; total: number; avgSurprisePct: number }

/**
 * The 📈EARN-RECORD tag, rendered identically wherever a name carries a beat record — held position
 * lines, the main shortlist, and the influencer candidate rows. One formatter because the prompt
 * teaches ONE reading of the tag ("beat ≥3/4, avg ≥ +5% = serial beater"); if the three call sites
 * drifted apart, that rule would mean different things in different tables.
 */
export function formatEarningsRecord(beat: EarningsBeatRecord | undefined): string {
  if (!beat) return "";
  // Round first so the sign reflects the number actually shown (no "-0%").
  const avgPct = Math.round(beat.avgSurprisePct);
  return `  📈EARN-RECORD beat ${beat.beats}/${beat.total}, avg ${avgPct >= 0 ? "+" : ""}${avgPct}% surprise`;
}

// Earnings-surprise history (Finnhub) for a set of symbols — how many of the last ~8 quarters the
// company BEAT estimates, and by how much on average. Feeds the earnings hold-judgment so a serial
// beater (e.g. PLTR: 4/4, +15% avg) reads as a ride-through candidate, not a coin flip. Fail-safe.
export async function fetchEarningsBeatHistory(symbols: string[]): Promise<Map<string, EarningsBeatRecord>> {
  const out = new Map<string, EarningsBeatRecord>();
  const key = process.env.FINNHUB_API_KEY;
  const uniq = [...new Set(symbols)].filter(Boolean);
  if (!key || uniq.length === 0) return out;
  const BATCH = 10;
  for (let i = 0; i < uniq.length; i += BATCH) {
    await Promise.all(uniq.slice(i, i + BATCH).map(async sym => {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${key}`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const data = await res.json() as Array<{ surprisePercent?: number; period?: string }>;
        if (!Array.isArray(data)) return;
        // Finnhub returns newest-first, but sort by period desc defensively so a reorder can never
        // feed the OLDEST 8 quarters (a stale base rate) into a live ride-through decision.
        const recent = [...data]
          .sort((a, b) => (b.period ?? "").localeCompare(a.period ?? ""))
          .slice(0, 8)
          .filter(e => typeof e.surprisePercent === "number");
        if (recent.length < 2) return; // need a couple of quarters for a meaningful record
        const beats = recent.filter(e => (e.surprisePercent as number) > 0).length;
        const avg = recent.reduce((s, e) => s + (e.surprisePercent as number), 0) / recent.length;
        out.set(sym, { beats, total: recent.length, avgSurprisePct: avg });
      } catch { /* fail-safe per symbol */ }
    }));
  }
  return out;
}
