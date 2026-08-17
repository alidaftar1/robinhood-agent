import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

function requestWithAuth(header: string | null): Request {
  const init: RequestInit = {};
  if (header !== null) init.headers = { authorization: header };
  return new Request("http://localhost/api/runs", init);
}

describe("isAuthorizedCronRequest", () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  describe("CRON_SECRET unset (the regression this guards against)", () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it("rejects the exact bypass string a stringified-undefined comparison used to accept", () => {
      // Before the fix: `Bearer ${process.env.CRON_SECRET}` with CRON_SECRET
      // unset stringifies to the literal "Bearer undefined" — a fixed,
      // guessable value that passed the old inline check.
      expect(isAuthorizedCronRequest(requestWithAuth("Bearer undefined"))).toBe(false);
    });

    it("rejects a request with no Authorization header at all", () => {
      expect(isAuthorizedCronRequest(requestWithAuth(null))).toBe(false);
    });

    it("rejects any other header value too", () => {
      expect(isAuthorizedCronRequest(requestWithAuth("Bearer anything-else"))).toBe(false);
    });
  });

  describe("CRON_SECRET set", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = "test-secret-value";
    });

    it("accepts the matching Bearer header", () => {
      expect(isAuthorizedCronRequest(requestWithAuth("Bearer test-secret-value"))).toBe(true);
    });

    it("rejects a wrong secret", () => {
      expect(isAuthorizedCronRequest(requestWithAuth("Bearer wrong-value"))).toBe(false);
    });

    it("rejects a missing header", () => {
      expect(isAuthorizedCronRequest(requestWithAuth(null))).toBe(false);
    });

    it("rejects the header without the Bearer prefix", () => {
      expect(isAuthorizedCronRequest(requestWithAuth("test-secret-value"))).toBe(false);
    });

    it("is case-sensitive on the secret value", () => {
      expect(isAuthorizedCronRequest(requestWithAuth("Bearer TEST-SECRET-VALUE"))).toBe(false);
    });
  });
});
