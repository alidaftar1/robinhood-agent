import { dedupeRuns, getLatestRun, updateLatestRun } from "@/lib/run-store";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, string> = {};

  // Test Yahoo Finance
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    results.yahoo = res.ok ? `ok (${res.status})` : `http ${res.status}`;
  } catch (e) {
    results.yahoo = `error: ${e}`;
  }

  // Test NewsAPI
  try {
    const res = await fetch(`https://newsapi.org/v2/top-headlines?category=business&pageSize=1&apiKey=${process.env.NEWS_API_KEY}`);
    results.newsapi = res.ok ? `ok (${res.status})` : `http ${res.status}`;
  } catch (e) {
    results.newsapi = `error: ${e}`;
  }

  // Test Upstash
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    });
    results.upstash = res.ok ? `ok (${res.status})` : `http ${res.status}`;
  } catch (e) {
    results.upstash = `error: ${e}`;
  }

  // Test Robinhood token refresh (just check env vars)
  results.robinhoodToken = process.env.ROBINHOOD_REFRESH_TOKEN ? "refresh token present" : "MISSING";
  results.anthropicKey = process.env.ANTHROPIC_API_KEY ? "present" : "MISSING";

  // Dedup same-day runs (keep latest per date)
  try {
    const removed = await dedupeRuns();
    results.dedup = `removed ${removed} duplicate(s)`;
  } catch (e) {
    results.dedup = `error: ${e}`;
  }

  // Clear agenticDailyReturn on latest run if it was computed against a same-day baseline
  const url = new URL(request.url);
  if (url.searchParams.get("clearReturn") === "1") {
    try {
      const latest = await getLatestRun();
      if (latest) {
        await updateLatestRun({ ...latest, agenticDailyReturn: null, agenticImpliedTransfer: null });
        results.clearReturn = `cleared return for ${latest.date}`;
      }
    } catch (e) {
      results.clearReturn = `error: ${e}`;
    }
  }

  return Response.json(results);
}
