import { describe, expect, test, mock, afterAll } from "bun:test";

// Stub the network before importing the module under test: fetchQuoteLite (per-symbol quotes) and
// the raw SPY chart fetch both go out over the wire, and the scorer must be testable without either.
const PRICES: Record<string, number> = { UP: 110, DOWN: 90, FLAT: 100, DEAD: NaN };
// `mock.module` is GLOBAL and persists across tests in bun, so there is exactly ONE stub here and
// the call counter is reset by whichever test needs it — re-mocking per test leaks into later ones.
const quoteCalls = { n: 0 };
mock.module("../lib/market-data", () => ({
  fetchQuoteLite: async (symbol: string) => {
    quoteCalls.n++;
    const p = PRICES[symbol];
    return p != null && Number.isFinite(p) ? { price: p, change1d: 0 } : null;
  },
}));

const realFetch = globalThis.fetch;
// SPY flat at 500 on every day → spyReturnPct = 0, so excess == forward and the direction
// assertions below isolate the sign convention rather than the benchmark arithmetic.
globalThis.fetch = (async (url: any) => {
  if (String(url).includes("/SPY?")) {
    const days = 40;
    const ts = Array.from({ length: days }, (_, i) => Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000) + i * 86400);
    return new Response(JSON.stringify({
      chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map(() => 500) }] } }] },
    }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as any;
afterAll(() => { globalThis.fetch = realFetch; });

const { scoreShadowObservations } = await import("../lib/shadow-scoring");
const TODAY = "2026-09-14";
const obs = (symbol: string, price = 100, date = "2026-09-01") => ({ symbol, price, date });

describe("forward return + benchmark", () => {
  test("computes forward return from the stored capture price", async () => {
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    expect(scored[0].forwardReturnPct).toBeCloseTo(10, 5);
    expect(scored[0].daysElapsed).toBe(13);
  });

  test("subtracts SPY over the observation's own window", async () => {
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    expect(scored[0].spyReturnPct).toBeCloseTo(0, 5);   // flat SPY in the stub
    expect(scored[0].excessReturnPct).toBeCloseTo(10, 5);
  });

  test("one quote per DISTINCT symbol — repeats across days cost nothing extra", async () => {
    quoteCalls.n = 0;
    await scoreShadowObservations(
      [obs("UP", 100, "2026-09-01"), obs("UP", 105, "2026-09-02"), obs("UP", 108, "2026-09-03")],
      TODAY, "entry",
    );
    expect(quoteCalls.n).toBe(1);
  });
});

// The whole reason `direction` is a required argument: the same forward return is a win for an
// entry signal and a whipsaw for an exit signal.
describe("direction inversion", () => {
  test("ENTRY: a name that rose was called correctly", async () => {
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    expect(scored[0].correct).toBe(true);
  });

  test("ENTRY: a name that fell was called wrong", async () => {
    const { scored } = await scoreShadowObservations([obs("DOWN")], TODAY, "entry");
    expect(scored[0].correct).toBe(false);
  });

  test("EXIT: a name that kept falling was called correctly — selling avoided the loss", async () => {
    const { scored } = await scoreShadowObservations([obs("DOWN")], TODAY, "exit");
    expect(scored[0].correct).toBe(true);
  });

  test("EXIT: a name that bounced was a whipsaw", async () => {
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "exit");
    expect(scored[0].correct).toBe(false);
  });

  test("the SAME observation scores oppositely under the two directions", async () => {
    const entry = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    const exit = await scoreShadowObservations([obs("UP")], TODAY, "exit");
    expect(entry.stats.hitRatePct).toBe(100);
    expect(exit.stats.hitRatePct).toBe(0);
  });
});

describe("honest denominators", () => {
  test("reports distinct symbols alongside raw observations", async () => {
    const { stats } = await scoreShadowObservations(
      [obs("UP", 100, "2026-09-01"), obs("UP", 101, "2026-09-02"), obs("DOWN", 100, "2026-09-03")],
      TODAY, "entry",
    );
    expect(stats.observations).toBe(3);
    expect(stats.distinctSymbols).toBe(2);
  });

  test("an unquotable symbol is excluded, never counted as a 0% return", async () => {
    const { stats } = await scoreShadowObservations([obs("UP"), obs("DEAD")], TODAY, "entry");
    expect(stats.observations).toBe(2);
    expect(stats.measurable).toBe(1);
    expect(stats.avgForwardReturnPct).toBeCloseTo(10, 5); // not diluted toward 5 by the dead row
  });

  test("empty capture returns a stated-empty result, not a fake zero", async () => {
    const { stats } = await scoreShadowObservations([], TODAY, "entry");
    expect(stats.measurable).toBe(0);
    expect(stats.verdict).toMatch(/no measurable observations/i);
  });
});

describe("verdict refuses to overclaim", () => {
  test("a thin, correlated sample is labelled TOO EARLY and says not to act", async () => {
    const { stats } = await scoreShadowObservations(
      Array.from({ length: 30 }, (_, i) => obs("UP", 100, `2026-09-${String((i % 9) + 1).padStart(2, "0")}`)),
      TODAY, "entry",
    );
    expect(stats.observations).toBe(30);
    expect(stats.distinctSymbols).toBe(1);
    expect(stats.verdict).toContain("TOO EARLY");
    expect(stats.verdict).toMatch(/do not act on it/i);
  });

  test("the verdict names the action matching the direction", async () => {
    const entry = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    const exit = await scoreShadowObservations([obs("UP")], TODAY, "exit");
    expect(entry.stats.verdict).toContain("buying these");
    expect(exit.stats.verdict).toContain("selling these");
  });
});
