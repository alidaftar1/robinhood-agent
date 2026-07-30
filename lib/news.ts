// ─────────────────────────────────────────────────────────────────────────────
// PER-STOCK NEWS SIGNAL (Finnhub company-news → Haiku material-event extraction)
//
// The structured signals (★INS insider, ↑↓FIRM analyst, ⚠EARN earnings) miss the EVENT TAIL —
// M&A, litigation, guidance changes, product/contract wins, regulatory, exec changes. That's the
// incremental value of per-stock news; everything else in a news feed is noise or already tracked.
// So this fetches recent company news per ticker and uses Haiku to distill ONLY a material,
// price-moving corporate event (with direction), surfaced as a compact ⚡NEWS flag. Finnhub free
// tier covers large + mid caps (verified). Fail-safe throughout — news is an ENRICHMENT; a fetch
// or key failure must never break the trade run (returns an empty map).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@/lib/anthropic";

export interface NewsSignal {
  direction: "+" | "-" | "0"; // likely stock impact of the event
  summary: string;            // ≤100 chars — the specific event
}

const NEWS_LOOKBACK_DAYS = 5;
const CACHE_TTL = 60 * 60 * 12; // 12h — news is fetched once per daily run; cache guards retries
const MAX_HEADLINES = 15;       // most-recent headlines fed to Haiku (AAPL returns ~250/wk — cap it)

function ymd(d: Date): string { return d.toISOString().split("T")[0]; }

// ── Redis (per-symbol cache; same Upstash REST pattern as the rest of the app) ──
async function cacheGet(symbol: string): Promise<NewsSignal | null | undefined> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined; // undefined = cache unavailable (fetch); null = cached "no event"
  try {
    const res = await fetch(`${url}/get/robinhood:news:${symbol}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as { result: string | null };
    if (json.result == null) return undefined;
    return JSON.parse(json.result) as NewsSignal | null;
  } catch { return undefined; }
}
async function cacheSet(symbol: string, sig: NewsSignal | null): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", `robinhood:news:${symbol}`, JSON.stringify(sig), "EX", CACHE_TTL]]),
    });
  } catch { /* best-effort */ }
}

// Recent company-news headlines for one symbol (most recent first, capped). Fail-safe → [].
async function fetchCompanyNews(symbol: string): Promise<string[]> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];
  const to = new Date();
  const from = new Date(to.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000);
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${ymd(from)}&to=${ymd(to)}&token=${key}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return [];
    const data = await res.json() as Array<{ headline?: string; summary?: string; datetime?: number }>;
    if (!Array.isArray(data)) return [];
    return data
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, MAX_HEADLINES)
      .map(a => (a.headline ?? "").trim())
      .filter(Boolean);
  } catch { return []; }
}

// Distill a MATERIAL, price-moving corporate event from the headlines (or null if there's none).
// Deliberately EXCLUDES what we already track (analyst notes, earnings-date previews) and the noise
// (listicles, price recaps, "most active stocks") so the flag stays high-signal.
async function extractMaterialNews(anthropic: Anthropic, symbol: string, headlines: string[]): Promise<NewsSignal | null> {
  if (headlines.length === 0) return null;
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are given recent NEWS HEADLINES for one stock. Report ONLY a MATERIAL, price-moving CORPORATE EVENT from the last few days — specifically: M&A / acquisition / merger, major litigation or regulatory action (lawsuit, FDA/FTC/DOJ, fine, ban), a company GUIDANCE change (raised/cut outlook), a major product launch / big contract or partnership win, an executive change (CEO/CFO), a major buyback/dividend change, or a major operational event (recall, breach, outage, plant/strike).
EXCLUDE as NOT material (noise or already tracked elsewhere): routine analyst rating/price-target notes, "upcoming earnings" / earnings-date previews, "most active stocks" / index recap / listicle / "top gainers" headlines, generic "is X a good buy" articles, pure daily price-move recaps, and reprints.
Output exactly one line: NEWS:{"material":true|false,"direction":"+|-|0","summary":"<=90 chars, the specific event"}
direction = likely stock impact (+ bullish, - bearish, 0 mixed/unclear). If nothing material: {"material":false,"direction":"0","summary":""}.`,
      messages: [{ role: "user", content: `${symbol} headlines:\n${headlines.map(h => `- ${h}`).join("\n")}` }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
    const m = text.match(/NEWS:(.+)/);
    if (!m) return null;
    const parsed = JSON.parse(m[1]) as { material?: boolean; direction?: string; summary?: string };
    if (!parsed.material || !parsed.summary) return null;
    const direction = (["+", "-", "0"].includes(parsed.direction ?? "") ? parsed.direction : "0") as "+" | "-" | "0";
    return { direction, summary: String(parsed.summary).slice(0, 100) };
  } catch { return null; }
}

// Material-news signals for a set of symbols (shortlist + held). Cache-first per symbol; only
// cache-misses hit Finnhub + Haiku. Batched to bound concurrency. Fail-safe → empty map.
export async function fetchNewsSignals(symbols: string[]): Promise<Map<string, NewsSignal>> {
  const out = new Map<string, NewsSignal>();
  if (symbols.length === 0 || !process.env.FINNHUB_API_KEY) return out;
  const anthropic = createAnthropic();
  const uniq = [...new Set(symbols)];
  const BATCH = 5;
  let fetched = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      const cached = await cacheGet(sym);
      if (cached !== undefined) { if (cached) out.set(sym, cached); return; } // cache hit (null = known-none)
      fetched++;
      const headlines = await fetchCompanyNews(sym);
      const sig = await extractMaterialNews(anthropic, sym, headlines);
      await cacheSet(sym, sig);
      if (sig) out.set(sym, sig);
    }));
  }
  console.log("NEWS_SIGNALS", { symbols: uniq.length, fetched, material: out.size });
  return out;
}
