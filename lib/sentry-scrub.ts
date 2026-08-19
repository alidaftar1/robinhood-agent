// Shared Sentry secret-scrubber, used by all three init points
// (sentry.server.config.ts, sentry.edge.config.ts, instrumentation-client.ts).
//
// Two distinct sources of a credential in a URL Sentry might capture:
//   1. middleware.ts's `?token=`/`?key=` (single-use dashboard login link / manually-typed
//      DASHBOARD_SECRET) — lands in event.request.url / event.request.query_string, and in
//      navigation breadcrumbs, for that one request.
//   2. Outgoing calls to market-data providers (FMP `?apikey=`, NewsAPI `?apiKey=`, YouTube
//      `?key=`, Finnhub `?token=` — see lib/analyst.ts, lib/earnings.ts, lib/market-data.ts,
//      lib/influencer-signals.ts) — Sentry's fetch auto-instrumentation (tracesSampleRate: 1.0)
//      records these as child spans AND as 'http' breadcrumbs on every trade/analysis run.
//      Verified against the installed SDK's own source (node_modules/@sentry/node-core's
//      outgoingFetchRequest.js / node's http.js): the query string lands in span.data under
//      "http.url"/"url.full" (full URL) and separately "http.query" (query only), and in a
//      breadcrumb's data under the same "http.query" key — Sentry's own sanitizer already
//      strips the query from breadcrumb.data.url, but NOT from http.query, so that field still
//      needs scrubbing here.
// Matched case-insensitively since real-world providers spell it differently
// (apikey/apiKey/APIKEY) — see the lib/ call sites above for the actual param names used.
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

// Shared by both spans and http breadcrumbs — both carry the same attribute shape
// (verified against the SDK source, see the file-header comment): a full-URL field under a
// key ending "url"/"full" ("url", "http.url", "url.full") and/or a query-only field ending
// "query" ("http.query"), which need different parsing since a bare query string isn't valid
// URL input on its own.
function scrubUrlLikeData(data: Record<string, unknown>): Record<string, unknown> {
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

function scrubBreadcrumb(breadcrumb: import("@sentry/nextjs").Breadcrumb): import("@sentry/nextjs").Breadcrumb {
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  const scrubbed = scrubUrlLikeData(data as Record<string, unknown>);
  // Navigation breadcrumbs' to/from fields don't end in "url"/"query"/"full", so
  // scrubUrlLikeData's key-suffix sniffing doesn't reach them — handle explicitly.
  for (const field of ["to", "from"] as const) {
    const value = scrubbed[field];
    if (typeof value === "string") scrubbed[field] = scrubUrl(value);
  }
  breadcrumb.data = scrubbed;
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

/**
 * Scrubs event.request.url, event.request.query_string, span data (outgoing-fetch-call
 * spans), and any breadcrumb URL/query fields. Shared by beforeSend / beforeSendTransaction.
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
  event.spans = event.spans?.map((span) => (span.data ? { ...span, data: scrubUrlLikeData(span.data) } : span));
  return event;
}

/** Standalone beforeBreadcrumb hook — scrubs a breadcrumb before it's ever retained in the
 * client's in-memory buffer, not just right before upload (what beforeSend/beforeSendTransaction
 * cover). Without this, a scrubbed-at-send credential still sat in memory in cleartext for the
 * whole session up to that point. */
export const beforeBreadcrumb = scrubBreadcrumb;
