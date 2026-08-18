import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isValidDashboardKey,
  mintLoginToken,
  redeemLoginToken,
  createSession,
  touchSession,
  getSessionCookieConfig,
} from "@/lib/dashboard-auth";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
}

// @types/node types NODE_ENV as read-only on ProcessEnv; this is a normal, safe write at
// runtime (Node itself doesn't enforce that), just not typed for direct assignment.
function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

afterEach(() => {
  resetEnv();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ─── getSessionCookieConfig: __Host- prefix must never appear on a non-Secure cookie ───

describe("getSessionCookieConfig", () => {
  it("production: uses the __Host- prefix and Secure", () => {
    resetEnv();
    setNodeEnv("production");
    const { name, secure } = getSessionCookieConfig();
    expect(secure).toBe(true);
    expect(name).toBe("__Host-dashboard_session");
  });

  it("non-production: plain name, not Secure — __Host- would be spec-invalid without Secure, and Secure itself isn't guaranteed to persist on every local dev client", () => {
    resetEnv();
    setNodeEnv("development");
    const { name, secure } = getSessionCookieConfig();
    expect(secure).toBe(false);
    expect(name).toBe("dashboard_session");
    expect(name.startsWith("__Host-")).toBe(false);
  });

  it("invariant: whenever the name carries __Host-, secure is always true (the combination the spec requires)", () => {
    for (const env of ["production", "development", "test", undefined]) {
      resetEnv();
      setNodeEnv(env);
      const { name, secure } = getSessionCookieConfig();
      if (name.startsWith("__Host-")) expect(secure).toBe(true);
    }
  });
});

// ─── isValidDashboardKey: pure secret-comparison logic, no Redis involved ───

describe("isValidDashboardKey", () => {
  it("fails closed when DASHBOARD_SECRET is unset — never falls back to a comparison", async () => {
    delete process.env.DASHBOARD_SECRET;
    delete process.env.CRON_SECRET;
    // Mirrors the exact regression this whole fix follows from: an unset secret must never
    // let a request through, including one that (mis)guesses the literal stringified value.
    expect(await isValidDashboardKey("undefined")).toBe(false);
    expect(await isValidDashboardKey("")).toBe(false);
  });

  it("fails closed when DASHBOARD_SECRET is shorter than the shared MIN_SECRET_LEN floor", async () => {
    process.env.DASHBOARD_SECRET = "short-secret"; // 12 chars, under the 16-char floor
    delete process.env.CRON_SECRET;
    expect(await isValidDashboardKey("short-secret")).toBe(false);
  });

  it("fails closed when DASHBOARD_SECRET collides with CRON_SECRET — the exact misconfiguration this fix exists to prevent", async () => {
    const shared = "a-perfectly-long-enough-secret-value";
    process.env.DASHBOARD_SECRET = shared;
    process.env.CRON_SECRET = shared;
    // Even the correct value is rejected, because accepting it here would mean a leaked
    // dashboard link is once again a valid trade-API credential — silently, with both
    // individual length/presence checks passing.
    expect(await isValidDashboardKey(shared)).toBe(false);
  });

  it("accepts the exact secret when properly configured and distinct from CRON_SECRET", async () => {
    process.env.DASHBOARD_SECRET = "dashboard-only-secret-value-123";
    process.env.CRON_SECRET = "a-totally-different-cron-secret";
    expect(await isValidDashboardKey("dashboard-only-secret-value-123")).toBe(true);
  });

  it("rejects a wrong candidate of the same length as the real secret", async () => {
    process.env.DASHBOARD_SECRET = "dashboard-only-secret-value-123";
    process.env.CRON_SECRET = "a-totally-different-cron-secret";
    expect(await isValidDashboardKey("dashboard-only-secret-value-999")).toBe(false);
  });

  it("rejects an empty candidate even when a valid secret is configured", async () => {
    process.env.DASHBOARD_SECRET = "dashboard-only-secret-value-123";
    process.env.CRON_SECRET = "a-totally-different-cron-secret";
    expect(await isValidDashboardKey("")).toBe(false);
  });
});

// ─── Redis-backed helpers: mint/redeem/session — mocked against a tiny fake Upstash ───

// In-memory stand-in for Upstash's REST API, just enough to exercise the SET/GETDEL/EXPIRE
// commands this file's helpers actually issue. Keyed the same way redisCommand builds its URL
// (path-style: /COMMAND/arg1/arg2/...), so this stays a faithful shape of the real call, not a
// hand-wave that just returns whatever each test wants.
function installFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [command, ...args] = parts;

    let result: unknown = null;
    if (command === "SET") {
      const [key, value, exFlag, ttl] = args;
      const expiresAt = exFlag === "EX" && ttl ? Date.now() + Number(ttl) * 1000 : null;
      store.set(key!, { value: value!, expiresAt });
      result = "OK";
    } else if (command === "GETDEL") {
      const [key] = args;
      const entry = store.get(key!);
      store.delete(key!);
      result = entry && (entry.expiresAt === null || entry.expiresAt > Date.now()) ? entry.value : null;
    } else if (command === "EXPIRE") {
      const [key, ttl] = args;
      const entry = store.get(key!);
      if (entry && (entry.expiresAt === null || entry.expiresAt > Date.now())) {
        entry.expiresAt = Date.now() + Number(ttl) * 1000;
        result = 1;
      } else {
        result = 0;
      }
    }

    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;

  return store;
}

describe("mintLoginToken / redeemLoginToken", () => {
  beforeEach(() => installFakeRedis());

  it("a freshly minted token redeems successfully exactly once", async () => {
    const token = await mintLoginToken();
    expect(token).not.toBeNull();
    expect(await redeemLoginToken(token!)).toBe(true);
    // Single-use: the SAME token must fail the second time, even though its TTL hasn't expired.
    expect(await redeemLoginToken(token!)).toBe(false);
  });

  it("redeeming a token that was never minted fails", async () => {
    expect(await redeemLoginToken("00".repeat(32))).toBe(false);
  });

  it("redeeming an empty token fails without a network call", async () => {
    expect(await redeemLoginToken("")).toBe(false);
  });

  it("two minted tokens are independent — redeeming one never consumes the other", async () => {
    const a = await mintLoginToken();
    const b = await mintLoginToken();
    expect(a).not.toBe(b);
    expect(await redeemLoginToken(a!)).toBe(true);
    expect(await redeemLoginToken(b!)).toBe(true);
  });
});

describe("createSession / touchSession", () => {
  beforeEach(() => installFakeRedis());

  it("a freshly created session is valid and stays valid across repeated touches", async () => {
    const sessionId = await createSession();
    expect(sessionId).not.toBeNull();
    expect(await touchSession(sessionId!)).toBe(true);
    expect(await touchSession(sessionId!)).toBe(true); // renewal doesn't consume it
  });

  it("an unknown session id is invalid", async () => {
    expect(await touchSession("not-a-real-session-id")).toBe(false);
  });

  it("an empty session id is invalid without a network call", async () => {
    expect(await touchSession("")).toBe(false);
  });
});

describe("Redis unreachable — every helper fails closed, never throws past the caller", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch;
  });

  it("mintLoginToken returns null instead of throwing", async () => {
    expect(await mintLoginToken()).toBeNull();
  });

  it("redeemLoginToken returns false instead of throwing", async () => {
    expect(await redeemLoginToken("some-token")).toBe(false);
  });

  it("createSession returns null instead of throwing", async () => {
    expect(await createSession()).toBeNull();
  });

  it("touchSession returns false instead of throwing", async () => {
    expect(await touchSession("some-session")).toBe(false);
  });
});
