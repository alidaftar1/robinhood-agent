// Auth for the private dashboard at `/` — fully separate from CRON_SECRET (lib/auth.ts).
//
// WHY A SEPARATE SECRET: the dashboard is a read-only view shared by URL (email links, manual
// entry). CRON_SECRET gates the trade API. Before this file, both used the SAME secret, so a
// leaked read-only dashboard link could reach /api/trade. One secret, one job: a dashboard leak
// must never be a trade-API leak.
//
// WHY ONE-TIME TOKENS, NOT THE SECRET ITSELF, IN EMAIL: earlier design embedded the dashboard
// secret directly in every notification email (?key=...). That secret is then permanently valid
// and sits in every email ever sent — an old, forgotten, or breached email account hands over a
// working credential forever. Instead, notification routes call mintLoginToken() to get a
// single-use, short-lived token; the raw DASHBOARD_SECRET is only ever typed once, directly, into
// the manual-login form (LoginScreen) — it never travels over email at all.
//
// WHY REDIS FOR SESSIONS: this repo already talks to Upstash Redis over its REST API for run
// history (lib/run-store.ts) — no new dependency. Storing sessions/tokens there (rather than a
// stateless derived cookie) means a compromised cookie is REVOCABLE (delete the Redis key) and
// naturally expires server-side, not just via a client-trusted cookie attribute.
//
// FAILS CLOSED, same philosophy as requireCronAuth: a missing/weak DASHBOARD_SECRET, or one that
// collides with CRON_SECRET (an easy operator slip that would silently defeat the whole point of
// having two secrets), rejects every manual-login attempt rather than falling back to anything.

import { redisCommand } from "./run-store";
import { MIN_SECRET_LEN } from "./auth";

// The __Host- prefix requires the Secure attribute on every cookie carrying it — browsers
// reject the Set-Cookie outright otherwise. Secure cookies DO persist over plain http on
// localhost in current Chrome/Firefox/Edge (a documented "potentially trustworthy origin"
// exemption), but that's a browser-specific carve-out, not a guarantee (Safari's track record
// here is less consistent, and any non-evergreen client wouldn't honor it). Rather than have
// local dev depend on that exemption at all, use the unprefixed name + a non-Secure cookie
// outside production — same approach next-auth uses for this exact reason.
//
// Computed per-call (not cached at module load) so it always reflects the current
// NODE_ENV — matters for tests that toggle it, and avoids any import-order surprise.
export function getSessionCookieConfig(): { name: string; secure: boolean } {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    name: isProduction ? "__Host-dashboard_session" : "dashboard_session",
    secure: isProduction,
  };
}

const LOGIN_TOKEN_PREFIX = "dashboard:login-token:";
const SESSION_PREFIX = "dashboard:session:";

// Single-use email/manual-link bootstrap token: short-lived, since it's only meant to be used
// once, right after the email arrives or the link is manually opened.
const LOGIN_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

// Session lifetime once logged in. Renewed on every valid dashboard load (see touchSession),
// so an active user never gets logged out mid-use — only real inactivity expires it.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function randomToken(): string {
  // 32 random bytes, hex-encoded — 256 bits of entropy, far beyond brute-force range even
  // amplified by however many requests an attacker could realistically throw at Redis lookups.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison for two SECRET values (attacker-controlled candidate vs. the
 * real secret). A plain `===`/`!==` short-circuits on the first differing byte, leaking timing
 * information about how much of a guess was correct. Hashing both sides to a fixed length first,
 * then comparing every byte regardless of where they differ, removes that channel.
 *
 * Not needed for Redis-backed token/session lookups elsewhere in this file — a KV existence
 * check isn't a byte-by-byte comparison an attacker can time, and the tokens involved are
 * high-entropy random values, not something worth trying to time-attack in the first place.
 */
async function constantTimeSecretEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  // Both are SHA-256 digests, so always equal length (32 bytes) — no early-exit-on-length-
  // mismatch branch needed, which would itself be a timing leak if lengths could differ.
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i]! ^ bytesB[i]!;
  }
  return diff === 0;
}

/**
 * True only when DASHBOARD_SECRET is present, long enough, and distinct from CRON_SECRET.
 * Every entry point below calls this before trusting DASHBOARD_SECRET for anything — fail
 * closed on any of the three conditions rather than silently accepting a weak/reused secret.
 */
function dashboardSecretIsConfigured(): boolean {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) return false;
  // Plain !== here, not constant-time: both operands are server env vars, never attacker input,
  // so there's no timing channel to close — only the two comparisons above (against a
  // request-supplied value) need constant-time treatment.
  if (secret === process.env.CRON_SECRET) return false;
  return true;
}

/**
 * Verify a manually-entered dashboard key against DASHBOARD_SECRET.
 * Fails closed (returns false) if the secret isn't configured at all — never falls through to
 * comparing against an empty/undefined value.
 */
export async function isValidDashboardKey(candidate: string): Promise<boolean> {
  if (!dashboardSecretIsConfigured()) return false;
  return constantTimeSecretEqual(candidate, process.env.DASHBOARD_SECRET!);
}

/**
 * Mint a single-use login token for an outbound notification email. Callers (autopilot,
 * drop-check, earnings-exit) embed this in the "Open dashboard" link instead of any secret.
 * Returns null if Redis isn't configured or the write fails — callers already handle a null/
 * missing link gracefully (see how they build the email body), same as other Redis writes in
 * this codebase (lib/run-store.ts's saveRun swallows Upstash errors rather than blocking the
 * cron itself on a storage hiccup).
 */
export async function mintLoginToken(): Promise<string | null> {
  try {
    const token = randomToken();
    await redisCommand("SET", `${LOGIN_TOKEN_PREFIX}${token}`, "1", "EX", LOGIN_TOKEN_TTL_SECONDS);
    return token;
  } catch {
    console.warn("Upstash unavailable — dashboard login token not minted");
    return null;
  }
}

/**
 * Redeem a single-use login token minted by mintLoginToken(). Deletes it on read (via GETDEL)
 * so it can never be replayed, even within its TTL window. Returns true exactly once per token.
 */
export async function redeemLoginToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const result = await redisCommand("GETDEL", `${LOGIN_TOKEN_PREFIX}${token}`);
    return result === "1";
  } catch {
    return false;
  }
}

/**
 * Start a new dashboard session after a successful login (manual key or redeemed token).
 * Returns the opaque session id to store in the session cookie — never derived from
 * DASHBOARD_SECRET, so a leaked session id can't be used to reconstruct the real secret.
 */
export async function createSession(): Promise<string | null> {
  try {
    const sessionId = randomToken();
    await redisCommand("SET", `${SESSION_PREFIX}${sessionId}`, "1", "EX", SESSION_TTL_SECONDS);
    return sessionId;
  } catch {
    return null;
  }
}

/**
 * Check whether a session id (from the session cookie) is still valid, and slide its expiry
 * forward on every valid check — an active user's session renews itself; only real inactivity
 * (7 days with no page load) lets it expire.
 */
export async function touchSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const exists = await redisCommand("EXPIRE", `${SESSION_PREFIX}${sessionId}`, SESSION_TTL_SECONDS);
    // Upstash EXPIRE returns 1 if the key existed and the TTL was set, 0 if the key didn't exist.
    return exists === 1;
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_TTL_SECONDS;

/**
 * Build a one-time dashboard login link for an outbound email, e.g.
 * `https://app.example.com/?token=...`. Falls back to the bare dashboard URL (no token) if
 * minting fails (Redis unreachable) — the human still gets a link, it just prompts for the
 * manual key instead of logging straight in, same degraded-but-safe pattern as other Redis
 * failures in this codebase (see mintLoginToken's own fallback).
 */
export async function buildDashboardLoginUrl(host: string): Promise<string> {
  const token = await mintLoginToken();
  return token ? `${host}/?token=${token}` : `${host}/`;
}

/**
 * Public dashboard URL for outbound email links — the KEYLESS `/public` view (account number
 * redacted, no token in the URL). Preferred over the authenticated one-time-token link for emails:
 * nothing sensitive to leak (safe if a notification email is screenshotted), no Redis token round-trip,
 * and it always resolves (falls back to the prod alias if APP_URL is unset, so drop-check/earnings-exit
 * — which pass a possibly-empty APP_URL — never emit a broken relative link).
 */
export function dashboardPublicUrl(host?: string | null): string {
  const base = host && host.length > 0 ? host : "https://robinhood-agent.vercel.app";
  return `${base}/public`;
}
