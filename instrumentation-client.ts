// Sentry — browser init (the dashboard UI). In SDK v10 this file replaces the old
// sentry.client.config.ts and is picked up automatically by Next.js.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 1.0,

  // Session Replay (the "Watch real user sessions" product). Record only a sample of
  // ordinary sessions, but every session that hits an error.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],

  enableLogs: true,
  debug: false,
});

// Instruments Next.js App Router client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
