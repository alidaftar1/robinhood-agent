import { redisCommand } from "@/lib/run-store";
import { SEC_UA, getCIKMap } from "@/lib/insider";
import { createAnthropic } from "@/lib/anthropic";

// ─── Earnings-release signal ─────────────────────────────────────────────────
//
// What a company ACTUALLY SAID at its last print, not how its price reacted.
//
// Everything else the main book sees is derived from price: 12-1 momentum, the quality screen,
// 📊REPORTED's 1d/5d move. This is the first input that reads the company's own words — most
// importantly its FORWARD GUIDANCE, which price history cannot contain.
//
// Source is the 8-K with item 2.02 ("Results of Operations"), whose EX-99.1 exhibit is the
// earnings press release. Note what this is NOT: it is not the earnings CALL transcript, so there
// is no management Q&A here — the release is the company's prepared statement.
//
// COST is the whole design constraint. Reading a filing is free (SEC EDGAR); summarising it is a
// Sonnet call over ~15k chars. So analysis is (a) restricted to names that both matter to this run
// and actually reported recently, (b) capped per run, and (c) cached per symbol+report-date, which
// makes it valid until the next quarter. Expected steady state is a few calls per WEEK.
//
// Fail-safe throughout: every path returns null/empty rather than throwing. An earnings summary is
// a nice-to-have context signal, and it must never be able to break a trade run.

const EDGAR_SUBMISSIONS = "https://data.sec.gov/submissions";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const MAX_FILING_CHARS = 15_000;   // press releases run long; this is the head where the numbers live
const CACHE_TTL_SECONDS = 120 * 24 * 60 * 60;   // > one quarter: valid until the next print
const MISS_TTL_SECONDS  = 10 * 24 * 60 * 60;   // outlives the ~7d recentEarnings window, retries next quarter

export type ManagementTone = "Confident" | "Cautious" | "Neutral" | "Defensive" | "Optimistic";

export interface EarningsReleaseAnalysis {
  symbol: string;
  reportDate: string;
  /** Forward guidance in the company's own terms — the part price history cannot contain. */
  guidance: string | null;
  headline: string | null;      // the one number that stood out
  tone: ManagementTone;
  redFlags: string[];
  bullCase: string[];
  bearCase: string[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILING_CHARS);
}

/**
 * Locate the EX-99.1 exhibit in an EDGAR filing index.
 *
 * The naive `/EX-99\.1[\s\S]{0,800}?href="..."/` scans FORWARD from the first textual "EX-99.1",
 * which only works when the filer repeats the exhibit type in the Description column. When
 * Description is free text, the first occurrence is the TYPE cell — which sits AFTER its own row's
 * href — so the match runs into the NEXT row. Verified live: JPM's earnings 8-K resolved to the
 * EX-99.2 financial supplement instead of the EX-99.1 narrative, silently, because the fetch still
 * succeeded. Parse rows and require the type cell to equal EX-99.1 exactly.
 */
export function findEx991Href(indexHtml: string): string | null {
  for (const row of indexHtml.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    if (!cells.some(c => c.toUpperCase() === "EX-99.1")) continue;
    const href = row.match(/href="([^"]+\.(?:htm|html))"/i);
    if (href) return href[1];
  }
  return null;
}

/** An 8-K COVER PAGE rather than the press release — the fallback document when no EX-99.1 row is
 *  found. It strips to a few thousand chars of boilerplate, clears the content floor, and would buy
 *  a Sonnet call that can only return null (or worse, a "summary" of forward-looking-statement
 *  legalese rendered as "what they actually said"). Detect it and never pay. */
export function isCoverPageOnly(text: string): boolean {
  const t = text.slice(0, 4000);
  return /CURRENT\s+REPORT/i.test(t) && /Pursuant\s+to\s+Section\s+13\s+OR\s+15\(d\)/i.test(t);
}

/** The text of a symbol's most recent earnings press release, or null. Free (EDGAR). */
export async function fetchLatestEarningsRelease(
  symbol: string,
  cik: string,
  signal: AbortSignal,
): Promise<{ filingDate: string; content: string } | null> {
  try {
    const subs = await fetch(`${EDGAR_SUBMISSIONS}/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!subs.ok) return null;
    const data = await subs.json() as {
      filings?: { recent?: { accessionNumber: string[]; filingDate: string[]; form: string[]; items: string[]; primaryDocument: string[] } };
    };
    const recent = data.filings?.recent;
    if (!recent) return null;

    // Item 2.02 = "Results of Operations and Financial Condition" — the earnings 8-K specifically,
    // not any 8-K (companies file those for many unrelated events). Item numbers stop at 9, so a
    // substring test cannot collide with a longer number.
    let idx = -1;
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === "8-K" && String(recent.items[i] ?? "").includes("2.02")) { idx = i; break; }
    }
    if (idx === -1) return null;

    const accession = recent.accessionNumber[idx];
    const filingDate = recent.filingDate[idx];
    const base = `${EDGAR_ARCHIVES}/${parseInt(cik, 10)}/${accession.replace(/-/g, "")}`;

    const indexRes = await fetch(`${base}/${accession}-index.htm`, { headers: { "User-Agent": SEC_UA }, signal });
    if (indexRes.ok) {
      const href = findEx991Href(await indexRes.text());
      if (href) {
        const doc = await fetch(`${base}/${href.split("/").pop()}`, { headers: { "User-Agent": SEC_UA }, signal });
        if (doc.ok) {
          const content = stripHtml(await doc.text());
          if (!isCoverPageOnly(content)) return { filingDate, content };
        }
      }
    }
    // Fallback is the 8-K body, which for most filers is a cover page pointing AT the exhibit.
    const fallback = await fetch(`${base}/${recent.primaryDocument[idx]}`, { headers: { "User-Agent": SEC_UA }, signal });
    if (!fallback.ok) return null;
    const content = stripHtml(await fallback.text());
    return isCoverPageOnly(content) ? null : { filingDate, content };
  } catch {
    return null;   // fail-safe: no earnings context beats a broken run
  }
}

/** Summarise a release into the few fields a trading decision can use. Costs one Sonnet call. */
export async function analyzeEarningsRelease(
  symbol: string,
  reportDate: string,
  content: string,
  signal?: AbortSignal,
): Promise<EarningsReleaseAnalysis | null> {
  if (!content || content.length < 500) return null;   // nothing substantive to read
  try {
    const anthropic = createAnthropic();
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      messages: [{
        role: "user",
        content: `Extract what matters to a momentum equity investor from this earnings press release for ${symbol}.

Be concrete and quote the company's own numbers. If the release does not state something, use null — do NOT infer or estimate it.

RELEASE:
${content}

Return ONLY valid JSON:
{
  "guidance": "Forward-looking statement in their words — hard numbers or qualitative color. null if the release gives none.",
  "headline": "The single number that stood out, e.g. 'Revenue $94.9B, +5% YoY'. null if unclear.",
  "tone": "one of: Confident, Cautious, Neutral, Defensive, Optimistic",
  "redFlags": ["at most 2 short flags; [] if none"],
  "bullCase": ["at most 2 short points"],
  "bearCase": ["at most 2 short points"]
}`,
      }],
    }, {
      // The SDK default is a 10-minute timeout with 2 retries. This runs inside a maxDuration=300
      // route that still owes a 150s analysis call and the MCP order sessions, so an unbounded
      // hang here means the function is killed BEFORE any trade — and the route's outer catch
      // never runs, so not even an alert fires. A context signal is not enough: it bounds fetches,
      // not the SDK's own retry loop.
      timeout: 45_000,
      maxRetries: 1,
      signal,
    });
    const txt = resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return normalizeReleaseAnalysis(symbol, reportDate, JSON.parse(m[0]));
  } catch {
    return null;
  }
}

const TONES: ManagementTone[] = ["Confident", "Cautious", "Neutral", "Defensive", "Optimistic"];

/**
 * Coerce a model response into the shape the prompt renders. Separated out and pure because this
 * is untrusted text reaching a live trading prompt: a hallucinated tone, a string where an array
 * belongs, or ten "red flags" should degrade gracefully rather than render garbage to the model.
 * An unusable payload returns null, which the caller treats as "no earnings context" — never as
 * an empty-but-valid analysis, which would read as "nothing concerning was said".
 */
export function normalizeReleaseAnalysis(symbol: string, reportDate: string, raw: unknown): EarningsReleaseAnalysis | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<EarningsReleaseAnalysis>;
  // Third-party filing text landing in the TRADING model's system prompt. Collapse newlines so a
  // field cannot fake prompt structure (a line like "- HARD LIMIT: ..." would read as an
  // instruction), and cap length — which also keeps the Redis write, whose payload is
  // percent-encoded into a URL path, well under any gateway limit.
  const MAX_FIELD = 300;
  const text = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const flat = v.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return flat ? flat.slice(0, MAX_FIELD) : null;
  };
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map(x => text(x)).filter((x): x is string => x !== null).slice(0, 2)
      : [];
  const analysis: EarningsReleaseAnalysis = {
    symbol,
    reportDate,
    guidance: text(p.guidance),
    headline: text(p.headline),
    tone: TONES.includes(p.tone as ManagementTone) ? (p.tone as ManagementTone) : "Neutral",
    redFlags: list(p.redFlags),
    bullCase: list(p.bullCase),
    bearCase: list(p.bearCase),
  };
  // Nothing substantive extracted — rendering an all-empty block would imply a clean quarter.
  if (!analysis.guidance && !analysis.headline && analysis.bullCase.length === 0 && analysis.bearCase.length === 0) return null;
  return analysis;
}

const cacheKey = (symbol: string, reportDate: string) => `earnings-release:${symbol}:${reportDate}`;

/** New Sonnet analyses per run. Cache hits are unlimited and free; this bounds only fresh work. */
export const MAX_NEW_ANALYSES_PER_RUN = 3;

/**
 * Analyses for names that BOTH matter to this run and actually reported recently.
 *
 * Keyed on symbol + REPORT DATE, which we already know from lib/earnings — so a cache hit costs
 * neither an EDGAR fetch nor a Sonnet call, and an entry stays valid until the next print.
 * Returns the notes it could not produce so a cap is never silent.
 */
export async function getEarningsReleaseAnalyses(
  symbols: string[],
  recentEarnings: Map<string, { date: string; daysAgo: number }>,
  signal: AbortSignal,
): Promise<{ analyses: Map<string, EarningsReleaseAnalysis>; notes: string[] }> {
  const analyses = new Map<string, EarningsReleaseAnalysis>();
  const notes: string[] = [];
  // Only names that genuinely reported — everything else has nothing new to read.
  const reported = [...new Set(symbols)].filter(s => recentEarnings.has(s));
  if (reported.length === 0) return { analyses, notes };

  // ONE CIK fetch for the whole run: company_tickers.json is ~800KB, and the previous code
  // downloaded it per symbol. It is also filtered to SP500_UNIVERSE, so a non-S&P influencer
  // candidate can NEVER resolve — those are dropped up front instead of downloading 800KB to fail
  // and then emitting an "unavailable" note every single run, forever.
  let cikMap: Map<string, string>;
  try { cikMap = await getCIKMap(signal); } catch { cikMap = new Map(); }
  const candidates = reported.filter(s => cikMap.has(s.toUpperCase()));

  let fresh = 0;
  const skipped: string[] = [];
  for (const symbol of candidates) {
    const reportDate = recentEarnings.get(symbol)!.date;
    const key = cacheKey(symbol, reportDate);

    try {
      const cached = await redisCommand("GET", key) as string | null;
      if (cached) {
        const parsed = JSON.parse(cached) as unknown;
        // Tombstone: we already tried this symbol+quarter and there was nothing usable. Without it
        // an unreadable filing re-pays a Sonnet call every run for the whole recentEarnings window.
        if (parsed && typeof parsed === "object" && (parsed as { miss?: boolean }).miss) continue;
        // RE-NORMALIZE on read. A cached blob written by an older schema (or truncated) would
        // otherwise reach formatEarningsReleases and throw on `.length`, taking the trade run with it.
        const revived = normalizeReleaseAnalysis(symbol, reportDate, parsed);
        if (revived) { analyses.set(symbol, revived); continue; }
      }
    } catch { /* cache unavailable or unparseable — fall through to a live read */ }

    // Count the ATTEMPT, not the success: a Sonnet call that returns null (429/529, unparseable
    // JSON, content-free document) is still paid for. Incrementing only on success let a bad
    // earnings week bill many multiples of the advertised cap.
    if (fresh >= MAX_NEW_ANALYSES_PER_RUN) { skipped.push(symbol); continue; }

    const release = await fetchLatestEarningsRelease(symbol, cikMap.get(symbol.toUpperCase())!, signal);
    // Guard against a STALE filing: the first item-2.02 8-K may predate this quarter's print (filed
    // later in the day, or filed under 7.01/8.01). Caching last quarter's guidance under this
    // quarter's report date would render it as current for 120 days.
    const daysApart = release ? Math.abs(Date.parse(release.filingDate) - Date.parse(reportDate)) / 86_400_000 : Infinity;
    if (!release || !Number.isFinite(daysApart) || daysApart > 5) {
      skipped.push(symbol);
      await writeCache(key, { miss: true }, MISS_TTL_SECONDS);
      continue;
    }

    fresh++;
    const analysis = await analyzeEarningsRelease(symbol, reportDate, release.content, signal);
    if (!analysis) { skipped.push(symbol); await writeCache(key, { miss: true }, MISS_TTL_SECONDS); continue; }
    analyses.set(symbol, analysis);
    await writeCache(key, analysis, CACHE_TTL_SECONDS);
  }

  // Never let a cap or a structural gap read as "there was nothing to report". Prefixed CONTEXT so
  // the skeptical reviewer and the email do not read it as a dropped/shrunk ORDER, which is what
  // every other entry in buySizingAdjustments means.
  if (skipped.length > 0) {
    notes.push(`CONTEXT — earnings-release summary unavailable this run for: ${skipped.join(", ")}${fresh >= MAX_NEW_ANALYSES_PER_RUN ? ` (hit the ${MAX_NEW_ANALYSES_PER_RUN}-per-run analysis cap; cached next run)` : ""}. No order was affected.`);
  }
  return { analyses, notes };
}

async function writeCache(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await redisCommand("SET", key, JSON.stringify(value), "EX", ttl);
  } catch (e) {
    // redisCommand encodes the payload into a URL path and does not check res.ok, so a silent
    // failure would re-pay a Sonnet call every run. Log it rather than let it vanish.
    console.warn("EARNINGS_RELEASE_CACHE_WRITE_FAILED", { key, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Compact block for the analysis prompt. Empty string when there is nothing to say. */
export function formatEarningsReleases(analyses: Map<string, EarningsReleaseAnalysis>): string {
  if (analyses.size === 0) return "";
  const rows = [...analyses.values()].map(a => {
    const parts = [`${a.symbol} (reported ${a.reportDate}, tone: ${a.tone})`];
    if (a.headline) parts.push(`  headline: ${a.headline}`);
    parts.push(`  GUIDANCE: ${a.guidance ?? "none given in the release"}`);
    if (a.bullCase.length) parts.push(`  bull: ${a.bullCase.join("; ")}`);
    if (a.bearCase.length) parts.push(`  bear: ${a.bearCase.join("; ")}`);
    if (a.redFlags.length) parts.push(`  ⚠ red flags: ${a.redFlags.join("; ")}`);
    return parts.join("\n");
  });
  return `\nWHAT THEY ACTUALLY SAID (latest earnings press release, from the company's own 8-K):
Every other input you have is derived from PRICE — momentum, the quality screen, the 1d/5d move after the print. This is the company's own statement, and GUIDANCE in particular is forward-looking information that price history cannot contain. Weigh it as evidence about the thesis, not as a trading trigger: it does NOT change what is eligible, and it does not override the shortlist or any cap. A strong print with weak guidance is a real reason to prefer another name; cite it in your thesis when it tips a decision. Absence of a red flag is not an endorsement — this is one quarter's prepared remarks, not the call Q&A.
PRECEDENCE when this conflicts with 📈EARN-RECORD: the record is a statistical prior about how this company's prints tend to land; GUIDANCE is what management just said about the quarter ahead. Guidance is the more specific and more recent evidence, so prefer it — but say so explicitly in your thesis when you do.
${rows.join("\n")}`;
}
