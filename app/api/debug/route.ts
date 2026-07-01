import { dedupeRuns, getLatestRun, getRuns, updateLatestRun, updateRunByDate, computeDailyReturn, backfillSleeveReturns } from "@/lib/run-store";

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
      if (latest?.returnLocked) {
        results.patchTrades = `skipped — return for ${latest.date} is locked (known artifact)`;
      } else if (latest && prevDay?.portfolioAfter) {
        const todaySymbols = new Set(latest.positions.map(p => p.symbol));
        // Strip any previously inferred sells so we can re-derive them with the corrected formula
        const realTrades = (latest.trades ?? []).filter(t => t.state !== "inferred");
        const recordedSells = new Set(realTrades.filter(t => t.side === "sell").map(t => t.symbol));
        const missingSellPos = prevDay.positions.filter(p => !todaySymbols.has(p.symbol) && !recordedSells.has(p.symbol));

        if (missingSellPos.length > 0) {
          // Use prevDay position's stored price as best estimate of fill price.
          // The cash-flow identity is unreliable here: cashAfter includes T+1
          // settlement from the previous day's sells, inflating apparent proceeds.
          const inferredSells = missingSellPos.map(pos => {
            const avgPrice = parseFloat(pos.price) > 0 ? parseFloat(pos.price) : parseFloat(pos.avgCost);
            return { symbol: pos.symbol, side: "sell", quantity: pos.quantity, avgPrice: avgPrice.toFixed(2), state: "inferred" };
          });

          const patchedTrades = [...realTrades, ...inferredSells];
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

  // Recompute agenticDailyReturn for a specific historical run by date.
  // Use when a run was injected with agenticDailyReturn=null but all position/trade data is present.
  if (url.searchParams.get("patchDate")) {
    const date = url.searchParams.get("patchDate")!;
    try {
      const runs = await getRuns(30);
      const run = runs.find(r => r.date === date);
      const prevRun = runs.find(r => r.date < date);
      if (run?.returnLocked) {
        results.patchDate = `${date}: skipped — return is locked (known artifact, won't recompute)`;
      } else if (!run || !run.portfolioAfter || !prevRun?.portfolioAfter) {
        results.patchDate = `run or prev not found for ${date}`;
      } else {
        const result = computeDailyReturn(
          parseFloat(run.portfolioAfter.totalValue),
          parseFloat(prevRun.portfolioAfter.totalValue),
          run.positions, prevRun.positions,
          run.trades ?? []
        );
        const patched = await updateRunByDate(date, r => ({
          ...r,
          agenticDailyReturn: result?.dailyReturn ?? null,
          agenticImpliedTransfer: result?.impliedTransfer ?? null,
        }));
        results.patchDate = patched
          ? `${date}: return = ${result?.dailyReturn != null ? (result.dailyReturn * 100).toFixed(2) + "%" : "null"}`
          : `no run found for ${date}`;
      }
    } catch (e) {
      results.patchDate = `error: ${e}`;
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

  // Backfill/correct influencer + main sleeve returns across all history with the fixed
  // sleeve-trade attribution. Corrects artifacts where a position sold OUT of the influencer
  // sleeve booked its prior value as a phantom loss (e.g. BTC 2026-06-30 → bogus −14.13%),
  // and gives the main book a full history instead of a single day.
  if (url.searchParams.get("recomputeSleeves")) {
    try {
      const changes = await backfillSleeveReturns();
      results.recomputeSleeves = changes.length ? `patched ${changes.length}: ${changes.join(" | ")}` : "no changes";
    } catch (e) {
      results.recomputeSleeves = `error: ${e}`;
    }
  }

  // Clear agenticDailyReturn for a specific date (use when early runs have bogus 0% same-day returns)
  if (url.searchParams.get("clearReturnForDate")) {
    const date = url.searchParams.get("clearReturnForDate")!;
    try {
      const patched = await updateRunByDate(date, r => ({ ...r, agenticDailyReturn: null, agenticImpliedTransfer: null, returnLocked: true }));
      results.clearReturnForDate = patched ? `cleared + locked return for ${date}` : `no run found for ${date}`;
    } catch (e) {
      results.clearReturnForDate = `error: ${e}`;
    }
  }

  // Correct a recorded transfer figure for a date, e.g. ?setTransfer=2026-06-23&amount=300
  // (used to fix a known deposit amount when the old/new totalValue format inflated it).
  if (url.searchParams.get("setTransfer")) {
    const date = url.searchParams.get("setTransfer")!;
    const amount = parseFloat(url.searchParams.get("amount") ?? "");
    if (!isFinite(amount)) {
      results.setTransfer = "error: missing or invalid &amount";
    } else {
      try {
        const patched = await updateRunByDate(date, r => ({ ...r, agenticImpliedTransfer: amount }));
        results.setTransfer = patched ? `set transfer for ${date} to ${amount}` : `no run found for ${date}`;
      } catch (e) {
        results.setTransfer = `error: ${e}`;
      }
    }
  }

  // Correct unsettled cash for a date, e.g. ?setUnsettled=2026-06-23&amount=505.61
  // Recomputes totalValue = settled cash + unsettled + equity to stay consistent.
  if (url.searchParams.get("setUnsettled")) {
    const date = url.searchParams.get("setUnsettled")!;
    const amount = parseFloat(url.searchParams.get("amount") ?? "");
    if (!isFinite(amount)) {
      results.setUnsettled = "error: missing or invalid &amount";
    } else {
      try {
        const patched = await updateRunByDate(date, r => {
          if (!r.portfolioAfter) return r;
          const cash = parseFloat(r.portfolioAfter.cash) || 0;
          const equity = parseFloat(r.portfolioAfter.equity) || 0;
          return { ...r, portfolioAfter: { ...r.portfolioAfter, unsettledCash: amount.toFixed(2), totalValue: (cash + amount + equity).toFixed(2) } };
        });
        results.setUnsettled = patched ? `set unsettled for ${date} to ${amount}` : `no run found for ${date}`;
      } catch (e) {
        results.setUnsettled = `error: ${e}`;
      }
    }
  }

  // Correct settled cash + equity for a date, e.g. ?setCashEquity=2026-06-25&cash=43.55&equity=1668.17
  // Recomputes totalValue = cash + (existing unsettled) + equity. Use to repair a snapshot
  // whose stale cash/equity (e.g. a same-day run-merge that kept the morning values) no
  // longer matches the reconciled positions / live balance.
  if (url.searchParams.get("setCashEquity")) {
    const date = url.searchParams.get("setCashEquity")!;
    const cash = parseFloat(url.searchParams.get("cash") ?? "");
    const equity = parseFloat(url.searchParams.get("equity") ?? "");
    if (!isFinite(cash) || !isFinite(equity)) {
      results.setCashEquity = "error: missing or invalid &cash / &equity";
    } else {
      try {
        const patched = await updateRunByDate(date, r => {
          if (!r.portfolioAfter) return r;
          const unsettled = parseFloat(r.portfolioAfter.unsettledCash ?? "0") || 0;
          return { ...r, portfolioAfter: { ...r.portfolioAfter, cash: cash.toFixed(2), equity: equity.toFixed(2), totalValue: (cash + unsettled + equity).toFixed(2) } };
        });
        results.setCashEquity = patched ? `set cash=${cash} equity=${equity} for ${date}` : `no run found for ${date}`;
      } catch (e) {
        results.setCashEquity = `error: ${e}`;
      }
    }
  }

  return Response.json(results);
}
