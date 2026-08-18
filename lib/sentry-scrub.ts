// Shared Sentry query-string scrubber, used by all three init points
// (sentry.server.config.ts, sentry.edge.config.ts, instrumentation-client.ts).
//
// middleware.ts is the one place a login credential is allowed to appear in the
// URL: `?token=` (single-use login link) or `?key=` (manually-typed
// DASHBOARD_SECRET) — see middleware.ts for the full flow. Sentry's automatic
// request/breadcrumb capture would otherwise store that request's full URL —
// credential included — in cleartext on every event and navigation breadcrumb
// for that request. This strips just those two param VALUES wherever a URL
// shows up in a captured event, before it leaves the process.
const SENSITIVE_PARAMS = ["token", "key"];

function scrubUrl(raw: string): string {
  let url: URL;
  try {
    // Accept both absolute URLs and relative paths (breadcrumb/request data uses both).
    url = new URL(raw, "http://localhost");
  } catch {
    return raw; // not a URL-shaped string — leave untouched
  }
  let changed = false;
  for (const p of SENSITIVE_PARAMS) {
    if (url.searchParams.has(p)) {
      url.searchParams.set(p, "[Filtered]");
      changed = true;
    }
  }
  if (!changed) return raw;
  return raw.includes("://") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function scrubBreadcrumb(breadcrumb: import("@sentry/nextjs").Breadcrumb): import("@sentry/nextjs").Breadcrumb {
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  for (const field of ["url", "to", "from"] as const) {
    const value = data[field];
    if (typeof value === "string") data[field] = scrubUrl(value);
  }
  return breadcrumb;
}

// event.request.query_string is populated separately from event.request.url by Sentry's
// request-data integration, and can take any of three shapes — scrub whichever one shows up.
type QueryParams = string | Record<string, string> | Array<[string, string]>;

function scrubQueryString(qs: QueryParams): QueryParams {
  if (typeof qs === "string") {
    const params = new URLSearchParams(qs);
    let changed = false;
    for (const p of SENSITIVE_PARAMS) {
      if (params.has(p)) {
        params.set(p, "[Filtered]");
        changed = true;
      }
    }
    return changed ? params.toString() : qs;
  }
  if (Array.isArray(qs)) {
    return qs.map(([k, v]): [string, string] => (SENSITIVE_PARAMS.includes(k) ? [k, "[Filtered]"] : [k, v]));
  }
  const out: Record<string, string> = { ...qs };
  for (const p of SENSITIVE_PARAMS) {
    if (p in out) out[p] = "[Filtered]";
  }
  return out;
}

/**
 * Scrubs event.request.url, event.request.query_string, and any breadcrumb URL fields.
 * Shared by beforeSend / beforeSendTransaction.
 */
export function scrubEvent<
  T extends { request?: { url?: string; query_string?: QueryParams }; breadcrumbs?: import("@sentry/nextjs").Breadcrumb[] },
>(event: T): T {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  if (event.request?.query_string) event.request.query_string = scrubQueryString(event.request.query_string);
  event.breadcrumbs = event.breadcrumbs?.map(scrubBreadcrumb);
  return event;
}
