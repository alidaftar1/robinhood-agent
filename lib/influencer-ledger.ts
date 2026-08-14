// ─────────────────────────────────────────────────────────────────────────────
// INFLUENCER-PICK ATTRIBUTION LEDGER
//
// The influencer sleeve's edge is UNPROVEN (over its first ~6 weeks it is slightly
// negative and extremely volatile), and until now nothing measured which channels'
// picks actually work — the trade records carry no channel attribution, and the
// signal cache is TTL'd so history is lost. This ledger is the missing measurement:
// it persistently logs every qualifying influencer pick with the channel(s) that
// made it and the price at first sighting, then scores each pick's forward return and
// rolls it up per channel. That answers "which channels (if any) have edge?" and, as
// data accumulates, gives an HONEST verdict on the whole concept — instead of reading
// a noisy 6-week cumulative as signal (which burned us once already).
//
// Deterministic (no LLM). Measures from FIRST-LOGGED price, so it is accurate going
// forward; picks that predate the ledger get today's price as their baseline (their
// pre-ledger history is unrecoverable — the cache didn't keep it).
// ─────────────────────────────────────────────────────────────────────────────

import { fetchQuoteLite } from "@/lib/market-data";
import { getRuns } from "@/lib/run-store";
import { netScores, INFLUENCER_BUY_FLOOR } from "@/lib/influencer-signals";
import type { InfluencerCache } from "@/lib/influencer-signals";

type Confidence = "high" | "medium" | "low";
const CONF_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

const LEDGER_KEY = "robinhood:influencer-ledger";
// Track picks that clear the SAME bar the sleeve buys on: NET score (buy consensus − avoid
// dissent) ≥ the buy floor. Kept in lock-step with the buy logic so the ledger measures exactly
// what the strategy would act on. Below the floor the strategy never buys, so tracking would
// just add noise to the channel stats.
const MIN_SCORE = INFLUENCER_BUY_FLOOR;

export interface LedgerPick {
  ticker: string;
  channels: string[];        // union of channels that recommended it while open
  maxScore: number;          // peak weighted mention score (high=3/med=2/low=1, summed)
  maxConfidence: Confidence;
  firstSeenDate: string;     // YYYY-MM-DD — the return baseline date
  lastSeenDate: string;
  priceAtSignal: number;     // price when first logged (the baseline)
}

export interface PickOutcome extends LedgerPick {
  currentPrice: number | null;
  returnPct: number | null;  // (current / priceAtSignal − 1) × 100 — RAW
  marketReturnPct: number | null; // SPY's return over the same firstSeen→today window
  alphaPct: number | null;   // returnPct − marketReturnPct — edge over just holding the index
  daysElapsed: number;       // firstSeen → today (horizons vary; exposed for transparency)
}

export interface ChannelStats {
  channel: string;
  picks: number;             // measurable picks (a live price was available)
  hitRatePct: number;        // % of picks with returnPct > 0
  avgReturnPct: number;      // simple mean of RAW pick returns (mixed horizons — see daysElapsed)
  avgAlphaPct: number | null; // mean return ABOVE/below SPY over each pick's own window — the real
                              // edge (strips out market beta; null until any pick has a market baseline)
  bestPick: string;
  worstPick: string;
}

// ── Redis (persistent, NOT TTL'd — this is the historical record) ──────────────
// Stored as one JSON blob keyed by ticker. The ledger is small (tens of picks) and
// has a single daily writer (/api/influencer-cache), so read-modify-write is safe.

// Returns the ledger, {} for a GENUINE miss (key absent), or null on a READ ERROR
// (store unconfigured / non-2xx / network or parse failure). Callers writing back MUST
// distinguish the two: this is an ACCUMULATING record, so a transient read hiccup must
// never be treated as "empty" and then overwritten — that would wipe real history.
async function ledgerGet(): Promise<Record<string, LedgerPick> | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${LEDGER_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: string | null };
    if (json.result == null) return {}; // key doesn't exist yet — a genuine empty ledger
    return JSON.parse(json.result) as Record<string, LedgerPick>;
  } catch {
    return null; // network / JSON error — do NOT let the caller overwrite on this
  }
}

async function ledgerSet(data: Record<string, LedgerPick>): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", LEDGER_KEY, JSON.stringify(data)]]),
  });
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

// Collapse a cache into per-ticker {channels, best confidence}. A ticker's score is the
// cache's own weighted tickerCounts (high=3/med=2/low=1, summed across all mentions).
function perTicker(cache: InfluencerCache): Map<string, { channels: Set<string>; conf: Confidence }> {
  const byTicker = new Map<string, { channels: Set<string>; conf: Confidence }>();
  for (const sig of cache.signals) {
    const conf = (["high", "medium", "low"].includes(sig.confidence) ? sig.confidence : "low") as Confidence;
    for (const t of sig.tickers) {
      const e = byTicker.get(t) ?? { channels: new Set<string>(), conf: "low" as Confidence };
      e.channels.add(sig.channelName);
      if (CONF_RANK[conf] > CONF_RANK[e.conf]) e.conf = conf;
      byTicker.set(t, e);
    }
  }
  return byTicker;
}

// Upsert one OPEN episode per ticker from a freshly-refreshed cache. New qualifying
// tickers are logged with today's price as the baseline; already-tracked tickers just
// accumulate channels / bump score / extend lastSeen (baseline price is preserved, so
// the return is measured from the FIRST recommendation, not each re-mention).
// Called from /api/influencer-cache after each refresh. Fail-safe on any Redis error.
export async function recordPicks(
  cache: InfluencerCache,
  today: string,
): Promise<{ recorded: number; updated: number; skipped?: boolean }> {
  const byTicker = perTicker(cache);
  const ledger = await ledgerGet();
  // Read failed (or no store) — skip the write entirely. Overwriting with only today's
  // picks would clobber the accumulated history this ledger exists to keep.
  if (ledger === null) return { recorded: 0, updated: 0, skipped: true };
  let recorded = 0;
  let updated = 0;

  const net = netScores(cache); // buy consensus − avoid dissent — the actual buyable signal
  // Fetch baselines for genuinely-new qualifying tickers in parallel.
  const newTickers = [...byTicker.entries()].filter(
    ([t]) => (net[t] ?? 0) >= MIN_SCORE && !ledger[t],
  );
  const prices = new Map(
    await Promise.all(
      newTickers.map(async ([t]) => [t, (await fetchQuoteLite(t))?.price ?? null] as const),
    ),
  );

  for (const [ticker, e] of byTicker) {
    const score = net[ticker] ?? 0;
    if (score < MIN_SCORE) continue;
    const existing = ledger[ticker];
    if (existing) {
      existing.channels = [...new Set([...existing.channels, ...e.channels])];
      existing.maxScore = Math.max(existing.maxScore, score);
      if (CONF_RANK[e.conf] > CONF_RANK[existing.maxConfidence]) existing.maxConfidence = e.conf;
      existing.lastSeenDate = today;
      updated++;
    } else {
      const price = prices.get(ticker);
      if (price == null || price <= 0) continue; // can't baseline without a price
      ledger[ticker] = {
        ticker,
        channels: [...e.channels],
        maxScore: score,
        maxConfidence: e.conf,
        firstSeenDate: today,
        lastSeenDate: today,
        priceAtSignal: price,
      };
      recorded++;
    }
  }

  await ledgerSet(ledger);
  return { recorded, updated };
}

// Score every tracked pick's forward return and roll up per channel. Read-only.
export async function computeAttribution(
  today: string,
): Promise<{ picks: PickOutcome[]; channels: ChannelStats[] }> {
  // Read-only path: a null (read error) is safe to treat as empty here — nothing is written.
  const ledger = await ledgerGet();
  const entries = Object.values(ledger ?? {});

  // SPY price by date, from the daily run records, so each pick's return can be measured AGAINST the
  // market over its OWN window. This turns "went up in a bull market" (beta) into genuine edge (alpha)
  // — without it, every channel reads strongly positive simply because the index rose. Fail-safe: no
  // runs → no market baseline → alpha stays null and only the raw return shows.
  const runs = await getRuns(120).catch(() => []);
  const spyByDate = new Map<string, number>();
  for (const r of runs) if (typeof r.spyPrice === "number") spyByDate.set(r.date, r.spyPrice);
  // "now" for SPY must be LIVE (like each pick's current price), so the window matches: firstSeen→now
  // on both legs. Fall back to the latest run's close if the live quote fails.
  const spyNow = (await fetchQuoteLite("SPY").catch(() => null))?.price
    ?? runs.map((r) => r.spyPrice).find((x): x is number => typeof x === "number")
    ?? null;

  const picks: PickOutcome[] = await Promise.all(
    entries.map(async (p) => {
      const currentPrice = (await fetchQuoteLite(p.ticker))?.price ?? null;
      const returnPct =
        currentPrice != null && p.priceAtSignal > 0
          ? (currentPrice / p.priceAtSignal - 1) * 100
          : null;
      const spyThen = spyByDate.get(p.firstSeenDate) ?? null;
      const marketReturnPct =
        spyNow != null && spyThen != null && spyThen > 0 ? (spyNow / spyThen - 1) * 100 : null;
      const alphaPct = returnPct != null && marketReturnPct != null ? returnPct - marketReturnPct : null;
      return { ...p, currentPrice, returnPct, marketReturnPct, alphaPct, daysElapsed: daysBetween(p.firstSeenDate, today) };
    }),
  );

  // Per-channel: credit each contributing channel with the pick's RAW return and its market-relative
  // alpha. avgReturn mixes horizons (each pick has its own daysElapsed) — a known v1 limitation; alpha
  // corrects for the market's move over that same horizon, so it's the edge measure worth ranking on.
  const byChannel = new Map<string, { ret: number; alpha: number | null; ticker: string }[]>();
  for (const p of picks) {
    if (p.returnPct == null) continue;
    for (const ch of p.channels) {
      const arr = byChannel.get(ch) ?? [];
      arr.push({ ret: p.returnPct, alpha: p.alphaPct, ticker: p.ticker });
      byChannel.set(ch, arr);
    }
  }
  const channels: ChannelStats[] = [...byChannel.entries()]
    .map(([channel, rows]) => {
      const rets = rows.map((r) => r.ret);
      const alphas = rows.map((r) => r.alpha).filter((a): a is number => a != null);
      const best = rows.reduce((a, b) => (b.ret > a.ret ? b : a));
      const worst = rows.reduce((a, b) => (b.ret < a.ret ? b : a));
      return {
        channel,
        picks: rets.length,
        hitRatePct: (rets.filter((r) => r > 0).length / rets.length) * 100,
        avgReturnPct: rets.reduce((a, b) => a + b, 0) / rets.length,
        avgAlphaPct: alphas.length ? alphas.reduce((a, b) => a + b, 0) / alphas.length : null,
        bestPick: `${best.ticker} ${best.ret >= 0 ? "+" : ""}${best.ret.toFixed(1)}%`,
        worstPick: `${worst.ticker} ${worst.ret >= 0 ? "+" : ""}${worst.ret.toFixed(1)}%`,
      };
    })
    // Rank by EDGE (alpha over the market), not raw return — that's the whole point. Channels with no
    // market baseline yet fall back to raw return so they still sort sensibly.
    .sort((a, b) => (b.avgAlphaPct ?? b.avgReturnPct) - (a.avgAlphaPct ?? a.avgReturnPct));

  picks.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
  return { picks, channels };
}
