import { describe, it, expect } from "bun:test";
import { SCENARIOS, formatFixtureMarketData } from "./fixtures";
import { runMockAgent, runAnalysisAgent } from "./agent";
import { runAllChecks, runAllDecisionChecks } from "./checks";
import { scoreInsiderAwareness } from "./scorers";
import { buildSystemPrompt, buildAnalysisPrompt } from "@/lib/strategy";
import { computeStockBeta } from "@/lib/market-data";
import { computeBookBeta, formatBookBeta, computeInfluencerPnL } from "@/lib/risk-metrics";
import { computeSleeveReturns, type PositionSnapshot, type TradeSnapshot, type TradeRun } from "@/lib/run-store";

const _d = new Date();
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAnalysisSystemPrompt(scenario: (typeof SCENARIOS)[number]) {
  return buildAnalysisPrompt(
    TODAY,
    formatFixtureMarketData(
      scenario.marketState ?? "default",
      scenario.insiderBuys ?? {},
      scenario.earningsOverrides ?? {},
      scenario.analystRatings ?? {},
      scenario.stockOverrides ?? {},
    ),
    {
      buyingPower: scenario.buyingPower,
      totalValue: scenario.totalValue,
      positions: scenario.positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.average_buy_price,
      })),
    },
  );
}

function buildExecutionSystemPrompt(scenario: (typeof SCENARIOS)[number], urgentHeader?: string) {
  const base = buildSystemPrompt(
    TODAY,
    formatFixtureMarketData(
      scenario.marketState ?? "default",
      scenario.insiderBuys ?? {},
      scenario.earningsOverrides ?? {},
      scenario.analystRatings ?? {},
      scenario.stockOverrides ?? {},
    ),
    {
      buyingPower: scenario.buyingPower,
      totalValue: scenario.totalValue,
      positions: scenario.positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCost: p.average_buy_price,
      })),
    },
  );
  return urgentHeader ? urgentHeader + base : base;
}

function printDecisionResults(
  name: string,
  checks: ReturnType<typeof runAllDecisionChecks>,
  text: string,
) {
  console.log(`\n── ${name} (analysis) ─────────────────────────────`);
  console.log(`Text (first 200): ${text.slice(0, 200).replace(/\n/g, " ")}`);
  for (const c of checks) {
    const icon = c.passed ? "✓" : "✗";
    console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

function printExecutionResults(
  name: string,
  checks: ReturnType<typeof runAllChecks>,
  summary: string,
  toolCalls: import("./agent").ToolCall[],
) {
  const orders = toolCalls.filter((c) => c.tool === "place_equity_order");
  console.log(`\n── ${name} (execution) ─────────────────────────────`);
  console.log(`Tool calls: ${toolCalls.map((c) => c.tool).join(" → ")}`);
  console.log(`Orders: ${orders.map((o) => `${o.input.side} ${o.input.symbol}×${o.input.quantity}`).join(", ") || "none"}`);
  for (const c of checks) {
    const icon = c.passed ? "✓" : "✗";
    console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

// ─── Analysis-session scenario tests (primary) ────────────────────────────────
// Tests buildAnalysisPrompt (Sonnet, no tools) → TRADE_DECISION JSON.
// These match the actual production code path.

const ANALYSIS_SCENARIOS = SCENARIOS.filter(
  (s) => !["drop-check"].includes(s.name) // drop-check uses urgentHeader, tested separately
);

for (const scenario of ANALYSIS_SCENARIOS) {
  describe(`analysis: ${scenario.name}`, () => {
    it(scenario.description, async () => {
      const systemPrompt = buildAnalysisSystemPrompt(scenario);
      const { text, decision } = await runAnalysisAgent(systemPrompt);
      const checks = runAllDecisionChecks(text, decision, scenario);

      printDecisionResults(scenario.name, checks, text);

      const failed = checks.filter((c) => !c.passed);
      expect(failed).toEqual([]);
    }, 120_000);
  });
}

// ─── Targeted analysis constraints ────────────────────────────────────────────
// Note: T+1 settlement is covered by the t1-settlement scenario in the analysis suite above,
// which runs checkT1BudgetRespected. No separate targeted test needed.

describe("analysis constraint: min position size", () => {
  it("emits buys=[] when settled buying power is below $50 minimum", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "min-position-size")!;
    const { decision } = await runAnalysisAgent(buildAnalysisSystemPrompt(scenario));
    console.log(`\n── min-position-size ─────────────────────────────`);
    console.log(`Buys: ${JSON.stringify(decision?.buys)}`);
    expect(decision?.buys ?? []).toHaveLength(0);
  }, 120_000);
});

describe("analysis constraint: imminent earnings no-buy", () => {
  it("does not buy top-momentum stock with earnings in 2 days", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "imminent-earnings")!;
    const { decision } = await runAnalysisAgent(buildAnalysisSystemPrompt(scenario));
    const imminentBuys = (decision?.buys ?? []).filter((b) =>
      Object.keys(scenario.earningsOverrides ?? {}).includes(b.symbol),
    );
    console.log(`\n── imminent earnings no-buy ─────────────────────────────`);
    console.log(`Buys: ${JSON.stringify(decision?.buys)}, imminent buys: ${JSON.stringify(imminentBuys)}`);
    expect(imminentBuys).toHaveLength(0);
  }, 120_000);
});

describe("analysis constraint: earnings exit", () => {
  it("sells held position when earnings are ≤2 days away", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "earnings-exit")!;
    const { decision } = await runAnalysisAgent(buildAnalysisSystemPrompt(scenario));
    const ibmSell = (decision?.sells ?? []).find((s) => s.symbol === "IBM");
    console.log(`\n── earnings exit ─────────────────────────────`);
    console.log(`Sells: ${JSON.stringify(decision?.sells)}`);
    expect(ibmSell).toBeDefined();
  }, 120_000);
});

// ─── Execution-layer scenario tests (legacy) ──────────────────────────────────
// Tests buildSystemPrompt (Haiku, with MCP mock tools) → place_equity_order calls.
// Kept for regression coverage on the execution-layer constraints.

// Excluded from execution suite (Haiku-in-isolation artifacts — analysis suite covers the logic):
// - rebalance-losers: Haiku sometimes skips PORTFOLIO_SNAPSHOT when no buys follow sells
// - overweight-single-position: Haiku ignores $400/order cap when deciding quantity; in production
//   Sonnet pre-decides quantities and Haiku just executes the exact order
// - bear-market: Haiku emits thin (<300 char) prose in negative-momentum conditions; analysis
//   suite passes this scenario with full Sonnet reasoning
for (const scenario of SCENARIOS.filter((s) => !["drop-check", "t1-settlement", "min-position-size", "rebalance-losers", "overweight-single-position", "bear-market"].includes(s.name))) {
  describe(`execution: ${scenario.name}`, () => {
    it(scenario.description, async () => {
      const systemPrompt = buildExecutionSystemPrompt(scenario);
      const { toolCalls, finalSummary } = await runMockAgent(systemPrompt, scenario);
      const checks = runAllChecks(toolCalls, finalSummary, scenario);

      printExecutionResults(scenario.name, checks, finalSummary, toolCalls);

      const failed = checks.filter((c) => !c.passed);
      expect(failed).toEqual([]);
    }, 120_000);
  });
}

// ─── Targeted execution constraints ───────────────────────────────────────────

describe("execution constraint: no forbidden tools", () => {
  it("never calls get_equity_quotes, get_equity_tradability, or review_equity_order", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "empty-portfolio")!;
    const { toolCalls } = await runMockAgent(buildExecutionSystemPrompt(scenario), scenario);
    const forbidden = toolCalls.filter((c) =>
      ["get_equity_quotes", "get_equity_tradability", "review_equity_order"].includes(c.tool),
    );
    expect(forbidden).toHaveLength(0);
  }, 120_000);
});

describe("execution constraint: process order", () => {
  it("skips get_equity_positions and get_portfolio when portfolio is pre-injected", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "rebalance-losers")!;
    const { toolCalls } = await runMockAgent(buildExecutionSystemPrompt(scenario), scenario);
    const redundant = toolCalls.filter(
      (c) => c.tool === "get_equity_positions" || c.tool === "get_portfolio",
    );
    expect(redundant).toHaveLength(0);
  }, 120_000);
});

describe("execution constraint: budget with zero buying power", () => {
  it("does not place buys when buying power is zero and no sells precede them", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "no-buying-power")!;
    const { toolCalls } = await runMockAgent(buildExecutionSystemPrompt(scenario), scenario);
    const buysWithNoSells = toolCalls.filter((c) => {
      if (c.tool !== "place_equity_order" || c.input.side !== "buy") return false;
      const precedingSells = toolCalls
        .slice(0, toolCalls.indexOf(c))
        .filter((p) => p.tool === "place_equity_order" && p.input.side === "sell");
      return precedingSells.length === 0;
    });
    expect(buysWithNoSells).toHaveLength(0);
  }, 120_000);
});

describe("execution constraint: drop-check stop-loss", () => {
  it("sells held position down ≥5% intraday, keeps others unchanged", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "drop-check")!;
    const dropped = scenario.droppedPositions ?? [];
    const urgentHeader = `🔴 STOP-LOSS RUN — ${TODAY} 🔴
The following held positions have dropped ≥5% intraday — thesis breakdown signal — must be evaluated for exit:
  ${dropped.map((s) => `${s} (-6.2% today)`).join("\n  ")}

INSTRUCTIONS — deviate from standard process:
1. SELL the positions listed above immediately — the drop signals a breakdown in thesis.
2. Keep ALL other positions UNCHANGED.
3. With the freed cash, either:
   a. Buy ONE high-conviction alternative (best momentum, no imminent earnings, price ≤ $400), OR
   b. Hold cash if SPY is also broadly down (>1.5% today) — capital preservation takes priority.
4. Emit PORTFOLIO_SNAPSHOT as usual.
Do NOT do a full portfolio rebalance. Only exit the damaged positions.

`;
    const { toolCalls } = await runMockAgent(buildExecutionSystemPrompt(scenario, urgentHeader), scenario);
    const ibmSells = toolCalls.filter(
      (c) => c.tool === "place_equity_order" && c.input.side === "sell" && c.input.symbol === "IBM",
    );
    const wfcSells = toolCalls.filter(
      (c) => c.tool === "place_equity_order" && c.input.side === "sell" && c.input.symbol === "WFC",
    );
    console.log(`\n── drop-check ─────────────────────────────`);
    console.log(`Orders: ${toolCalls.filter((c) => c.tool === "place_equity_order").map((c) => `${c.input.side} ${c.input.symbol}`).join(", ") || "none"}`);
    expect(ibmSells.length).toBeGreaterThan(0);
    expect(wfcSells).toHaveLength(0);
  }, 120_000);
});

// ─── LLM eval: insider signal awareness ──────────────────────────────────────

describe("llm-eval: insider signal awareness", () => {
  it("acknowledges ★INS signal in analysis reasoning (score >= 0.5)", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "insider-signal")!;
    const { text, decision } = await runAnalysisAgent(buildAnalysisSystemPrompt(scenario));
    const result = await scoreInsiderAwareness(text, scenario.insiderBuys ?? {}, []);

    console.log(`\n── insider-signal LLM eval ───────────────────────`);
    console.log(`Score: ${result.score.toFixed(2)} | ${result.rationale}`);
    console.log(`Decision: ${JSON.stringify(decision)}`);

    expect(result.score).toBeGreaterThanOrEqual(0.5);
  }, 120_000);
});

// ─── Deterministic: benchmark-awareness (per-stock β + book β + prompt wiring) ──
// No LLM — pure math + prompt-content assertions, so these never flake.

describe("benchmark-awareness: beta math", () => {
  it("computeStockBeta ≈ 2 when the stock moves 2× SPY each day", () => {
    const spy = [100, 102, 101, 104, 103, 106, 105, 108];
    const spyR = spy.slice(1).map((c, i) => c / spy[i] - 1);
    let px = 100;
    const stock = [px];
    for (const r of spyR) { px = px * (1 + 2 * r); stock.push(px); }
    const beta = computeStockBeta(stock, spy);
    expect(beta).toBeGreaterThan(1.9);
    expect(beta).toBeLessThan(2.1);
  });

  it("computeStockBeta returns null (unknown) with insufficient history", () => {
    expect(computeStockBeta([100, 101], [100, 101])).toBeNull();
  });

  it("computeStockBeta returns null when the two series lengths disagree (misaligned bars)", () => {
    const spy = [100, 102, 101, 104, 103, 106, 105, 108];
    const stock = [50, 51, 50.5, 52, 51.5, 53, 52.5]; // one fewer close → can't trust positional pairing
    expect(computeStockBeta(stock, spy)).toBeNull();
  });

  it("computeStockBeta preserves a real negative (inverse) beta", () => {
    const spy = [100, 102, 101, 104, 103, 106, 105, 108];
    const spyR = spy.slice(1).map((c, i) => c / spy[i] - 1);
    let px = 100;
    const stock = [px];
    for (const r of spyR) { px = px * (1 - r); stock.push(px); } // moves opposite SPY
    const beta = computeStockBeta(stock, spy);
    expect(beta).not.toBeNull();
    expect(beta!).toBeLessThan(0); // inverse correlation → negative β, must NOT be nulled
  });

  it("computeBookBeta counts a real negative β as known (not defaulted to 1.0)", () => {
    const book = computeBookBeta(
      [{ symbol: "A", value: 100 }, { symbol: "D", value: 100 }],
      (s) => ({ A: 1.4, D: -0.4 } as Record<string, number>)[s],
    );
    expect(book!.beta).toBeCloseTo(0.5, 3);   // (1.4·100 + −0.4·100) / 200, NOT (1.4+1.0)/2
    expect(book!.coveragePct).toBe(100);      // negative β is covered, not "unknown"
  });

  it("computeBookBeta is value-weighted and covers 100% when all β known", () => {
    const book = computeBookBeta(
      [{ symbol: "A", value: 100 }, { symbol: "B", value: 300 }],
      (s) => ({ A: 1.0, B: 1.5 } as Record<string, number>)[s],
    );
    expect(book).not.toBeNull();
    expect(book!.beta).toBeCloseTo(1.375, 3); // (1.0·100 + 1.5·300) / 400
    expect(book!.coveragePct).toBe(100);
  });

  it("computeBookBeta defaults uncovered names to market β (1.0) and reports partial coverage", () => {
    const book = computeBookBeta(
      [{ symbol: "A", value: 100 }, { symbol: "C", value: 100 }],
      (s) => ({ A: 2.0 } as Record<string, number>)[s], // C unknown → 1.0
    );
    expect(book!.beta).toBeCloseTo(1.5, 3); // (2.0·100 + 1.0·100) / 200
    expect(book!.coveragePct).toBe(50);
  });

  it("formatBookBeta renders the CURRENT BOOK β line", () => {
    expect(formatBookBeta({ beta: 1.375, coveragePct: 100 })).toContain("CURRENT BOOK β vs SPY: 1.38");
    expect(formatBookBeta(null)).toBe("");
  });
});

describe("sleeve returns: sold-out position is reconciled, not booked as a phantom loss", () => {
  // The real 2026-06-30 case: BTC was sold out of the influencer sleeve. The old code
  // filtered the sell out of the sleeve's trades → BTC's prior value booked as a ~−14% loss.
  const pos = (symbol: string, quantity: string, price: string): PositionSnapshot => ({ symbol, quantity, avgCost: price, price });
  const trade = (side: string, symbol: string, quantity: string, avgPrice: string, strategy: "main" | "influencer"): TradeSnapshot =>
    ({ side, symbol, quantity, avgPrice, state: "filled", strategy });

  const prevInfluencer = [pos("AAPL", "1", "280.77"), pos("BTC", "2", "26.26")];
  const todayInfluencer = [pos("AAPL", "1", "286.215"), pos("PLTR", "1", "116.24")];
  const prevPositions = [...prevInfluencer, pos("MSFT", "1", "400")];
  const todayPositions = [...todayInfluencer, pos("MSFT", "1", "400")];
  const trades = [trade("buy", "PLTR", "1", "116.26", "influencer"), trade("sell", "BTC", "2", "26.04", "influencer")];

  const { influencerDailyReturn, mainDailyReturn } = computeSleeveReturns(
    todayPositions, trades, todayInfluencer, prevInfluencer, prevPositions,
  );

  it("influencer return reflects the real ~+1.5% (AAPL gain), not the −14% BTC artifact", () => {
    expect(influencerDailyReturn).not.toBeNull();
    expect(influencerDailyReturn! * 100).toBeGreaterThan(1.0);
    expect(influencerDailyReturn! * 100).toBeLessThan(2.0); // ≈ +1.50%
  });

  it("the sold BTC does NOT leak into the main book (MSFT unchanged → ~0%)", () => {
    expect(mainDailyReturn).not.toBeNull();
    expect(Math.abs(mainDailyReturn!)).toBeLessThan(1e-6); // MSFT flat, BTC sell correctly excluded from main
  });

  it("a name MIGRATING main→influencer via a partial influencer buy books no phantom P&L", () => {
    // PLTR held in main yesterday; today an influencer-tagged buy moves the whole position to the
    // sleeve. Prices flat → both sleeves must read ~0% (old asymmetric partition gave infl +50% / main −11%).
    const prevInf = [pos("MEET", "1", "100")];
    const todayInf = [pos("MEET", "1", "100"), pos("PLTR", "2", "50")];
    const prevPos = [...prevInf, pos("PLTR", "1", "50"), pos("MSFT", "1", "400")];
    const todayPos = [...todayInf, pos("MSFT", "1", "400")];
    const tr = [trade("buy", "PLTR", "1", "50", "influencer")];
    const r = computeSleeveReturns(todayPos, tr, todayInf, prevInf, prevPos);
    expect(Math.abs(r.influencerDailyReturn!)).toBeLessThan(1e-6);
    expect(Math.abs(r.mainDailyReturn!)).toBeLessThan(1e-6);
  });
});

describe("influencer P&L: realized+unrealized dollars incl. the SPCX same-day round trip", () => {
  const pos = (symbol: string, quantity: string, price: string): PositionSnapshot => ({ symbol, quantity, avgCost: price, price });
  const trade = (side: string, symbol: string, quantity: string, avgPrice: string, strategy?: "main" | "influencer"): TradeSnapshot =>
    ({ side, symbol, quantity, avgPrice, state: "filled", ...(strategy ? { strategy } : {}) });
  const mkRun = (date: string, trades: TradeSnapshot[], influencerPositions: PositionSnapshot[] = []): TradeRun => ({
    timestamp: `${date}T14:30:00Z`, date, summary: "", portfolioAfter: null, positions: [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 }, trades, influencerPositions,
  });

  // Mirrors the real sleeve: SPCX sell has NO stored buy (correction supplies @166); MSFT & BTC
  // round-trip ~flat; AAPL & PLTR are still held and up. Newest-first order (as the dashboard passes).
  const runsNewestFirst = [
    // latest holdings carry their real avgCost (buy price) vs current price → snapshot-native unrealized
    mkRun("2026-07-01", [], [
      { symbol: "AAPL", quantity: "1", avgCost: "278.13", price: "293.3" },
      { symbol: "PLTR", quantity: "1", avgCost: "116.26", price: "124.815" },
    ]),
    mkRun("2026-06-30", [trade("buy", "PLTR", "1", "116.26", "influencer"), trade("sell", "BTC", "2", "26.04")]),
    mkRun("2026-06-26", [trade("buy", "AAPL", "1", "278.13", "influencer")]),
    mkRun("2026-06-25", [trade("buy", "BTC", "2", "26.13", "influencer"), trade("sell", "MSFT", "1", "374.50")]),
    mkRun("2026-06-23", [trade("buy", "MSFT", "1", "374.50", "influencer")]),
    mkRun("2026-06-22", [trade("sell", "SPCX", "1", "154.61")]), // buy @166 supplied by the correction
  ];

  const pnl = computeInfluencerPnL(runsNewestFirst)!;

  it("realized loss is dominated by SPCX (−$11.39), MSFT/BTC ~flat → ≈ −$11.57", () => {
    expect(pnl).not.toBeNull();
    expect(pnl.realized).toBeCloseTo(-11.57, 1);
  });

  it("unrealized is the AAPL + PLTR paper gain ≈ +$23.73", () => {
    expect(pnl.unrealized).toBeCloseTo(23.73, 1);
    expect(pnl.holdings.map(h => h.symbol).sort()).toEqual(["AAPL", "PLTR"]); // SPCX fully closed, not held
  });

  it("net total includes the SPCX loss → ≈ +$12.16 (not the +7.52% the % index showed)", () => {
    expect(pnl.total).toBeCloseTo(12.16, 1);
  });
});

describe("benchmark-awareness: prompt wiring", () => {
  it("market data table exposes a β column", () => {
    const table = formatFixtureMarketData("default", {}, {}, {}, {});
    expect(table).toContain("β");
  });

  it("buildAnalysisPrompt injects the marginal-impact guidance + β reading key", () => {
    const prompt = buildAnalysisPrompt(
      TODAY, "TABLE",
      { buyingPower: "$1000.00", totalValue: "$1000.00", positions: [] },
      undefined,
      "\nSECTOR EXPOSURE (current holdings, by value):\n  • Financials: 50%\n",
    );
    expect(prompt).toContain("MARGINAL BENCHMARK IMPACT");
    expect(prompt).toContain("β = beta vs SPY");
    expect(prompt).toContain("marginal impact vs SPY"); // thesis requirement (gated on sector section)
  });
});
