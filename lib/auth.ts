// Shared auth gate for every cron-/secret-protected route (trade, autopilot, debug, …).
//
// FAILS CLOSED. The prior inline check was `authHeader !== `Bearer ${process.env.CRON_SECRET}``.
// If CRON_SECRET is ever unset, that template collapses to the literal string "Bearer undefined",
// so anyone sending `Authorization: Bearer undefined` sails through the check on every protected
// route — including the one that places live trades. And nothing warned you: the app ran fine
// unprotected. On a live-money app a missing secret must LOCK THE DOOR, not silently open it.
//
// So: if the secret is missing or implausibly short (a config slip), reject EVERY request with 503
// rather than comparing against a guessable string. Only a present, sufficiently-long secret that
// exactly matches the bearer token is allowed through.
//
// Credit: this fail-open gap was responsibly disclosed by Hirad Peyvandi, who found it reading
// the public repo and reported it privately instead of filing a public issue.

// A real CRON_SECRET is a long random string; anything shorter than this is a misconfiguration,
// not a deliberately weak secret. Reject rather than trust it.
const MIN_SECRET_LEN = 16;

/**
 * Returns a rejection Response if the request is not authorized, or null if it is.
 * Usage at the top of a protected route:
 *   const unauth = requireCronAuth(request);
 *   if (unauth) return unauth;
 */
export function requireCronAuth(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;

  // Fail closed on a missing/weak secret — never fall back to a guessable comparison.
  if (!secret || secret.length < MIN_SECRET_LEN) {
    return Response.json(
      { error: "Server auth is not configured" },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
