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
  returnPct: number | null;  // (current / priceAtSignal − 1) × 100
  daysElapsed: number;       // firstSeen → today (horizons vary; exposed for transparency)
}

export interface ChannelStats {
  channel: string;
  picks: number;             // measurable picks (a live price was available)
  hitRatePct: number;        // % of picks with returnPct > 0
  avgReturnPct: number;      // simple mean of pick returns (mixed horizons — see daysElapsed)
  probRealPct: number | null; // chance the channel's edge is REAL not luck (one-sample t-test); null until ≥3 picks
  bestPick: string;
  worstPick: string;
}

// ─── small-sample significance for a channel's returns ───────────────────────
// "% likely real" = probability the channel's TRUE mean pick-return is positive (a genuine edge, not
// luck), from a one-sample t-test on its picks. This ledger deals in TINY samples (a few picks per
// channel), so we use the Student-t distribution — the normal approx would badly overstate confidence
// at n=3–5. Returns null until ≥3 picks, because a t-test needs ≥2 degrees of freedom to say anything.
function lgamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015, y = z;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-30, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * betai(df / 2, 0.5, df / (df + t * t)); // P(T > |t|)
  return t >= 0 ? 1 - tail : tail;
}
export function channelProbRealPct(rets: number[]): number | null {
  const n = rets.length;
  if (n < 3) return null; // a t-test needs ≥2 df to be meaningful
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)); // sample sd
  if (sd === 0) return mean > 0 ? 100 : mean < 0 ? 0 : 50;
  return studentTCdf(mean / (sd / Math.sqrt(n)), n - 1) * 100;
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

  const picks: PickOutcome[] = await Promise.all(
    entries.map(async (p) => {
      const currentPrice = (await fetchQuoteLite(p.ticker))?.price ?? null;
      const returnPct =
        currentPrice != null && p.priceAtSignal > 0
          ? (currentPrice / p.priceAtSignal - 1) * 100
          : null;
      return { ...p, currentPrice, returnPct, daysElapsed: daysBetween(p.firstSeenDate, today) };
    }),
  );

  // Per-channel: credit each contributing channel with the pick's return. avgReturn
  // mixes horizons (each pick has its own daysElapsed) — a known v1 limitation.
  const byChannel = new Map<string, { ret: number; ticker: string }[]>();
  for (const p of picks) {
    if (p.returnPct == null) continue;
    for (const ch of p.channels) {
      const arr = byChannel.get(ch) ?? [];
      arr.push({ ret: p.returnPct, ticker: p.ticker });
      byChannel.set(ch, arr);
    }
  }
  const channels: ChannelStats[] = [...byChannel.entries()]
    .map(([channel, rows]) => {
      const rets = rows.map((r) => r.ret);
      const best = rows.reduce((a, b) => (b.ret > a.ret ? b : a));
      const worst = rows.reduce((a, b) => (b.ret < a.ret ? b : a));
      return {
        channel,
        picks: rets.length,
        hitRatePct: (rets.filter((r) => r > 0).length / rets.length) * 100,
        avgReturnPct: rets.reduce((a, b) => a + b, 0) / rets.length,
        probRealPct: channelProbRealPct(rets),
        bestPick: `${best.ticker} ${best.ret >= 0 ? "+" : ""}${best.ret.toFixed(1)}%`,
        worstPick: `${worst.ticker} ${worst.ret >= 0 ? "+" : ""}${worst.ret.toFixed(1)}%`,
      };
    })
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct);

  picks.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
  return { picks, channels };
}
