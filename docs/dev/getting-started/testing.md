# Testing

How this codebase tests itself, and what a test has to do to be worth keeping.

The short version: the backend drives the **real Express app in-process** through
supertest against a **real Postgres database**, with only Firebase and the email
transport replaced. The frontend fakes the **network**, not the service layer. Both
choices exist because the alternatives produced suites that could not fail.

## First run

```bash
cd backend && npm run test:db   # once: builds one Postgres database per Jest worker
```

Skip this and every worker fails with a bare `database paralegix_test_N does not
exist`. `test:db` (`backend/scripts/setup-test-db.sh`) builds six databases
(`TEST_DB_COUNT`, default 6) in the `paralegix-pg` container, each from
`backend/db/schema.sql` in ONE strict pass, so a failure there is a real schema
ordering defect, not something to retry. It prefers Podman locally and Docker in
CI (`CONTAINER_ENGINE` overrides). The harness derives the per-worker names from
`DATABASE_URL_TEST` (default
`postgresql://postgres:postgres@localhost:5433/paralegix_test`) and refuses any
URL that does not name a `paralegix_test` database.

The Postgres container needs **at least 6 GiB**. Each of four Jest workers opens
a pool of 10 connections to its own database, and every one of those backends
carries its own relcache for all ~100 tables, so memory scales with the worker
count. A smaller container gets OOM-killed mid-run:

```bash
podman update --memory 6g --memory-swap 6g paralegix-pg
```

That takes effect live, with no restart.

## Running

```bash
# backend/                          # frontend/
npm test              # unit        npm test             # alias for test:unit
npm run test:unit     # same        npm run test:unit    # jsdom specs, offline
npm run test:watch                  npm run test:integration  # LIVE: needs a server
npm run test:coverage               npm run test:all
npm run test:live     # opt-in      npm run test:perf
npx jest tests/billing/lateFeeMath.test.ts   # one file, either package
```

`npm test` is offline in both packages. It needs no running server, no Firebase
credentials and no network.

For one file, `npm test -- <path>` works in `backend/`. It depends on the backend
scripts ending their `--selectProjects unit` list with `--passWithNoTests=false`:
`--selectProjects` takes a list, so without a flag after it an appended path became a
second project name and all 523 specs ran. `tests/config/testScripts.test.ts` fails if a
script loses that. The same trap catches `jest --selectProjects unit <path>` typed by hand;
put the path first. In `frontend/` it does NOT: `test` there is a nested `npm run test:unit`, and npm does not forward `--`
arguments through it, so the whole suite runs. Use `npx jest <path>` for a focused frontend spec.
Appending a path to `npm run test:unit --` also runs the whole unit selection because that
script's `--testPathIgnorePatterns` consumes the extra paths as ignore patterns.

The backend unit scripts run Jest as
`node --no-concurrent-marking node_modules/.bin/jest`. The flag stops a V8
garbage-collector crash in long runs (see flaky cause 4 below). A bare
`npx jest <file>` omits it, which is fine for a single spec.

Measure coverage with `npm run test:coverage`, never a bare `npx jest --coverage`.
A bare `npx jest` runs BOTH backend projects, and `live` needs a real server, so
its global setup throws before a single test runs. The command exits non-zero and
writes no coverage summary, leaving the previous `coverage/coverage-summary.json`
on disk. Anything reading that file afterwards gets the last successful run's
numbers, and redirecting the command's output hides the failure entirely. This
has already produced figures eight hours out of date. If a percentage looks
unchanged after you added tests, check the file's mtime before believing it.

### Running one spec beside the suite

Jest overwrites `JEST_WORKER_ID` in every process it owns, `--runInBand`
included, so exporting it does not give a second run its own database: both land
on `paralegix_test_1` and each truncates the other's fixtures mid-file. Use
`TEST_DB_SLOT` instead, which takes precedence.

```bash
TEST_DB_SLOT=5 npx jest tests/billing/lateFeeMath.test.ts --runInBand
```

Slots 1 to 4 belong to the suite's own workers. Use 5 and up for anything running
beside it. `npm run test:db` already builds 5 and 6; build more with
`TEST_DB_COUNT=10 ./scripts/setup-test-db.sh`.

## The backend has two Jest projects

### `unit`: the default, and what matters

Everything under `backend/tests/` except `tests/live/`. Two kinds of spec live
here:

- **Pure-function specs** that import from `src/` directly, for arithmetic with a
  right answer: `tests/billing/timeRounding.test.ts`, `tests/signatures/textFit.test.ts`.
- **In-process specs** that drive the real app through supertest. `src/app.ts`
  already exports the app without calling `listen()`, so nothing had to be split
  apart to make this work.

Every in-process spec imports one module:

```ts
import { createFirm, ownerOf, memberWith, drainEvents } from '../support/setupInProcess';
```

`tests/support/setupInProcess.ts` installs the mocks in the required order and
registers the lifecycle hooks, so the reset cannot be forgotten. What it gives you:

| File | Responsibility |
|---|---|
| `firebase.mock.ts` | Replaces Firebase Admin. `tokenFor({ uid })` mints a token the mocked `verifyIdToken` resolves, so a spec can be **any** caller: a second firm's owner, a narrow role, a portal user, a person on an organization's roster. GCS is present but inert: every bucket operation throws by name. |
| `email.mock.ts` | Replaces the `resend` transport, **not** `sendEmail`, so the firm notification toggle, the per-recipient daily cap and the compliance footer all still run. `recipientsOf(subject)` answers "who was told". |
| `app.ts` | The supertest surface: `request()` for an anonymous call, `as(token)` for an authenticated one (it also pins the caller's time zone). |
| `db.ts` | The test pool, and the file that sets the environment. Points `DATABASE_URL` at this worker's database and FORCES the settings the suite depends on (`NODE_ENV=test`, `RBAC_ENFORCED=true`, `RATE_LIMITS_DISABLED=true`, `STRIPE_AUTO_RECOVERY_ENABLED=false`, `PG_POOL_MAX=10`, placeholder provider secrets) rather than reading them from `.env`. Auto-recovery is forced because a developer `.env` set it on while CI has no `.env`, so the same refund spec ran the money-recovery path locally and skipped it in CI. `truncateAll()` empties only the tables that hold rows, with `delete` under `session_replication_role = replica`, not `truncate`. |
| `stripeWebhook.ts` | `stripeWebhookSender(secret)` delivers a genuinely signed event (the real `Stripe.webhooks` HMAC, no network) to the real payments webhook route and fails on anything but `200`; `seedStripePaidInvoice` and `seedStripeTrustDeposit` seed the money a refund or dispute acts on. |
| `gate.ts` | `gateMethod(target, key)` holds a method open mid-call, so a concurrency spec can PROVE two requests overlapped instead of hoping `Promise.all` interleaved them. |
| `inMemoryBucket.ts` | `installInMemoryBucket()` swaps the inert GCS double for a working in-memory one, for specs where the stored object is the behaviour. |
| `rlsSession.ts` | `withRlsIdentity(uid, fn)` runs a query as the Supabase `authenticated` role, so an RLS policy is actually enforced. The app connects as `postgres` and bypasses RLS. |
| `portalUpload.ts` | Drives a client-portal upload through all three legs (`upload-init`, the storage PUT, `upload-finalize`). |
| `minimalPdf.ts` | Small, structurally valid PDFs for tests that pass through PDF admission. |
| `factories.ts` | Fixtures via plain SQL, never the app's own repositories. |
| `actors.ts` | `ownerOf(firm)`, `memberWith(firm, [codes])`, `portalUser()`, `stranger()`. |
| `caches.ts` | Clears the permission cache and the two portal association caches. |
| `events.ts` | `drainEvents()`. `eventBus.emit` does not await its async listeners. |
| `clock.ts` | `freezeClockAt('2026-03-15T09:00:00-04:00')`. Requires an explicit offset. |

Middleware runs for real: helmet, the request logger, the membership and
permission gates, the plan gates, the timezone requirement and the centralised
error handler. That is the point: those gates are where the tenancy and
permission bugs live, and a harness that stubbed them would test nothing.

### `live`: opt-in

`backend/tests/live/`: the original black-box suite. It fetches a **real running
server**, signs in to **real Firebase**, and shares one seeded account, so it is
serial and rate-limited. It needs `__TEST_TOKEN__` (note the trailing
underscores) or `TEST_FIREBASE_API_KEY` + `TEST_EMAIL` + `TEST_PASSWORD`.

It is not in CI. A case an in-process spec can cover should move rather than be
duplicated.

### CI

`.github/workflows/ci.yml` runs on manual dispatch only. Its `backend-tests` job
runs the `unit` project in four shards (`npx jest --selectProjects unit
--coverage --shard=N/4`), each on its own runner with its own six databases
under Docker, and uploads coverage per shard. `backend-static` runs typecheck,
lint and the `db:*` guards, and the `frontend` job runs `ci:checks` then
`test:unit` pinned to `TZ=America/Los_Angeles`.

## The frontend has a trap, and a harness that avoids it

`frontend/tests/setup.ts` globally replaces 20+ service modules with a Proxy whose
every method resolves to `{}`, and forces `hasPermission: () => true`.

Under that default a component test **cannot fail** because a service returned the
wrong shape, because an endpoint answered 403, or because a permission was
missing. It only checks that a component renders given fabricated data. That is
why a large frontend suite once stayed green through broken organization
behaviour.

`frontend/tests/support/` fakes the **transport** instead:

| File | What it gives you |
|---|---|
| `apiMock.ts` | Fakes global `fetch`, leaving the whole service layer real: url building, query parameters, response parsing and `ApiError` handling all execute. An unmatched request **throws** and names the method and url rather than returning empty. |
| `permissions.ts` | Real permission answers, so the read-only degradation rule is testable. Call `resetPermissions()` in `afterEach`, because the object is shared. |
| `renderWithProviders.tsx` | A fresh `QueryClient` per render with `retry: false`. A shared client would hand the second spec the first spec's cached data. |
| `xhrMock.ts` | Fakes `XMLHttpRequest` for uploads, which are hand-built on XHR for progress events and so invisible to `apiMock`. Use `xhr.onExact(...)`; plain `on` is a substring match. |
| `webLocks.ts` | `installWebLocks()`: a Web Locks API for jsdom, which has none. Without it every resumable-upload spec silently exercises the no-locks fallback. |
| `pdfWindowHarness.tsx` | Drives the observers a windowed PDF viewer needs, since jsdom does no layout and would render zero pages. |

Unmock the service and the deduplicator at the top of the file:

```ts
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
```

Worked examples: `tests/components/clients/ClientContacts.test.tsx`,
`tests/contexts/PermissionsContext.test.tsx`.

::: warning ts-jest does not type-check
`isolatedModules` is on, so the frontend suite can be fully green while
`next build` fails on a type error in a test file. `next build` type-checks the
`tests/` tree. Run the build, not just the suite, before pushing.
:::

### Stripe specs

Stripe code is tested offline, through the real routes. Each spec replaces
`src/modules/stripe/stripe.config` with an object whose SDK surfaces are `jest.fn()`s for the
calls the path should make and throwing stubs for everything else, then asserts the exact
arguments that move money (cents, `application_fee_amount`, `transfer_data.destination`,
idempotency keys) and the resulting database state. Webhooks are signed with the real
`Stripe.webhooks` static. Two rules that are easy to miss:

- The recovery code catches its own errors, so a stray Stripe call that throws does NOT fail
  the test by itself. `stripeReversalWebhooks.test.ts` records every call its stubs receive
  and fails in `afterEach` if there was one.
- `STRIPE_AUTO_RECOVERY_ENABLED` is read into a const at module load. The one spec that needs
  it on (`stripeAutoRecovery.test.ts`) sets it after importing the harness and before the
  first request loads the app.

| Spec | Covers |
|---|---|
| `stripeReversalWebhooks.test.ts` | refunds, disputes, won/lost disputes, failed refunds, failed ACH deposits, with recovery off |
| `stripeAutoRecovery.test.ts` | the transfer reversals, card charges, refunds and restores recovery sends to Stripe |
| `webhookConnectSecret.test.ts` | the payments route's second (Connect) secret and its `event.account` rule |
| `stripeConnectOnboarding.test.ts` | onboarding and disconnecting operating and trust connected accounts |
| `stripePaymentRequests.test.ts` | installment requests, voids and the client pay link |

## What makes a test worth having

**Name what has to break for it to go red.** If you cannot, delete it. The
recurring failure here is not a missing test, it is a test that passes while
proving nothing:

- Asserting an absence without first proving the action ran. "Exactly one
  organization" passed while the request was failing with a 400 and nothing had
  been created.
- Asserting a status where the behaviour is content. A list endpoint refuses by
  returning an empty body, not a 403.
- A `??` fallback chain in an assertion. `body.a ?? body.b ?? []` keeps passing
  when the field is renamed.
- Seeding no data for the thing under test. A `can_view_billing` case against a
  world with no money passes whether the money was withheld or never existed.
- Asserting a figure in the wrong unit. The API renders dollars while fixtures are
  in cents, so `not.toContain('731900')` finds nothing whether the data leaked or
  not.

**Pair every refusal with a grant.** A guard written as "refuse everyone"
satisfies every negative case in a file while making the feature unusable. Half
the value of these suites is the positive case sitting next to the negative one.

**Mutation-test before trusting a green.** Break the rule in the source, watch the
matching test go red, then revert. Roughly a third of first drafts in this
codebase passed against deliberately broken code until someone checked.

## Honesty about what you ran

Never state that tests, lint or the build pass without having run them in that
same message. "Tests added" is not a claim you can make without a run behind it.

## When the suite is flaky, it is usually not the test

Five separate causes have produced failures that look like application bugs, and
all of them move around as the suite grows. Check in this order:

1. **Postgres OOM.** `podman logs paralegix-pg | grep "signal 9"`. It restarts and
   spends minutes in recovery, and runs on either side fail with fixtures that
   inserted a row and then got a 404.
2. **A module-load timer.** The app is loaded once per Jest worker, so anything
   scheduled at import time fires inside whatever spec happens to be running when
   the delay elapses. `unref()` stops a timer holding the event loop open; it does
   **not** stop it firing. Two of these were found and are now skipped under
   `NODE_ENV=test`.
3. **Pool exhaustion.** Several services fan out with `Promise.all`, so one
   request can hold four connections at once. `PG_POOL_MAX` is 10 in tests for
   that reason.

The symptom for 2 and 3 is a bare `socket hang up` on whichever test drew the
short straw.

4. **A Jest worker taking SIGSEGV**, which is a Node defect and not yours. The
   symptom is one spec file reporting `Test suite failed to run`, and the run's
   TOTAL test count dropping because that file never ran. Confirm it rather than
   guess: `ls -t ~/Library/Logs/DiagnosticReports/node-*.ips | head`. Every crash
   seen so far has the same top frame,
   `v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers`, inside
   V8's garbage collector, with no application frame anywhere on the stack. The
   `--no-concurrent-marking` flag in the npm test scripts now prevents it, so a
   crash usually means the run bypassed them (a bare `npx jest` over many files).
   With no `signal 9` in the Postgres log, a SIGSEGV can also be the host running
   out of memory: close other memory-hungry applications.
5. **WAL accumulation**, which is the largest factor in how long the suite takes.
   The suite empties its tables between every spec across four workers, so it
   generates write-ahead log faster than checkpoints retire it, and `max_wal_size`
   is a soft target rather than a limit. Growth is roughly 350 MB per full run.
   A manual checkpoint reclaims it:

   ```bash
   podman exec paralegix-pg psql -U postgres -c "checkpoint;"
   ```

   Measured on this machine: `pg_wal` 19 GB to 1.1 GB, and the full suite 514s to
   64s. Run it every twenty or so full runs. The symptom that points here rather
   than at memory is a run taking minutes instead of ~80 seconds, sometimes with a
   transient `No space left on device` while `df` reports hundreds of gigabytes
   free.

   A related cause is `pg_class` bloat in test databases built before the reset
   switched from `truncate` to `delete` (every `truncate` allocated new catalog
   entries). Its symptom is connect timeouts and unexplained 500s; rebuilding with
   `npm run test:db`, or `vacuum full pg_class` per test database, clears it. The
   `backend-testing` skill has the full symptom index.

## Tests are required, not optional

Every change ships with tests. New route or service function: a test through the
real route. Bug fix: a test that **fails before the fix** and passes after. If it
passes on the broken code it does not cover the bug. Changed behaviour: update the
test that pinned the old behaviour, deliberately. Refactor with no behaviour
change: the existing tests stay green untouched.

The backend suite is the only thing standing between a change and a cross-firm
data leak, a wrong invoice, or an overdrawn trust account, and none of those look
wrong on screen.
