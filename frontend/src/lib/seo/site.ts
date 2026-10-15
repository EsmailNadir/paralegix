/**
 * Canonical site identity for metadata, robots, and the sitemap.
 *
 * `SITE_URL` is the origin absolute URLs are built from (Open Graph images,
 * canonicals, sitemap entries). Override it per deployment with
 * `NEXT_PUBLIC_SITE_URL`; the default is production.
 *
 * `IS_INDEXABLE` gates whether crawlers are welcome at all. Staging serves the
 * same pages as production, so without this it would be indexed as duplicate
 * content and compete with the real site. Vercel sets `VERCEL_ENV` to
 * "production" only on the production deployment of a project, which makes it
 * the right signal: preview builds and the staging project both resolve false.
 * Local `npm run build` has no `VERCEL_ENV` and so is also treated as
 * non-indexable, which is the safe default.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.paralegix.com';

export const IS_INDEXABLE = process.env.VERCEL_ENV === 'production';

/** Public marketing surface - the only routes offered to crawlers. */
export const PUBLIC_ROUTES = [
  '/',
  '/features',
  '/workflow',
  '/pricing',
  '/login',
  '/register',
  '/terms',
  '/privacy',
  '/subprocessors',
] as const;

/**
 * Authenticated app, token-gated flows, and error surfaces. None of these render
 * meaningful HTML to a crawler (they gate on client-side auth and prerender to a
 * loading shell), and several carry single-use tokens in the path.
 */
export const DISALLOWED_PATHS = [
  '/api/',
  '/dashboard',
  '/lawfirm/',
  '/client/',
  '/admin',
  '/account',
  '/onboarding/',
  '/auth/',
  '/share/',
  '/signature',
  '/verify-email',
  '/complete-registration',
  '/reset-password',
  '/accept-invite',
  '/accept-member-invite',
  '/register/invite',
  '/register/member-invite',
  '/auth-required',
  '/access-denied',
  '/invalid-link',
  '/maintenance',
] as const;
