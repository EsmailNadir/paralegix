/**
 * Session cookie for the documentation site.
 *
 * The docs site is a separate static (VitePress) deployment. It cannot call this
 * API on the user's behalf and it cannot read the Firebase session, which the
 * client SDK keeps in the app origin's IndexedDB rather than in a cookie. So the
 * app trades a verified Firebase ID token for a short-lived HS256 JWT, set as an
 * httpOnly cookie on the parent domain, and the docs deployment's edge
 * middleware verifies it offline with the same shared secret. No network hop and
 * no Firebase credentials are needed at the docs edge.
 *
 * The cookie authorizes reading the guide and nothing else: it carries no firm
 * scope and no permissions, and no API route accepts it as authentication.
 * Revocation is therefore bounded by TTL_SECONDS rather than immediate, which is
 * the trade-off that keeps verification offline. Sign-out clears it explicitly.
 */

const jwt = require('jsonwebtoken');
const { AppError } = require('../../shared/errors/AppError');

// Overridable per environment: production and staging share the
// .paralegix.com parent domain, so without distinct names each environment's
// docs session overwrites the other's cookie.
export const COOKIE_NAME = process.env.DOCS_COOKIE_NAME || 'plx_docs';
export const TTL_SECONDS = 12 * 60 * 60;

/**
 * Parent domain the cookie is scoped to (e.g. `.paralegix.com`) so that the app,
 * this API, and the docs deployment all see it. Deliberately unset in local dev,
 * where all three are `localhost`: cookies ignore ports, so a host-only cookie is
 * already shared across :3000/:3005/:5001, and `Domain=.localhost` is not
 * reliably accepted.
 */
const COOKIE_DOMAIN = process.env.DOCS_COOKIE_DOMAIN || undefined;

function getSecret() {
  const secret = process.env.DOCS_SESSION_SECRET;
  if (!secret) {
    throw new AppError(
      'Documentation access is not configured.',
      503,
      'DOCS_SESSION_UNCONFIGURED',
    );
  }
  return secret;
}

/**
 * Cookie attributes. `clearCookie` only matches a cookie by name/domain/path, so
 * issue and clear must derive them from this one place or sign-out silently
 * leaves the cookie in place.
 *
 * SameSite=Lax is sufficient because the docs host is a sibling subdomain: a
 * top-level navigation from the app to the docs site is same-site, so the cookie
 * rides along, while genuine cross-site requests do not carry it.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,
    path: '/',
  };
}

/** Mint the cookie for an already-authenticated user. Returns its lifetime. */
export function issue(res: any, { uid, email }: any) {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      sub: uid,
      email: email || null,
      scope: 'docs',
      iat: nowSec,
      exp: nowSec + TTL_SECONDS,
    },
    getSecret(),
    { algorithm: 'HS256' },
  );

  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: TTL_SECONDS * 1000 });
  return TTL_SECONDS;
}

export function clear(res: any) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}
