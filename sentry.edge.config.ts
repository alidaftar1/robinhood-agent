// Sentry — edge runtime init (middleware and any edge routes). Loaded by instrumentation.ts.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent, beforeBreadcrumb } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0, // stays — powers AI-monitoring gen_ai spans
  debug: false,          // Logs trimmed 2026-07-25

  // This is the runtime middleware.ts runs in — the one place ?token=/?key=
  // (dashboard login credential) legitimately appears in a URL. Strip it, and any
  // data-provider API key on an outgoing-call span, before anything leaves the process.
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb,
});
