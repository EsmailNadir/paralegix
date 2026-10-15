# Clients & Client Portal

## Summary

The Clients feature has two distinct audiences sharing one data store:

1. **Firm-side CRM** (`firm_member` users): create/list/update/delete clients (people and organizations), manage per-client notes, related contacts, company relationships, matter associations, billing rates, and standalone client events. Mounted at `/api/lawfirms/:lawFirmId/clients` (`backend/src/app.ts:862`, with the client notes router ahead of the main router), gated by RBAC permissions (`clients.view` / `clients.manage`).
2. **Client Portal** (`client` users): a self-service area where the client sees only *their own* matters, billing/invoices (with Stripe checkout), client-visible documents (which they can also upload to, and against which the firm can raise document requests), messages, trust ledger, events, notifications and portal settings. Mounted at `/api/client-portal` (`backend/src/app.ts:867`), gated by `requireUserType(['client'])` on the whole router (`backend/src/modules/clients/portal/portal.routes.ts:44`) plus a per-firm gate that answers 402 when the firm's billing is inactive and 403 when the firm has turned off its `clientPortal` feature (`:89-129`).

A client row is either a person or an organization (`clients.client_type`, immutable after insert). A person reaches the portal through `clients.user_id`: a row with `user_id IS NULL` is a placeholder (added before the client had an account), and when the client logs in, identity-linking promotes or merges that placeholder onto their Firebase UID (`linkClientIdentityToFirm`, `backend/src/modules/clients/clientIdentityLinking.service.ts:437`). An organization never has a `user_id`; people reach its portal through `client_company_links` rows that tie their person client to the company.

## Key Takeaways

- **`clients` is the single source of truth for the client↔firm association.** A portal user's associations in a firm are resolved from two arms by `resolveClientAssociations` (`portal/clientAssociation.resolver.ts:169`): person rows where `clients.user_id` is their uid, and company rows reached through `client_company_links`. Matters come from `matter_clients` for the chosen client record.
- **Portal access scoping is derived, never client-supplied.** Every portal handler resolves `getActiveClientAccessContext()` (`portal.service.ts:448`), which self-heals the person arm, resolves associations, and throws `ForbiddenError` when there are none (`:464`). A uid with several associations in one firm must pick one with `clientRecordId` (`CLIENT_SELECTION_REQUIRED`); the server still checks that the chosen record is one of theirs. The client record id and accessible `matterIds` / `taskIds` come from the server.
- **The access context is memoized for 5s and invalidated on association change.** A bounded LRU cache (`ACTIVE_CONTEXT_TTL_MS = 5000`, at most 2000 entries) keyed by `(lawFirmId, uid, clientRecordId)` collapses one page load's burst of resolves into one (`portal.service.ts:297-330`); an explicit `authEmail` override bypasses it. Firm-side mutations that change an association call `invalidateAccessContext` (`:343`), which drops every entry for that firm and uid, but only **on the instance that ran the mutation**: the cache is process-local.
- **`createClient` resolves exactly one client row.** Portal invitation preparation resolves or creates the canonical client inside the client transaction. The service reuses that row, or the existing row keyed by user id, or creates one fresh placeholder. Requested matter links share the transaction and email follows commit.
- **The firm grid is server-paged.** `ClientViewGrid` uses `useClientsTable` (`hooks/clientHooks/useClientsTable.ts`) and invalidates `["clients", lawFirmId]` after mutations (`ClientViewGrid.tsx:281`). `listClients` (`clients.service.ts:165`) reads through `listClientsPaged` (`clients.repository.ts:211`), and each client's `matterIds` is narrowed to the matters the caller can see.
- **`createClient` surfaces invite-send failures end-to-end.** A failed invite returns `portalStatus: 'invite_failed'` (`clients.service.ts:273`), which `ClientViewGrid` renders as a distinct warning with a "Resend invite" action (`ClientViewGrid.tsx:263`, `onResendInvite` at `:318`).
- **RBAC on the firm side:** `clients.view` (reads) and `clients.manage` (writes); billing rates use `billing.viewRates` / `billing.manageRates` (`clients.routes.ts:379,389`); the portal-files preview and the client's standalone-task list use `files.view` (`:237,248`). Firm owners bypass all checks.
- **Client notes follow the client's matters.** Notes go through the shared notes router, and `assertClientNoteAccess` (`notes/clientNotes.service.ts:60`) lets a member read a client's notes only if the client is on no matter (the intake case) or the member is on one of that client's matters; owners, firm admins and holders of `notes.viewFirmWide` always pass.
- **Portal reads and writes are Zod-validated.** Messages, mark-read, settings, trust ledger, billing, conversations, notifications, events and document URL refreshes all run through `validate()` (`portal.routes.ts:184-508`, schemas in `portal.validation.ts`).
- **Portal billing trusts the backend payload.** `serializePortalInvoice` (`portal.service.ts:141`) computes `status`/`remainingBalance` server-side, and `buildPortalBilling` (`:651`) batches the matter invoices and matching matter-client ids. A company association may lack billing rights (`assertCanViewBilling`, `:217`).
- **Self-healing identity linking** runs on portal access for the person arm only: an unlinked row found by email is linked, duplicate placeholders merged, and a pending invite auto-accepted (`selfHealPersonAssociation`, `portal.service.ts:364`). Email matching never grants company access. The merge **preserves contact detail**: the placeholder's `phone`, `organization`, `address`, `preferred_contact_method`, `email` and `stripe_customer_id` are coalesced onto the survivor first (`clientIdentityLinking.service.ts:220-225`), and organization rows are refused as merge sources.
- **The portal has its own notification bell** (`listClientNotifications` / `markClientNotificationRead` / `markAllClientNotificationsRead`, `portal.service.ts:2525-2558`), and the Documents view badges never-opened shares as **New** from `file_client_access.first_seen_at` (`db/schema/85_files.sql:231`, `annotateNewFlags` at `portal.service.ts:2585`).

---

## How It Works

### Transaction boundaries

Organization creation rejects direct portal invitations. Portal identities belong to person clients on the Organization's roster. Optional invitation preparation, including canonical-client resolution, stays inside its savepoint; a failure discards both its writes and deferred effects. After-commit delivery failures are logged and do not turn a committed client creation into a failed HTTP response or prevent later creation events.

Client creation commits its canonical client row, optional portal invitation preparation and requested matter links together. Invitation preparation runs in a savepoint so an expected invitation failure can remain non-fatal without leaving partial invite writes. Email, identity-message reconciliation and client/matter events run only after the outer commit. Existing portal accounts resolve the actual client record by email rather than treating their Firebase uid as a client-row id.

Creating a related person contact commits the directory row and `contact_clients` link together. Editing one commits directory fields, stale targeted-invitation revocation and relationship/primary flags together. Directory events follow commit.


### Entry Points

**Backend route registration**

| Surface | Mount | File:line |
|---|---|---|
| Firm CRM routes | `/api/lawfirms/:lawFirmId/clients` (`[clientNotesModuleRoutes, clientsModuleRoutes]`) | `backend/src/app.ts:862` |
| Portal routes | `/api/client-portal` | `backend/src/app.ts:867` |

**Firm CRM endpoints** (`backend/src/modules/clients/clients.routes.ts`), all `verifyToken` + `requirePermission(...)`:

| Method & Path | Permission | Handler | Line |
|---|---|---|---|
| `POST /` | `clients.manage` | `createClient` | `:33` |
| `GET /events` | `clients.view` | `listAllClientEvents` | `:45` |
| `GET /` (`?ids=` batch, `?portalOnly=true`) | `clients.view` | `getClientsByIds` / `listClients` | `:64` |
| `GET /lookup` | `clients.view` | `lookupClients` (typeahead) | `:117` |
| `GET /:clientId/company-relationships` | `clients.view` | `listClientCompanyRelationships` | `:146` |
| `GET /:clientId/summary` | `clients.view` | `getClientSummary` (`clientSummary.service.ts`): matter count, invoice count and owned billed/paid/outstanding cents in SQL; `matters` null without `matters.view`, `billing` null without `billing.viewInvoices` | `:161` |
| `GET /:clientId` | `clients.view` | `getClient` | `:156` |
| `PUT /:clientId` | `clients.manage` | `updateClient` | `:167` |
| `DELETE /:clientId` | `clients.manage` | `removeClient` | `:179` |
| `POST /:clientId/revoke-portal-access` | `clients.manage` | `revokePortalAccess` | `:189` |
| `POST` / `DELETE` / `GET` `/:clientId/matters[...]` | manage / view | matter-association ops | `:199,:212,:224` |
| `GET /:clientId/portal-files` | `files.view` | firm-side preview of what the client sees in the portal | `:237` |
| `GET /:clientId/tasks` | `files.view` | standalone tasks the client is linked to (share-files picker) | `:248` |
| `GET`/`POST`/`PUT`/`DELETE` `/:clientId/contacts[/:linkId]` | view / manage | related-contact links | `:261,:271,:287,:302` |
| `GET`/`POST`/`PUT`/`DELETE` `/:clientId/events[/:eventId]` | view / manage | client-event CRUD | `:313,:331,:357,:401` |
| `GET`/`PUT` `/:clientId/billing-rates` | `billing.viewRates` / `billing.manageRates` | billing rate ops | `:379,:389` |

Client notes (`/:clientId/notes*`) come from the shared `createNotesRouter` configured in `notes/clientNotes.routes.ts:11-22` with `clients.view` / `clients.manage`: list, get, versions, create, update, pin, retract, time entries and replies. Note time (the three time routes, and a note posted with `timeEntries`) needs `billing.manageTimeEntries` as well, as on every parent.

The `GET /` route is overloaded: a `?ids=a,b,c` query triggers a batch profile resolve (`getClientsByIds`), **capped at 200 ids; an over-cap request is rejected with a 400 `ValidationError`, not truncated** (`clients.routes.ts:74-86`); otherwise it returns the firm client list (`:93`).

**Portal endpoints** (`backend/src/modules/clients/portal/portal.routes.ts`), all behind `verifyToken` + `requireUserType(['client'])` (`:44`), a `router.use` that backfills `req.userData.email` from the token (`:46-51`), and the per-firm billing/portal-feature gate on `/lawfirm/:lawFirmId` (`:89`). Most handlers accept an optional `clientRecordId` to pick among several associations. Endpoints: `my-lawfirms`, `firm-summaries`, `lawfirm/:id/associations`, `matters[/:matterId]`, `billing` (validated), `invoices/:invoiceId`, `documents` + `matters/:matterId/documents`, document URL refreshes (validated, record the first open), resumable `matters/:matterId/documents/upload-init` / `upload-finalize` / `upload-cancel` (`:265,:278,:290`), `document-requests` plus item upload, upload-cancel and fulfillment routes (`:302-381`), `messages/conversations`, `messages` GET / POST / `mark-read`, message attachment `upload-init` / `upload-finalize` / `upload-cancel`, `unread-count`, `events`, `billing/pay/:invoiceId`, `trust/balance` + `trust/ledger`, `settings` GET/PUT, `notifications` GET / `mark-all-read` / `:notificationId/read` (`:508-526`), and `dashboard` (`:538`).

**Frontend entry points**

| Surface | File:line |
|---|---|
| Firm clients page (thin wrapper → `ClientViewGrid`) | `frontend/src/app/lawfirm/[lawFirmId]/clients/page.tsx` |
| Firm clients grid (server-paged, owns UI state/modals) | `frontend/src/components/clientComp/ClientViewGrid.tsx` |
| Firm clients hooks | `frontend/src/hooks/clientHooks/useClientsTable.ts`, `useClients.ts` |
| Firm clients service | `frontend/src/services/clients.service.ts:295` |
| Portal pages (matters/billing/calendar/documents/messages/signatures/trust/settings) | `frontend/src/app/client/lawfirm/[lawFirmId]/*` |
| Portal dashboard page | `frontend/src/app/client/dashboard/page.tsx` |
| Portal service | `frontend/src/services/client-portal.service.ts:269` |

### Trace: Portal client loads their dashboard

`GET /api/client-portal/lawfirm/:lawFirmId/dashboard`:

1. `verifyToken` verifies the Firebase ID token and sets `req.user`.
2. `requireUserType(['client'])` loads the user row, confirms `userType === 'client'`, attaches `req.userData`; the next `router.use` backfills `req.userData.email` from the token (`portal.routes.ts:44-51`).
3. The `/lawfirm/:lawFirmId` gate (`:89`) loads the firm's plan and passes straight through when billing is active and the `clientPortal` feature is on; otherwise it confirms the caller belongs to the firm and answers 402 `BILLING_INACTIVE` or 403.
4. The handler (`:538`) calls `getClientDashboard` (`portal.service.ts:2381`), which resolves `getActiveClientAccessContext()` (`:448`):
   a. A cache hit on `(lawFirmId, uid, clientRecordId)` returns immediately (skipped when an `authEmail` override is passed).
   b. Otherwise `resolveAssociationsWithSelfHeal` (`:401`) runs the person-arm self-heal (link an unlinked row found by email, or auto-accept a pending invite, `selfHealPersonAssociation`, `:364`) and resolves the person and company associations.
   c. No associations ⇒ `ForbiddenError` (`:464`). Several and no `clientRecordId` ⇒ `CLIENT_SELECTION_REQUIRED`.
   d. `resolveMatterAndTaskIds` (`:416`) reads the chosen record's `matterIds` from `matter_clients` and its standalone `taskIds`; the context is cached.
5. `getClientDashboard` runs `buildPortalMatters` (`:565`) and, when the association may view billing, `buildPortalBilling` (`:651`) in parallel.
6. The profile is enriched from the already-loaded `context.clientRecord`. `notes` is always `[]`: client notes are firm-internal and never reach the portal.
7. Response `{ profile, notes: [], matters, invoices, billingSummary }`.

### Trace: Firm member creates a client (with portal invite)

`POST /api/lawfirms/:lawFirmId/clients`:

1. `ClientViewGrid` validates name/email client-side and calls `clientsService.createClient(lawFirmId, {...})` (`ClientViewGrid.tsx:219`).
2. `verifyToken` → `requirePermission('clients.manage')` → `validate(createClientSchema)` (`clients.routes.ts:33-35`).
3. `createClient` (`clients.service.ts:242`) resolves the email, decides `shouldAutoInviteToPortal = portalInvitePending && !userId && !!email` (`:251`), and looks up any existing row by `userId` (`:253`).
4. Prepare the auto-invite inside a savepoint of the client transaction. Its database writes can roll back without poisoning client creation; an expected preparation failure remains non-fatal and sets `portalStatus = 'invite_failed'`. Delivery is deferred until the outer commit.
5. Resolve exactly one target row: the canonical client prepared by the invite, else an existing row keyed by `userId`, else a fresh placeholder. `upsertTxn` receives the outer executor.
6. Validate and link any requested `matterIds` through `linkMattersTxn` on the same executor. Failed links roll back the client and invite preparation. `MATTER_CLIENTS_UPDATED`, `CLIENT_CREATED` and email follow commit.
7. Emits `CLIENT_CREATED` and returns `{ clientId, portalStatus }` (`:332-333`). The grid maps `portalStatus` to a message and invalidates `["clients", lawFirmId]` (`ClientViewGrid.tsx:263-281`).

### Portal Documents Are Two-Way

The portal is not read-only for documents. A client can:

- **Upload into any matter they are on**, through the resumable `upload-init` / `upload-finalize` pair (`portal.routes.ts:265,278`; `beginMatterDocumentUpload` / `finishMatterDocumentUpload`, `portal.service.ts:2025,2041`, 100 MB per file). Both halves check `ensureMatterAccess(context, matterId)`, and finalize emits `DOCUMENT_UPLOADED_BY_CLIENT` (`:2054`) to notify the firm.
- **Fulfill a document-request checklist item** the firm sent them, on a matter or a matter-less "General" request (`beginRequestItemUpload` / `finishRequestItemUpload`, `portal.service.ts:2091,2118`). The request must be addressed to this client, and a client can delete only their **own** fulfillment. See [Document Requests](document-requests.md).

Both uploads open at most 10 files per init (`PORTAL_DOCUMENT_MAX_FILES`, `portal.service.ts:1808`) and take up to 50 in ONE finalize (`PORTAL_DOCUMENT_MAX_FINALIZE`, `:1821`). `clientPortalService` declares a larger selection in inits of 10 and finalizes all of it in one call, so the firm gets one notification per selection; it refuses more than 50 files before any init. The upload modal, the matter page and the checklist panel keep the first files up to their limit and say how many were left out.

Each init holds a quota reservation per file, returned as `reservationId` and echoed back at finalize, which deletes it. Storage usage counts saved files only; a reservation not finalized or cancelled lapses after two hours (see [files.md](files.md#storage-usage)). **A cancel releases at once:** `upload-cancel` on either route (`portal.routes.ts:290,342`; `cancelMatterDocumentUpload` / `cancelRequestItemUpload`, `portal.service.ts:2070,2167`) takes `{ uploads: [{ fileId, reservationId }] }` (at most 50), deletes the reservations, then the rows that are in scope, unfinalized and claimed by this client, with their partial objects, freeing the names. It answers `{ cancelled: n }`. The frontend sends it for every session every init group opened whenever an upload stops short of finalize, cancelled or failed, without waiting on it or reporting its failure.

What a client can **see** is answered from the files tree, not by scanning storage: sharing is a column on the file or folder and per-client narrowing is `file_client_visibility`, so one recursive query (`listVisibleDocuments`, `portal.service.ts:1153`) decides it and the portal cannot disagree with the firm side. Each document's and folder's path from the scope root comes from one more query for the whole scope (`filesRepo.ancestorsForMany`), not a query per row, so a listing takes the same number of pool connections however many files it returns; the firm-side preview (`firmScanScope`) reads paths the same way. Download URLs are signed lazily through the refresh routes, which also record the first open.

### Data Model

Tables live in `backend/db/schema/20_parties.sql` (generated into `schema.sql`).

**`clients`** (`20_parties.sql:9`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | also `unique (law_firm_id, id)` for composite FKs |
| `law_firm_id` | uuid | FK → `law_firms`, `on delete cascade` |
| `client_type` | text | `person` (default) or `company`; immutable after insert (trigger `clients_type_immutable`); a company may not have a `user_id` (`clients_company_no_user_id_check`) |
| `user_id` | text (nullable) | FK → `users(id)` `on delete set null`; **portal identity link** for a person; NULL = placeholder |
| `email` | citext | case-insensitive; **not unique** |
| `name` | text not null | a company's legal name |
| `phone`, `organization`, `address`, `preferred_contact_method` | text | `organization` is a person's employer, not a company's name |
| `status` | text default `active` | CHECK `active` / `inactive` / `archived` |
| `portal_invite_pending`, `invited_at`, `invited_by`, `joined_at` | | invite lifecycle |
| `invitation_sent_at`, `invitation_resend_count`, `invitation_failed`, `last_resend_at` | | invite delivery tracking |
| `stripe_customer_id` | text | set via `setStripeCustomerIdById` (`clients.repository.ts:424`) |
| `billing_rates` | jsonb `{}` | `{ defaultRate, memberRates }` |
| `settings` | jsonb `{}` | client portal/notification prefs |

Indexes: `clients_firm_email_idx`, `clients_firm_type_idx`, `clients_user_id_idx`, `clients_firm_name_idx`, `clients_email_idx` (global, for email-based firm discovery), `clients_created_at_idx`, and the `lower(name|email|organization)` expression indexes for the conflict check (`20_parties.sql:48-74`).

**Notes**: client notes are rows in the shared `notes` table with `client_id` set (`db/schema/50_notes.sql:65`), with versions and replies in `note_versions` / `note_replies`, the same model as matter and task notes (see [Matters](matters.md#notes)). Note types and templates are covered in [Reference Data](reference-data.md).

**Related contacts**: `contact_clients` (`20_parties.sql:154`) links a firm-wide directory contact (see [Contacts](contacts.md)) to a client with a free-text `relationship`, an `is_primary` flag (one primary per client, partial unique index) and delivery preferences. The old per-client `client_contacts` table is gone.

**Company relationships**: `client_company_links` (`20_parties.sql:201`) ties a person client to a company client (composite FKs, cascade, one primary company per person). It is what gives a person portal access to a company and what the conflict check follows.

**Events**: standalone client events are rows in the shared `events` table with `client_id` set (`db/schema/60_calendar.sql:158`); matter events use the same table with `matter_id` (see [Calendar](calendar.md)).

**Foreign keys**: the client-referencing FKs are declared and kept (the old soft-reference sweep that dropped them was retired). `clients.service.removeClient` still deletes a client's children itself, in one transaction, through `deleteClientCascade` (`clients.repository.ts:813`).

Related junctions: `matter_clients` (composite FKs, with `billing_portion_bp` for split billing); `task_clients` (firm-scoped tasks); invoice contexts reference clients via `client_context_id`.

**`file_client_access`** (`db/schema/85_files.sql:231`): `(law_firm_id, client_user_id, file_id)` + `first_seen_at`. Records which shared files a portal client has opened so the Documents view can badge the rest as "New". Sharing and share notifications write the same row, so a row by itself is not an open: only a non-null `first_seen_at` is. `recordView` upserts it and `getSeenFileIds` reads it (`portal/clientDocumentViews.repository.ts`). The share digest producer is documented in the Files feature doc.

### Key Logic & Rules

**Validation** (`clients.validation.ts`): Zod. Client name trimmed, 1-200; `phone` ≤ 100, `organization` ≤ 200, `address` ≤ 1000; `status ∈ {active,inactive,archived}`; `preferredContactMethod ∈ {email,phone,sms,portal}`, where null on create or update records "no preference" and only an absent field on create takes the `email` default; `clientType ∈ {person,company}` (`:4-22`). Portal reads and writes are validated in `portal.validation.ts`: messages, mark-read, settings (a strict whitelist), trust ledger, document URL refreshes, billing, messages and conversations paging, notifications, events (`:11-156`). Portal uploads go through the resumable init/finalize pair, bounded in the service (at most 5 message attachments per batch, and 10 matter documents per init with up to 50 per finalize, 100 MB each, `portal.service.ts:1651-1652,1808-1821`). Both halves enforce the count: a finalize naming more uploads than that is refused with 400, and the document finalize loads every claimed row in one query (`filesRepo.findManyByIds`).

**Portal access control / client scoping:** Every data handler derives scope from `getActiveClientAccessContext()` (`portal.service.ts:448`):
- The client record is resolved from `req.user.uid` (with the email-based self-heal for the person arm), never from a request-supplied id; a supplied `clientRecordId` only chooses among the caller's own associations.
- No association ⇒ `ForbiddenError` (`:464`).
- Per-matter access is enforced by `ensureMatterAccess(context, matterId)` (`:201`), used by matter reads, matter documents, uploads and document requests.
- Billing reads and payment require `assertCanViewBilling` (`:217`). Payment (`getPaymentCheckoutUrl`, `:2272`) resolves the invoice's matter and client context in one query, then requires an accessible matter plus `invoiceBelongsToClient` (`:641`), or a client-context invoice on the caller's own record.

**Portal notification bell:** `listClientNotifications` / `markClientNotificationRead` / `markAllClientNotificationsRead` (`portal.service.ts:2525-2558`) each resolve the access context first, then read or write ONLY rows keyed on the caller's own uid in the shared `notifications` table. The feed is polled every 60 s and on focus, not Realtime (`hooks/notificationHooks/useClientNotifications.ts:51`).

**Unseen-document ("New") badges:** `annotateNewFlags` (`portal.service.ts:2739`) stamps `isNew` on each returned document with one `getSeenFileIds` query per listing: the caller's `file_client_access` rows for those file ids whose `first_seen_at` is set. The badge is per client, so another client on the same matter keeps it until they open the file themselves. Opening a document through either refresh route records the first open via `recordView` (`:1268`), idempotent, awaited before the response because the service gets no CPU once the response is sent, and still best-effort: a failed write is logged and never blocks the download. Folders are never badged. `tests/clients/portalNewBadge.test.ts` pins this.

**Access-context cache:** a bounded LRU (`createBoundedCache`, `ACTIVE_CONTEXT_TTL_MS = 5000`, at most `ACTIVE_CONTEXT_MAX_ENTRIES = 2000` entries, env-overridable) keyed by `(lawFirmId, uid, clientRecordId)` (`portal.service.ts:297-330`). An `authEmail` override bypasses it. `invalidateAccessContext` (`:343`) deletes every entry for a (firm, uid) prefix.

**Identity linking** (`linkClientIdentityToFirm`, `clientIdentityLinking.service.ts:437`): transactional, with an optional external executor when the invite-accept flow needs the invite claim and the link committed together. Email matching considers person rows only; a company that shares the email is never linked or merged. Duplicate placeholders are merged into the survivor by `mergePlaceholder` (`:183`), which refuses organization rows as sources, coalesces the placeholder's contact fields onto the survivor first (`:220-225`), and moves its company links and related contacts (`moveCompanyLinks` `:51`, `moveRelatedContacts` `:115`) along with its matters and invoices.

**Matter-client edit is a partial patch.** `matterClients.service.updateClient` (`matters/clients/matterClients.service.ts:86`) writes only the fields the caller sent; an omitted key is left untouched while an explicit empty string still clears the field (`:98-107`), and `mattersRepo.updateClientRecord` (`matters.repository.ts:1958`) builds its `SET` list from only the defined keys.

**Tenancy:** Every query is scoped by `law_firm_id` through the tenant-scoped Drizzle helpers. `getClientOrThrow` guards firm-side reads and writes; client events call `assertClientInFirm` before writing, so an event can never be written against another firm's client. The portal additionally scopes by the resolved client record.

**Revoke portal access** nulls `user_id`, `joined_at` and `portal_invite_pending` but keeps the client row, then invalidates the cached access context (`clients.service.ts:465-475`).

**Delete** (`removeClient`, `clients.service.ts:477`) refuses a client under legal hold (403; a `before delete` trigger backs this up), with trust transactions or a trust minimum balance, with billing records, or (for a company) with a live canonical conversation (409s). It then calls `deleteClientCascade` (`clients.repository.ts:813`), which in one transaction removes `task_clients`, the client's notes, related-contact links, company links, events and pending invitations before the row itself, and invalidates the access context for every affected portal user (`clients.service.ts:556-559`).

**Events** (`clients.events.ts`): registers no listeners. The four it used to register were no-ops; cleanup after a client or matter delete happens through FK cascades, `deleteClientCascade`, and the files, billing, document-request, signature and notification modules' own listeners.

### Dependencies

- **Postgres** through the tenant-scoped Drizzle helpers (`shared/database/queryContext`, `scopedWrite`).
- **Firebase Admin** for Auth token verification and GCS signed URLs.
- **GCS** for client-visible documents and message attachments.
- **Stripe** (`stripe.service.getClientCheckoutUrl`) for portal invoice payment (`portal.service.ts:2335`).
- Cross-module: invitations, users, lawfirms (plan and feature gate), matters and matter events, invoices, messaging, trust, settings, notifications, files, document requests.
- Frontend: `@tanstack/react-query`, `useServerTable`, the shared transport.

### Example

```
POST /api/lawfirms/<firm>/clients
{ "name": "Acme Corp", "email": "ap@acme.com", "portalInvitePending": true }
→ sendClientInvite sends a client invite (may resolve/create the canonical row)
→ upsertTxn writes that single client row (user_id NULL)
→ { "clientId": "...", "portalStatus": "invited" }
```

The client registers with `ap@acme.com`, logs into the portal, and hits `GET /api/client-portal/lawfirm/<firm>/dashboard`. `selfHealPersonAssociation` finds the placeholder by email, `linkClientIdentityToFirm` sets `user_id` to the new UID and clears `portal_invite_pending`, and the dashboard returns the client's matters and invoices.

---

## What Can Be Improved

Resolved since the last pass and dropped: the schema-only build with no client FKs (the soft-reference sweep was retired; the FKs are declared and kept in `20_parties.sql` and the tables that reference clients), and the unbounded access-context map (now a bounded LRU, `portal.service.ts:308-314`).

### Medium priority

1. **The access-context cache is invalidated only on the instance that ran the mutation.** `invalidateAccessContext` (`portal.service.ts:356`) clears a single process's cache. On a multi-instance deploy (Cloud Run scales horizontally) a `revokePortalAccess` or matter-link change on instance A does not clear instance B, so B can serve the stale association for up to the 5 s TTL. If stricter consistency is wanted, move the cache to a shared store or add pub/sub invalidation.

### Low priority

2. **`addClientMatters` still issues a per-matter existence query in a loop.** `linkMattersTxn` resolves the whole set in one query (`clients.repository.ts:720`), but the service-level `addClientMatters` still calls `clientsRepo.matterExists` and `linkMatter` per id (`clients.service.ts:597-613`), 2N round-trips. Route it through `linkMattersTxn`.

3. **`/:clientId/tasks` is gated by `files.view`, not `tasks.view`.** The route exists for the share-files picker (`clients.routes.ts:248-250`), but it returns task rows, so a member without `tasks.view` can list a client's standalone tasks. Either gate it on both permissions or return only the fields the picker needs.

4. **`portal.service.ts` keeps generic date helpers.** `toMillis` (`:64`) and `ts` (`:128`) handle ISO strings and `Date`s correctly but duplicate helpers found in other modules; a candidate for `shared/utils/time`.
