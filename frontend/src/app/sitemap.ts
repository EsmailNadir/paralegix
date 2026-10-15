import type { MetadataRoute } from 'next';
import { SITE_URL, PUBLIC_ROUTES } from '@/lib/seo/site';

/**
 * Relative weighting for crawlers. The landing page leads, the three pages that
 * describe the product follow, and the sign-in/legal surface trails - those are
 * destinations people arrive at deliberately rather than discover via search.
 */
const PRIORITY: Record<string, number> = {
  '/': 1,
  '/features': 0.9,
  '/pricing': 0.9,
  '/workflow': 0.8,
  '/register': 0.6,
  '/login': 0.4,
  '/terms': 0.3,
  '/privacy': 0.3,
  '/subprocessors': 0.3,
};

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route === '/' ? '' : route}`,
    changeFrequency: 'monthly',
    priority: PRIORITY[route] ?? 0.5,
  }));
}
