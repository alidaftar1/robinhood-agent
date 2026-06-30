const RUNS_KEY = "robinhood:runs";
const MAX_RUNS = 90; // ~3 months of daily runs

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
  // Influencer sub-portfolio (added 2026-06-18)
  influencerPositions?: PositionSnapshot[];
  influencerDailyReturn?: number | null;
}

async function redisCommand(command: string, ...args: (string | number)[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");

  const res = await fetch(`${url}/${command}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json() as { result: unknown };
  return json.result;
}

async function redisPost(command: string, body: unknown): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");

  const res = await fetch(`${url}/${command}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
function reconcilePositions(run: TradeRun): TradeRun {
  const soldQty = new Map<string, number>();
  for (const t of run.trades ?? []) {
    if (t.side === "sell") {
      soldQty.set(t.symbol, (soldQty.get(t.symbol) ?? 0) + (parseFloat(t.quantity) || 0));
    }
  }
  if (soldQty.size === 0) return run;
  const keep = (p: PositionSnapshot) => {
    const sold = soldQty.get(p.symbol) ?? 0;
    return !(sold > 0 && sold >= (parseFloat(p.quantity) || 0));
  };
  const positions = (run.positions ?? []).filter(keep);
  // Reconcile the influencer sub-portfolio too: a stale sold name there inflates the
  // next day's influencer-cap count and gets carried forward as a phantom holding.
  const influencerPositions = run.influencerPositions?.filter(keep);
  const positionsChanged = positions.length !== (run.positions ?? []).length;
  const influencerChanged =
    influencerPositions != null && influencerPositions.length !== run.influencerPositions!.length;
  if (!positionsChanged && !influencerChanged) return run;
  return {
    ...run,
    positions,
    ...(influencerPositions != null ? { influencerPositions } : {}),
  };
}

// Collapses runs to one canonical record per date. Keeps the richer run (see
// preferRun) but unions in the dropped run's trades so no fill is lost from
// history, then reconciles positions against the day's sells (see
// reconcilePositions). Pure + side-effect free so it can be unit-tested without Redis.
export function mergeRunsByDate(all: TradeRun[]): TradeRun[] {
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
    }
  }
  return [...byDate.values()]
    .map(reconcilePositions)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function dedupeRuns(): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");
  const all = await getRuns(90);
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
  const tradeNetCash = todayTrades.reduce((s, t) => {
    const qty = parseFloat(t.quantity);
    const price = parseFloat(t.avgPrice);
    return s + (t.side === "buy" ? qty * price : -(qty * price));
  }, 0);

  const pnl = (posValToday - posValYesterday) - tradeNetCash;
  const impliedTransfer = todayValue - yesterdayValue - pnl;
  return { dailyReturn: pnl / yesterdayValue, impliedTransfer };
}

// Updates a specific run by date, applying an updater function. Rewrites the full list.
export async function updateRunByDate(date: string, updater: (run: TradeRun) => TradeRun): Promise<boolean> {
  const all = await getRuns(90);
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
