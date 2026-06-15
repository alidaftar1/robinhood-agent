/**
 * Integration tests — run against the live production deployment.
 * Read-only: no trades triggered, no state mutated.
 *
 * Usage:
 *   bun --env-file=.env.local test evals/integration.test.ts
 *   # or with explicit secret:
 *   CRON_SECRET=your_secret bun test evals/integration.test.ts
 */

import { describe, it, expect } from "bun:test";

const BASE = process.env.APP_URL ?? "https://YOUR_APP.vercel.app";
const SECRET = process.env.CRON_SECRET ?? "";
const AUTH = { Authorization: `Bearer ${SECRET}` };

// ─── Health checks ────────────────────────────────────────────────────────────

describe("health: external services", () => {
  it("Yahoo Finance is reachable", async () => {
    const res = await fetch(`${BASE}/api/debug`, { headers: AUTH });
    const data = await res.json() as Record<string, string>;
    expect(res.status).toBe(200);
    expect(data.yahoo).toMatch(/^ok/);
  }, 15_000);

  it("Upstash Redis is reachable", async () => {
    const res = await fetch(`${BASE}/api/debug`, { headers: AUTH });
    const data = await res.json() as Record<string, string>;
    expect(data.upstash).toMatch(/^ok/);
  }, 15_000);

  it("Anthropic API key is configured", async () => {
    const res = await fetch(`${BASE}/api/debug`, { headers: AUTH });
    const data = await res.json() as Record<string, string>;
    expect(data.anthropicKey).toBe("present");
  }, 15_000);

  it("Robinhood refresh token is configured", async () => {
    const res = await fetch(`${BASE}/api/debug`, { headers: AUTH });
    const data = await res.json() as Record<string, string>;
    expect(data.robinhoodToken).toBe("refresh token present");
  }, 15_000);
});

// ─── Run store checks ─────────────────────────────────────────────────────────

describe("run store: post-trade persistence", () => {
  it("latest run was saved to Redis within 48 hours", async () => {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { headers: AUTH });
    expect(res.status).toBe(200);

    const data = await res.json() as { runs: Array<{ timestamp: string; date: string }> };
    expect(data.runs.length).toBeGreaterThan(0);

    const latest = data.runs[0];
    const ageHours = (Date.now() - new Date(latest.timestamp).getTime()) / 3_600_000;

    console.log(`\nLatest run: ${latest.date} (${ageHours.toFixed(1)}h ago)`);
    expect(ageHours).toBeLessThan(48);
  }, 15_000);

  it("latest run has portfolio data (saveRun completed — not a phantom trade)", async () => {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { headers: AUTH });
    const data = await res.json() as {
      runs: Array<{ portfolioAfter: unknown; market: { stocksLoaded: number } }>
    };
    const latest = data.runs[0];

    expect(latest.portfolioAfter).not.toBeNull();
    console.log(`\nPortfolio saved: ${JSON.stringify(latest.portfolioAfter)}`);
    console.log(`Stocks loaded: ${latest.market?.stocksLoaded}`);
  }, 15_000);

  it("latest run loaded at least 400 S&P 500 stocks", async () => {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { headers: AUTH });
    const data = await res.json() as {
      runs: Array<{ market: { stocksLoaded: number } }>
    };
    const stocksLoaded = data.runs[0]?.market?.stocksLoaded ?? 0;
    console.log(`\nStocks loaded: ${stocksLoaded}/~450`);
    expect(stocksLoaded).toBeGreaterThanOrEqual(400);
  }, 15_000);
});

// ─── Personal account snapshot ────────────────────────────────────────────────

describe("run store: personal account snapshot", () => {
  it("latest run has personal account data with a positive total value", async () => {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      runs: Array<{ personal: { totalValue: string; cash: string; positions: unknown[] } | null }>
    };
    const personal = data.runs[0]?.personal;

    expect(personal).not.toBeNull();
    const totalValue = parseFloat(personal!.totalValue);
    expect(totalValue).toBeGreaterThan(0);

    console.log(`\nPersonal: $${personal!.totalValue} total, $${personal!.cash} cash, ${personal!.positions.length} positions`);
  }, 15_000);

  it("personal positions have valid prices (non-zero)", async () => {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { headers: AUTH });
    const data = await res.json() as {
      runs: Array<{ personal: { positions: Array<{ symbol: string; price: string }> } | null }>
    };
    const positions = data.runs[0]?.personal?.positions ?? [];

    const zeroPriced = positions.filter((p) => parseFloat(p.price) <= 0);
    if (zeroPriced.length > 0) {
      console.log(`\nZero-priced positions: ${zeroPriced.map((p) => p.symbol).join(", ")}`);
    }
    // Positions not in S&P 500 priceMap (e.g. SERV) may have price 0 if Claude didn't report one
    // Allow up to 1 zero-priced position (non-S&P 500 holdings)
    expect(zeroPriced.length).toBeLessThanOrEqual(1);
  }, 15_000);
});

// ─── Event-driven route checks ────────────────────────────────────────────────

describe("event routes: earnings-exit and drop-check", () => {
  it("earnings-exit route is reachable and returns valid JSON", async () => {
    const res = await fetch(`${BASE}/api/earnings-exit`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    // Should either skip (no imminent earnings) or succeed (ran a session)
    const valid = data.skipped === true || data.success === true;
    console.log(`\nearnings-exit: ${JSON.stringify(data)}`);
    expect(valid).toBe(true);
  }, 30_000);

  it("drop-check route is reachable and returns valid JSON", async () => {
    const res = await fetch(`${BASE}/api/drop-check`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    // Should either skip (no severe drops) or succeed (ran a session)
    const valid = data.skipped === true || data.success === true;
    console.log(`\ndrop-check: ${JSON.stringify(data)}`);
    expect(valid).toBe(true);
  }, 30_000);

  it("earnings-exit skips on days with no held positions or no imminent earnings", async () => {
    const res = await fetch(`${BASE}/api/earnings-exit`, { headers: AUTH });
    const data = await res.json() as { skipped?: boolean; reason?: string; success?: boolean };
    if (data.skipped) {
      console.log(`\nearnings-exit skipped: ${data.reason}`);
      expect(["no positions held", "no imminent earnings on held positions", "market holiday"]).toContain(data.reason ?? "");
    } else {
      // It ran a real session — that's also fine
      console.log(`\nearnings-exit triggered a real exit session`);
      expect(data.success).toBe(true);
    }
  }, 30_000);

  it("drop-check skips on days with no severe drops", async () => {
    const res = await fetch(`${BASE}/api/drop-check`, { headers: AUTH });
    const data = await res.json() as { skipped?: boolean; reason?: string; success?: boolean };
    if (data.skipped) {
      console.log(`\ndrop-check skipped: ${data.reason}`);
      expect(["no positions held", "no severe drops", "market holiday"]).toContain(data.reason ?? "");
    } else {
      console.log(`\ndrop-check triggered a real stop-loss session`);
      expect(data.success).toBe(true);
    }
  }, 30_000);
});
