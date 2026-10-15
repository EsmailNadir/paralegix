# PostHog Analytics & Cookie Consent

The frontend sends product analytics and browser exceptions to PostHog through a same-origin
proxy. The backend sends a small set of server-authoritative events directly to PostHog. Browser
consent is decided in `frontend/src/lib/analytics/consent.ts`; only
`frontend/src/lib/analytics/analytics.ts` initializes `posthog-js`, and only
`backend/src/shared/analytics/serverAnalytics.ts` imports `posthog-node`.

## Event flow and ownership

| Source | Events | Entry point |
|---|---|---|
| Browser | Registration and login, checkout start, invitations, calendar connection, matter/lead/task/note/time/invoice/trust/message actions, and portal document uploads | `track()` in `analytics.ts` |
| Browser SDK | Pageviews and browser exceptions, including the global error boundary | `posthog.init()` and `captureAnalyticsException()` in `analytics.ts` |
| Backend | Firm creation, subscription start/status/cancellation/payment failure, and the first application of a client invoice payment | `captureServerEvent()` in `serverAnalytics.ts` |

The two event-name unions, `AnalyticsEvent` and `ServerAnalyticsEvent`, are the event catalog.
Use an explicit `track()` call after the action succeeds. Record a server event at the durable
write or webhook that proves the action happened, so retries and failed requests do not inflate
usage. The backend wrapper queues without awaiting the network, catches capture errors, and
flushes on graceful shutdown with a 1.5-second budget. A missing server token makes every call
a no-op; the backend test harness forces it empty.

`AnalyticsSession` identifies a signed-in browser by Firebase UID and resets on sign-out or
account switch. The firm and client layouts call `useAnalyticsContext()` to attach `user_type`
and `law_firm_id`; when enabled, `law_firm` is also a PostHog group. Before browser consent,
identity and context remain pending in memory and are applied if analytics starts. Backend
events use the acting `users.id` when available, or `law_firm:<id>` for a webhook, and always
carry the firm group and `law_firm_id` property. These IDs are pseudonymous, not anonymous.

## Regional behavior

On startup, the app reads the saved analytics choice. A saved decline keeps analytics off in every
region. A saved acceptance starts analytics without another region lookup. With no saved choice,
the app requests `/api/consent-region`, which reads Vercel's `x-vercel-ip-country` header. The
response is private and uncached so a shared cache cannot apply one visitor's region to another.

Visitors in EU member states, the rest of the EEA, the UK, Switzerland and Canada are classified
as `required`. Canada is there for Quebec's Law 25, which requires identifying or profiling
technology to be off by default and reaches businesses outside Quebec; all of Canada is included
because an IP address cannot reliably tell Quebec from the other provinces. PostHog does not
initialize until they accept. Other known countries are `notice`:
analytics starts on load and the visitor can still decline in Cookie settings. The choice is saved
in local storage and applies in every region. The region result is cached only for the browser
session.

When the country header is absent or the lookup fails (including local development), the browser
time zone is used. A `Europe/` or Canadian time zone requires acceptance; other time zones use the
notice behavior. This deliberately errs toward asking in uncertain European and Canadian cases.

## Cookies and storage

PostHog starts only after the regional decision allows it. Its browser persistence uses PostHog's
cookie and local storage identifier. Declining from Cookie settings opts out of capture and removes
PostHog `ph_` entries from local storage and cookies on the current host and its parent-domain
suffixes. The app also keeps the consent choice itself in local storage so the choice survives a
browser restart, with the time it was made: a choice older than a year is forgotten and the
visitor is asked again. The region cache is in session storage and expires with the session.

## Account erasure

Erasing an account (self-service, or a firm erasing a client with a linked account) also calls
`deleteAnalyticsPerson` in `backend/src/shared/analytics/serverAnalytics.ts`, which asks PostHog's
`persons/bulk_delete` endpoint to delete that person with their events and recordings. It needs
`POSTHOG_PERSONAL_API_KEY` (a personal key with person write scope, limited to the environment's
project; a secret) and `POSTHOG_PROJECT_ID` on the backend. Without them it does nothing, and the
privacy policy's promise that deleting an account deletes its analytics is not kept, so both must
be set in staging and production. It never throws: a failure is logged and the erasure stands.

The SDK is configured with autocapture, dead-click capture, heatmaps, performance capture, session
recording, and surveys disabled. Events use the allowlisted `AnalyticsEvent` names and sanitized
properties; see `frontend/src/lib/analytics/sanitize.ts`. Do not initialize PostHog directly or add
another `posthog-js` import: use `track()`, `identifyUser()`, and the consent entry points.

`scrubCapture()` runs before every browser send. It drops page titles; removes URL query strings
and hashes; masks the token after `/share/` and `/intake/`; and keeps only exception type,
mechanism and stack locations. The SDK may separately attach marketing `utm_*` properties, so
do not put client information in campaign parameters. `AnalyticsProperties` accepts primitive
values, but that type does not make an arbitrary string safe. Review every new property for
names, email addresses, free text, file names and amounts. The backend also drops non-primitive
values at runtime, but callers must apply the same content rule.

Browser consent controls browser events only. Server events continue independently of the
visitor's saved choice. The privacy policy describes that basis; change the policy and this
implementation together if that decision changes. Terms/privacy acceptance recorded by
`POST /api/privacy/accept-terms` is a separate process from the analytics choice.

## Proxy and project regions

The browser sends analytics to `/ingest` on the app's own origin. Next.js rewrites `/ingest/*` to
the configured PostHog ingestion host, including its matching static-asset host. This keeps the
SDK requests same-origin and avoids exposing a third-party ingestion hostname in browser requests.
The host's data region is determined by the PostHog project and its configured ingestion host; it
is separate from the visitor's cookie-consent region. The current local, staging, and production
projects use PostHog's US cloud.

Configure the frontend with `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and
`NEXT_PUBLIC_POSTHOG_HOST`. Configure server-side events separately with `POSTHOG_PROJECT_TOKEN`
and `POSTHOG_HOST`. `NEXT_PUBLIC_POSTHOG_UI_HOST` is optional and defaults to
`https://us.posthog.com`. Each environment must use its own project token, with the frontend and
backend tokens for an environment pointing to the same project. The frontend host and backend
host default to `https://us.i.posthog.com`. Frontend variables are embedded at build time; an
unset browser token disables SDK initialization. Server events bypass `/ingest` and are disabled
when their token is absent. These project tokens are public ingestion tokens, never personal or
admin API keys. See [Environment Variables](/dev/ops/environment-variables), [Staging
Setup](/STAGING_SETUP) and [Production Cutover](/PRODUCTION_CUTOVER) for the environment values.

## Verification and delivery problems

Run the focused tests after changing event names, consent, sanitization, or delivery:

```bash
(cd frontend && npx jest tests/lib/analytics tests/app/api/consentRegion.route.test.ts tests/components/ui/CookieNotice.test.tsx)
(cd backend && npx jest tests/shared/serverAnalytics.test.ts)
```

For a configured environment, confirm the browser's `/api/consent-region` response and saved
choice before expecting browser events. In a required region with no acceptance, no PostHog SDK
request should occur. With consent, browser requests use `/ingest`; a rewrite or host mismatch
can prevent delivery even when `track()` runs. Server events go to `POSTHOG_HOST`, so inspect
backend `[analytics]` warnings and the target PostHog project's live events if one is missing.
Check the project token and host together, and keep local, staging and production traffic in
their respective projects. A browser event can be absent because the action failed, consent was
denied, the token was unset at build time, or the event was intentionally not captured.

## What the privacy policy depends on

The public privacy policy, terms and sub-processors page make promises that hold only while
these stay true. Change one and the legal pages must change with it.

- Each PostHog project keeps **Discard client IP data** on, and session replay, autocapture,
  heatmaps, dead clicks, console logs and network timing off.
- `sanitize.ts` strips query strings, hashes, share and intake tokens, page titles and all
  exception text, keeping only an exception's type and stack locations.
- Every `track()` property is an id, enum, count or boolean.
- Server-side events (`law_firm_created`, the subscription events, `client_invoice_paid`) ignore
  the browser's consent choice. The policy says so and relies on legitimate interests for them.
- GeoIP stores country, region, city, postal code and approximate coordinates; the policy lists
  exactly these. Trimming them in PostHog's GeoIP transformation needs a policy update too.
- Events are kept for one year on the free plan and seven on paid plans, as the policy states.

## Vendor agreement

PostHog's Data Processing Agreement was executed on 2026-09-22 through `app.posthog.com/legal`.
The signed copy is kept with the company's legal records, not in this repository. The
organization's **Internal AI training** setting is off, so PostHog does not use this data to
train its own features. Generate and sign a new DPA under the company's name once the business is
incorporated.

## Code to update together

- `frontend/src/lib/analytics/consentRegion.ts`: country list and fallback policy.
- `frontend/src/app/api/consent-region/route.ts`: Vercel country-header lookup and cache policy.
- `frontend/src/lib/analytics/consent.ts`: saved choices and startup/decline behavior.
- `frontend/src/lib/analytics/analytics.ts`: SDK options, storage cleanup, and event API.
- `frontend/src/lib/analytics/sanitize.ts`: URL, title and exception scrubbing.
- `frontend/src/components/AnalyticsSession.tsx` and `frontend/src/hooks/useAnalyticsContext.ts`:
  signed-in identity and firm context.
- `frontend/next.config.ts`: ingestion and static-asset proxy rewrites.
- `backend/src/shared/analytics/serverAnalytics.ts`: server event catalog, firm scope and flush.
- `docs/dev/ops/environment-variables.md` and the privacy, terms and sub-processors pages:
  configuration and the promises tied to it.

Keep the country list and regional explanation here aligned when policy or behavior changes. The
consent tests are in `frontend/tests/lib/analytics/consent.test.ts`, region classification tests are
in `frontend/tests/lib/analytics/consentRegion.test.ts`, and the route tests are in
`frontend/tests/app/api/consentRegion.route.test.ts`. Sanitization and delivery tests are in
`frontend/tests/lib/analytics/sanitize.test.ts`, `frontend/tests/lib/analytics/analytics.test.ts`
and `backend/tests/shared/serverAnalytics.test.ts`.
