// Leaf module ON PURPOSE — no imports, for the same reason as lib/position-target: the shortlist
// builder (lib/market-data), the buy-time budget (app/api/trade -> lib/buy-sizing) and the prompt
// (lib/strategy) all need it, and the two gates must read ONE rule or they will disagree.

/**
 * MAIN-BOOK SECTOR CAP: a sector may hold at most 3x its S&P 500 weight (min 1 name, max 3).
 *
 * Replaced the flat 40% cap on 2026-10-23 (owner decision), from
 * `bun scripts/sector-cap-backtest.ts` — 1999-2026, 6 names, historical sectors for every variant,
 * identical data/rules/costs; only the sector limit differed:
 *
 *      rule            CAGR   Sharpe    IR   maxDD   1999-2012 vs SPY   2013-2026 vs SPY
 *      flat (2/sector) +8.14%   0.41   0.10  -83.9%       -5.43%             +5.32%
 *      SPY + 15pp      +8.18%   0.42   0.09  -73.4%       -3.18%             +2.64%
 *      3x SPY         +11.78%   0.51   0.25  -84.4%       -4.31%            +12.13%   <- adopted
 *      SPY-matched     +3.48%   0.27  -0.13  -79.4%       -8.42%             -1.36%
 *      SPY             +8.68%   0.53     —   -55.2%
 *
 * RE-RUN AT THE LIVE SIZE, 7 names (`--n 7 --only count-2,3x-spy`), and the picture is weaker:
 *
 *      rule            CAGR   Sharpe    IR   maxDD   yrs>SPY   1999-2012 vs SPY   2013-2026 vs SPY
 *      flat (2/sector) +9.01%   0.45   0.13  -77.3%   18/28       -2.54%             +3.68%
 *      3x SPY         +12.08%   0.52   0.26  -83.5%   17/28       -3.98%            +12.38%
 *
 * At 6 names 3x-SPY beat the flat cap in both halves; at 7 it LOSES 1999-2012 and its whole edge is
 * the tech-led 2013-2026 half, with a ~6pp deeper drawdown. The owner chose it on 2026-10-23 knowing
 * that: it is, in effect, a bet that a tech-heavy book keeps paying.
 *
 * TECH LOWERED TO 3 NAMES (60%) on 2026-10-24 (owner decision: 80% in one sector was too much), from
 * `--n 7 --only count-2,3x-spy,3x-spy-max3` — the 4th Tech name bought ~0.65pp/yr for ~6pp of drawdown:
 *
 *      rule              CAGR   Sharpe    IR   maxDD   yrs>SPY   1999-2012 vs SPY   2013-2026 vs SPY
 *      flat (2/sector)  +9.01%   0.45   0.13  -77.3%   18/28       -2.54%             +3.68%
 *      3x SPY, max 4   +12.08%   0.52   0.26  -83.5%   17/28       -3.98%            +12.38%
 *      3x SPY, max 3   +11.43%   0.52   0.23  -77.5%   17/28       -2.89%             +9.51%   <- live
 *
 * (The backtest's max 3 binds every sector; at today's weights only Tech reaches it, historically
 * Financials did too around 2006.) Still a tech-tilted bet, just a smaller one: if tech leadership
 * ends, this rule concentrates the book in the wrong place — revisit then. Further limits of the evidence: few
 * rules on one 28-year path (the best is partly luck); no LLM layer; and the strategy lost to SPY in
 * 1999-2012 under EVERY rule, so the sector rule is not the strategy's main risk.
 *
 * WHAT IT DOES TO THE BOOK: big sectors loosen, everything else tightens. At 7 names, Technology may
 * hold 3 names; Financials and Health Care 2; every other sector 1. In DOLLARS a sector gets that
 * many full positions (FULL_POSITION_FRACTION, 20% of the book): 60% / 40% / 20%. So a
 * sector the market barely holds (Energy, 3.7%) can no longer become 40% of this one.
 *
 * The backtest is equal-weight by name; live adds the dollar budget (one name = one full position),
 * which the backtest never modelled.
 *
 * BUY-SIDE ONLY, like the cap it replaces: it bounds the shortlist and new money, and never forces a
 * sale. A sector already over its cap (Energy at ~40% when this shipped) just stops receiving buys.
 */

/** S&P 500 sector weights by SPDR sector ETF (GICS), from State Street's SPY sector breakdown as
 *  of the date below. A dated constant, not a live fetch: weights drift slowly, a scrape would be
 *  a new way for the buy path to break, and a stale table fails mildly (caps a few points off).
 *  Refresh from https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy */
export const SPY_SECTOR_WEIGHTS_ASOF = "2026-10-22";
export const SPY_SECTOR_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  XLK: 0.3757,   // Information Technology
  XLF: 0.1208,   // Financials
  XLV: 0.0994,   // Health Care
  XLC: 0.0923,   // Communication Services
  XLY: 0.0896,   // Consumer Discretionary
  XLI: 0.0803,   // Industrials
  XLP: 0.0495,   // Consumer Staples
  XLE: 0.0373,   // Energy
  XLU: 0.0204,   // Utilities
  XLRE: 0.0175,  // Real Estate
  XLB: 0.0170,   // Materials
});

export const SECTOR_CAP_MULTIPLE = 3;
/** Hard per-sector bound on top of the 3x rule (Tech at 3x alone would be ~113%). 3, not the first
 *  rule's 4: lowered 2026-10-24 by the owner and re-backtested at that value (header table). */
export const SECTOR_MAX_NAMES = 3;

/** Most names a sector may hold in an N-name book. A sector missing from the table (or `?`) gets
 *  the minimum, 1 — the strictest reading, never an uncapped one. */
export function sectorMaxNames(sector: string, n: number): number {
  const w = SPY_SECTOR_WEIGHTS[sector] ?? 0;
  return Math.min(SECTOR_MAX_NAMES, Math.max(1, Math.floor(SECTOR_CAP_MULTIPLE * w * n + 1e-9)));
}

/** One full position as a share of the book: the PERCENTAGE half of the per-position cap
 *  (lib/strategy maxPositionDollars = max($400, floor(20% x total))). Deliberately a fixed fraction,
 *  NOT maxPositionDollars/total: that ratio inherits the $400 floor, so on a shrinking account
 *  (after ~15% losses) every sector budget would silently LOOSEN — Tech past 100% — exactly when
 *  losses are largest. And since floor(0.2 x total) <= 0.2 x total, a full-size buy always fits. */
export const FULL_POSITION_FRACTION = 0.2;

/** The same rule in DOLLARS, as a fraction of the book: one full position per allowed name. Derived
 *  from sectorMaxNames so the shortlist and the buy-time budget cannot disagree — and one POSITION
 *  per name, not 1/N, so the single name a 1-name sector may hold can be bought at full size (1/7 =
 *  14% sat under the 20% position cap and trimmed every such buy). */
export function sectorBudgetFraction(sector: string, n: number): number {
  return sectorMaxNames(sector, n) * FULL_POSITION_FRACTION;
}

/** The SELL-side soft nudge (risk-metrics formatSectorExposure): a sector over this share of the
 *  INVESTED book is nudged toward a trim. Defined here so there is one 40%. */
export const SOFT_TRIM_PCT = 40;

/** SELL-side soft-nudge threshold for a sector: the long-standing 40%, raised to the sector's buy
 *  budget where that is higher (only Technology today, 60%), so the nudge does not sit far below what the
 *  buy gate allows. NOT an exact match: the nudge is a share of INVESTED value, the budget a share of
 *  the WHOLE book incl. cash (the same pre-existing base mismatch the flat 40% had), so with cash on
 *  hand the two can still disagree by the cash share. Never LOWERED: tightening the buy cap does not
 *  turn into new sell pressure. */
export function sectorSoftTrimPct(sector: string, n: number): number {
  return Math.max(SOFT_TRIM_PCT, sectorBudgetFraction(sector, n) * 100);
}

/** Display names — must equal lib/market-data SECTOR_ETFS (pinned by evals/sector-budget.test.ts),
 *  which the SECTOR EXPOSURE block uses, so one prompt never calls a sector two names. Copied rather
 *  than imported because this module must stay a leaf (see top). */
const SECTOR_NAMES: Readonly<Record<string, string>> = {
  XLK: "Technology", XLC: "Comm Svcs", XLF: "Financials", XLV: "Health Care", XLI: "Industrials",
  XLY: "Cons Discret", XLP: "Cons Staples", XLE: "Energy", XLB: "Materials", XLRE: "Real Estate",
  XLU: "Utilities",
};
export const SECTOR_DISPLAY_NAMES = SECTOR_NAMES;

/** One line for the analysis prompt, generated from the rule so the words cannot drift from it. */
export function sectorCapSummary(n: number): string {
  const groups = new Map<number, string[]>();
  for (const sec of Object.keys(SPY_SECTOR_WEIGHTS)) {
    const k = sectorMaxNames(sec, n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(SECTOR_NAMES[sec] ?? sec);
  }
  const min = Math.min(...groups.keys());
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([k, names]) =>
    `${k === min ? "every other sector" : names.join(", ")} ≤${k} name${k === 1 ? "" : "s"} (${k} full position${k === 1 ? "" : "s"})`,
  ).join("; ");
}
