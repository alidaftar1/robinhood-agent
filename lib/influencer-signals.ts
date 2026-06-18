import Anthropic from "@anthropic-ai/sdk";
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
  tickers: string[];
  confidence: "high" | "medium" | "low";
}

export interface InfluencerCache {
  refreshedAt: string;
  signals: InfluencerSignal[];
  // Tickers seen across all signals, deduped, with mention count
  tickerCounts: Record<string, number>;
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

async function extractTickers(
  anthropic: Anthropic,
  title: string,
  description: string,
  channelName: string
): Promise<{ tickers: string[]; confidence: "high" | "medium" | "low" }> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system: `Extract stock tickers this YouTube finance creator is bullish on or holding in this video.
Include a ticker if the creator: recommends buying it, says they are buying/adding/holding it, names it as a top pick, or features it positively in a portfolio update. ETFs count.
Exclude tickers mentioned only as warnings, shorts, examples of bad investments, or generic market commentary.
Convert company names to their ticker (e.g. "Nvidia"→NVDA, "Palantir"→PLTR, "Tesla"→TSLA, "SpaceX"→SPCX).
Output exactly one line: TICKERS:{"tickers":["AAPL","NVDA"],"confidence":"high|medium|low"}
confidence=high: title or content is an explicit buy call ("Why I'm buying X", "Best stocks to buy now", "My top stock")
confidence=medium: portfolio update / holdings video naming positions, or implied picks
confidence=low: tickers mentioned but stance is ambiguous
If genuinely no actionable tickers (pure education, macro-only, no names): TICKERS:{"tickers":[],"confidence":"low"}`,
      messages: [{
        role: "user",
        content: `Channel: ${channelName}\nTitle: ${title}\nDescription: ${description.slice(0, 500)}`,
      }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
    const m = text.match(/^TICKERS:(.+)$/m);
    if (!m) return { tickers: [], confidence: "low" };
    const parsed = JSON.parse(m[1]) as { tickers: string[]; confidence: string };
    return {
      // Shape-check + alias-normalize only. Real liquidity validation happens in a
      // second pass (validateTickerLiquidity) so newly-listed names not in the static
      // universe (e.g. a fresh IPO) can still qualify if they're genuinely liquid.
      tickers: (parsed.tickers ?? [])
        .map((t: string) => t.toUpperCase())
        .map((t: string) => TICKER_ALIASES[t] ?? t)
        .filter((t: string) => /^[A-Z]{1,5}$/.test(t)),
      confidence: (["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low") as "high" | "medium" | "low",
    };
  } catch { return { tickers: [], confidence: "low" }; }
}

// ─── Main refresh ──────────────────────────────────────────────────────────────

export async function refreshInfluencerSignals(): Promise<InfluencerCache> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

  // Extract tickers via Haiku (batch, but throttle to avoid rate limits)
  const signals: InfluencerSignal[] = [];
  const BATCH = 5;
  for (let i = 0; i < candidateVideos.length; i += BATCH) {
    const batch = candidateVideos.slice(i, i + BATCH);
    const extracted = await Promise.allSettled(
      batch.map(v => extractTickers(
        anthropic,
        v.item.snippet.title,
        v.item.snippet.description,
        v.channelName
      ).then(result => ({ v, result })))
    );
    for (const r of extracted) {
      if (r.status === "fulfilled" && r.value.result.tickers.length > 0) {
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
        });
      }
    }
  }

  // Validate every extracted ticker for real liquidity (known names fast-pass, unknown
  // names checked against Yahoo). Drop anything that doesn't qualify, then drop signals
  // left with no tickers. This is the universe future-proofing — no hardcoded gate.
  const allCandidateTickers = signals.flatMap(s => s.tickers);
  const tradeable = await filterToTradeable(allCandidateTickers);
  const validatedSignals = signals
    .map(s => ({ ...s, tickers: s.tickers.filter(t => tradeable.has(t)) }))
    .filter(s => s.tickers.length > 0);

  // Build ticker mention counts (weighted by confidence)
  const tickerCounts: Record<string, number> = {};
  for (const sig of validatedSignals) {
    const weight = sig.confidence === "high" ? 3 : sig.confidence === "medium" ? 2 : 1;
    for (const t of sig.tickers) {
      tickerCounts[t] = (tickerCounts[t] ?? 0) + weight;
    }
  }

  const cache: InfluencerCache = {
    refreshedAt: new Date().toISOString(),
    signals: validatedSignals,
    tickerCounts,
  };
  await cacheSet(cache);
  return cache;
}

// ─── Public read API ───────────────────────────────────────────────────────────

export async function getInfluencerSignals(): Promise<InfluencerCache | null> {
  return cacheGet();
}

/** Format influencer signals for inclusion in the Sonnet analysis prompt.
 *  @param priceMap optional live prices for influencer tickers (fetched in trade route)
 */
export function formatInfluencerSignals(cache: InfluencerCache | null, priceMap?: Map<string, number>): string {
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
    return `${flag} ${ticker.padEnd(6)}${priceStr.padEnd(9)} score=${score}  channels: ${channels}`;
  }).filter(Boolean).join("\n");

  if (!rows) return "";

  return `\n\n══════════════════════════════════════════════════════
INFLUENCER SIGNALS (YouTube — last 48h) — refreshed ${cache.refreshedAt.slice(0, 10)}
Independent finance YouTubers (Meet Kevin, Tom Nash, Ticker Symbol YOU, etc.)
You have 25% of total budget (~$511) reserved for influencer picks.
Rules for influencer sub-portfolio:
• Pick at most 1–2 tickers from this list — HARD LIMIT of 2 influencer positions held at once (the system will reject extras)
• Total influencer buys this run should stay within ~25% of total portfolio (~$511) — do NOT over-allocate to influencer picks
• Max $400 per position (same as main strategy), min $50
• Prefer score ≥ 3 (multiple channel mentions or high-confidence pick)
• Must fit within your settled buying power (shared pool)
• Tag ALL influencer buys in TRADE_DECISION with "strategy":"influencer"
• Tickers in THIS section that are NOT S&P 500 constituents (e.g. PLTR, COIN, HOOD, RBLX) may ONLY be bought as influencer picks — never as a "main" pick
• Your main S&P 500 momentum picks default to "main" — do not tag them

${rows}
══════════════════════════════════════════════════════`;
}
