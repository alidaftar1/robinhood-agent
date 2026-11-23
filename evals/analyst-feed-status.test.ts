import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchAnalystRatings } from "@/lib/analyst";

// 2026-11-17: every analyst-feed failure used to collapse to {} — the same value as "no analyst
// actions today" — so a bad key or a spent quota read as a quiet market. On 11-03 and 11-16 the sell
// rail recorded 0 analyst symbols and nothing said why. The fetch now reports a status, and the
// trade run records a note whenever it is not "ok".
const realFetch = globalThis.fetch;
const realKey = process.env.FMP_API_KEY;
afterEach(() => { globalThis.fetch = realFetch; process.env.FMP_API_KEY = realKey; });
const stub = (impl: () => Promise<Response>) => { globalThis.fetch = (() => impl()) as unknown as typeof fetch; };

describe("analyst feed: a failure is named, never silent", () => {
  it("no key → no-key", async () => {
    delete process.env.FMP_API_KEY;
    expect(await fetchAnalystRatings()).toEqual({ ratings: {}, status: "no-key" });
  });
  it("HTTP 401 (bad key) → http-401", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response('{"Error Message":"Invalid API KEY."}', { status: 401 }));
    expect((await fetchAnalystRatings()).status).toBe("http-401");
  });
  it("an error object instead of a list → bad-shape; a thrown fetch → error", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response('{"Error Message":"Limit Reach"}', { status: 200 }));
    expect((await fetchAnalystRatings()).status).toBe("bad-shape");
    stub(async () => { throw new Error("timeout"); });
    expect((await fetchAnalystRatings()).status).toBe("error");
  });
  it("CONTROL: a valid empty list is ok — a quiet day is not a failure", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response("[]", { status: 200 }));
    expect(await fetchAnalystRatings()).toEqual({ ratings: {}, status: "ok" });
  });
  // 2026-11-23: the FMP plan caps the endpoint at 10 items = the last few hours of the whole market.
  const item = (hoursAgo: number, symbol = "XYZQ") => ({
    symbol, publishedDate: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), newsTitle: "PT Raised to $10",
  });
  it("a list that does not reach back over the lookback window → truncated, ratings still returned", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response(JSON.stringify([item(1, "AAPL"), item(5)]), { status: 200 }));
    const r = await fetchAnalystRatings();
    expect(r.status).toBe("truncated");
    expect(r.coverage).toContain("~5h");
    expect(Object.keys(r.ratings)).toEqual(["AAPL"]);
  });
  it("undated items cannot establish coverage → truncated, not ok", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response(JSON.stringify([{ symbol: "AAPL", newsTitle: "PT Raised" }]), { status: 200 }));
    expect((await fetchAnalystRatings()).status).toBe("truncated");
  });
  it("CONTROL: a list reaching past the cutoff is ok", async () => {
    process.env.FMP_API_KEY = "k";
    stub(async () => new Response(JSON.stringify([item(1, "AAPL"), item(24 * 8)]), { status: 200 }));
    expect((await fetchAnalystRatings()).status).toBe("ok");
  });
  it("wiring: the trade run records the note on any non-ok status, and the autopilot emails it", () => {
    const trade = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    expect(trade).toContain('} else if (marketData.analystFeedStatus !== "ok") {');
    expect(trade).toContain("⚠️ Analyst feed truncated (FMP: ${marketData.analystFeedCoverage");
    // The sell rail's trigger is UNCHANGED by the label: truncated (formerly "ok") must not stand it down.
    expect(trade).toContain('(marketData.analystFeedStatus !== "ok" && marketData.analystFeedStatus !== "truncated") || Object.keys(marketData.analystRatings');
    expect(trade).toContain("⚠️ Analyst feed unavailable (FMP: ${marketData.analystFeedStatus})");
    const auto = readFileSync(`${import.meta.dir}/../app/api/autopilot/route.ts`, "utf8");
    expect(auto).toContain('n.startsWith("⚠️ Analyst feed unavailable")');
    // NOT a soft issue: on the capped plan truncation is the steady state, and a NEEDS ATTENTION
    // banner every morning is desensitisation (the 10-13 lesson). It stays in the run's notes.
    expect(auto).not.toContain("Analyst feed truncated");
    expect(auto).toContain("if (analystFeedNote) softIssues.push(analystFeedNote);");
  });
});
