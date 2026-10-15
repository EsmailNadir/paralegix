# Multi-Tenancy & Tenant Isolation

How Paralegix keeps one law firm's data from ever reaching another: `law_firm_id` scoping, app-enforced isolation, membership assertions, and the one place the database enforces it directly.

## Summary

Paralegix is multi-tenant with the **law firm as the tenant root**. Nearly every
table carries a `law_firm_id` (uuid, FK → `law_firms`) and is keyed by
`(law_firm_id, id)`. Isolation is the **application's responsibility**, not the
database's: the backend connects to Postgres as the `postgres` role and bypasses
row-level security, so every query must scope by `law_firm_id` in app code. Two
mechanisms enforce this:

1. **Audited Drizzle contexts** — tenant queries require an explicit
   `law_firm_id` scope that is verified against emitted SQL. The retained
   `DrizzleRepository` CRUD base follows the same Drizzle path for
   existing simple CRUD, and malformed uuid ids are rejected as not-found.
2. **Membership asserts** — `assertLawFirmMembership`, `assertMatterMembership`,
   and friends in `backend/src/shared/utils/membership.ts`, called at the top of
   services to prove the caller belongs to the firm (and, where relevant, the
   matter) before any work.

The **one** place the database enforces tenancy itself is the messaging /
notifications / signatures realtime path, which has Postgres **RLS** enabled
because the Supabase Realtime client reads those tables directly with a
Firebase-UID JWT rather than going through the backend.

## Key Takeaways

- **`(law_firm_id, id)` keying is the invariant.** An `id` alone is never a key;
  a query without `law_firm_id` is a tenant-isolation bug. The tenant query
  context and the `DrizzleRepository` CRUD base never emit one.
- **App-enforced, not DB-enforced, for most tables.** The backend is the
  `postgres` superuser role, so RLS does not constrain it. Tenant scoping is
  correct only because every query includes `law_firm_id` — this is enforced by
  audited Drizzle contexts and code review. Complex parameterized SQL is still
  executed through Drizzle and must retain the `law_firm_id` predicate.
- **Membership is checked in the service, first.** Services call
  `assertLawFirmMembership(lawFirmId, userId)` before doing anything;
  matter-scoped work adds `assertMatterMembership`. A non-member gets a
  `ForbiddenError` before any data is read or written.
- **Malformed ids fail as not-found, not as a DB cast error.** `validId()` /
  `isUuid()` guard uuid columns so a bad id returns `null`/`404` instead of
  throwing a Postgres cast error (and never leaks across tenants).
- **RLS is the exception, reserved for direct client reads.** Only the tables
  the Supabase Realtime client subscribes to have RLS, because those are the only
  reads that do not pass through the trusted backend: `conversations`,
  `messages`, `conversation_participants`, `notifications`,
  `signature_sources`, `signature_sessions`, `signature_participants`, and
  `signature_processing_jobs`.
- **The subject must be in the firm too, not just the caller.** A write that
  names a client id from the request calls `assertClientInFirm` so a row can
  never carry one firm's `law_firm_id` and another firm's `client_id`.

## `law_firm_id` scoping through Drizzle

`backend/src/shared/database/queryContext.ts` provides the normal tenant query
boundary. Its `tenantQuery` and related scoped helpers take the table and firm id,
build a mandatory scope condition, and inspect compiled SQL before execution,
refusing to run if the tenant predicate did not survive into the emitted SQL with
the expected bound value. The contexts are named by capability:

- `tenantQuery`, `tenantAliasedQuery`, `tenantParameterizedQuery`: a base or
  parent table that carries `law_firm_id`; `firmQuery` for the `law_firms` row
  itself.
- `tokenQuery`: public reads/writes scoped by an unguessable token (signing
  links, OAuth `state`), which must appear as a bound parameter.
- `systemQuery` / `adminQuery` / `privilegedParameterizedQuery`: genuinely
  global identity or platform-admin data. There is deliberately no generic
  `unscopedQuery()`, so every unscoped query is named and searchable.

`backend/src/shared/database/scopedWrite.ts` holds the write-side helpers
(`scopedInsert`, `scopedInsertMany`, `scopedUpsert`, `scopedUpdate`,
`scopedDelete`, ...). Inserts strip immutable keys from the caller's payload and
then stamp the trusted `lawFirmId`, so a body cannot choose its own tenant.
`DrizzleRepository.ts` is the CRUD base for simple tenant-scoped tables and
goes through the same helpers. `SqlRepository.ts`, the legacy base constructed
with a table NAME, is deleted.

- **Every query is tenant-scoped.** Fluent Drizzle queries receive the required
  scope condition, and compatibility methods such as `findById`, `findAll`,
  `findWhere`, `update`, `delete`, and `batchDelete` take `lawFirmId` first.
  Creates force `law_firm_id = lawFirmId`.
- **Uuid id guarding.** `validId(id)` returns false for a
  non-uuid on a uuid-keyed table via the `UUID_RE` regex, so `findById` /
  `update` / `delete` short-circuit to `null`/no-op rather than issuing a query
  that would throw an invalid-uuid cast error. `isUuid` is also exported for
  parameterized compatibility SQL to guard uuid params before querying.
- **Never string-concatenates values.** Drizzle-bound values and audited
  `parameterizedSql` keep values bound; only reviewed internal identifiers can
  be interpolated.

For complex reads (JOINs, junction tables, transactions), repositories use
fluent Drizzle or audited parameterized SQL executed through Drizzle. They still
must scope by `law_firm_id` and guard uuid params with `isUuid()`, but they do
not bypass the query layer through the raw pool.

## Why tenancy is enforced in app code, not the DB

The backend connects as the Postgres `postgres` role, which **bypasses RLS**.
This is a deliberate trade-off: RLS on every tenant table would require threading
the current firm/user into the database session on every query and would not
compose with the connection pool cleanly. Instead the app owns scoping — every
query carries `law_firm_id` — and the DB is trusted infrastructure behind the
backend. The keying `(law_firm_id, id)` and audited Drizzle contexts make the
correct query the default. A missing `law_firm_id` predicate remains a real
cross-tenant leak with no DB backstop, which is why membership asserts below run
first and code review treats it as a bug.

## Membership assertions

`backend/src/shared/utils/membership.ts` is the gate services call before
touching data. Members are the source of truth (owners are member rows with
`is_owner = true`).

- **`assertLawFirmMembership(lawFirmId, userId)`** — one query against `members`;
  throws `ForbiddenError` if the user is not a member of the firm.
  `assertLawFirmMemberships` is the batch form for a set of user ids.
- **`assertMatterMembership(lawFirmId, matterId, userId)`** — a single JOIN of
  `matter_members ⋈ members` proves the user is **both** a firm member and a
  member of that specific matter. On failure it reproduces three distinct
  outcomes: not a firm member → `ForbiddenError`; firm member but no such matter
  → `NotFoundError('Matter')`; matter exists but not a member of it →
  `ForbiddenError`. `assertMatterMemberships` is the batch form.
- **`assertMatterReadAccess(lawFirmId, matterId, userId)`** — the read-side
  variant: firm owners and admins pass without matter membership, everyone else
  falls through to `assertMatterMembership`. Use it for reads that owners are
  expected to see firm-wide; keep `assertMatterMembership` on writes.
- **`assertMatterWriteAccess(lawFirmId, matterId, userId)`**: same audience as
  the read variant, but only for edits to the matter record itself (fields,
  practice area, linked clients). The work product hanging off a matter (notes,
  events, files, tasks, time) stays on `assertMatterMembership`, so the ethical
  wall still holds against owners and admins there.
- **`getAccessibleMatterIds`** — resolves, in one query, which of a set of matter
  ids the user can access, so a batch of matter-scoped rows can be validated
  without a per-row round-trip.
- **`isFirmOwnerOrAdmin(lawFirmId, userId)`** — the shared owner/admin test
  behind the firm-wide read surfaces. Owner is `members.is_owner`; "admin" is
  inferred from holding the `members.changeRole` permission, which only
  owner/admin roles carry and which the member baseline deliberately excludes
  (so there is no separate admin flag to keep in sync). It is the `seeAll` input to the matters and
  tasks list/lookup queries, where true drops the membership predicate. It exists
  because the same bug kept recurring independently: an owner opening a firm-wide
  total (accounts receivable, unbilled summaries, the matters grid) saw only
  matters they were personally a member of, and silently under-reported. Route
  new firm-wide reads through this helper rather than re-deriving the test.

Membership proves the **caller** belongs to the firm; it says nothing about ids
the request **names**. `assertClientInFirm(lawFirmId, clientId)`
(`backend/src/shared/utils/clientScope.ts`) is the subject-side check for client
ids. Without it a create path wrote its own `law_firm_id` next to another firm's
`client_id`: invisible to both firms, and deleted by the other firm's client
cascade (trust transactions, where the FK restricts, instead blocked that firm
from ever deleting its client). It answers `404` rather than `403` so another
firm's ids are indistinguishable from ids that never existed. Call it in any
service that writes a client id from the request. The same class of bug (a
foreign practice area, member, parent or task id) is pinned by the specs in
`backend/tests/tenancy/`, with `foreignClientWrites.test.ts` as the standing
guard for client ids.

> Portal-client access is asserted per module, not through a shared helper. The
> earlier `assertLawFirmAccess` / `assertClientAccess` / `assertClientMatterAccess`
> helpers were Firestore-era and had no remaining callers; they were removed.

The service pattern (`backend/AGENTS.md`) puts `assertLawFirmMembership` first,
then `assertMatterMembership` when a `matterId` is involved, before any
repository call.

## Messaging RLS (the DB-enforced exception)

The messaging, notifications, and signature realtime tables are the **only**
tables where Postgres RLS is active, because the Supabase Realtime client reads
them **directly** from the browser — not through the backend. That direct read
path needs a database-level authorization check.

- **The client authenticates with a Firebase-UID JWT.**
  `backend/src/modules/messaging/messaging.realtime.ts` mints a short-lived
  (15-minute) Supabase-compatible JWT signed with `SUPABASE_JWT_SECRET`, carrying
  the Firebase uid as `sub` and `role: 'authenticated'`. RLS policies authorize
  by `auth.jwt() ->> 'sub'` against `members.user_id` / `conversations.client_id`.
- **Access checks are consolidated `SECURITY DEFINER` helpers** in
  `backend/db/schema/86_messaging.sql`. `messaging_can_access_conversation(p_conversation, p_uid)`
  (`86_messaging.sql:213`) returns true, for a direct thread, when the uid is the
  conversation's client **or** a member of its firm, and for a group
  conversation only when the uid is a current (not removed) participant. It backs
  the `conversation_participants` policy. Folding the branches into one function
  makes each policy a single cheap call instead of a per-row correlated
  subquery, and `SECURITY DEFINER` lets it read `conversations`/`members` without
  granting the `authenticated` role SELECT on them.
- **`messages` uses a stricter helper,** `messaging_realtime_message_access`
  (`86_messaging.sql:240`): in a group conversation only participants who are
  also **firm members** may stream message rows, because a row carries a
  plaintext `sender_name` and a client must not read co-clients' names when the
  firm hides them. Clients get live group updates from the `conversations` row
  plus a masked REST refetch.
- **`search_path` is pinned** (`public, pg_catalog` on the conversation helpers,
  `public` on `rls_is_firm_member`) so a definer body cannot be hijacked by a
  caller-controlled `search_path`; `EXECUTE` is revoked from public and granted
  only to `authenticated`.
- **`conversations` policy** is group-aware: a group row is visible to its
  participants only (`rls_is_conversation_participant`); a direct row when
  `(auth.jwt() ->> 'sub') = client_id` OR the uid is a firm member via
  `rls_is_firm_member`. **`notifications`** allows a row when
  `(auth.jwt() ->> 'sub') = user_id` (`backend/db/schema/90_platform.sql:52`).
- **Signature tables** (`backend/db/schema/87_signatures.sql`):
  `signature_sources`, `signature_sessions` and `signature_processing_jobs`
  allow a row to any member of its firm (`rls_is_firm_member`);
  `signature_participants` also allows the participant's own `client_user_id` or
  `member_user_id`.

The **backend writes** to these tables as `postgres` and bypasses RLS entirely —
RLS only constrains the direct client subscription. So the same isolation lives
in two places for these tables: app code on the write path, RLS on the direct
read path.

## Source

- `backend/src/shared/database/queryContext.ts` — audited tenant, parent, token, system, and admin query contexts
- `backend/src/shared/database/DrizzleRepository.ts`: tenant-scoped CRUD, `validId`
- `backend/src/shared/database/scopedWrite.ts`: tenant-stamped insert/update/delete helpers
- `backend/src/shared/utils/membership.ts` — firm/matter/client membership asserts
- `backend/src/shared/utils/clientScope.ts`: `assertClientInFirm`
- `backend/db/schema/*.sql` (generated into `backend/db/schema.sql`): `(law_firm_id, id)` keying; RLS in `86_messaging.sql`, `87_signatures.sql`, `90_platform.sql`
- `backend/tests/tenancy/`: cross-tenant regression specs
- `backend/src/modules/messaging/messaging.realtime.ts` — Firebase-UID Realtime JWT
- `backend/AGENTS.md` — repository/service scoping rules

## Related

- [/dev/security/auth-tokens](/dev/security/auth-tokens) — who the caller is
- [/dev/security/rbac-permissions](/dev/security/rbac-permissions) — what the caller may do
- [/dev/admin/rate-limiting](/dev/admin/rate-limiting) — abuse throttling
