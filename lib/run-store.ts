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
  /**
   * WHO placed this order. The owner trades this account by hand periodically, so "a fill exists"
   * and "the agent did it" are different facts and must not share a field.
   *
   * MUST BE STAMPED AT WRITE TIME — it cannot be recovered afterwards. The obvious discriminators
   * all fail: a human fill and an agent fill are both `state: "filled"` at the broker, and
   * `refPrice` is absent on both (only the trade route stamps it; drop-check and earnings-exit do
   * not). 2026-10-06 is the worked example — the agent's own ILMN stop-loss and the owner's seven
   * trades were indistinguishable in the store, which is what let the skeptical reviewer build a
   * false theory about unrecorded agent buys, and what made me misattribute the ILMN exit to the
   * owner.
   *
   * "agent"  — placed by /api/trade, /api/drop-check or /api/earnings-exit.
   * "human"  — discovered at the broker by planCapture with no agent order behind it.
   * absent   — written before this field existed. UNKNOWN, not "agent": do not default it.
   */
  actor?: "agent" | "human";
  /** The date the fill actually happened, when the broker told us — NOT the run's date.
   *
   *  A run snapshots at 07:30, so a trade made during a session falls between that snapshot and the
   *  NEXT one and is therefore recorded on the next day's run. That is correct for RETURN
   *  accounting: the day's return is measured snapshot-to-snapshot, and the trade's P&L belongs to
   *  that window. It is wrong as a statement of WHEN, and with nothing to say otherwise the
   *  dashboard dated the owner's 2026-10-06 trades to 10-07.
   *
   *  Only set where there is evidence: planCapture matches a real broker order and copies its
   *  createdAt. An INFERRED trade leaves this undefined, because the reconstruction knows a position
   *  changed between two snapshots and genuinely cannot know when. Absent means "no better
   *  information than the run's date", never "same day". */
  tradedOn?: string;
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
  /** Whether MAIN-BOOK buys were open on this run, as DECIDED at trade time.
   *
   *  Stored rather than recomputed because it is no longer a pure function of the date: since
   *  2026-10-21 an off-window day also opens when idle settled cash clears the floor and the market
   *  is risk-on (lib/strategy mainBuysOpen). The reviewer cannot reconstruct that from a stored run
   *  — the regime is not in the record — so a calendar-only recomputation would report
   *  mainBookBuysOpen:false on a day the book genuinely bought, and file concerns about it.
   *  Absent on runs predating this field; callers fall back to the calendar rule. */
  mainBuysOpen?: boolean;
  portfolioAfter: {
    totalValue: string;
    cash: string;
    equity: string;
    unsettledCash?: string; // unsettled sell proceeds (T+1) — captured from 2026-06-21
    /** true when unsettledCash was READ from the live broker balance alongside cash (2026-10-24).
     *  On limited margin a measured "0.00" is real; without this flag readers treat 0 as "not
     *  captured" and re-add the day's sells. Absent on older runs. */
    unsettledMeasured?: boolean;
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

/**
 * Persist a run. Returns whether it actually landed — DO NOT IGNORE IT.
 *
 * This used to return void and swallow every error, which made an unpersisted run indistinguishable
 * from a saved one AT THE CALL SITE. On 2026-10-06 the main-book stop correctly sold ILMN at
 * $276.75 on a -5.8% break, the save did not land, and drop-check carried straight on to email
 * "🔴 Risk-Exit Triggered" — a success notice for a run that does not exist. The fill then surfaced
 * as an "uncaptured order", the reviewer built a false theory on it, and the trade is absent from
 * the record that every return, sleeve split and attribution number is computed from. There are
 * ZERO [RISK-EXIT] runs across the whole stored history, so this is unlikely to have been the first.
 *
 * Callers that go on to CLAIM something happened — an alert, an email, a success response — must
 * branch on this. A write that silently does nothing is the most expensive kind of failure here,
 * because everything downstream keeps working on a book that is quietly wrong.
 *
 * Deliberately still does not throw: the trade route calls this AFTER orders are placed, and an
 * exception there would abort the rest of the post-trade bookkeeping over a storage problem that
 * has already happened. The caller decides what a failed save means for it.
 */
export async function saveRun(run: TradeRun): Promise<boolean> {
  try {
    const serialized = JSON.stringify(run);
    await redisPost("pipeline", [
      ["LPUSH", RUNS_KEY, serialized],
      ["LTRIM", RUNS_KEY, 0, MAX_RUNS - 1],
    ]);
    return true;
  } catch (e) {
    // Loud, and specific about the consequence — "not saved to dashboard" undersold it: the run
    // store is the ledger, not a display cache.
    console.error("SAVE_RUN_FAILED", { date: run.date, timestamp: run.timestamp, error: String(e) });
    return false;
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

/**
 * The sleeve pair as it should be STORED, given the account-level result for the same day.
 *
 * A sleeve return must never publish on a day the account-level return was withheld. The two are
 * computed independently — computeDailyReturn for the whole book, computeSleeveReturns for the
 * halves — and before this they could disagree about whether the day was knowable at all.
 *
 * 2026-10-16 is the case that forced it. The owner bought REGN, ROST and LLY in his own account
 * before the 07:30 run. The agent never placed those orders, so no trade record existed to offset
 * them, and $476.90 of cash turning into equity read as profit. computeDailyReturn correctly
 * refused the day and agenticDailyReturn was stored null — but the MAIN sleeve, whose trade list
 * was empty (the only recorded trade, an AVGO sell, belongs to the influencer sleeve), published
 * +39.4% and that is what the dashboard showed for the half hour until the 08:00 autopilot ran
 * /api/verify?capture=1 and recorded the owner's fills.
 *
 * Note what did NOT save it: clampSleeveReturn's 50% ceiling. A phantom only has to be smaller
 * than the clamp to reach the dashboard, and the size of a phantom has nothing to do with whether
 * it is real. The account-level null is the honest signal — it is the system saying it cannot
 * price this day — so the sleeves must inherit it rather than each re-deciding.
 *
 * Where this rule holds, and where it does not — do not read it as a global invariant on stored
 * history:
 *   - ENFORCED at write time by all four paths that derive a sleeve return: trade, verify capture,
 *     debug patchTrades and debug patchDate, each through this one definition. The two clear
 *     endpoints (clearReturn, clearReturnForDate) null the sleeves alongside the account return,
 *     so the automated repairs cannot violate it from either direction.
 *   - NOT RETROACTIVE. backfillSleeveReturns SKIPS a null-agentic run, which is not the same rule:
 *     skipping LEAVES the stale sleeve value in place rather than nulling it. So a phantom already
 *     written under the old code — the 2026-10-16 mainDailyReturn: +39.4% on a null-account day —
 *     is not cleared by ?recomputeSleeves. Repair such a day with ?patchDate (which now recomputes
 *     both) or by hand. The skip is deliberate and stays: it is what protects the hand-supplied
 *     ?setInfluencerReturn value on the non-canonical 2026-06-22 run, which is a null-agentic day
 *     carrying a real sleeve number on purpose — the one documented exception to the rule above.
 */
export function sleeveReturnsForStorage(
  agentic: { dailyReturn: number; impliedTransfer: number } | null,
  raw: { influencerDailyReturn: number | null; mainDailyReturn: number | null },
): { influencerDailyReturn: number | null; mainDailyReturn: number | null } {
  if (agentic == null) return { influencerDailyReturn: null, mainDailyReturn: null };
  return {
    influencerDailyReturn: clampSleeveReturn(raw.influencerDailyReturn),
    mainDailyReturn: clampSleeveReturn(raw.mainDailyReturn),
  };
}

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

/**
 * Owner sleeve label, applied to EVERY stored run from `fromDate` through the newest (inclusive).
 *
 * Why a range, not one date: sleeve membership carries forward from the previous run
 * (app/api/trade), and lib/stopouts symbolsWithMainOwnership reads ALL stored runs — a buy not tagged
 * "influencer", or any run holding the name outside influencerPositions, keeps it on the MAIN-book
 * stop. So every run that holds it must agree. Refusals (each would otherwise report a success that
 * does not hold): a run BEFORE fromDate that already marks the name as main (re-run from that date);
 * no run in the range ending with the requested membership; a run saved between read and write
 * (a cron mid-flight would be erased); a write not visible on re-read.
 */
export async function tagSleeveFrom(fromDate: string, symbol: string, sleeve: "influencer" | "main"): Promise<{ ok: true; detail: string[] } | { ok: false; reason: string }> {
  const all = await getRuns(MAX_RUNS);
  if (!all.length) return { ok: false, reason: "no runs stored" };
  if (fromDate > all[0].date) return { ok: false, reason: `${fromDate} is after the newest stored date (${all[0].date})` };
  if (sleeve === "influencer") {
    // Mirrors symbolsWithMainOwnership: a main buy counts in ANY run (even pre-tracking); a holding
    // outside the sleeve counts only in runs that track the sleeve.
    const marksMain = (r: TradeRun) =>
      (r.trades ?? []).some(t => t.symbol === symbol && t.side === "buy" && t.strategy !== "influencer") ||
      (r.influencerPositions != null && (r.positions ?? []).some(p => p.symbol === symbol)
        && !r.influencerPositions.some(p => p.symbol === symbol));
    const earlier = all.filter(r => r.date < fromDate && marksMain(r));
    if (earlier.length) {
      // Start of THIS holding: walk back from fromDate while consecutive runs still hold it. Evidence
      // inside it means fromDate was too late; evidence before it is a CLOSED earlier holding, and
      // relabelling that would rewrite old sleeve history — so refuse rather than suggest it.
      const before = all.filter(r => r.date < fromDate);           // newest first
      let start = fromDate;
      for (const r of before) { if (r.influencerPositions == null || !(r.positions ?? []).some(p => p.symbol === symbol)) break; start = r.date; }
      const first = earlier.map(r => r.date).sort()[0];
      return first >= start
        ? { ok: false, reason: `this holding started ${start}, before ${fromDate}, and runs from then mark ${symbol} as main — re-run from ${start}` }
        : { ok: false, reason: `an earlier, CLOSED main-book holding of ${symbol} (from ${first}) is still in the stored history; drop-check reads it and would keep the main-book stop, so the label cannot take effect — not applied` };
    }
  }
  // A pre-tracking run INSIDE the range cannot be relabelled (applySleeveTag leaves it alone), yet a
  // main buy there still counts for drop-check — so a success would not hold. Refuse instead.
  const untrackedHit = all.find(r => r.date >= fromDate && r.influencerPositions == null &&
    ((r.positions ?? []).some(p => p.symbol === symbol) || (r.trades ?? []).some(t => t.symbol === symbol)));
  if (untrackedHit) return { ok: false, reason: `${symbol} appears in a run from before sleeve tracking (${untrackedHit.date}); that run cannot be relabelled — not applied` };
  const head = all[0].timestamp, len = all.length;
  const detail: string[] = [];
  let reached = 0, changed = 0;
  for (const r of all) {
    if (r.date < fromDate) continue;
    const res = applySleeveTag(r, symbol, sleeve);
    detail.push(`${r.date} ${r.timestamp?.slice(11, 16) ?? "?"}Z: ${res.buys} buy(s), ${res.membership}`);
    if (res.buys || res.membership === "added" || res.membership === "removed") changed++;
    const has = (r.influencerPositions ?? []).some(p => p.symbol === symbol);
    const held = (r.positions ?? []).some(p => p.symbol === symbol);
    if (held && res.membership !== "untracked" && has === (sleeve === "influencer")) reached++;
  }
  if (!reached) return { ok: false, reason: `no run from ${fromDate} on holds ${symbol} in a tracked snapshot — nothing would carry forward [${detail.join("; ")}]` };
  if (!changed) return { ok: true, detail: [...detail, "already labelled — nothing written"] };
  const now = await getRuns(MAX_RUNS);
  if (now.length !== len || now[0]?.timestamp !== head) return { ok: false, reason: "a run was saved meanwhile — retry when no cron is running" };
  await redisPost("pipeline", [["DEL", RUNS_KEY], ...all.map(r => ["RPUSH", RUNS_KEY, JSON.stringify(r)])]);
  const after = await getRuns(MAX_RUNS);
  if (after.length !== len || JSON.stringify(after[0]) !== JSON.stringify(all[0])) return { ok: false, reason: "write not visible on re-read — check the run store before retrying" };
  return { ok: true, detail };
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
  /** Full created_at timestamp, transcribed by an LLM — a HINT input only, never a gate. */
  createdAtTs?: string;
};

/** A run cannot place an order later than its start + the function's hard maximum (5 min) + slack. */
export const RUN_MAX_MS = 6 * 60_000;

/**
 * Uncaptured BUYS that LOOK like the owner's own trade: placed after today's latest run could have
 * placed anything. A HINT for the email and the reviewer, nothing more — it removes no discrepancy
 * and changes no status, because the timestamp is LLM-transcribed and the "latest run" may not be
 * the run that placed the buys (a lost save). 2026-10-26: the owner's $150 MU buy at 10:51 ET read
 * as an uncaptured order + a -$150 cash gap, and the reviewer hunted for the missing $150 elsewhere.
 * An attempt to RELABEL such fills as non-discrepancies was dropped after two reviews showed it
 * could hide the agent's own unrecorded buys.
 */
export function likelyOwnerBuys(
  uncaptured: readonly LiveOrder[],
  run: { timestamp: string; date: string } | null | undefined,
  today: string,
): Array<{ order: LiveOrder; at: string }> {
  if (!run || run.date !== today) return [];
  const runStart = Date.parse(run.timestamp);
  if (!Number.isFinite(runStart)) return [];
  const out: Array<{ order: LiveOrder; at: string }> = [];
  for (const o of uncaptured) {
    if (o.side !== "buy" || o.state !== "filled" || !o.createdAtTs) continue;
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(o.createdAtTs)) continue;
    const t = Date.parse(o.createdAtTs);
    if (!Number.isFinite(t) || t <= runStart + RUN_MAX_MS) continue;
    if (o.createdAt && new Date(t).toISOString().slice(0, 10) !== o.createdAt) continue;
    out.push({ order: o, at: new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) });
  }
  return out;
}

/**
 * Filled broker orders from `today` that no stored trade accounts for.
 *
 * Pulled out of /api/verify so it can be asked TWICE in one request: once to report, and again
 * after ?capture=1 has written records, so the answer reflects what is now on file. Before this,
 * the discrepancy list was built before the capture ran and `status` was computed from it
 * afterwards — so an order the SAME request had just recorded was still reported as uncaptured.
 * 2026-10-14 is the worked case: the email said "Recorded 1 of your own fill(s): buy MRVL
 * x0.000269" in autoFixed and "Uncaptured order: buy MRVL x0.000269" in issues, and the second one
 * set the banner to NEEDS ATTENTION.
 *
 * The 0.01-share tolerance is inherited from the original check and kept deliberately: capture
 * takes its QUANTITY from position arithmetic and only its PRICE from the broker, so a recorded
 * trade need not equal the order share-for-share. Where the two disagree beyond the tolerance this
 * keeps REPORTING the order — the safe direction. Nothing here suppresses on symbol alone.
 */
export function findUncapturedOrders(
  liveOrders: LiveOrder[] | null,
  storedTrades: readonly TradeSnapshot[],
  today: string,
): LiveOrder[] {
  if (!liveOrders) return [];
  // Only orders placed today; an order with no createdAt cannot be dated, so it is checked rather
  // than skipped.
  const todayFilled = liveOrders.filter(o => o.state === "filled" && (!o.createdAt || o.createdAt === today));
  return todayFilled.filter(order => !storedTrades.some(
    t => t.symbol === order.symbol && t.side === order.side &&
         Math.abs(parseFloat(t.quantity) - parseFloat(order.quantity)) < 0.01,
  ));
}

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
  latest: Pick<TradeRun, "positions" | "trades" | "influencerPositions">,
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

  /**
   * SEVERAL FILLS ON ONE SYMBOL, netting to the gap.
   *
   * `matches` pairs ONE order with ONE gap, which fails the moment a symbol is traded more than
   * once in a window: the gap is the NET change and no individual order equals it. 2026-10-14 is
   * the worked case — the owner bought 0.69 MRVL, then trimmed 0.33 and 0.28, netting +0.079.
   * Nothing matched, MRVL fell to residual, and the day would have had its return withheld and
   * locked with four perfectly good broker fills sitting right there.
   *
   * Recording ALL the fills is also strictly more faithful than matching one: four real trades
   * give the true cost basis and the true realised P&L, where a single synthesised net trade
   * gives neither.
   *
   * SAFETY. Only fires when the fills net to the gap within the same tolerance a single match
   * uses, so a symbol whose orders do NOT explain the change still falls through to residual
   * rather than being papered over. Orders already represented by a stored trade are excluded
   * first — otherwise a previously captured fill (this morning's MRVL dust buy) would be counted
   * twice. And the caller does not have to trust any of this: `reconciles` below re-runs the
   * identity over what would be persisted, so a wrong reconstruction reports itself.
   */
  // Checks BOTH trade lists, and the held run's is the one that matters most: a fill captured
  // YESTERDAY is already inside today's baseline QUANTITY, so re-recording it from the same
  // still-in-window order double-counts it. Caught in simulation against the real 2026-10-14
  // orders — this morning's MRVL dust buy was captured into the 10-14 run, and without the
  // heldRun arm it would have been recorded a second time on 10-15.
  //
  // Dates compared when BOTH sides carry one, so two genuinely separate fills of identical size on
  // different days are not conflated. Where a date is missing the quantity match stands alone; the
  // error direction is then "do not record", which under-records and leaves `reconciles` false
  // rather than inventing a trade.
  //
  // TOLERANT ON QUANTITY, and this is the correction that made the mechanism work at all. The
  // broker's order reader ROUNDS TO 2dp — the same fact `matches` above is built around ("KO came
  // back as both 0.64 and 0.637741") — so an exact comparison never recognises a stored trade in
  // the order list. 2026-10-15: the agent's own MRVL sell was stored as 1.190290 and returned by
  // the broker as "1.19", so it was NOT excluded, was counted into the multi-fill net
  // (0.69 - 0.33 - 0.28 - 1.19 = -1.11 against a gap of +0.079), matched nothing, and MRVL fell to
  // residual — the day withheld and locked with every fill available. Shipped with a 1e-9 epsilon
  // because the unit test used exact quantities on BOTH sides, which the broker never does.
  //
  // Same tolerance as `matches`, so the two cannot disagree about whether an order and a trade are
  // the same fill. Over-matching here UNDER-records, which leaves `reconciles` false and withholds
  // loudly; under-matching double-counts silently. Those are not symmetric, so prefer this side.
  const sameFill = (t: TradeSnapshot, o: LiveOrder) => {
    if (t.symbol !== o.symbol || t.side !== o.side) return false;
    if (t.tradedOn && o.createdAt && t.tradedOn !== o.createdAt) return false;
    const tq = parseFloat(t.quantity) || 0, oq = parseFloat(o.quantity) || 0;
    return Math.abs(tq - oq) <= Math.max(0.01, Math.abs(tq) * 0.02);
  };
  const alreadyRecorded = (o: LiveOrder) =>
    realTrades.some(t => sameFill(t, o)) || (heldRun.trades ?? []).some(t => sameFill(t, o));
  const netMultiFill = (symbol: string, signedGap: number): LiveOrder[] | null => {
    const fills = candidates.filter(o => o.symbol === symbol && !used.has(o) && !alreadyRecorded(o));
    // Defensive only, and mutation-checked as INERT: the single-order path runs first and takes
    // every case a lone fill can explain, so this never sees one. Kept because that is a property
    // of the CALLER's ordering rather than of this helper — do not write a test for it, and do not
    // mistake it for a live guard. (Same status as `used` above.)
    if (fills.length < 2) return null;
    const net = fills.reduce((a, o) => {
      const q = parseFloat(o.quantity);
      return a + (Number.isFinite(q) ? (o.side === "buy" ? q : -q) : 0);
    }, 0);
    const tol = Math.max(0.01, Math.abs(signedGap) * 0.02);
    return Math.abs(net - signedGap) <= tol ? fills : null;
  };
  //
  // QUANTITY FROM POSITIONS, PRICE FROM THE BROKER — the same rule the single-order path follows,
  // applied to a set. The broker rounds order quantities to 2dp, so recording the fills verbatim
  // leaves the book out by the rounding error: on 2026-10-15 the real fills summed to 0.000882
  // more than the position change (~$0.20), `reconciles` came back false, and the day stayed
  // withheld over sub-penny dust with every fill correctly captured. So the residual is absorbed
  // into the LARGEST fill, where it is proportionally smallest, and every fill keeps its own
  // broker PRICE — cost basis and realised P&L stay true while the arithmetic closes exactly.
  const reconcileQuantities = (fills: LiveOrder[], signedGap: number): Map<LiveOrder, number> | null => {
    const q = new Map<LiveOrder, number>();
    let net = 0;
    for (const o of fills) {
      const v = parseFloat(o.quantity);
      const n = Number.isFinite(v) ? v : 0;
      q.set(o, n);
      net += o.side === "buy" ? n : -n;
    }
    const delta = signedGap - net;
    if (Math.abs(delta) < 1e-12) return q;
    // Largest by absolute size: the adjustment is a rounding remainder, and putting it on the
    // biggest fill keeps the relative distortion smallest.
    let biggest: LiveOrder | null = null;
    for (const o of fills) if (!biggest || (q.get(o) ?? 0) > (q.get(biggest) ?? 0)) biggest = o;
    if (!biggest) return null;
    const adjusted = (q.get(biggest) ?? 0) + (biggest.side === "buy" ? delta : -delta);
    // A correction that flips a fill negative means these orders do not describe this change at
    // all; refuse rather than invent one.
    if (!(adjusted > 0)) return null;
    q.set(biggest, adjusted);
    return q;
  };
  // A captured BUY's sleeve: the run being repaired wins when it already holds the name in the
  // sleeve — that is the trade run sorting the owner's new buy (lib/owner-buys) before this capture
  // could record it. Otherwise the run that held the book, the same rule sells use.
  const buySleeve = (symbol: string): "main" | "influencer" =>
    latest.influencerPositions?.some(p => p.symbol === symbol)
      ? "influencer"
      : inferSellStrategy(symbol, heldRun.influencerPositions, heldRun.trades ?? []);
  const recordFills = (fills: LiveOrder[], symbol: string, signedGap: number) => {
    const qty = reconcileQuantities(fills, signedGap);
    if (!qty) return false;
    for (const o of fills) {
      used.add(o);
      record.push({
        symbol, side: o.side as "buy" | "sell", quantity: (qty.get(o) ?? 0).toFixed(6),
        avgPrice: parseFloat(o.avgPrice).toFixed(2), state: "filled", actor: "human",
        ...(o.createdAt ? { tradedOn: o.createdAt } : {}),
        strategy: o.side === "buy" ? buySleeve(symbol) : inferSellStrategy(symbol, heldRun.influencerPositions, heldRun.trades ?? []),
      });
    }
    return true;
  };

  // SELLS the records are missing — buildInferredSells already priced them at the held run's mark;
  // a real fill replaces that estimate.
  for (const est of gaps.sells) {
    const qty = parseFloat(est.quantity);
    const hit = candidates.find(o => matches(o, "sell", est.symbol, qty));
    if (!hit) {
      // A NET decrease can also be several fills (a buy and two larger trims). Signed negative:
      // the position went down.
      const fills = netMultiFill(est.symbol, -qty);
      if (fills && recordFills(fills, est.symbol, -qty)) {
        supersede.push(...inferredSells.filter(t => t.symbol === est.symbol));
      }
      continue; // no evidence — leave it to patchTrades to estimate as before
    }
    used.add(hit);
    record.push({
      ...est, avgPrice: parseFloat(hit.avgPrice).toFixed(2), state: "filled", actor: "human",
      ...(hit.createdAt ? { tradedOn: hit.createdAt } : {}),
    });
    supersede.push(...inferredSells.filter(t => t.symbol === est.symbol));
  }

  // SHARES THAT APPEARED — the case patchTrades can only refuse, because inventing a buy fabricates
  // a cost basis. A filled buy order IS that cost basis, so the refusal becomes a recording.
  for (const u of gaps.unreconstructable) {
    if (u.reason !== "shares-appeared" || u.excessQty == null) { residual.push(u); continue; }
    const hit = candidates.find(o => matches(o, "buy", u.symbol, u.excessQty!));
    if (!hit) {
      const fills = netMultiFill(u.symbol, u.excessQty);
      if (!fills || !recordFills(fills, u.symbol, u.excessQty)) { residual.push(u); continue; }
      continue;
    }
    used.add(hit);
    record.push({
      symbol: u.symbol, side: "buy", quantity: u.excessQty.toFixed(6),
      avgPrice: parseFloat(hit.avgPrice).toFixed(2), state: "filled", actor: "human",
      ...(hit.createdAt ? { tradedOn: hit.createdAt } : {}),
      strategy: buySleeve(u.symbol),
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

/**
 * Set `actor` (and optionally `tradedOn`) on trades that predate those fields.
 *
 * Provenance CANNOT be inferred after the fact — a human fill and an agent fill are both
 * `state: "filled"`, and `refPrice` is absent on both, so there is no signal in the record to read.
 * The only correct source is whoever knows: for a run written before the field existed, that is the
 * owner. This exists so those rows can be corrected deliberately rather than guessed at, and so the
 * guess never gets encoded as a heuristic.
 *
 * Only ever FILLS A GAP, and PER FIELD: `actor` is never overwritten, because a writer that placed
 * the order knows better than any later correction. `tradedOn` follows the same rule but is tracked
 * separately — they are different facts, and bundling them meant an already-tagged trade could
 * never be given its fill date. Matching is by symbol+side, which is unambiguous within one run: the
 * executor emits one order per symbol per side.
 *
 * Returns how many of each field were filled. Pure: the caller decides whether to persist.
 */
export function applyActorTag(
  run: TradeRun,
  tags: Array<{ symbol: string; side: string; actor?: "agent" | "human"; tradedOn?: string }>,
  /**
   * Replace a value that is already recorded. Off by default, because a later guess must not
   * override what a writer knew first-hand.
   *
   * It exists because a first-hand tag can still be a FALSE CLAIM. On 2026-10-06 the drop-check
   * recorded the owner's own ILMN sale as `actor: "agent"`: it triggered on a stale 07:30 snapshot
   * that still showed ILMN held, tried to sell a position the owner had already closed, and
   * verifySells — which asks the broker for "sell orders placed today" and matches BY SYMBOL — found
   * the owner's fill and accepted it as confirmation of its own order. Only the owner can settle
   * that, so the owner needs a way to say so.
   */
  force = false,
): { actors: number; dates: number } {
  let actors = 0, dates = 0;
  for (const tag of tags) {
    for (const t of run.trades ?? []) {
      if (t.symbol !== tag.symbol || t.side !== tag.side) continue;
      // The two fields have DIFFERENT rules and must be applied independently. Treating them as one
      // unit meant a trade that already carried `actor` could never be given its fill date — which
      // is precisely the state the first pass left every corrected trade in.
      if (tag.actor && (force || !t.actor)) { t.actor = tag.actor; actors++; }
      if (tag.tradedOn && (force || !t.tradedOn)) { t.tradedOn = tag.tradedOn; dates++; }
    }
  }
  return { actors, dates };
}

/**
 * Put a symbol's position into a sleeve on ONE run, by the owner's say-so.
 *
 * Owner trades are captured the next morning with the sleeve the symbol ALREADY had
 * (inferSellStrategy), so a brand-new name always lands in "main" — there was no way to say
 * "this one is an influencer pick" (2026-10-27: owner bought AMZN and asked for it in the sleeve;
 * PLTR got the label only because the sleeve already held it). This sets `strategy` on that run's
 * BUYS of the symbol and adds/removes it from `influencerPositions`, which every later run carries
 * forward (app/api/trade derives membership from the previous run's influencerPositions). Sells
 * are left alone: a sell's sleeve is the sleeve it left, which this does not rewrite.
 * Sleeve RETURNS are not touched here — run ?recomputeSleeves after, so one function owns them.
 */
export function applySleeveTag(run: TradeRun, symbol: string, sleeve: "influencer" | "main"): { buys: number; membership: "added" | "removed" | "unchanged" | "not-held" | "untracked" } {
  if (run.influencerPositions == null) return { buys: 0, membership: "untracked" };
  let buys = 0;
  for (const t of run.trades ?? []) {
    if (t.symbol !== symbol || t.side !== "buy") continue;
    // An untagged buy already reads as main everywhere (inferSellStrategy, stopouts): not a change.
    const isInfl = t.strategy === "influencer";
    if (sleeve === "influencer" ? !isInfl : isInfl) { t.strategy = sleeve; buys++; }
  }
  // (checked above: a run without the field predates sleeve tracking, and lib/stopouts reads that as
  // "no evidence" — a one-name sleeve there would turn its other positions into main-book evidence)
  const infl = run.influencerPositions;
  const inSleeve = infl.some(p => p.symbol === symbol);
  if (sleeve === "influencer") {
    if (inSleeve) return { buys, membership: "unchanged" };
    const pos = (run.positions ?? []).find(p => p.symbol === symbol);
    if (!pos) return { buys, membership: "not-held" };
    run.influencerPositions = [...infl, { ...pos }];
    return { buys, membership: "added" };
  }
  if (!inSleeve) return { buys, membership: "unchanged" };
  run.influencerPositions = infl.filter(p => p.symbol !== symbol);
  return { buys, membership: "removed" };
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
