// Shared Sentry secret-scrubber, used by all three init points
// (sentry.server.config.ts, sentry.edge.config.ts, instrumentation-client.ts).
//
// Two distinct sources of a credential in a URL Sentry might capture:
//   1. middleware.ts's `?token=`/`?key=` (single-use dashboard login link / manually-typed
//      DASHBOARD_SECRET) — lands in event.request.url / event.request.query_string, and in
//      navigation breadcrumbs, for that one request.
//   2. Outgoing calls to market-data providers (FMP `?apikey=`, NewsAPI `?apiKey=`, YouTube
//      `?key=`, see lib/analyst.ts, lib/earnings.ts, lib/market-data.ts,
//      lib/influencer-signals.ts) — Sentry's HTTP auto-instrumentation (tracesSampleRate: 1.0)
//      records these as child spans on every trade/analysis run, storing the request URL in
//      event.spans[].data, and as 'http' breadcrumbs — a different capture point from #1,
//      needing separate handling.
// Matched case-insensitively since real-world providers spell it differently
// (apikey/apiKey/APIKEY) — see [[lib/market-data.ts]] etc. for the actual call sites.
const SENSITIVE_PARAMS = new Set(["token", "key", "apikey"]);

function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAMS.has(name.toLowerCase());
}

function scrubUrl(raw: string): string {
  let url: URL;
  try {
    // Accept both absolute URLs and relative paths (breadcrumb/request/span data uses both).
    url = new URL(raw, "http://localhost");
  } catch {
    return raw; // not a URL-shaped string — leave untouched
  }
  let changed = false;
  for (const name of [...url.searchParams.keys()]) {
    if (isSensitiveParam(name)) {
      url.searchParams.set(name, "[Filtered]");
      changed = true;
    }
  }
  if (!changed) return raw;
  return raw.includes("://") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

// Some span/breadcrumb attributes hold a bare query string ("apikey=abc&x=1", no leading "?"
// or scheme/host) rather than a full URL — scrubUrl's URL-parse would treat that as a path
// segment and miss it, so query-shaped strings get their own scrubber.
function scrubBareQueryString(raw: string): string {
  const params = new URLSearchParams(raw);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (isSensitiveParam(name)) {
      params.set(name, "[Filtered]");
      changed = true;
    }
  }
  return changed ? params.toString() : raw;
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
  if (typeof qs === "string") return scrubBareQueryString(qs);
  if (Array.isArray(qs)) {
    return qs.map(([k, v]): [string, string] => (isSensitiveParam(k) ? [k, "[Filtered]"] : [k, v]));
  }
  const out: Record<string, string> = { ...qs };
  for (const k of Object.keys(out)) {
    if (isSensitiveParam(k)) out[k] = "[Filtered]";
  }
  return out;
}

// Outgoing-HTTP-call spans (the market-data-provider requests, auto-instrumented at
// tracesSampleRate: 1.0) store their URL in span.data under a key whose exact name varies by
// SDK/semantic-convention version ("url", "http.url", "url.full") and sometimes as a
// query-only fragment ("http.query", "url.query") rather than a full URL — key-name-sniff
// which scrubber applies, since a bare query string and a full URL need different parsing.
function scrubSpanData(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (lower.endsWith("query")) {
      out[key] = scrubBareQueryString(value);
    } else if (lower.endsWith("url") || lower.endsWith("full")) {
      out[key] = scrubUrl(value);
    }
  }
  return out;
}

/**
 * Scrubs event.request.url, event.request.query_string, span data (outgoing-HTTP-call spans),
 * and any breadcrumb URL fields. Shared by beforeSend / beforeSendTransaction.
 */
export function scrubEvent<
  T extends {
    request?: { url?: string; query_string?: QueryParams };
    breadcrumbs?: import("@sentry/nextjs").Breadcrumb[];
    spans?: Array<{ data?: Record<string, unknown> }>;
  },
>(event: T): T {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  if (event.request?.query_string) event.request.query_string = scrubQueryString(event.request.query_string);
  event.breadcrumbs = event.breadcrumbs?.map(scrubBreadcrumb);
  event.spans = event.spans?.map((span) => (span.data ? { ...span, data: scrubSpanData(span.data) } : span));
  return event;
}

/** Standalone beforeBreadcrumb hook — scrubs a breadcrumb before it's ever retained in the
 * client's in-memory buffer, not just right before upload (what beforeSend/beforeSendTransaction
 * cover). Without this, a scrubbed-at-send credential still sat in memory in cleartext for the
 * whole session up to that point. */
export const beforeBreadcrumb = scrubBreadcrumb;
