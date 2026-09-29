// ─────────────────────────────────────────────────────────────────────────────
// FEATURE CAPTURE — Phase 0 of the tail-risk experiment (docs/experiment-nori-tail-risk.md)
//
// The run already computes a rich per-name feature vector for the whole universe and then THROWS
// IT AWAY: TradeRun.market keeps only counts, positions covers the ~6-10 held names, and the
// ledgers/shadows store {symbol, price, date} because a forward-return baseline is all they need.
// So there is no historical feature matrix and no way to build one retroactively — reconstructing
// it from a vendor would import the survivorship bias that parked the Sharadar backtest.
//
// This writes down what is currently discarded. Nothing more. It places no orders, reads no new
// API, calls no model, and is wrapped fail-safe at the call site: a capture failure must never
// cost a trade. Same measure-before-mechanism precedent as the mean-reversion and give-back
// shadows, which exist to accrue forward outcomes before any capital moves.
//
// STORAGE DIVERGES from those shadows ON PURPOSE. They read the whole history, merge, and write it
// back — fine at 5 rows/day, but at ~500 rows/day that becomes a multi-megabyte blob rewritten
// daily, and a single failed read would risk the whole history. This uses ONE KEY PER DAY, so a
// write touches only that day and a bad day cannot damage the rest.
//
// Forward outcomes are deliberately NOT stored: they are computed on read from the captured price,
// exactly as the existing shadows do. Nothing needs labelling at write time, so the capture never
// has to be revisited or backfilled.
// ─────────────────────────────────────────────────────────────────────────────

import type { StockData } from "./market-data";
import { redisPost } from "./run-store";

/** ~18 months: long enough to outlive any evaluation window, short enough to bound storage. */
export const CAPTURE_TTL_SECONDS = 550 * 24 * 60 * 60;
export const CAPTURE_KEY_PREFIX = "robinhood:feature-capture:";

/** Columns, in order. Stored positionally (see below) — APPEND ONLY, never reorder or remove:
 *  a reader of an older day resolves columns by this list, so changing the order silently
 *  re-labels history. New columns go on the end and read as undefined for earlier days. */
export const CAPTURE_COLUMNS = [
  "symbol", "price",
  "mom12_1", "change5d", "change14d", "change30d",
  "volatility30d", "beta",
  "sharpe5d", "sharpe14d", "sharpe30d",
  "distFrom52wHigh", "relStrength5d", "relStrength30d",
  "qualityPct", "peTTM", "peFY", "daysToEarnings",
] as const;

export interface CaptureDay {
  v: 1;
  date: string;
  columns: readonly string[];
  /** Positional rows matching `columns`. Columnar-ish on purpose: repeating 18 field NAMES across
   *  ~500 rows roughly triples the payload for no information. */
  rows: Array<Array<string | number | null>>;
}

/** Round to keep the payload small. These are inputs to a model, not an accounting ledger —
 *  4 decimals is far below the noise floor of any of them. */
const r4 = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(4));

/** Pure: build the rows for one day. Injected lookups keep it testable without market data or
 *  Redis, matching screenMeanReversionCandidates' shape. */
export function buildFeatureRows(
  stocks: StockData[],
  qualityOf: (symbol: string) => number | null,
  peOf: (symbol: string) => { peTTM: number | null; peFY: number | null },
  daysToEarningsOf: (symbol: string) => number | null,
): CaptureDay["rows"] {
  return stocks
    // A row with no price is unusable as a forward-return baseline, which is the ONE thing the
    // capture exists to preserve. Drop it rather than store a row that can never be scored.
    .filter(s => s.symbol && Number.isFinite(s.price) && s.price > 0)
    .map(s => {
      const pe = peOf(s.symbol);
      return [
        s.symbol, r4(s.price),
        r4(s.mom12_1), r4(s.change5d), r4(s.change14d), r4(s.change30d),
        r4(s.volatility30d), r4(s.beta),
        r4(s.sharpe5d), r4(s.sharpe14d), r4(s.sharpe30d),
        r4(s.distFrom52wHigh), r4(s.relStrength5d), r4(s.relStrength30d),
        r4(qualityOf(s.symbol)), r4(pe.peTTM), r4(pe.peFY), daysToEarningsOf(s.symbol),
      ];
    });
}

/** Write one day. Returns what happened so the caller can log it — a capture that silently stops
 *  writing is worthless, and "0 written" every day is the only symptom it would ever show. */
export async function recordFeatureCapture(
  rows: CaptureDay["rows"],
  today: string,
): Promise<{ written: number; bytes: number; skipped?: string }> {
  if (rows.length === 0) return { written: 0, bytes: 0, skipped: "no rows" };
  const payload: CaptureDay = { v: 1, date: today, columns: CAPTURE_COLUMNS, rows };
  const json = JSON.stringify(payload);
  // POST/pipeline, never the URL-path helper: that encodes the value into the PATH, which a
  // ~75KB payload blows past — the same trap that made the valuation EPS cache silently never write.
  await redisPost("pipeline", [[
    "SET", `${CAPTURE_KEY_PREFIX}${today}`, json, "EX", CAPTURE_TTL_SECONDS,
  ]]);
  return { written: rows.length, bytes: json.length };
}
