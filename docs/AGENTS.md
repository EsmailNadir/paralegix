# AGENTS.md — Docs

This is the Paralegix documentation site. It is a **VitePress** site, completely separate
from the `frontend/` and `backend/` apps (its own `package.json` and `node_modules`). Use
this file when working anywhere under `docs/`.

## Dev Commands

Run from `docs/`:

```bash
npm install          # first-time setup (separate node_modules from the app)
npm run dev          # VitePress dev server, port 3005
npm run build        # production build (outputs to .vitepress/dist)
npm run preview      # serve the built site locally
```

Deployed via Vercel (`docs/vercel.json`), served under the `/docs/` base path
(`base: '/docs/'` in the config).

## Access Control (sign-in required)

The site is **not public**. `middleware.ts` (Vercel Edge Middleware) gates every
path except the four favicon paths in its `PUBLIC_PATHS` list, on a `plx_docs` cookie and redirects anyone without a valid one to the app's
`/docs` entry page, which signs them in, mints a cookie, and sends them back to the
page they asked for.

The cookie is an HS256 JWT issued by the API (`POST /api/auth/docs-session`,
`backend/src/modules/auth/docsSession.ts`) after it verifies a Firebase ID token.
It is httpOnly, scoped to the parent domain so app and docs both see it, lives 12
hours, and is cleared on sign-out. The middleware verifies it with a local HMAC
check, so the edge needs no network call and no Firebase credentials. Because
verification is offline, revocation is bounded by the 12-hour TTL rather than
immediate; nothing but the guide is readable with it.

Required env vars **on the docs Vercel project**:

- `DOCS_SESSION_SECRET` — must match the API's value exactly.
- `DOCS_APP_URL` — app origin to bounce through, e.g. `https://paralegix.com`.
- `DOCS_COOKIE_NAME`: optional, defaults to `plx_docs`. It is read by BOTH
  `docs/middleware.ts` and `backend/src/modules/auth/docsSession.ts`. Setting it on one
  side only breaks the gate, so change both or neither.

The gate **fails closed**: if either is missing the site serves 503, on the
reasoning that a docs deploy silently readable by the world looks perfectly
healthy. Set both before deploying.

The gate is Vercel-only. `npm run dev` does not run middleware, so local docs are
unauthenticated as before.

## Public vs Internal Builds (important)

The public/internal split is enforced at **build time**, not per request, in
`.vitepress/config.ts` via `srcExclude` and the `DOCS_INCLUDE_DEV` env var:

- **Default `npm run build` → PUBLIC site.** Only the polished user guide is included:
  `index.md`, `export.md`, `authentication/`, `dashboard/`, `matters/`, `tasks/`,
  `clients/`, `leads/`, `contacts/`, `calendar/`, `files/`, `messaging/`, `billing/`,
  `trust/`, `templates/`, `automation/`, `document-signing/`, `settings/`. All internal
  content is dropped (not just unlinked — the pages are never emitted).
- **`DOCS_INCLUDE_DEV=true` → ADMIN build.** Adds the top-nav **Dev** and **Future** tabs
  plus their sidebars, and includes `dev/**`, `features/**` (engineering reference),
  `future/**`, and the root ops docs (`STAGING_SETUP.md`, `TRUST_STRIPE_COMPLIANCE.md`,
  `DIRECT_CHARGE_MIGRATION.md`, `PRODUCTION_CUTOVER.md`). Meant for a private deploy
  behind Vercel password/SSO.
- `ALWAYS_EXCLUDE` in the config is `['superpowers/**', 'AGENTS.md', 'CLAUDE.md']`; those are
  dropped from every build. `superpowers/**` holds raw design specs with unclosed `<...>`
  placeholders VitePress cannot render.

When you add a new page, decide which bucket it belongs in:
- **User-facing** → put it under a guide folder AND add it to `userGuideSidebar` in the config.
- **Internal/engineering/admin** → put it under `dev/**` or `features/**` and add it to
  `devSidebar`. Do NOT leave internal pages in a public folder — they would leak into the
  public build. `features/*.md` are engineering reference (they cite `file:line`), never
  user-facing.
- **Speculative/roadmap** → put it under `future/**` and add it to `futureSidebar`.

Registering the page in a sidebar is not optional. `collectSections()` walks the sidebars,
not a glob, so a page missing from every sidebar is silently absent from the nav AND from
the "Export for AI" artifacts.

## Layout

- `.vitepress/config.ts`: site config, nav, all three sidebars (`userGuideSidebar`,
  `devSidebar`, `futureSidebar`), search provider, the public/dev exclusion globs, and the
  `buildEnd: writeExportArtifacts` hook. Edit sidebars here when adding pages.
- `.vitepress/theme/`: custom theme. `custom.css` is site styling; `index.ts` also
  registers `DocsExport.vue` and rewrites every "Back to App" link per host (localhost /
  staging / prod).
- **Export for AI**: `writeExportArtifacts` emits `paralegix-docs.txt` and
  `paralegix-docs.json` into the build, a vite dev-server plugin serves them locally, and
  `export.md` plus a nav entry surface them. Content comes from `collectSections()`, which
  walks the sidebars.
- `public/` — static assets served at the site root. It currently holds only the favicons; see the screenshots note below.
- Guide content folders: `authentication/`, `dashboard/`, `matters/`, `tasks/`, `clients/`,
  `leads/`, `contacts/`, `calendar/`, `files/`, `messaging/`, `billing/`, `trust/`,
  `templates/`, `automation/`, `document-signing/`, `settings/`.
- Internal content: `dev/**` (architecture, ops, security, admin), `features/**`
  (per-module engineering reference), `future/**` (roadmap and research notes),
  `superpowers/**` (raw design specs, always excluded from every build), and the root
  `*.md` runbooks.

## Search

**Local search (VitePress built-in) is the mode to use now.** Its index is built at compile
time from the source markdown, so it needs no crawler and works behind the sign-in gate.

`.vitepress/config.ts` configures only local search. Algolia env vars are not read.

## Screenshots (user-guide images)

**The guide currently ships with no screenshots.** The previous set was captured on
2026-07-28 and every surface it covered changed underneath it (the shared `ui/TabBar` +
count pill, the status-badge rework, the contact directory, and the trust/billing surface
rework), so the images contradicted the text they illustrated and were removed rather than
left to mislead. `public/` holds only the favicons; there is no `public/images/` directory
right now.

Recapturing is outstanding work. Pages that most want an image, in rough priority order:
the matters list and matter page, the billing hub, the invoice page, the tasks list, the
files browser, the contact directory, and the trust overview.

When you do recapture, put them back under `public/images/guide/` and reference them as
`/images/guide/<name>.png` (VitePress resolves `public/` to the site root). Give every
image descriptive alt text — that pattern held before and should hold again.

Conventions for these screenshots:
- Captured at viewport **1400x900**, then **cropped to 1400x838** to remove the bottom-left
  app bar (the user avatar / firm name and, in dev mode, the Next.js dev-tools badge that
  overlaps it). When you add or replace a guide screenshot, crop that bottom strip off too
  so it matches the rest. Pillow one-liner (`im.crop((0,0,w,838))`) works; the bar sits at
  roughly y=843–882, so 838 removes it with a small margin without touching main content.
- Capture against the seeded demo dataset on the local Podman Postgres, built by
  `npx tsx backend/db/seed/seed-local-testdata.ts` (fixed-UUID and idempotent: practice areas,
  `*.example.test` clients, matters, invoices in each status, trust ledger, and so on). It
  writes to one firm and deletes only its own rows, so re-running it is safe. Using that
  same dataset is what keeps names and numbers consistent from page to page.
- Capture with the Playwright MCP (the built-in browser screenshot action tended to time
  out here).

## Writing Conventions

- **No em dashes** in doc copy — reword with a period or comma instead.
- Engineering docs must describe Drizzle as the backend application query layer. SQL
  `schema.sql` and numbered migrations remain the database authority; do not advise direct
  raw-pool application queries.
- User-guide pages: plain, task-oriented language aimed at law-firm staff, not engineers.
  Lead with what the feature is and how to use it. Keep engineering detail in `features/**`.
- Link between guide pages with root-relative links (e.g. `[Billing](/billing/overview)`).
