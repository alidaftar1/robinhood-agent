// Earnings-date source. Yahoo's chart API stopped returning meta.earningsTimestamp
// (verified absent for all names 2026-07-23), which had silently left the daily
// analysis blind to earnings — the ⚠EARN / ⚠⚠ IMMINENT flags never fired. FMP's
// bulk earnings-calendar is now the primary source, feeding those flags so the
// momentum LLM regains earnings AWARENESS (don't buy into earnings; weigh the risk
// on holdings) — used as information for judgment, not a mechanical forced exit.
//
// Coverage caveat: on the current FMP plan the calendar is strong for large caps
// but misses some mid-caps, and the per-symbol endpoint is premium-locked. Names it
// can't resolve simply won't show the flag (no false signal).

interface FmpEarningsRow {
  symbol: string;
  date: string; // YYYY-MM-DD
}

// symbol → nearest UPCOMING earnings date (YYYY-MM-DD) within `days` ahead.
// Never throws — returns an empty map on any failure so the trade pipeline can't
// break on an earnings-data outage.
export async function fetchUpcomingEarnings(days = 30): Promise<Map<string, string>> {
  const apiKey = process.env.FMP_API_KEY;
  const out = new Map<string, string>();
  if (!apiKey) return out;

  const from = new Date().toISOString().split("T")[0];
  const to = new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0];

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return out;

    const data = await res.json();
    if (!Array.isArray(data)) return out; // FMP returns an error object (not an array) on failure

    for (const row of data as FmpEarningsRow[]) {
      if (!row.symbol || !row.date || row.date < from) continue; // upcoming only
      const prev = out.get(row.symbol);
      if (!prev || row.date < prev) out.set(row.symbol, row.date); // keep the nearest
    }
    return out;
  } catch {
    return out;
  }
}
