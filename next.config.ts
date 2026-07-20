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

  webpack: {
    // Auto-instrument Vercel Cron Monitors → each cron in vercel.json shows up as a check-in.
    automaticVercelMonitors: true,
  },
});
