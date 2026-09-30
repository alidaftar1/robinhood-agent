// Leaf module, no imports. The ⚡NEWS tag is rendered in THREE places — held-position lines
// (lib/strategy), the main shortlist table (lib/market-data) and the influencer candidates
// (lib/influencer-signals) — and until 2026-09-30 each had its own copy of the format string.
// One shared renderer so they cannot drift: the shortlist is where BUY decisions read this, so a
// buy-side tag that means something different from the hold-side tag is the worst version.
//
// Living here rather than in lib/news.ts because that module imports the Anthropic SDK, and
// market-data importing it for one string would pull the SDK in behind it.

/** How far back the news fetch looks. A signal is only visible while its publish date is inside
 *  this rolling window — which is why a catalyst can vanish between two consecutive runs with
 *  nothing about the company having changed. */
export const NEWS_LOOKBACK_DAYS = 5;

export interface NewsTagInput {
  direction: string;
  summary: string;
  /** Publish date of the underlying headline, YYYY-MM-DD. Optional: older cached signals predate
   *  it, and an absent date simply renders the tag as it always was. */
  date?: string;
}

/** Whole days between two YYYY-MM-DD dates; null when either is unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The tag WITHOUT leading whitespace — callers control their own spacing.
 *
 *  Carries the catalyst's AGE, because every rule that accepts ⚡NEWS↑ as a reason frames it as a
 *  FRESH catalyst, and freshness cannot be judged from presence alone. ILMN was kept 2026-09-14 on
 *  a UBS upgrade published 09-09 — its last day inside the window — and sold 09-15 for "no fresh
 *  catalyst" when the window rolled past it, then rose ~21% vs SPY over ten days. */
export function formatNewsTag(n: NewsTagInput | undefined | null, today: string): string {
  if (!n) return "";
  const arrow = n.direction === "+" ? "↑" : n.direction === "-" ? "↓" : "";
  const age = n.date ? daysBetween(n.date, today) : null;
  // A future-dated signal is a data error, not a fresh catalyst — render it undated rather than
  // claiming "-2d ago".
  const ageStr = age == null || age < 0 ? "" : age === 0 ? ", today" : `, ${age}d ago`;
  return `⚡NEWS${arrow}${ageStr} "${n.summary}"`;
}
