# AGENTS.md: Frontend

**All frontend UI guidance lives in the `paralegix-frontend` skill**
(`.claude/skills/paralegix-frontend/`). Invoke it before building or changing anything visible:
a page, panel, modal, form, list, table, card, button, badge, pill, dropdown, menu, tab, toggle,
empty state, spinner, or toast.

It holds the decision procedure, the exemplar file to copy for each surface, the measured values
for every primitive, the full inventory of `src/components/ui/`, the token vocabulary, and the
list of files that look like precedent but are drift.

This file is deliberately thin so there is one source of truth. Add new frontend patterns to the
skill, not here.

## The one thing to know without opening anything

Paralegix has one settled visual language. Your job is to **reproduce it, never to design**.
Every value you might reach for (radius, padding, font size, colour, gap, duration) is already
decided somewhere in `frontend/src`. Open the nearest existing equivalent and copy its skeleton
before writing anything.

The test: someone scrolling the app must not be able to tell which screen was built most
recently. If your UI is identifiable as new, it is wrong, regardless of whether it looks good on
its own.

## Stack

Next.js 16 (App Router), React 19, TypeScript strict, Tailwind v4, TanStack React Query.
`package.json` is the dependency list; these are the parts you would otherwise guess wrong:

- `lucide-react` is the **only** icon set. `check-ui.sh` flags a `@heroicons` import.
- There is **no component library**. MUI, Chakra, Ant and AG Grid are not installed and must not
  come back. Every primitive is local, in `src/components/ui/`.
- Path alias `@/*` maps to `./src/*`.
- PDF work uses `react-pdf` / `@react-pdf/renderer` for rendering. An HTML template's PDF export
  is rendered by the backend (`templatesService.renderPdf`, Chromium on the document worker); the
  frontend ships no browser.
- The rest of the stack you would otherwise have to discover: `TipTap` (rich text), `dnd-kit`
  (drag and drop), `Framer Motion` (animation), `recharts` (charts), `firebase` (auth only;
  file storage is GCS behind the backend), `@supabase/supabase-js` (Realtime messaging only, never as a data store).

## Layout

- `src/app/` : App Router pages
- `src/components/` : `[domain]Comp/` folders plus `ui/` (shared primitives), `pdf/`,
  `providers/`, `sidebar/`, and nine loose top-level components (`LoadingSpinner`,
  `ErrorNotification`, `SuccessNotification`, `ConsoleNoiseFilter`, `AnalyticsSession`, and
  four banners)
- `src/services/` : API layer, one class per domain
- `src/hooks/` : `[domain]Hooks/` per domain. `useAuth.ts` holds Firebase auth state and is NOT
  a context; it subscribes to `onAuthStateChanged`
- `src/contexts/` : `AppShellContext`, `BillingTimerContext`, `CalendarSyncContext`,
  `ClientPortalContext`, `FileExportContext`, `FileUploadContext`, `FirmSettingsContext`, `LawFirmContext`,
  `NavigationContext`, `PermissionsContext`, `PreferencesContext`, `ProfileContext`
- `src/types/`, `src/styles/global.css` (design tokens + Tailwind theme registration)

**Key routes**: `/dashboard`, `/lawfirm/[lawFirmId]/{matters,tasks,messages,calendar}`,
`/lawfirm/[lawFirmId]/settings/*`, `/client/*`, `/verify-email`, `/auth/action`,
`/complete-registration`, `/register/{invite,member-invite}`, `/accept-{invite,member-invite}`,
`/onboarding/plan`, and `/admin/*` (eight pages: firms, clients, users, logins, whitelist and
test accounts, a separate surface from the firm app).

## Theming

CSS custom property tokens in `src/styles/global.css` (`:root` light, `.dark` dark). Tailwind
`@theme inline` maps them to utility classes. Dark mode is class-based (`.dark` on `<html>`).

Key semantic tokens: `bg-page`, `bg-surface`, `bg-surface-alt`, `bg-surface-hover`,
`text-on-surface`, `text-on-surface-secondary`, `text-on-surface-muted`, `border-outline`,
`border-outline-subtle`, `bg-input-bg`, `border-input-border`. Prefer tokens over hardcoded
colors; the full vocabulary is in the `paralegix-frontend` skill's `references/tokens.md`.

`PreferencesContext` owns sidebar, dashboard widgets and theme; reach it via `usePreferences()`.

## Auth & email verification

1. Email/password: `signUp()` → verify email → `/verify-email`
2. OAuth: Google/Microsoft popup → `/complete-registration` (userType selection) → dashboard
3. Login: sign-in → `isEmailVerified(user)` → dashboard or `/verify-email`
4. Verification link: `/auth/action?mode=verifyEmail` → `applyActionCode()` → login
5. Route protection: the lawfirm, client and dashboard layouts each check `isEmailVerified(user)` and redirect

OAuth users always arrive with `emailVerified: true` from the provider.

## Linting

ESLint flat config (`eslint.config.mjs`). Relaxations: `no-explicit-any` off,
`no-unescaped-entities` off, `no-unused-vars` warn. TypeScript strict mode is on.

Three React Compiler rules from `eslint-config-next` 16 are also off: `react-hooks/immutability`,
`react-hooks/refs` and `react-hooks/purity`. A triage found every report was an intentional React
idiom or a false positive. The other two compiler rules, `set-state-in-effect` and
`preserve-manual-memoization`, stay ENFORCED: do not disable them file-wide. Annotate a single
legitimate site with a specific `eslint-disable` reason instead.

## Environment (`.env.local`)

`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_SUPABASE_*` (Realtime messaging),
`NEXT_PUBLIC_DOCS_URL` (docs origin the `/docs` entry page hands off to), `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST`, `NEXT_PUBLIC_DUP_FETCH_WARN`,
`NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` (analytics; unset means off), and
`NEXT_PUBLIC_POSTHOG_UI_HOST` (the PostHog app origin, default `https://us.posthog.com`).

## Product analytics

`src/lib/analytics/analytics.ts` is the only importer of `posthog-js`. Call `track()` with a
name from its `AnalyticsEvent` union, on a confirmed server success, with IDs, enums, counts and
booleans only: never a name, email, amount or free text. `sanitize.ts` strips query strings and
the `/share/` and `/intake/` tokens from every URL before an event leaves the browser, and cuts
an exception down to its type and stack locations, since an error message can quote client data.
Analytics starts through `lib/analytics/consent.ts`, never `initAnalytics()` directly: EU, EEA,
UK, Swiss and Canadian visitors (by `/api/consent-region`, which reads Vercel's IP country) must
accept first, and a decline from Cookie settings is honoured everywhere. Local, staging and
production each have their own PostHog project token.

## Data access boundary

The frontend never connects to Postgres or imports Drizzle. It calls the backend through the
service layer. Drizzle is the backend's required application query layer; schema and migration
ownership remain SQL-first in `backend/db/`.

For UI dependencies and local primitives, follow the Stack section above.

```bash
npm run dev          # Next.js on Turbopack, port 3000
npm run build        # compile shared document-layout, then `next build --webpack`
npm run lint
npm run ci:checks    # lint + typecheck + SEVEN guards (see below)
```

`ci:checks` runs lint, typecheck, then the seven guards below. Five of them (`check:class-migration`,
`check:money-format`, `check:date-helpers`, `check:modal-sizing`, `check:dialog-shell`) enforce rules that are otherwise
only prose:

| Guard | Forbids |
|---|---|
| `check:dead-exports` | Exports with no external reader, after filtering Next.js convention exports and the explicit baseline |
| `check:service-transport` | Bypassing the service layer's transport |
| `check:class-migration` | A UI-primitive migration that silently changed a rendered class |
| `check:money-format` | Hand-formatted currency. `toFixed(2)` beside a literal `$` renders `$12500.00` where `Intl.NumberFormat` renders `$12,500.00` |
| `check:modal-sizing` | Sizing a dialog from the call site. `<Modal>` owns its width and height; a `max-w-*` or `max-h-*` in `className` is dropped at render, so pass `size` and `height` |
| `check:dialog-shell` | A `role="dialog"` outside `ui/Modal`. Nested dialogs pass `stacked`; a save in flight passes `dismissible={false}` |
| `check:date-helpers` | Inline date comparison and day-only parsing. Everything goes through `lib/utils/dateUtils.ts`. The backend enforces the same thing with the `paralegix/explicit-date-timezone` ESLint rule, which the frontend cannot reuse |

Shared document helpers come from `@paralegix/document-layout` in `backend/document-layout/`.
See `backend/AGENTS.md` for ownership; the frontend build compiles that package first.

Dev runs on Turbopack and production builds on webpack by design (`pdfjs-dist` 5.x breaks under
webpack's eval-based dev devtools). Each has its own alias block in `next.config.ts`
(`turbopack.resolveAlias` vs the `webpack()` hook), so a bundler-level change must be made in
**both**. `next build` type-checks but does not lint, so a
type error fails the Vercel build while a lint error does not.

## Tests

Tests are required, not optional. The suite layout, the global-mock trap and the
`tests/support/` transport harness load from `.claude/rules/frontend-tests.md` when you open
anything under `frontend/tests/`. Follow `test-driven-development` and `thorough-testing`.

## Verify your own work

```bash
bash .claude/skills/paralegix-frontend/scripts/check-ui.sh
```

Run it on your changed files before saying you are done.
