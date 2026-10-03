# Scope — rebuild STOCK_SECTOR from Sharadar membership

Scoped 2026-10-03. Nothing built. Universe changes need owner approval (`CLAUDE.md`).

## The finding this started from is bigger than the prune

Measured against Sharadar's `sp500` table (cached, snapshot 2026-09-29):

| | |
|---|---|
| Sharadar `current` S&P members | 503 |
| `STOCK_SECTOR` entries | 450 |
| in our universe, NOT in the S&P | **65** |
| in the S&P, MISSING from ours | **118** |
| same company, renamed ticker | **4** (BK→BNY, MMC→MRSH, FI→FISV, ABC→COR) |

(Raw set-difference gives 69/122; the drift report pulls the 4 renames out of BOTH sides, since
counting one company as a removal AND an addition would churn the universe for a ticker change.)

The 17-name prune addressed about a quarter of one side of this.

## The part that actually matters: the main book cannot buy ~24% of the index

Confirmed absent from `STOCK_SECTOR`: **AVGO, GOOG, BRK.B, ANET, UBER, CRWD, DELL, PNC, NOC, KKR,
APO, COIN** — among 118. These are not edge cases; several are megacaps.

A name outside `STOCK_SECTOR` can never reach `buildV1Shortlist`, so the main book has been
structurally unable to buy them. Worse, it is silent: the screen reports on the 450 it knows about
and nothing says the other 122 exist.

**AVGO, 2026-10-02 — stated carefully, because the obvious version of this claim is wrong.** It was
bought as an INFLUENCER pick, since sleeve classification infers "influencer" from
`!v1ShortlistSet.has(sym)` and AVGO cannot be shortlisted when it is not in the universe. So the
sleeve was its ONLY possible route in, and it consumed one of two scarce slots.

What is NOT established is that a main-book buy was displaced. 2026-10-02 was a Friday and the run
summary reads "Main Book — No Buys Today (Non-Rebalance Day)" — main-book buys were closed outright,
so no universe would have changed that day's outcome. Even on a rebalance day AVGO would still have
to clear the quality gate, positive 12-1 momentum, the <=2-per-sector cap, a top-~33 shortlist slot,
and the model's own choice among ~6 names. Sector room existed (main-book XLK is only MRVL), but
that is one condition of five.

So the defensible claim is about REACH, not about a specific lost trade: 122 index members can only
ever enter through the influencer sleeve, and nothing reports that. Whether the main book would have
bought any of them is unknowable — which is itself the problem, because the option was never on the
table to begin with.

## What exists vs what is missing

| need | status |
|---|---|
| point-in-time S&P membership | **have** — `lib/sharadar-universe.ts` (`parseSp500Csv`, `buildUniverseIndex`, `membersAsOf`), already survivorship-aware for the backtest |
| the data file | **have** — `scripts/sharadar-extract.sh` pulls `sp500.csv`; cached locally |
| **sector per ticker** | **MISSING** — the `sp500` table has date/action/ticker/name only. `STOCK_SECTOR` maps symbol → XL* ETF, and nothing currently supplies that for a new name |

The sector gap is the real work. Options:
1. Pull Sharadar's `TICKERS` table (has `sector`) and map its sector names → the 11 XL* ETFs. One
   extra fetch in `sharadar-extract.sh`, plus a mapping table that needs review once.
2. Keep `STOCK_SECTOR` hand-maintained and use Sharadar only to flag drift. Cheaper, still manual.

## The 122 must not be imported blindly

The list contains three distinct things, and only one is "a new S&P member":

- **Renames already handled**: BNY, MRSH, FISV, COR are now resolved by the drift report and do not
  appear as additions. VMRK still does: AVB and EQR combined into ONE entity, which a 1:1 rename map
  cannot express — a merger needs its own handling.
- **Entries that look like data artifacts or very recent events**: `P`, `Q`, `FDXF`, `HONA`, `ECHO`,
  `PSKY`, `SNDK`, `XYZ`. These need checking before anything is added — an import that invents a
  ticker puts a non-existent name on the buy allowlist.
- **Genuine additions** — the bulk.

Equally, the 65 split two ways: ~17 genuinely delisted (the prune list) and ~52 **alive but dropped
from the index** (AGCO, ALLY, ETSY, PARA, ZION, …). Those still price and still score; removing them
is a strategy decision — "S&P 500 momentum" says they go — not a data-hygiene fix.

## Risk

This changes WHAT THE AGENT MAY BUY, in both directions, by roughly a quarter of the universe. The
failure modes are asymmetric:

- Adding a bad ticker → it can reach the buy allowlist. Worst case.
- Dropping a live held name → it leaves the shortlist, and "fell off the shortlist" is a reason
  `lib/sell-rail` accepts for SELLING. A removal must be checked against current holdings first.
  (None of today's 12 holdings are in the 65, checked — but that must be a gate, not a one-off.)

## Proposed phases

1. **Report only, zero behaviour change. — BUILT 2026-10-03.** `computeUniverseDrift` (pure, 8 tests)
   + `scripts/universe-drift.ts`. Classifies missing / stale / renamed, refuses to report when the
   membership file yields zero current members (a truncated read would otherwise show the ENTIRE
   universe as stale, looking like a catastrophic index change rather than a bad file). Changes
   nothing at runtime.
2. **Sector source.** Add the `TICKERS` pull and the sector→ETF mapping, reviewed once by hand.
3. **One reviewed diff.** Apply adds and removes as a single commit with the full list in the
   message, gated on: no removal of a currently-held name, every addition resolving a real quote and
   a CIK, and renames reconciled against `TICKER_CIK_OVERRIDES` so nothing is double-counted.
4. **Keep it fresh.** Re-run the drift check in `backtest.yml` (which already has
   `SHARADAR_API_KEY`) and open a PR when it finds drift, rather than discovering this again in six
   months.

Phase 1 alone would have caught AVGO.
