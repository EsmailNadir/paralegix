---
paths:
  - "backend/tests/**"
  - "backend/jest.config.js"
---

# Backend tests

Tests are required on this repo. Follow `test-driven-development` for the failing-test-first
cycle and `thorough-testing` for depth. When the suite itself misbehaves (a slow run, a socket
hang up, a SIGSEGV, a `TEST_DB_SLOT` question, coverage), use the `backend-testing` skill.

**The first case for any new route is a caller from another firm.** Use `stranger()` or a second
firm's owner from `actors.ts`.

There are **two Jest projects**, and they have opposite requirements. `jest.config.js` defines both.

### `unit` (the default, and what CI runs)

Everything under `backend/tests/` except `backend/tests/live`. Run it with `npm test`, `npm run test:unit`,
`npm run test:watch`, `npm run test:coverage`, or one file via `npx jest tests/<path>/<file>.test.ts`.

It needs **no running server, no Firebase credentials and no network**. It holds two kinds of spec:

- **Pure-function specs** (`backend/tests/shared/`, `backend/tests/signatures/textFit.test.ts`, …) that import from
  `backend/src/` directly.
- **In-process specs** that drive the real Express app through `supertest`. `backend/src/app.ts` already
  exports the app without calling `listen()`, so the harness needs no production split.

Every in-process spec imports one module:

```ts
import { createFirm, ownerOf, memberWith, drainEvents } from '../support/setupInProcess';
```

`backend/tests/support/setupInProcess.ts` installs the mocks in the required order and registers the
lifecycle hooks. Its parts:

| File | Responsibility |
|---|---|
| `firebase.mock.ts` | Replaces Firebase Admin. `tokenFor({ uid })` mints a token the mocked `verifyIdToken` resolves, so a spec can be ANY caller: a second firm's owner, a narrow role, a portal user, a person on an organization's roster. GCS is present but inert: `admin.storage().bucket(x)` succeeds (several modules call it at module scope) and every operation on it throws by name. |
| `email.mock.ts` | Replaces the `resend` transport, NOT `sendEmail`, so the firm notification toggle, the per-recipient daily cap and the compliance footer all still run. `recipientsOf(subject)` answers "who was told". |
| `app.ts` | The supertest surface. `request()` for an anonymous call, `as(token)` for an authenticated one (it also pins the caller's time zone, default `America/New_York`). Both are re-exported by `setupInProcess.ts`, so a spec imports them from there. |
| `db.ts` | The test pool, and the file that sets the environment. Loads `backend/.env` first, because several modules read config at module load, then FORCES the settings the suite depends on rather than reading them: `NODE_ENV=test`, `RBAC_ENFORCED=true`, `RATE_LIMITS_DISABLED=true`, `STRIPE_AUTO_RECOVERY_ENABLED=false` (only `stripeAutoRecovery.test.ts` turns it on), and nine placeholder provider secrets. `LOG_LEVEL` is forced too, to `TEST_LOG_LEVEL` else `silent`. Two are only defaults, so a value already set wins: `PG_POOL_MAX` (`10`) and `PG_POOL_RESERVE` (`1`). It also overwrites `DATABASE_URL_PROD` and `_STAGING` with a blocked URL. Forcing rather than reading is deliberate: `.env` is untracked, CI has none, and an unset `RBAC_ENFORCED` makes the whole RBAC half of the suite pass for the wrong reason. |
| `stripeWebhook.ts` | `stripeWebhookSender(secret)` delivers a genuinely signed event to the real payments webhook route; `seedStripePaidInvoice` and `seedStripeTrustDeposit` seed the money a refund or dispute acts on. |
| `gate.ts` | `gateMethod(target, key)` suspends a method mid-call, so a concurrency spec can PROVE two requests overlapped instead of assuming `Promise.all` interleaved them. Also injects a single-call fault. |
| `inMemoryBucket.ts` | `installInMemoryBucket()` swaps the inert GCS double for a working in-memory one, for specs that need an upload to actually round-trip. |
| `rlsSession.ts` | `withRlsIdentity(uid, fn)` runs a query as that Firebase uid through a non-superuser role, so an RLS policy is actually enforced; `attemptUnderRls` captures a refusal instead of throwing. The backend connects as `postgres` and bypasses RLS everywhere else, so a policy test that skips this proves nothing. |
| `factories.ts` | Fixtures via plain SQL, never the app's repositories. Firms default to the `enterprise` plan, because `starter` disables templates, trust and signing. |
| `actors.ts` | `ownerOf(firm)`, `memberWith(firm, [codes])`, `portalUser()`, `stranger()`. |
| `caches.ts` | Clears the permission cache and the two portal association caches. Without it a spec reads a value resolved before its own change and passes wrongly. |
| `events.ts` | `drainEvents()`. `eventBus.emit` does not await its `async` listeners, so an assertion otherwise races the notification write. |
| `clock.ts` | `freezeClockAt('2026-03-15T09:00:00-04:00')`. Requires an explicit offset. |

**One Postgres database per Jest worker**, named `paralegix_test_$JEST_WORKER_ID`. Build them with
`npm run test:db` (`backend/scripts/setup-test-db.sh`), which rebuilds each from `backend/db/schema.sql` in ONE
strict pass. (It used to apply the file repeatedly until a pass came back clean, because
`schema.sql` carried forward references. Those are now in the DEFERRED CROSS-TABLE FOREIGN KEYS
block and the whole-schema sweeps run last, so a single pass produces a schema byte-identical to
what the old repeated build produced. A failure here is now a real schema defect, not something to
retry past.)

### `live` (opt-in)

`backend/tests/live/`: the original black-box suite, one folder per module. Run it with `npm run test:live`.

It fetches a **real server** (`backend/tests/live/setup.ts` uses `fetch` against `TEST_API_URL`, default
`http://localhost:5001`, so the server must already be running), signs in to **real Firebase**, and
shares one seeded account, so it is serial (`maxWorkers: 1`) and rate-limited. It needs **test auth
env**: either `__TEST_TOKEN__` (a pre-fetched Firebase ID token; note the trailing underscores,
`auth-helper.ts` and `global-setup.ts` read only that form even though `validate-test-env.ts` also
accepts `__TEST_TOKEN`) OR `TEST_FIREBASE_API_KEY` + `TEST_EMAIL` + `TEST_PASSWORD`.
`backend/tests/live/validate-test-env.ts` fails fast if neither is present and loads `backend/.env` itself,
so no manual exporting is needed; a shell or CI value still overrides the file. Shared helpers:
`backend/tests/live/auth-helper.ts`, `backend/tests/live/setup.ts`, `backend/tests/live/helpers.ts`. Point them at a
disposable database, never staging or prod.

Because it drives ONE account from ONE IP, a fast run trips the rate limits and fails with 429s
that look like unrelated bugs. Start the server under test with the caps lifted:
`USER_RATE_LIMIT_MAX=100000 GLOBAL_RATE_LIMIT_MAX=100000 npm run dev`.

It is kept because it is the only thing that exercises the deployed wiring end to end. It is not in
CI, and a case that an in-process spec covers should move rather than be duplicated.

