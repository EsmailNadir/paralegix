# Paralegix Feature Documentation

Engineering reference for every major feature in Paralegix. Each doc traces the real
code end-to-end (UI → service → route → repository → Postgres), cites `file:line`, and
ends with a **What Can Be Improved** section.

> These docs were **re-audited against the current code** after a large improvement
> sweep. They describe how the code actually behaves now, not the original design. Each
> doc's improvements section lists only what is **still** open.

> **Migration numbers in these docs are historical.** The numbered chain that ran to `0262`
> was collapsed into `backend/db/schema.sql` (generated from `backend/db/schema/*.sql`), and
> `backend/db/migrations/` restarted at `0001`. A doc that cites an old number such as `0071`
> is naming when a change landed, not a file you can open. The schema files are the authority.
>
> **Coverage note:** the sections covering work from the old migrations `0114` to `0138` were written
> after the main audit: matter stages / custom fields / key dates / activity feed
> ([matters.md](matters.md)), task subtasks ([tasks.md](tasks.md)), client uploads +
> document requests + share links ([files.md](files.md), [clients.md](clients.md)), group
> system messages + history visibility ([messaging.md](messaging.md)), time-entry source
> links + the `billable` flag and invoice line-item editing ([billing.md](billing.md)), and
> the firm-wide contact directory ([contacts.md](contacts.md)). Those sections describe
> current code but have not been through an improvement audit, so they carry thinner
> "What Can Be Improved" entries than the audited ones.

> **Citations drift.** These docs cite `file:line`. The files are reliable; the line
> numbers age with every commit that touches the file above the cited point. Treat a
> line number as "roughly here, search for the symbol", not as an address.
>
> **Server-side lists:** the move off fetch-everything-then-filter now covers matters, tasks,
> clients, trust transactions, firm invoices and time entries, the files-page grids, and the
> conversation list, with the shared SQL machinery in
> `backend/src/shared/database/pagination.ts`. The whole model, including which surfaces are
> SQL-paged versus windowed over a derived set, lives in
> [server-side-search.md](server-side-search.md) rather than being repeated per domain. The
> owner/admin firm-wide visibility rule those reads gate on
> (`isFirmOwnerOrAdmin`) is in [/dev/security/multi-tenancy](../dev/security/multi-tenancy.md).

## Index

| Feature | Doc | What it covers |
|---------|-----|----------------|
| Dashboard | [dashboard.md](dashboard.md) | Aggregate summary endpoint + React Query widgets |
| Matters | [matters.md](matters.md) | Matters + members/clients/notes, conflict check |
| Tasks | [tasks.md](tasks.md) | Tasks + assignees/visibility/dependencies/notes |
| Clients | [clients.md](clients.md) | Firm CRM + client portal |
| Identity Verification | [identity-verification.md](identity-verification.md) | Portal clients verify identity with a wallet driver's license through Credence ID |
| Leads | [leads.md](leads.md) | Pre-client pipeline, stage tree, public intake forms, conversion |
| Contacts | [contacts.md](contacts.md) | Firm-wide non-client directory + matter/client junctions |
| Calendar | [calendar.md](calendar.md) | Local events + unified Google/Outlook sync engine |
| Billing | [billing.md](billing.md) | Time entries, invoices, flat fees, expenses, analytics |
| Trust Accounting | [trust-accounting.md](trust-accounting.md) | IOLTA ledger, append-only transactions, reconciliation |
| Stripe Payments & Connect | [stripe-payments.md](stripe-payments.md) | Connect onboarding, direct charges, webhooks, reconciliation |
| Templates | [templates.md](templates.md) | Document templates (HTML + DOCX) + folders |
| Messaging | [messaging.md](messaging.md) | Conversations via Supabase Realtime (RLS) + backend writes |
| E-Signatures | [e-signatures.md](e-signatures.md) | Token-based signing sessions, fields, audit, PDF seal |
| Files | [files.md](files.md) | GCS document storage + Postgres metadata dual-write + quota |
| Document Requests | [document-requests.md](document-requests.md) | Client upload checklists (lifecycle, portal upload, quota, notifications) and public share links |
| Document Conversion | [document-conversion.md](document-conversion.md) | LibreOffice conversion in the API or the private Cloud Run worker: caps, timeouts, failures |
| Settings | [settings.md](settings.md) | Firm/user settings (jsonb), preferences |
| Reference Data | [reference-data.md](reference-data.md) | Court/UTBMS catalogs, firm courts, practice areas, note types and templates, deadline-set seeding |
| Authentication | [authentication.md](authentication.md) | Firebase Auth, server-side email verification, route guards |
| Law Firms / RBAC / Plans | [lawfirms-rbac-plans.md](lawfirms-rbac-plans.md) | Tenancy, roles/permissions, permission cache, plan enforcement |
| Admin Console | [admin-console.md](admin-console.md) | Platform admin gate, `/api/admin` routes, cross-tenant limits, whitelist and test accounts |
| Invitations | [invitations.md](invitations.md) | Token-based member & client invites |
| Notifications | [notifications.md](notifications.md) | Event bus, outbox backstop, in-app notifications |
| Server-Side Search | [server-side-search.md](server-side-search.md) | `/lookup` typeaheads + paged lists, page-then-enrich CTE, ethical wall |

## What changed in the improvement sweep

This section and the two after it are a **historical record** of the audit passes. Their
verification notes name ad hoc scripts (`test-trust`, `test-messaging-rls`) and migrations that
no longer exist; the Jest suites in `backend/tests/` replaced the scripts, and `schema.sql`
replaced the migrations.

The original audit surfaced ~150 findings. The large majority have been implemented and
verified against the database (every `backend/db/test-*.js` module script passed at the
time; those ad hoc scripts have since been retired in favor of the Jest integration suite
in `backend/tests/`). Highlights:

- **Correctness/security:** server-side email verification; invoice totals recomputed
  server-side; invite accept is now a guarded, transactional `status='accepted'`
  transition; client-accept guards `invite_type`; constant-time signing-secret compares;
  the bulk task + calendar event payloads were fixed (they had silently stopped
  firing notifications/calendar-sync); the signature-session status CHECK was
  corrected for multi-signer flows.
- **Performance:** N+1 elimination and batching across matters/tasks/billing/trust/clients/
  signatures; a single dashboard-summary endpoint (cold-load GETs ~9–11 → 4); messaging
  conversation-list and `getConversation` de-duplicated; a permission cache; integer-cent
  money math end-to-end; ~25 new indexes (migrations 0037, 0043).
- **Architecture:** the two ~1,700-line Google/Outlook sync services unified into one
  `providerSyncEngine` + strategies; a durable `event_outbox` + worker (flag-gated);
  the `files` table is now dual-written; shared helpers replace duplicated money/status/
  derivation logic.
- **Cleanup:** dead tables dropped (`template_assets`, `conversation_read_state`,
  `task_visibility`, `case_field_definitions`); dead endpoints/Firestore shims removed;
  process comments stripped from code; lint warnings 68 → 14.

That sweep shipped as the old migrations `0035` to `0058`, which are now folded into
`schema.sql`. To change the schema today, edit a domain file in `backend/db/schema/` and write a
new numbered migration with the `new-migration` skill; see
[/dev/ops/database](../dev/ops/database.md). The whole ~150-finding backlog plus the prior re-audit's
notable findings have since been **implemented** across matters/tasks/clients/billing/trust,
calendar/e-signatures/files/settings/dashboard, and auth/RBAC/invitations/notifications/
messaging (and a conservative templates-backend pass), and the Automations feature was
removed.

## Re-audit history

**3rd-pass findings — all now implemented.** The third re-audit surfaced gaps/regressions
introduced by the big sweep; every one has since been fixed and verified: the `requireFeature`
plan-gates now run after `verifyToken` (unauthenticated → 401, no plan-tier leak); messaging
patch-in-place firm-unread now matches the server's `sender_type='client'` semantics; single-use
signing tokens are stamped `consumed_at` so the "already complete" reload screen shows correctly;
`portalStatus:'invite_failed'` is typed and surfaced with a resend prompt; the files SQL read path's
shape gaps (`clientVisible`/`folderColor`/`updated`/legacy merge) are reproduced via migration 0066;
the Outlook webhook now throws on transient 429/5xx so the retry path records a durable failure;
token verify passes `checkRevoked:true`; and client-invite revoke is wired in the frontend.

**4th-pass findings — implemented.** A fourth re-audit (after the 3rd-pass fixes) checked for
regressions introduced *by* those fixes, and fixed them:

| Severity | Finding | Resolution |
|----------|---------|------------|
| High | The wave-3 "always-on" outbox enqueue wrote an `event_outbox` row per emit, but the retention sweep stayed worker-gated — so with `EVENT_OUTBOX_WORKER` unset (default) `pending` rows grew unbounded with no consumer/pruner | Tied persistence to the worker: enqueue is skipped entirely when the worker is off (live in-process emit is the sole path, zero write-amp); worker on → persist + retry + bounded sweep (`eventBus.ts`, `eventOutbox.ts`) |
| Med | Calendar **Google** delta dropped transient failures — a non-410 non-OK response `return`ed without throwing, so 429/5xx aborted the page loop and the webhook reported success with no retry (the exact gap the Outlook side had just fixed) | Google delta now throws a retryable error on 429/5xx/rate-limit reasons so the webhook records a durable retry; 410 full-resync handling unchanged (`google.service.ts`) |
| Med | User-settings lock was bypassable on write: the lock gate was skipped when the caller omitted the `?lawFirmId=` query param | Lock authority is now derived server-side from the user's firm memberships (union of all firms' locks); the query param is no longer trusted for enforcement (`settings.service.ts`) |
| Med | `markAccepted` became dead code after the invite-accept refactor (a non-transactional TOCTOU footgun for a future caller) | Deleted (`invitations.repository.ts`) |
| Low | Dashboard summary sent the timezone twice (header + an ignored `tz` query param), widening the dedup cache key; `batchUpdateCaseTasks` was dead | Dropped the `tz` query param; removed the dead method |

A further pass implemented the remaining contained findings (outbox retention pruning;
settings jsonb bounds + lock/unlock key enum; paginated GCS folder ops; signing access-code
cumulative cap + prod cert guard; clients `= any` batching; atomic `createMatter`; messaging
realtime-timer ref-counting) — see the per-doc improvement sections.

## Large refactors — implemented

The genuinely large items were then taken on directly:

| Area | What was done | Verified by |
|------|---------------|-------------|
| Trust | Balance reads switched off O(n) `SUM` onto the stored running-balance snapshot columns; `voidWithBalance` recomputes downstream snapshots in-txn with a consistency guard; migration 0071 backfills + repairs all snapshots (caught one stale account off by 10,090,000¢) | `test-trust` + a full snapshot-vs-SUM parity check ("all match"); the ~16 negative dev balances are genuine test-induced over-withdrawals |
| Messaging | Per-row RLS `messages` subquery replaced by a `SECURITY DEFINER` helper `messaging_can_access_conversation` (search_path pinned, execute granted to `authenticated` only), migration 0072 | `test-messaging-rls` (client+member read, stranger blocked) |
| Tasks | Table moved to server-side pagination + whitelisted sort + status/assignee/matter/priority/search filters pushed into SQL; analytics already aggregates in SQL | `test-tasks` + frontend build |
| Dashboard | Team roster + pending signatures folded into the single `dashboard-summary` call (−2 cold GETs, no duplicate count); `sectionErrors` wired to every widget | `test-dashboard` + frontend build |
| Files | The folder tree moved out of the storage path and into `files.parent_id`. A rename is one UPDATE, a same-name upload race is decided by a unique index, and every operation takes a row id. Storage holds bytes at `objects/{id}` and nothing else (`files.md`) | The files suites, plus `npm run db:files-tree`, which fails the build on any shape that would put the tree back into the path |

## Remaining / deferred work (each detailed in its doc)

These require a real environment, infra, or manual verification this codebase pass cannot provide,
so they are intentionally left for dedicated efforts:

| Area | Remaining item | Why deferred |
|------|----------------|--------------|
| Calendar | Reuse the `syncToken` delta on the foreground poll; move the outbound coalesce / token-refresh lock / watch map to DB advisory locks for multi-instance safety | Live two-way sync — needs real Google + Outlook accounts to verify create/update/delete round-trips both directions before merge (the webhook transient-retry/dead-letter half is already done) |
| E-Signatures | Collapse the duplicated v1/v2 finalize branches; move the P12 cert to a secret store; participant-token rotation | The finalize unification needs manual PDF signature/tamper verification a script can't assert; cert relocation is an ops task (the cumulative lockout cap + prod cert guard are done) |
| RBAC | Cross-instance permission cache (currently process-local) | Needs Redis/pub-sub infra not present; correct on a single instance |
| Notifications | Producers enqueue the outbox row inside their own write transaction (true transactional outbox) | Evaluated and intentionally deferred: now that persistence is worker-gated (and the worker is off by default), the only gain is closing a tiny commit→enqueue crash window, at the cost of threading a pg client through every producer + repo — high blast radius for low marginal value. The `enqueue(…, client)` opt-in already exists for a future need |
| Templates | Stop full-array `assets` jsonb rewrites (the always-empty `html` column is gone; `templates` now stores `html_object_path`) | Delicate module under concurrent frontend refactor; left alone deliberately |
| Auth | Move the frontend `VERIFICATION_WHITELIST` server-side | Config concern; the two lists are documented to be kept in sync per-env |

## Operational note

Server-side email verification (`backend/src/shared/middleware/auth.ts`) reads its allow-list
from the `EMAIL_VERIFICATION_WHITELIST` env var (comma-separated, default empty). In dev,
set it to the test accounts that aren't email-verified, or those accounts will get
`403 EMAIL_NOT_VERIFIED`. In production it should stay empty (real verification enforced).
