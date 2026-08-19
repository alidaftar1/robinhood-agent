// Sentry — server-side init (Node.js runtime: API routes, the 8am autopilot cron,
// the analysis/scoring pipeline, Robinhood MCP calls). Loaded by instrumentation.ts.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent, beforeBreadcrumb } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Tracing stays: it's the transport for AI monitoring's gen_ai spans (needs > 0).
  // Low traffic, so 1.0 is fine. Logs trimmed 2026-07-25 (redundant with Vercel logs).
  tracesSampleRate: 1.0,

  // Verbose SDK logging only outside production, to debug the setup itself.
  debug: process.env.SENTRY_DEBUG === "1",

  // Strip the dashboard login credential (?token=/?key=, see middleware.ts) and any
  // data-provider API key (?apikey=/?apiKey=, see lib/analyst.ts, lib/earnings.ts,
  // lib/market-data.ts, lib/influencer-signals.ts) out of any URL/span/breadcrumb
  // captured on an error or transaction event before it reaches Sentry.
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  // Scrubs a breadcrumb before it's retained in the in-memory buffer, not just right
  // before upload — closes the window where a scrubbed-at-send credential still sat in
  // memory in cleartext for the rest of the session.
  beforeBreadcrumb,
});
