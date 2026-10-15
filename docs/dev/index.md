# Developer & Admin Docs

Internal documentation for engineers and firm administrators: architecture
reference, operations runbooks, and admin-facing subsystem details.

::: warning INTERNAL — NOT PUBLIC
This section is **excluded from the public documentation build**. It ships only
when the site is built with `DOCS_INCLUDE_DEV=true`, which is intended for a
private/admin-only deployment behind access control. See
[Access & gating](#access-gating) below.
:::

## Sections

### Getting Started

- [Architecture Overview](/dev/getting-started/architecture) — the system at a
  glance and the request lifecycle.
- [Local Development](/dev/getting-started/local-development) — run the stack
  locally.
- [Testing](/dev/getting-started/testing): the backend and frontend suites, the
  test database, and what to run before calling a change done.

### Concepts

- [Money Handling](/dev/concepts/money) — integer-cent math end to end.
- [Event Bus & Outbox](/dev/concepts/event-bus-outbox) — events and the durable
  outbox backstop.

### Admin

- [Rate Limiting](/dev/admin/rate-limiting) — how abuse-prone endpoints are
  throttled, what is covered, and how to tune it.

### Security & Compliance

- [Auth & Tokens](/dev/security/auth-tokens) — Firebase token model and sign-in
  flows.
- [RBAC & Permissions](/dev/security/rbac-permissions) — roles, permission codes,
  plan enforcement.
- [Multi-Tenancy & Isolation](/dev/security/multi-tenancy) — `law_firm_id`
  scoping and messaging RLS.
- [Audit Logging](/dev/security/audit-logging) — what is recorded and where.
- [Privacy & Data Rights](/dev/security/privacy-data-rights) — data-subject
  rights and email compliance.
- [PostHog Analytics & Cookie Consent](/dev/security/posthog-analytics): browser and
  server event flow, regional consent, data limits, configuration and verification.
- [Unverified-Account Sweep](/dev/security/unverified-account-sweep): how
  accounts that never verify their email are cleaned up.
- [Secrets](/dev/security/secrets) — application secrets and where they live.

### Operations

- [Cron Jobs](/dev/ops/cron-jobs) — the scheduled jobs and what breaks if they
  stop.
- [Webhooks](/dev/ops/webhooks) — inbound Stripe and calendar webhooks.
- [Environment Variables & Flags](/dev/ops/environment-variables) — every env var
  and feature flag.
- [Database](/dev/ops/database) — schema, migrations, and local Postgres.
- [Deployment](/dev/ops/deployment) — Vercel and Cloud Run.
- [Cloud Architecture](/dev/ops/cloud-architecture): the GCP, Vercel and
  Supabase topology and how the services connect.
- [Incident Runbook](/dev/ops/incident-runbook) — on-call procedures.

### Engineering Reference

End-to-end, `file:line`-cited reference for every major subsystem (UI → service
→ route → repository → Postgres). Start at the [Feature Index](/features/README).

### Runbooks & Migrations

- [Staging Setup](/STAGING_SETUP) — staging environment topology and runbook.
- [Trust / Stripe Compliance](/TRUST_STRIPE_COMPLIANCE) — IOLTA commingling model.
- [Direct Charge Migration](/DIRECT_CHARGE_MIGRATION) — payments migration notes.
- [Production Cutover](/PRODUCTION_CUTOVER): the plan for moving `main` and
  production onto this codebase.

The **Future** tab (same admin build) holds the roadmap, the tech-debt list and
research notes. Start at [Future](/future/).

## Access & gating

Two separate controls apply.

**Sign-in (per request).** Every docs deploy, public or admin, sits behind
`docs/middleware.ts`, a Vercel Edge Middleware gate. It requires a valid
`plx_docs` cookie that the API issues after a Firebase sign-in
(`backend/src/modules/auth/docsSession.ts`). `docs/AGENTS.md` has the env vars
and the fail-closed behavior. This gate proves the reader has a Paralegix
account. It does not prove the reader is an admin.

**Dev content (build time).** VitePress has no per-user roles, so "admins only"
is enforced by what the build emits:

- The **public build** (the default, `npm run build`) sets no flag. It runs with
  `srcExclude` covering all internal content, so these pages are **not emitted at
  all** — they are not reachable by URL and not indexed by search.
- The **admin build** sets `DOCS_INCLUDE_DEV=true`. It includes this Dev section
  and the engineering/ops docs, and adds the **Dev** and **Future** tabs to the
  top navigation.

To serve the Dev docs to admins, deploy a second build with
`DOCS_INCLUDE_DEV=true` behind an extra access control layer (e.g. Vercel
Password Protection or SSO). The sign-in gate alone is not enough:
`POST /api/auth/docs-session` runs only `verifyToken`, so every user with a
verified email, firm member or portal client, gets the cookie. Do **not** deploy the
flagged build to the public origin.
