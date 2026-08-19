// Sentry — browser init (the dashboard UI). In SDK v10 this file replaces the old
// sentry.client.config.ts and is picked up automatically by Next.js.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent, beforeBreadcrumb } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Tracing stays: it's the transport for AI monitoring's gen_ai spans (needs > 0).
  tracesSampleRate: 1.0,

  // Trimmed 2026-07-25: Session Replay + Logs removed — near-zero value on a
  // barely-used dashboard, and Replay was heavy client-bundle weight. Kept: error
  // monitoring + AI monitoring (+ the tracing that powers it).
  debug: false,

  // The dashboard's login redirect briefly carries ?token=/?key= (see middleware.ts).
  // Strip it out of the URL on any error/transaction/navigation-breadcrumb this
  // client captures, and out of route-change breadcrumbs too.
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb,
});

// Instruments Next.js App Router client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
