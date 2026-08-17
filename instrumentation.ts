// Next.js instrumentation hook. Loads the right Sentry server/edge config per runtime,
// and forwards nested React Server Component errors to Sentry via onRequestError.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // Fail closed: every cron/dashboard route trusts CRON_SECRET to gate
    // access (see lib/cron-auth.ts). Refuse to boot without it rather than
    // silently running with every one of those routes unprotected — README
    // already documents this as a required var, this just enforces it.
    if (!process.env.CRON_SECRET) {
      throw new Error(
        "CRON_SECRET is not set. It authorizes every cron and dashboard " +
        "route (trade, autopilot, drop-check, ...) — the app must not " +
        "start without it. Set it in .env.local (dev) or the Vercel " +
        "project's environment variables (prod)."
      );
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
