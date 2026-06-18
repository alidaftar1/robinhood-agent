import { dedupeRuns, getLatestRun, getRuns, updateLatestRun, computeDailyReturn } from "@/lib/run-store";

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

  const url = new URL(request.url);

  // Infer missing sell records and recompute return for the latest run.
  // Needed when the sell session timed out after orders were already placed on Robinhood.
  if (url.searchParams.get("patchTrades") === "1") {
    try {
      const runs = await getRuns(10);
      const latest = runs[0];
      const prevDay = runs.find(r => r.date < (latest?.date ?? ""));
      if (latest && prevDay?.portfolioAfter) {
        const todaySymbols = new Set(latest.positions.map(p => p.symbol));
        const recordedSells = new Set((latest.trades ?? []).filter(t => t.side === "sell").map(t => t.symbol));
        const missingSellPos = prevDay.positions.filter(p => !todaySymbols.has(p.symbol) && !recordedSells.has(p.symbol));

        if (missingSellPos.length > 0) {
          const buyCost = (latest.trades ?? []).filter(t => t.side === "buy")
            .reduce((s, t) => s + parseFloat(t.quantity) * parseFloat(t.avgPrice), 0);
          const cashBefore = parseFloat(prevDay.portfolioAfter.cash);
          const cashAfter = parseFloat(latest.portfolioAfter?.cash ?? "0");
          const totalProceeds = Math.max(0, cashAfter - cashBefore + buyCost);
          const totalEstValue = missingSellPos.reduce((s, p) => s + parseFloat(p.quantity) * parseFloat(p.price), 0);

          const inferredSells = missingSellPos.map(pos => {
            const estValue = parseFloat(pos.quantity) * parseFloat(pos.price);
            const proportion = totalEstValue > 0 ? estValue / totalEstValue : 1 / missingSellPos.length;
            const avgPrice = parseFloat(pos.quantity) > 0 ? (totalProceeds * proportion) / parseFloat(pos.quantity) : parseFloat(pos.price);
            return { symbol: pos.symbol, side: "sell", quantity: pos.quantity, avgPrice: avgPrice.toFixed(2), state: "inferred" };
          });

          const patchedTrades = [...(latest.trades ?? []), ...inferredSells];
          const agenticResult = latest.portfolioAfter
            ? computeDailyReturn(
                parseFloat(latest.portfolioAfter.totalValue),
                parseFloat(prevDay.portfolioAfter.totalValue),
                latest.positions, prevDay.positions, patchedTrades
              )
            : null;

          await updateLatestRun({ ...latest, trades: patchedTrades, agenticDailyReturn: agenticResult?.dailyReturn ?? null, agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null });
          results.patchTrades = `patched ${inferredSells.length} sell(s): ${inferredSells.map(s => `${s.symbol}@$${s.avgPrice}`).join(", ")} → return ${agenticResult?.dailyReturn != null ? (agenticResult.dailyReturn * 100).toFixed(2) + "%" : "null"}`;
        } else {
          results.patchTrades = "no missing sells detected";
        }
      } else {
        results.patchTrades = "not enough run data";
      }
    } catch (e) {
      results.patchTrades = `error: ${e}`;
    }
  }

  // Clear agenticDailyReturn on latest run if it was computed against a same-day baseline
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
