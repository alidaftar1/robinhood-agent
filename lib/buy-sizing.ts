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

// ── Per-position cap enforcement (cumulative holdings, not per-order) ────────
// The $maxPos per-position cap (max(400, 20% of book), lib/strategy.ts) is stated to the
// model as "Max $X per position" but is only operationalized in-prompt as a PER-BUY check
// (max_qty = floor(maxPos / price)) that treats every buy as if starting from ZERO shares.
// So when the model TOPS UP a name it already holds, the per-buy check passes trivially
// (1 extra share ≪ max_qty) while the CUMULATIVE position drifts past the cap — nothing
// deterministic ever counts the existing shares. Observed: APA topped up 07-13 (→~$550) and
// 07-14 (→~$585) past the $490 cap (~24% of a $2,454 book vs the 20% intent), uncaught.
//
// This clamps each buy so (existing $held + new shares) ≤ maxPositionDollars, using the SAME
// dollar cap the prompt already states — it does NOT change the cap or force a trim; it only
// refuses to ADD to a name already at/over its per-name limit (shrinking a top-up, or dropping
// it if there's zero headroom). Fresh positions (0 held) behave exactly like the prompt's
// existing max_qty rule. Pure + dependency-free so it's unit-testable. Run BEFORE fitBuysToBudget
// (cap the name first, then fit what's left into settled buying power).
export function capBuysToPositionLimit<T extends { symbol: string; quantity: number; price: number }>(
  buys: T[],
  heldValueBySymbol: Map<string, number>,
  maxPositionDollars: number,
): { sized: T[]; adjustments: string[] } {
  const sized: T[] = [];
  const adjustments: string[] = [];
  // Track value committed per symbol as we go (existing held + accepted new shares) so
  // repeated buys of the same name within one decision can't collectively breach the cap.
  const committed = new Map(heldValueBySymbol);
  const cap = Math.round(maxPositionDollars);
  for (const b of buys) {
    if (!(b.price > 0) || !(maxPositionDollars > 0)) {
      sized.push(b); // no usable price / cap → can't clamp; leave to the budget fit + broker
      continue;
    }
    const held = committed.get(b.symbol) ?? 0;
    const headroom = maxPositionDollars - held;
    const maxAddQty = Math.floor(headroom / b.price);
    if (maxAddQty >= b.quantity) {
      sized.push(b);
      committed.set(b.symbol, held + b.quantity * b.price);
    } else if (maxAddQty >= 1) {
      sized.push({ ...b, quantity: maxAddQty });
      adjustments.push(`${b.symbol} ${b.quantity}→${maxAddQty} (capped: ~$${Math.round(held)} already held, $${cap} per-name limit)`);
      committed.set(b.symbol, held + maxAddQty * b.price);
    } else {
      adjustments.push(`${b.symbol} DROPPED — position already at the $${cap} per-name cap (~$${Math.round(held)} held); top-up would breach it`);
    }
  }
  return { sized, adjustments };
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
