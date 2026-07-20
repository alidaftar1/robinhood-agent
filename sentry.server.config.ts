// Sentry — server-side init (Node.js runtime: API routes, the 8am autopilot cron,
// the analysis/scoring pipeline, Robinhood MCP calls). Loaded by instrumentation.ts.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Trace 100% during the trial so you can explore the product; dial down later.
  tracesSampleRate: 1.0,

  // Send structured logs to Sentry (the "Logging" product from the onboarding screen).
  enableLogs: true,

  // Verbose SDK logging only outside production, to debug the setup itself.
  debug: process.env.SENTRY_DEBUG === "1",
});
