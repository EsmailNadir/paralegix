// Public link routes whose next path segment is a bearer token: anyone holding
// the URL can open the shared files, the intake form or the payment link. The
// frontend's analytics sanitizer (frontend/src/lib/analytics/sanitize.ts)
// redacts the same three before a URL reaches PostHog; this does it before a
// URL reaches the server logs.
const SECRET_PATH_RE = /^(\/api\/(?:share|intake|pay)\/)[^/?#]+/;

/** What the token segment is replaced with, so the route shape still groups in logs. */
export const REDACTED_SEGMENT = ':token';

/**
 * The URL with a public link's token replaced by `:token`. Every other URL,
 * and anything after the token (a sub-path or a query string), is unchanged.
 */
export function redactSecretPath(url: string): string {
  return url.replace(SECRET_PATH_RE, `$1${REDACTED_SEGMENT}`);
}
