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

const TODAY_ISO = "2026-09-14";
const realFetch = globalThis.fetch;
// SPY is CONFIGURABLE. The original stub was flat, which made excess === forward and silently hid
// an exit-direction inversion through a full review cycle — a flat benchmark cannot distinguish
// "judged on excess" from "judged on absolute". `spyMode` lets each test pick.
let spyMode: "flat" | "crash" | "rally" | "down" = "flat";
globalThis.fetch = (async (url: any) => {
  if (String(url).includes("/SPY?")) {
    const days = 40;
    const t0 = Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000);
    const ts = Array.from({ length: days }, (_, i) => t0 + i * 86400);
    // A STEP at TODAY, not a ramp: observations are dated before TODAY, so a step makes each
    // observation's own window return exactly `rate` regardless of how long the series is. An
    // earlier version ramped linearly across the whole span, so a 13-day window saw only a third of
    // the intended move and the assertions were calibrated against the wrong number.
    const rate = spyMode === "crash" ? -0.30 : spyMode === "rally" ? 0.30 : spyMode === "down" ? -0.05 : 0;
    const todayTs = Math.floor(Date.parse(TODAY_ISO + "T00:00:00Z") / 1000);
    const closeFor = (i: number) => (ts[i] >= todayTs ? 500 * (1 + rate) : 500);
    return new Response(JSON.stringify({
      chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => closeFor(i)) }] } }] },
    }), { status: 200 });
  }
  if (spyMode === "flat") return new Response("{}", { status: 404 });
  return new Response("{}", { status: 404 });
}) as any;
afterAll(() => { globalThis.fetch = realFetch; });

const { scoreShadowObservations } = await import("../lib/shadow-scoring");
const TODAY = TODAY_ISO;
const obs = (symbol: string, price = 100, date = "2026-09-01") => // 13d before TODAY → matured
 ({ symbol, price, date });

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

// ── The finding the flat-SPY stub could not see (review, 2026-09-14) ──────────────────────────
describe("exit is judged ABSOLUTELY — a stop sells to cash, and cash does not track SPY", () => {
  test("a stopped name that fell while SPY fell HARDER is still a correct exit", async () => {
    spyMode = "crash"; // SPY −20%; DOWN is −10% → excess strongly POSITIVE
    const { scored, stats } = await scoreShadowObservations([obs("DOWN")], TODAY, "exit");
    expect(scored[0].excessReturnPct!).toBeGreaterThan(0); // excess says "beat the market"
    expect(scored[0].correct).toBe(true);                   // ...but selling still avoided a real loss
    expect(stats.hitRatePct).toBe(100);
    spyMode = "flat";
  });

  test("a stop that sold right before a rise is wrong even if that rise lagged SPY", async () => {
    spyMode = "rally"; // SPY +20%; UP is +10% → excess NEGATIVE
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "exit");
    expect(scored[0].excessReturnPct!).toBeLessThan(0); // excess says "lagged the market"
    expect(scored[0].correct).toBe(false);               // ...but the name rose, so the sell was a whipsaw
    spyMode = "flat";
  });

  test("ENTRY still uses excess — it is a relative choice against the market", async () => {
    spyMode = "rally"; // SPY +20%; UP is +10% → underperformed
    const { scored } = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    expect(scored[0].forwardReturnPct!).toBeGreaterThan(0); // rose in absolute terms
    expect(scored[0].correct).toBe(false);                  // ...but lost to just holding SPY
    spyMode = "flat";
  });
});

describe("benchmark failure is never dressed up as zero alpha", () => {
  test("a failed SPY fetch nulls the benchmark averages and drops the vs-SPY claim", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as any;
    const { stats } = await scoreShadowObservations([obs("UP")], TODAY, "entry");
    globalThis.fetch = saved;
    expect(stats.avgSpyReturnPct).toBeNull();
    expect(stats.avgExcessReturnPct).toBeNull();
    expect(stats.benchmarked).toBe(0);
    expect(stats.verdict).toContain("SPY benchmark unavailable");
    expect(stats.verdict).not.toMatch(/\+0\.0% vs SPY/);
  });
});

describe("one vote per name, and only matured rows vote", () => {
  test("a name recurring across days counts ONCE in the headline", async () => {
    const { stats } = await scoreShadowObservations(
      [obs("UP", 100, "2026-09-01"), obs("UP", 100, "2026-09-02"), obs("UP", 100, "2026-09-03"), obs("DOWN", 100, "2026-09-01")],
      TODAY, "entry",
    );
    expect(stats.observations).toBe(4);
    expect(stats.symbolsScored).toBe(2);   // not 4
    expect(stats.hitRatePct).toBe(50);     // 1 of 2 names, not 3 of 4 rows
  });

  test("rows with no forward window yet do not vote", async () => {
    const { stats } = await scoreShadowObservations([obs("UP", 100, TODAY)], TODAY, "entry");
    expect(stats.measurable).toBe(1);
    expect(stats.matured).toBe(0);
    expect(stats.verdict).toMatch(/no .*forward window yet|nothing to measure/i);
  });
});
