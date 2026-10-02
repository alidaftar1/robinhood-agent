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

import { fetchQuoteLite, fetchDailyBars, firstCloseAfter } from "@/lib/market-data";
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

// Per-CHANNEL baseline. A channel is credited only from ITS OWN first mention forward.
// Before this existed, every channel on a ticker inherited the pick-level baseline, so a channel
// that mentioned an already-logged winner was credited with the entire prior run-up — which
// systematically rewarded channels for discussing names that were already working.
export interface ChannelEntry {
  firstSeenDate: string;   // when THIS channel first mentioned the ticker
  priceAtSignal: number;   // price on that date — this channel's own baseline
  // True for entries migrated from the pre-2026-10-02 shape, where only one shared baseline was
  // stored. Their per-channel mention dates are UNRECOVERABLE (never recorded), so they keep the
  // old inflated baseline. Surfaced rather than hidden so a channel's stat can say how much of it
  // is still union-credited instead of quietly mixing the two.
  inherited?: boolean;
  // "publish" = baselined at the first close AFTER the video went up (what we want).
  // "refresh" = that close could not be resolved (no bars, unsupported symbol, or the video is
  // newer than the latest session) and the entry fell back to the refresh date + live price. The
  // pair stays internally consistent either way; this says which, so a fallback is never read as a
  // real publish-date baseline. Absent on rows written before publish-date baselining existed.
  baselineSource?: "publish" | "refresh";
}

export interface LedgerPick {
  ticker: string;
  channels: string[];        // union of channels that recommended it while open
  maxScore: number;          // peak weighted mention score (high=3/med=2/low=1, summed)
  maxConfidence: Confidence;
  firstSeenDate: string;     // YYYY-MM-DD — the TICKER-level baseline date (first sighting, any channel)
  lastSeenDate: string;
  priceAtSignal: number;     // price when first logged (the ticker-level baseline)
  channelEntries?: Record<string, ChannelEntry>; // optional: absent on rows written before the fix
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
  // How many of `picks` still use a baseline inherited from the pre-fix union-credit shape.
  // inheritedPicks === picks means the whole row is still the OLD measure; 0 means it is fully
  // credited from the channel's own first mentions.
  inheritedPicks: number;
  // How many of `picks` actually have a SPY baseline, i.e. contribute to avgAlphaPct. Channels are
  // RANKED on alpha, and per-channel baselines multiplied the number of dates that must be present
  // in the run history (one per channel-per-ticker, not one per ticker), so a channel can now be
  // ranked on a strict subset of its credits. Without this the shortfall is invisible.
  alphaPicks: number;
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
// `channels` maps channel -> the EARLIEST publishedAt of its videos mentioning this ticker. The
// video's publish time, not the cron's refresh time, is when the call was actually made; the refresh
// can be a day or more later, and for anything already being discussed when the ledger first ran it
// was months later. Carrying it per channel is what lets each channel be baselined at its own call.
function perTicker(cache: InfluencerCache): Map<string, { channels: Map<string, string>; conf: Confidence }> {
  const byTicker = new Map<string, { channels: Map<string, string>; conf: Confidence }>();
  for (const sig of cache.signals) {
    const conf = (["high", "medium", "low"].includes(sig.confidence) ? sig.confidence : "low") as Confidence;
    for (const t of sig.tickers) {
      const e = byTicker.get(t) ?? { channels: new Map<string, string>(), conf: "low" as Confidence };
      const prev = e.channels.get(sig.channelName);
      if (!prev || (sig.publishedAt && sig.publishedAt < prev)) e.channels.set(sig.channelName, sig.publishedAt);
      if (CONF_RANK[conf] > CONF_RANK[e.conf]) e.conf = conf;
      byTicker.set(t, e);
    }
  }
  return byTicker;
}

// Back-fill per-channel entries for a row written before they existed. PURE and exported so the
// flagging rule is unit-testable — it decides which history is trustworthy, and getting it wrong in
// either direction is costly: over-flagging permanently mislabels correctly-measured picks as
// contaminated, under-flagging hides real union credit.
//
// Pre-fix, `priceAtSignal` WAS each channel's own baseline for every channel present on day one.
// The inflation only arises for channels APPENDED after the first sighting. So a row never touched
// again (firstSeenDate === lastSeenDate) cannot have gained a late channel and its credit is sound.
// For re-touched rows we cannot tell WHICH channels were late, so all are flagged — the
// conservative direction, and the most the stored data supports.
export function migratedChannelEntries(existing: LedgerPick): Record<string, ChannelEntry> {
  const mayBeContaminated = existing.firstSeenDate !== existing.lastSeenDate;
  return Object.fromEntries(
    existing.channels.map((ch) => [ch, {
      firstSeenDate: existing.firstSeenDate,
      priceAtSignal: existing.priceAtSignal,
      ...(mayBeContaminated ? { inherited: true } : {}),
    }]),
  );
}

// Upsert one OPEN episode per ticker from a freshly-refreshed cache. New qualifying
// tickers are logged with today's price as the baseline; already-tracked tickers just
// accumulate channels / bump score / extend lastSeen (baseline price is preserved, so
// the return is measured from the FIRST recommendation, not each re-mention).
// Called from /api/influencer-cache after each refresh. Fail-safe on any Redis error.
export async function recordPicks(
  cache: InfluencerCache,
  today: string,
): Promise<{ recorded: number; updated: number; withheld?: number; skipped?: boolean }> {
  const byTicker = perTicker(cache);
  const ledger = await ledgerGet();
  // Read failed (or no store) — skip the write entirely. Overwriting with only today's
  // picks would clobber the accumulated history this ledger exists to keep.
  if (ledger === null) return { recorded: 0, updated: 0, skipped: true };
  let recorded = 0;
  let updated = 0;
  // Credits we could NOT establish a baseline for. Counted and logged because the withhold is
  // otherwise invisible: `updated`/`lastSeenDate` still advance, so a run that credited nothing
  // reported a clean update. A mention whose video later ages out of the transcript window is lost,
  // so this number needs to be watchable rather than inferred.
  let withheld = 0;

  const net = netScores(cache); // buy consensus − avoid dissent — the actual buyable signal
  // A price is needed for any ticker that is NEW, *or* that an already-tracked ticker gained a NEW
  // CHANNEL on — the new channel needs its OWN baseline, taken at its own call. Fetching only for
  // new tickers (the pre-fix behaviour) is what forced late mentions onto the original baseline.
  const needsPrice = [...byTicker.entries()].filter(([t, e]) => {
    if ((net[t] ?? 0) < MIN_SCORE) return false;
    const existing = ledger[t];
    if (!existing) return true;
    const credited = new Set(Object.keys(existing.channelEntries ?? {}).length ? Object.keys(existing.channelEntries!) : existing.channels);
    return [...e.channels.keys()].some((ch) => !credited.has(ch));
  });
  // Live price (the fallback) AND the month of daily bars used to resolve each channel's
  // publish-date baseline. Both are fetched once per ticker, in parallel, so adding publish-date
  // baselining costs one extra request per NEW credit rather than one per channel.
  const quotes = new Map(
    await Promise.all(
      needsPrice.map(async ([t]) => {
        const [live, bars] = await Promise.all([fetchQuoteLite(t), fetchDailyBars(t)]);
        return [t, { live: live?.price ?? null, bars }] as const;
      }),
    ),
  );

  // Baseline for ONE channel's call: the first close AFTER its earliest video on this ticker.
  // Falls back to the refresh date + live price when that cannot be resolved — a consistent pair,
  // flagged so it is never read as a publish-date baseline. Returns null only when neither exists,
  // which is the fail-closed case the caller counts as withheld.
  const baselineFor = (ticker: string, publishedAt: string | undefined): ChannelEntry | null => {
    const q = quotes.get(ticker);
    const published = publishedAt ? Date.parse(publishedAt) : NaN;
    if (q?.bars && Number.isFinite(published)) {
      const hit = firstCloseAfter(q.bars, Math.floor(published / 1000));
      if (hit && hit.close > 0) {
        return { firstSeenDate: hit.date, priceAtSignal: hit.close, baselineSource: "publish" };
      }
    }
    if (q?.live != null && q.live > 0) {
      return { firstSeenDate: today, priceAtSignal: q.live, baselineSource: "refresh" };
    }
    return null;
  };

  for (const [ticker, e] of byTicker) {
    const score = net[ticker] ?? 0;
    if (score < MIN_SCORE) continue;
    const existing = ledger[ticker];
    if (existing) {
      // Migrate on first touch: rows written before per-channel baselines existed carry only one
      // shared baseline. Those channels' own mention dates were never recorded and cannot be
      // reconstructed, so they keep the old baseline and are tagged `inherited` — the fix stops the
      // inflation accruing, it does not retroactively correct it.
      if (!existing.channelEntries) existing.channelEntries = migratedChannelEntries(existing);
      for (const [ch, publishedAt] of e.channels) {
        if (existing.channelEntries[ch]) continue; // already credited — keep its EARLIEST baseline
        // Fail CLOSED: with no baseline at all we cannot measure this channel's call. Falling back
        // to the TICKER's baseline is precisely the union-credit bug, so withhold and retry next
        // run (a day late beats crediting a run-up the channel was not present for).
        const entry = baselineFor(ticker, publishedAt);
        if (!entry) { withheld++; continue; }
        existing.channelEntries[ch] = entry;
      }
      // channels[] stays in lock-step with what is actually credited, so the two can't disagree.
      existing.channels = Object.keys(existing.channelEntries);
      existing.maxScore = Math.max(existing.maxScore, score);
      if (CONF_RANK[e.conf] > CONF_RANK[existing.maxConfidence]) existing.maxConfidence = e.conf;
      existing.lastSeenDate = today;
      updated++;
    } else {
      // Each channel on a brand-new ticker is baselined at ITS OWN call, not at the refresh — two
      // channels can mention the same new name days apart and must not share a baseline.
      const entries: Record<string, ChannelEntry> = {};
      for (const [ch, publishedAt] of e.channels) {
        const entry = baselineFor(ticker, publishedAt);
        if (!entry) { withheld++; continue; }
        entries[ch] = entry;
      }
      // Nothing measurable → do not create the row at all. A row with no credited channel would
      // sit in the ledger forever contributing to no channel's stats.
      if (!Object.keys(entries).length) continue;
      // Ticker-level baseline = the EARLIEST channel call, so the pick-level return and the
      // per-channel returns are on the same footing rather than the pick silently using the
      // refresh date while its channels use publish dates.
      const earliest = Object.values(entries).reduce((a, b) => (b.firstSeenDate < a.firstSeenDate ? b : a));
      ledger[ticker] = {
        ticker,
        channels: Object.keys(entries),
        maxScore: score,
        maxConfidence: e.conf,
        firstSeenDate: earliest.firstSeenDate,
        lastSeenDate: today,
        priceAtSignal: earliest.priceAtSignal,
        // Every channel on a brand-new ticker genuinely starts at its own call — none is inherited.
        channelEntries: entries,
      };
      recorded++;
    }
  }

  await ledgerSet(ledger);
  if (withheld > 0) {
    console.warn("INFLUENCER_LEDGER_CREDIT_WITHHELD", { withheld, today, reason: "no baseline price for a newly-mentioning channel" });
  }
  return { recorded, updated, ...(withheld > 0 ? { withheld } : {}) };
}

// Per-channel rollup, extracted as a PURE function so the credit rule is unit-testable without
// Redis or a live quote. This is where the union-credit fix lives, and an untested credit rule is
// how the original one shipped: every channel on a ticker took the ticker's whole return.
export function rollupChannels(
  picks: PickOutcome[],
  spyByDate: Map<string, number>,
  spyNow: number | null,
): ChannelStats[] {
  const byChannel = new Map<string, { ret: number; alpha: number | null; ticker: string; inherited: boolean }[]>();
  for (const p of picks) {
    if (p.currentPrice == null) continue;
    for (const ch of p.channels) {
      // Credit this channel from ITS OWN first mention, not the ticker's first sighting. Rows with
      // no channelEntries predate the fix and fall back to the ticker-level baseline (flagged
      // inherited), which is the old union-credit number — the only thing the stored data supports.
      const entry = p.channelEntries?.[ch];
      const base = entry?.priceAtSignal ?? p.priceAtSignal;
      const baseDate = entry?.firstSeenDate ?? p.firstSeenDate;
      const inherited = entry ? entry.inherited === true : true;
      if (!(base > 0)) continue;
      const ret = (p.currentPrice / base - 1) * 100;
      const spyThen = spyByDate.get(baseDate) ?? null;
      const alpha = spyNow != null && spyThen != null && spyThen > 0
        ? ret - (spyNow / spyThen - 1) * 100
        : null;
      const arr = byChannel.get(ch) ?? [];
      arr.push({ ret, alpha, ticker: p.ticker, inherited });
      byChannel.set(ch, arr);
    }
  }
  return [...byChannel.entries()]
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
        inheritedPicks: rows.filter((r) => r.inherited).length,
        alphaPicks: alphas.length,
      };
    })
    // Rank by EDGE (alpha over the market), not raw return — that's the whole point. Channels with no
    // market baseline yet fall back to raw return so they still sort sensibly.
    .sort((a, b) => (b.avgAlphaPct ?? b.avgReturnPct) - (a.avgAlphaPct ?? a.avgReturnPct));

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
  const channels = rollupChannels(picks, spyByDate, spyNow);

  picks.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
  return { picks, channels };
}
