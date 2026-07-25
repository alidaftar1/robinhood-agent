// Sentry — server-side init (Node.js runtime: API routes, the 8am autopilot cron,
// the analysis/scoring pipeline, Robinhood MCP calls). Loaded by instrumentation.ts.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Tracing stays: it's the transport for AI monitoring's gen_ai spans (needs > 0).
  // Low traffic, so 1.0 is fine. Logs trimmed 2026-07-25 (redundant with Vercel logs).
  tracesSampleRate: 1.0,

  // Verbose SDK logging only outside production, to debug the setup itself.
  debug: process.env.SENTRY_DEBUG === "1",
});
