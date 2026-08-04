// ── Pre-flight buy sizing ────────────────────────────────────────────────────
// The model sizes buys against an estimated budget, but (a) today's sells settle T+1
// so they DON'T add to today's buying power, (b) the live price ticks above the 7:30am
// thesis estimate, and (c) the broker keeps a small buffer — so a marginal buy gets
// REJECTED and its cash sits idle (GPN squeezed out 07-01 ~$302; TSLA 07-06 ~$405).
// Fix deterministically BEFORE placing orders: reserve a BUFFER, cost each buy with a
// price CUSHION, fit the highest-PER-SHARE-price buys first, keep what fits (shrinking the
// marginal buy rather than losing it) — so settled cash deploys fully and nothing gets
// silently rejected. Pure + dependency-free so it's unit-testable in evals.

export const BUY_BUFFER_PCT = 0.03;   // leave 3% of settled buying power unspent (broker buffer)
export const BUY_PRICE_CUSHION = 1.02; // budget each buy 2% above the thesis price (live tick)

// NOTE: fitBuysToBudget / usableBuyBudget / positionCapQty (below) are the WHOLE-SHARE sizers. The
// live V1 path uses the notional versions (fitNotionalBuysToBudget etc.). These are retained on
// purpose as the one-commit ROLLBACK target for the fractional/notional migration + the whole-share
// FALLBACK math — do not delete. (See docs/plan-fractional-notional-orders.md.)

// The spend limit to hand the ANALYSIS so it never "decides" a buy the pre-flight
// then silently drops (the GOOGL-07-24 case: $322 chosen, dropped for being $0.82
// over the buffered budget, cash left idle). Reserves BOTH the broker buffer and the
// per-buy price cushion up front: a buy set summing to ≤ this (at thesis price)
// survives fitBuysToBudget exactly, so the analysis picks names that actually fit.
export function usableBuyBudget(settledBuyingPower: number): number {
  return (settledBuyingPower * (1 - BUY_BUFFER_PCT)) / BUY_PRICE_CUSHION;
}

export function fitBuysToBudget<T extends { symbol: string; quantity: number; price: number }>(
  buys: T[],
  settledBuyingPower: number,
): { sized: T[]; adjustments: string[] } {
  let budget = settledBuyingPower * (1 - BUY_BUFFER_PCT);
  const sized: T[] = [];
  const adjustments: string[] = [];
  // Fit the highest PER-SHARE price first. A buy's minimum increment is 1 whole share, so a
  // high-per-share name is the one that gets DROPPED entirely (can't shrink below 1 share) and
  // strands the most cash when a cheaper buy claims the budget first — the TSLA-07-06 squeeze
  // ($405 idle) and GPN-07-01. Most-expensive-per-share-first gives the hardest-to-fit
  // indivisible buys first claim; cheaper multi-share buys then shrink to absorb the remainder.
  // NOTE: sort by per-SHARE price, NOT total value — a shrinkable $500 multi-share buy must not
  // outrank a $405 whole-share buy and starve it. Non-finite prices sort last (handled by the
  // unit guard below). Conviction/sleeve intent is deliberately NOT a sort input: that's the
  // model's job upstream (plus the influencer cap, enforced before sizing). This is a last-resort
  // budget fit that optimizes for deploying capital without stranding an indivisible buy.
  const perShare = (b: T) => (isFinite(b.price) ? b.price : -Infinity);
  const ordered = [...buys].sort((a, b) => perShare(b) - perShare(a));
  for (const b of ordered) {
    const unit = b.price * BUY_PRICE_CUSHION;
    if (!(unit > 0)) {
      // No usable price estimate — we can't size it. Let the session try the order as-is, but
      // record it so a downstream broker rejection (or an unbudgeted fill that crowds out later
      // buys) is never silent — the whole point of persisting these adjustments.
      sized.push(b);
      adjustments.push(`${b.symbol} sized as-is — no usable price estimate; not counted against budget (may be rejected or crowd out later buys)`);
      continue;
    }
    const maxQty = Math.floor(budget / unit);
    if (maxQty >= b.quantity) {
      sized.push(b);
      budget -= b.quantity * unit;
    } else if (maxQty >= 1) {
      sized.push({ ...b, quantity: maxQty });
      adjustments.push(`${b.symbol} ${b.quantity}→${maxQty} (shrunk to fit budget)`);
      budget -= maxQty * unit;
    } else {
      // A whole-share buy that can't fit even at qty 1 — dropped, not shrunk. Its budget can't
      // be redeployed deterministically without distorting the thesis/sector mix, so it stays
      // idle and the NEXT run re-evaluates with fresh analysis. Recorded loudly (persisted to
      // the run) so the drop is never silent — the reviewer/email must see it.
      adjustments.push(`${b.symbol} DROPPED — whole share needs ~$${Math.round(unit)} but only $${Math.round(budget)} settled buying power left; ~$${Math.round(unit)} stays idle until the next run re-evaluates`);
    }
  }
  return { sized, adjustments };
}

// Per-position TOP-UP cap: the max NEW shares of `symbol` allowed before existing-holding value +
// new-buy value would exceed `maxPos` (the ~20% per-position cap). Returns 0 if the position is
// already at/over cap (drop the top-up). Pure arithmetic so the buy-time guard is unit-testable.
// Buy-time only — it never implies selling an already-over-cap position.
export function positionCapQty(heldValue: number, buyPrice: number, maxPos: number): number {
  if (buyPrice <= 0) return Infinity; // can't reason without a price → don't block (caller keeps the buy)
  const room = maxPos - heldValue;
  return Math.max(0, Math.floor(room / buyPrice));
}

// ── Notional (dollar_amount) sizing ──────────────────────────────────────────
// With fractional/notional orders the broker fills exact dollars, so there is NO indivisible
// whole-share to strand — the entire idle-cash / dropped-buy problem the whole-share sizer works
// around disappears. These are the notional counterparts used by the V1 notional path.

export const MIN_BUY_DOLLARS = 50; // per-buy floor (avoids dust positions); matches the prompt rule

// Spend limit handed to the ANALYSIS for a notional book: reserve only the broker buffer (no
// whole-share price cushion needed — we specify dollars, not shares, so nothing rounds up).
export function usableNotionalBudget(settledBuyingPower: number): number {
  return settledBuyingPower * (1 - BUY_BUFFER_PCT);
}

// Fit dollar-notional buys to settled buying power. No indivisibility → walk the buys in the
// model's (conviction) order, allot each its full dollarAmount while budget remains, SHRINK the
// marginal buy to the remaining dollars (kept only if ≥ MIN_BUY_DOLLARS, else dropped as dust).
// Deterministic + pure. Unlike the whole-share sizer, a buy is only ever dropped when < the $50
// floor remains — cash deploys down to the last ~$50, never a whole-share remainder.
export function fitNotionalBuysToBudget<T extends { symbol: string; dollarAmount: number }>(
  buys: T[],
  settledBuyingPower: number,
  minBuy: number = MIN_BUY_DOLLARS,
): { sized: T[]; adjustments: string[] } {
  let budget = settledBuyingPower * (1 - BUY_BUFFER_PCT);
  const sized: T[] = [];
  const adjustments: string[] = [];
  for (const b of buys) {
    const want = b.dollarAmount;
    if (!(want > 0)) { adjustments.push(`${b.symbol} skipped — non-positive dollarAmount`); continue; }
    if (budget < minBuy) { adjustments.push(`${b.symbol} DROPPED — only $${budget.toFixed(2)} settled buying power left (< $${minBuy} min)`); continue; }
    if (want <= budget) {
      sized.push(b);
      budget -= want;
    } else {
      // Shrink the marginal buy to the remaining budget (still ≥ min here since budget ≥ minBuy).
      sized.push({ ...b, dollarAmount: Number(budget.toFixed(2)) });
      adjustments.push(`${b.symbol} $${want.toFixed(0)}→$${budget.toFixed(0)} (shrunk to fit budget; no share stranded)`);
      budget = 0;
    }
  }
  return { sized, adjustments };
}

// Per-position TOP-UP cap in DOLLARS: remaining room before existing-holding value + new buy would
// exceed `maxPos`. Returns 0 if already at/over cap. The notional analogue of positionCapQty — no
// floor-to-shares, so the cap is exact. Buy-time only; never implies selling an over-cap position.
export function positionCapDollars(heldValue: number, maxPos: number): number {
  return Math.max(0, maxPos - heldValue);
}

// Resolve a SELL intent to a concrete share-quantity string against the LIVE held quantity. The
// model emits intent (exit:"all" / fraction) — NEVER a raw share count — so it can't mistype and
// over/under-sell. Rules: full exit → the EXACT held string (no float drift, no dust remainder);
// fraction (0<F<1) → held×F trimmed; legacy numeric quantity → clamped to held (never over-sell);
// nothing specified → full exit (safe default). Returns null if nothing is held. Pure + testable.
export function resolveSellQuantity(
  intent: { exit?: string; fraction?: number; quantity?: number },
  heldQtyStr: string,
): string | null {
  const held = parseFloat(heldQtyStr) || 0;
  if (held <= 0) return null;
  // exit:"all" takes precedence over any other field — a full exit must never be down-graded to a
  // trim by a stray/hedged `fraction`.
  if (intent.exit === "all") return heldQtyStr;
  if (intent.fraction != null) {
    // A malformed fraction (≥1, ≤0, NaN) must NOT fall through to a full liquidation — skip it. The
    // model was told 0<F<1; anything else is a mistake we refuse to guess (fail toward inaction).
    if (!(intent.fraction > 0 && intent.fraction < 1)) return null;
    const q = (held * intent.fraction).toFixed(6).replace(/\.?0+$/, "");
    return (parseFloat(q) || 0) > 0 ? q : null;
  }
  if (intent.quantity != null && intent.quantity > 0) return String(Math.min(intent.quantity, held));
  return heldQtyStr; // no intent field at all → full exit (safe default)
}
