// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION-COST (SLIPPAGE) LEDGER
//
// The only live question that resolves in WEEKS. Portfolio-level performance needs decades —
// SE(IR) = sqrt(252/n) puts "does this beat SPY" at ~43 years, and even the 28-year backtest sits
// at t=1.58. Slippage is the opposite shape: per-fill dispersion is tens of basis points, so ~20
// fills is enough to see a 10bp mean, which is 3 weeks at ~6 buys/week.
//
// It is also currently unmeasured, and the magnitude matters: a persistent 50bp/yr of execution
// cost would swamp anything the ranking logic is arguing about, while being invisible in every
// return number because it is already baked into the fill.
//
// CONVENTION: positive bps = WORSE execution, on BOTH sides. A buy filled above the decision price
// cost money; a sell filled below it cost money. Signing the two sides the same way is what lets
// them be pooled or compared — getting it backwards would make a real cost look like a gain, which
// is the one error that would be acted on.
// ─────────────────────────────────────────────────────────────────────────────

import type { TradeRun, TradeSnapshot } from "./run-store";

export interface Fill {
  date: string;
  symbol: string;
  side: string;
  slippageBps: number;
}

export interface SlippageStats {
  side: "buy" | "sell" | "all";
  fills: number;
  meanBps: number;
  medianBps: number;
  /** Standard error of the mean, in bps — the whole point is knowing when n is enough. */
  seBps: number;
  /** True when the mean is more than 1.96 SE from zero, i.e. distinguishable from no cost. */
  significant: boolean;
  worst: string;
}

/** Positive = worse execution. Null when it cannot be computed rather than 0, which reads as free. */
export function slippageBps(t: TradeSnapshot): number | null {
  const ref = parseFloat(t.refPrice ?? "");
  const fill = parseFloat(t.avgPrice ?? "");
  if (!(ref > 0) || !(fill > 0)) return null;
  const raw = ((fill - ref) / ref) * 10_000;
  // A sell filled BELOW the decision price is the costly direction, so its sign flips.
  return t.side === "sell" ? -raw : raw;
}

/** Every priceable fill across the runs, newest first in whatever order the runs arrive. */
export function collectFills(runs: TradeRun[]): Fill[] {
  const out: Fill[] = [];
  for (const r of runs) {
    for (const t of r.trades ?? []) {
      // `inferred` sells are reconstructed by patchTrades, not observed fills — their avgPrice is a
      // derived estimate, so including them would measure our own arithmetic, not the broker's.
      if (t.state === "inferred") continue;
      // A HUMAN trade is a real fill, but it is not the AGENT's execution. Slippage asks "what did
      // the agent's own order cost against the price it decided on", so the owner's manual fills
      // belong to a different question entirely. They are excluded here EXPLICITLY rather than
      // left to fall out of the missing-refPrice check below: that is an accident of the owner not
      // having a decision price, and the day someone stamps one it would silently start polluting
      // the one measurement that resolves in weeks.
      if (t.actor === "human") continue;
      const bps = slippageBps(t);
      if (bps == null) continue;
      out.push({ date: r.date, symbol: t.symbol, side: t.side, slippageBps: bps });
    }
  }
  return out;
}

function stats(side: SlippageStats["side"], fills: Fill[]): SlippageStats | null {
  if (fills.length === 0) return null;
  const v = fills.map(f => f.slippageBps).sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const median = v[Math.floor(v.length / 2)];
  // Population sd is fine here; with n this small the distinction is noise against the noise.
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const se = v.length > 1 ? sd / Math.sqrt(v.length) : Infinity;
  const worst = fills.reduce((a, b) => (b.slippageBps > a.slippageBps ? b : a));
  return {
    side,
    fills: v.length,
    meanBps: mean,
    medianBps: median,
    seBps: se,
    significant: se !== Infinity && Math.abs(mean) > 1.96 * se,
    worst: `${worst.symbol} ${worst.slippageBps >= 0 ? "+" : ""}${worst.slippageBps.toFixed(0)}bp`,
  };
}

/** Per-side and pooled. Sides are reported separately because they can differ systematically —
 *  buys are sized in dollars and sells are whole positions, so they do not face the same spread. */
export function computeSlippage(runs: TradeRun[]): SlippageStats[] {
  const fills = collectFills(runs);
  return [
    stats("buy", fills.filter(f => f.side === "buy")),
    stats("sell", fills.filter(f => f.side === "sell")),
    stats("all", fills),
  ].filter((s): s is SlippageStats => s !== null);
}
