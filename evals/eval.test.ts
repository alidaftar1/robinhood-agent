import { describe, it, expect } from "bun:test";
import { SCENARIOS, formatFixtureMarketData } from "./fixtures";
import { runMockAgent, runAnalysisAgent } from "./agent";
import { runAllChecks, runAllDecisionChecks } from "./checks";
import { scoreInsiderAwareness } from "./scorers";
import { buildSystemPrompt, buildAnalysisPrompt } from "@/lib/strategy";
import { computeStockBeta } from "@/lib/market-data";
import { computeBookBeta, formatBookBeta, computeBenchmarkVerdict } from "@/lib/risk-metrics";
import { computeSleeveReturns, type PositionSnapshot, type TradeSnapshot, type TradeRun } from "@/lib/run-store";
import { reconcileDashboard } from "@/lib/dashboard-reconcile";
import { fitBuysToBudget } from "@/lib/buy-sizing";

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

  it("fitBuysToBudget fits the priciest-per-share buy first so a cheap buy can't strand an expensive whole-share buy (TSLA-07-06)", () => {
    // The 07-06 squeeze: the model emitted the CHEAP buy FIRST — DXC×6 @ $10 then TSLA×1 @ $405,
    // ~$467 settled buying power. Order-preserving (the old bug) let DXC eat the budget and DROP
    // the whole-share TSLA (→ ~$405 idle). Cheap-first input here so this test FAILS unless the
    // per-share-descending sort actually runs.
    const { sized, adjustments } = fitBuysToBudget(
      [{ symbol: "DXC", quantity: 6, price: 10 }, { symbol: "TSLA", quantity: 1, price: 405.22 }],
      467.6,
    );
    const bySym = Object.fromEntries(sized.map(b => [b.symbol, b.quantity]));
    expect(bySym.TSLA).toBe(1);                       // the expensive whole-share is kept, not stranded
    expect(bySym.DXC ?? 0).toBeLessThan(6);           // the cheap marginal buy absorbs the shrink
    expect(adjustments.some(a => a.includes("DXC"))).toBe(true);
    expect(adjustments.some(a => a.includes("TSLA"))).toBe(false); // TSLA untouched → no strand
    // Deploys nearly all buying power (budget after 3% buffer), not ~$405 idle.
    const spent = sized.reduce((s, b) => s + b.quantity * b.price * 1.02, 0);
    expect(spent).toBeGreaterThan(467.6 * 0.9);
  });

  it("fitBuysToBudget prioritizes by PER-SHARE price, not total value, so a shrinkable multi-share buy can't starve a whole-share buy", () => {
    // ~$600 BP: AAPL 5@$100 (total $500) vs TSLA 1@$405 (total $405). Sorting by TOTAL value would
    // fund AAPL first and DROP the whole-share TSLA; per-share ordering keeps the indivisible TSLA
    // and shrinks the divisible AAPL. This is the case that distinguishes the two sort keys.
    const { sized } = fitBuysToBudget(
      [{ symbol: "AAPL", quantity: 5, price: 100 }, { symbol: "TSLA", quantity: 1, price: 405.22 }],
      600,
    );
    const bySym = Object.fromEntries(sized.map(b => [b.symbol, b.quantity]));
    expect(bySym.TSLA).toBe(1);              // whole-share protected
    expect(bySym.AAPL ?? 0).toBeLessThan(5); // the shrinkable buy yields instead
  });

  it("buildAnalysisPrompt runs a concentrated book (4–6 total names, conviction in size)", () => {
    const pf = { buyingPower: "$100", totalValue: "$1000", positions: [] } as any;
    const prompt = buildAnalysisPrompt("2026-07-06", "", pf, "", "");
    expect(prompt).toContain("CONCENTRATION");
    expect(prompt).toContain("4–6");
    expect(prompt).not.toContain("RISK-ON");   // regime overlay reverted — no regime block
    expect(prompt).not.toContain("RISK-OFF");
  });

  it("fitBuysToBudget drops a whole-share buy that truly can't fit and records a non-silent note", () => {
    // Only $300 buying power; TSLA's 1 whole share (~$413 cushioned) genuinely can't fit → it is
    // DROPPED (can't shrink below 1 share) but the drop is recorded so it's never silent.
    const { sized, adjustments } = fitBuysToBudget([{ symbol: "TSLA", quantity: 1, price: 405.22 }], 300);
    expect(sized.find(b => b.symbol === "TSLA")).toBeUndefined();
    expect(adjustments.some(a => a.includes("TSLA") && a.includes("DROPPED"))).toBe(true);
  });

  it("dashboard 'Swings vs. Market' reads the CURRENT run's stored book β (holdings-based, aligned with the holdings shown beside it)", () => {
    // The card uses `current?.bookBeta ?? null` — the same run that drives the card's cash/sector
    // stats — so β always matches the displayed holdings and never falls back to a stale older day.
    const pick = (current: { bookBeta?: { beta: number; coveragePct: number } | null } | null) =>
      current?.bookBeta ?? null;
    expect(pick({ bookBeta: { beta: 0.74, coveragePct: 90 } })!.beta).toBe(0.74);
    expect(pick({ bookBeta: null })).toBeNull();  // current predates the field → "—", not a stale day's β
    expect(pick(null)).toBeNull();                // no current run yet → "—"
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

describe("benchmark verdict: is the active book beating buy-and-hold SPY", () => {
  // agenticDailyReturn mirrors main here so the SPY baseline (keyed off first agentic return,
  // matching the dashboard) lands on the same run as the first main return.
  const mkRun = (date: string, mainDailyReturn: number | null, spyPrice: number): TradeRun => ({
    timestamp: `${date}T14:30:00Z`, date, summary: "", portfolioAfter: null, positions: [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 }, spyPrice, mainDailyReturn,
    agenticDailyReturn: mainDailyReturn,
  });
  // Helper builds runs oldest→newest then reverses to newest-first (as the dashboard passes).
  const newestFirst = (runs: TradeRun[]) => [...runs].reverse();

  it("reports beating when the book outruns SPY", () => {
    const v = computeBenchmarkVerdict(newestFirst([
      mkRun("2026-06-15", null, 100),   // baseline (no main return yet)
      mkRun("2026-06-16", 0.02, 100.5),
      mkRun("2026-06-17", 0.01, 101.0),
    ]))!;
    expect(v.alpha).toBeGreaterThan(0);
    expect(v.daysTrailing).toBe(0); // ahead → no trailing flag on the card
    expect(v.sustained).toBe(false);
  });

  it("flags SUSTAINED underperformance after ≥10 straight trailing days", () => {
    const runs: TradeRun[] = [mkRun("2026-06-01", null, 100)];
    for (let i = 1; i <= 12; i++) {
      // main loses a touch daily while SPY climbs → cumulative alpha negative every day
      runs.push(mkRun(`2026-06-${String(i + 1).padStart(2, "0")}`, -0.001, 100 + i * 0.3));
    }
    const v = computeBenchmarkVerdict(newestFirst(runs))!;
    expect(v.alpha).toBeLessThan(0);
    expect(v.daysTrailing).toBeGreaterThanOrEqual(10);
    expect(v.sustained).toBe(true); // ⚠ flag fires
  });

  it("calls a short trailing streak normal noise, not sustained", () => {
    const v = computeBenchmarkVerdict(newestFirst([
      mkRun("2026-06-15", null, 100),
      mkRun("2026-06-16", -0.002, 100.5),
      mkRun("2026-06-17", -0.001, 101.0),
    ]))!;
    expect(v.alpha).toBeLessThan(0);
    expect(v.daysTrailing).toBeGreaterThan(0); // trailing, but short → muted flag, not the ⚠
    expect(v.sustained).toBe(false);
  });
});

describe("dashboard reconciliation: deterministic audit of derived numbers", () => {
  const rpos = (symbol: string, qty: string, price: string): PositionSnapshot => ({ symbol, quantity: qty, avgCost: price, price });
  const rRun = (date: string, o: {
    positions?: PositionSnapshot[]; infl?: PositionSnapshot[]; trades?: TradeSnapshot[]; total?: string;
    spy?: number; agentic?: number | null; main?: number | null; infR?: number | null;
  }): TradeRun => ({
    timestamp: `${date}T14:30:00Z`, date, summary: "",
    portfolioAfter: { totalValue: o.total ?? "1000", cash: "0", equity: o.total ?? "1000" },
    positions: o.positions ?? [], influencerPositions: o.infl ?? [], trades: o.trades ?? [],
    market: { stocksLoaded: 0, headlinesLoaded: 0 }, spyPrice: o.spy ?? 100,
    agenticDailyReturn: o.agentic ?? null, mainDailyReturn: o.main ?? null, influencerDailyReturn: o.infR ?? null,
  });
  const titles = (rs: TradeRun[]) => reconcileDashboard(rs).map(f => f.title);

  it("flags the influencer-slot squat (sleeve 2/2 with S&P names) — the AAPL case", () => {
    const t = titles([rRun("2026-07-02", {
      infl: [rpos("AAPL", "1", "110"), rpos("PLTR", "1", "110")],
      positions: [rpos("AAPL", "1", "110"), rpos("PLTR", "1", "110")], agentic: 0.01,
    })]);
    expect(t.some(x => x.includes("at capacity"))).toBe(true);
  });

  it("flags an influencer position not actually held (stale sleeve membership)", () => {
    const t = titles([rRun("2026-07-02", {
      infl: [rpos("ZZZZ", "1", "10")], positions: [rpos("MSFT", "1", "100")], agentic: 0.01,
    })]);
    expect(t.some(x => x.includes("not in the account"))).toBe(true);
  });

  it("stays quiet on a clean sleeve (held names, no squat, no orphan)", () => {
    const t = titles([rRun("2026-07-02", {
      infl: [rpos("AAPL", "1", "110")], // 1 slot used → no squat; AAPL is held → no orphan
      positions: [rpos("AAPL", "1", "110"), rpos("MSFT", "1", "100")], agentic: 0.01,
    })]);
    expect(t).toEqual([]);
  });
});

describe("time-stop: staleness rule wiring in the buy prompt", () => {
  const build = (positions: PortfolioContextPositions) => buildAnalysisPrompt(
    TODAY, "TABLE",
    { buyingPower: "$1000.00", totalValue: "$5000.00", positions },
    undefined, "\nSECTOR EXPOSURE...\n",
  );
  type PortfolioContextPositions = { symbol: string; quantity: string; avgCost: string; heldDays?: number; price?: number }[];

  it("shows holding age + return and injects the TIME-STOP rule when heldDays is present", () => {
    const prompt = build([{ symbol: "MKC", quantity: "2", avgCost: "50.00", heldDays: 20, price: 50.5 }]);
    expect(prompt).toContain("held 20d");
    expect(prompt).toContain("+1.0% since entry");
    expect(prompt).toContain("TIME-STOP");
  });

  it("omits the TIME-STOP rule when positions carry no holding age (fallback path)", () => {
    const prompt = build([{ symbol: "MKC", quantity: "2", avgCost: "50.00" }]);
    expect(prompt).not.toContain("TIME-STOP");
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
