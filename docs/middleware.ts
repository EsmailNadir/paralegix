import { next } from '@vercel/edge';

/**
 * Sign-in gate for the documentation site.
 *
 * This is a static VitePress build, so there is no server to check a session on:
 * the gate has to run at the edge, in front of every response. It verifies the
 * `plx_docs` cookie that the API issues (backend/src/modules/auth/docsSession.js)
 * after checking a Firebase ID token, using the same shared secret. Verification
 * is a local HMAC check, so no network call and no Firebase credentials are
 * needed here.
 *
 * Anyone without a valid cookie is sent to the app's /docs entry page, which
 * signs them in if needed, mints a fresh cookie, and returns them to the page
 * they asked for. An expired cookie therefore renews itself on the next
 * navigation instead of showing a login wall.
 *
 * Every path is gated, not just HTML. VitePress compiles each page's prose into
 * its own JS chunk, so gating navigations alone would leave the whole guide
 * readable through the asset URLs listed in the build manifest.
 */

// Must match the backend's DOCS_COOKIE_NAME (docsSession.ts) exactly — both
// default to 'plx_docs', but production and staging share the .paralegix.com
// parent domain, so an operator who sets DOCS_COOKIE_NAME on one backend to
// keep the two environments' cookies from colliding needs to set the same
// value here too.
const COOKIE_NAME = process.env.DOCS_COOKIE_NAME || 'plx_docs';

/** Static assets that must stay reachable so the redirect itself renders cleanly. */
const PUBLIC_PATHS = new Set(['/favicon.ico', '/favicon.svg', '/docs/favicon.ico', '/docs/favicon.svg']);

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Backed by an explicit ArrayBuffer: WebCrypto's BufferSource excludes
// SharedArrayBuffer, which a bare `new Uint8Array(n)` does not rule out.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function isValidSession(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  try {
    // Pin the algorithm before verifying. Trusting the token's own `alg` is how
    // "none" and RS256-key-confusion forgeries get accepted.
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader)));
    if (header.alg !== 'HS256') return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signed = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!signed) return false;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
    // A token minted for anything other than the docs must not open the docs.
    if (payload.scope !== 'docs') return false;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return next();

  const secret = process.env.DOCS_SESSION_SECRET;
  const appUrl = process.env.DOCS_APP_URL;

  // Fail CLOSED. A misconfigured deploy that served the guide to everyone would
  // look completely healthy, so an unconfigured gate refuses instead.
  if (!secret || !appUrl) {
    return new Response(
      'Documentation access is not configured. Set DOCS_SESSION_SECRET and DOCS_APP_URL on this deployment.',
      { status: 503, headers: { 'content-type': 'text/plain' } },
    );
  }

  const token = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (token && (await isValidSession(token, secret))) return next();

  const returnTo = `${url.pathname}${url.search}`;
  return Response.redirect(`${appUrl}/docs?to=${encodeURIComponent(returnTo)}`, 302);
}

export const config = {
  // Run on everything. The exclusions above are handled in code so that adding
  // one does not mean editing a regex.
  matcher: '/:path*',
};
