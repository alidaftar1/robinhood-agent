import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Baseline security headers, applied to every route (pages + /api/*) in every
// environment (dev + prod) — none of these can break anything: HSTS/X-Frame-Options/
// nosniff/Referrer-Policy are inert on plain HTTP (dev) and have no app dependency to
// break; Permissions-Policy only denies browser APIs (camera/mic/geolocation/...) that
// nothing in this app calls (verified: no navigator.mediaDevices/geolocation/clipboard
// usage anywhere in app/).
//
// The one header that CAN break things — Content-Security-Policy (needs a per-request
// nonce, and would break `next dev`'s eval-based Fast Refresh) — is NOT here. It's set
// in middleware.ts instead, production-only, only on the two HTML routes ("/", "/public").
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};

export default withSentryConfig(nextConfig, {
  // Org/project from the Sentry onboarding wizard.
  org: "meta-most-recent",
  project: "javascript-nextjs",

  // Only print SDK build logs when running the build locally, not on CI.
  silent: !process.env.CI,

  // Upload a wider set of source maps for readable stack traces (applies to webpack + turbopack).
  widenClientFileUpload: true,

  // Auth token for uploading source maps at build time. Set SENTRY_AUTH_TOKEN in the env.
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // NOTE: Vercel cron monitoring (_experimental.vercelCronsMonitoring) was REMOVED 2026-07-25.
  // The span-based check-ins were systematically unreliable — the "completed" check-in didn't
  // register before the serverless function froze, so Sentry declared spurious "timeout
  // check-in" failures on crons that ran fine (apidrop-check, then apiinfluencer-cache — 2/2
  // false positives, incl. a single-schedule cron). Cron health is covered by the app's own
  // checks (autopilot verifies the daily run) instead. The orphaned Sentry monitors must be
  // deleted in the Sentry UI, or they'll flip to "missed check-in" alerts.
});
