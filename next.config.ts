import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {};

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
