const RUNS_KEY = "robinhood:runs";
// RECORDS, not dates: several routes write extra records on a date that already has one
// (drop-check exits, earnings-exit, same-day re-runs), so the number of distinct DATES is always
// lower — ~1.2 records/date observed. heldDaysOf needs STALE_DAYS (60) distinct dates, so 90
// records left only ~15 dates of headroom and a busier week would have made the main-book
// time-stop unreachable again. 150 gives ~125 dates at the observed ratio.
export const MAX_RUNS = 150;

export interface PositionSnapshot {
  symbol: string;
  quantity: string;
  avgCost: string;
  price: string; // current market price at time of run
}

export interface TradeSnapshot {
  symbol: string;
  side: string;
  quantity: string;
  avgPrice: string;
  state: string;
  strategy?: "main" | "influencer"; // which sub-portfolio this trade belongs to
  /** The quote this trade was DECIDED on — marketData's price for the symbol at analysis time.
   *
   *  Stored so execution cost is measurable at all. Slippage is the one live question that resolves
   *  in WEEKS rather than years: per-fill dispersion is small (tens of bps), so ~20 fills is enough
   *  to see a 10bp mean, versus the ~43 years the portfolio-level "beats SPY" question needs. It is
   *  also the one nothing currently measures — and a persistent 50bp of execution cost would swamp
   *  anything the ranking logic is arguing about.
   *
   *  OBSERVED, not derived: the decision price cannot be reconstructed after the fact, because the
   *  quote that drove the decision is gone by the next run. Optional because runs written before
   *  this existed have none. */
  refPrice?: string;
}

export interface PersonalSnapshot {
  totalValue: string;
  cash: string;
  positions: PositionSnapshot[];
  trades: TradeSnapshot[];
}

export interface TradeRun {
  timestamp: string;
  date: string;
  summary: string;
  portfolioAfter: {
    totalValue: string;
    cash: string;
    equity: string;
    unsettledCash?: string; // unsettled sell proceeds (T+1) — captured from 2026-06-21
  } | null;
  positions: PositionSnapshot[];
  market: {
    stocksLoaded: number;
    headlinesLoaded: number;
  };
  spyPrice?: number;
  trades?: TradeSnapshot[];
  // Performance comparison fields (added 2026-06-10)
  personal?: PersonalSnapshot | null;
  agenticDailyReturn?: number | null;
  personalDailyReturn?: number | null;
  agenticImpliedTransfer?: number | null;
  personalImpliedTransfer?: number | null;
  /** Set when a return was deliberately cleared as a known artifact (e.g. a thin
   *  intraday run / deposit-window day). Blocks auto-recompute so patchDate /
   *  patchTrades can't resurrect a bogus number. (2026-06-30) */
  returnLocked?: boolean;
  /** Core S&P-sleeve daily return (account minus the influencer slice), stored at
   *  trade time. Lets the dashboard show the core strategy isolated from the influencer
   *  drag. From 2026-06-30; null on older runs (no reliable backfill). */
  mainDailyReturn?: number | null;
  /** Value-weighted book β vs SPY of the post-trade holdings, computed at trade time from
   *  each holding's β (fresh market data) × position value. This is the dashboard's "Swings
   *  vs. Market" number: a HOLDINGS-based estimate that's meaningful from day one — unlike a
   *  realized regression over a handful of daily returns, which is noise until months of
   *  history accrue and (for a daily-rebalanced book) blends names no longer held. coveragePct
   *  = share of book value with a known β. null on older runs / when no priced holdings. (2026-07-04) */
  bookBeta?: { beta: number; coveragePct: number; bySymbol?: Record<string, number> } | null;
  /** Human-readable notes from the pre-flight buy-sizing step (fitBuysToBudget) when it shrank
   *  or DROPPED a decided buy to fit settled buying power — e.g. "TSLA DROPPED — whole share
   *  needs ~$413 but only $40 left; ~$413 stays idle". Persisted so a dropped buy is never
   *  silent: the skeptical-reviewer and 8am email can cite the exact sizing reason instead of
   *  inferring it from idle cash. Absent when no sizing adjustment was needed. (2026-07-06) */
  buySizingAdjustments?: string[];
  /** Market regime at trade time: is SPY above (riskOn) or below its ~100-day average? RETIRED as a
   *  β target — the β-regime overlay trial (2026-07-06) ended; V1 does NOT target a book β, and low/
   *  negative β is expected (APA's inverse β). This field is now INFORMATIONAL only (still fed to the
   *  drop-check sympathy judgment as a risk-on/off signal). null when the signal was unavailable. */
  regime?: { riskOn: boolean; spy: number; ma: number } | null;
  // Influencer sub-portfolio (added 2026-06-18)
  influencerPositions?: PositionSnapshot[];
  influencerDailyReturn?: number | null;
}

export async function redisCommand(command: string, ...args: (string | number)[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");

  const res = await fetch(`${url}/${command}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json() as { result: unknown };
  return json.result;
}

/** Upstash's /pipeline endpoint answers with a TOP-LEVEL ARRAY ([{result:…},{result:…}]), not the
 *  {result:…} envelope every other endpoint uses. redisPost unwraps `.result` and therefore returns
 *  undefined for a pipeline — invisible to writers, which ignore the return, and wrong for anyone
 *  who needs the results. Use this when you need them. */
export async function redisPipeline(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Upstash pipeline ${res.status}`);
  return res.json();   // the array, unwrapped by nobody
}

export async function redisPost(command: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");

  const res = await fetch(`${url}/${command}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Optional and undefined by default, so every existing caller is unchanged. Callers that run
    // AFTER saveRun but BEFORE updateLatestRun should pass one: a hung connection there burns the
    // remaining maxDuration and the function dies before the day's return is written.
    signal,
  });
  const json = await res.json() as { result: unknown };
  return json.result;
}

export async function saveRun(run: TradeRun): Promise<void> {
  try {
    const serialized = JSON.stringify(run);
    await redisPost("pipeline", [
      ["LPUSH", RUNS_KEY, serialized],
      ["LTRIM", RUNS_KEY, 0, MAX_RUNS - 1],
    ]);
  } catch {
    console.warn("Upstash unavailable — run not saved to dashboard");
  }
}

// Overwrites the most recently saved run (index 0) with updated data.
// Call after post-trade fetches to backfill portfolioAfter/positions/trades.
export async function updateLatestRun(run: TradeRun): Promise<void> {
  try {
    await redisPost("pipeline", [
      ["LSET", RUNS_KEY, 0, JSON.stringify(run)],
    ]);
  } catch {
    console.warn("Upstash unavailable — latest run not updated");
  }
}

export async function getRuns(limit = 30): Promise<TradeRun[]> {
  try {
    const results = await redisCommand("lrange", RUNS_KEY, 0, limit - 1) as string[] | null;
    if (!results) return [];
    return results.map((r) => JSON.parse(r) as TradeRun);
  } catch {
    return [];
  }
}

export async function getLatestRun(): Promise<TradeRun | null> {
  const runs = await getRuns(1);
  return runs[0] ?? null;
}

// Returns the most recent run from a date strictly earlier than `today`.
// Used for day-over-day return comparisons so same-day re-runs don't distort the baseline.
export async function getPreviousDayRun(today: string): Promise<TradeRun | null> {
  const runs = await getRuns(10);
  return runs.find(r => r.date < today) ?? null;
}

// Removes duplicate same-day runs, keeping only the latest timestamp per date.
// Stable identity for a fill, so unioning trades across same-date runs doesn't
// duplicate the ones both runs already recorded.
function tradeKey(t: TradeSnapshot): string {
  return `${t.symbol}|${t.side}|${t.quantity}|${t.avgPrice}`;
}

function unionTrades(a: TradeSnapshot[], b: TradeSnapshot[]): TradeSnapshot[] {
  const out = [...a];
  const seen = new Set(a.map(tradeKey));
  for (const t of b) {
    const k = tradeKey(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

/** One sell record that a same-date run RE-RECORDED — the same real fill written twice
 *  with two different price estimates, which unionTrades can't collapse. */
export interface ReRecordedSell {
  date: string;
  symbol: string;
  quantity: string;
  keptPrice: string;    // the record we keep (highest-confidence state)
  droppedPrice: string; // the phantom twin
  phantomProceeds: number; // dollars the duplicate adds to the day's tradeNetCash
  dropKey: string;      // `${date}|${tradeKey}` of the record to drop
}

// Confidence in a recorded fill's price, best first. drop-check overwrites a sell's
// avgPrice with the detection-pass QUOTE while the trade route / earnings-exit keep the
// model's self-reported number, so two runs observing the same fill land on two different
// prices — and a "filled" report is closer to the real fill than a pre-fill "submitted" one.
function sellConfidence(t: TradeSnapshot): number {
  if (t.state === "filled") return 0;
  if (t.state === "submitted") return 1;
  return 2; // "inferred" and anything else — weakest
}

// A day cannot sell more shares of a symbol than it could possibly have held: the
// start-of-day holding plus whatever it bought that day. When two same-date runs each
// record the SAME real fill (an intraday exit run places the sell; a later run's
// PORTFOLIO_SNAPSHOT reports the day's trades again, or the exit re-fires), the two
// records differ only in avgPrice/state — so tradeKey sees two distinct fills, unionTrades
// keeps both, and computeDailyReturn double-counts the proceeds as pure phantom P&L.
//
// TER on 2026-07-27: ONE real 1-share sell (live Robinhood: filled @ $327.74) was stored
// twice — @ $327.94 "filled" and @ $328.73 "submitted" — against a position that started
// the day at ZERO shares and was bought that morning (ceiling = 1). The extra $328.73 of
// sell proceeds turned a true −0.08% day into +13.27% with a phantom −$331.57 "withdrawal".
// Under the autopilot's 30% extreme-return threshold, so nothing flagged it; the day's
// return was cleared instead (returnLocked) — a permanent hole in the compounded record.
//
// Deliberately narrow: a record is dropped ONLY when (a) the day's recorded sells for that
// symbol exceed the provable ceiling, AND (b) it is a same-QUANTITY twin of a record we
// keep. Genuine partial fills (10 + 7 of 17 held) never exceed the ceiling; a lone sell
// against a stale/incomplete prior snapshot has no twin, so a wrong ceiling can't delete
// real history. Returns [] when there is no earlier snapshot to derive a ceiling from.
export function findReRecordedSells(runsNewestFirst: TradeRun[]): ReRecordedSell[] {
  const byDate = new Map<string, TradeRun[]>();
  for (const r of runsNewestFirst) {
    const arr = byDate.get(r.date);
    if (arr) arr.push(r); else byDate.set(r.date, [r]);
  }

  const out: ReRecordedSell[] = [];
  for (const [date, dayRuns] of byDate) {
    // The day's trades exactly as mergeRunsByDate would union them (same identity rule).
    const trades: TradeSnapshot[] = [];
    const seen = new Set<string>();
    for (const r of dayRuns) {
      for (const t of r.trades ?? []) {
        const k = tradeKey(t);
        if (!seen.has(k)) { seen.add(k); trades.push(t); }
      }
    }

    // Start-of-day holdings = newest snapshot from an EARLIER date (getPreviousDayRun
    // semantics). No prior snapshot → no provable ceiling → leave the day alone.
    const prev = runsNewestFirst.find(r => r.date < date && (r.positions?.length ?? 0) > 0);
    if (!prev) continue;
    const qtyOf = (s: string) => parseFloat(s) || 0;
    const held = new Map(prev.positions.map(p => [p.symbol, qtyOf(p.quantity)]));

    const bought = new Map<string, number>();
    const sellsBySymbol = new Map<string, TradeSnapshot[]>();
    for (const t of trades) {
      if (t.side === "buy") bought.set(t.symbol, (bought.get(t.symbol) ?? 0) + qtyOf(t.quantity));
      else if (t.side === "sell") {
        const arr = sellsBySymbol.get(t.symbol);
        if (arr) arr.push(t); else sellsBySymbol.set(t.symbol, [t]);
      }
    }

    for (const [symbol, sells] of sellsBySymbol) {
      const ceiling = (held.get(symbol) ?? 0) + (bought.get(symbol) ?? 0);
      let excess = sells.reduce((s, t) => s + qtyOf(t.quantity), 0) - ceiling;
      if (excess <= 1e-9) continue; // sells fit what was sellable — nothing to prove

      // Keep the highest-confidence records; stable on the union order for ties.
      const ranked = sells
        .map((t, i) => ({ t, i }))
        .sort((a, b) => sellConfidence(a.t) - sellConfidence(b.t) || a.i - b.i);
      const keptQtys: number[] = [];
      for (const { t } of ranked) {
        const qty = qtyOf(t.quantity);
        const twin = excess > 1e-9 && qty <= excess + 1e-9
          ? ranked.find(r => r.t !== t && qtyOf(r.t.quantity) === qty && keptQtys.includes(qtyOf(r.t.quantity)))
          : undefined;
        if (twin) {
          out.push({
            date, symbol, quantity: t.quantity,
            keptPrice: twin.t.avgPrice, droppedPrice: t.avgPrice,
            phantomProceeds: qty * (parseFloat(t.avgPrice) || 0),
            dropKey: `${date}|${tradeKey(t)}`,
          });
          excess -= qty;
          continue;
        }
        keptQtys.push(qty);
      }
    }
  }
  return out;
}

// Picks which of two same-date runs is the canonical record. A day can hold both
// the main daily-trade run AND a thin intraday secondary run (stop-loss /
// drop-check / earnings-exit). The OLD dedup kept whichever had the later
// timestamp — which is almost always the thin secondary run, silently discarding
// the main run's full trade set AND its correct, transfer-adjusted return. (A thin
// run can't recompute the day's return: it only carries its own one trade, so
// computeDailyReturn undercounts tradeNetCash and inflates P&L.) Prefer the richer
// record instead: a run that already has a computed agenticDailyReturn wins, then
// the one with more trades, then the later timestamp as a final tiebreak.
function preferRun(a: TradeRun, b: TradeRun): TradeRun {
  const aHasReturn = a.agenticDailyReturn != null;
  const bHasReturn = b.agenticDailyReturn != null;
  if (aHasReturn !== bHasReturn) return aHasReturn ? a : b;
  const aTrades = (a.trades ?? []).length;
  const bTrades = (b.trades ?? []).length;
  if (aTrades !== bTrades) return aTrades > bTrades ? a : b;
  return a.timestamp >= b.timestamp ? a : b;
}

// A position cannot survive a same-day sell that disposed of it. When an intraday
// stop-loss / take-profit / drop-check run sells a holding AFTER the main daily run
// already snapshotted it, the merged record keeps the main run's positions (which
// still list the sold symbol) while only unioning in the sell trade. Left
// unreconciled, that stale holding becomes the NEXT day's return baseline — the
// position's full value shows up as phantom P&L (~5% on a typical name) — or gets
// re-inferred as a duplicate sell by patchTrades the following day.
//
// Drop any position whose symbol was sold this day in a quantity >= the held
// quantity. This momentum strategy never sells then re-buys the same name the same
// day, so an equal-or-greater-qty same-day sell unambiguously means the holding is
// gone. (A genuine post-trade snapshot already excludes sold names, so the only
// positions this touches are ones a later intraday exit left stranded.)
/** How much of a symbol the day's trades moved, and what the day STARTED from. */
interface DayFlow {
  sold: Map<string, number>;
  bought: Map<string, number>;
  /** Previous date's holdings, or null when UNKNOWN — the day is outside the window, or its
   *  snapshot is empty (a thin intraday run carries none, which is not a baseline of zero). */
  prev: Map<string, number> | null;
}

/** Fractional shares mean exact equality is unsafe; this is well below any real trade size. */
const QTY_EPSILON = 1e-4;

/**
 * Brings a day's positions snapshot into line with the day's trades — but ONLY when the snapshot
 * demonstrably hasn't caught up with them.
 *
 * The decision is made per symbol by ARITHMETIC, not by timestamps:
 *
 *     expected = max(0, prevHeld + boughtToday - soldToday)
 *
 * If the snapshot already equals `expected`, it was taken after the trades and is ground truth —
 * leave it alone. If it doesn't, the snapshot is stale (the classic case: the 7:30 run snapshots
 * SMCI, a noon stop sells it, and the merge keeps 7:30's positions), so `expected` replaces it, and
 * a position that reconciles to zero is dropped.
 *
 * HISTORY — two bugs this shape is chosen to avoid:
 *  - Before 2026-09-15 this compared `sold >= snapshotQuantity`. Snapshots are post-trade, so that
 *    quantity is the REMAINDER, and any trim of >=50% satisfied it and deleted the whole lot. TRGP
 *    was trimmed exactly 50% and vanished: the dashboard ran ~$108 short and heldDaysOf read 0
 *    against a true 14 days, silently resetting the 15-day STALE clock on any trimmed position.
 *  - The first fix keyed off "was this sell recorded by a run newer than the snapshot?", which a
 *    re-reported fill defeats — this repo already records the same fill twice from two runs
 *    (findReRecordedSells, the TER 07-27 incident), and the later copy made the trim look
 *    post-snapshot again. Quantities can't be fooled that way, and sells are deduped by trade key
 *    below so a twin is never counted twice.
 *
 * With no previous-day baseline (it fell outside the caller's window) the snapshot is trusted
 * unchanged: reconciling against an unknown baseline is exactly what caused the deletions above.
 */
function reconcilePositions(run: TradeRun, flow?: DayFlow): TradeRun {
  if (!flow || flow.sold.size === 0) return run;

  /**
   * What the symbol was held at before today, or null when that genuinely can't be known.
   *
   * A previous snapshot that EXISTS but omits the symbol returns 0 — that is evidence it was not
   * held, and it is what makes the routine buy-and-stop-out-same-day case reconcile. A NULL
   * previous snapshot (the oldest date in the caller's window, or a previous date whose only run
   * carried no positions) returns null: absence of evidence, never treated as zero.
   *
   * There is deliberately NO carve-out for "bought today". Two attempts at one were reverted
   * because both deleted real holdings: "bought today implies zero before" is simply false, and
   * the post-sell form of the test (`snapshotQty <= bought`) passes whenever a hidden prior
   * holding is smaller than the amount sold. See the refusals on reconcilePositions below.
   */
  const baselineOf = (symbol: string): number | null =>
    flow.prev ? (flow.prev.get(symbol) ?? 0) : null;

  /**
   * Bring one position into line with the day's trades, but ONLY on evidence.
   *
   *     expected = prevHeld + boughtToday - soldToday
   *
   * Equal to the snapshot -> it was taken after the trades and is ground truth; leave it.
   * Otherwise the snapshot is stale -> correct it down to `expected`, dropping at zero.
   *
   * Three refusals, each from a bug this function has actually shipped:
   *  - Never RAISE a quantity. `expected` derives from the previous snapshot, which can itself be
   *    overstated, and inventing equity feeds the next day's return baseline.
   *  - Never act on an impossible sale (sold > prevHeld + bought). That means the trade record is
   *    corrupt — usually one fill written twice by two same-date runs at different price estimates,
   *    which tradeKey cannot collapse and findReRecordedSells does not catch in every shape.
   *  - Never act without a baseline. A previous snapshot that EXISTS but omits the symbol is
   *    evidence it was not held; a NULL snapshot is merely absence of evidence, and treating the
   *    two alike erased 10 of 12 held TSLA shares.
   */
  const adjust = (p: PositionSnapshot): PositionSnapshot | null => {
    const sold = flow.sold.get(p.symbol) ?? 0;
    if (sold <= 0) return p;                        // untouched by today's sells
    const snapshotQty = parseFloat(p.quantity) || 0;
    const bought = flow.bought.get(p.symbol) ?? 0;

    // No previous snapshot, no reconciliation. A carve-out for the same-day buy-and-stop-out shape
    // was tried and removed: it tested `snapshotQty <= bought`, but the snapshot is POST-SELL, so a
    // hidden prior holding H makes it H + bought - sold and the test passes whenever H <= sold —
    // then `expected = bought - sold` erased H. An evidence-only form (`snapshotQty + sold <=
    // bought`) cannot distinguish registry #72's STALE snapshot (4 held / 4 bought / 4 sold) from a
    // genuine H = 4, so the carve-out was deciding an ambiguous case by DELETING. This file's rule
    // is the opposite, and the one-day residual is the price of honouring it.
    const prevQty = baselineOf(p.symbol);
    if (prevQty == null) return p;
    if (sold > prevQty + bought + QTY_EPSILON) return p;   // impossible sale → the record is corrupt
    const expected = Math.max(0, prevQty + bought - sold);

    if (Math.abs(snapshotQty - expected) <= QTY_EPSILON) return p; // already reflects the trades
    if (expected >= snapshotQty) return p;                         // never raise
    return expected <= QTY_EPSILON ? null : { ...p, quantity: expected.toFixed(6) };
  };

  const mapPositions = (list: PositionSnapshot[] | undefined) => {
    if (!list) return undefined;
    const out: PositionSnapshot[] = [];
    let changed = false;
    for (const p of list) {
      const next = adjust(p);
      if (next === null) { changed = true; continue; }
      if (next !== p) changed = true;
      out.push(next);
    }
    return changed ? out : list;
  };

  const positions = mapPositions(run.positions ?? []) ?? [];
  const influencerPositions = mapPositions(run.influencerPositions);
  if (positions === (run.positions ?? []) && influencerPositions === run.influencerPositions) return run;
  return {
    ...run,
    positions,
    ...(influencerPositions !== undefined ? { influencerPositions } : {}),
  };
}

// Collapses runs to one canonical record per date. Keeps the richer run (see
// preferRun) but unions in the dropped run's trades so no fill is lost from
// history, then reconciles positions against the day's sells (see
// reconcilePositions). Pure + side-effect free so it can be unit-tested without Redis.
export function mergeRunsByDate(all: TradeRun[]): TradeRun[] {
  // Provably-impossible sell records (the same fill written twice by two same-date runs).
  // Dropped BEFORE reconcilePositions so the position reconciliation and every downstream
  // return calc see one record per real fill. Never silent — logged for the Vercel logs,
  // and surfaced in the 8am email by dashboard-reconcile's re-recorded-sell check.
  const reRecorded = findReRecordedSells(all);
  const dropKeys = new Set(reRecorded.map(d => d.dropKey));
  if (reRecorded.length > 0) {
    console.warn("RE_RECORDED_SELL_DROPPED", reRecorded.map(d =>
      `${d.date} ${d.symbol} x${d.quantity} @${d.droppedPrice} (duplicate of @${d.keptPrice}, +$${d.phantomProceeds.toFixed(2)} phantom proceeds)`));
  }

  const byDate = new Map<string, TradeRun>();
  // Track the most-recent NON-EMPTY positions snapshot per date, keyed off the
  // ORIGINAL run timestamps (not the merged base's, which carries preferRun's
  // chosen timestamp and could be earlier than a later run's snapshot).
  const posSourceByDate = new Map<string, TradeRun>();
  for (const run of all) {
    if ((run.positions?.length ?? 0) > 0) {
      const cur = posSourceByDate.get(run.date);
      if (!cur || run.timestamp > cur.timestamp) posSourceByDate.set(run.date, run);
    }
    const existing = byDate.get(run.date);
    if (!existing) {
      byDate.set(run.date, { ...run, trades: [...(run.trades ?? [])] });
      continue;
    }
    const winner = preferRun(existing, run);
    const other = winner === existing ? run : existing;
    // Clone the winner before mutating so we never write back into a caller's input
    // object (`existing` is already a fresh clone from the first-seen branch; `run`
    // is raw). Keeps mergeRunsByDate pure, as its docstring promises.
    const base = winner === existing ? winner : { ...winner, trades: [...(winner.trades ?? [])] };
    base.trades = unionTrades(base.trades ?? [], other.trades ?? []);
    // Buy-sizing notes are per-run EVENTS (a drop/shrink happened when THAT run placed buys), so
    // UNION them across same-date runs rather than letting preferRun pick one — otherwise a drop
    // note on the losing run vanishes and the "a drop is never silent" guarantee breaks on a
    // two-full-run day. Deduped so re-merging an already-merged run can't accumulate copies.
    const mergedSizing = [...new Set([...(base.buySizingAdjustments ?? []), ...(other.buySizingAdjustments ?? [])])];
    if (mergedSizing.length > 0) base.buySizingAdjustments = mergedSizing;
    byDate.set(run.date, base);
  }
  // Position snapshot: when BOTH same-date runs are full runs (e.g. the 7:30
  // rotation AND an 8am stop-loss exit that ALSO opened a new position), the
  // richer run (preferRun, chosen for its computed return) may carry the EARLIER,
  // now-stale holdings — missing a name the later run bought. reconcilePositions
  // only drops sold names, never adds bought ones, so that name would silently
  // vanish from the canonical snapshot and resurface as phantom equity in the next
  // day's return baseline. Overlay the latest non-empty snapshot as ground truth
  // (a thin intraday exit has empty positions, so it can never override a full
  // run's snapshot — the SMCI/06-24 case still holds).
  for (const [date, base] of byDate) {
    const src = posSourceByDate.get(date);
    if (src && src !== base) {
      base.positions = [...src.positions];
      if (src.influencerPositions) base.influencerPositions = [...src.influencerPositions];
      // Book β is computed against a specific holdings snapshot — carry it from whichever run
      // supplies the positions above, so the merged run's β always describes the book it shows.
      if (src.bookBeta !== undefined) base.bookBeta = src.bookBeta;
    }
  }
  // Apply the re-recorded-sell drops FIRST, then derive each day's flow from the resulting
  // canonical trade list. Deriving it from the raw runs instead was a real bug: tradeKey includes
  // avgPrice, and a re-recorded twin differs in exactly that field (it is why findReRecordedSells
  // exists), so a twin was never deduped, its quantity counted twice, and a still-held trim
  // remainder deleted. unionTrades has already collapsed true duplicates here.
  const canonical = [...byDate.values()].map(r => dropKeys.size === 0
    ? r
    : { ...r, trades: (r.trades ?? []).filter(t => !dropKeys.has(`${r.date}|${tradeKey(t)}`)) });

  const datesAscending = [...canonical].map(r => r.date).sort();
  const byDateCanonical = new Map(canonical.map(r => [r.date, r]));
  // Reconcile OLDEST-FIRST and feed each corrected day forward, so a stale earlier snapshot is
  // fixed before it is used as the next day's baseline rather than propagating.
  const reconciledByDate = new Map<string, TradeRun>();
  for (let i = 0; i < datesAscending.length; i++) {
    const date = datesAscending[i];
    const run = byDateCanonical.get(date)!;
    const sold = new Map<string, number>();
    const bought = new Map<string, number>();
    for (const t of run.trades ?? []) {
      const target = t.side === "sell" ? sold : bought;
      target.set(t.symbol, (target.get(t.symbol) ?? 0) + (parseFloat(t.quantity) || 0));
    }
    const prevDate = i > 0 ? datesAscending[i - 1] : null;
    const prevRun = prevDate ? reconciledByDate.get(prevDate) : null;
    // An EMPTY previous snapshot is NOT a baseline of zero — a thin intraday stop/drop-check run
    // legitimately carries no positions, and reading that as "held nothing yesterday" deleted a
    // trimmed position outright. Absent or empty both mean UNKNOWN.
    const prevPositions = prevRun?.positions ?? [];
    const prev = prevPositions.length > 0
      ? new Map(prevPositions.map(p => [p.symbol, parseFloat(p.quantity) || 0]))
      : null;
    reconciledByDate.set(date, reconcilePositions(run, { sold, bought, prev }));
  }

  return [...reconciledByDate.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function dedupeRuns(): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");
  const all = await getRuns(MAX_RUNS);
  const deduped = mergeRunsByDate(all);
  // Safety: never let a logic slip turn this history-rewriting call into a wipe.
  if (all.length > 0 && deduped.length === 0) {
    throw new Error("dedupeRuns: refusing to write empty run list");
  }
  const pipeline = [
    ["DEL", RUNS_KEY],
    ...deduped.map(r => ["RPUSH", RUNS_KEY, JSON.stringify(r)]),
  ];
  await redisPost("pipeline", pipeline);
  return all.length - deduped.length;
}

// Computes transfer-adjusted daily return for one account.
// Falls back to simple total-value change when position prices are unavailable
// (e.g. non-S&P holdings like SERV that aren't in the price map).
/**
 * Trades that make a day's return uncomputable: no recorded fill price AND no position left today
 * to price them from. A buy or a PARTIAL sell still has a position in today's snapshot, so it can
 * be marked to market; a sell that fully closed a position cannot (see computeDailyReturn).
 *
 * Exported so the trade route reports exactly the trades that actually blocked the calculation,
 * rather than re-deriving a looser rule and naming ones that were priced fine.
 */
export function findUnpriceableTrades(
  todayPositions: PositionSnapshot[],
  trades: TradeSnapshot[],
): TradeSnapshot[] {
  const stillHeld = new Set(todayPositions.map(p => p.symbol));
  return trades.filter(t => !(parseFloat(t.avgPrice) > 0) && !stillHeld.has(t.symbol));
}

export function computeDailyReturn(
  todayValue: number,
  yesterdayValue: number,
  todayPositions: PositionSnapshot[],
  yesterdayPositions: PositionSnapshot[],
  todayTrades: TradeSnapshot[]
): { dailyReturn: number; impliedTransfer: number } | null {
  if (yesterdayValue <= 0) return null;

  // Always use the transfer-aware, position-level formula. If a single position is
  // missing a live price (e.g. a freshly-listed non-S&P name), fall back to its
  // avgCost FOR THAT POSITION rather than abandoning the whole calc. Abandoning it
  // (the old behavior) routed to a total-value diff that counts DEPOSITS as return —
  // so a deposit on a day a price was missing would show as a huge fake gain.
  const priceOf = (p: PositionSnapshot) => {
    const price = parseFloat(p.price);
    return price > 0 ? price : (parseFloat(p.avgCost) || 0);
  };
  const posValToday = todayPositions.reduce((s, p) => s + parseFloat(p.quantity) * priceOf(p), 0);
  const posValYesterday = yesterdayPositions.reduce((s, p) => s + parseFloat(p.quantity) * priceOf(p), 0);

  // Include ALL placed trades — Claude emits state "submitted", not "filled",
  // so filtering by state would zero out tradeNetCash and overstate P&L on trade days.
  // A trade with no usable price must NOT silently contribute 0. `|| 0` was tried and is worse than
  // the NaN it replaced: the position a $200 pending buy created still counts in posValToday, so
  // dropping its cost from tradeNetCash inflates pnl by the full notional — ~+10% on a $2k book,
  // comfortably under the autopilot's |return| > 30% alarm and compounded into the dashboard index
  // forever. NaN at least failed loudly. Fall back to the position's own snapshot price; if even
  // that is unavailable the day is UNPRICEABLE and returns null, which the existing
  // /api/debug?patchDate path is built to repair.
  // A snapshot price may stand in for a missing fill price EXCEPT on a sell that CLOSED the
  // position. The distinction is arithmetic, not a heuristic:
  //   - Position still held today (a buy, or a partial sell): the symbol is in todayPositions, so
  //     the substitute is TODAY's mark and the day's contribution works out to
  //     fullQty·(todayPrice − yesterdayPrice) — the correct mark-to-market.
  //   - Position fully closed: the symbol is absent from todayPositions, so the only substitute is
  //     YESTERDAY's price, and the contribution qty·(fill − yesterday) collapses to exactly ZERO —
  //     booking neither gain nor loss. Sells here are overwhelmingly stop-outs and drop-check
  //     exits, i.e. declines, so that would systematically erase losses and bias the stored return
  //     upward, silently, with no alert possible because the result is no longer null.
  // Only the closed case has no honest proxy, and only it makes the day uncomputable.
  const priceBySymbol = new Map<string, number>();
  for (const p of yesterdayPositions) priceBySymbol.set(p.symbol, priceOf(p));
  for (const p of todayPositions) priceBySymbol.set(p.symbol, priceOf(p)); // today wins where both exist
  const stillHeldToday = new Set(todayPositions.map(p => p.symbol));
  const unpriced: string[] = [];
  const tradeNetCash = todayTrades.reduce((s, t) => {
    const qty = parseFloat(t.quantity) || 0;
    let price = parseFloat(t.avgPrice);
    if (!(price > 0)) {
      price = stillHeldToday.has(t.symbol) ? (priceBySymbol.get(t.symbol) ?? 0) : 0;
      if (!(price > 0)) { unpriced.push(`${t.side} ${t.symbol}`); return s; }
      console.warn("TRADE_PRICE_SUBSTITUTED", { symbol: t.symbol, side: t.side, price });
    }
    return s + (t.side === "buy" ? qty * price : -(qty * price));
  }, 0);
  if (unpriced.length > 0) {
    // NOT silently null. /api/debug?patchDate recomputes from these SAME stored trades and never
    // re-derives avgPrice, so it can never repair this — the autopilot would call it every run and
    // fail forever while nothing raised an issue (the |return| > 30% alarm only fires on a NON-null
    // return). Meanwhile the dashboard compounds SPY continuously but skips the agent's null day,
    // silently biasing the headline AI-vs-SPY comparison by a full day's move. A permanent hole in
    // the track record has to be loud — this is the 07-27 harm recorded in the registry.
    console.error("DAILY_RETURN_UNPRICEABLE", { unpriced });
    return null;
  }

  const pnl = (posValToday - posValYesterday) - tradeNetCash;
  const impliedTransfer = todayValue - yesterdayValue - pnl;
  return { dailyReturn: pnl / yesterdayValue, impliedTransfer };
}

// Splits a run into influencer-sleeve vs main-sleeve daily returns from a SINGLE definition
// of which trades belong to which sleeve — so the trade route and the recompute/backfill path
// can't drift. A symbol belongs to the influencer sleeve's P&L if it was influencer YESTERDAY
// OR today. That union is the fix for a real bug: influencerSymbols excludes anything sold
// today, so a position sold OUT of the sleeve lost its sell trade from the reconciliation and
// its whole prior value booked as a phantom loss (BTC on 2026-06-30 → bogus −14.13%; the same
// sell also leaked into the main book). Callers pass the already-derived sleeve membership;
// this only computes the two returns given that membership.
export function computeSleeveReturns(
  positions: PositionSnapshot[],
  trades: TradeSnapshot[],
  influencerPositions: PositionSnapshot[],
  prevInfluencerPositions: PositionSnapshot[],
  prevPositions: PositionSnapshot[],
): { influencerDailyReturn: number | null; mainDailyReturn: number | null } {
  const priceOf = (p: PositionSnapshot) => parseFloat(p.price) > 0 ? parseFloat(p.price) : (parseFloat(p.avgCost) || 0);
  const value = (ps: PositionSnapshot[]) => ps.reduce((s, p) => s + parseFloat(p.quantity) * priceOf(p), 0);

  // A symbol belongs to the influencer sleeve if it was influencer YESTERDAY or TODAY. Partition
  // BOTH days' positions AND the trades by this same set, so every symbol lives in exactly one
  // sleeve across the two compared days. This keeps the day-over-day P&L self-consistent through
  // a sleeve change: a name SOLD out of the sleeve keeps its sell (BTC 06-30), and a name that
  // MIGRATES in via a partial influencer buy (e.g. PLTR — both S&P and an influencer pick) carries
  // its prior-day value into the influencer base instead of booking a phantom loss in main.
  const influencerUniverse = new Set([
    ...influencerPositions.map(p => p.symbol),
    ...prevInfluencerPositions.map(p => p.symbol),
  ]);
  const isInfluencer = (sym: string) => influencerUniverse.has(sym);

  const influToday = positions.filter(p => isInfluencer(p.symbol));
  const influYesterday = prevPositions.filter(p => isInfluencer(p.symbol));
  const mainToday = positions.filter(p => !isInfluencer(p.symbol));
  const mainYesterday = prevPositions.filter(p => !isInfluencer(p.symbol));

  // Tiny-denominator guard: a sleeve REBUILT from cash (prior-day book a negligible
  // fraction of today's) has no meaningful daily % — a sub-dollar real P&L divided by a
  // near-zero base amplifies into a large phantom return. This is directional: it fires
  // only on cash-deployment GROWTH days (2026-07-10 main: prior book $33.60 was 1.6% of
  // today's $2,038 → −2.05% phantom), NOT on liquidation days (prior book is large, base
  // is fine) or normal add days (prior book stays well above the threshold). The 10% floor
  // means the sleeve grew >10x in a day — that's a rebuild, not management. Tunable.
  //
  // Deliberately RELATIVE-only (no absolute dollar floor): the influencer sleeve is
  // legitimately small — a BTC-only sleeve is ~$28 — so any absolute floor big enough to
  // matter would null that sleeve's real returns every day. A sub-dollar base (where a
  // relative-only test could still amplify) can't occur here: the smallest real position
  // is one whole/fractional share worth ~$28. Do NOT add an absolute floor without solving
  // the small-sleeve case first.
  const materialBase = (today: PositionSnapshot[], yst: PositionSnapshot[]) =>
    value(yst) >= 0.10 * value(today);

  // AN EXIT DAY IS A REAL DAY. Requiring positions TODAY used to be part of this test, which
  // silently deleted every day a sleeve was fully closed out — and a sleeve empties precisely when
  // its positions are stopped out (-5%), knocked out by the drop-check, or exited on bad news.
  // Those are LOSS days by construction, so dropping them is not neutral: the holding days keep
  // their gains while the exits that paid for them vanish. Measured over the 30 stored runs, the
  // influencer sleeve read +2.87% with exit days dropped and -6.79% with them counted — a 9.7-point
  // overstatement, all in the flattering direction (2026-08-28 PYPL/IMAX -7.32% and 2026-09-10 CRM
  // -2.23% were both discarded). It is the same defect as the SPCX round-trip the % index lost in
  // July, which is recorded as "the compounded-% approach fundamentally can't show the sleeve
  // honestly" — it can, once the exits are in it.
  //
  // The day is perfectly computable: computeDailyReturn divides by YESTERDAY's value, so an empty
  // book today is just `pnl = proceeds - yesterdayValue`. Only the YESTERDAY side must be non-empty
  // (a zero denominator), which is the guard that remains. If the sells are missing from the record
  // the result is ~-100%, and clampSleeveReturn still nulls it rather than publishing a phantom.
  const sleeveReturn = (today: PositionSnapshot[], yst: PositionSnapshot[], tr: TradeSnapshot[]) =>
    yst.length > 0 && materialBase(today, yst)
      ? computeDailyReturn(value(today), value(yst), today, yst, tr)
      : null;

  const influencer = sleeveReturn(influToday, influYesterday, trades.filter(t => isInfluencer(t.symbol)));
  const main = sleeveReturn(mainToday, mainYesterday, trades.filter(t => !isInfluencer(t.symbol)));

  return {
    influencerDailyReturn: influencer?.dailyReturn ?? null,
    mainDailyReturn: main?.dailyReturn ?? null,
  };
}

// Backfill / correct influencer + main sleeve daily returns across ALL stored history using
// the corrected computeSleeveReturns attribution. Only the canonical daily run per date (the
// one carrying agenticDailyReturn — the run mergeRunsByDate/preferRun surfaces) gets a sleeve
// return, so the dashboard's per-date compounding stays one-point-per-date. Each canonical run
// is recomputed against the previous canonical run's snapshots (matching production's day-over-
// day baseline). Returns a human-readable change log; writes the full list atomically.
// A single-day sleeve move beyond this is almost certainly a residual data artifact, not a real
// return (the sleeves are small/volatile but not THIS volatile — a phantom −51.25% appeared 2026-08-28
// when an influencer name was stopped out intraday by the drop-check and its proceeds weren't credited
// in the trade run's own trades). Drop to null rather than stamp a number that would distort the
// compounded track record. Applied at BOTH the live write AND the recompute so a phantom never reaches
// the dashboard raw. Tunable.
export const SLEEVE_EXTREME_RETURN = 0.5;
export const clampSleeveReturn = (x: number | null): number | null =>
  x != null && Math.abs(x) > SLEEVE_EXTREME_RETURN ? null : x;

export async function backfillSleeveReturns(): Promise<string[]> {
  const all = await getRuns(MAX_RUNS); // newest-first
  const changes: string[] = [];
  // Drop provably-impossible re-recorded sells (same fill written twice) before recomputing sleeve
  // returns, so a phantom proceeds figure can't distort a sleeve's day — the same correction
  // mergeRunsByDate + patchDate apply. Without this, the 07-27 double-recorded TER sell would keep
  // poisoning the MAIN sleeve's return even after the agentic return was fixed.
  const dropKeys = new Set(findReRecordedSells(all).map(d => d.dropKey));
  const dedupTrades = (run: TradeRun) =>
    dropKeys.size === 0 ? (run.trades ?? []) : (run.trades ?? []).filter(t => !dropKeys.has(`${run.date}|${tradeKey(t)}`));
  const fmt = (x: number | null | undefined) => x == null ? "null" : (x * 100).toFixed(2) + "%";
  const approxEq = (a: number | null, b: number | null) =>
    (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
  const sane = clampSleeveReturn;

  const patched = all.map(run => {
    if (run.agenticDailyReturn == null) return run; // non-canonical (thin intraday) run — leave untouched
    // Same baseline agenticDailyReturn used at trade time: the newest run of any earlier DATE
    // (getPreviousDayRun semantics) — NOT the previous canonical run — so sleeve + agentic returns
    // share one baseline. `all` is newest-first, so find() returns that run.
    const prev = all.find(r => r.date < run.date);
    if (!prev) return run; // first return-bearing run has no prior baseline
    const raw = computeSleeveReturns(
      run.positions ?? [],
      dedupTrades(run),
      run.influencerPositions ?? [],
      prev.influencerPositions ?? [],
      prev.positions ?? [],
    );
    const influencerDailyReturn = sane(raw.influencerDailyReturn);
    const mainDailyReturn = sane(raw.mainDailyReturn);
    const oldI = run.influencerDailyReturn ?? null;
    const oldM = run.mainDailyReturn ?? null;
    if (!approxEq(oldI, influencerDailyReturn) || !approxEq(oldM, mainDailyReturn)) {
      changes.push(`${run.date}: infl ${fmt(oldI)}→${fmt(influencerDailyReturn)}, main ${fmt(oldM)}→${fmt(mainDailyReturn)}`);
    }
    return { ...run, influencerDailyReturn, mainDailyReturn };
  });

  // Safety before the DEL+RPUSH rewrite: refuse to write unless every original run is still
  // present and well-formed (guards a future map→filter slip or a dropped/undefined entry).
  const ok = all.length > 0 && patched.length === all.length && patched.every(r => r && typeof r.date === "string" && r.timestamp);
  if (changes.length > 0) {
    if (!ok) throw new Error("backfillSleeveReturns: integrity check failed — refusing to rewrite history");
    const pipeline = [
      ["DEL", RUNS_KEY],
      ...patched.map(r => ["RPUSH", RUNS_KEY, JSON.stringify(r)]),
    ];
    await redisPost("pipeline", pipeline);
  }
  return changes;
}

// Updates a specific run by date, applying an updater function. Rewrites the FULL list.
// MUST read MAX_RUNS, not a literal: this DELs the key and RPUSHes back whatever it read, so any
// record beyond the read window is permanently destroyed. A hardcoded 90 was lossless only while
// 90 WAS MAX_RUNS — raising the cap turned every patch call into a silent truncation.
export async function updateRunByDate(date: string, updater: (run: TradeRun) => TradeRun): Promise<boolean> {
  const all = await getRuns(MAX_RUNS);
  const idx = all.findIndex(r => r.date === date);
  if (idx < 0) return false;
  all[idx] = updater(all[idx]);
  const pipeline = [
    ["DEL", RUNS_KEY],
    ...all.map(r => ["RPUSH", RUNS_KEY, JSON.stringify(r)]),
  ];
  await redisPost("pipeline", pipeline);
  return true;
}

// Idempotency guard for the autopilot email — one send per calendar date.
const AUTOPILOT_SENT_PREFIX = "robinhood:autopilot:sent:";

export async function hasAutopilotSentToday(date: string): Promise<boolean> {
  try {
    const result = await redisCommand("get", `${AUTOPILOT_SENT_PREFIX}${date}`);
    return result === "1";
  } catch {
    return false;
  }
}

export async function markAutopilotSent(date: string): Promise<void> {
  try {
    // EX 90000 = 25 hours — expires well before the next day's run
    await redisCommand("set", `${AUTOPILOT_SENT_PREFIX}${date}`, "1", "EX", 90000);
  } catch {
    // Non-fatal — worst case we send a duplicate on a Redis blip
  }
}

// Persist the 8am skeptical-reviewer output so the cloud fixer can consume it as its WORK LIST.
// Without this the concerns are emailed then thrown away, and the cloud agent (which calls
// /api/autopilot AFTER the email already sent) gets a bare skip response with no concerns — so it
// re-reviews from scratch, reaches weaker conclusions, and proposes nothing (the 08-07 ILMN/ROST miss).
const AUTOPILOT_CONCERNS_PREFIX = "robinhood:autopilot:concerns:";

export async function storeAutopilotConcerns(date: string, payload: unknown): Promise<void> {
  try {
    await redisCommand("set", `${AUTOPILOT_CONCERNS_PREFIX}${date}`, JSON.stringify(payload), "EX", 172800); // 48h
  } catch { /* non-fatal — the cloud agent falls back to its own review */ }
}

export async function getStoredAutopilotConcerns(date: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await redisCommand("get", `${AUTOPILOT_CONCERNS_PREFIX}${date}`);
    return typeof r === "string" ? (JSON.parse(r) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The run summary carries the model's ACTUAL reasoning, and the 8am email is the only place most of
// it is ever read. The email's old `slice(0, 800)` was wrong in two compounding ways: 800 chars is
// less than the main-book hold/sell review alone, and that review prints FIRST — so the INFLUENCER
// and BUY reasoning, the part explaining why a name was bought over its competitors, was reliably
// the part cut. On 2026-10-02 the email ended mid-word ("- No h") and the AVGO-vs-MU decision
// (MU scored 6, AVGO 4, one sleeve slot free) was never shown at all.
//
// Truncation and ESCAPING are deliberately one function rather than two composable ones, so the
// unescaped variant is not available to a future caller. The summary is model-written prose
// interpolated into email HTML, and nothing in this repo escaped it before: a single `<` in a line
// like "P/E <18 but momentum broke" makes the mail client swallow everything up to the next `>` —
// which is the section's own `</p>`. That silently deletes the rest of the reasoning, i.e. exactly
// the failure this function exists to prevent, and widening 800 → 6000 widened the exposure with it.
//
// Order matters: truncate on the RAW text so the dropped-char count is honest, then escape (escaping
// first would let the cut land inside an entity). `&` must be replaced before `<`/`>` or the escapes
// would themselves be re-escaped.
export const SUMMARY_EMAIL_LIMIT = 6000;

// Exported because the summary is NOT the only model-written field interpolated into the email:
// the skeptical reviewer's title/detail are LLM prose AND the reviewer is fed the run summary
// (lib/autopilot-review.ts), so the very `<` this neutralizes comes straight back through there and
// would swallow the rest of the concerns list — a higher-priority section than the summary itself.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSummaryForEmail(summary: string, limit: number = SUMMARY_EMAIL_LIMIT): string {
  const truncated = summary.length <= limit
    ? summary
    : `${summary.slice(0, limit)}\n\n[… truncated ${summary.length - limit} of ${summary.length} chars — open the dashboard for the full reasoning]`;
  return escapeHtml(truncated);
}

/**
 * Which sleeve a SELL belongs to.
 *
 * The original implementation looked for the symbol's BUY in the PREVIOUS RUN only — but a position
 * is bought days or weeks before it is sold, so that run almost never contains it. Result: 67 of 81
 * historical sells carried no strategy at all, which makes per-sleeve realised P&L uncomputable
 * (positions never net to closed, so every one reads as still open).
 *
 * `influencerPositions` on the prior run is the authoritative record of which HOLDINGS are sleeve
 * positions — it is what computeSleeveReturns already partitions on — so membership there decides.
 * The buy-history scan remains only as a fallback for runs predating that field.
 *
 * Returns "main" rather than undefined when nothing is known: main is the overwhelming default, and
 * an untagged sell is what caused the problem. Note the limit of that trade-off — a wrong tag is
 * NOT actually visible: the dashboard renders a 📺 only for "influencer" (so a mis-tagged sleeve
 * exit shows as an absent emoji, which nobody notices) and autopilot-review coerces
 * `strategy ?? "main"`, so it cannot tell a stamped "main" from a missing one either. The case for
 * stating it is consistency — every other path answers this question the same way — not
 * detectability. A missing tag still silently breaks the accounting, which is the worse of the two.
 */
export function inferSellStrategy(
  symbol: string,
  prevInfluencerPositions: PositionSnapshot[] | undefined,
  recentBuys: TradeSnapshot[] = [],
): "main" | "influencer" {
  // Present-but-empty is meaningful (the sleeve held nothing); absent means the run predates the
  // field and cannot answer, so fall through to the buy history.
  if (prevInfluencerPositions) {
    return prevInfluencerPositions.some(p => p.symbol === symbol) ? "influencer" : "main";
  }
  const buy = recentBuys.find(t => t.side === "buy" && t.symbol === symbol && t.strategy);
  return buy?.strategy === "influencer" ? "influencer" : "main";
}

/** Why a symbol's change could not be turned into a sell record. */
export type UnreconstructableReason =
  /**
   * Share count rose by more than the records explain — an unrecorded BUY, the mirror of the case
   * this function repairs. Deliberately NOT reconstructed: a sell can be priced at the held run's
   * mark because the shares left at whatever the market gave, but inventing a buy fabricates a COST
   * BASIS and spends cash nothing accounted for.
   */
  | "shares-appeared"
  /**
   * A quantity string that will not parse, or is negative. Treating it as 0 is the FAIL-OPEN branch
   * and the worst one available here: "we cannot read the holding" silently becomes "the holding is
   * zero", i.e. SELL EVERYTHING — measured, a today-side quantity of "", "abc" or "0" fabricated a
   * full exit of a still-held position. CLAUDE.md names this trap directly ("dropping a bad input is
   * usually the fail-OPEN branch"), so an unreadable count withholds instead.
   */
  | "unreadable-quantity"
  /**
   * Shares left but no row in the held run can price them — so there is no honest mark to use. Only
   * reachable for a symbol that was never a held position (it reaches the loop through the trade
   * records), where writing a sell meant persisting `avgPrice: "NaN"`.
   */
  | "no-usable-price";

/** What patchTrades should write, plus what it must NOT paper over. */
export type InferredSellPlan = {
  /** Reconstructed sells, ready to append. Always `state: "inferred"`. */
  sells: TradeSnapshot[];
  /**
   * Discrepancies this function refuses to invent a trade for. A non-empty list means the day's
   * INVENTORY disagrees with its records, so the caller must not publish a return computed from it
   * — see the patchTrades branch in /api/debug, which withholds the number and raises an issue
   * rather than recomputing around a known-wrong book.
   */
  unreconstructable: Array<{ symbol: string; reason: UnreconstructableReason; excessQty?: number }>;
};

/**
 * Reconstruct the SELL records implied by a position's share count falling between two runs.
 *
 * Extracted from /api/debug?patchTrades so the risky part is testable. Three things here are easy to
 * get wrong and silently corrupt the permanent history:
 *
 *   · WHICH RUN answers the sleeve question. It must be the run that still HELD the position
 *     (`heldRun`), never the run it is missing from — the latter's influencerPositions no longer
 *     contains it, so every sleeve exit would be tagged "main". Note that this is a WRONG tag, a
 *     different failure from the ABSENT tags that left 67 of 81 historical sells untagged (that was
 *     the prior tagger scanning the previous run's BUYS, which a weeks-old position is never in —
 *     see inferSellStrategy above). A wrong tag is the worse of the two: a missing one is at least
 *     re-derivable by planSellTagBackfill, which only ever fills a gap and never overwrites.
 *   · The price is an ESTIMATE — the held run's snapshot mark, not an observed fill. Callers must
 *     keep `state: "inferred"` on these so consumers that need real fills can exclude them;
 *     lib/slippage's collectFills does, and must continue to.
 *   · QUANTITY, not symbol membership, is the test. This was the bug until 2026-10-05: asking only
 *     whether a symbol had DISAPPEARED meant a partial sale reconstructed nothing, and
 *     computeDailyReturn then published a number it could not establish — measured, selling 5 of 10
 *     shares on a flat day stored -25.00% with a phantom +$500 transfer, and 1 of 10 stored -5.00%,
 *     under the autopilot's |return| > 30% alarm, so nothing fired and it compounded into the
 *     dashboard index permanently. A full exit is just the case where the shortfall happens to be
 *     the whole position; there was never a reason to treat it as the only case.
 *
 * The accounting identity, per symbol:
 *
 *     unexplained = heldQty + recordedBuyQty - recordedSellQty - qtyNow
 *
 * Positive ⇒ shares left without a sell on record ⇒ reconstruct one for exactly that many.
 * Negative ⇒ shares arrived without a buy on record ⇒ `unreconstructable` (see the type above).
 * Zero ⇒ the records already explain the change; nothing to do.
 *
 * Share counts are compared against the module's shared QTY_EPSILON rather than for equality —
 * fills are fractional ("1.743251"), so an exact test would manufacture dust sells.
 *
 * Previously-inferred sells are excluded from `recordedSellQty` so the plan is IDEMPOTENT: the
 * caller strips them, the shortfall recomputes to the same number, and a corrected estimate can
 * replace an earlier bad one. Buys are counted in every state, matching computeDailyReturn, which
 * includes all placed trades because the decision model emits "submitted" rather than "filled".
 *
 * The common case is no longer a timed-out sell session: it is the OWNER selling in the Robinhood
 * app, which the trade route cannot see at all. This path is the only record such a sell ever gets,
 * whether they sold the whole position or part of it.
 */
export function buildInferredSells(
  heldRun: Pick<TradeRun, "positions" | "influencerPositions" | "trades">,
  missingRun: Pick<TradeRun, "positions" | "trades">,
): InferredSellPlan {
  const sells: TradeSnapshot[] = [];
  const unreconstructable: InferredSellPlan["unreconstructable"] = [];

  /**
   * Share count for one symbol, or null when any contributing row is unreadable.
   *
   * Rows are SUMMED, not indexed: a run can legitimately carry the same symbol twice, and taking
   * the first row would under-count the holding and invent a sell for the difference.
   *
   * null rather than 0 on bad input is the whole point — see "unreadable-quantity" above. A
   * NEGATIVE count is treated as unreadable too: nothing here shorts, so it cannot be a holding,
   * and left alone it would ENLARGE the fabricated sale.
   */
  const sumQty = (rows: PositionSnapshot[], symbol: string): number | null => {
    let total = 0;
    for (const r of rows) {
      if (r.symbol !== symbol) continue;
      const q = parseFloat(r.quantity);
      if (!Number.isFinite(q) || q < 0) return null;
      total += q;
    }
    return total;
  };

  // Trade quantities. Buys are counted in EVERY state, matching computeDailyReturn, which includes
  // all placed trades because the decision model emits "submitted" rather than "filled". The
  // trade-off is pinned by a test: an order recorded but never filled makes the expected holding
  // too high, so the shortfall absorbs it. Keeping the two in step matters more than either rule on
  // its own — if they disagree, the sell records and the day's arithmetic describe different books.
  // Previously-inferred SELLS are excluded so the plan is idempotent (the caller strips them, the
  // shortfall recomputes to the same number, and a corrected estimate can replace a bad one).
  const tradeQty = (side: "buy" | "sell", symbol: string): number | null => {
    let total = 0;
    for (const t of missingRun.trades ?? []) {
      if (t.side !== side || t.symbol !== symbol) continue;
      if (side === "sell" && t.state === "inferred") continue;
      const q = parseFloat(t.quantity);
      if (!Number.isFinite(q) || q < 0) return null;
      total += q;
    }
    return total;
  };

  // Every symbol either run KNOWS ABOUT, positions and trades alike. Positions alone was a silent
  // hole: a recorded buy with no position row in either snapshot was never examined, so the day's
  // return booked the whole purchase as a loss while this reported "nothing to do" — and at
  // realistic proportions ($200 on a $2,000 book, ~-10%) that sits under the |return| > 30% alarm,
  // the exact silent shape this function exists to kill.
  const symbols = [...new Set([
    ...heldRun.positions.map(p => p.symbol),
    ...missingRun.positions.map(p => p.symbol),
    ...(missingRun.trades ?? []).map(t => t.symbol),
  ])];

  for (const symbol of symbols) {
    const heldQty = sumQty(heldRun.positions, symbol);
    const qtyNow = sumQty(missingRun.positions, symbol);
    const boughtQty = tradeQty("buy", symbol);
    const soldQty = tradeQty("sell", symbol);
    if (heldQty == null || qtyNow == null || boughtQty == null || soldQty == null) {
      unreconstructable.push({ symbol, reason: "unreadable-quantity" });
      continue;
    }

    const unexplained = heldQty + boughtQty - soldQty - qtyNow;
    if (unexplained < -QTY_EPSILON) {
      unreconstructable.push({ symbol, reason: "shares-appeared", excessQty: -unexplained });
      continue;
    }
    if (unexplained <= QTY_EPSILON) continue;

    // Price from the HELD run's row — the last mark before the shares left, never today's mark.
    // Sells reaching this path are overwhelmingly declines (stop-outs, drop-check exits, an owner
    // cutting a loser), so pricing them at a later mark would bias proceeds DOWN systematically.
    const row = heldRun.positions.find(p => p.symbol === symbol && parseFloat(p.price) > 0)
      ?? heldRun.positions.find(p => p.symbol === symbol);
    const price = parseFloat(row?.price ?? "") > 0 ? parseFloat(row!.price) : parseFloat(row?.avgCost ?? "");
    if (!Number.isFinite(price) || price <= 0) {
      // Reachable for a symbol that never was a held position — it arrived via the trade records,
      // so there is no row to price. Writing the record anyway persisted `avgPrice: "NaN"`, which
      // computeT1Drag then silently dropped from its estimate and the email rendered verbatim.
      unreconstructable.push({ symbol, reason: "no-usable-price", excessQty: unexplained });
      continue;
    }

    sells.push({
      symbol,
      side: "sell" as const,
      // The SHORTFALL, not the whole holding — for a full exit the two are the same number.
      // toFixed(6) is the broker's own precision: all 346 quantities across 30 runs of stored
      // history carry exactly 6 decimals, so this both matches the surrounding data and keeps a
      // full exit BYTE-IDENTICAL to the verbatim string the previous implementation wrote. Raw
      // String() does not: measured, 10 - 9.1 persisted "0.9000000000000004" into permanent trade
      // records, which the owner's email and the reviewer's prompt then rendered unformatted, and
      // which findReRecordedSells (exact float-equality on the quantity string) could never twin.
      quantity: unexplained.toFixed(6),
      avgPrice: price.toFixed(2),
      state: "inferred",
      strategy: inferSellStrategy(symbol, heldRun.influencerPositions, heldRun.trades ?? []),
    });
  }
  return { sells, unreconstructable };
}

/** A filled order as /api/verify reads it back from the broker. */
export type LiveOrder = {
  symbol: string; side: string; quantity: string; avgPrice: string; state: string; createdAt?: string;
};

export type CapturePlan = {
  /** Trades to append, at the broker's OBSERVED price and state "filled". */
  record: TradeSnapshot[];
  /** Inferred sells to drop because a real fill now covers the same disposal. */
  supersede: TradeSnapshot[];
  /** Discrepancies no live order explains — these still fall through to patchTrades. */
  residual: InferredSellPlan["unreconstructable"];
  /** True when every discrepancy was matched, i.e. the book reconciles from records afterwards. */
  reconciles: boolean;
};

/**
 * Turn the broker's filled orders into REAL trade records for trades the agent never saw.
 *
 * The owner trades manually in the same account. /api/verify has detected those fills every day —
 * `uncapturedOrders` — and nothing has ever written them down, so patchTrades was left to ESTIMATE
 * the sells at the previous snapshot's mark (a permanent error: $5.07 across KO and NEM on
 * 2026-10-05) and to REFUSE outright on the buys, withholding the day's return.
 *
 * TWO SOURCES, EACH FOR WHAT IT IS GOOD AT. The quantity comes from the POSITION ARITHMETIC, never
 * from the order: /api/verify reads orders through an LLM that formats them to two decimals, so the
 * same KO sale came back as both "0.64" and "0.637741", and 0.0023 of drift is 20x QTY_EPSILON —
 * enough to leave the book permanently unbalanced. The positions snapshot is exact. The PRICE comes
 * from the order, because it is the only place a real fill price exists at all.
 *
 * So a live order is used as EVIDENCE that a disposal happened and at what price, and the share
 * count is still derived from the identity in buildInferredSells. An order whose quantity is
 * nowhere near the observed shortfall is not evidence of that shortfall and is ignored.
 *
 * Nothing is recorded that the book does not already show: if no live order matches a discrepancy
 * it stays in `residual` and patchTrades handles it exactly as before. This cannot invent a trade,
 * only price one.
 */
export function planCapture(
  heldRun: Pick<TradeRun, "positions" | "influencerPositions" | "trades">,
  latest: Pick<TradeRun, "positions" | "trades">,
  liveOrders: LiveOrder[],
  /**
   * The dates this reconciliation spans: `from` is the run that still held the book, `to` is the
   * run being repaired. NOT "today".
   *
   * A run snapshots at 07:30, so a trade made during a session lands in the NEXT run's window and
   * is reconciled a day later — the same lag patchTrades has always had. Filtering to the calendar
   * day therefore rejected exactly the orders being reconciled: the owner's 2026-10-06 fills would
   * have been discarded on 10-07 for being "stale". The window is inclusive of both ends because a
   * fill can fall either side of the 07:30 boundary.
   */
  window: { from: string; to: string },
): CapturePlan {
  // Previously-inferred sells are estimates standing in for a real fill, so they must not count as
  // "already recorded" — superseding them is the point.
  const inferredSells = (latest.trades ?? []).filter(t => t.side === "sell" && t.state === "inferred");
  const realTrades = (latest.trades ?? []).filter(t => !(t.side === "sell" && t.state === "inferred"));

  // What the records fail to explain, by the same identity patchTrades uses.
  const gaps = buildInferredSells(heldRun, { positions: latest.positions, trades: realTrades });

  const candidates = liveOrders.filter(o =>
    o.state === "filled"
    && (!o.createdAt || (o.createdAt >= window.from && o.createdAt <= window.to))
    && parseFloat(o.avgPrice) > 0);
  // Defensive only, and currently unreachable: a symbol yields at most one gap, and `matches`
  // requires the side to agree, so no order can be offered to two gaps. Kept because that is a
  // property of buildInferredSells' output rather than of this function — mutation-checked as inert,
  // so do not write a test for it and do not mistake it for a live guard.
  const used = new Set<LiveOrder>();
  // An order corroborates a shortfall when its quantity is CLOSE to it. Tolerance is the larger of
  // one cent of a share and 2% — the formatting loss is proportional, so a fixed epsilon would
  // reject every fractional position while 2% of a real trade is far below any plausible mix-up.
  const matches = (o: LiveOrder, side: string, symbol: string, qty: number) => {
    if (used.has(o) || o.side !== side || o.symbol !== symbol) return false;
    const oq = parseFloat(o.quantity);
    return Number.isFinite(oq) && Math.abs(oq - qty) <= Math.max(0.01, qty * 0.02);
  };

  const record: TradeSnapshot[] = [];
  const supersede: TradeSnapshot[] = [];
  const residual: InferredSellPlan["unreconstructable"] = [];

  // SELLS the records are missing — buildInferredSells already priced them at the held run's mark;
  // a real fill replaces that estimate.
  for (const est of gaps.sells) {
    const qty = parseFloat(est.quantity);
    const hit = candidates.find(o => matches(o, "sell", est.symbol, qty));
    if (!hit) continue; // no evidence — leave it to patchTrades to estimate as before
    used.add(hit);
    record.push({ ...est, avgPrice: parseFloat(hit.avgPrice).toFixed(2), state: "filled" });
    supersede.push(...inferredSells.filter(t => t.symbol === est.symbol));
  }

  // SHARES THAT APPEARED — the case patchTrades can only refuse, because inventing a buy fabricates
  // a cost basis. A filled buy order IS that cost basis, so the refusal becomes a recording.
  for (const u of gaps.unreconstructable) {
    if (u.reason !== "shares-appeared" || u.excessQty == null) { residual.push(u); continue; }
    const hit = candidates.find(o => matches(o, "buy", u.symbol, u.excessQty!));
    if (!hit) { residual.push(u); continue; }
    used.add(hit);
    record.push({
      symbol: u.symbol, side: "buy", quantity: u.excessQty.toFixed(6),
      avgPrice: parseFloat(hit.avgPrice).toFixed(2), state: "filled",
      // Sleeve membership is read from the run that held the book, the same rule sells use.
      strategy: inferSellStrategy(u.symbol, heldRun.influencerPositions, heldRun.trades ?? []),
    });
  }

  // Did it work? Re-run the identity over the trade list we would persist. Anything still
  // outstanding means the capture did NOT make the book add up, and the caller must not treat the
  // day as reconciled just because something was written.
  const after = [...realTrades.filter(t => !supersede.includes(t)), ...record];
  const check = buildInferredSells(heldRun, { positions: latest.positions, trades: after });
  return {
    record, supersede, residual,
    reconciles: check.sells.length === 0 && check.unreconstructable.length === 0,
  };
}

/**
 * Backfill the `strategy` tag on SELLS that were written without one.
 *
 * 67 of 81 stored sells have no tag, because the original tagger searched the previous run's BUYS
 * for the symbol — which is almost never where a weeks-old position's buy lives. Fixing the tagger
 * only helps future sells; without this the sleeve's realised P&L stays uncomputable for everything
 * already recorded, since a position whose sell is untagged never nets to closed.
 *
 * Inference uses the SAME rule as the live path: membership in the PRIOR run's influencerPositions,
 * falling back to buy history for runs predating that field.
 *
 * Only ever FILLS A GAP — an existing tag is never overwritten, so a bad inference cannot destroy a
 * tag the trade route recorded first-hand. Returns a per-run plan; the caller decides to write.
 */
export function planSellTagBackfill(runsNewestFirst: TradeRun[]): Array<{
  index: number; date: string; tagged: Array<{ symbol: string; strategy: "main" | "influencer" }>;
}> {
  const out: Array<{ index: number; date: string; tagged: Array<{ symbol: string; strategy: "main" | "influencer" }> }> = [];
  runsNewestFirst.forEach((run, i) => {
    // newest-first, so the PRIOR run (older) is the next index.
    const prior = runsNewestFirst[i + 1];
    const tagged: Array<{ symbol: string; strategy: "main" | "influencer" }> = [];
    for (const t of run.trades ?? []) {
      if (t.side !== "sell" || t.strategy) continue;
      tagged.push({ symbol: t.symbol, strategy: inferSellStrategy(t.symbol, prior?.influencerPositions, prior?.trades ?? []) });
    }
    if (tagged.length) out.push({ index: i, date: run.date, tagged });
  });
  return out;
}

/** Apply a backfill plan in place. Returns how many trades were tagged. */
export function applySellTagBackfill(
  runsNewestFirst: TradeRun[],
  plan: ReturnType<typeof planSellTagBackfill>,
): number {
  let n = 0;
  for (const p of plan) {
    const run = runsNewestFirst[p.index];
    for (const { symbol, strategy } of p.tagged) {
      const t = (run.trades ?? []).find(x => x.side === "sell" && x.symbol === symbol && !x.strategy);
      if (t) { t.strategy = strategy; n++; }
    }
  }
  return n;
}

/** Write back a whole run list, newest-first. Used only by backfills. */
export async function replaceRuns(runsNewestFirst: TradeRun[]): Promise<void> {
  // Guard: refuse to replace with a SHORTER list. A truncated read followed by a write is how a
  // backfill turns into data loss, and this store is the agent's entire history.
  const existing = await getRuns(MAX_RUNS);
  if (runsNewestFirst.length < existing.length) {
    throw new Error(`refusing to replace ${existing.length} runs with ${runsNewestFirst.length}`);
  }
  await redisPost("pipeline", [
    ["DEL", RUNS_KEY],
    ...runsNewestFirst.map(r => ["RPUSH", RUNS_KEY, JSON.stringify(r)]),
  ]);
}
