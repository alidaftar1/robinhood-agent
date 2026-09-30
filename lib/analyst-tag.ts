// Leaf module, no imports. Same reason lib/news-tag exists: the analyst flag is rendered in the
// shortlist table (lib/market-data) and — from 2026-09-30 — on held-position lines
// (lib/strategy), and two copies of the format string drift.
//
// WHY POSITION LINES NEEDED THIS AT ALL. Analyst actions have their own channel, separate from
// ⚡NEWS: lib/news explicitly EXCLUDES "routine analyst rating/price-target notes" as non-material,
// and lib/analyst collects them with a 7-day cutoff. Until now that channel rendered ONLY in the
// shortlist table — so for a name the book HOLDS but which has fallen off the shortlist, an
// upgrade or a downgrade was invisible in every surface the model reads, while the prompt's
// keep-exceptions explicitly accept "a fresh catalyst (★INS / ⚡↑ / ⚡NEWS↑)" and its sell triggers
// accept "a ↓FIRM downgrade". ILMN was sold 2026-09-14/15 days after a UBS upgrade to Buy with a
// $260 target that the model could not see on its position line; it then rose ~21% vs SPY.

/** THE cutoff: lib/analyst imports this to build its fetch window, so the legend's "last 7 days"
 *  and the filter that enforces it cannot drift apart. Defined in the leaf so the importing
 *  direction stays acyclic (lib/analyst → lib/strategy → lib/analyst-tag, which imports nothing). */
export const ANALYST_LOOKBACK_DAYS = 7;

export interface AnalystTagInput {
  action: string;              // upgrade | downgrade | initiate | raise_pt | lower_pt
  firmShort: string;
  priceTarget?: number;
  pctUpside?: number;
  date: string;                // YYYY-MM-DD
}

/** Whole days between two YYYY-MM-DD dates; null when either is unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The two most recent ratings, newest first, WITHOUT leading whitespace — callers own spacing.
 *
 *  Carries each action's age for the same reason the news tag does: every rule that accepts an
 *  analyst action frames it as a FRESH catalyst or a recent downgrade, and freshness cannot be
 *  judged from presence alone. No "about to expire" warning — that wording argued against bearish
 *  exits and invited pre-emptive selling when it was tried on the news tag. */
export function formatAnalystTag(
  ratings: AnalystTagInput[] | undefined | null,
  today: string,
  max = 2,
): string {
  if (!ratings?.length) return "";
  return [...ratings]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max)
    .map((r) => {
      // NEW COVERAGE gets its own neutral marker. A firm can initiate at Neutral or Underweight,
      // so an initiation is not directional and must never borrow ↑ — nor ⚡, which is a
      // documented escape hatch from loss discipline and the time-stop. See parseAction.
      const arrow = r.action === "initiate" ? "◦NEW " : (r.action === "upgrade" || r.action === "raise_pt" ? "↑" : "↓");
      const pt = r.priceTarget ? `$${r.priceTarget.toFixed(0)}` : "";
      const upside = r.pctUpside != null ? `(${r.pctUpside >= 0 ? "+" : ""}${r.pctUpside.toFixed(0)}%)` : "";
      // ⚡ marks an upgrade with material upside — the same bar the shortlist has always used.
      const impact = r.action === "upgrade" && (r.pctUpside ?? 0) >= 15 ? "⚡" : "";
      const age = daysBetween(r.date, today);
      // A future-dated rating is a data error, not a fresher catalyst — render it undated.
      const ageStr = age == null || age < 0 ? "" : age === 0 ? ", today" : `, ${age}d ago`;
      return `${impact}${arrow}${r.firmShort}${pt}${upside}${ageStr}`;
    })
    // " · ", not " ". Once entries carry ", 5d ago" the space is no longer an unambiguous
    // delimiter — "⚡↑UBS$260(+18%), 5d ago ↓GS$80(-12%), 1d ago" lets a reader attach the wrong
    // age to the wrong action, which is the one field these rules judge freshness on.
    .join(" · ");
}
