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

// Enforce the per-position dollar cap across a set of buys — trimming each to its remaining
// headroom (existing-holding value + new-buy value ≤ maxPos), or dropping it if there's no
// meaningful room left. Applies to EVERY buy regardless of strategy tag: the influencer sleeve
// caps the number of names but had no per-position dollar ceiling, so a single influencer buy —
// or a shortlist name laundered through strategy:"influencer" — could take ~the whole book past
// the cap (security audit 2026-08-18, finding [3]). Buy-time only: it stops a breach GROWING, it
// never force-sells an already-over-cap position. Extra fields on each buy are preserved.
export function applyPerPositionCap<T extends { symbol: string; dollarAmount: number }>(
  buys: T[],
  maxPos: number,
  heldValueOf: (symbol: string) => number,
): { buys: T[]; notes: string[] } {
  const notes: string[] = [];
  const capped = buys.flatMap((b): T[] => {
    const room = positionCapDollars(heldValueOf(b.symbol), maxPos); // exact $ headroom, no floor-to-shares
    if (b.dollarAmount <= room) return [b];                          // within cap — untouched
    if (room < MIN_BUY_DOLLARS) {                                    // no meaningful room — drop the top-up
      notes.push(`${b.symbol} buy DROPPED — position already at/over the $${maxPos.toFixed(0)} cap`);
      return [];
    }
    notes.push(`${b.symbol} buy trimmed $${b.dollarAmount.toFixed(0)}→$${room.toFixed(0)} — would exceed the $${maxPos.toFixed(0)} per-position cap`);
    return [{ ...b, dollarAmount: Number(room.toFixed(2)) }];
  });
  return { buys: capped, notes };
}

// ── Sector budget, across BOTH sleeves (risk control) ─────────────────────────────────────────
// THE GAP THIS CLOSES. "40% sector cap" was enforced as <=floor(0.4*N) BUYABLE NAMES per sector
// inside buildV1Shortlist, which has three holes: it is a name COUNT standing in for a value cap,
// it ignores what is already HELD ("◆HELD rows may sit outside the sector cap because they're
// already in the book"), and it only sees the MAIN shortlist. The influencer sleeve picks on a
// YouTube signal with no sector awareness and has its own 2 slots, so two individually-compliant
// sleeves can stack one industry without any guard registering a breach.
//
// 2026-10-14 is the worked case: XLK reached 44.5% of the book — NVDA $356 and AVGO $329 in the
// sleeve, MRVL $386 in the main book — and every XLK dollar was a semiconductor. Nothing was
// broken. Main bought MRVL, the sleeve bought NVDA and AVGO, the owner topped MRVL up four times,
// and no single path exceeded its own budget.
//
// So this is a VALUE gate (the rule as actually stated) over positions from BOTH sleeves, applied
// at buy time. BUY-SIDE ONLY — it can never force a sale, matching every other cap here; a sector
// already over budget from price appreciation simply stops receiving new money.
//
// Top-ups are NOT exempt, unlike the position-slot cap. A slot cap counts NAMES, so a top-up adds
// none; this counts DOLLARS, and a top-up adds those. Exempting them would leave the largest
// single route to concentration open — on 2026-10-14 the biggest XLK position got there precisely
// by repeated top-ups.
export interface SectorBudgetOpts {
  /** Current value per sector, counting EVERY held position, main and sleeve alike. */
  heldValueBySector: Map<string, number>;
  /** Sector for a symbol, or null when it cannot be established. */
  sectorOf: (symbol: string) => string | null;
  /** Denominator for the cap — the whole book, cash included. */
  totalValue: number;
  /** Fraction, e.g. 0.40. */
  capPct: number;
  minBuy?: number;
}

export function applySectorBudget<T extends { symbol: string; dollarAmount: number }>(
  buys: T[],
  opts: SectorBudgetOpts,
): { buys: T[]; notes: string[] } {
  const notes: string[] = [];
  const minBuy = opts.minBuy ?? MIN_BUY_DOLLARS;
  const budget = opts.totalValue * opts.capPct;
  // Mutable running total so two buys in the SAME sector in one decision cannot each pass against
  // the same headroom — the classic way a per-item check lets a batch through.
  const running = new Map(opts.heldValueBySector);
  if (!(budget > 0)) {
    // No usable denominator means no budget can be established. WITHHOLD rather than wave the
    // batch through: an unestablished limit is not an absent one.
    return {
      buys: [],
      notes: buys.map(b => `${b.symbol} buy DROPPED — could NOT establish the sector budget (total value unreadable). Withheld rather than buying against an unknown limit.`),
    };
  }
  const kept = buys.flatMap((b): T[] => {
    const sector = opts.sectorOf(b.symbol);
    if (sector == null) {
      // Same direction as the earnings gate: a name whose sector we cannot establish cannot be
      // budgeted, and dropping the CHECK rather than the BUY is the fail-open branch.
      notes.push(`${b.symbol} buy DROPPED — could NOT establish its sector, so it cannot be counted against the ${(opts.capPct * 100).toFixed(0)}% sector budget. This says our sector data is missing, NOT that ${b.symbol} is over-concentrated.`);
      return [];
    }
    const held = running.get(sector) ?? 0;
    const room = budget - held;
    if (room <= 0) {
      notes.push(`${b.symbol} buy DROPPED — ${sector} is already $${held.toFixed(0)} of a $${budget.toFixed(0)} budget (${(held / opts.totalValue * 100).toFixed(1)}% vs a ${(opts.capPct * 100).toFixed(0)}% cap), counting BOTH sleeves. No new money into this sector until it falls back under.`);
      return [];
    }
    if (b.dollarAmount <= room) {
      running.set(sector, held + b.dollarAmount);
      return [b];
    }
    if (room < minBuy) {
      notes.push(`${b.symbol} buy DROPPED — only $${room.toFixed(0)} of ${sector} budget remains, below the $${minBuy} minimum buy.`);
      return [];
    }
    notes.push(`${b.symbol} buy trimmed $${b.dollarAmount.toFixed(0)}→$${room.toFixed(0)} — would take ${sector} past its ${(opts.capPct * 100).toFixed(0)}% budget, counting BOTH sleeves.`);
    running.set(sector, held + room);
    return [{ ...b, dollarAmount: Number(room.toFixed(2)) }];
  });
  return { buys: kept, notes };
}

// ── Concentration trim-on-drift (risk control) ────────────────────────────────────────────────
// The per-position cap (applyPerPositionCap) only bounds NEW BUYS — a winner can still APPRECIATE
// past it (APA drifted to 28% of the book with the 20% cap never trimming it; when Energy sold off
// 2026-08-27 that single name was >half the week's −4% loss). This enforces the cap on HELD value
// too: any MAIN position over the TRIGGER (a band above target, so a name hovering at the cap isn't
// re-trimmed daily) is trimmed back to TARGET (= the buy cap). Deliberately in tension with "let
// winners run" — it caps single-name DRAWDOWN risk at the cost of some upside; that's the point.
//
// Returns partial-sell intents ({symbol, fraction}) for the executor + human-readable notes. Pure.
// The band: TRIGGER = target × TRIM_TRIGGER_MULT (default 1.25). TARGET = maxPos (the buy cap), so a
// trim never fights a fresh buy (trigger is always ABOVE the buy cap → no buy/trim churn). NOTE: on a
// SMALL book the buy cap is the $400 FLOOR (maxPositionDollars = max($400, 0.2×total)), not 20%, so
// the effective concentration % is higher than ~25% there — an intentional consequence of the min-buy
// floor (you can't both require $50–$400 deployable positions AND cap a name at 20% of a ~$1500 book).
// The account is well above that floor; this is a latent small-book note, not a live gap.
export const TRIM_TRIGGER_MULT = 1.25;

export function applyConcentrationTrim(
  symbols: string[],                       // MAIN-book held symbols to check (influencer sleeve excluded by caller)
  maxPos: number,                          // the per-position dollar cap (= TARGET) — maxPositionDollars(totalValue)
  heldValueOf: (symbol: string) => number, // current market value of the held position
  triggerMult: number = TRIM_TRIGGER_MULT,
): { trims: Array<{ symbol: string; fraction: number; strategy: "main" }>; notes: string[] } {
  const trigger = maxPos * triggerMult;
  const trims: Array<{ symbol: string; fraction: number; strategy: "main" }> = [];
  const notes: string[] = [];
  for (const sym of symbols) {
    const value = heldValueOf(sym);
    if (!(value > trigger)) continue;            // within the band (or unpriced=0) — leave it
    // Sell down to the TARGET (maxPos), not the trigger — the same level a fresh buy is capped at.
    const fraction = (value - maxPos) / value;   // 0<fraction<1 (value>trigger>maxPos ⇒ numerator>0)
    if (!(fraction > 0 && fraction < 1)) continue; // safety: never a full liquidation from a trim
    trims.push({ symbol: sym, fraction: Number(fraction.toFixed(4)), strategy: "main" });
    notes.push(`${sym} TRIMMED — position $${value.toFixed(0)} exceeds the ~${(triggerMult * 100).toFixed(0)}%-of-cap concentration trigger ($${trigger.toFixed(0)}); trimming ${(fraction * 100).toFixed(0)}% back to the $${maxPos.toFixed(0)} cap`);
  }
  return { trims, notes };
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
