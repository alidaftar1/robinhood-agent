// Sort the owner's own buys into a book, at the first trade run that sees them.
//
// The owner buys by hand during the session, after that day's 07:30 run. The next 07:30 run is the
// first to hold the shares, and the 08:00 capture that records the fill comes AFTER it. Until this
// existed, a holding not already in the sleeve was treated as MAIN at that run, so a buy the owner
// meant for the influencer sleeve was judged against the main list and sold (2026-10-30: AMD,
// bought 10-29 for the sleeve, sold at 07:30 as "fell off the shortlist", −$32). A tag after the
// capture always came too late for that run.
//
// The owner's rule (2026-10-29): his buys are meant to fit main OR influencer; the agent should
// check them and may sell one that fits neither. So, for each name held now that the previous run
// did not hold and the agent did not buy:
//   on the main shortlist (buy list or ◆HELD band)      → main
//     …unless it also qualifies for the sleeve and is NOT in the main list's top 7 (the book's target
//     size): a name that is on the list only for its sector's slot is a weak main pick and a strong
//     sleeve one (2026-10-30, owner: GOOGL, +23% 12-1 momentum, 11th of 14, net 8 / 4 channels)
//   otherwise, qualifies as a sleeve buy right now     → influencer
//   main data AND influencer data both read, neither   → misfit (sold by code this run)
//   either side could not be read                       → unknown (left as main, never sold)
// Main wins a tie only for a top-7 name.
// An outage never sells: a misfit is only declared when BOTH checks actually ran — and "could not
// be read" includes a name in the S&P universe that has no price or momentum this morning (one
// failed quote drops it from the shortlist without any signal). Then confirmMisfits keeps only the
// misfits the broker shows the OWNER bought: a holding that is merely new (spin-off, merger stock,
// a row the last snapshot dropped, the agent's own late fill) is never sold as "your buy".

export type OwnerBuySort = {
  symbol: string;
  sleeve: "main" | "influencer" | "misfit" | "unknown";
  why: string;
};

export function sortOwnerBuys(args: {
  /** Symbols held right now (live positions). */
  heldNow: string[];
  /** The previous run's positions — null when there is no previous run (nothing is "new"). */
  prevHeld: string[] | null;
  /** Symbols the agent itself bought in the previous run (late fills are not owner buys). */
  prevAgentBuys: string[];
  /** On the main shortlist: buy-allowlist or ◆HELD band. null = quality data unavailable. */
  onMainList: ((sym: string) => boolean) | null;
  /** In the top of the main list (first TARGET_MAIN_POSITIONS of the ranked buy list). */
  mainStrong: (sym: string) => boolean;
  /** The main check could not be made for this name (quality withheld, or no price/momentum), so
   *  "not on the list" proves nothing. */
  mainUnknown: (sym: string) => boolean;
  /** Sleeve-buy check (net floor + channels + universe). null = influencer signals unavailable. */
  influencer: { qualifies: (sym: string) => boolean; describe: (sym: string) => string } | null;
}): OwnerBuySort[] {
  if (!args.prevHeld) return [];
  const prev = new Set(args.prevHeld);
  const agent = new Set(args.prevAgentBuys);
  const out: OwnerBuySort[] = [];
  for (const symbol of new Set(args.heldNow)) {
    if (prev.has(symbol) || agent.has(symbol)) continue;
    const mainKnown = args.onMainList != null && !args.mainUnknown(symbol);
    const sleeveFit = args.influencer?.qualifies(symbol) ?? false;
    if (mainKnown && args.onMainList!(symbol)) {
      if (args.mainStrong(symbol)) {
        out.push({ symbol, sleeve: "main", why: "in the top of the main-book shortlist" });
        continue;
      }
      if (!sleeveFit) {
        out.push({ symbol, sleeve: "main", why: "on the main-book shortlist" });
        continue;
      }
      out.push({ symbol, sleeve: "influencer", why: `on the main shortlist outside its top, and a stronger influencer pick (${args.influencer!.describe(symbol)})` });
      continue;
    }
    if (sleeveFit) {
      out.push({ symbol, sleeve: "influencer", why: `qualifies as an influencer pick (${args.influencer!.describe(symbol)})` });
      continue;
    }
    if (mainKnown && args.influencer) {
      out.push({ symbol, sleeve: "misfit", why: `not on the main-book shortlist and not an influencer pick (${args.influencer.describe(symbol)})` });
      continue;
    }
    out.push({
      symbol, sleeve: "unknown",
      why: !mainKnown ? "main-book quality data unavailable for it" : "influencer signals unavailable",
    });
  }
  return out;
}

/**
 * Keep a misfit only with evidence the owner bought it (`ownerBought`: symbols with a filled,
 * owner-placed buy in the window). No evidence, or the evidence could not be read (null), turns it
 * into "unknown": left alone, never sold.
 */
export function confirmMisfits(sorted: OwnerBuySort[], ownerBought: Set<string> | null): OwnerBuySort[] {
  return sorted.map(s => {
    if (s.sleeve !== "misfit" || ownerBought?.has(s.symbol)) return s;
    return {
      symbol: s.symbol, sleeve: "unknown",
      why: ownerBought == null
        ? "fits neither book, but your order history could not be read to confirm you bought it"
        : "fits neither book, but no filled buy by you was found for it (spin-off, merger stock or a data gap?)",
    };
  });
}
