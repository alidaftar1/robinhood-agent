import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@/lib/anthropic";
import { SP500_UNIVERSE } from "./strategy";

// ─── Channel registry ──────────────────────────────────────────────────────────
// Independent finance YouTubers who make specific stock pick recommendations.
// Channel IDs verified by research agent (June 2026). Sorted by pick signal strength.
export const INFLUENCER_CHANNELS: Array<{ name: string; channelId: string; focus: string }> = [
  { name: "Meet Kevin",          channelId: "UCUvvj5lwue7PspotMDjk5UA", focus: "daily market commentary, explicit buy/sell calls, macro" },
  { name: "Tom Nash",            channelId: "UCJwKCyEIFHwUOPQQ-4kC1Zw", focus: "long-term growth stocks: AMD, NVDA, GOOGL, TSLA, PLTR" },
  { name: "Financial Education", channelId: "UCnMn36GT_H0X-w5_ckLtlgQ", focus: "growth stocks, stock of the month picks" },
  { name: "Ticker Symbol YOU",   channelId: "UC7kCeZ53sli_9XwuQeFxLqw", focus: "AI stocks, semiconductors: NVDA, AMD, AVGO, MU" },
  { name: "Joseph Carlson",      channelId: "UCbta0n8i6Rljh0obO7HzG9A", focus: "dividend growth: AAPL, MSFT, VICI, SPG, NFLX" },
  { name: "InvestAnswers",       channelId: "UClgJyzwGs-GyaNxUHcLZrkg", focus: "data-driven equities and macro, options" },
  { name: "Andrei Jikh",         channelId: "UCGy7SkBjcIAgTiwkXEtPnYg", focus: "stocks, crypto, dividend investing" },
  { name: "Ricky Gutierrez",     channelId: "UCtlAFoYl2aWb6pMiHCctQHA", focus: "day/swing trading: NVDA, TSLA, QQQ" },
  { name: "Everything Money",    channelId: "UChBVf9YnourrEDTsbbwJPRA", focus: "value investing, undervalued stocks" },
];

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface InfluencerSignal {
  channelName: string;
  channelId: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  publishedAt: string;
  viewCount: number;
  tickers: string[];                       // BUY / bullish
  confidence: "high" | "medium" | "low";
  avoidTickers?: string[];                  // BEARISH / warn-against (informational)
  insight?: string;                         // one-sentence takeaway from the video
}

export interface InfluencerCache {
  refreshedAt: string;
  signals: InfluencerSignal[];
  // Bullish tickers across all signals, weighted by confidence (the buy signal)
  tickerCounts: Record<string, number>;
  // Bearish/avoid tickers across all signals, by mention count (informational)
  avoidCounts?: Record<string, number>;
}

// ─── Redis ─────────────────────────────────────────────────────────────────────

const CACHE_KEY = "robinhood:influencer-signals";
const CACHE_TTL = 26 * 60 * 60; // 26h — covers overnight gap between cron runs

async function redisPost(path: string, body: unknown): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(url + "/" + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { result: unknown };
  return json.result;
}

async function cacheGet(): Promise<InfluencerCache | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json() as { result: string | null };
    if (!json.result) return null;
    return JSON.parse(json.result) as InfluencerCache;
  } catch { return null; }
}

async function cacheSet(data: InfluencerCache): Promise<void> {
  await redisPost("pipeline", [
    ["SET", CACHE_KEY, JSON.stringify(data), "EX", CACHE_TTL],
  ]);
}

// ─── YouTube helpers ───────────────────────────────────────────────────────────

const YT_BASE = "https://www.googleapis.com/youtube/v3";

function ytKey(): string {
  return process.env.YOUTUBE_API_KEY ?? "";
}

interface YTSearchItem {
  id: { videoId: string };
  snippet: { title: string; description: string; publishedAt: string; channelId: string; channelTitle: string };
}

interface YTVideoItem {
  id: string;
  statistics: { viewCount?: string };
}

async function getChannelVideos(channelId: string, since: Date): Promise<YTSearchItem[]> {
  const key = ytKey();
  if (!key) return [];
  try {
    const url = `${YT_BASE}/search?part=snippet&channelId=${channelId}&type=video&order=date&publishedAfter=${since.toISOString()}&maxResults=10&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { items?: YTSearchItem[] };
    return data.items ?? [];
  } catch { return []; }
}

async function getVideoViews(videoIds: string[]): Promise<Map<string, number>> {
  const key = ytKey();
  if (!key || videoIds.length === 0) return new Map();
  try {
    const url = `${YT_BASE}/videos?part=statistics&id=${videoIds.join(",")}&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return new Map();
    const data = await res.json() as { items?: YTVideoItem[] };
    return new Map((data.items ?? []).map(v => [v.id, parseInt(v.statistics.viewCount ?? "0")]));
  } catch { return new Map(); }
}

// ─── Stock-pick extraction via Haiku ──────────────────────────────────────────

// Known liquid tickers beyond SP500 that influencers commonly discuss
export const EXPANDED_UNIVERSE = [
  // Mega-cap tech / popular growth
  "PLTR", "ARM", "SMCI", "CRWD", "SNOW", "DDOG", "NET", "COIN", "HOOD", "SOFI",
  "LCID", "RIVN", "NIO", "XPEV", "BIDU", "BILI", "JD", "PDD", "SHOP", "SQ",
  "PINS", "SNAP", "RBLX", "U", "AFRM", "UPST", "OPEN", "SEER",
  // Biotech / pharma
  "MRNA", "BNTX", "NVAX", "SGEN", "BMRN", "RARE", "ALNY", "SRPT",
  // ETFs (influencers often recommend)
  "QQQ", "ARKK", "ARKG", "ARKF", "IWM", "XLK", "SOXL",
  // Popular dividend / value
  "O", "MAIN", "JEPI", "JEPQ", "SCHD",
  // Newly public / hot listings influencers pump (keep current)
  "SPCX", // SpaceX — IPO'd 2026-06-12 on Nasdaq, largest IPO ever; heavy influencer coverage
];

// Fast-accept set — tickers known liquid, skip the Yahoo round-trip for these.
const VALID_TICKERS = new Set([...SP500_UNIVERSE, ...EXPANDED_UNIVERSE]);

// Liquidity bar for tickers NOT in VALID_TICKERS. Higher than typical so obscure /
// hallucinated symbols that happen to resolve on Yahoo don't sneak in.
const MIN_AVG_VOLUME = 1_000_000;
const MIN_PRICE = 5;
const MAX_PRICE = 500;

// Validate an unknown ticker against Yahoo: must price in band AND trade with real
// volume so the influencer bucket can enter/exit quickly. This is what future-proofs
// the universe — any genuinely liquid new listing qualifies without a code change.
async function validateTickerLiquidity(symbol: string): Promise<boolean> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json() as {
      chart?: { result?: Array<{
        meta?: { regularMarketPrice?: number };
        indicators?: { quote?: Array<{ volume?: (number | null)[] }> };
      }> };
    };
    const result = data?.chart?.result?.[0];
    if (!result) return false;
    const price = result.meta?.regularMarketPrice ?? 0;
    if (price < MIN_PRICE || price > MAX_PRICE) return false;
    const volumes = (result.indicators?.quote?.[0]?.volume ?? []).filter((v): v is number => v != null && v > 0);
    if (volumes.length === 0) return false;
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    return avgVol >= MIN_AVG_VOLUME;
  } catch { return false; }
}

// Given candidate tickers, return the set that's tradeable: known-liquid (fast path)
// or unknown-but-validated via Yahoo liquidity check.
async function filterToTradeable(tickers: string[]): Promise<Set<string>> {
  const unique = [...new Set(tickers)];
  const accepted = new Set<string>();
  const toValidate: string[] = [];
  for (const t of unique) {
    if (VALID_TICKERS.has(t)) accepted.add(t);
    else toValidate.push(t);
  }
  // Validate unknowns in small concurrent batches to respect Yahoo rate limits.
  const BATCH = 5;
  for (let i = 0; i < toValidate.length; i += BATCH) {
    const batch = toValidate.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(t => validateTickerLiquidity(t).then(ok => ({ t, ok }))));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.ok) accepted.add(r.value.t);
    }
  }
  return accepted;
}

// Maps common company-name guesses / wrong-ticker hallucinations to the real symbol.
// Needed because Haiku may know the company but not its exact (often newly-issued) ticker.
const TICKER_ALIASES: Record<string, string> = {
  SPACE: "SPCX",   // SpaceX
  SPACEX: "SPCX",
  GOOGLE: "GOOGL",
  ALPHABET: "GOOGL",
  FACEBOOK: "META",
};

// ~2k tokens of transcript to Haiku — bounds cost and captures the intro + main thesis.
const TRANSCRIPT_CHAR_CAP = 8000;
const TRANSCRIPT_CACHE_TTL = 60 * 60 * 24 * 14; // 14d — a video ages out of the 7-day window well before this

// Transcripts are immutable, and the 7-day refresh window re-sees the same videos daily, so cache
// per videoId to avoid re-billing Supadata every run (cuts credit use ~5x → only NEW videos cost).
// "" is a valid cached value = "known to have no transcript, don't re-fetch". null = not cached.
async function transcriptCacheGet(videoId: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/robinhood:transcript:${videoId}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as { result: string | null };
    return json.result;
  } catch { return null; }
}

async function transcriptCacheSet(videoId: string, text: string): Promise<void> {
  try {
    await redisPost("pipeline", [["SET", `robinhood:transcript:${videoId}`, text, "EX", TRANSCRIPT_CACHE_TTL]]);
  } catch { /* cache write is best-effort */ }
}

// Fetch a video's transcript via Supadata. Works from serverless IPs (Supadata proxies the
// fetch from unblocked infra — direct YouTube caption scraping is blocked from datacenter IPs,
// verified 0/22 in prod). Auto-Whispers videos with no captions. Fail-safe: returns null on any
// error, timeout, or missing key → caller falls back to title+description.
async function fetchTranscript(videoId: string): Promise<string | null> {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) return null;
  const cached = await transcriptCacheGet(videoId);
  if (cached !== null) return cached === "" ? null : cached; // cache hit ("" = known-none)
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/transcript?url=https://youtu.be/${videoId}`,
      { headers: { "x-api-key": key }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) return null; // transient / quota — do NOT cache, retry next run
    const data = await res.json() as { content?: Array<{ text?: string }> | string };
    const text = typeof data.content === "string"
      ? data.content
      : (data.content ?? []).map((s) => s.text ?? "").join(" ");
    const clean = text.replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_CHAR_CAP);
    await transcriptCacheSet(videoId, clean); // cache the success (incl "" = no transcript)
    return clean || null;
  } catch {
    return null;
  }
}

interface ExtractedSignal {
  tickers: string[];                          // BUY / bullish
  confidence: "high" | "medium" | "low";      // conviction of the BUY list
  avoid: string[];                            // BEARISH / warn-against
  insight: string;                            // one-sentence takeaway/thesis
}

async function extractSignal(
  anthropic: Anthropic,
  title: string,
  description: string,
  channelName: string,
  transcript: string | null,
): Promise<ExtractedSignal> {
  const EMPTY: ExtractedSignal = { tickers: [], confidence: "low", avoid: [], insight: "" };
  try {
    // Prefer the actual spoken transcript (the real picks + stance live in the video, not the
    // clickbait title). Fall back to title+description (which usually lists the discussed stocks).
    const source = transcript
      ? `Channel: ${channelName}\nTitle: ${title}\nVIDEO TRANSCRIPT (may be truncated to the start of the video):\n${transcript}`
      : `Channel: ${channelName}\nTitle: ${title}\nDescription:\n${description.slice(0, 1500)}`;
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `You analyze a YouTube finance video. You get its TRANSCRIPT when available — base everything on what the creator actually SAYS, not the clickbait title. Otherwise you get the TITLE + DESCRIPTION (descriptions usually name the discussed stocks, often with timestamps). Extract three things:
- buy: tickers the creator is BULLISH on (recommends buying, is buying/adding/holding, names a top pick, features positively in a portfolio update). ETFs count.
- avoid: tickers the creator is BEARISH on or warns against (says to sell/avoid, is shorting, calls overvalued or a bad investment). A ticker must NEVER be in both lists.
- insight: ONE concise sentence (≤160 chars) capturing the video's main takeaway/thesis — a market/macro/sector view or the core reason behind a pick. Specific, plain, no hype. "" if there's no clear take.
Convert company names to tickers ("Nvidia"→NVDA, "Palantir"→PLTR, "Tesla"→TSLA, "SpaceX"→SPCX).
Output exactly one line: SIGNAL:{"buy":["NVDA"],"confidence":"high|medium|low","avoid":["INTC"],"insight":"..."}
confidence (of the BUY list): high = explicit buy call ("I'm buying X", "my top pick"); medium = portfolio/holdings mention or soft positive; low = ambiguous or no buys.
If nothing actionable and no clear take: SIGNAL:{"buy":[],"confidence":"low","avoid":[],"insight":""}`,
      messages: [{
        role: "user",
        content: source,
      }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
    const m = text.match(/^SIGNAL:(.+)$/m);
    if (!m) return EMPTY;
    const parsed = JSON.parse(m[1]) as { buy?: string[]; confidence?: string; avoid?: string[]; insight?: string };
    // Shape-check + alias-normalize only. Real liquidity validation happens in a second pass
    // (filterToTradeable) so newly-listed names not in the static universe can still qualify.
    const norm = (arr: string[] | undefined) => (arr ?? [])
      .map((t) => String(t).toUpperCase())
      .map((t) => TICKER_ALIASES[t] ?? t)
      .filter((t) => /^[A-Z]{1,5}$/.test(t));
    const tickers = norm(parsed.buy);
    const avoid = norm(parsed.avoid).filter((t) => !tickers.includes(t)); // never both lists
    return {
      tickers,
      confidence: (["high", "medium", "low"].includes(parsed.confidence ?? "") ? parsed.confidence : "low") as "high" | "medium" | "low",
      avoid,
      insight: typeof parsed.insight === "string" ? parsed.insight.replace(/\s+/g, " ").trim().slice(0, 200) : "",
    };
  } catch { return EMPTY; }
}

// ─── Main refresh ──────────────────────────────────────────────────────────────

export async function refreshInfluencerSignals(): Promise<InfluencerCache> {
  const anthropic = createAnthropic();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days — these channels post picks weekly, not daily

  // Fetch recent videos from all channels in parallel
  const channelResults = await Promise.allSettled(
    INFLUENCER_CHANNELS.map(async ch => {
      const videos = await getChannelVideos(ch.channelId, since);
      return { channel: ch, videos };
    })
  );

  // Collect all video IDs for bulk view count fetch
  const allVideos: Array<{ channelName: string; channelId: string; item: YTSearchItem }> = [];
  for (const r of channelResults) {
    if (r.status === "fulfilled") {
      for (const item of r.value.videos) {
        allVideos.push({ channelName: r.value.channel.name, channelId: r.value.channel.channelId, item });
      }
    }
  }

  // Filter to videos that look stock-related (title OR description) before spending Haiku tokens.
  // Broad net — the Haiku extraction step decides whether there's an actual pick.
  const stockKeywords = /\b(stock|stocks|buy|buying|bought|sell|selling|invest|investing|portfolio|holding|holdings|position|ticker|shares|market|bull|bear|trade|trading|dividend|growth|undervalued|pick|picks|watchlist|adding|loading)\b/i;
  const candidateVideos = allVideos.filter(
    v => stockKeywords.test(v.item.snippet.title) || stockKeywords.test(v.item.snippet.description ?? "")
  );

  if (candidateVideos.length === 0) {
    const empty: InfluencerCache = { refreshedAt: new Date().toISOString(), signals: [], tickerCounts: {} };
    await cacheSet(empty);
    return empty;
  }

  // Fetch view counts in one batch
  const videoIds = candidateVideos.map(v => v.item.id.videoId);
  const viewMap = await getVideoViews(videoIds);

  // For each video: fetch the transcript (Supadata, fail-safe) then extract buy/avoid/insight
  // via Haiku. Transcript is the real signal; title+description is the fallback. Batch-throttled.
  const signals: InfluencerSignal[] = [];
  let transcriptHits = 0;
  const BATCH = 5;
  for (let i = 0; i < candidateVideos.length; i += BATCH) {
    const batch = candidateVideos.slice(i, i + BATCH);
    const extracted = await Promise.allSettled(
      batch.map(async v => {
        const transcript = await fetchTranscript(v.item.id.videoId);
        if (transcript) transcriptHits++;
        const result = await extractSignal(
          anthropic,
          v.item.snippet.title,
          v.item.snippet.description,
          v.channelName,
          transcript,
        );
        return { v, result };
      })
    );
    for (const r of extracted) {
      // Keep a signal if it carries ANY of: a buy, an avoid, or an insight — so bearish-only
      // and pure-commentary videos still surface in the email (they never did before).
      if (r.status === "fulfilled" && (r.value.result.tickers.length > 0 || r.value.result.avoid.length > 0 || r.value.result.insight)) {
        const { v, result } = r.value;
        signals.push({
          channelName: v.channelName,
          channelId: v.channelId,
          videoId: v.item.id.videoId,
          videoTitle: v.item.snippet.title,
          videoUrl: `https://youtube.com/watch?v=${v.item.id.videoId}`,
          publishedAt: v.item.snippet.publishedAt,
          viewCount: viewMap.get(v.item.id.videoId) ?? 0,
          tickers: result.tickers,
          confidence: result.confidence,
          avoidTickers: result.avoid,
          insight: result.insight,
        });
      }
    }
  }

  console.log("INFLUENCER_TRANSCRIPT_COVERAGE", { videos: candidateVideos.length, withTranscript: transcriptHits });

  // Validate every extracted ticker (buy AND avoid) for real liquidity (known names fast-pass,
  // unknown names checked against Yahoo). Drop non-qualifying tickers, then keep a signal if it
  // still carries a buy, an avoid, or an insight. Universe future-proofing — no hardcoded gate.
  const allCandidateTickers = [...new Set(signals.flatMap(s => [...s.tickers, ...(s.avoidTickers ?? [])]))];
  const tradeable = await filterToTradeable(allCandidateTickers);
  const validatedSignals = signals
    .map(s => ({
      ...s,
      tickers: s.tickers.filter(t => tradeable.has(t)),
      avoidTickers: (s.avoidTickers ?? []).filter(t => tradeable.has(t)),
    }))
    .filter(s => s.tickers.length > 0 || (s.avoidTickers?.length ?? 0) > 0 || s.insight);

  // Bullish counts weighted by confidence (the buy signal); bearish counts by mention (informational).
  const tickerCounts: Record<string, number> = {};
  const avoidCounts: Record<string, number> = {};
  for (const sig of validatedSignals) {
    const weight = sig.confidence === "high" ? 3 : sig.confidence === "medium" ? 2 : 1;
    for (const t of sig.tickers) tickerCounts[t] = (tickerCounts[t] ?? 0) + weight;
    for (const t of sig.avoidTickers ?? []) avoidCounts[t] = (avoidCounts[t] ?? 0) + 1;
  }

  const cache: InfluencerCache = {
    refreshedAt: new Date().toISOString(),
    signals: validatedSignals,
    tickerCounts,
    avoidCounts,
  };
  await cacheSet(cache);
  return cache;
}

// ─── Public read API ───────────────────────────────────────────────────────────

export async function getInfluencerSignals(): Promise<InfluencerCache | null> {
  return cacheGet();
}

// Falling-knife screen for influencer picks. The signal measures popularity, not price
// trend — a stock can be most-talked-about precisely because it's crashing (SPCX post-IPO).
// Reject if EITHER: down >8% over 5 trading days, OR >15% below its recent 10-day high
// (the latter catches pump-and-dump names where the 5-day net is misleadingly mild).
export const MOMENTUM_FLOOR_PCT = -8;
export const DIST_FROM_HIGH_FLOOR = -15;

export interface MomentumSignal { change5d: number; distFromHigh: number; aboveShortMA: boolean }

// True if the pick is a falling knife we should NOT buy. A pick that's flagged
// (down >8% over 5d, or >15% off its recent high) is normally rejected — UNLESS it's
// shown a CONFIRMED recovery (reclaimed its 5-day moving average = short-term trend
// turned up). That exception lets a genuine bottom back in without chasing a one-day
// dead-cat bounce (a single pop off a low is still below the 5d average).
export function isInfluencerDowntrend(m: MomentumSignal | undefined): boolean {
  if (!m) return false;
  const flagged = m.change5d < MOMENTUM_FLOOR_PCT || m.distFromHigh < DIST_FROM_HIGH_FLOOR;
  if (!flagged) return false;
  if (m.aboveShortMA) return false; // confirmed-recovery exception
  return true;
}

// For display: a pick that's flagged but recovering (above its 5d MA).
export function isInfluencerRecovering(m: MomentumSignal | undefined): boolean {
  if (!m) return false;
  const flagged = m.change5d < MOMENTUM_FLOOR_PCT || m.distFromHigh < DIST_FROM_HIGH_FLOOR;
  return flagged && m.aboveShortMA;
}

/** Format influencer signals for inclusion in the Sonnet analysis prompt.
 *  @param priceMap optional live prices for influencer tickers (fetched in trade route)
 *  @param momentum optional 5-day % change per ticker (downtrend screen)
 */
export function formatInfluencerSignals(cache: InfluencerCache | null, priceMap?: Map<string, number>, momentum?: Map<string, MomentumSignal>): string {
  if (!cache || cache.signals.length === 0) return "";

  // Top tickers by weighted mention count
  const sorted = Object.entries(cache.tickerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15);

  if (sorted.length === 0) return "";

  // Build per-ticker detail rows
  const rows = sorted.map(([ticker, score]) => {
    const mentions = cache.signals.filter(s => s.tickers.includes(ticker));
    const channels = [...new Set(mentions.map(s => s.channelName))].join(", ");
    const highConf = mentions.filter(s => s.confidence === "high").length;
    const flag = highConf > 0 ? "🔥" : "📺";
    const price = priceMap?.get(ticker);
    const priceStr = price ? ` $${price.toFixed(2)}` : "";
    // Liquidity filter: skip tickers outside $5-$500 range
    if (price && (price < 5 || price > 500)) return null;
    const mom = momentum?.get(ticker);
    const tag = mom == null ? "" : isInfluencerDowntrend(mom) ? " ⛔DOWNTREND" : isInfluencerRecovering(mom) ? " ↑RECOVERING" : "";
    const momStr = mom != null
      ? ` 5d:${mom.change5d >= 0 ? "+" : ""}${mom.change5d.toFixed(0)}% hi:${mom.distFromHigh.toFixed(0)}%${tag}`
      : "";
    return `${flag} ${ticker.padEnd(6)}${priceStr.padEnd(9)}${momStr.padEnd(26)} score=${score}  channels: ${channels}`;
  }).filter(Boolean).join("\n");

  if (!rows) return "";

  return `\n\n══════════════════════════════════════════════════════
INFLUENCER SIGNALS (YouTube — last 7 days) — refreshed ${cache.refreshedAt.slice(0, 10)}
Independent finance YouTubers (Meet Kevin, Tom Nash, Ticker Symbol YOU, etc.)
This is a deliberate HIGH-RISK / HIGH-REWARD sleeve — ~25% of the total portfolio is
allocated to following these creators' picks. It runs ALONGSIDE your main momentum book,
NOT instead of it. Do not skip it just because your momentum table looks better.

ACTION REQUIRED — fill the influencer sleeve when a qualifying signal exists:
• If ANY ticker below has score ≥ 3, you SHOULD buy 1–2 of them this run (target ~25% of the portfolio),
  UNLESS every qualifying pick is disqualified (price above the per-position cap, ⚠⚠ imminent earnings, or no settled cash).
• HARD LIMIT: at most 2 influencer positions held at once (system rejects extras).
• Same per-position cap as the main strategy, min $50. Whole shares only.
• Prefer the highest score; a score-6 pick is a strong, broadly-covered signal — do not ignore it.
• DOWNTREND SCREEN: do NOT buy a pick marked ⛔DOWNTREND (down >${Math.abs(MOMENTUM_FLOOR_PCT)}% over 5d, OR >${Math.abs(DIST_FROM_HIGH_FLOOR)}% below its recent high). The row shows "5d:" (5-day change) and "hi:" (distance from recent high). These signals measure popularity, not price — a falling stock can be the most-talked-about one. The system rejects these buys anyway. A pick marked ↑RECOVERING dipped but has reclaimed its 5-day average (trend turned up) — it is allowed. Prefer a rising or ↑RECOVERING pick; never a ⛔DOWNTREND one.
• Tag EVERY influencer buy in TRADE_DECISION with "strategy":"influencer".
• Non-S&P-500 tickers here (e.g. SPCX, PLTR, COIN, HOOD) can ONLY be bought as influencer picks.
• These are funded from the SAME settled buying power as main picks — total buys still ≤ budget.

${rows}

Reminder: influencer names are volatile by design and carry a tight −5% stop. That is expected —
the sleeve is sized small (25%) precisely so you can take these higher-variance bets.
══════════════════════════════════════════════════════`;
}
