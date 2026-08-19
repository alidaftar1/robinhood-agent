import { NextRequest, NextResponse } from "next/server";
import {
  getSessionCookieConfig,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  createSession,
  isValidDashboardKey,
  redeemLoginToken,
} from "./lib/dashboard-auth";

// Runs on the two HTML routes ("/", "/public" — see config.matcher below). /api/* keeps
// its own CRON_SECRET gate (lib/auth.ts) untouched and gets no CSP (it returns JSON, not
// HTML — nothing for a script/style policy to protect there).
//
// Two independent jobs live here now:
//   1. Login-credential redemption — "/" ONLY (unchanged from before; guarded by pathname
//      below so widening the matcher to include "/public" doesn't change /public at all).
//   2. Per-request CSP nonce — both routes, PRODUCTION ONLY. Gated to prod because `next dev`
//      relies on eval() for Fast Refresh (which a nonce/strict-dynamic CSP blocks) and
//      @vercel/analytics loads its debug script from an external host only in dev — neither
//      of those needs hardening locally, only on the deployed origin.
//
// ── Job 1: login-credential redemption (this is the ONE place a login credential is
// allowed to appear in the URL, and only for the single request that redeems it):
//   - ?token=...  — single-use link from a notification email (see lib/dashboard-auth.ts).
//   - ?key=...    — manually-typed DASHBOARD_SECRET (LoginScreen's form).
// Either path, on success, creates a server-side session and redirects to the bare `/` — the
// credential never appears in a second request, browser history entry, or referrer header.
//
// Requests with neither param pass through unchanged; app/page.tsx decides login-screen vs.
// dashboard by checking the session cookie against Redis (see lib/dashboard-auth.ts).
export async function middleware(request: NextRequest) {
  const url = request.nextUrl;

  if (url.pathname === "/") {
    const token = url.searchParams.get("token");
    const key = url.searchParams.get("key");

    if (token || key) {
      const strippedUrl = url.clone();
      strippedUrl.searchParams.delete("token");
      strippedUrl.searchParams.delete("key");

      let authorized = false;
      if (token) {
        authorized = await redeemLoginToken(token);
      } else if (key) {
        authorized = await isValidDashboardKey(key);
      }

      if (!authorized) {
        // Don't set a cookie; redirect to the clean URL either way so an invalid/expired
        // credential doesn't linger in the address bar or get resubmitted on refresh. The
        // page then renders LoginScreen (no session cookie present) — same response shape
        // as "never logged in", rather than a distinguishing error for a wrong vs. missing
        // credential.
        return withCspOnRedirect(NextResponse.redirect(strippedUrl));
      }

      const sessionId = await createSession();
      if (!sessionId) {
        // Redis is unreachable — fail closed. Redirect to the clean URL without a cookie
        // rather than letting the request through unauthenticated.
        return withCspOnRedirect(NextResponse.redirect(strippedUrl));
      }

      const response = NextResponse.redirect(strippedUrl);
      const cookieConfig = getSessionCookieConfig();
      response.cookies.set(cookieConfig.name, sessionId, {
        httpOnly: true,
        secure: cookieConfig.secure,
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      });
      return withCspOnRedirect(response);
    }
  }

  return withCspOnPageRender(request);
}

// ── Job 2: CSP nonce (production only) ──────────────────────────────────────────────────
// Gated to prod because `next dev` relies on eval() for Fast Refresh (a nonce/strict-dynamic
// CSP blocks eval) and @vercel/analytics loads its debug script from an external host only
// in dev — neither needs hardening locally, only on the deployed origin.
function buildCsp(nonce: string): string {
  return [
    // 'strict-dynamic' is required, not just defense-in-depth: @vercel/analytics injects
    // its script via document.createElement at runtime (a non-nonced, dynamically-created
    // tag) — strict-dynamic propagates trust from the nonced bundle that creates it, or the
    // script gets silently blocked. The trailing 'unsafe-inline' https: http: is the
    // standard CSP1/2 fallback: any browser that understands nonce/strict-dynamic ignores
    // it outright, so it doesn't weaken the policy on a modern browser.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https: http:`,
    // Inline `style={}` is used throughout the dashboard UI — style-src needs 'unsafe-inline'
    // for that to keep rendering. Style injection is a much lower-value XSS vector than
    // script injection, and this app's styles are all developer-authored, not user input.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // 'self' covers same-origin RSC/analytics fetches; *.sentry.io covers the browser
    // Sentry SDK's error/transaction beacons (no tunnelRoute configured, so it posts
    // directly to Sentry's ingest host).
    "connect-src 'self' https://*.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// Redirects render no HTML — no nonce needed, just the header for consistency.
function withCspOnRedirect(response: NextResponse): NextResponse {
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Content-Security-Policy", buildCsp(Buffer.from(crypto.randomUUID()).toString("base64")));
  }
  return response;
}

// The page-render path: the nonce must also be forwarded on the request so Next.js can
// read it and auto-apply it to its own hydration/chunk-loading inline scripts (its
// documented nonce mechanism) — setting it only on the response would leave Next's own
// scripts un-nonced and broken by this same policy.
function withCspOnPageRender(request: NextRequest): NextResponse {
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/", "/public"],
};
