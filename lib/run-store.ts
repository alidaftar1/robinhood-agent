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

// Collapses runs to one canonical record per date. Keeps the richer run (see
// preferRun) but unions in the dropped run's trades so no fill is lost from
// history. Pure + side-effect free so it can be unit-tested without Redis.
export function mergeRunsByDate(all: TradeRun[]): TradeRun[] {
  const byDate = new Map<string, TradeRun>();
  for (const run of all) {
    const existing = byDate.get(run.date);
    if (!existing) {
      byDate.set(run.date, { ...run, trades: [...(run.trades ?? [])] });
      continue;
    }
    const base = preferRun(existing, run);
    const other = base === existing ? run : existing;
    base.trades = unionTrades(base.trades ?? [], other.trades ?? []);
    byDate.set(run.date, base);
  }
  return [...byDate.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
