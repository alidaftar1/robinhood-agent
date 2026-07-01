import type { StockData, MarketData, InsiderBuy, AnalystRating } from "@/lib/market-data";
import { SP500_UNIVERSE } from "@/lib/strategy";
import { formatMarketDataForPrompt, momentumScore } from "@/lib/market-data";

// Controlled prices for key S&P 100 stocks.
// All prices chosen to be ≤ $400 (affordable on $1k budget) unless noted.
const BASE_PRICES: Record<string, { price: number; change1d: number; change30d: number }> = {
  // Top momentum
  IBM:  { price: 282, change1d: 0.8,  change30d: 22.5 },
  ABBV: { price: 223, change1d: 0.5,  change30d: 10.6 },
  GE:   { price: 323, change1d: 0.6,  change30d: 8.7  },
  MS:   { price: 214, change1d: 0.7,  change30d: 10.8 },
  WFC:  { price: 78,  change1d: 0.4,  change30d: 7.9  },
  MMM:  { price: 145, change1d: 0.9,  change30d: 8.6  },
  FDX:  { price: 305, change1d: 1.1,  change30d: 8.4  },
  // Mid momentum
  AAPL: { price: 304, change1d: -0.2, change30d: 3.8  },
  JPM:  { price: 285, change1d: 0.3,  change30d: 4.1  },
  BAC:  { price: 48,  change1d: 0.2,  change30d: 3.2  },
  // Weak / negative momentum
  MSFT: { price: 458, change1d: -0.1, change30d: -0.6 }, // > $400, unaffordable at 40% cap
  NVDA: { price: 208, change1d: -0.3, change30d: -2.7 },
  META: { price: 647, change1d: -0.5, change30d: -3.5 }, // > $400
  AMZN: { price: 245, change1d: -0.8, change30d: -10.4 },
  GOOGL: { price: 178, change1d: -0.9, change30d: -9.0 },
  NFLX: { price: 380, change1d: -1.2, change30d: -5.8 },
  // Bottom performers
  CHTR: { price: 310, change1d: -2.1, change30d: -14.9 },
  T:    { price: 21,  change1d: -1.5, change30d: -10.2 },
  PEP:  { price: 130, change1d: -1.0, change30d: -9.0  },
  WMT:  { price: 93,  change1d: -0.8, change30d: -8.0  },
  // Expensive (can't buy 1 share at 40% cap on $1k portfolio)
  LLY:  { price: 1162, change1d: 1.1, change30d: 22.5 },
  GS:   { price: 1052, change1d: 0.9, change30d: 12.3 },
  NOW:  { price: 900,  change1d: 1.2, change30d: 26.2 },
};

const SPY_MOCK = { change1d: 0.5, change5d: 1.5, change30d: 3.0 };

function buildMockStocks(): StockData[] {
  return SP500_UNIVERSE.map((symbol) => {
    const base = BASE_PRICES[symbol] ?? { price: 100, change1d: 0.1, change30d: 1.0 };
    const vol = 20 + Math.abs(base.change30d) * 0.5;
    const change5d = base.change30d * 0.3;
    const change14d = base.change30d * 0.6;
    return {
      symbol,
      price: base.price,
      change1d: base.change1d,
      change5d,
      change14d,
      change30d: base.change30d,
      distFrom52wHigh: -Math.abs(base.change30d) * 0.8,
      volatility30d: vol,
      sharpe5d: momentumScore(change5d, 5, vol),
      sharpe14d: momentumScore(change14d, 10, vol),
      sharpe30d: momentumScore(base.change30d, 21, vol),
      // Mock β loosely scaled off volatility (higher-vol mocks swing harder), clamped to a
      // realistic 0.6–1.6 band. Deterministic so eval runs stay stable.
      beta: Math.max(0.6, Math.min(1.6, 1 + (vol - 20) / 60)),
      earningsDate: null,
      relStrength1d: base.change1d - SPY_MOCK.change1d,
      relStrength5d: change5d - SPY_MOCK.change5d,
      relStrength14d: change14d - SPY_MOCK.change30d * 0.6,
      relStrength30d: base.change30d - SPY_MOCK.change30d,
    };
  }).sort((a, b) => (b.sharpe5d * 0.6 + b.sharpe14d * 0.4) - (a.sharpe5d * 0.6 + a.sharpe14d * 0.4));
}

export type MarketState = "default" | "bear";

export function buildMarketData(
  state: MarketState = "default",
  insiderBuys: Record<string, InsiderBuy[]> = {},
  earningsOverrides: Record<string, string> = {},
  analystRatings: Record<string, AnalystRating[]> = {},
  stockOverrides: Record<string, { change1d?: number; change5d?: number; change14d?: number; change30d?: number }> = {}
): MarketData {
  let stocks = buildMockStocks();
  if (state === "bear") {
    stocks = stocks.map((s) => ({
      ...s,
      change30d: s.change30d - 15,
      change1d: s.change1d - 1.5,
    }));
  }
  if (Object.keys(earningsOverrides).length > 0) {
    stocks = stocks.map((s) =>
      earningsOverrides[s.symbol] ? { ...s, earningsDate: earningsOverrides[s.symbol] } : s
    );
  }
  if (Object.keys(stockOverrides).length > 0) {
    stocks = stocks.map((s) => {
      const ov = stockOverrides[s.symbol];
      if (!ov) return s;
      const merged = { ...s, ...ov };
      if (ov.change5d != null) {
        merged.sharpe5d = momentumScore(ov.change5d, 5, s.volatility30d);
        merged.relStrength5d = ov.change5d - SPY_MOCK.change5d;
      }
      if (ov.change14d != null) {
        merged.sharpe14d = momentumScore(ov.change14d, 10, s.volatility30d);
        merged.relStrength14d = ov.change14d - SPY_MOCK.change30d * 0.6;
      }
      return merged;
    });
  }
  return {
    stocks,
    sectors: [],
    headlines: [
      "[Reuters] Fed holds rates steady, signals caution on cuts",
      "[Bloomberg] S&P 500 retreats as tech selloff deepens",
    ],
    fetchedAt: "2026-06-08T16:00:00.000Z",
    insiderBuys,
    analystRatings,
    spyContext: SPY_MOCK,
  };
}

export function formatFixtureMarketData(
  state: MarketState = "default",
  insiderBuys: Record<string, InsiderBuy[]> = {},
  earningsOverrides: Record<string, string> = {},
  analystRatings: Record<string, AnalystRating[]> = {},
  stockOverrides: Record<string, { change1d?: number; change5d?: number; change14d?: number; change30d?: number }> = {}
): string {
  return formatMarketDataForPrompt(buildMarketData(state, insiderBuys, earningsOverrides, analystRatings, stockOverrides));
}

export function formatCompactMarketData(
  state: MarketState = "default",
  insiderBuys: Record<string, InsiderBuy[]> = {},
  earningsOverrides: Record<string, string> = {},
  analystRatings: Record<string, AnalystRating[]> = {}
): string {
  const data = buildMarketData(state, insiderBuys, earningsOverrides, analystRatings);
  const sorted = [...data.stocks].sort((a, b) => (b.sharpe5d * 0.6 + b.sharpe14d * 0.4) - (a.sharpe5d * 0.6 + a.sharpe14d * 0.4));
  const compact = [...sorted.slice(0, 15), ...sorted.slice(-5)];
  return formatMarketDataForPrompt({ ...data, stocks: compact });
}

// Lookup price from fixture (for assertion math)
export function mockPrice(symbol: string): number {
  return BASE_PRICES[symbol]?.price ?? 100;
}

// ─── Scenario definitions ─────────────────────────────────────────────────────

export interface MockPosition {
  symbol: string;
  quantity: string;
  average_buy_price: string;
}

export interface Scenario {
  name: string;
  description: string;
  buyingPower: string;
  totalValue: string;
  positions: MockPosition[];
  marketState?: MarketState;
  insiderBuys?: Record<string, InsiderBuy[]>;
  earningsOverrides?: Record<string, string>; // symbol → YYYY-MM-DD earnings date
  analystRatings?: Record<string, AnalystRating[]>;
  stockOverrides?: Record<string, { change1d?: number; change5d?: number; change14d?: number; change30d?: number }>; // override specific stock fields
  droppedPositions?: string[]; // symbols considered severely dropped (≥5% intraday loss)
}

export const SCENARIOS: Scenario[] = [
  {
    name: "empty-portfolio",
    description: "Full cash, no positions — should build a new portfolio",
    buyingPower: "$500.00",
    totalValue: "$500.00",
    positions: [],
  },
  {
    name: "rebalance-losers",
    description: "Three positions: two laggards that should be rotated out, one strong keeper",
    buyingPower: "$50.00",
    totalValue: "$1000.00",
    positions: [
      { symbol: "AMZN", quantity: "2", average_buy_price: "260.00" }, // -10.4% momentum, down from cost
      { symbol: "CHTR", quantity: "1", average_buy_price: "350.00" }, // -14.9% momentum, down from cost
      { symbol: "IBM",  quantity: "1", average_buy_price: "250.00" }, // +22.5% momentum, up from cost
    ],
  },
  {
    name: "no-buying-power",
    description: "Portfolio fully deployed — should hold or sell to rebalance, not overspend",
    buyingPower: "$0.00",
    totalValue: "$970.00",
    positions: [
      { symbol: "IBM",  quantity: "2", average_buy_price: "265.00" }, // strong, probably keep
      { symbol: "AAPL", quantity: "1", average_buy_price: "310.00" }, // mediocre momentum
      { symbol: "AMZN", quantity: "1", average_buy_price: "260.00" }, // negative momentum
    ],
  },
  {
    name: "overweight-single-position",
    description: "One position takes up >40% of portfolio — tests whether Claude respects position cap on new buys",
    buyingPower: "$500.00",
    totalValue: "$1412.00",
    positions: [
      { symbol: "AAPL", quantity: "3", average_buy_price: "280.00" }, // 3×$304 = $912; $500 settled cash available
    ],
  },
  {
    name: "bear-market",
    description: "All stocks have negative momentum — tests conservative / cash-preservation behavior",
    buyingPower: "$500.00",
    totalValue: "$500.00",
    positions: [],
    marketState: "bear",
  },
  {
    name: "imminent-earnings",
    description: "Top-momentum stock (IBM) reports earnings in 2 days — Claude must not buy it",
    buyingPower: "$500.00",
    totalValue: "$500.00",
    positions: [],
    earningsOverrides: {
      IBM: new Date(Date.now() + 2 * 86_400_000).toISOString().split("T")[0],
    },
  },
  {
    name: "t1-settlement",
    description: "Has $200 settled buying power but also holds a weak stock worth ~$245 — cannot use same-day sell proceeds for buys",
    buyingPower: "$200.00",
    totalValue: "$900.00",
    positions: [
      { symbol: "AMZN", quantity: "1", average_buy_price: "260.00" }, // -10.4% momentum — candidate to sell
      { symbol: "IBM",  quantity: "2", average_buy_price: "250.00" }, // +22.5% momentum — keeper
    ],
  },
  {
    name: "min-position-size",
    description: "Only $45 settled buying power — below the $50 minimum, so buys should be empty",
    buyingPower: "$45.00",
    totalValue: "$1800.00",
    positions: [
      { symbol: "IBM",  quantity: "4", average_buy_price: "265.00" }, // strong momentum, keep
      { symbol: "GE",   quantity: "2", average_buy_price: "310.00" }, // decent momentum, keep
    ],
  },
  {
    name: "analyst-upgrade",
    description: "Top-momentum stock (WFC) upgraded by Goldman Sachs to Buy — Claude should acknowledge ↑GS in its reasoning",
    buyingPower: "$500.00",
    totalValue: "$980.00",
    positions: [
      { symbol: "AMZN", quantity: "1", average_buy_price: "260.00" }, // -10.4% momentum, candidate to sell
      { symbol: "WFC",  quantity: "1", average_buy_price: "70.00"  }, // +7.9% momentum + analyst upgrade
    ],
    analystRatings: {
      WFC: [{
        symbol: "WFC",
        action: "upgrade" as const,
        firm: "Goldman Sachs",
        firmShort: "GS",
        priceTarget: 105,
        prevPriceTarget: 85,
        priceWhenPosted: 78,
        pctUpside: 34.6,
        date: new Date(Date.now() - 1 * 86_400_000).toISOString().split("T")[0],
      }],
    },
  },
  {
    name: "earnings-exit",
    description: "IBM is held with earnings in 2 days — must sell before earnings and redeploy into next best alternatives",
    buyingPower: "$200.00",
    totalValue: "$964.00",
    positions: [
      { symbol: "IBM", quantity: "2", average_buy_price: "265.00" }, // ⚠⚠ IMMINENT — system prompt says exit
      { symbol: "MS",  quantity: "1", average_buy_price: "200.00" }, // strong momentum — probably keep
    ],
    earningsOverrides: {
      IBM: new Date(Date.now() + 2 * 86_400_000).toISOString().split("T")[0],
    },
  },
  {
    name: "drop-check",
    description: "IBM held position drops 6.2% intraday — should be sold, WFC kept unchanged, proceeds optionally redeployed",
    buyingPower: "$100.00",
    totalValue: "$982.00",
    positions: [
      { symbol: "IBM", quantity: "1", average_buy_price: "280.00" }, // dropped hard today
      { symbol: "WFC", quantity: "3", average_buy_price: "78.00"  }, // fine, keep unchanged
    ],
    stockOverrides: {
      IBM: { change1d: -6.2 },
    },
    droppedPositions: ["IBM"],
  },
  {
    name: "insider-signal",
    description: "Top-momentum stock (IBM) has CEO insider buying — Claude should acknowledge and weight ★INS in its reasoning",
    buyingPower: "$550.00",
    totalValue: "$1030.00",
    positions: [
      { symbol: "AMZN", quantity: "1", average_buy_price: "260.00" }, // -10.4% momentum, candidate to sell
      { symbol: "IBM",  quantity: "1", average_buy_price: "250.00" }, // +22.5% momentum + insider buy
    ],
    insiderBuys: {
      IBM: [{
        ownerName: "Arvind Krishna",
        ownerTitle: "Chief Executive Officer",
        shares: 1000,
        pricePerShare: 270.00,
        totalValue: 270_000,
        filingDate: "2026-06-05",
      }],
    },
  },
];
