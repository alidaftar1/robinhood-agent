// ─────────────────────────────────────────────────────────────────────────────
// EXIT-ATTRIBUTION LEDGER
//
// The mirror of lib/signal-ledger. That one logs every BUY with the signals present at buy time and
// measures which ones predict. Nothing did the same for EXITS — and exits are a large share of what
// this agent does: ⚡NEWS↓ risk sells, ↓FIRM downgrades, the staleness time-stop, drop-check stops
// and take-profits, "fell off the shortlist" rotations.
//
// So we could say which signals pick good entries and NOTHING about whether our exits beat simply
// holding. The registry already records exits that cost money and were caught one at a time by
// hand — ILMN sold 08-06 at $188.96 and re-bought 08-07 at $188.54; ROST sold and re-bought on a
// re-cited earnings report. Catching those by hand is exactly the situation the buy-side ledger was
// built to end.
//
// WHAT "GOOD" MEANS HERE, stated because the sign is the opposite of the buy ledger's: a good exit
// is one the price FELL after. `returnPct` is the name's move from the exit price onward, so
// NEGATIVE is good and the per-trigger average is read as "what holding would have cost us".
//
// THE COUNTERFACTUAL IS "HELD", NOT "HELD VS WHAT WE BOUGHT INSTEAD". This measures whether the
// TRIGGER has edge, not whether the rotation did — the proceeds usually get redeployed, and
// attributing that is a different and much noisier question. Do not read these numbers as the P&L
// impact of exiting; read them as "is this a good reason to sell".
//
// Forward-only, like the other ledgers: a trigger cannot be reconstructed for a past sell, so it
// accumulates from the first record. Small samples early; a measurement layer, never a gate.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchQuoteLite } from "@/lib/market-data";

const LEDGER_KEY = "robinhood:exit-ledger";
/** Keep a year of exits. NOTE there is no horizon: returnPct is always measured to TODAY, so a
 *  300-day-old exit and a 2-day-old one are pooled into one average and beta drift makes every
 *  trigger look worse in a rising market. Fine while samples are tiny; bucket by age before
 *  reading these as a verdict. */
const MAX_EXITS = 400;
/**
 * Both ledger calls are bounded. They run AFTER the orders are placed and, in the trade route,
 * between saveRun and updateLatestRun — the window redisPost's own comment warns about, where a
 * hung connection burns the remaining maxDuration and the day's return never gets written. In
 * drop-check they sit before sendAlert, so a hang would swallow the only notification that a stop
 * fired. Observability must never cost either.
 */
const LEDGER_TIMEOUT_MS = 5_000;

/**
 * WHY a position was closed. Deterministic paths know their own trigger; a model-decided sell
 * reports one if it emitted one, and falls back to "discretionary" rather than guessing — an
 * unlabelled exit must not be silently filed under a trigger it may not belong to.
 */
export type ExitTrigger =
  | "news-down"        // ⚡NEWS↓ material bearish event
  | "firm-down"        // analyst downgrade / price-target cut
  | "stop"             // drop-check stop-loss
  | "take-profit"      // drop-check +20%
  | "earnings"         // pre-earnings exit
  | "stale"            // time-stop: held long, went nowhere
  | "shortlist-drop"   // fell off the quality-momentum shortlist
  | "concentration"    // sector-cap or per-position trim
  | "discretionary"    // model sold it and named no structured reason
  | "human";           // the owner sold it — NO WRITER YET; planCapture tags the trade actor:"human"
                       // but does not feed this ledger, so owner exits are currently absent

/**
 * Map the model's self-reported reason onto a trigger. An unrecognised or missing value degrades to
 * "discretionary" — NEVER to a specific trigger. Guessing would quietly inflate whichever trigger
 * the default pointed at and corrupt the measurement for every honest exit of that kind, which is
 * the one thing this ledger cannot survive.
 */
export function triggerFromReason(reason: string | undefined): ExitTrigger {
  const known: ExitTrigger[] = ["news-down", "firm-down", "stale", "shortlist-drop", "concentration", "stop", "take-profit", "earnings"];
  const r = (reason ?? "").trim().toLowerCase();
  return (known as string[]).includes(r) ? (r as ExitTrigger) : "discretionary";
}

export interface ExitRecord {
  symbol: string;
  date: string;            // exit date (YYYY-MM-DD)
  strategy: string;        // "main" | "influencer"
  priceAtExit: number;     // baseline for the forward return
  trigger: ExitTrigger;
  /** Trading days held, when the caller knows it. Context, not a measure. NO WRITER SETS THIS YET. */
  heldDays?: number;
}

export interface ExitOutcome extends ExitRecord {
  currentPrice: number | null;
  /** The name's move SINCE the exit. Negative = the exit avoided a fall = good. */
  returnPct: number | null;
  daysElapsed: number;
}

export interface TriggerStat {
  trigger: ExitTrigger;
  exits: number;
  /** Mean post-exit move. NEGATIVE is a good trigger. */
  avgReturnPct: number;
  /** Share of exits the price fell after — the hit rate for an exit rule. */
  avoidedRatePct: number;
  bestExit: string;        // the one that avoided the most
  worstExit: string;       // the one that cost the most upside
}

const daysBetween = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

/**
 * null on ANY read failure — never `[]`.
 *
 * recordExits does read-modify-write on one blob, so treating a transient hiccup as "empty" and
 * writing back would wipe the accumulated history. lib/signal-ledger states this contract in a
 * comment and enforces it; the first version of this file copied the shape and not the rule.
 *
 * Deliberately NOT using run-store's redisCommand: it does not check res.ok, so an Upstash 5xx
 * yields result === undefined and reads as an empty ledger with no exception at all.
 */
async function ledgerGet(): Promise<ExitRecord[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${LEDGER_KEY}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: string | null };
    if (json.result == null) return [];        // genuinely empty, distinct from unreadable
    return JSON.parse(json.result) as ExitRecord[];
  } catch { return null; }
}

/** POST /pipeline, not a GET URL: redisCommand encodes the whole blob into the request PATH, which
 *  passes 8KB at ~53 records and reaches ~61KB at MAX_EXITS — a silent, permanent write failure. */
async function ledgerSet(data: ExitRecord[]): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", LEDGER_KEY, JSON.stringify(data)]]),
      signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Append exits. `skipped` says WHICH half failed, because they mean different things: "read" means
 * the history could not be loaded and the write was abandoned to avoid clobbering it; "write" means
 * the history was intact and only this append was lost. Never throws and never blocks a trade — this is observability, and a ledger write
 * must not affect an order that has already been placed.
 *
 * Deduped on symbol+date+TRIGGER, not symbol+date. A name genuinely can exit twice in one day: the
 * 07:30 run trims it on the sector cap and the 10:00 drop-check stops out the remainder, which the
 * known-issues registry records as a routine shape. Keying on the day alone kept the FIRST writer,
 * and because write order is fixed (/api/trade -> drop-check -> earnings-exit) that systematically
 * dropped stops, take-profits and earnings exits while over-weighting trims — a bias in exactly the
 * numbers this ledger exists to produce.
 */
/**
 * Which incoming exits are genuinely new. Pure, so the key can be pinned by a test.
 *
 * Keyed on date+symbol+TRIGGER, not date+symbol. A name genuinely exits twice in one day — the
 * 07:30 run trims it on the sector cap and the 10:00 drop-check stops out the remainder, a shape
 * the known-issues registry documents as routine. Keying on the day alone kept the FIRST writer,
 * and because write order is fixed (/api/trade → drop-check → earnings-exit) that systematically
 * dropped stops, take-profits and earnings exits while over-weighting trims: a bias in exactly the
 * per-trigger numbers this ledger exists to produce.
 */
export function dedupeExits(existing: ExitRecord[], incoming: ExitRecord[]): ExitRecord[] {
  const key = (e: ExitRecord) => `${e.date}|${e.symbol}|${e.trigger}`;
  const seen = new Set(existing.map(key));
  const out: ExitRecord[] = [];
  for (const e of incoming) {
    if (!(e.priceAtExit > 0) || seen.has(key(e))) continue;
    seen.add(key(e));   // also dedupes WITHIN one batch
    out.push(e);
  }
  return out;
}

export async function recordExits(exits: ExitRecord[]): Promise<{ recorded: number; skipped?: "read" | "write" }> {
  if (exits.length === 0) return { recorded: 0 };
  const existing = await ledgerGet();
  if (existing === null) {
    // Unreadable, NOT empty. Skipping one write loses one row; writing would lose the history.
    console.warn("EXIT_LEDGER_READ_FAILED — skipping the write rather than overwriting history");
    return { recorded: 0, skipped: "read" };
  }
  const fresh = dedupeExits(existing, exits);
  if (fresh.length === 0) return { recorded: 0 };
  const ok = await ledgerSet([...existing, ...fresh].slice(-MAX_EXITS));
  if (!ok) { console.warn("EXIT_LEDGER_WRITE_FAILED", { attempted: fresh.length }); return { recorded: 0, skipped: "write" }; }
  return { recorded: fresh.length };
}

/** Pure: roll exits up per trigger. Exported for tests; computeExitAttribution does the fetching. */
export function rollupTriggers(outcomes: ExitOutcome[]): TriggerStat[] {
  const byTrigger = new Map<ExitTrigger, ExitOutcome[]>();
  for (const o of outcomes) {
    if (o.returnPct == null) continue;   // unpriceable — contributes to nothing
    byTrigger.set(o.trigger, [...(byTrigger.get(o.trigger) ?? []), o]);
  }
  return [...byTrigger.entries()]
    .map(([trigger, rows]) => {
      const rets = rows.map(r => r.returnPct as number);
      const best = rows.reduce((a, b) => ((b.returnPct as number) < (a.returnPct as number) ? b : a));
      const worst = rows.reduce((a, b) => ((b.returnPct as number) > (a.returnPct as number) ? b : a));
      const fmt = (o: ExitOutcome) => `${o.symbol} ${(o.returnPct as number) >= 0 ? "+" : ""}${(o.returnPct as number).toFixed(1)}%`;
      return {
        trigger,
        exits: rets.length,
        avgReturnPct: rets.reduce((a, b) => a + b, 0) / rets.length,
        avoidedRatePct: (rets.filter(r => r < 0).length / rets.length) * 100,
        bestExit: fmt(best),
        worstExit: fmt(worst),
      };
    })
    // Most useful trigger first: the one whose names fell hardest after we left.
    .sort((a, b) => a.avgReturnPct - b.avgReturnPct);
}

export async function computeExitAttribution(
  today: string,
): Promise<{ exits: ExitOutcome[]; triggers: TriggerStat[] }> {
  const records = (await ledgerGet()) ?? [];
  const outcomes: ExitOutcome[] = await Promise.all(
    records.map(async (r) => {
      const currentPrice = (await fetchQuoteLite(r.symbol).catch(() => null))?.price ?? null;
      return {
        ...r,
        currentPrice,
        returnPct: currentPrice != null && r.priceAtExit > 0
          ? (currentPrice / r.priceAtExit - 1) * 100
          : null,
        daysElapsed: daysBetween(r.date, today),
      };
    }),
  );
  outcomes.sort((a, b) => (a.returnPct ?? Infinity) - (b.returnPct ?? Infinity));
  return { exits: outcomes, triggers: rollupTriggers(outcomes) };
}
