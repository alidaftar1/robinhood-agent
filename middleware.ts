import { NextRequest, NextResponse } from "next/server";
import {
  DASHBOARD_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  createSession,
  isValidDashboardKey,
  redeemLoginToken,
} from "./lib/dashboard-auth";

// Runs only against the dashboard root (see config.matcher below) — /public stays fully open,
// /api/* keeps its own CRON_SECRET gate (lib/auth.ts) untouched.
//
// This is the ONE place a login credential is allowed to appear in the URL, and only for the
// single request that redeems it:
//   - ?token=...  — single-use link from a notification email (see lib/dashboard-auth.ts).
//   - ?key=...    — manually-typed DASHBOARD_SECRET (LoginScreen's form).
// Either path, on success, creates a server-side session and redirects to the bare `/` — the
// credential never appears in a second request, browser history entry, or referrer header.
//
// Requests with neither param pass through unchanged; app/page.tsx decides login-screen vs.
// dashboard by checking the session cookie against Redis (see lib/dashboard-auth.ts).
export async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const token = url.searchParams.get("token");
  const key = url.searchParams.get("key");

  if (!token && !key) {
    return NextResponse.next();
  }

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
    // Don't set a cookie; redirect to the clean URL either way so an invalid/expired credential
    // doesn't linger in the address bar or get resubmitted on refresh. The page then renders
    // LoginScreen (no session cookie present) — same response shape as "never logged in",
    // rather than a distinguishing error for a wrong vs. missing credential.
    return NextResponse.redirect(strippedUrl);
  }

  const sessionId = await createSession();
  if (!sessionId) {
    // Redis is unreachable — fail closed. Redirect to the clean URL without a cookie rather
    // than letting the request through unauthenticated.
    return NextResponse.redirect(strippedUrl);
  }

  const response = NextResponse.redirect(strippedUrl);
  response.cookies.set(DASHBOARD_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

export const config = {
  matcher: ["/"],
};
