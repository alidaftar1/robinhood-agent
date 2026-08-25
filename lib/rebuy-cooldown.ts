// ─────────────────────────────────────────────────────────────────────────────
// ANTI-CHURN RE-BUY COOLDOWN — a code-enforced gate on the main book's buy list.
//
// The book kept selling a name and re-buying it days later at ~the same-or-higher price with no
// new information (measured 2026-08-25: 9 re-entries in 30 runs, ILMN ×3; ROST sold 08-20 then
// re-bought citing earnings dated 08-19 — a "catalyst" that PREDATED the sale). The existing
// ROTATION-CHURN / RE-ENTRY notices only WARN the model; they don't bind. This promotes them to an
// enforced gate: a re-buy of a recently sold/stopped MAIN name is DROPPED unless a catalyst
// (bullish news / analyst upgrade / insider buy) is dated STRICTLY AFTER the exit.
//
// LLM-vs-code boundary: code enforces the invariant (no re-buy without a fresh, dated catalyst);
// the model still decides which names to buy and makes the catalyst case — but a catalyst that
// predates the exit (already public when it sold) can't be rationalized past a date comparison.
// Pure + injected closures so it's unit-testable without market data.
// ─────────────────────────────────────────────────────────────────────────────

export interface CooldownExit {
  symbol: string;
  date: string;              // YYYY-MM-DD of the exit the catalyst must post-date
  kind: "sold" | "stopped";  // discretionary rotation vs −5% stop
}

// Signals available per symbol at buy-decision time. All dates are compared as YYYY-MM-DD
// (zero-padded → lexical order == chronological); a datetime is normalized via slice(0,10).
export interface CatalystInputs {
  news?: { direction: string; summary: string; date?: string };
  analyst?: Array<{ action: string; firmShort?: string; date: string; pctUpside?: number }>;
  insider?: Array<{ filingDate: string }>;
}

const day = (d?: string): string => (d ?? "").slice(0, 10);
// STRICT `>` on the calendar day is deliberate. A catalyst on the SAME day as the exit is not
// counted: `>=` would let a catalyst that was public BEFORE that day's morning sell (e.g. sold on a
// pre-market earnings print, then "re-buy citing the same earnings") slip through — the exact churn
// this gate stops. The cost is a rare false-block of a genuinely-post-fill same-day catalyst, which
// errs safe (the name is eligible again once the cooldown window lapses).

/**
 * A catalyst that is dated STRICTLY AFTER `exitDate`, or null if none. Only genuinely bullish,
 * dated signals count — a bullish ⚡NEWS event, an analyst upgrade / raised price target, or an
 * insider buy. Earnings is deliberately NOT a catalyst here: an earnings *date* isn't a bullish
 * signal, and "I sold on the earnings reaction then re-bought citing the same earnings" is exactly
 * the churn this gate exists to stop.
 */
export function findPostSaleCatalyst(exitDate: string, inp: CatalystInputs): string | null {
  const cut = day(exitDate);
  const after = (d?: string) => day(d) !== "" && day(d) > cut;

  if (inp.news && inp.news.direction === "+" && after(inp.news.date)) {
    return `⚡NEWS↑ ${inp.news.summary} (${day(inp.news.date)})`;
  }
  // Bullish analyst action after the exit. Exclude EXPLICITLY-negative-upside ratings: parseAction
  // (lib/analyst.ts) maps a coverage "initiates"/"initiated" to action="upgrade" regardless of the
  // rating, so an "initiates at Underperform" (PT below price → pctUpside<0) would otherwise pass as
  // a bullish catalyst. Unknown upside (pctUpside==null) still passes — the direction tag stands.
  const up = (inp.analyst ?? []).find(a =>
    (a.action === "upgrade" || a.action === "raise_pt") && after(a.date) && (a.pctUpside == null || a.pctUpside > 0));
  if (up) return `↑FIRM ${up.firmShort ?? ""} ${up.action} (${day(up.date)})`.replace(/\s+/g, " ").trim();

  const ins = (inp.insider ?? []).find(i => after(i.filingDate));
  if (ins) return `★INS insider buy (${day(ins.filingDate)})`;

  return null;
}

/**
 * Drop any MAIN-book buy of a name in cooldown that lacks a post-exit catalyst. Influencer-tagged
 * buys are skipped (they have their own net-floor + downtrend guards, and their exits aren't
 * tracked in the main-book registries). Returns the surviving buys plus human-readable drop notes
 * (surfaced in the run/email like every other buy-sizing adjustment).
 */
export function applyRebuyCooldown<T extends { symbol: string; strategy?: string }>(
  buys: T[],
  isInfluencer: (b: T) => boolean,
  cooldownOf: (symbol: string) => CooldownExit | null,
  catalystOf: (symbol: string, exitDate: string) => string | null,
): { buys: T[]; notes: string[] } {
  const notes: string[] = [];
  const kept = buys.filter(b => {
    // Skip influencer buys via the SAME classification the other buy-path guards use (a strategy tag
    // OR an off-shortlist influencer candidate) — not just the tag — so an untagged influencer pick
    // isn't wrongly subjected to the main-book cooldown (its exits aren't tracked in these registries).
    if (isInfluencer(b)) return true;
    const cd = cooldownOf(b.symbol);
    if (!cd) return true;                          // not recently sold/stopped
    const cat = catalystOf(b.symbol, cd.date);
    if (cat) return true;                          // legit re-entry — a catalyst postdates the exit
    notes.push(`${b.symbol} re-buy BLOCKED — ${cd.kind} ${cd.date}, no new catalyst since (churn)`);
    return false;
  });
  return { buys: kept, notes };
}
