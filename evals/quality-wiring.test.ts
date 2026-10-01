import { describe, test, expect, afterEach } from "bun:test";
import { fetchQualityFromSEC, getQualityScores } from "@/lib/quality";

// WIRING tests, by stubbing global fetch.
//
// Review 5 mutation-swept the suite and found 20 survivors, ALL network-bound — including
// `if (!shouldCache(data))` → `if (false)` and, literally, re-adding `{notFoundOk: true}` to the
// tickers fetch, which IS the H-1 regression. Testing a predicate does not prove it is consulted, and
// every guard that shipped broken this week lived in code no test could reach. These close that.
//
// H-1 recap, because it is what this file exists to prevent: secGet returned the 404 sentinel
// unconditionally, so a 404 on company_tickers.json produced an empty CIK map (Object.keys(Symbol())
// is [], not a throw), every name withheld, `degraded` still false, and that empty result CACHED for
// 8 days — during which the trade route tripped its shortlist floor and returned early every run,
// stopping buys AND sells.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** ~1,100 plausible filers, enough to clear MIN_TICKER_MAP. */
const tickerMap = () => Object.fromEntries(
  Array.from({ length: 1100 }, (_, i) => [String(i), { ticker: i === 0 ? "AAPL" : `T${i}`, cik_str: i + 1 }]),
);

/**
 * A frame whose period DATES match the period being requested. The first version of this helper
 * returned 2025-annual dates for every URL including quarters, so `combineTtm`'s contiguity guard
 * correctly rejected every name and the whole thing threw — my fixture was wrong, not the code. Worth
 * recording: a stub that does not respect the invariant under test will fail for the wrong reason.
 */
function frameFor(url: string, n = 600, val = 1_000_000_000) {
  const m = url.match(/\/USD\/CY(\d{4})(Q[1-4])?(I)?\.json/);
  const year = m ? Number(m[1]) : 2025;
  const q = m?.[2];
  let start: string, end: string;
  if (!q) { start = `${year}-01-01`; end = `${year}-12-31`; }                 // annual duration
  else {
    const qi = Number(q[1]);
    start = `${year}-${String((qi - 1) * 3 + 1).padStart(2, "0")}-01`;
    end = [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`][qi - 1];
  }
  return {
    data: Array.from({ length: n }, (_, i) => ({ cik: i + 1, val, start, end })),
  };
}

function stub(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: any) => handler(String(input))) as typeof fetch;
}

describe("a 404 on the ticker map must NOT produce a cacheable empty result", () => {
  test("fetchQualityFromSEC THROWS rather than scoring nobody", async () => {
    // This is the exact H-1 scenario: tickers 404, every other SEC call perfectly healthy.
    stub((url) => {
      if (url.includes("company_tickers.json")) return new Response("not found", { status: 404 });
      return json(frameFor(url));
    });
    // Must reject. If the 404 sentinel is ever re-applied to this call site, it resolves instead —
    // with scores:{} — which is what shipped and would have halted trading for 8 days.
    await expect(fetchQualityFromSEC()).rejects.toThrow();
  });

  test("getQualityScores turns that into null, which the route alerts on and trades through", async () => {
    // Direction check: null means "no quality filter + alert + keep trading momentum-only", which is
    // loud and recoverable. A cached empty result was silent and stopped sells for a week.
    stub((url) => {
      if (url.includes("company_tickers.json")) return new Response("not found", { status: 404 });
      return json(frameFor(url));
    });
    expect(await getQualityScores(true)).toBeNull();
  });

  test("an implausibly SMALL ticker map is refused too, not just a 404", async () => {
    stub((url) => {
      if (url.includes("company_tickers.json")) return json({ 0: { ticker: "AAPL", cik_str: 320193 } });
      return json(frameFor(url));
    });
    await expect(fetchQualityFromSEC()).rejects.toThrow(/implausibly small/);
  });

  test("a ticker map whose FIELDS changed shape is refused rather than silently emptied", async () => {
    // cik_str as a string instead of a number would drop every entry.
    stub((url) => {
      if (url.includes("company_tickers.json")) {
        return json(Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [String(i), { ticker: `T${i}`, cik_str: String(i + 1) }])));
      }
      return json(frameFor(url));
    });
    await expect(fetchQualityFromSEC()).rejects.toThrow(/implausibly small/);
  });
});

describe("the healthy path is reached and is cacheable", () => {
  test("a well-formed universe produces scores and degrades nothing", async () => {
    // Proves the throwing tests above fail for the RIGHT reason — this stub differs only in the
    // tickers response, so a blanket failure would show up here as well.
    stub((url) => {
      if (url.includes("company_tickers.json")) return json(tickerMap());
      if (url.includes("companyconcept")) return json({ units: { USD: [] } });
      return json(frameFor(url));
    });
    const d = await fetchQualityFromSEC();
    expect(Object.keys(d.scores).length).toBeGreaterThan(0);
    expect(d.degraded).toBe(false);
  });

  test("a FAILING quarter fetch marks the result degraded — so it will not be cached", async () => {
    // Pins that the degraded wiring is CONSULTED, not merely present: a 503 on one quarter frame must
    // survive into the returned object. Chosen over failing the instants, because a total instant
    // failure legitimately throws instead (loud -> null -> alert -> trades momentum-only).
    stub((url) => {
      if (url.includes("company_tickers.json")) return json(tickerMap());
      if (url.includes("companyconcept")) return json({ units: { USD: [] } });
      if (url.includes("/NetIncomeLoss/USD/CY2026Q1.json")) return new Response("boom", { status: 503 });
      return json(frameFor(url));
    });
    const d = await fetchQualityFromSEC();
    expect(d.degraded).toBe(true);
    expect(Object.keys(d.scores).length).toBeGreaterThan(0);   // still a usable result, just uncacheable
  });
});

// ── Is the cache-write guard actually CONSULTED? ─────────────────────────────────────────────────
// Review 5: `if (!shouldCache(data))` → `if (false)` SURVIVED the suite. The predicate was tested; the
// branch that uses it was not. Pinning a guard's logic without pinning its call site is how the
// inert-M-1 fix shipped — it moved a throw into a return value the caller discarded.
//
// These observe the Redis write directly by stubbing fetch for the Upstash endpoint too.
describe("a degraded result is never WRITTEN to the cache", () => {
  const realEnv = { url: process.env.UPSTASH_REDIS_REST_URL, tok: process.env.UPSTASH_REDIS_REST_TOKEN };
  afterEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = realEnv.url;
    process.env.UPSTASH_REDIS_REST_TOKEN = realEnv.tok;
  });

  /** Runs getQualityScores against stubbed SEC + Upstash, returning every Upstash body seen. */
  async function withCapture(secHandler: (url: string) => Response) {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub-upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    const writes: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("stub-upstash.invalid")) {
        if (init?.body) writes.push(String(init.body));
        return json({ result: null });               // GET miss / SET ack
      }
      return secHandler(url);
    }) as typeof fetch;
    const data = await getQualityScores(true);
    return { data, writes };
  }

  const healthy = (url: string) => {
    if (url.includes("company_tickers.json")) return json(tickerMap());
    if (url.includes("companyconcept")) return json({ units: { USD: [] } });
    return json(frameFor(url));
  };

  test("a HEALTHY result IS written — so the negative test below means something", async () => {
    const { data, writes } = await withCapture(healthy);
    expect(data).not.toBeNull();
    expect(data!.degraded).toBe(false);
    expect(writes.some(w => w.includes("quality:scores:"))).toBe(true);
  });

  test("a DEGRADED result is NOT written", async () => {
    const { data, writes } = await withCapture((url) => {
      if (url.includes("/NetIncomeLoss/USD/CY2026Q1.json")) return new Response("boom", { status: 503 });
      return healthy(url);
    });
    expect(data!.degraded).toBe(true);
    // The whole point: no SET reaches Redis. Bypassing the guard makes this fail.
    expect(writes.some(w => w.includes("quality:scores:"))).toBe(false);
  });

  test("a PARTIAL instant failure also degrades — pins the anyInstantFailed limb", async () => {
    // Only the OLDER instant fails, so the newer one still populates and the run stays usable.
    const { data } = await withCapture((url) => {
      if (/\/(StockholdersEquity|Assets|Liabilities)\/USD\/CY2025Q4I\.json/.test(url)) {
        return new Response("boom", { status: 503 });
      }
      return healthy(url);
    });
    expect(data!.degraded).toBe(true);
  });
});

// ── The ladder must gate on a USABLE WINDOW, not on fact COUNT ────────────────────────────────────
// The first version short-circuited on `direct.length > 0`, so a filer with a handful of UNUSABLE
// NetIncomeLoss facts never reached the ProfitLoss fallback — which is why the sector-bias fix barely
// moved the numbers on its first attempt. Measured live: FCX has 11 such facts whose newest annual is
// a DEF 14A (correctly rejected by the form allowlist) and AEP has 67 whose newest 10-K annual is from
// 2013 (4,657 days stale). Both derive cleanly from ProfitLoss − NCI once the ladder is reached.
describe("a filer with unusable NetIncomeLoss facts still reaches the ProfitLoss ladder", () => {
  const annual = (val: number, year: number, form: string) => ({
    start: `${year}-01-01`, end: `${year}-12-31`, val, filed: `${year + 1}-02-01`, form,
  });

  /** SEC stub: NetIncomeLoss present but unusable; ProfitLoss + NCI healthy and recent. */
  const ladderStub = (url: string) => {
    if (url.includes("company_tickers.json")) return json(tickerMap());
    if (url.includes("/NetIncomeLoss.json")) {
      // Present, plural — and all unusable: one ancient 10-K, one recent PROXY.
      return json({ units: { USD: [annual(500, 2013, "10-K"), annual(900, 2025, "DEF 14A")] } });
    }
    if (url.includes("/ProfitLoss.json")) {
      return json({ units: { USD: [annual(4_150_000_000, 2025, "10-K")] } });
    }
    if (url.includes("NoncontrollingInterest")) {
      return json({ units: { USD: [annual(1_950_000_000, 2025, "10-K")] } });   // 47% NCI, FCX-shaped
    }
    if (url.includes("companyconcept")) return json({ units: { USD: [] } });
    return json(frameFor(url));
  };

  /**
   * Frames must be POPULATED (or the MIN_FILERS gate rejects the period and the function throws
   * before recovery is ever reached — my first fixture did exactly that). So: income frames cover
   * CIKs 100-700, which clears the floor but EXCLUDES AAPL's cik 1, while the balance-sheet instants
   * cover 1-600 and include it. AAPL therefore has Assets but no income → a recovery candidate.
   */
  const framesExcludingAapl = (url: string) => {
    const income = url.includes("/NetIncomeLoss/USD/CY");
    const base = income ? 100 : 1;
    const body = frameFor(url, 600);
    body.data = body.data.map((r: any, i: number) => ({ ...r, cik: base + i }));
    return json(body);
  };

  test("the derived series is used, and the NCI is subtracted rather than swallowed", async () => {
    stub((url) => {
      if (/\/USD\/CY/.test(url)) return framesExcludingAapl(url);
      return ladderStub(url);
    });
    const d = await fetchQualityFromSEC();
    // AAPL is the one universe symbol in the stubbed ticker map, and it is reachable ONLY via the
    // recovery ladder here. If the ladder had been skipped there would be no score at all; if NCI
    // were ignored the roa would be ~2x. The ratio pins both.
    expect(d.scores["AAPL"]).toBeDefined();
    const roa = d.scores["AAPL"].roa;
    expect(roa).toBeCloseTo(2.2, 1);              // (4.15 − 1.95) / 1.0 assets
    expect(roa).not.toBeCloseTo(4.15, 1);         // the un-adjusted, fail-open value
  });

  test("when NEITHER source yields a window the filer is withheld, not invented", async () => {
    stub((url) => {
      if (/\/USD\/CY/.test(url)) return framesExcludingAapl(url);
      if (url.includes("/ProfitLoss.json")) return json({ units: { USD: [annual(100, 2013, "10-K")] } });  // stale
      return ladderStub(url);
    });
    const d = await fetchQualityFromSEC();
    expect(d.scores["AAPL"]).toBeUndefined();        // withheld, not invented from a stale series
    expect(d.withheld).toContain("AAPL");
  });
});
