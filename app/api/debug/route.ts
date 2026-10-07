import { requireCronAuth } from "@/lib/auth";
import { dedupeRuns, getLatestRun, getRuns, updateLatestRun, updateRunByDate, computeDailyReturn, backfillSleeveReturns, findReRecordedSells } from "@/lib/run-store";
import { getMarketData } from "@/lib/market-data";
import { computeBookBetaForPositions } from "@/lib/risk-metrics";
import { getValidAccessToken } from "@/lib/robinhood-auth";
import { prunePicksByFirstSeen, resetLedger } from "@/lib/influencer-ledger";
import { planSellTagBackfill, applySellTagBackfill, replaceRuns, buildInferredSells, computeSleeveReturns, clampSleeveReturn, applyActorTag } from "@/lib/run-store";
import { getQualityScores } from "@/lib/quality";

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
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  // Mostly human-readable strings, but `patchTradesRefused` carries STRUCTURED data: the
  // autopilot must be able to branch on a refusal without pattern-matching prose.
  const results: Record<string, unknown> = {};

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
        // Strip any previously inferred sells so we can re-derive them with the corrected formula.
        const realTrades = (latest.trades ?? []).filter(t => !(t.state === "inferred" && t.side === "sell"));
        // prevDay is the run that still HELD these positions, so it is the run that can answer which
        // sleeve each belonged to. Price is prevDay's snapshot mark: an ESTIMATE, not an observed
        // fill, which is why these stay state:"inferred" (lib/slippage excludes them). The cash-flow
        // identity is no substitute — cashAfter includes T+1 settlement from the prior day's sells,
        // which inflates apparent proceeds.
        const plan = buildInferredSells(prevDay, { positions: latest.positions, trades: realTrades });

        // Sleeve returns are derived from the trade list too, so a repair that recomputes only the
        // whole-account number leaves them computed against the UNREPAIRED one. That is not cosmetic:
        // computeSleeveReturns sees the sold position vanish from the main book with no offsetting
        // sell, and books its entire value as a phantom loss for that sleeve — 2026-10-06 stored
        // mainDailyReturn -27.65% (NEM $419.79 + KO $54.75 against a ~$1,716 main book) while the
        // whole-account return was a correct +1.12%, because that one divides by TOTAL value
        // including the cash the sale produced. It compounded into the dashboard's headline Main
        // Book Return as -30.90%. Under SLEEVE_EXTREME_RETURN (50%) nothing clamped it, and no
        // reviewer check covers it. ?recomputeSleeves repairs history; this stops it recurring.
        const sleevesFor = (trades: typeof realTrades) => {
          const raw = computeSleeveReturns(
            latest.positions ?? [], trades,
            latest.influencerPositions ?? [], prevDay.influencerPositions ?? [], prevDay.positions ?? [],
          );
          return {
            influencerDailyReturn: clampSleeveReturn(raw.influencerDailyReturn),
            mainDailyReturn: clampSleeveReturn(raw.mainDailyReturn),
          };
        };

        if (plan.unreconstructable.length > 0) {
          // The day's INVENTORY disagrees with its records. The sells we CAN reconstruct are still
          // written — the objection is to the day's number, not to those records, and discarding a
          // perfectly good KO exit because MSFT is unexplained loses information for nothing. But
          // the return is WITHHELD rather than recomputed.
          //
          // Withheld, not left alone: the stored number was computed at write time without the
          // missing sells, so it is already the artifact (the -25%-style phantom loss). Leaving it
          // would turn a repairable wrong number into a permanent one, since patchTrades is the only
          // path that rebuilds sells and patchDate never re-derives them. CLAUDE.md's rule is to
          // withhold what cannot be established, and null is the only branch that actually does.
          //
          // returnLocked because Fix 2 of the 8am autopilot calls patchDate on ANY null return, so
          // an unlocked null is immediately recomputed from the very inventory just declared wrong.
          // It is recoverable: /api/debug?patchDate=DATE&unlock=1 once the book is reconciled. A
          // cleared day is a hole in the compounded record (see the TER 07-27 entry in
          // autopilot-known-issues), which is why this raises an issue rather than going quiet.
          const detail = plan.unreconstructable
            .map(u => `${u.symbol} (${u.reason}${u.excessQty != null ? ` ${u.excessQty.toFixed(6)}` : ""})`)
            .join(", ");
          const patchedTrades = [...realTrades, ...plan.sells];
          await updateLatestRun({
            ...latest, trades: patchedTrades,
            agenticDailyReturn: null, agenticImpliedTransfer: null, returnLocked: true,
            // The per-sleeve split is derived from the SAME inventory, so it is no more
            // establishable than the whole-account number. Leaving the old values would publish a
            // main/influencer attribution computed from a book we have just declared wrong.
            influencerDailyReturn: null, mainDailyReturn: null,
          });
          console.error("PATCH_TRADES_UNRECONSTRUCTABLE", { date: latest.date, unreconstructable: plan.unreconstructable });
          // STRUCTURED, not just prose. The autopilot classifies patchTrades' outcome by string
          // matching, and a "REFUSED …" message passed its "looks like a successful fix" test — so
          // the refusal was filed under auto-fixes, the email subject stayed HEALTHY, and the
          // pre-existing orphan alert was cancelled. Callers must branch on this field.
          results.patchTradesRefused = plan.unreconstructable;
          results.patchTrades = `WITHHELD ${latest.date} — inventory disagrees with the records: ${detail}. `
            + `Wrote ${plan.sells.length} reconstructable sell(s); the day's return is cleared and LOCKED rather than `
            + `recomputed from a known-wrong book. Reconcile against Robinhood, then `
            + `/api/debug?patchDate=${latest.date}&unlock=1.`;
        } else if (plan.sells.length > 0) {
          const patchedTrades = [...realTrades, ...plan.sells];
          const agenticResult = latest.portfolioAfter
            ? computeDailyReturn(
                parseFloat(latest.portfolioAfter.totalValue),
                parseFloat(prevDay.portfolioAfter.totalValue),
                latest.positions, prevDay.positions, patchedTrades
              )
            : null;

          await updateLatestRun({ ...latest, trades: patchedTrades, agenticDailyReturn: agenticResult?.dailyReturn ?? null, agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null, ...sleevesFor(patchedTrades) });
          results.patchTrades = `patched ${plan.sells.length} sell(s): ${plan.sells.map(s => `${s.symbol} ${s.quantity}@$${s.avgPrice}[${s.strategy}]`).join(", ")} → return ${agenticResult?.dailyReturn != null ? (agenticResult.dailyReturn * 100).toFixed(2) + "%" : "null"}`;
        } else if ((latest.trades ?? []).length !== realTrades.length) {
          // Nothing left to infer, but the STORE still holds inferred sells that are no longer
          // derivable — the disposal they stood in for now has a real fill on record. Writing the
          // stripped list is not housekeeping: the stale estimate and the real fill both count as
          // proceeds in computeDailyReturn, and findReRecordedSells cannot collapse them because
          // its twin test needs the duplicate's quantity to cover the whole excess, which a PARTIAL
          // inferred sell never does. Two sells for one disposal is the TER 07-27 shape, which
          // stored a -0.08% day as +13.27%. Writing partial quantities (new on 2026-10-05) is what
          // brought this within reach, so it is closed here rather than left to the merge layer.
          const obsolete = (latest.trades ?? []).filter(t => t.state === "inferred" && t.side === "sell");
          const agenticResult = latest.portfolioAfter
            ? computeDailyReturn(
                parseFloat(latest.portfolioAfter.totalValue),
                parseFloat(prevDay.portfolioAfter.totalValue),
                latest.positions, prevDay.positions, realTrades
              )
            : null;
          await updateLatestRun({
            ...latest, trades: realTrades,
            agenticDailyReturn: agenticResult?.dailyReturn ?? null,
            agenticImpliedTransfer: agenticResult?.impliedTransfer ?? null,
            ...sleevesFor(realTrades),
          });
          results.patchTrades = `dropped ${obsolete.length} obsolete inferred sell(s) now covered by real fills `
            + `(${obsolete.map(t => `${t.symbol} x${t.quantity}`).join(", ")}) → return `
            + `${agenticResult?.dailyReturn != null ? (agenticResult.dailyReturn * 100).toFixed(2) + "%" : "null"}`;
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

  // Stamp provenance on trades written before `actor` existed. Format:
  //   ?tagActor=DATE:SYMBOL:SIDE:agent|human[:YYYY-MM-DD][,...]   (actor "-" = date only)
  // Needed because provenance is NOT recoverable from the record — a human fill and an agent fill
  // are both state:"filled" with no refPrice — so the only correct source is someone who knows.
  // Never overwrites a tag a writer set first-hand; it only fills gaps.
  const tagActor = url.searchParams.get("tagActor");
  if (tagActor) {
    // DATE:SYMBOL:SIDE:actor[:filledOn][,...] — filledOn optional, and `actor` may be "-" to set
    // only the date on a trade whose provenance is already recorded.
    const [date, ...rest] = tagActor.split(":");
    const tags: Array<{ symbol: string; side: string; actor?: "agent" | "human"; tradedOn?: string }> = [];
    for (const part of rest.join(":").split(",")) {
      const [symbol, side, actor, filledOn] = part.split(":");
      if (!symbol || (side !== "buy" && side !== "sell")) continue;
      const a = actor === "agent" || actor === "human" ? actor : undefined;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(filledOn ?? "") ? filledOn : undefined;
      if (a || d) tags.push({ symbol, side, ...(a ? { actor: a } : {}), ...(d ? { tradedOn: d } : {}) });
    }
    if (!date || tags.length === 0) {
      results.tagActor = "bad format — use DATE:SYMBOL:SIDE:agent|human[:YYYY-MM-DD][,...]";
    } else {
      let changed = { actors: 0, dates: 0 };
      // &force=1 replaces a value already recorded — needed when a WRITER's own tag is a false
      // claim (see applyActorTag). Explicit so it can never happen by accident.
      const force = url.searchParams.get("force") === "1";
      const ok = await updateRunByDate(date, (run) => { changed = applyActorTag(run, tags, force); return run; });
      results.tagActor = ok
        ? `${date}: set actor on ${changed.actors} trade(s), fill date on ${changed.dates} `
          + `(${tags.map(t => `${t.side} ${t.symbol}${t.actor ? "=" + t.actor : ""}${t.tradedOn ? "@" + t.tradedOn : ""}`).join(", ")}). `
          + (force ? "FORCED — existing values were replaced." : "Fields already recorded are never overwritten.")
        : `no run found for ${date}`;
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

  // Force-refresh the SEC quality scores from source (bypasses the ~weekly cache). Use after a change
  // to the quality screen so the next trade run picks it up immediately instead of waiting out the TTL.
  // Surgical ledger prune by first-seen date. The ledger is ONE Redis key holding a JSON object, so
  // the Upstash console can only delete the whole thing — which is the full reset the owner chose
  // against. Gated by requireCronAuth like everything else here.
  // Backfill strategy tags on sells written before the tagger was fixed. ?backfillSellTags=1 is a
  // DRY RUN; add &write=1 to apply. Read-then-write, and replaceRuns refuses to shrink the list.
  if (url.searchParams.get("backfillSellTags")) {
    try {
      const runs = await getRuns(200);
      const plan = planSellTagBackfill(runs);
      const total = plan.reduce((a, p) => a + p.tagged.length, 0);
      if (url.searchParams.get("write") === "1") {
        const n = applySellTagBackfill(runs, plan);
        await replaceRuns(runs);
        results.backfillSellTags = `tagged ${n} sells across ${plan.length} runs`;
      } else {
        const sample = plan.slice(0, 6).map(p => `${p.date}: ${p.tagged.map(t => `${t.symbol}=${t.strategy}`).join(" ")}`);
        results.backfillSellTags = `DRY RUN — would tag ${total} sells across ${plan.length} runs. ${sample.join(" | ")}`;
      }
    } catch (e) {
      results.backfillSellTags = `error: ${e}`;
    }
  }

  const resetConfirm = url.searchParams.get("resetLedger");
  if (resetConfirm) {
    try {
      const r = await resetLedger(resetConfirm);
      results.resetLedger = "refused" in r ? `refused: ${r.refused}` : `cleared ${r.cleared} picks`;
    } catch (e) {
      results.resetLedger = `error: ${e}`;
    }
  }

  const pruneDates = url.searchParams.get("pruneLedgerDates");
  if (pruneDates) {
    try {
      const r = await prunePicksByFirstSeen(pruneDates.split(",").map(d => d.trim()));
      results.pruneLedgerDates = r.skipped
        ? "skipped — ledger read failed; refusing to write (would wipe history)"
        : r.refused
          ? `refused: ${r.refused}`
          : `removed ${r.removed.length}: ${r.removed.join(" ") || "none"} — ${r.remaining} picks remain`;
    } catch (e) {
      results.pruneLedgerDates = `error: ${e}`;
    }
  }

  if (url.searchParams.get("refreshQuality")) {
    try {
      const q = await getQualityScores(true);
      const elig = q ? Object.values(q.scores).filter(s => s.eligible).length : 0;
      // Name the DEAD universe entries, not just count them. Pruning SP500_UNIVERSE needs owner
      // approval, and the list only ever existed in a log line Vercel does not retain, so the prune
      // was unapprovable in practice. These have no CIK in SEC's ticker file — acquired, renamed or
      // delisted — and each burns a Yahoo quote every run.
      // Capped at 30 like the log line it mirrors (lib/quality.ts) — in the truncated-ticker-map
      // case this list can be the WHOLE universe, and a debug payload is not the place to dump it.
      // The suspect flag leads, because acting on a suspect list deletes LIVE names.
      results.refreshQuality = q
        ? `refreshed: ${Object.keys(q.scores).length} scored, ${elig} eligible (period ${q.period}); ` +
          (q.staleUniverseSuspect
            ? `⚠ ${q.staleUniverse.length} symbols have no CIK — IMPLAUSIBLE, suspect a truncated SEC ticker map. Do NOT prune on this.`
            : `stale universe (${q.staleUniverse.length}): ${q.staleUniverse.slice(0, 30).join(" ") || "none"}${q.staleUniverse.length > 30 ? " …" : ""}`)
        : "failed (SEC/Redis unavailable)";
    } catch (e) {
      results.refreshQuality = `error: ${e}`;
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
