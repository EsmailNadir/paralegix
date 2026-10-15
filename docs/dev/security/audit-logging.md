# Audit Logging

What Paralegix records about who did what, where those records live, and how to query them.

## Summary

Paralegix keeps several independent, **append-only** trails rather than one
monolithic log. Each is tuned to a different auditor:

- **The mutation audit log** (`audit_events`) — a firm-scoped record of every
  state-changing API request (login activity, create/update/delete). Backs the
  firm-facing "security and data-access audit log" and the cross-firm platform
  admin console.
- **The security event stream** — structured log lines (`event: "authz.denied"`,
  `"data.export"`, `"data.erasure"`, …) emitted to Cloud Logging for alerting.
  These are *observability*, not a queryable table.
- **The signature audit trail** (`signature_audit_events`) — a per-signing-session
  chain of view/consent/sign/decline events, the evidentiary backbone of ESIGN
  sealing.
- **The trust ledger** (`trust_transactions`) — an append-only IOLTA ledger whose
  immutability is enforced by a database trigger; corrections are reversing
  entries, never edits.

All four resist tampering at the database layer: a `BEFORE UPDATE` (and, for the
trust ledger, `BEFORE DELETE`) trigger raises an exception on any attempt to
mutate a recorded row in place. Deletes are permitted only where a cascade must
purge a parent (a deleted firm, a purged signing session).

## Key Takeaways

- **Mutations are audited globally, after auth.** `auditMutations` is mounted
  once (`backend/src/app.ts:519`), *after* `express.json()` and the per-route
  `verifyToken`, so it observes a populated `req.user` and the final status code.
  It records on the response `finish` event, so auditing never delays or breaks
  the response it is recording.
- **Reads are not audited.** Only `POST/PUT/PATCH/DELETE` are recorded
  (`audit.middleware.ts:4`). A `GET` produces no `audit_events` row. Data-access
  *exports* are captured separately as security events, not here.
- **Request bodies are never stored.** The middleware deliberately omits the body
  (it can carry PII or secrets) and stores only derived, low-risk fields plus an
  empty `metadata` object (`audit.middleware.ts:69`).
- **Everything is append-only at the DB.** `audit_events`, `signature_audit_events`,
  and `trust_transactions` each have an immutability trigger. You cannot doctor a
  row through the app *or* a direct SQL `UPDATE`.
- **403s become security signals.** The central error handler flags every 403 as
  an `authz.denied` event (`errorHandler.ts:13`); a spike from one actor is the
  signature of IDOR / authz probing.
- **Retention is unbounded today.** Nothing purges old rows on a schedule. Growth
  and a formal retention policy are open backlog items (see Gaps).

## The mutation audit log (`audit_events`)

### What is captured

`auditMutations` (`backend/src/modules/audit/audit.middleware.ts`) derives and
stores, per mutating request:

| Field | Source | Notes |
|---|---|---|
| `action` | `"<METHOD> <path>"` with uuids collapsed to `:id` | e.g. `POST /api/lawfirms/:id/matters/:id/notes` — groups cleanly |
| `law_firm_id` | first `/lawfirms/<uuid>` segment in the URL | `null` for actions with no firm scope |
| `actor_uid` / `actor_email` | `req.user.uid` / `req.user.email` | populated by the route's `verifyToken` |
| `method`, `path` | request method + query-stripped path | full path kept alongside the grouped `action` |
| `status_code` | `res.statusCode` at finish | records failures too, not just successes |
| `ip`, `user_agent` | `req.ip`, `User-Agent` header | `trust proxy` bounds the forwarded IP so it is not spoofable |
| `metadata` | always `{}` today | reserved jsonb; bodies are intentionally excluded |
| `created_at` | `now()` default | `timestamptz` |

### What is skipped

- Non-mutating methods (`GET`, `HEAD`, `OPTIONS`).
- `/api/health`, `/api/webhooks/*`, `/api/cron/*` (`audit.middleware.ts:31`):
  noise or machine-to-machine traffic carrying no firm actor.
- Requests with **neither** a firm scope **nor** an actor (`audit.middleware.ts:63`)
  — anonymous unscoped traffic is dropped as noise.

### Storage & immutability

Rows live in `audit_events` (`backend/db/schema/90_platform.sql:145`). The table
is append-only: `audit_events_immutable()` raises on any `UPDATE`
(`90_platform.sql:164`). `DELETE` is permitted solely so the `on delete cascade`
from `law_firms` can purge a deleted firm's rows. Writes are best-effort: the
service wraps the insert in try/catch and logs on failure rather than throwing
(`audit.service.ts:66`), so a logging fault never fails the user's request. The
write is registered as a tracked background write, and `drainAuditWrites()`
lets the test harness wait for it before truncating tables.
Indexes: `(law_firm_id, created_at desc)`, `(actor_uid, created_at desc)`, and
the filtered-list pair `(law_firm_id, action, created_at desc, id desc)` /
`(law_firm_id, actor_uid, created_at desc, id desc)`
(`backend/db/schema/95_deferred_fks.sql:116`).

Sign-ins are recorded here too, but not by the middleware: `recordLoginEvent`
in `backend/src/modules/auth/auth.service.ts:474` writes an `auth.login` row
for each of the user's firms.

### How to query

- **Firm-scoped (in-app):** `GET /api/lawfirms/:lawFirmId/audit-events`, gated by
  the `firm.viewAuditLog` permission (`backend/src/modules/audit/audit.routes.ts:11`).
  Supports `limit`, `offset`, `action`, and `actorUid` filters; returns
  `{ items, totalItems }`, newest first (`audit.repository.ts:50`).
- **Cross-firm (platform admin):** `GET /api/admin/audit-events`
  (`backend/src/modules/admin/admin.routes.ts:187`), behind the router-level
  `router.use(verifyToken, requireIsAdmin)` (`admin.routes.ts:34`). Also accepts
  a `search` filter.
  Unscoped; adds `lawFirmId` as a filter and enriches each row with the firm name
  and actor display name via left joins (`audit.repository.ts:88`). Filter
  `action=auth.login` for login activity.
- **Direct SQL (ops):** `select * from audit_events where law_firm_id = $1 order
  by created_at desc`. Always scope by `law_firm_id` when investigating one firm.

## Security event stream (Cloud Logging)

Separate from the table, `logSecurityEvent(req, event, opts)`
(`backend/src/shared/utils/securityLog.ts`) emits structured log lines whose
stable `event` field is the contract with the alerting config in
`infra/monitoring/`. Identifying fields (`ip`, `actorUid`, `requestId`) go in the
log entry, never as metric labels, to avoid time-series cardinality blowups.
Notable events:

- `auth.failed`: every failed ID-token verify, with the client `ip`, logged in
  `backend/src/shared/middleware/auth.ts`. See /dev/security/auth-tokens.
- `authz.denied`: every 403, flagged centrally in the error handler
  (`errorHandler.ts:13`). Drives the authz-probing alert.
- `admin.action`: every mutating (`POST/PUT/PATCH/DELETE`) request to the
  platform admin router, with method and path (`admin.routes.ts:43`). Admin
  reads are not logged.
- `data.export` — a data-subject export ran (self or firm-on-client),
  emitted by the privacy routes. See /dev/security/privacy-data-rights.
- `data.erasure` — an account or client was erased.

These are best-effort and non-throwing; a logging failure never surfaces onto the
request. They are queried in Logs Explorer / log-based metrics, not via an API.

## Signature audit trail (`signature_audit_events`)

Each signing session accumulates an immutable, ordered chain of events
(`backend/src/modules/signatures/audit.ts`). Event types
(`session.created`, `session.viewed`, `document.viewed`, `consent.given`,
`session.completed`, `session.expired`, `session.cancelled`,
`participant.declined`, `participant.removed`, `email.sent`, `reminder.sent`,
`accesscode.verified`, `accesscode.failed`) are defined in `AUDIT_EVENTS`
(`audit.ts:9`), and a `CHECK` constraint on `event_type` holds the table to the
same list (`backend/db/schema/87_signatures.sql:461`), so a new event type needs
both. Each row stores `session_id`, `law_firm_id`, `participant_id`, `event_type`,
`ip`, `user_agent`, `actor_uid`, and a jsonb `metadata` blob. `writeAuditEvent`
extracts IP/UA from the request (honoring `x-forwarded-for`) and is a tracked
background write, so callers may drop the promise;
`writeAuditEvents` batch-inserts for cron/loop paths (`audit.ts:81`).
`listAuditEvents(token)` returns the trail oldest-first (`audit.ts:129`).

Immutability: `signature_audit_immutable()` blocks `UPDATE`
(`87_signatures.sql:494`). `DELETE` is intentionally allowed so the
`on delete cascade` from `signature_sessions` (and the session cleanup job) can
purge a session's audit rows; a blanket delete-block would abort session
deletion. `hashDocument()` (`audit.ts:152`) computes the SHA-256 used to bind the
sealed document to its trail.

## Trust ledger auditability (`trust_transactions`)

The IOLTA ledger is append-only by design. `trust_txn_immutable()`
(`backend/db/schema/80_trust.sql:216`) is a `BEFORE UPDATE OR DELETE` trigger that:

- **Blocks deleting** a `completed` or `void` transaction outright; the void
  lineage is part of the correction trail.
- **Makes `void` terminal:** a void row cannot be updated at all, so it can never
  be flipped back to `completed`.
- **Freezes completed rows in place:** on `UPDATE`, only the bank-clearing stamps
  (`cleared_at`, `cleared_in_reconciliation_id`) and `updated_at` may change; the
  rest of the row must be byte-for-byte identical, so amount and attribution
  (client/matter/date) stay tamper-evident. The one declared exception is a
  client-identity merge, which may repoint `client_id` only for the exact
  `from:to` pair it sets in the transaction-local
  `paralegix.trust_client_remap` setting.
- **Limits `completed → void`** to setting the void fields (`voided_by`,
  `voided_at`, `void_reason`); no other column may change alongside it.

Corrections are therefore posted as **reversing entries**, never edits, which is
the ledger's audit property. Trust records carry a configurable `retentionYears`
(default 5, `backend/src/modules/trust/trust.service.ts:18`).

## Gaps & backlog

Honest limitations, tracked in the compliance backlog:

- **No scheduled retention/rotation for `audit_events`.** Rows accrue
  indefinitely (only a firm cascade removes them). A retention window, archival,
  and a full soft-delete/recycle-bin model are open items; only the legal-hold
  subset exists today.
- **`metadata` is unused.** The mutation log stores no per-action detail beyond
  method/path/status — no before/after diffs. Reconstructing *what changed*
  requires correlating with domain tables.
- **Error-tracking/alerting on the security stream is not fully wired.** The event
  taxonomy exists; the Cloud Logging log-based metrics + alert policies (or Sentry)
  are still an ops task.
- **`user_agent` / `ip` trust depends on `TRUST_PROXY_HOPS`.** Misconfiguring the
  proxy-hop count would let a client spoof the recorded IP.

## Source

- `backend/src/modules/audit/audit.middleware.ts` — global mutation-audit middleware
- `backend/src/modules/audit/audit.service.ts` — best-effort record + list
- `backend/src/modules/audit/audit.repository.ts` — append-only inserts, firm/cross-firm queries
- `backend/src/modules/audit/audit.routes.ts` — `GET /audit-events` (`firm.viewAuditLog`)
- `backend/src/modules/admin/admin.routes.ts` — cross-firm admin audit endpoint
- `backend/src/shared/middleware/errorHandler.ts` — 403 → `authz.denied` flagging
- `backend/src/shared/utils/securityLog.ts` — structured security event stream
- `backend/src/modules/signatures/audit.ts` — signature audit trail + document hashing
- `backend/src/modules/auth/auth.service.ts`: `recordLoginEvent` (`auth.login` rows)
- `backend/db/schema/90_platform.sql`, `87_signatures.sql`, `80_trust.sql` (generated into `backend/db/schema.sql`): `audit_events`, `signature_audit_events`, `trust_transactions` tables + immutability triggers
