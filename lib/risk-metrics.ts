import { STOCK_SECTOR, SECTOR_ETFS } from "./market-data";
import type { TradeRun, TradeSnapshot } from "./run-store";

// ─── Influencer sleeve realized+unrealized P&L (dollars) ─────────────────────────
// The compounded influencer % index can't represent the sleeve honestly: it only starts
// once the sleeve held a position across a day boundary, so a same-day round trip (SPCX,
// bought and stopped out 2026-06-22) never enters it — making the sleeve look far better
// than it did. This computes the sleeve's true realized + unrealized P&L in DOLLARS from a
// cost-basis ledger over every influencer trade, so SPCX's loss is included.

// Known gaps in the stored trade history, corrected from the actual order records. Keep this
// list tiny and documented — each entry is a real fill the run snapshots dropped.
const INFLUENCER_TRADE_CORRECTIONS: Array<{ date: string; symbol: string; side: "buy" | "sell"; quantity: number; price: number }> = [
  // SPCX was bought @ $166 and stopped out @ $154.61 the SAME day (2026-06-22). Only the sell
  // landed in the snapshot, so the buy cost — and the −$11.39 realized loss — was missing.
  { date: "2026-06-22", symbol: "SPCX", side: "buy", quantity: 1, price: 166 },
];

export interface InfluencerPnL {
  realized: number;
  unrealized: number;
  total: number;
  holdings: Array<{ symbol: string; shares: number; avgCost: number; price: number; unrealized: number }>;
}

export function computeInfluencerPnL(runsNewestFirst: TradeRun[]): InfluencerPnL | null {
  const chron = [...runsNewestFirst].reverse(); // oldest → newest

  // REALIZED — cost-basis ledger over influencer buys/sells (closed trades only).
  // A BUY counts only if tagged influencer; a SELL is booked to the sleeve when we hold that
  // symbol in the ledger. That loose sell-match is required because some sells lost their tag
  // (the SPCX stop-out), and it's safe because the trade route keeps main/influencer a strict
  // partition — a symbol is in exactly one sleeve per run, so a ledger symbol's sell IS its sleeve's.
  // Limitation: this only sees trades still inside the getRuns window; a cost basis whose buy has
  // aged out of stored history can't be reconstructed here.
  const ledger = new Map<string, { shares: number; cost: number }>();
  let realized = 0;
  for (const run of chron) {
    const corrections: TradeSnapshot[] = INFLUENCER_TRADE_CORRECTIONS
      .filter(c => c.date === run.date)
      .map(c => ({ side: c.side, symbol: c.symbol, quantity: String(c.quantity), avgPrice: String(c.price), state: "filled", strategy: "influencer" }));
    // Buys before sells within a day so a same-day round trip (SPCX) has a cost basis when its sell lands.
    const trades = [...corrections, ...(run.trades ?? [])].sort((a, b) => (a.side === "buy" ? 0 : 1) - (b.side === "buy" ? 0 : 1));
    for (const t of trades) {
      const qty = parseFloat(t.quantity), px = parseFloat(t.avgPrice);
      if (!isFinite(qty) || !isFinite(px) || qty <= 0) continue;
      const held = ledger.get(t.symbol);
      if (t.side === "buy" && t.strategy === "influencer") {
        const l = held ?? { shares: 0, cost: 0 };
        l.shares += qty; l.cost += qty * px;
        ledger.set(t.symbol, l);
      } else if (t.side === "sell" && held && held.shares > 1e-9) {
        const avg = held.cost / held.shares;
        const s = Math.min(qty, held.shares);
        realized += s * (px - avg);
        held.shares -= s; held.cost -= s * avg;
      }
    }
  }

  // UNREALIZED — snapshot-native from the latest run that actually HELD influencer positions,
  // using the snapshot's own quantity/avgCost/price. This is robust where a ledger would be
  // fragile: a later same-day intraday run with an empty influencer snapshot can't zero it, and
  // it can't drift from a missing/untagged sell (it reads the true current holdings directly).
  const latestHeld = [...chron].reverse().find(r => (r.influencerPositions?.length ?? 0) > 0);
  const holdings: InfluencerPnL["holdings"] = (latestHeld?.influencerPositions ?? [])
    .map(p => {
      const shares = parseFloat(p.quantity), avgCost = parseFloat(p.avgCost), price = parseFloat(p.price);
      return { symbol: p.symbol, shares, avgCost, price, unrealized: shares * (price - avgCost) };
    })
    .filter(h => h.shares > 0 && isFinite(h.unrealized));
  const unrealized = holdings.reduce((s, h) => s + h.unrealized, 0);

  if (ledger.size === 0 && holdings.length === 0) return null;
  return { realized, unrealized, total: realized + unrealized, holdings };
}

// ─── Cash drag ─────────────────────────────────────────────────────────────────
// % of the portfolio sitting in uninvested cash. In an up market this cash earns
// nothing and drags returns below a fully-invested benchmark like SPY.
export function computeCashPct(run: TradeRun): number | null {
  const cash = parseFloat(run.portfolioAfter?.cash ?? "");
  const total = parseFloat(run.portfolioAfter?.totalValue ?? "");
  if (!total || !isFinite(cash) || !isFinite(total) || total <= 0) return null;
  return (cash / total) * 100;
}

// ─── Sector exposure ───────────────────────────────────────────────────────────
// How the invested equity is split across industries. A portfolio concentrated in
// one sector is really a bet on that sector, not pure stock-picking.
export interface SectorSlice {
  etf: string;
  name: string;
  value: number;
  pct: number;
}

// Core grouping — works from any (symbol, dollar value) list.
export function computeSectorSlices(positions: Array<{ symbol: string; value: number }>): SectorSlice[] {
  const byEtf = new Map<string, number>();
  let equity = 0;
  for (const p of positions) {
    if (!isFinite(p.value) || p.value <= 0) continue;
    const etf = STOCK_SECTOR[p.symbol] ?? "OTHER";
    byEtf.set(etf, (byEtf.get(etf) ?? 0) + p.value);
    equity += p.value;
  }
  if (equity <= 0) return [];
  return [...byEtf.entries()]
    .map(([etf, value]) => ({
      etf,
      name: etf === "OTHER" ? "Other / non-S&P" : (SECTOR_ETFS[etf] ?? etf),
      value,
      pct: (value / equity) * 100,
    }))
    .sort((a, b) => b.value - a.value);
}

export function computeSectorBreakdown(run: TradeRun): SectorSlice[] {
  return computeSectorSlices(
    (run.positions ?? []).map((p) => ({ symbol: p.symbol, value: parseFloat(p.quantity) * parseFloat(p.price) }))
  );
}

export const SECTOR_CAP_PCT = 40;

// Renders the current sector mix + a soft-cap nudge for the analysis prompt.
export function formatSectorExposure(slices: SectorSlice[]): string {
  if (slices.length === 0) return "";
  const lines = slices.map((s) => `  • ${s.name}: ${s.pct.toFixed(0)}%`).join("\n");
  const top = slices[0];
  const over = top && top.pct > SECTOR_CAP_PCT
    ? `\n⚠ You are ${top.pct.toFixed(0)}% in ${top.name} — OVER the ${SECTOR_CAP_PCT}% soft cap. Lean toward trimming it and redeploying into an underweight sector, unless you explicitly justify keeping the concentration.`
    : "";
  return `\nSECTOR EXPOSURE (current holdings, by value):\n${lines}${over}\n`;
}

// ─── Beta vs SPY ───────────────────────────────────────────────────────────────
// How hard the portfolio swings relative to the market. beta = cov(agent, spy) /
// var(spy), computed from aligned daily returns. >1 = swings more than SPY, <1 =
// less. Needs several days of data to mean anything — returns the sample size so
// the UI can flag an early/low-confidence estimate.
export function computeBeta(runs: TradeRun[]): { beta: number; n: number } | null {
  const chron = [...runs].reverse(); // oldest → newest
  const pairs: Array<{ a: number; s: number }> = [];
  for (let i = 1; i < chron.length; i++) {
    const agent = chron[i].agenticDailyReturn;
    const spyNow = chron[i].spyPrice;
    const spyPrev = chron[i - 1].spyPrice;
    if (agent == null || !spyNow || !spyPrev) continue;
    pairs.push({ a: agent, s: spyNow / spyPrev - 1 });
  }
  if (pairs.length < 2) return null;
  const meanA = pairs.reduce((x, p) => x + p.a, 0) / pairs.length;
  const meanS = pairs.reduce((x, p) => x + p.s, 0) / pairs.length;
  let cov = 0, varS = 0;
  for (const p of pairs) {
    cov += (p.a - meanA) * (p.s - meanS);
    varS += (p.s - meanS) ** 2;
  }
  if (varS === 0) return null;
  return { beta: cov / varS, n: pairs.length };
}

// ─── Daily alpha win rate ──────────────────────────────────────────────────────
// Fraction of trading days the agent's daily return BEAT SPY's daily return. For a
// SPY-benchmarked agent this is far more meaningful than "% of up days", which at
// daily granularity mostly tracks the market's own up-day frequency rather than any
// skill. Uses the same aligned daily-return pairs as computeBeta (ties = not a win).
export function computeBeatRate(runs: TradeRun[]): { rate: number; n: number } | null {
  const chron = [...runs].reverse(); // oldest → newest
  let wins = 0, n = 0;
  for (let i = 1; i < chron.length; i++) {
    const agent = chron[i].agenticDailyReturn;
    const spyNow = chron[i].spyPrice;
    const spyPrev = chron[i - 1].spyPrice;
    if (agent == null || !spyNow || !spyPrev) continue;
    const spy = spyNow / spyPrev - 1;
    n++;
    if (agent > spy) wins++;
  }
  if (n < 3) return null;
  return { rate: wins / n, n };
}

// Weighted-average β of the CURRENT book vs SPY, using each holding's β from today's
// market data (betaOf). Names not covered — rare, a holding that dropped out of the
// fetched universe — default to 1.0 (market-like) so the estimate stays honest instead
// of silently dropping weight. Returns coverage so a low-confidence estimate can be
// flagged. This is the "how much beta am I already carrying" number the buy decision
// weighs a new position against.
export function computeBookBeta(
  positions: Array<{ symbol: string; value: number }>,
  betaOf: (symbol: string) => number | null | undefined
): { beta: number; coveragePct: number } | null {
  let wSum = 0, bSum = 0, covered = 0;
  for (const p of positions) {
    if (!isFinite(p.value) || p.value <= 0) continue;
    const raw = betaOf(p.symbol);
    // A real β of 0 (uncorrelated) or negative (inverse) is KNOWN and must count as-is;
    // only null/undefined/non-finite (unmeasured) falls back to 1.0 (market-like).
    const known = raw != null && isFinite(raw);
    const b = known ? raw : 1.0;
    if (known) covered += p.value;
    wSum += p.value;
    bSum += b * p.value;
  }
  if (wSum <= 0) return null;
  return { beta: bSum / wSum, coveragePct: (covered / wSum) * 100 };
}

// One-line book-β summary prepended to the risk section of the buy prompt. Empty when
// there are no priced holdings (nothing to compare a new buy against yet).
export function formatBookBeta(book: { beta: number; coveragePct: number } | null): string {
  if (!book) return "";
  const conf = book.coveragePct < 70 ? ` (partial — β known for ${book.coveragePct.toFixed(0)}% of the book)` : "";
  return `\nCURRENT BOOK β vs SPY: ${book.beta.toFixed(2)} — ${betaDescription(book.beta)}${conf}\n`;
}

export function betaDescription(beta: number): string {
  if (beta > 1.1) return "swings more than the market";
  if (beta < 0.9) return "swings less than the market";
  return "roughly tracks the market";
}

// ─── Max drawdown ────────────────────────────────────────────────────────────
// Largest peak-to-trough decline in an indexed value series, as a positive %
// (the depth of the worst drop). The core downside-risk number — comparing the
// agent's vs SPY's answers "when it's bad, how much worse is the agent?"
export function computeMaxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD * 100;
}

// ─── Position concentration ──────────────────────────────────────────────────
// Single-name concentration: how much rides on the biggest position(s). SPY's
// largest single name is ~7%; a concentrated book can be 20%+ in one stock.
export interface Concentration {
  largestSymbol: string;
  largestPct: number;
  topThreePct: number;
  count: number;
}

export function computeConcentration(run: TradeRun): Concentration | null {
  const vals = (run.positions ?? [])
    .map((p) => ({ symbol: p.symbol, value: parseFloat(p.quantity) * parseFloat(p.price) }))
    .filter((p) => isFinite(p.value) && p.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = vals.reduce((s, p) => s + p.value, 0);
  if (total <= 0 || vals.length === 0) return null;
  const topThree = vals.slice(0, 3).reduce((s, p) => s + p.value, 0);
  return {
    largestSymbol: vals[0].symbol,
    largestPct: (vals[0].value / total) * 100,
    topThreePct: (topThree / total) * 100,
    count: vals.length,
  };
}

// ─── T+1 settlement drag ─────────────────────────────────────────────────────
// The cash account can't redeploy sell proceeds until they settle the next trading
// day, so on every rebalance that capital sits idle for ~1 day. The cost of that
// idle day ≈ (capital sold / portfolio) × (market's move over that day). Summed
// across rebalances, it estimates how much the T+1 lockup cost vs a fully-invested
// benchmark. Note: when the market FELL on an idle day, the lockup actually helped
// (avoided a loss) → that day contributes a negative drag. The signed total is the
// honest net effect, not a guaranteed cost.
export function computeT1Drag(runs: TradeRun[]): { dragPct: number; rebalances: number } | null {
  const chron = [...runs].reverse(); // oldest → newest
  let dragPct = 0;
  let rebalances = 0;
  for (let i = 0; i < chron.length - 1; i++) {
    const run = chron[i];
    const next = chron[i + 1];
    const soldValue = (run.trades ?? [])
      .filter((t) => t.side === "sell")
      .reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
    if (!isFinite(soldValue) || soldValue <= 0) continue;
    const total = parseFloat(run.portfolioAfter?.totalValue ?? "");
    if (!isFinite(total) || total <= 0) continue;
    const spyNow = run.spyPrice;
    const spyNext = next.spyPrice;
    if (!spyNow || !spyNext) continue;
    const spyRet = spyNext / spyNow - 1; // market move over the idle day
    dragPct += (soldValue / total) * spyRet * 100;
    rebalances += 1;
  }
  if (rebalances === 0) return null;
  return { dragPct, rebalances };
}

// Capital currently locked in T+1 settlement. Prefer the LIVE-captured unsettled
// (portfolioAfter.unsettledCash = total cash − settled buying power), which is the
// ground truth and includes sells that filled today from a prior run (e.g. a queued
// stop). Fall back to summing this run's sell proceeds only for old runs that didn't
// capture it.
export function computeT1Settling(run: TradeRun): { amount: number; pct: number } | null {
  const stored = parseFloat(run.portfolioAfter?.unsettledCash ?? "");
  const sold = (run.trades ?? [])
    .filter((t) => t.side === "sell")
    .reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
  // Every run now snapshots the LIVE unsettled (total cash − settled buying power) via
  // fetchAgenticBalance — including the intraday stop-loss/earnings runs — so the stored
  // value is the COMPLETE figure (all of today's unsettled proceeds, across runs), and the
  // dashboard passes the latest-by-timestamp run. Use stored directly; only fall back to
  // summing today's recorded sells for old runs that predate live-unsettled capture.
  // (The sell-sum is less accurate — it uses recorded/placeholder prices.)
  const hasStored = isFinite(stored) && stored > 0;
  const amount = hasStored ? stored : sold;
  if (!isFinite(amount) || amount <= 0) return null;
  const total = parseFloat(run.portfolioAfter?.totalValue ?? "") || 0;
  // totalValue already includes the snapshot's unsettled; for an old run with no stored
  // unsettled we added the sell-sum, so add it to the denominator too.
  const trueTotal = hasStored ? total : total + amount;
  return { amount, pct: trueTotal > 0 ? (amount / trueTotal) * 100 : 0 };
}
