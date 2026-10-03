# Scope — rebuild STOCK_SECTOR from Sharadar membership

Scoped 2026-10-03. Nothing built. Universe changes need owner approval (`CLAUDE.md`).

## The finding this started from is bigger than the prune

Measured against Sharadar's `sp500` table (cached, snapshot 2026-09-29):

| | |
|---|---|
| Sharadar `current` S&P members | 503 |
| `STOCK_SECTOR` entries | 450 |
| in our universe, NOT in the S&P | **69** |
| in the S&P, MISSING from ours | **122** |

The 17-name prune addressed about a quarter of one side of this.

## The part that actually matters: the main book cannot buy ~24% of the index

Confirmed absent from `STOCK_SECTOR`: **AVGO, GOOG, BRK.B, ANET, UBER, CRWD, DELL, PNC, NOC, KKR,
APO, COIN** — among 122. These are not edge cases; several are megacaps.

A name outside `STOCK_SECTOR` can never reach `buildV1Shortlist`, so the main book has been
structurally unable to buy them. Worse, it is silent: the screen reports on the 450 it knows about
and nothing says the other 122 exist.

**AVGO is the worked example, from 2026-10-02.** It was bought — as an INFLUENCER pick, because
sleeve classification infers "influencer" from `!v1ShortlistSet.has(sym)` and AVGO cannot be on the
shortlist if it is not in the universe. So a current S&P 500 member was bought into the 2-slot
influencer sleeve and booked to influencer P&L, rather than being eligible for the main book at all.
That mis-slots the position AND consumes scarce sleeve capacity.

This is a bug in reach, not in ranking, and it is invisible in every metric we have.

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

- **Renames we already handle**: BNY, MRSH, FISV, COR, VMRK — the same companies as BK, MMC, FI,
  ABC, and the AVB/EQR combination. Importing both spellings would double-count them.
- **Entries that look like data artifacts or very recent events**: `P`, `Q`, `FDXF`, `HONA`, `ECHO`,
  `PSKY`, `SNDK`, `XYZ`. These need checking before anything is added — an import that invents a
  ticker puts a non-existent name on the buy allowlist.
- **Genuine additions** — the bulk.

Equally, the 69 split two ways: ~17 genuinely delisted (the prune list) and ~52 **alive but dropped
from the index** (AGCO, ALLY, ETSY, PARA, ZION, …). Those still price and still score; removing them
is a strategy decision — "S&P 500 momentum" says they go — not a data-hygiene fix.

## Risk

This changes WHAT THE AGENT MAY BUY, in both directions, by roughly a quarter of the universe. The
failure modes are asymmetric:

- Adding a bad ticker → it can reach the buy allowlist. Worst case.
- Dropping a live held name → it leaves the shortlist, and "fell off the shortlist" is a reason
  `lib/sell-rail` accepts for SELLING. A removal must be checked against current holdings first.
  (None of today's 12 holdings are in the 69, checked — but that must be a gate, not a one-off.)

## Proposed phases

1. **Report only, zero behaviour change.** A drift check that logs adds/removes/renames each run,
   surfaced like `QUALITY_STALE_UNIVERSE`. Makes the gap visible and lets the list be reviewed over a
   few days before anything moves. Low risk, and it is the piece that keeps working afterwards.
2. **Sector source.** Add the `TICKERS` pull and the sector→ETF mapping, reviewed once by hand.
3. **One reviewed diff.** Apply adds and removes as a single commit with the full list in the
   message, gated on: no removal of a currently-held name, every addition resolving a real quote and
   a CIK, and renames reconciled against `TICKER_CIK_OVERRIDES` so nothing is double-counted.
4. **Keep it fresh.** Re-run the drift check in `backtest.yml` (which already has
   `SHARADAR_API_KEY`) and open a PR when it finds drift, rather than discovering this again in six
   months.

Phase 1 alone would have caught AVGO.
