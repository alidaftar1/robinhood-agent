import { SP500_UNIVERSE } from "@/lib/strategy";
import type { ToolCall, TradeDecision } from "./agent";
import type { Scenario } from "./fixtures";
import { mockPrice } from "./fixtures";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

// ─── Individual checks ────────────────────────────────────────────────────────

/**
 * When portfolio state is pre-injected (always the case in production and evals),
 * Claude must NOT call get_equity_positions or get_portfolio — they're redundant
 * and waste an MCP round-trip (~20-30s).
 */
export function checkSkipsPositionsWithPreInjection(calls: ToolCall[]): CheckResult {
  const redundant = calls.filter(
    (c) => c.tool === "get_equity_positions" || c.tool === "get_portfolio"
  );
  return {
    name: "skips get_equity_positions and get_portfolio (pre-injected)",
    passed: redundant.length === 0,
    detail: redundant.length > 0
      ? `called redundantly: ${redundant.map((c) => c.tool).join(", ")}`
      : undefined,
  };
}

/** All sells must precede all buys (to free buying power first). */
export function checkSellsBeforeBuys(calls: ToolCall[]): CheckResult {
  const orders = calls.filter((c) => c.tool === "place_equity_order");
  const firstBuyIdx = orders.findIndex((o) => o.input.side === "buy");
  const lastSellIdx = orders.findLastIndex((o) => o.input.side === "sell");

  if (firstBuyIdx === -1 || lastSellIdx === -1) {
    return { name: "sells before buys", passed: true, detail: "only one side present" };
  }
  const passed = lastSellIdx < firstBuyIdx;
  return {
    name: "sells before buys",
    passed,
    detail: passed
      ? "all sells precede buys"
      : `sell at index ${lastSellIdx} comes after buy at index ${firstBuyIdx}`,
  };
}

/** Every order symbol must be in the S&P 500 universe. */
export function checkSP500Only(calls: ToolCall[]): CheckResult {
  const orders = calls.filter((c) => c.tool === "place_equity_order");
  const offUniverse = orders.filter((o) => !SP500_UNIVERSE.includes(String(o.input.symbol ?? "")));
  return {
    name: "only S&P 500 stocks ordered (universe: 449 tickers)",
    passed: offUniverse.length === 0,
    detail: offUniverse.length > 0
      ? `off-universe: ${offUniverse.map((o) => o.input.symbol).join(", ")}`
      : undefined,
  };
}

/** No single buy should cost more than $400 (40% of the $1k budget, as stated in the system prompt). */
export function checkPositionCap(calls: ToolCall[], _scenario: Scenario): CheckResult {
  const cap = 400;
  const buys = calls.filter((c) => c.tool === "place_equity_order" && c.input.side === "buy");

  const violations = buys.filter((o) => {
    const symbol = String(o.input.symbol ?? "");
    const qty = Number(o.input.quantity ?? 0);
    const cost = qty * mockPrice(symbol);
    return cost > cap + 1; // +$1 tolerance for rounding
  });

  return {
    name: "no single position > 40% of portfolio",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? violations
          .map((o) => `${o.input.symbol} ×${o.input.quantity} = $${(Number(o.input.quantity) * mockPrice(String(o.input.symbol))).toFixed(0)} (cap $${cap.toFixed(0)})`)
          .join(", ")
      : undefined,
  };
}

/** All order quantities must be whole numbers (no fractional shares). */
export function checkWholeShares(calls: ToolCall[]): CheckResult {
  const orders = calls.filter((c) => c.tool === "place_equity_order");
  const fractional = orders.filter((o) => {
    const qty = Number(o.input.quantity ?? 0);
    return !Number.isInteger(qty) || qty <= 0;
  });
  return {
    name: "whole share quantities only",
    passed: fractional.length === 0,
    detail: fractional.length > 0
      ? `fractional: ${fractional.map((o) => `${o.input.symbol}×${o.input.quantity}`).join(", ")}`
      : undefined,
  };
}

/**
 * Claude must not call forbidden tools.
 * We removed these from the process instructions; calling them wastes time.
 */
export function checkNoForbiddenTools(calls: ToolCall[]): CheckResult {
  const forbidden = ["get_equity_quotes", "get_equity_tradability", "review_equity_order"];
  const violations = calls.filter((c) => forbidden.includes(c.tool));
  return {
    name: "no forbidden tool calls",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? `called: ${[...new Set(violations.map((c) => c.tool))].join(", ")}`
      : undefined,
  };
}

/**
 * Total cost of all buys must not exceed buying power + proceeds from sells
 * placed in the same run (optimistic: assumes sells execute immediately).
 */
export function checkBudget(calls: ToolCall[], scenario: Scenario): CheckResult {
  const buyingPower = parseFloat(scenario.buyingPower.replace("$", ""));
  const orders = calls.filter((c) => c.tool === "place_equity_order");

  const sellProceeds = orders
    .filter((o) => o.input.side === "sell")
    .reduce((sum, o) => {
      const symbol = String(o.input.symbol ?? "");
      const qty = Number(o.input.quantity ?? 0);
      return sum + qty * mockPrice(symbol);
    }, 0);

  const buySpend = orders
    .filter((o) => o.input.side === "buy")
    .reduce((sum, o) => {
      const symbol = String(o.input.symbol ?? "");
      const qty = Number(o.input.quantity ?? 0);
      return sum + qty * mockPrice(symbol);
    }, 0);

  const available = buyingPower + sellProceeds;
  const passed = buySpend <= available + 1; // +$1 tolerance
  return {
    name: "buy spend within available funds",
    passed,
    detail: passed
      ? undefined
      : `spent $${buySpend.toFixed(0)} but only $${available.toFixed(0)} available (power: $${buyingPower} + sells: $${sellProceeds.toFixed(0)})`,
  };
}

/**
 * Claude must not buy a stock with earnings ≤3 days away (⚠⚠ IMMINENT).
 * The system prompt says "exit or avoid" — buying into imminent earnings is always wrong.
 */
export function checkNoImminentEarningsBuys(calls: ToolCall[], scenario: Scenario): CheckResult {
  const today = Date.now();
  const imminent = Object.entries(scenario.earningsOverrides ?? {})
    .filter(([, date]) => {
      const daysOut = (new Date(date).getTime() - today) / 86_400_000;
      return daysOut >= 0 && daysOut <= 3;
    })
    .map(([symbol]) => symbol);

  if (imminent.length === 0) {
    return { name: "no buys into imminent earnings", passed: true, detail: "no imminent earnings in scenario" };
  }

  const violations = calls.filter(
    (c) => c.tool === "place_equity_order" && c.input.side === "buy" && imminent.includes(String(c.input.symbol ?? ""))
  );

  return {
    name: "no buys into imminent earnings",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? `bought into imminent earnings (≤3d): ${violations.map((c) => c.input.symbol).join(", ")}`
      : `correctly avoided: ${imminent.join(", ")}`,
  };
}

/**
 * If a pre-injected position has ⚠⚠ IMMINENT earnings (≤3 days), Claude must sell it.
 * The system prompt says "If already holding, sell before earnings" — no exceptions.
 */
export function checkSellsImminent(calls: ToolCall[], scenario: Scenario): CheckResult {
  const today = Date.now();
  const imminentHeld = scenario.positions
    .filter((p) => {
      const date = scenario.earningsOverrides?.[p.symbol];
      if (!date) return false;
      const daysOut = (new Date(date).getTime() - today) / 86_400_000;
      return daysOut >= 0 && daysOut <= 3;
    })
    .map((p) => p.symbol);

  if (imminentHeld.length === 0) {
    return { name: "exits holdings with imminent earnings", passed: true, detail: "no held positions with imminent earnings" };
  }

  const sold = calls
    .filter((c) => c.tool === "place_equity_order" && c.input.side === "sell")
    .map((c) => String(c.input.symbol ?? ""));

  const notSold = imminentHeld.filter((s) => !sold.includes(s));
  return {
    name: "exits holdings with imminent earnings",
    passed: notSold.length === 0,
    detail: notSold.length > 0
      ? `still holding ${notSold.join(", ")} with ⚠⚠ IMMINENT earnings — must exit`
      : `correctly exited: ${imminentHeld.join(", ")}`,
  };
}

/**
 * If a scenario marks positions as severely dropped (≥5% intraday), Claude must sell them.
 * Only checks positions that are both dropped AND currently held.
 */
export function checkSellsDropped(calls: ToolCall[], scenario: Scenario): CheckResult {
  const droppedHeld = (scenario.droppedPositions ?? []).filter((sym) =>
    scenario.positions.some((p) => p.symbol === sym)
  );

  if (droppedHeld.length === 0) {
    return { name: "exits severely dropped holdings (≥5% intraday)", passed: true, detail: "no dropped positions in scenario" };
  }

  const sold = calls
    .filter((c) => c.tool === "place_equity_order" && c.input.side === "sell")
    .map((c) => String(c.input.symbol ?? ""));

  const notSold = droppedHeld.filter((s) => !sold.includes(s));
  return {
    name: "exits severely dropped holdings (≥5% intraday)",
    passed: notSold.length === 0,
    detail: notSold.length > 0
      ? `still holding ${notSold.join(", ")} despite ≥5% drop — should exit`
      : `correctly exited: ${droppedHeld.join(", ")}`,
  };
}

/**
 * If an upgraded stock was purchased, Claude's reasoning must reference the analyst signal.
 * Downgrades are not a hard constraint (Claude may override with other signals) but upgrades
 * on stocks that Claude actually buys should be mentioned.
 */
export function checkAnalystSignalRespected(calls: ToolCall[], summary: string, scenario: Scenario): CheckResult {
  const ratings = scenario.analystRatings ?? {};
  const upgradedSymbols = Object.entries(ratings)
    .filter(([, rs]) => rs.some((r) => r.action === "upgrade"))
    .map(([symbol]) => symbol);

  if (upgradedSymbols.length === 0) {
    return { name: "analyst upgrade signal respected", passed: true, detail: "no upgrades in scenario" };
  }

  const boughtUpgraded = calls.filter(
    (c) => c.tool === "place_equity_order" && c.input.side === "buy" && upgradedSymbols.includes(String(c.input.symbol ?? ""))
  );

  if (boughtUpgraded.length === 0) {
    return { name: "analyst upgrade signal respected", passed: true, detail: "did not buy any upgraded stock" };
  }

  const analystKeywords = ["upgrade", "analyst", "raised", "buy rating", "outperform", "overweight", "↑", "⚡", "impactful", "high-conviction"];
  const lowerSummary = summary.toLowerCase();
  const mentioned = analystKeywords.some((k) => lowerSummary.includes(k));

  return {
    name: "analyst upgrade signal respected",
    passed: mentioned,
    detail: mentioned
      ? `referenced analyst signal while buying ${boughtUpgraded.map((c) => c.input.symbol).join(", ")}`
      : `bought upgraded stock(s) ${boughtUpgraded.map((c) => c.input.symbol).join(", ")} without mentioning analyst signal`,
  };
}

/** Final summary must contain a trading thesis in the prose text before the PORTFOLIO_SNAPSHOT line. */
export function checkHasReasoning(summary: string): CheckResult {
  // Only scan text before the snapshot JSON — keywords in table headers or JSON don't count as reasoning
  const prose = summary.split(/^PORTFOLIO_SNAPSHOT:/m)[0];
  const keywords = [
    "momentum", "thesis", "sector", "because", "earnings", "macro", "catalyst",
    "growth", "valuation", "insider", "signal", "sharpe", "upgrade", "rebalance",
    "rotation", "alpha", "conviction", "strength", "performance", "position",
    "holding", "portfolio", "risk", "market", "buy", "sell", "keep",
  ];
  const found = keywords.filter((k) => prose.toLowerCase().includes(k));
  // Require at least 1 relevant keyword — goal is detecting completely empty reasoning, not mandating richness
  return {
    name: "provides trading thesis / reasoning",
    passed: found.length >= 1 && prose.length > 100,
    detail: `keywords found: ${found.join(", ")} (prose length: ${prose.length})`,
  };
}

/**
 * Claude must emit a PORTFOLIO_SNAPSHOT line at the end of its response.
 * This line is the production pipeline's source for portfolioAfter, positions, and trades —
 * without it, the run is saved with null portfolioAfter and the comparison chart breaks.
 */
export function checkSnapshotPresent(summary: string): CheckResult {
  const match = summary.match(/^PORTFOLIO_SNAPSHOT:(\{.+\})$/m);
  if (!match) {
    return { name: "PORTFOLIO_SNAPSHOT line emitted", passed: false, detail: "missing PORTFOLIO_SNAPSHOT line" };
  }
  try {
    const snap = JSON.parse(match[1]);
    const hasCash = snap.cash !== undefined;
    const hasPositions = Array.isArray(snap.positions);
    const hasTrades = Array.isArray(snap.trades);
    const passed = hasCash && hasPositions && hasTrades;
    return {
      name: "PORTFOLIO_SNAPSHOT line emitted",
      passed,
      detail: passed
        ? `cash=${snap.cash}, ${snap.positions.length} positions, ${snap.trades.length} trades`
        : `missing fields: ${!hasCash ? "cash " : ""}${!hasPositions ? "positions " : ""}${!hasTrades ? "trades" : ""}`,
    };
  } catch (e) {
    return {
      name: "PORTFOLIO_SNAPSHOT line emitted",
      passed: false,
      detail: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * PORTFOLIO_SNAPSHOT cash must equal: starting buying power + sell proceeds − buy costs.
 * Validates that Claude is tracking its own cash balance correctly.
 */
export function checkSnapshotCashMath(summary: string, calls: ToolCall[], scenario: Scenario): CheckResult {
  const match = summary.match(/^PORTFOLIO_SNAPSHOT:(\{.+\})$/m);
  if (!match) {
    return { name: "PORTFOLIO_SNAPSHOT cash math correct", passed: false, detail: "no snapshot found" };
  }
  try {
    const snap = JSON.parse(match[1]);
    const snapshotCash = parseFloat(String(snap.cash ?? "0"));
    const startingBP = parseFloat(scenario.buyingPower.replace("$", ""));
    const orders = calls.filter((c) => c.tool === "place_equity_order");
    const sellProceeds = orders
      .filter((o) => o.input.side === "sell")
      .reduce((s, o) => s + Number(o.input.quantity ?? 0) * mockPrice(String(o.input.symbol ?? "")), 0);
    const buyCosts = orders
      .filter((o) => o.input.side === "buy")
      .reduce((s, o) => s + Number(o.input.quantity ?? 0) * mockPrice(String(o.input.symbol ?? "")), 0);
    const expectedCash = startingBP + sellProceeds - buyCosts;
    const diff = Math.abs(snapshotCash - expectedCash);
    const passed = diff <= 2; // $2 tolerance for price rounding
    return {
      name: "PORTFOLIO_SNAPSHOT cash math correct",
      passed,
      detail: passed
        ? `$${snapshotCash} ≈ BP $${startingBP} + sells $${sellProceeds.toFixed(0)} − buys $${buyCosts.toFixed(0)}`
        : `snapshot $${snapshotCash} ≠ expected $${expectedCash.toFixed(2)} (diff $${diff.toFixed(2)})`,
    };
  } catch (e) {
    return { name: "PORTFOLIO_SNAPSHOT cash math correct", passed: false, detail: String(e) };
  }
}

// ─── Decision-based checks (analysis session) ─────────────────────────────────
// These operate on the TRADE_DECISION JSON produced by buildAnalysisPrompt,
// not on MCP tool calls. They mirror the constraints enforced in that prompt.

/** TRADE_DECISION line must be present and parse to valid JSON with required fields. */
export function checkTradeDecisionPresent(text: string): CheckResult {
  const match = text.match(/^TRADE_DECISION:(.+)$/m);
  if (!match) {
    return { name: "TRADE_DECISION line present", passed: false, detail: "no TRADE_DECISION line found" };
  }
  try {
    const d = JSON.parse(match[1]);
    const valid = typeof d.thesis === "string" && Array.isArray(d.sells) && Array.isArray(d.buys);
    return {
      name: "TRADE_DECISION line present",
      passed: valid,
      detail: valid
        ? `thesis ${d.thesis.length}ch, sells=${d.sells.length}, buys=${d.buys.length}`
        : "missing required fields: thesis, sells[], buys[]",
    };
  } catch (e) {
    return { name: "TRADE_DECISION line present", passed: false, detail: `JSON parse error: ${e}` };
  }
}

/**
 * T+1 settlement: total buy cost must not exceed settled buying power.
 * Sell proceeds are NOT added — they don't settle same day.
 */
export function checkT1BudgetRespected(decision: TradeDecision | null, scenario: Scenario): CheckResult {
  if (!decision) return { name: "T+1: buys within settled buying power", passed: false, detail: "no decision parsed" };
  const settled = parseFloat(scenario.buyingPower.replace("$", ""));
  const buyCost = decision.buys.reduce((s, b) => s + b.quantity * (b.price || mockPrice(b.symbol)), 0);
  const passed = buyCost <= settled + 1;
  return {
    name: "T+1: buys within settled buying power",
    passed,
    detail: passed
      ? `$${buyCost.toFixed(0)} ≤ $${settled} settled power`
      : `$${buyCost.toFixed(0)} exceeds $${settled} settled power (sell proceeds don't count)`,
  };
}

/** No single buy position should cost more than $400. */
export function checkDecisionPositionCap(decision: TradeDecision | null): CheckResult {
  if (!decision) return { name: "no single buy > $400", passed: false, detail: "no decision parsed" };
  const cap = 400;
  const violations = decision.buys.filter(b => b.quantity * (b.price || mockPrice(b.symbol)) > cap + 1);
  return {
    name: "no single buy > $400",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? violations.map(b => `${b.symbol} ×${b.quantity} @ $${b.price} = $${(b.quantity * b.price).toFixed(0)}`).join(", ")
      : undefined,
  };
}

/** No buy should cost less than $50 (minimum position size). */
export function checkDecisionMinPositionSize(decision: TradeDecision | null): CheckResult {
  if (!decision) return { name: "no buy < $50 minimum", passed: false, detail: "no decision parsed" };
  const min = 50;
  const violations = decision.buys.filter(b => b.quantity * (b.price || mockPrice(b.symbol)) < min - 1);
  return {
    name: "no buy < $50 minimum",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? violations.map(b => `${b.symbol} ×${b.quantity} @ $${b.price} = $${(b.quantity * b.price).toFixed(0)}`).join(", ")
      : undefined,
  };
}

/** All symbols in sells/buys must be in the S&P 500 universe. */
export function checkDecisionSP500Only(decision: TradeDecision | null): CheckResult {
  if (!decision) return { name: "only S&P 500 in decision", passed: false, detail: "no decision parsed" };
  const allSymbols = [...decision.sells.map(s => s.symbol), ...decision.buys.map(b => b.symbol)];
  const offUniverse = allSymbols.filter(sym => !SP500_UNIVERSE.includes(sym));
  return {
    name: "only S&P 500 in decision",
    passed: offUniverse.length === 0,
    detail: offUniverse.length > 0 ? `off-universe: ${offUniverse.join(", ")}` : undefined,
  };
}

/** Buys and sells must use whole share quantities. */
export function checkDecisionWholeShares(decision: TradeDecision | null): CheckResult {
  if (!decision) return { name: "whole share quantities in decision", passed: false, detail: "no decision parsed" };
  const bad = [
    ...decision.sells.filter(s => !Number.isInteger(s.quantity) || s.quantity <= 0).map(s => `sell ${s.symbol}×${s.quantity}`),
    ...decision.buys.filter(b => !Number.isInteger(b.quantity) || b.quantity <= 0).map(b => `buy ${b.symbol}×${b.quantity}`),
  ];
  return {
    name: "whole share quantities in decision",
    passed: bad.length === 0,
    detail: bad.length > 0 ? bad.join(", ") : undefined,
  };
}

/** Decision must not include buys of stocks with earnings ≤3 days away. */
export function checkDecisionNoImminentBuys(decision: TradeDecision | null, scenario: Scenario): CheckResult {
  if (!decision) return { name: "no buys into imminent earnings (decision)", passed: false, detail: "no decision parsed" };
  const today = Date.now();
  const imminent = Object.entries(scenario.earningsOverrides ?? {})
    .filter(([, date]) => { const d = (new Date(date).getTime() - today) / 86_400_000; return d >= 0 && d <= 3; })
    .map(([sym]) => sym);
  if (imminent.length === 0) return { name: "no buys into imminent earnings (decision)", passed: true, detail: "no imminent earnings" };
  const violations = decision.buys.filter(b => imminent.includes(b.symbol));
  return {
    name: "no buys into imminent earnings (decision)",
    passed: violations.length === 0,
    detail: violations.length > 0
      ? `bought into imminent earnings: ${violations.map(b => b.symbol).join(", ")}`
      : `correctly avoided: ${imminent.join(", ")}`,
  };
}

/** Decision must sell held positions whose earnings are ≤3 days away. */
export function checkDecisionSellsImminent(decision: TradeDecision | null, scenario: Scenario): CheckResult {
  if (!decision) return { name: "sells imminent earnings holdings (decision)", passed: false, detail: "no decision parsed" };
  const today = Date.now();
  const imminentHeld = scenario.positions.filter(p => {
    const date = scenario.earningsOverrides?.[p.symbol];
    if (!date) return false;
    const d = (new Date(date).getTime() - today) / 86_400_000;
    return d >= 0 && d <= 3;
  }).map(p => p.symbol);
  if (imminentHeld.length === 0) return { name: "sells imminent earnings holdings (decision)", passed: true, detail: "none held" };
  const sold = decision.sells.map(s => s.symbol);
  const notSold = imminentHeld.filter(s => !sold.includes(s));
  return {
    name: "sells imminent earnings holdings (decision)",
    passed: notSold.length === 0,
    detail: notSold.length > 0 ? `still holding ${notSold.join(", ")} with ⚠⚠ IMMINENT earnings` : `correctly exited: ${imminentHeld.join(", ")}`,
  };
}

/** Thesis text must be substantive (not empty, uses signal keywords). */
export function checkDecisionHasThesis(decision: TradeDecision | null): CheckResult {
  if (!decision) return { name: "thesis is substantive", passed: false, detail: "no decision parsed" };
  const keywords = ["momentum", "sector", "sharpe", "alpha", "earnings", "insider", "upgrade", "thesis", "rotation", "signal", "conviction"];
  const found = keywords.filter(k => decision.thesis.toLowerCase().includes(k));
  const passed = decision.thesis.length >= 50 && found.length >= 1;
  return {
    name: "thesis is substantive",
    passed,
    detail: `${decision.thesis.length}ch, keywords: ${found.join(", ") || "none"}`,
  };
}

/** Sells in the decision must only include symbols actually held. */
export function checkSellsOnlyHeld(decision: TradeDecision | null, scenario: Scenario): CheckResult {
  if (!decision) return { name: "sells only held positions", passed: false, detail: "no decision parsed" };
  const held = new Set(scenario.positions.map(p => p.symbol));
  const notHeld = decision.sells.filter(s => !held.has(s.symbol));
  return {
    name: "sells only held positions",
    passed: notHeld.length === 0,
    detail: notHeld.length > 0 ? `not held: ${notHeld.map(s => s.symbol).join(", ")}` : undefined,
  };
}

export function runAllDecisionChecks(text: string, decision: TradeDecision | null, scenario: Scenario): CheckResult[] {
  return [
    checkTradeDecisionPresent(text),
    checkT1BudgetRespected(decision, scenario),
    checkDecisionPositionCap(decision),
    checkDecisionMinPositionSize(decision),
    checkDecisionSP500Only(decision),
    checkDecisionWholeShares(decision),
    checkDecisionNoImminentBuys(decision, scenario),
    checkDecisionSellsImminent(decision, scenario),
    checkDecisionHasThesis(decision),
    checkSellsOnlyHeld(decision, scenario),
  ];
}

// ─── Full check suite (execution layer) ───────────────────────────────────────

export function runAllChecks(
  calls: ToolCall[],
  summary: string,
  scenario: Scenario
): CheckResult[] {
  return [
    checkSkipsPositionsWithPreInjection(calls),
    checkSnapshotPresent(summary),
    // checkSnapshotCashMath omitted from runAllChecks: mock tool responses don't return
    // fill prices so Claude estimates from memory, producing $15-$30 arithmetic drift.
    // Include it manually in Braintrust for trend tracking.
    checkSellsBeforeBuys(calls),
    checkSP500Only(calls),
    checkPositionCap(calls, scenario),
    checkWholeShares(calls),
    checkNoForbiddenTools(calls),
    checkBudget(calls, scenario),
    checkNoImminentEarningsBuys(calls, scenario),
    checkSellsImminent(calls, scenario),
    // checkSellsDropped excluded: only valid when the stop-loss urgent header is active (drop-check route).
    // Without the header, Claude treats dropped stocks as discretionary sells — not a hard rule.
    // Tested in the targeted "constraint: drop-check stop-loss" describe block in eval.test.ts.
    checkAnalystSignalRespected(calls, summary, scenario),
    checkHasReasoning(summary),
  ];
}
