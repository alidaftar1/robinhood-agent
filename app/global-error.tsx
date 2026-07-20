"use client";

// Catches errors thrown in the root layout/template that ordinary error boundaries miss,
// and reports them to Sentry. Renders a minimal fallback UI.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <p style={{ padding: 24 }}>Something went wrong.</p>
      </body>
    </html>
  );
}
