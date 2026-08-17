// Shared guard for every cron/dashboard-triggered API route.
//
// Fail-closed on purpose: `process.env.CRON_SECRET` being unset must never
// be treated as "any request is fine." Interpolating an unset env var into
// a template literal (`Bearer ${process.env.CRON_SECRET}`) silently produces
// the *string* "Bearer undefined" — a fixed, guessable value that satisfies
// a naive `authHeader !== \`Bearer ${secret}\`` check. This helper refuses
// to authorize anything when the secret isn't configured, instead of
// comparing against that stringified fallback.
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
