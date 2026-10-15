# Document Requests and Share Links

## Summary

A **document request** is a checklist a firm sends to one client ("please upload your W-2, last three
bank statements, ..."). The client sees it in the portal, uploads files against each checklist item,
and the firm sees each item flip to `received`, with the request rolling up to `completed` when
nothing is left pending. A request is either tied to a matter or is a matter-less "General" request
addressed to a client of the firm.

A **public share link** is the other direction: an expiring, optionally password-protected URL to a
single file, for someone with no portal account (opposing counsel, an expert, a court). It lives in
the files module and is resolved by an unauthenticated route.

This page is the detailed reference for both. Storage model: [Files](/features/files). Portal
identity: [Clients](/features/clients).

## Key Takeaways

- **Three route families.** Firm side at `/api/lawfirms/:lawFirmId/document-requests` (permission
  `documents.request`), portal side under `/api/client-portal/lawfirm/:lawFirmId/document-requests`
  (client users only), public share at `/api/share/:token` (no auth, IP rate-limited)
  (`backend/src/app.ts:879-881,910`).
- **Status is a rollup.** An item is `pending | received | waived`; a request is
  `open | completed | cancelled`. `recomputeStatus` sets `completed` when a request has items and none
  are pending, otherwise `open`, and never touches `cancelled`
  (`documentRequests.repository.ts:423-437`).
- **An uploaded file is an ordinary `files` row.** A fulfillment is an `attachments` row pointing at
  that file through the `document_request_item_id` arm (`86_messaging.sql:298,317`). Renames and moves
  do not break the link, and the upload is billed against firm quota like any other upload.
- **Portal uploads are direct-to-storage and quota-reserved.** Init claims `files` rows, reserves the
  declared bytes, and mints one GCS resumable session per file; finalize verifies what landed and
  settles the reservation exactly once (`shared/storage/directUpload.ts:315-388,453-532`).
- **A client can only reach requests addressed to its own client record**, resolved server-side from
  the caller's uid, never a request-supplied client id (`documentRequests.service.ts:215-220`).
- **There are no reminders.** Nothing reads `due_date` on a schedule; the only messages are the
  creation bell and email, and the firm bell on client upload (`documentRequests.events.ts`).
- **Share-link tokens are bearer credentials** (48 hex chars, stored in plaintext as the primary key),
  expire between 1 hour and 1 year, and are revoked when the file is deleted
  (`files/shareLinks.service.ts:46-82`, `files.mutate.routes.ts:167,322`).

---

## How It Works

### Transaction boundaries

Checklist mutations serialize on the request header. Header edits and added items, item status changes, firm file linking, portal fulfillment recording, and portal removal of the final fulfillment share their request transaction with status rollup recomputation. Portal fulfillment recording rechecks cancellation after taking the lock. Failed rollups restore both the item/fulfillment writes and the header (`documentRequests.repository.ts::withLockedRequest`). Storage uploads remain separate from these database transactions.


### Entry Points

**Firm side**, mounted at `app.ts:880` (no router-level auth or feature gate; each route applies
`verifyToken` + `requirePermission('documents.request')`, `documentRequests.routes.ts`):

| Method and path | Handler | Extra check |
|---|---|---|
| `GET /?matterId=` | `listRequests` (paged, max 200) | `assertMatterReadAccess` (`service.ts:84-87`) |
| `POST /` | `createRequest` | matter membership + client on matter, or client belongs to firm (`service.ts:18-82`) |
| `GET /clients/:clientId` | `listClientRequestsForMember` (unpaged) | per row: general requests, plus matter requests the caller may read. Owners and admins read every matter; other members only matters they are on (`isFirmOwnerOrAdmin`, `getAccessibleMatterIds`) |
| `GET /:id` | `getRequest` | matter read access if matter-scoped (`service.ts:89-94`) |
| `PATCH /:id` | `updateRequest` (title, note, status, due date, `addItems`) | matter membership if matter-scoped (`service.ts:96-121`) |
| `DELETE /:id` | `deleteRequest` | same (`service.ts:123-129`) |
| `PATCH /:id/items/:itemId` | `updateItem` (mark `received` / `waived` / `pending`) | same (`service.ts:132-144`) |
| `POST /:id/items/:itemId/link-file` | `linkFile` (attach an existing matter file) | matter-scoped requests only (`service.ts:155-184`) |
| `DELETE /:id/items/:itemId/files/:fulfillmentId` | `unlinkFile` | same as update (`service.ts:187-199`) |

Presets live at `/document-request-templates` (`app.ts:881`): read needs `documents.request` or
`settings.viewFirm`, writes need `settings.manageFirm` (`documentRequestTemplates.routes.ts:18-56`).

**Portal side**, inside the client portal router, which applies `verifyToken` +
`requireUserType(['client'])` to every route (`portal.routes.ts:44`) and a per-firm billing and
`clientPortal` feature gate to `/lawfirm/:lawFirmId/*` (`portal.routes.ts:89`):

| Method and path | Service (`portal.service.ts`) |
|---|---|
| `GET .../document-requests[?matterId=]` | `listPortalDocumentRequests` (`:2035`) |
| `POST .../:requestId/items/:itemId/fulfill/upload-init` (`uploadLimiter`) | `beginRequestItemUpload` (`:1963`) |
| `POST .../:requestId/items/:itemId/fulfill/upload-finalize` | `finishRequestItemUpload` (`:1990`) |
| `GET .../items/:itemId/fulfillments/:fulfillmentId/url` | `getPortalRequestFulfillmentUrl` (`:2048`) |
| `DELETE .../items/:itemId/fulfillments/:fulfillmentId` | `deletePortalRequestFulfillment` (`:2070`) |

Routes are at `portal.routes.ts:288-356`. Every handler first calls `getActiveClientAccessContext`
(`portal.service.ts:448`), which resolves the caller's client record (person or company roster
contact, optional `clientRecordId` selector).

**Share links:**

| Method and path | Guard | Handler (`files/shareLinks.service.ts`) |
|---|---|---|
| `GET /api/lawfirms/:id/file-share-links?fileId=` | `verifyToken`, `requireFeature('fileSharing')` (`app.ts:879`), `files.upload` | `listShareLinks` (`:84`) |
| `POST /api/lawfirms/:id/file-share-links` | same | `createShareLink` (`:46`) |
| `DELETE /api/lawfirms/:id/file-share-links/:token` | same | `revokeShareLink` (`:92`) |
| `GET /api/share/:token` | `publicShareLimiter` only | `getPublicMeta` (`:112`) |
| `POST /api/share/:token/download` | `publicShareLimiter` only | `resolveDownload` (`:133`) |

The public limiter is 30 requests per minute (`PUBLIC_SHARE_RATE_LIMIT_MAX`), keyed by IP because it
passes no `keyBy` (`rateLimiters.ts:21-37,212-217`).

**Frontend:**

- Firm: `DocumentRequestsPanel` on the matter page (`matters/[matterId]/page.tsx:1789`) with a
  `FilePickerModal` for link-file (`DocumentRequestsPanel.tsx:52-89`), and `ClientDocumentRequestsTab`
  on client detail (`ClientDetail.tsx:1095`) via `GET /clients/:clientId`.
- Create: picking a template in `CreateDocumentRequestModal` copies its title, note and items into
  the form (`CreateDocumentRequestModal.tsx:112-124`); the request stores a snapshot, not a template id.
- Portal: `RequestedDocumentsPanel` hides `cancelled` requests and keeps `completed` ones open for
  more uploads (`RequestedDocumentsPanel.tsx:91-95`), uploading via `fulfillRequestItem`
  (`client-portal.service.ts:634-648`).
- Share: `ShareLinkModal` (expiry 1 h, 24 h, 7 d, 30 d; default 7 d, `ShareLinkModal.tsx:24-31`) and
  the public page `app/share/[token]/page.tsx`, whose layout sets noindex (`app/share/layout.tsx:4-6`).

### Data Flow: a client fulfills one checklist item

1. The client picks files in `RequestedDocumentsPanel`, which calls `fulfillRequestItem`
   (`RequestedDocumentsPanel.tsx:120`). `sendDirectUpload` posts `{ files: [{ fileName, contentType,
   size }] }` to `upload-init` (`client-portal.service.ts:560-576`).
2. `beginRequestItemUpload` resolves the access context, then `getClientRequestTarget` loads the
   request and throws 403 if `request.clientId` is not the caller's client record
   (`documentRequests.service.ts:215-220`). A `cancelled` request is refused with 400, and a
   matter-scoped one also passes `ensureMatterAccess` (`portal.service.ts:201`).
3. `beginClientDocumentUpload` (`portal.service.ts:1777`) creates the scope root folder, then claims
   one `files` row per file (unfinalized, `clientVisible: true`) so the database settles name
   collisions. It calls `beginDirectUploadBatch` with max 10 files and 100 MiB each
   (`portal.service.ts:1762-1763`), tagging object metadata with `documentRequestId` and
   `documentRequestItemId`. If anything fails, the claimed rows are hard-deleted.
4. `beginDirectUploadBatch` admits every file (name, size, type), then calls `reserveStorageUsage`
   for the declared total. A firm over quota is refused before a session is minted. It then creates
   one GCS resumable session per file; if minting fails partway, the reservation is released
   (`directUpload.ts:315-388`).
5. The browser PUTs each file to its session URL, sequentially, with one progress bar for the whole
   batch (`client-portal.service.ts:588-596`).
6. `upload-finalize` runs `finishRequestItemUpload`, which re-resolves the request, re-checks
   cancellation and matter access, because the route stands alone (`portal.service.ts:1990`).
7. `finishClientDocumentUpload` (`portal.service.ts:1850`) loads each named row by `fileId` and keeps
   only rows inside the authorized scope. The object path comes from the row, not the body.
   `settleDirectUploadBatch` verifies each object, `filesRepo.finalize` stamps size and type, and
   quota is committed for what landed, released for what did not, and adjusted for bytes beyond the
   reservation (`directUpload.ts:453-532`).
8. If at least one document landed, `recordFulfillment` inserts one `attachments` row per file and
   sets the item to `received` and runs `recomputeStatus` in the same request-header-locked transaction
   (`documentRequests.service.ts:229-243`, `repository.ts:329-346`).
9. `DOCUMENT_UPLOADED_BY_CLIENT` is emitted; the listener bells every matter member
   (`documentRequests.events.ts:154-183`). The response is `{ documents, failures, requestId, itemId }`
   with 201.

The firm-side path is the same service layer without the upload: `linkFile` checks the file is in
the same matter and inserts the attachment with `createdBy` = the firm user
(`documentRequests.service.ts:155-184`).

### Data Model

From `backend/db/schema/85_files.sql` unless noted.

| Table | Key columns | Notes |
|---|---|---|
| `document_requests` (`:382-402`) | `law_firm_id`, `matter_id` (nullable = General), `client_id`, `title`, `note`, `status`, `due_date` (date), `created_by` | Composite FKs `(law_firm_id, matter_id)` and `(law_firm_id, client_id)`, both `on delete cascade`. Indexes on `(law_firm_id, client_id)` and `(law_firm_id, matter_id, created_at desc, id desc)` (`95_deferred_fks.sql:79-80`). |
| `document_request_items` (`:406-422`) | `request_id` (cascade), `label`, `description`, `status`, `sort_order` | Indexed `(request_id, sort_order)`. |
| `attachments` (`86_messaging.sql:290-336`) | `file_id`, `document_request_item_id`, `created_by` | One of seven parent arms (check constraint `num_nonnulls(...) = 1`). `created_by` is what separates a client's upload from a firm link. |
| `document_request_templates` (`:428-442`) | `name`, `default_title`, `default_note`, `items` jsonb, `archived` | Presets only; a request never references one. |
| `file_share_links` (`:454-481`) | `token` (PK), `file_id` (`on delete set null`), `display_name`, `mime_type`, `permission` (`view`/`download`), `password_hash` (scrypt), `expires_at`, `revoked_at`, `access_count`, `last_accessed_at` | Stores a file id, so a link follows renames and moves. |

A fulfillment's name and path are read live from `files` through a join, so a moved file still
resolves (`repository.ts:84-109,145-163`). `attachedByFirm` is `true` when the attaching user's
`user_type` is `firm_member`; a null `created_by` counts as the client's (`repository.ts:96-108`).

### Key Logic and Rules

**Lifecycle.**

| Action | Item effect | Request effect |
|---|---|---|
| Create | items inserted `pending`, blank labels dropped, max 50 (`validation.ts:22`, `repository.ts:42-49`) | `open` |
| Client upload / firm link-file | item set `received` | `recomputeStatus` |
| Firm `PATCH` item status | any of the three | `recomputeStatus` |
| Firm `PATCH` request without `status` | none | `recomputeStatus` (`service.ts:116-117`) |
| Firm `PATCH` request with `status` | none | written as given, no recompute |
| Firm unlink | item status left alone (`repository.ts:374-379`) | not recomputed |
| Client deletes own upload | item back to `pending` if zero fulfillments remain | `recomputeStatus` (`service.ts:290-307`) |

A request with zero items stays `open` forever through the rollup, because `completed` needs
`total > 0` (`repository.ts:433`). `addItems` locks the request row (`for update`) to serialize
`sort_order` (`repository.ts:272-292`).

**Cancelled vs completed.** Portal init, finalize and `recordFulfillment` refuse `cancelled`
(`portal.service.ts:1963,1990`, `service.ts:233`). `completed` has no such guard, so a client can keep
adding files (pinned by the characterization test in `documentRequestFulfillmentGaps.test.ts:152`).
The firm's link-file does not check `cancelled` at all (`documentRequestFulfillmentConvergence.test.ts:182`).

**Tenancy.** Every repository read goes through `tenantQuery` and every write through
`scopedInsert/Update/Delete`, which bind `law_firm_id` (`repository.ts:25,35`). Ids that are not
UUIDs return null before querying (`repository.ts:169,186`).

**Firm authorization.** Matter-scoped requests enforce matter membership (writes) or matter read
access (reads). General requests have no matter, so `documents.request` is the only gate
(`service.ts:99-101`). `GET /clients/:clientId` has no matter in its path, so
`listClientRequestsForMember` applies the same read rule per row and drops requests on matters the
caller cannot read. The portal calls the unfiltered `listClientRequests` instead, because the
client is the addressee of every row it returns. `documentRequests.test.ts` ("the ethical wall on
the client list") pins both the refusal and the owner and staffed-member controls.

**Portal authorization.** The client id always comes from the resolved access context, never the
request. `listForClient` filters `client_id` and excludes `cancelled` (`repository.ts:211-219`).
A client may preview any fulfillment on its own request, including firm-linked ones, via a signed URL
with `SIGNED_URL_TTL_DEFAULT` (`portal.service.ts:2048-2067`). It may delete only non-firm
attachments; for a company client, any roster contact may delete a colleague's upload
(`service.ts:269-294`). Deleting a fulfillment never deletes the file row.

**Company targets.** `contactClientId` narrows fan-out to one portal-enabled roster link (`service.ts:37-50`).

**Notifications and email** (`documentRequests.events.ts`):

- `DOCUMENT_REQUEST_CREATED`: bell `document_requested` plus an inline-HTML email deep-linking to
  `/client/lawfirm/:id/documents?clientRecordId=`. A person client with no `user_id` gets nothing
  (`:140`). A company fans out to every roster contact with a portal user whose
  `notifications.documentRequested` is not `false`; email only to links with `is_email_recipient`
  (`:123-136`). Email is gated by `shouldSendClientEmail` with category `documentRequested`, which
  applies the firm master switch (`emailPreferences.ts:79,293-299`).
- `DOCUMENT_UPLOADED_BY_CLIENT`: one bell per upload call to matter members, category
  `documentUploaded`. Returns early when `matterId` is null (`:157`).
- `CLIENT_DELETED`: deletes the client's requests, a backstop to the FK cascade (`:38-44`).
- No reminder, overdue, or due-date job exists; no cron or job module references
  `document_requests`.

Identity relinking repoints `client_id` to the real client (`clientIdentityLinking.service.ts:376`).

**Share links.**

- *Create:* firm membership plus `assertFileReadAccess`, the same matter wall as downloads
  (`shareLinks.service.ts:47-48`, `files.scope.ts:111-126`). Folders are refused (`:34-38`). Expiry
  defaults to 168 h, bounded 1 h to 1 year; password up to 200 chars, scrypt with a 16-byte salt
  (`:19-23,51-65`, `shareLinks.validation.ts:3-11`). Token is `crypto.randomBytes(24)` hex (`:64`).
  `display_name` is a snapshot of the file name at creation (`:59-62`).
- *Public meta* returns only display name, permission, `requiresPassword`, expiry and content type,
  never the path or hash (`:112-121`). Missing or revoked is 404; expired is 410
  `SHARE_LINK_EXPIRED` (`:102-109`).
- *Download* verifies the password in constant time (401 `SHARE_LINK_PASSWORD`), confirms the file
  row is still live (`findById` excludes `deleted_at`, `files.repository.ts:254-261`), else 410
  `SHARE_LINK_FILE_GONE`, then mints a 15-minute v4 signed URL with inline (`view`, via
  `dispositionFor`) or attachment disposition and bumps `access_count` (`:133-161`).
- *Firm-agnostic lookup:* `getByToken` uses `tokenQuery`, which refuses to run a query that does not
  bind the token (`shareLinks.repository.ts:81-99`, `queryContext.ts:283-295`).
- *Revocation:* explicit `DELETE` sets `revoked_at`, scoped to the firm (`repository.ts:55-58`). Soft
  delete of a file or folder revokes every link in the subtree (`files.mutate.routes.ts:167,322`). A
  destroyed file nulls `file_id` through the FK, which the download path reports as gone.

### Dependencies

- Modules: `files` (rows, scope roots, `assertFileReadAccess`, see [Files](/features/files)),
  `shared/storage/directUpload.ts` + `shared/utils/storageUsage.ts` (sessions, quota),
  `shared/utils/membership`, notifications + `emailService.sendEmail`, and the portal resolver
  `clientAssociation.resolver.ts` (see [Clients](/features/clients)).
- Env: `FRONTEND_URL`, `GCS_BUCKET`, `UPLOAD_RATE_LIMIT_MAX` (default 120 per uid per minute,
  `rateLimiters.ts:131-137`), `PUBLIC_SHARE_RATE_LIMIT_MAX`.

### Example

Firm creates a General request for a person client:

```http
POST /api/lawfirms/7f1c.../document-requests
{ "clientId": "2b9e...", "title": "Tax documents", "dueDate": "2026-10-01",
  "items": [{ "label": "2025 W-2" }, { "label": "Bank statements", "description": "Last 3 months" }] }

201 { "message": "Document request created successfully",
      "request": { "id": "c4d0...", "matterId": null, "status": "open", "dueDate": "2026-10-01",
                   "items": [{ "id": "a1...", "label": "2025 W-2", "status": "pending", "sortOrder": 0,
                               "fulfillments": [] }, ...] } }
```

The client calls `upload-init` for item `a1...` with `{ "files": [{ "fileName": "w2.pdf",
"contentType": "application/pdf", "size": 48213 }] }`, PUTs to `uploadUrl`, then `upload-finalize`.
Item `a1...` becomes `received`; the request stays `open` until the second item is received or
waived. With `matterId` null, no firm member is belled.

### Tests

All in `backend/tests/documentRequests/` unless noted:

| File | Covers |
|---|---|
| `documentRequests.test.ts` | create validation, General requests, company targeting, CRUD, `documents.request` permission, cross-firm isolation, email default and firm master switch |
| `documentRequestLifecycles.test.ts` | rollup to `completed`, waive and manual receive, portal list and delete, matter roster and staffing checks |
| `portalDocumentRequests.test.ts` | client sees only its own requests, cancelled hidden, day-only due date, cross-firm and non-client refusal |
| `documentRequestFulfillmentConvergence.test.ts` | firm and client paths reach the same rollup; cancelled divergence; who may delete |
| `documentRequestFulfillmentGaps.test.ts` | cancelled refusal, completed still accepts, item from another request, other client, cross-matter link, missing object gives 404 |
| `documentRequestFulfillmentRetry.test.ts` | a retried upload records two fulfillments and two charges; notification dedupe within 60 s |
| `documentRequestTemplates*.test.ts` | preset CRUD, archive, tenancy, permissions, snapshot independence |
| `backend/tests/files/publicShareLinks.test.ts` | public meta disclosure, expiry vs revoked vs missing, passwords, firm-side list and revoke, create validation |

---

### Upload retry identity

The portal supplies an action key per selected upload group. `document_request_uploads` stores one session/file reference per position, scoped to the firm, checklist item and uploader. A repeated init recovers the same sessions; reusing a key with a different selection returns 409. Finalize links each file once under the existing request lock. Distinct uploads remain separate documents, and their notification identity includes the item and file IDs. Checklist targets are validated before upload files are claimed or finalized.

## What Can Be Improved

- **General-request uploads notify nobody at the firm.** The `DOCUMENT_UPLOADED_BY_CLIENT` listener
  returns when `matterId` is null (`documentRequests.events.ts:157`), so a client completing a
  General request is invisible until someone opens the tab. Bell the request's `created_by`
  instead, or as well.
- **A request to a client without a portal account is silent.** A person client with no `user_id`
  gets neither bell nor email (`documentRequests.events.ts:140`), even when the client has an email,
  and create still returns 201. At least surface it in the response.
- **No reminders despite a due date.** `due_date` is stored and shown but no job reads it. A
  housekeeping pass for overdue open requests would reuse `EMAIL_CATEGORIES.DOCUMENT_REQUESTED`.
- **Duplicate uploads are double-charged and the notification is deduped by accident.** Retries
  create new rows and charges; the firm bell collapses only because the rendered payload is
  identical within 60 s (`documentRequestFulfillmentRetry.test.ts:142-218`,
  `notifications.repository.ts:103`). An idempotency key on init would fix both.
- **Status edge cases.** A manual `status` in `PATCH` skips recompute, so `completed` can be set with
  pending items, and a later item change silently overwrites it (`service.ts:110,116-117`).
  `unlinkFile` leaves the item `received` and the request `completed` with no evidence
  (`service.ts:187-199`). Link-file ignores `cancelled` (`service.ts:155-184`).
- **Share tokens are stored in plaintext.** `token` is the primary key (`85_files.sql:455`), so a
  database read leaks live bearer credentials. Store a SHA-256 of the token and look up by hash.
- **Share-link UI covers a fraction of the backend range.** The modal stops at 30 days while the API
  allows a year (`ShareLinkModal.tsx:25-30`, `shareLinks.service.ts:17`). Either is fine; they
  should agree.
- **Stale comments and links.** `files.storage.ts:250-263` says a link stores an object path;
  `85_files.sql:445-453` names a `file_share_links_sync_revoked` trigger and columns that do not
  exist; `featureGateRouteMatrix.test.ts:235` says `createShareLink` probes storage, which it does not;
  `clients.md` links to `files#document-requests-the-checklist`, a heading that is gone (point it here).
- **No plan feature gate on document requests.** `file-share-links` sits behind
  `requireFeature('fileSharing')` but `document-requests` has none at mount (`app.ts:879-880`).
  Confirm this is intended.
