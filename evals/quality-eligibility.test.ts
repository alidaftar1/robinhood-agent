import { describe, test, expect } from "bun:test";
import { buildV1Shortlist, type StockData } from "@/lib/market-data";

// THE DISTINCTION THIS FILE EXISTS FOR: "measured and failed" vs "could not be measured".
//
// `QualityScore.eligible` is a boolean with no unknown state, so both were previously conflated. A
// HELD name absent from the shortlist reads as "fell off the shortlist" — which lib/sell-rail
// accepts as a code-verifiable reason to exit, and which lib/strategy names as valid sell reason (a).
// So a gap in SEC's data could authorise a liquidation. An unmeasurable name must be UNBUYABLE but
// never a sell signal.

const stock = (symbol: string, mom: number): StockData => ({
  symbol, price: 100, change1d: 0, change5d: 0, change14d: 0, change30d: 0,
  distFrom52wHigh: -10, volatility30d: 25, sharpe5d: 1, sharpe14d: 1, sharpe30d: 1,
  mom12_1: mom, beta: 1, earningsDate: null,
  relStrength1d: 0, relStrength5d: 0, relStrength14d: 0, relStrength30d: 0,
} as StockData);

// AAPL/MSFT/NVDA = XLK, JPM = XLF, KO = XLP, DUK = XLU.
const stocks = [stock("AAPL", 40), stock("MSFT", 35), stock("NVDA", 30), stock("JPM", 25), stock("KO", 20), stock("DUK", 15)];

describe("a quality-UNKNOWN held name is retained, never treated as fallen off", () => {
  test("it appears in retained and NOT in buy", () => {
    // MSFT measured-unknown (SEC data gap), and currently held.
    const { buy, retained } = buildV1Shortlist(stocks, new Set(["AAPL", "NVDA", "JPM", "KO", "DUK"]), {
      held: new Set(["MSFT"]),
      qualityUnknown: new Set(["MSFT"]),
    });
    expect(buy.map(s => s.symbol)).not.toContain("MSFT");     // can never be BOUGHT on absent quality
    expect(retained.map(s => s.symbol)).toContain("MSFT");    // but is NOT "off the shortlist"
  });

  test("WITHOUT the unknown set it vanishes — the sell-authorising behaviour being fixed", () => {
    const { buy, retained } = buildV1Shortlist(stocks, new Set(["AAPL", "NVDA", "JPM", "KO", "DUK"]), {
      held: new Set(["MSFT"]),
    });
    expect(buy.map(s => s.symbol)).not.toContain("MSFT");
    expect(retained.map(s => s.symbol)).not.toContain("MSFT");   // → reads as "fell off the shortlist"
  });

  test("an unknown name that is NOT held is simply absent — no phantom candidate", () => {
    const { buy, retained } = buildV1Shortlist(stocks, new Set(["AAPL", "NVDA"]), {
      held: new Set<string>(),
      qualityUnknown: new Set(["MSFT"]),
    });
    expect([...buy, ...retained].map(s => s.symbol)).not.toContain("MSFT");
  });

  test("a name that was MEASURED and FAILED still drops out — the distinction is preserved", () => {
    // KO is held, measured, and NOT eligible. It must NOT be rescued: it genuinely lost eligibility,
    // and the sell trigger is legitimate. Rescuing it would defeat the quality gate entirely.
    const { retained } = buildV1Shortlist(stocks, new Set(["AAPL", "NVDA", "JPM", "DUK"]), {
      held: new Set(["KO"]),
      qualityUnknown: new Set(["MSFT"]),
    });
    expect(retained.map(s => s.symbol)).not.toContain("KO");
  });

  test("an unknown held name with NEGATIVE momentum is not retained either", () => {
    // Retention still requires positive 12-1 momentum; unknown quality is not a blanket exemption.
    const withNeg = [...stocks, stock("XOM", -5)];
    const { retained } = buildV1Shortlist(withNeg, new Set(["AAPL"]), {
      held: new Set(["XOM"]),
      qualityUnknown: new Set(["XOM"]),
    });
    expect(retained.map(s => s.symbol)).not.toContain("XOM");
  });

  test("retained stays sorted by momentum, and buy is unaffected by the unknown set", () => {
    const eligible = new Set(["AAPL", "NVDA", "JPM", "KO", "DUK"]);
    const a = buildV1Shortlist(stocks, eligible, { held: new Set(["AAPL", "NVDA"]) });
    const b = buildV1Shortlist(stocks, eligible, { held: new Set(["AAPL", "NVDA"]), qualityUnknown: new Set(["MSFT"]) });
    expect(b.buy.map(s => s.symbol)).toEqual(a.buy.map(s => s.symbol));
    const moms = b.retained.map(s => s.mom12_1 as number);
    expect([...moms].sort((x, y) => y - x)).toEqual(moms);
  });
});
