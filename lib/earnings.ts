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

function windowDates(days: number): { from: string; to: string } {
  return {
    from: new Date().toISOString().split("T")[0],
    to: new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0],
  };
}

// Keep the nearest UPCOMING date per symbol as we merge sources.
function addNearest(out: Map<string, string>, symbol: string, date: string, from: string) {
  if (!symbol || !date || date < from) return; // upcoming only
  const prev = out.get(symbol);
  if (!prev || date < prev) out.set(symbol, date);
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
export async function fetchEarningsForSymbols(symbols: string[], days = 30, lookbackDays = 7): Promise<{ upcoming: Map<string, string>; recent: Map<string, RecentEarnings> }> {
  const upcoming = new Map<string, string>();
  const recent = new Map<string, RecentEarnings>();
  const key = process.env.FINNHUB_API_KEY;
  const uniq = [...new Set(symbols)].filter(Boolean);
  if (!key || uniq.length === 0) return { upcoming, recent };
  const today = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().split("T")[0];
  const to = new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0];
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
        let best: string | null = null, bestHour: string | undefined; // most-recent PAST report (< today)
        for (const row of data.earningsCalendar ?? []) {
          if (row.symbol !== sym || !row.date) continue;
          addNearest(upcoming, row.symbol, row.date, today); // nearest date >= today
          if (row.date < today && (!best || row.date > best)) { best = row.date; bestHour = row.hour; }
        }
        if (best) recent.set(sym, { date: best, daysAgo: earningsDaysAgo(best, bestHour, today) });
      } catch { /* fail-safe per symbol */ }
    }));
  }
  return { upcoming, recent };
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
