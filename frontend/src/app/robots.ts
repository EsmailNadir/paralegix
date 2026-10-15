import type { MetadataRoute } from 'next';
import { SITE_URL, IS_INDEXABLE, DISALLOWED_PATHS } from '@/lib/seo/site';

export default function robots(): MetadataRoute.Robots {
  if (!IS_INDEXABLE) {
    // Staging and preview deployments serve the same pages as production, so
    // they are closed to crawlers entirely rather than risk duplicate content.
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [...DISALLOWED_PATHS],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
