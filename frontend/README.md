# Paralegix Frontend

Next.js 16 (App Router) client for Paralegix, a legal practice management SaaS. Firm members
and clients (separate portal) manage matters, tasks, billing, trust accounting, files,
e-signatures, calendar, and messaging.

> UI conventions (navigation, page/modal/form patterns, shared components, theming) live in
> [`AGENTS.md`](./AGENTS.md). This README is the getting-started map.

## Quick Start

```bash
npm install
npm run dev          # Next.js dev server, port 3000
npm run build        # production (--webpack; ESLint ignored via next.config.ts)
npm run lint
npm run ci:checks    # lint + legacy-route guard + service-transport guard
```

Requires `.env.local` with `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_*`, and
`NEXT_PUBLIC_SUPABASE_*` (Realtime messaging).

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · TanStack React Query v5 · Firebase Auth ·
Supabase Realtime · TipTap · Framer Motion · dnd-kit · recharts · lucide-react (the only icon set).

- **Rendering**: the app surfaces are client-side (`"use client"` on pages). The marketing and
  legal pages, plus `sitemap.ts`, `robots.ts` and `opengraph-image.tsx`, are server components.
- **State**: React Query for server state, React Context for app state. No Redux/Zustand.
- **Firebase client imports must be dynamic `import()`** — never static top-level (SSR).

## Structure

```
src/
├── app/          # App Router pages + layouts
├── components/   # [domain]Comp/ folders + ui/ shared primitives
├── hooks/        # [domain]Hooks/ per domain
├── services/     # API service classes (one per domain)
├── contexts/     # Ten providers: Permissions, Preferences, Navigation, LawFirm, etc.
├── constants/    # statusMeta.ts, taskConstants.ts, stageColors.ts
├── config/       # static config maps
├── utils/        # shared helpers
├── lib/          # Firebase config, Supabase realtime client, API/error utils
├── types/        # TypeScript types
└── styles/       # global.css — design tokens + Tailwind theme
```

Path alias: `@/*` → `./src/*`.

## Routes

**Firm member** (`/lawfirm/[lawFirmId]/...`): `matters`, `matters/[matterId]`, `tasks`,
`clients`, `billing`, `calendar`, `messages`, `files`, `signatures`, `templates`, `trust`,
`leads`, `contacts`, `notes`, `notifications`, `client-invoice/[invoiceId]`, `get-started`,
and `settings/*` (general, members, roles,
billing, payments, customization, charge-codes, courts, practice-area, matter-config,
matter-fields, matter-stages, lead-stages, deadline-sets, intake-forms,
document-request-templates, notifications, getting-started).

**Client portal** (`/client/...`): `dashboard`, `lawfirm/[lawFirmId]` (hub, matters,
billing, documents, trust, settings), `messages`.

**Auth**: `/login`, `/register`, `/register/invite`, `/register/member-invite`,
`/accept-invite`, `/accept-member-invite`, `/verify-email`, `/complete-registration`,
`/auth/action` (Firebase verifyEmail/resetPassword), `/auth/reconnect` (calendar tokens).

**Admin** (`/admin/...`): dashboard, `lawfirms`, `lawfirms/[lawFirmId]`, `clients`, `users`,
`logins`, `whitelist`, `test-accounts`.

## Components

Domain folders under `src/components/[domain]Comp/` co-locate a Grid + Create/Edit modals
(e.g. `matterComp/`, `taskComp/`, `billingComp/`, `trustComp/`, `filesComp/`,
`messagesComp/`, `signaturesComp/`, `templatesComp/`, `clientComp/`, `settingsComp/`).

Shared primitives live in `src/components/ui/` (87 files) — reuse, never recreate: `Button`,
`Dropdown`, `ListView`, `ConfirmModal`, `ErrorToast`, `Spinner`, `RequirePermission`,
`RequireFeature`, `PageHeader`, `ToggleSwitch`, `StatusBadge`,
`SelectablePersonList`, `ParalegixLogo`. The full inventory is in the `paralegix-frontend`
skill's `references/components.md`.

## Data Fetching

```
Component → React Query hook → Service method → apiFetch → fetch()
                                                    ↓
                                            Firebase ID token (cached) + X-Timezone header
```

| Utility | File | Purpose |
|---|---|---|
| `apiFetch()` | `lib/utils/fetchWithTokenRefresh.ts` | fetch wrapper, auto-retry once on 401 |
| `requestDeduplicator` | `services/requestDeduplicator.ts` | dedupes identical concurrent GETs |
| `ApiError` | `lib/utils/apiErrors.ts` | normalized error (status, code, details, requestId) |

Services throw `ApiError` on failure so status/code/details survive to the UI. Render via
`getErrorMessage(err)` or pass the Error to `<ErrorNotification />`.

## Real-Time (Supabase)

Messaging, notifications, and the signing flow subscribe to **Supabase Realtime** channels
(Postgres change events over a Firebase-UID JWT, gated by RLS) — see
`hooks/useConversations.ts`, `useConversationMessages.ts`,
`notificationHooks/useNotificationsRealtime.ts`, `useSigningRealtime.ts`, and
`lib/supabase/realtimeClient.ts`. All other data flows over the REST API.

## State & Permissions

Auth is **not** a context: read the Firebase user through `useAuth()` from `@/hooks/useAuth`.
Context providers (per `lawFirmId` unless noted): `PermissionsContext`, `FirmSettingsContext`,
`PreferencesContext` (sidebar/dashboard/theme), `NavigationContext` (app root),
`AppShellContext`, `LawFirmContext`, `ProfileContext`, `ClientPortalContext`,
`CalendarSyncContext`, `BillingTimerContext`.

Frontend RBAC is **UI-only** — the backend enforces every permission. Gate with
`usePermissions().hasPermission("domain.action")` or `<RequirePermission permission="...">`.

## Theming

CSS custom-property tokens in `src/styles/global.css` (`:root` light, `.dark` dark), mapped
to utilities via Tailwind `@theme inline`. Prefer semantic tokens (`bg-page`, `bg-surface`,
`text-on-surface`, `border-outline`, `bg-input-bg`, …) over hardcoded colors. Dark mode is
class-based (`.dark` on `<html>`), with a pre-paint hydration script reading localStorage.

## Environment

All frontend vars are `NEXT_PUBLIC_`-prefixed (client-side, safe by design):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend API URL (default `http://localhost:5001/api`) |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase client config (auth) |
| `NEXT_PUBLIC_SUPABASE_*` | Supabase URL + anon key (Realtime messaging) |
