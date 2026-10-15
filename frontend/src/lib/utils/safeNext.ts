/**
 * Validate a post-login return path taken from the `next` query parameter.
 *
 * The parameter is attacker-controllable: anyone can send a victim a
 * `/login?next=...` link. Returning it unchecked is a classic open redirect,
 * which turns the product's own login page into a credible phishing hop. Only a
 * same-origin, non-protocol-relative absolute path is accepted; everything else
 * resolves to null and the caller falls back to its normal destination.
 *
 * Rejected shapes and why:
 *   `//evil.com`   - protocol-relative; the browser treats it as cross-origin
 *   `/\evil.com`   - some parsers normalize the backslash to a slash
 *   `https://...`  - absolute, cross-origin
 *   `javascript:`  - script execution, not navigation
 *   `/login`       - would bounce back to this page forever
 *
 * The login check matches on a path segment, not a string prefix, so a route
 * that merely starts with those characters (`/login-history`) still round-trips.
 */
const MAX_NEXT_LENGTH = 2048;

export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > MAX_NEXT_LENGTH) return null;

  // Must be an absolute path, and the second character must not turn it into a
  // protocol-relative or backslash-smuggled cross-origin reference.
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;

  // Defense in depth: resolve against a throwaway origin and confirm nothing in
  // the string escaped it.
  try {
    const resolved = new URL(raw, 'https://placeholder.invalid');
    if (resolved.origin !== 'https://placeholder.invalid') return null;
    if (resolved.pathname === '/login' || resolved.pathname.startsWith('/login/')) return null;
    // The hash never reaches the server and cannot redirect anywhere, so it is
    // safe to carry - and dropping it would lose an in-page anchor the link
    // deliberately targeted.
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}
