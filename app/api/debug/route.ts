import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { dedupeRuns, getLatestRun, getRuns, updateLatestRun, updateRunByDate, computeDailyReturn, backfillSleeveReturns, findReRecordedSells } from "@/lib/run-store";
import { getMarketData } from "@/lib/market-data";
import { computeBookBetaForPositions } from "@/lib/risk-metrics";
import { getValidAccessToken } from "@/lib/robinhood-auth";

const MCP_URL = "https://agent.robinhood.com/mcp/trading";

// Parse a Streamable-HTTP MCP response body, which is either plain JSON or an SSE stream
// (event: message\ndata: {json}). Returns the last JSON-RPC payload found. Metadata only.
function parseMcpBody(text: string): any {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { /* fall through */ } }
  let last: any = null;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { last = JSON.parse(m[1]); } catch { /* skip non-JSON data lines */ } }
  }
  return last;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
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

  // READ-ONLY MCP tool-schema introspection. Answers "does place_equity_order support fractional /
  // dollar-based (notional) orders?" by listing the tools and dumping place_equity_order's
  // inputSchema. This is a `tools/list` metadata call — it places NO order and mutates nothing.
  // Uses getValidAccessToken() (Redis-first; MAY refresh+persist if within the 5-min expiry buffer —
  // safe: prod also reads Redis-first, so this cannot break the cron's auth).
  if (url.searchParams.get("mcpToolSchema") === "1") {
    const dbg: Record<string, unknown> = {};
    try {
      const accessToken = await getValidAccessToken();
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      };
      const post = (body: unknown, extra: Record<string, string> = {}) =>
        fetch(MCP_URL, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });

      // 1) initialize (Streamable-HTTP handshake) — capture any session id the server hands back.
      const initRes = await post({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "schema-probe", version: "1.0" } },
      });
      const sessionId = initRes.headers.get("mcp-session-id") ?? initRes.headers.get("Mcp-Session-Id") ?? "";
      const initText = await initRes.text();
      dbg.initStatus = initRes.status;
      dbg.sessionId = sessionId ? "present" : "none";
      const sess: Record<string, string> = sessionId ? { "Mcp-Session-Id": sessionId } : {};
      // best-effort initialized notification (some servers require it before tools/list)
      try { await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sess); } catch { /* optional */ }

      // 2) tools/list — the metadata we actually want.
      const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sess);
      dbg.listStatus = listRes.status;
      const listText = await listRes.text();
      const parsed = parseMcpBody(listText);
      const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = parsed?.result?.tools ?? [];

      if (tools.length) {
        dbg.toolNames = tools.map(t => t.name);
        const order = tools.find(t => t.name === "place_equity_order");
        dbg.place_equity_order = order
          ? { description: order.description, inputSchema: order.inputSchema }
          : "place_equity_order not found in tool list";
        // Also surface review_equity_order — it previews an order and may expose the same param shape.
        const review = tools.find(t => t.name === "review_equity_order");
        if (review) dbg.review_equity_order = { description: review.description, inputSchema: review.inputSchema };
      } else {
        // Handshake likely needs a different shape — return raw bodies so a single trigger diagnoses it.
        dbg.note = "no tools parsed — raw handshake bodies included for diagnosis";
        // Redact any Bearer/long-token-shaped strings before echoing raw bodies (defense-in-depth:
        // the token is only ever sent in a request header, but a reflecting proxy must not leak it).
        const redact = (s: string) => s.replace(/Bearer\s+[\w.\-]+/gi, "Bearer [REDACTED]").replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED]");
        dbg.initBodyRaw = redact(initText.slice(0, 2000));
        dbg.listBodyRaw = redact(listText.slice(0, 4000));
      }
    } catch (e) {
      dbg.error = String(e);
    }
    return Response.json({ mcpToolSchema: dbg });
  }

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
    // &unlock=1 recomputes even a returnLocked day — use ONLY after the artifact that caused the
    // lock is fixed (e.g. the 07-27 re-recorded-sell phantom, fixed by findReRecordedSells). It
    // clears the lock and recomputes from the DEDUPED trades so the phantom can't re-inflate it.
    const unlock = url.searchParams.get("unlock") === "1";
    try {
      const runs = await getRuns(30);
      const run = runs.find(r => r.date === date);
      const prevRun = runs.find(r => r.date < date);
      if (run?.returnLocked && !unlock) {
        results.patchDate = `${date}: skipped — return is locked (known artifact, won't recompute). Pass &unlock=1 only after the artifact is fixed.`;
      } else if (!run || !run.portfolioAfter || !prevRun?.portfolioAfter) {
        results.patchDate = `run or prev not found for ${date}`;
      } else {
        // Drop provably-impossible re-recorded sells (PR #7) before computing, so a double-recorded
        // fill can't be counted as phantom proceeds — the same correction mergeRunsByDate applies.
        const dropKeys = new Set(
          findReRecordedSells(runs).filter(d => d.date === date).map(d => d.dropKey)
        );
        const tradeKeyOf = (t: { symbol: string; side: string; quantity: string; avgPrice: string }) =>
          `${date}|${t.symbol}|${t.side}|${t.quantity}|${t.avgPrice}`;
        const dedupedTrades = (run.trades ?? []).filter(t => !dropKeys.has(tradeKeyOf(t)));
        const result = computeDailyReturn(
          parseFloat(run.portfolioAfter.totalValue),
          parseFloat(prevRun.portfolioAfter.totalValue),
          run.positions, prevRun.positions,
          dedupedTrades
        );
        const patched = await updateRunByDate(date, r => ({
          ...r,
          agenticDailyReturn: result?.dailyReturn ?? null,
          agenticImpliedTransfer: result?.impliedTransfer ?? null,
          ...(unlock ? { returnLocked: false } : {}),
        }));
        results.patchDate = patched
          ? `${date}: return = ${result?.dailyReturn != null ? (result.dailyReturn * 100).toFixed(2) + "%" : "null"}${dropKeys.size ? ` (dropped ${dropKeys.size} re-recorded sell)` : ""}${unlock ? " [unlocked]" : ""}`
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

  // Correct a stored position's snapshot price for one date. Format: DATE:SYMBOL:PRICE. Fixes a
  // historical run where a held position's price was recorded as its cost basis (the pre-enrichPriceMap
  // bug — e.g. PLTR 2026-07-08 stored $116.26 = avgCost vs ~$132 market). Follow with ?recomputeSleeves=1
  // so the sleeve returns recompute against the corrected price (and STAY correct, unlike a
  // setInfluencerReturn override which recompute overwrites).
  const patchPP = url.searchParams.get("patchPositionPrice");
  if (patchPP) {
    const [date, sym, price] = patchPP.split(":");
    if (date && sym && price && parseFloat(price) > 0) {
      const ok = await updateRunByDate(date, (run) => ({
        ...run,
        positions: (run.positions ?? []).map((p) => (p.symbol === sym ? { ...p, price: String(price) } : p)),
        influencerPositions: (run.influencerPositions ?? []).map((p) => (p.symbol === sym ? { ...p, price: String(price) } : p)),
      }));
      results.patchPositionPrice = ok ? `set ${sym} price=${price} on ${date}` : `no run found for ${date}`;
    } else {
      results.patchPositionPrice = "bad format — use DATE:SYMBOL:PRICE";
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

  // Recompute the holdings-based book β on the LATEST run and store it, so the dashboard's
  // "Swings vs. Market" card shows a meaningful number today without waiting for tomorrow's
  // trade run (which stores it natively). Read-only: fetches fresh betas, places no orders.
  if (url.searchParams.get("recomputeBookBeta")) {
    try {
      const latest = await getLatestRun();
      if (!latest || !latest.positions?.length) {
        results.recomputeBookBeta = "no latest run with positions";
      } else {
        const md = await getMarketData();
        const bookBeta = computeBookBetaForPositions(
          md.stocks,
          latest.positions.map(p => ({ symbol: p.symbol, value: parseFloat(p.quantity) * parseFloat(p.price) })),
        );
        await updateLatestRun({ ...latest, bookBeta });
        results.recomputeBookBeta = bookBeta
          ? `set ${latest.date} bookBeta = ${bookBeta.beta.toFixed(2)} (β known for ${bookBeta.coveragePct.toFixed(0)}% of book)`
          : "no priced holdings";
      }
    } catch (e) {
      results.recomputeBookBeta = `error: ${e}`;
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

  // Set the influencer daily return for a date, e.g. ?setInfluencerReturn=2026-06-22&value=-0.0686
  // For a SAME-DAY round trip the position-based framework can't reconstruct (an influencer name
  // bought and stopped out the same day, its buy record since lost) — so the sleeve return is
  // supplied from the real trade prices. SPCX 2026-06-22: (154.61−166)/166 = −6.86%. Non-canonical
  // days like this are skipped by recomputeSleeves, so this value persists.
  if (url.searchParams.get("setInfluencerReturn")) {
    const date = url.searchParams.get("setInfluencerReturn")!;
    const value = parseFloat(url.searchParams.get("value") ?? "");
    if (!isFinite(value)) {
      results.setInfluencerReturn = "error: missing or invalid &value";
    } else {
      try {
        const patched = await updateRunByDate(date, r => ({ ...r, influencerDailyReturn: value }));
        results.setInfluencerReturn = patched ? `set ${date} influencerDailyReturn = ${(value * 100).toFixed(2)}%` : `no run found for ${date}`;
      } catch (e) {
        results.setInfluencerReturn = `error: ${e}`;
      }
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
