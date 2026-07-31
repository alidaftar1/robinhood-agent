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
interface FinnhubEarningsRow { symbol: string; date: string }

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

// PER-SYMBOL earnings (Finnhub) for a specific set — reliable near-term coverage the bulk cap drops.
// Batched to respect the free-tier rate limit. Fail-safe: a symbol that errors just isn't in the map.
export async function fetchEarningsForSymbols(symbols: string[], days = 30): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const key = process.env.FINNHUB_API_KEY;
  const uniq = [...new Set(symbols)].filter(Boolean);
  if (!key || uniq.length === 0) return out;
  const { from, to } = windowDates(days);
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
        for (const row of data.earningsCalendar ?? []) addNearest(out, row.symbol, row.date, from);
      } catch { /* fail-safe per symbol */ }
    }));
  }
  return out;
}
