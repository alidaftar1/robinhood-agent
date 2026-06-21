import { STOCK_SECTOR, SECTOR_ETFS } from "./market-data";
import type { TradeRun } from "./run-store";

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

export function computeSectorBreakdown(run: TradeRun): SectorSlice[] {
  const byEtf = new Map<string, number>();
  let equity = 0;
  for (const p of run.positions ?? []) {
    const val = parseFloat(p.quantity) * parseFloat(p.price);
    if (!isFinite(val) || val <= 0) continue;
    const etf = STOCK_SECTOR[p.symbol] ?? "OTHER";
    byEtf.set(etf, (byEtf.get(etf) ?? 0) + val);
    equity += val;
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

export function betaDescription(beta: number): string {
  if (beta > 1.1) return "swings more than the market";
  if (beta < 0.9) return "swings less than the market";
  return "roughly tracks the market";
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
