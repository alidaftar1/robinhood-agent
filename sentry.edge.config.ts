// Sentry — edge runtime init (middleware and any edge routes). Loaded by instrumentation.ts.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0, // stays — powers AI-monitoring gen_ai spans
  debug: false,          // Logs trimmed 2026-07-25
});
