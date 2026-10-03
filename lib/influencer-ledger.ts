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

import { fetchQuoteLite, fetchDailyBars, firstCloseAfter, closeOnOrAfterDate, addDays, STOCK_SECTOR, type DatedBars } from "@/lib/market-data";
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
// TRACKING threshold, deliberately BELOW the buy floor. The ledger used to track only what the
// sleeve would buy, which threw away every lower-conviction mention — the bulk of what these
// channels actually say — and left the most actionable question unanswerable: does the buy floor
// earn its keep? Comparing two cohorts needs far less data than ranking seven channels, and it has
// an action attached (raise, lower or keep the threshold) that a channel ranking will not have for
// years.
//
// The cohorts must NEVER be pooled. Required n scales with (sigma/effect)^2, so mixing
// low-conviction mentions into one average halves the effect while leaving the noise, which pushes
// required n UP ~4x while looking like more data. scoreAtEntry is stored per credit so the split
// survives into the stats.
export const MIN_TRACK_SCORE = 1;
const MIN_SCORE = MIN_TRACK_SCORE;
// WHAT THIS LEDGER MEASURES, stated because the two readings diverge and the old comment above
// claimed only one of them. MIN_SCORE keeps WHICH picks are TRACKED in lock-step with the buy
// floor. It does NOT make the BASELINE an executable entry price: `net` is computed over the whole
// ~7-day cache, so a ticker can sit below the floor for days and cross it only today, while its
// earliest credited video is days old. The baseline is that video's first close, so the pick can
// report a run-up the SLEEVE could never have taken (it would not have bought until the floor was
// crossed).
// That is deliberate: this ledger answers "which CHANNELS have edge", and a channel that called a
// name before it ran deserves the credit for exactly that. The "what could the strategy actually
// capture" question is answered by the SIGNAL ledger (lib/signal-ledger.ts), which measures our
// real buys. Do not reconcile these two numbers — they are different questions, and conflating
// them is what made the influencer scorecard wrong twice before.

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
  /** Set when THIS channel later told people to AVOID the name. The credit is frozen here: return is
   *  measured firstSeenDate → closedDate, not → now.
   *
   *  Without this a channel that correctly calls the exit is charged with the crash it warned
   *  about, while one that says avoid before a rally is credited with the rally — the bias runs
   *  against exactly the behaviour worth rewarding. Nothing else in the ledger closes a position,
   *  so an avoid was previously invisible: it lowers the NET score, and once net drops below the
   *  buy floor recordPicks skips the ticker entirely, which stops UPDATING the row while leaving
   *  the credit open and accruing forever.
   *
   *  One-way on purpose. A later re-recommendation does NOT reopen it: this store holds one row per
   *  ticker and cannot represent two episodes, so reopening would silently splice two separate
   *  calls into one return. A re-entry is a second episode and needs a model that has them. */
  closedDate?: string;
  closePrice?: number;
  /** The ticker's NET score when this credit was created. Decides which cohort the credit belongs
   *  to — at or above INFLUENCER_BUY_FLOOR is what the sleeve would actually buy. Absent on rows
   *  written before tracking went below the floor; those are all buy-floor picks by construction,
   *  since nothing else was tracked. */
  scoreAtEntry?: number;
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
  /** Every pick credited to this channel with its own return, best first. The aggregates alone are
   *  unreadable without this: a channel's "27 picks" turned out to be one watchlist video naming 17
   *  tickers at once, and nothing in the table said so. Showing the constituents makes a hit rate
   *  auditable against what the channel actually named. */
  tickerReturns: Array<{ ticker: string; retPct: number; closed?: true }>;
  /** Credits frozen because the channel later said AVOID. Measured to that close, not to now. */
  closedPicks: number;
  /** Picks whose window has not finished — no avoid yet and under HORIZON_DAYS old. EXCLUDED from
   *  every stat above, and counted here so a thin sample cannot pass for a full one. */
  pendingPicks: number;
  /** Mean return above/below the pick's OWN SECTOR ETF over its own window.
   *
   *  The sharpest available lever on how long this table takes to mean anything. These picks are
   *  overwhelmingly AI/semis, so "alpha vs SPY" still carries a large common sector factor — which
   *  is both why σ is ~14-15% per 30-day pick AND why the picks are correlated. Correlation is the
   *  binding constraint: with average pairwise ρ the confidence interval never shrinks past
   *  ±1.96σ√ρ no matter how many simultaneous picks accrue (≈±9pp at ρ=0.1). Residualising against
   *  the sector removes most of that common factor, so it both lowers σ and lifts the floor.
   *  Null for anything with no sector mapping — crypto, ETFs, non-S&P names. */
  avgSectorAlphaPct: number | null;
  /** How many picks actually had a sector benchmark, since the rest are silently absent from it. */
  sectorPicks: number;
  /** Mean return above/below the average pick whose window OVERLAPS this one.
   *
   *  Asks "did this channel beat the other picks made at the same time" instead of "did it beat
   *  zero", which differences out the regime and the sector wave entirely. Here correlation works
   *  FOR the measure rather than against it. Same idea as the signal ledger's `vs avg pick`, which
   *  already got this right, applied to channels. Null when nothing overlapped. */
  avgPeerRelPct: number | null;
  /** Median days held across the measured picks. Surfaced because earliest-wins means windows are
   *  NOT uniform — a 12-day exit and a 30-day hold are averaged together — so the mixing has to be
   *  visible rather than implied by a constant. */
  medianHoldDays: number | null;
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

// Baseline for ONE channel's call: the first SETTLED close after its earliest video on this
// ticker. Returns null when no session has closed yet, and the caller WITHHOLDS the credit.
//
// There is deliberately NO live-price fallback, and that is the whole correctness argument.
// This cron runs at 13:00 UTC — THIRTY MINUTES BEFORE the 13:30 UTC open. So for any video
// published since the previous close (i.e. every genuinely fresh pick) today's bar does not
// exist yet. A live-price fallback would baseline the channel at a PRE-MARKET price and credit
// it with the entire day's move, permanently — the next run short-circuits on
// `channelEntries[ch]` and never revisits it. That is the look-ahead firstCloseAfter exists to
// remove, reintroduced on the most common path, which is strictly worse than being a day late.
//
// Withholding self-heals: the video stays inside the ~7-day search window, so the NEXT run finds
// a settled close and credits the channel from it. Worked example — a Friday-evening video is
// withheld Monday (Monday's bar not open yet) and credited Tuesday from MONDAY's close, 4 days
// old and still in-window. The cost is a credit appearing a day late; the benefit is that it is
// never measured from a price that preceded the call.
//
// A ticker Yahoo has no daily bars for (an odd symbol, some crypto) is therefore never credited.
// That is the honest outcome — we cannot measure it — and the withheld counter plus
// INFLUENCER_LEDGER_CREDIT_WITHHELD make it visible rather than silent.
export function baselineForCall(
  bars: DatedBars | null | undefined,
  publishedAt: string | undefined,
): ChannelEntry | null {
    const published = publishedAt ? Date.parse(publishedAt) : NaN;
    if (!bars || !Number.isFinite(published)) return null;
    const hit = firstCloseAfter(bars, Math.floor(published / 1000));
    if (!hit || !(hit.close > 0)) return null;
    return { firstSeenDate: hit.date, priceAtSignal: hit.close, baselineSource: "publish" };
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

/** Per-ticker AVOID mentions: channel -> earliest publishedAt that warned against it. Mirrors
 *  perTicker, reading sig.avoidTickers instead of sig.tickers. Kept separate because an avoid must
 *  be processed even when the ticker no longer clears the buy floor — avoids are what push it
 *  below, so folding this into the score-gated path would make a closing signal unreachable
 *  exactly when it fires hardest. */
function avoidsPerTicker(cache: InfluencerCache): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const sig of cache.signals) {
    for (const t of sig.avoidTickers ?? []) {
      const e = out.get(t) ?? new Map<string, string>();
      const prev = e.get(sig.channelName);
      if (!prev || (sig.publishedAt && sig.publishedAt < prev)) e.set(sig.channelName, sig.publishedAt);
      out.set(t, e);
    }
  }
  return out;
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
  const avoidsByTicker = avoidsPerTicker(cache);
  // A ticker needs bars if it may gain a credit OR may CLOSE one. Closable = already in the ledger,
  // with an open entry for a channel that has since warned against it.
  const closableTickers = [...avoidsByTicker.entries()].filter(([t, chans]) => {
    const row = ledger[t];
    if (!row?.channelEntries) return false;
    return [...chans.keys()].some(ch => row.channelEntries![ch] && row.channelEntries![ch].closedDate == null);
  }).map(([t]) => t);
  const needsPrice = [...byTicker.entries()].filter(([t, e]) => {
    if ((net[t] ?? 0) < MIN_SCORE) return false;
    const existing = ledger[t];
    if (!existing) return true;
    const credited = new Set(Object.keys(existing.channelEntries ?? {}).length ? Object.keys(existing.channelEntries!) : existing.channels);
    return [...e.channels.keys()].some((ch) => !credited.has(ch));
  });
  // A month of daily bars per ticker needing a new credit — one request each, in parallel. No live
  // quote: it is not a usable baseline here (see baselineFor), so fetching one would only invite
  // its reintroduction as a fallback.
  const barTickers = [...new Set([...needsPrice.map(([t]) => t), ...closableTickers])];
  const quotes = new Map(
    await Promise.all(
      barTickers.map(async (t) => [t, { bars: await fetchDailyBars(t) }] as const),
    ),
  );

  const baselineFor = (ticker: string, publishedAt: string | undefined): ChannelEntry | null =>
    baselineForCall(quotes.get(ticker)?.bars, publishedAt);

  // CLOSE first, and OUTSIDE the score gate. Avoids are what push a ticker below the buy floor, so
  // closing inside the gated loop would make this unreachable precisely when the signal is
  // strongest — the `continue` below skips the ticker entirely.
  let closed = 0;
  for (const [ticker, chans] of avoidsByTicker) {
    const row = ledger[ticker];
    if (!row?.channelEntries) continue;
    for (const [ch, avoidAt] of chans) {
      const entry = row.channelEntries[ch];
      if (!entry || entry.closedDate != null) continue; // not credited, or already closed (one-way)
      // An avoid published BEFORE this channel's own entry is not a reversal of it — it belongs to
      // an earlier episode this one-row-per-ticker store cannot represent. Ignore rather than
      // closing a position at a price that predates it, which would invert the sign of the result.
      if (!avoidAt || avoidAt.slice(0, 10) < entry.firstSeenDate) continue;
      const close = baselineForCall(quotes.get(ticker)?.bars, avoidAt);
      if (!close) continue; // no settled close after the warning yet — retry next run
      entry.closedDate = close.firstSeenDate;
      entry.closePrice = close.priceAtSignal;
      closed++;
    }
  }
  if (closed > 0) console.log("INFLUENCER_LEDGER_CREDITS_CLOSED", { closed, today });

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
        existing.channelEntries[ch] = { ...entry, scoreAtEntry: score };
      }
      // channels[] stays in lock-step with what is actually credited, so the two can't disagree.
      existing.channels = Object.keys(existing.channelEntries);
      // Keep the ticker-level baseline at the EARLIEST credited channel call. A channel credited
      // later can easily have published EARLIER (a video reaching the cache a day late, or a
      // ticker that only just crossed the score floor), and without this the pick-level return
      // would be measured from a LATER baseline than one of its own credited channels — the same
      // pick-vs-channel mismatch the new-row branch is careful to avoid.
      const earliestEntry = Object.values(existing.channelEntries)
        .reduce<ChannelEntry | null>((a, b) => (a == null || b.firstSeenDate < a.firstSeenDate ? b : a), null);
      if (earliestEntry && earliestEntry.firstSeenDate < existing.firstSeenDate) {
        existing.firstSeenDate = earliestEntry.firstSeenDate;
        existing.priceAtSignal = earliestEntry.priceAtSignal;
      }
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
        entries[ch] = { ...entry, scoreAtEntry: score };
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
/**
 * How long a credit is measured for, unless the channel closes it sooner.
 *
 * Without a horizon every return runs first-sighting → now, so "hit" means "green at this instant"
 * and the stats drift with the market instead of reflecting decisions. 30 calendar days also BOUNDS
 * the window mixing: earliest-wins keeps windows non-uniform (a 12-day exit vs a 30-day hold), but
 * capped at 30 rather than unbounded-and-growing, which was 66+ days and climbing.
 */
export const HORIZON_DAYS = 30;

/**
 * EARLIEST WINS. A credit ends at the channel's own avoid, or at HORIZON_DAYS, whichever comes
 * first — because the question being answered is "what did following this channel return", which
 * includes its exit timing. Charging it for the 18 days after it said get out is the bias the
 * avoid-close removed; holding past 30 days is the open-ended drift the horizon removes.
 *
 * `barsByTicker` is optional: without bars the horizon cannot be resolved and the function degrades
 * to the previous open-ended measure rather than marking everything pending.
 */
/** Mean of the non-null values, or null when there are none — never 0, which would read as "no edge". */
function mean(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function rollupChannels(
  picks: PickOutcome[],
  spyByDate: Map<string, number>,
  spyNow: number | null,
  barsByTicker?: Map<string, DatedBars>,
  sectorBarsByEtf?: Map<string, DatedBars>,
  /** Restricts the rollup to one COHORT by the credit's scoreAtEntry. Cohorts are reported
   *  separately and never pooled — see MIN_TRACK_SCORE for why pooling would slow the measurement
   *  down rather than speed it up. A credit with no scoreAtEntry predates sub-floor tracking and is
   *  a buy-floor pick by construction. */
  cohort?: (scoreAtEntry: number) => boolean,
): ChannelStats[] {
  type Credit = {
    channel: string; ticker: string; ret: number; alpha: number | null; sectorAlpha: number | null;
    inherited: boolean; closed: boolean; heldDays: number; start: string; end: string;
  };
  const credits: Credit[] = [];
  const pendingByChannel = new Map<string, number>();
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
      // Cohort filter. An absent scoreAtEntry predates sub-floor tracking, so it is treated as a
      // buy-floor pick — that is what it was, since nothing below the floor was recorded then.
      if (cohort && !cohort(entry?.scoreAtEntry ?? INFLUENCER_BUY_FLOOR)) continue;
      if (!(base > 0)) continue;
      // A CLOSED credit is measured to its close, not to now: the channel told people out, so the
      // move after that is not theirs. BOTH legs must use the same end — taking the price at the
      // close while measuring SPY to today would leave the market's subsequent move inside alpha,
      // which is the same clock mismatch already fixed on the baseline side.
      const avoidAt = entry?.closedDate && entry.closePrice != null && entry.closePrice > 0
        ? { date: entry.closedDate, price: entry.closePrice }
        : null;
      // The horizon mark, if bars are available and day 30 has actually traded.
      const bars = barsByTicker?.get(p.ticker);
      const horizonHit = bars ? closeOnOrAfterDate(bars, addDays(baseDate, HORIZON_DAYS)) : null;
      const horizonAt = horizonHit && horizonHit.close > 0
        ? { date: horizonHit.date, price: horizonHit.close }
        : null;
      // EARLIEST WINS.
      const closedAt = avoidAt && horizonAt
        ? (avoidAt.date <= horizonAt.date ? avoidAt : horizonAt)
        : (avoidAt ?? horizonAt);
      // PENDING: bars exist (so the horizon is knowable) but day 30 has not traded and there is no
      // avoid — the window is unfinished, so this pick contributes to NOTHING. Counting a partial
      // window would let a 3-day-old pick move a 30-day statistic.
      if (!closedAt && bars) { pendingByChannel.set(ch, (pendingByChannel.get(ch) ?? 0) + 1); continue; }
      const endPrice = closedAt ? closedAt.price : p.currentPrice;
      const spyEnd = closedAt ? (spyByDate.get(closedAt.date) ?? null) : spyNow;
      const heldDays = closedAt ? Math.round((Date.parse(closedAt.date) - Date.parse(baseDate)) / 86_400_000) : p.daysElapsed;
      const ret = (endPrice / base - 1) * 100;
      const spyThen = spyByDate.get(baseDate) ?? null;
      const alpha = spyEnd != null && spyThen != null && spyThen > 0
        ? ret - (spyEnd / spyThen - 1) * 100
        : null;
      // Return of the pick's OWN SECTOR over the SAME window, both ends from the ETF's own bars so
      // the benchmark shares the pick's clock exactly.
      const etf = STOCK_SECTOR[p.ticker];
      const sBars = etf ? sectorBarsByEtf?.get(etf) : undefined;
      const sFrom = sBars ? closeOnOrAfterDate(sBars, baseDate) : null;
      const sTo = sBars && closedAt ? closeOnOrAfterDate(sBars, closedAt.date) : null;
      const sectorAlpha = sFrom && sTo && sFrom.close > 0
        ? ret - ((sTo.close / sFrom.close - 1) * 100)
        : null;
      credits.push({
        channel: ch, ticker: p.ticker, ret, alpha, sectorAlpha, inherited, heldDays,
        closed: avoidAt != null && closedAt === avoidAt,
        start: baseDate, end: closedAt ? closedAt.date : "9999-12-31",
      });
    }
  }
  // PEER-RELATIVE: each credit against the mean of credits whose window OVERLAPS it. Overlap rather
  // than a global average, so the comparison is genuinely contemporaneous — once the ledger spans
  // more time a global mean would compare across regimes, the very factor this removes.
  const peerRel = new Map<Credit, number | null>();
  for (const c of credits) {
    const peers = credits.filter(o => o !== c && o.start <= c.end && c.start <= o.end);
    peerRel.set(c, peers.length ? c.ret - peers.reduce((a, b) => a + b.ret, 0) / peers.length : null);
  }

  const byChannel = new Map<string, Credit[]>();
  for (const c of credits) byChannel.set(c.channel, [...(byChannel.get(c.channel) ?? []), c]);

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
        avgSectorAlphaPct: mean(rows.map(r => r.sectorAlpha)),
        sectorPicks: rows.filter(r => r.sectorAlpha != null).length,
        avgPeerRelPct: mean(rows.map(r => peerRel.get(r) ?? null)),
        closedPicks: rows.filter((r) => r.closed).length,
        pendingPicks: pendingByChannel.get(channel) ?? 0,
        medianHoldDays: rows.length ? [...rows.map(r => r.heldDays)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] : null,
        tickerReturns: rows.map((r) => ({ ticker: r.ticker, retPct: r.ret, ...(r.closed ? { closed: true as const } : {}) })).sort((a, b) => b.retPct - a.retPct),
        alphaPicks: alphas.length,
      };
    })
    // Rank by EDGE (alpha over the market), not raw return — that's the whole point. Channels with no
    // market baseline yet fall back to raw return so they still sort sensibly.
    // Ranked by SECTOR-relative edge where available: the common factor is removed, so it is both
    // the least noisy measure and the only one that can actually resolve as data accrues. Falls back
    // to vs-SPY then raw, so a channel with no sector-mapped picks still sorts sensibly.
    .sort((a, b) => (b.avgSectorAlphaPct ?? b.avgAlphaPct ?? b.avgReturnPct) - (a.avgSectorAlphaPct ?? a.avgAlphaPct ?? a.avgReturnPct));

}

// Score every tracked pick's forward return and roll up per channel. Read-only.
export async function computeAttribution(
  today: string,
): Promise<{ picks: PickOutcome[]; channels: ChannelStats[]; channelsBelowFloor: ChannelStats[] }> {
  // Read-only path: a null (read error) is safe to treat as empty here — nothing is written.
  const ledger = await ledgerGet();
  const entries = Object.values(ledger ?? {});

  // SPY price by date, from the daily run records, so each pick's return can be measured AGAINST the
  // market over its OWN window. This turns "went up in a bull market" (beta) into genuine edge (alpha)
  // — without it, every channel reads strongly positive simply because the index rose. Fail-safe: no
  // runs → no market baseline → alpha stays null and only the raw return shows.
  const runs = await getRuns(120).catch(() => []);
  const spyByDate = new Map<string, number>();
  // SPY's own daily CLOSES first, because a baseline is now a session close (firstCloseAfter) while
  // a run's stored `spyPrice` is an INTRADAY mark captured when /api/trade fires at 14:30 UTC.
  // Mixing them puts the two alpha legs on different clocks — a systematic open-to-close SPY error
  // in the very metric channels are RANKED on. The repo has measured that gap: the 10:30 and close
  // clocks correlate only 0.668 on SPY, and SPY's own annualised Sharpe flips SIGN between them
  // over the same 29 days (docs/HANDOFF-close-snapshot.md). Same-clock on both legs is not a nicety.
  // 6mo, because a 30-day horizon on a pick first seen months ago needs bars that reach back past
  // its baseline — and the SPY leg must cover the same span or alpha drops out exactly where the
  // horizon lands.
  const spyBars = await fetchDailyBars("SPY", "6mo");
  if (spyBars) {
    for (let i = 0; i < spyBars.ts.length; i++) {
      const c = spyBars.closes[i];
      if (c == null) continue;
      spyByDate.set(new Date(spyBars.ts[i] * 1000).toISOString().slice(0, 10), c);
    }
  }
  // Run marks only fill dates the bar window does not reach (it is ~1 month; the ledger is older).
  // Those are the mixed-clock ones; they are a biased fallback, but a missing baseline drops the
  // pick from alpha entirely and `.sort()` would then rank on a smaller subset still.
  for (const r of runs) {
    if (typeof r.spyPrice === "number" && !spyByDate.has(r.date)) spyByDate.set(r.date, r.spyPrice);
  }
  // "now" for SPY must be LIVE (like each pick's current price), so the window matches: firstSeen→now
  // on both legs. Fall back to the latest run's close if the live quote fails.
  const spyNow = (await fetchQuoteLite("SPY").catch(() => null))?.price
    ?? runs.map((r) => r.spyPrice).find((x): x is number => typeof x === "number")
    ?? null;

  // One 6mo bar fetch per ticker REPLACES the per-ticker live quote: same request count, and it
  // supplies both the horizon mark and the current mark. Everything is then on CLOSES, consistent
  // with the SPY leg — the previous mix of a live price against a close was the clock mismatch
  // already fixed on the baseline side.
  const barsByTicker = new Map<string, DatedBars>();
  await Promise.all(entries.map(async (p) => {
    const b = await fetchDailyBars(p.ticker, "6mo");
    if (b) barsByTicker.set(p.ticker, b);
  }));
  const lastClose = (t: string): number | null => {
    const b = barsByTicker.get(t);
    if (!b) return null;
    for (let i = b.closes.length - 1; i >= 0; i--) if (b.closes[i] != null) return b.closes[i] as number;
    return null;
  };

  const picks: PickOutcome[] = await Promise.all(
    entries.map(async (p) => {
      const currentPrice = lastClose(p.ticker) ?? (await fetchQuoteLite(p.ticker))?.price ?? null;
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
  // Only the sector ETFs the tracked picks actually map to — typically a handful, not all 11.
  const etfs = [...new Set(entries.map(p => STOCK_SECTOR[p.ticker]).filter((e): e is string => !!e))];
  const sectorBarsByEtf = new Map<string, DatedBars>();
  await Promise.all(etfs.map(async (e) => {
    const b = await fetchDailyBars(e, "6mo");
    if (b) sectorBarsByEtf.set(e, b);
  }));
  // TWO COHORTS, never pooled. `channels` is what the sleeve would actually buy; the sub-floor set
  // is the control that says whether the buy floor is doing any work.
  const channels = rollupChannels(picks, spyByDate, spyNow, barsByTicker, sectorBarsByEtf, (sc) => sc >= INFLUENCER_BUY_FLOOR);
  const channelsBelowFloor = rollupChannels(picks, spyByDate, spyNow, barsByTicker, sectorBarsByEtf, (sc) => sc < INFLUENCER_BUY_FLOOR);

  picks.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
  return { picks, channels, channelsBelowFloor };
}

/**
 * Pure: which tickers in `ledger` were first SEEN on one of `dates`.
 *
 * The launch cohort (2026-07-28/29) is baselined on the day the ledger was DEPLOYED, not on the day
 * any channel made the call, because picks predating the ledger took that day's price as their
 * baseline. SPCX is the clearest case: $115.38 → $158.96 reads as +37.8%, while the name is only
 * ~+6% YTD — the window starts at a local low chosen by a deploy date. Those rows cannot be
 * corrected (the real per-channel dates were never recorded), only removed.
 *
 * Separated from the write so the SELECTION is testable without Redis: this deletes live history,
 * and a predicate that quietly matched everything would be indistinguishable from a full reset.
 */
export function pickTickersToPrune(ledger: Record<string, LedgerPick>, dates: string[]): string[] {
  const want = new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  if (want.size === 0) return []; // no valid date → remove NOTHING, never "match all"
  return Object.values(ledger)
    .filter(p => want.has(p.firstSeenDate))
    .map(p => p.ticker)
    .sort();
}

/** Refuse a prune that would take most of the ledger — at that point it is a reset wearing a
 *  surgical label, and the owner chose surgical precisely to keep the rest. */
export const MAX_PRUNE_FRACTION = 0.5;

/**
 * Remove picks first seen on the given dates. Returns what it did; writes only on a clean read.
 */
export async function prunePicksByFirstSeen(
  dates: string[],
): Promise<{ removed: string[]; remaining: number; skipped?: true; refused?: string }> {
  const ledger = await ledgerGet();
  // Read error → do NOT write. Overwriting on a transient read failure would wipe the history this
  // ledger exists to keep (same rule as recordPicks).
  if (ledger === null) return { removed: [], remaining: 0, skipped: true };
  const total = Object.keys(ledger).length;
  const victims = pickTickersToPrune(ledger, dates);
  if (victims.length === 0) return { removed: [], remaining: total };
  if (total > 0 && victims.length / total > MAX_PRUNE_FRACTION) {
    return { removed: [], remaining: total, refused: `would remove ${victims.length} of ${total} (> ${MAX_PRUNE_FRACTION * 100}%) — that is a reset, not a prune` };
  }
  for (const t of victims) delete ledger[t];
  await ledgerSet(ledger);
  console.warn("INFLUENCER_LEDGER_PRUNED", { dates, removed: victims, remaining: Object.keys(ledger).length });
  return { removed: victims, remaining: Object.keys(ledger).length };
}

/**
 * Delete the WHOLE ledger. Separate from prunePicksByFirstSeen on purpose: that function refuses
 * anything over MAX_PRUNE_FRACTION precisely so a surgical prune can never quietly become a reset,
 * and weakening that guard to allow a reset would remove the protection for both. A reset is a
 * different operation and says so.
 *
 * Requires the caller to pass the literal confirmation, so a stray query param cannot wipe the
 * accumulated record. Returns the count removed; a failed read does NOT write.
 */
export async function resetLedger(confirm: string): Promise<{ cleared: number } | { refused: string }> {
  if (confirm !== "CONFIRM") return { refused: "resetLedger requires confirm=CONFIRM" };
  const ledger = await ledgerGet();
  if (ledger === null) return { refused: "ledger read failed — refusing to write" };
  const n = Object.keys(ledger).length;
  await ledgerSet({});
  console.warn("INFLUENCER_LEDGER_RESET", { cleared: n });
  return { cleared: n };
}
