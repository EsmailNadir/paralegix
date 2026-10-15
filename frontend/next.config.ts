import type { NextConfig } from "next";
import path from "path";

// CSP connect-src needs an origin, not the full API base URL (which includes
// a /api path) — CSP source matching considers the path component, so a path
// suffix here would wrongly scope the directive to that one path.
const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api").origin;
  } catch {
    return "";
  }
})();

// PostHog ingestion host for the project's region, and the matching static
// asset host (`us.i.posthog.com` serves its scripts from `us-assets.i.posthog.com`).
const posthogHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const posthogAssetHost = posthogHost.replace(".i.posthog.com", "-assets.i.posthog.com");

// Dev-only tunnel support. A phone testing a wallet flow cannot reach
// localhost, so the dev app is served through one public HTTPS tunnel: with
// DEV_API_PROXY_TARGET set (e.g. http://localhost:5001), /backend-api/* is
// forwarded to that API, and NEXT_PUBLIC_API_URL can point at
// https://<tunnel>/backend-api. DEV_ALLOWED_ORIGINS (comma-separated hosts)
// lets the tunnel's host load dev resources. Both stay unset everywhere else.
const devApiProxyTarget = (process.env.DEV_API_PROXY_TARGET || "").replace(/\/+$/, "");
const devAllowedOrigins = (process.env.DEV_ALLOWED_ORIGINS || "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  /* config options here */
  // Analytics is proxied through this origin at /ingest (see
  // src/lib/analytics/analytics.ts). PostHog's API paths end in a slash, and
  // Next's default trailing-slash redirect would break them.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: `${posthogAssetHost}/static/:path*` },
      { source: "/ingest/array/:path*", destination: `${posthogAssetHost}/array/:path*` },
      { source: "/ingest/:path*", destination: `${posthogHost}/:path*` },
      ...(devApiProxyTarget
        ? [{ source: "/backend-api/:path*", destination: `${devApiProxyTarget}/api/:path*` }]
        : []),
    ];
  },
  ...(devAllowedOrigins.length ? { allowedDevOrigins: devAllowedOrigins } : {}),
  // Hide the framework's dev-only bottom-corner indicator (dev builds only; it
  // never renders in production). It overlaps nothing on the firm side but sits
  // in the empty bottom-right corner of the client portal, where it reads as a
  // stray floating button.
  devIndicators: false,
  outputFileTracingRoot: path.join(process.cwd(), ".."),
  // No image optimizer. The only remote images are firm logos behind signed
  // storage links that change whenever the API re-signs them, so Vercel's
  // optimizer, which caches by URL, re-fetched and re-resized the same logo
  // for every new signature against its monthly quota. `next/image` now hands
  // the browser the link as it is.
  images: {
    unoptimized: true,
  },
  // Dev runs on Turbopack (the Next 16 default) — it serves ESM natively without
  // webpack's eval-based dev devtools, which pdfjs-dist 5.x is incompatible with
  // (the eval wrapping triggers "Object.defineProperty called on non-object" when
  // react-pdf loads). Turbopack also gives much faster cold starts / HMR.
  turbopack: {
    resolveAlias: {
      // Exclude the optional Node-only `canvas` dep that pdfjs-dist/react-pdf pulls in.
      canvas: "./empty-module.ts",
    },
  },
  // Production builds run on webpack (`next build --webpack`), which uses
  // source-map (not eval) devtools, so pdfjs works there without the workaround.
  webpack: (config) => {
    // react-pdf requires canvas to be excluded from client bundles
    config.resolve.alias.canvas = false;
    return config;
  },
  // Baseline security headers on every response. The CSP is deliberately limited
  // to directives that don't constrain how scripts or styles load: no script-src
  // or style-src is set (the app uses Next's inline runtime + inline styles +
  // third-party widgets, so restricting those needs separate validation). The
  // included directives are safe hardening: object-src 'none' blocks plugin
  // embeds, base-uri 'self' blocks <base> hijacking, frame-ancestors 'self'
  // mirrors the existing X-Frame-Options to prevent clickjacking, form-action
  // 'self' stops forms from being redirected off-app, and connect-src caps
  // where fetch/XHR/WebSocket calls can go — without a script-src this doesn't
  // stop an XSS payload from running, but it does stop one from exfiltrating
  // data (e.g. the Firebase refresh token) to an attacker-controlled host.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: [
              "object-src 'none'",
              "base-uri 'self'",
              "frame-ancestors 'self'",
              "form-action 'self'",
              `connect-src 'self' ${apiOrigin} https://*.googleapis.com https://*.supabase.co wss://*.supabase.co`,
            ].join("; "),
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
