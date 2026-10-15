# Files (Document Storage)

## Summary

Firm members upload, organize, preview, download, rename, move, delete and search documents. Every
document belongs to one **matter**, **task**, **client**, or the firm's **General Files**. The same
module backs note and task attachments, the client portal's document feed, and per-firm storage
usage.

## The one thing to understand

**The folder tree is a database table. The storage bucket holds bytes and nothing else.**

Each row in `files` is a file or a folder. A folder is a row with `kind = 'folder'`. A file is a row
plus one object, and the row picks that object's name:

```
lawfirmids/{lawFirmId}/objects/{the row's own id}
```

That path is opaque. It says nothing about which matter the document belongs to, which folder it is
in, or what it is called. Nothing parses it, and nothing builds one.

This is the whole design, and it is worth stating what it replaced, because the old shape reads as
the natural one. The tree used to live in the path: `lawfirmids/{firm}/{matter}/Contracts/nda.pdf`,
with a folder represented by an empty `Contracts/.folder` marker object carrying the folder's colour
and share state in its metadata. Object storage has no folders, so a folder had to be faked, and
every consequence below followed from that:

- **A rename was a data migration.** Storage cannot rename. Renaming a folder listed every object
  under its prefix, copied each to the new prefix, verified the copy, deleted the source, re-pointed
  the mirrored row, and repeated per page. It could stop partway and leave a folder split across two
  locations. It refused any folder past a scan ceiling outright. It patched two of the nine tables
  that stored the old path.
- **Two uploads of one name raced.** No bytes exist at init time, so an existence probe saw a free
  path for both callers, handed them the same one, and the second PUT replaced the first. Both were
  reported as uploaded and the firm was charged twice.
- **Every address was ambiguous.** A row was addressed by the folder on screen plus its name, so a
  search hit (which lives elsewhere) needed different handling from a browsed row, and every caller
  re-derived the rule.
- **A listing walked the bucket.** It gave up at 25,000 objects and reported `truncated`, which is
  indistinguishable from "the document was never uploaded".

The row model removes all four by construction. A rename is one `UPDATE` of one column. Two callers
racing for a name meet a unique index, and the loser gets `Retainer (1).pdf`. Every operation takes
an id. A listing is one indexed query.

### What still lives in a path

Storage the system owns, outside the browsable tree, addressed by prefix because there is no row to
address instead:

| Prefix | Holds |
|---|---|
| `lawfirmids/{firm}/signatures/{sessionId}/` | The preserved copy of an executed document and its certificate |
| `lawfirmids/{firm}/invoices/{invoiceId}/` | An invoice exactly as it was sent |
| `lawfirmids/{firm}/signing-work/{sessionId}/` | The scratch copies an open signing session works in |
| `lawfirmids/{firm}/exports/` | Folder archives built by the export worker |
| `lawfirmids/{firm}/template-renders/` | What a template fill or preview produced |
| `lawfirmids/{firm}/invoice-outgoing/` | Invoice working copies |
| `lawfirmids/{firm}/messaging/{firm}_{clientUid}/`, `…/messaging/group_{conversationId}/` | A conversation's attachments |
| `lawfirmids/{firm}/templates/` | Document template sources, canvases and images |
| `signing-uploads/{firm}/{id}/` (bucket root) | A transient upload waiting to be sent for signature |

`isSystemObjectPath` (`shared/storage/recordArchive.ts:113`) is the test for the first six rows,
the archive and working segments (`ARCHIVE_SEGMENTS`, `WORKING_SEGMENTS`, `:49`, `:70`). Those
are not billed to the firm, and the archives are also delete-protected. The rest are NOT system
paths: conversation attachments are quota-charged (the upload-init route reserves, the
file-manager copy goes through `saveUploadsWithQuota`), and so are template objects. None of
the rows has a `files` row, so none appears in a listing or can be deleted through a files route.

## Schema

`files` (`db/schema/85_files.sql`):

| Column | Means |
|---|---|
| `id` | The document's identity, everywhere. Also names its object. |
| `kind` | `file` or `folder` |
| `parent_id` | The folder above. Null makes this row a scope ROOT. |
| `scope` + `matter_id` / `task_id` / `client_id` | Which matter, task or client owns this subtree |
| `object_path` | Where the bytes are. Null for a folder. |
| `finalized_at` | Null until the bytes land. Nothing lists an unfinalized row. |
| `deleted_at` | Soft delete. The retention window runs from here. |
| `signed_via_session` | Ties an executed document to the signing session that produced it |
| `client_visible` | Shared with the client portal, inherited down the subtree |

Five partial unique indexes carry the rules:

- `files_sibling_name_uidx` on `(law_firm_id, parent_id, lower(name))`. Two documents in one
  folder cannot share a name, case-insensitively. This is what makes a same-name upload race safe.
- `files_matter_root_uidx`, `files_task_root_uidx`, `files_client_root_uidx`, `files_firm_root_uidx`
  give one root per scope. A row with no parent IS a root, so a second one is refused.
- `files_signed_via_session_uidx` allows one filed document per signing session, which is what makes a
  retried finalize file into the same row rather than a second copy beside it.

A scope root is created on first use by `ensureScopeRoot`, which inserts and ignores the conflict
rather than checking first: several uploads can race to be the first document in a matter.

A **matter-linked task** shares its matter's root. Its documents carry both `matter_id` and
`task_id`, and the two views filter on the task id in opposite directions: the matter's browser
excludes them, the task's keeps only them.

## File layout

| File | Holds |
|---|---|
| `files.routes.ts` | The adapter: firm-id injection, and the per-endpoint permission map. An unmapped path is refused. |
| `files.repository.ts` | The only code that knows the table. Every read and write of the tree. |
| `files.scope.ts` | `resolveFileScope()`: which scope a request addresses, who may address it, and that scope's root id. `resolveReadableMatterIds()` answers the matter arm of that for a whole set of ids at once |
| `files.storage.ts` | The bucket handle, the upload policy, signed-URL rules, and the destruction guards |
| `files.readers.ts` | `listScopeRoot` / `listScopeRootsForMatters` / `listFolder` / `searchScope` |
| `files.upload.routes.ts` | Resumable uploads, note and task attachments |
| `files.browse.routes.ts` | `/list`, `/list-matters`, `/list-folder`, `/search`, `/view`, `/refresh-url`, `/location`, `/usage` |
| `files.validation.ts` | The Zod schemas and the id caps behind `/list-matters` and `/bulk-client-visibility` |
| `files.mutate.routes.ts` | `/client-visibility`, `/bulk-client-visibility`, `/delete`, `/create-folder`, `/rename`, `/move`, `/update-folder-color`, `/delete-task-attachment` |
| `files.download.routes.ts` | `/download-url` (one document), `/export-jobs`, `/export-job`, `/export-job-cancel` (folder archives) |
| `zipExportJobs.ts` | The archive worker: the lease, the transfer slot, paged enumeration, the TTL sweep |
| `exportJobs.repository.ts` | `file_export_jobs` and its sources; every write re-checks the lease token |
| `files.sweeper.ts` | Destroys what a delete left behind, once its retention window has cleared |
| `files.events.ts` | Cleans up after a matter, task, client or firm delete |
| `cascadeSweep.ts` | Removes a deleted parent's objects inside the delete request, `CASCADE_DELETE_CONCURRENCY` (8) at a time |
| `files.storage.routes.ts` | Mounts the upload, browse, mutate and download routers under `/files` |
| `files.context.ts` | `BASE_FOLDER`, and resolving a filing destination to a browsable folder |
| `shareLinks.routes.ts` / `shareLinks.service.ts` / `shareLinks.repository.ts` | External share links (see below) |
| `shareNotifications.service.ts` | Buffers `FILE_SHARED` events into one debounced digest per client |

Frontend: one `FileBrowser` (`components/filesComp/FileBrowser.tsx`) serves both the firm-wide Files
page and the matter, task and client file tabs. Its state is in `hooks/fileHooks/`. Which documents
it shows is a `FileScope` (`lib/files/fileScope.ts`); where it is standing is a trail of
`FolderCrumb` (`lib/files/filePaths.ts`), which is a list of `{ id, name }`.

## Uploading

Three steps, in a fixed order. The order is the design:

1. **`POST /upload-init`** claims a ROW per file and returns its id, its object path, a resumable
   upload URL and a `reservationId`. The row is unfinalized, so nothing lists it. It has already
   claimed its name. The reservation is a `storage_reservations` row holding the file's declared
   size against the firm's quota while the upload is in flight (see Storage usage).
2. **The browser PUTs the bytes** straight to storage, in 32 MiB chunks that carry
   `Content-Range` (`frontend/src/lib/files/resumableUpload.ts`). They never pass through the
   backend. Every `308` from GCS names the bytes it persisted, and the next chunk starts there.
   After a dropped connection or a `5xx`, the client sleeps, asks GCS where it got to with a
   status query, and continues from the answer; a `400`/`403`/`404`/`410` means the session is
   dead and only a new init helps. The session descriptor is kept in `localStorage`
   (`lib/files/uploadSessionStore.ts`) from before the first byte until finalize or a cancel, so
   the same file picked again after a reload or a network failure resumes without a second init. The file half of that key hashes
   a file whole only up to 16 MiB; above that it hashes the first and last 8 MiB beside the name,
   size and modification time, so a 10 GB file does not sit at 0% for a minute and a half first. The store forgets a session
   at 20 hours, under the sweeper's 24.
3. **`POST /upload-finalize`** names each `{ fileId, reservationId }`, verifies the object landed,
   re-checks the plan's per-file cap against the ACTUAL bytes, sniffs the first 8 bytes for a
   disguised executable, and stamps `finalized_at`. It then charges the bytes that landed and
   deletes the reservations the body names. A file that failed its transfer still goes to
   finalize with the rest of its batch, which is what gives its reservation back.

The stamp is not best-effort. A row that cannot be stamped fails the upload, because reporting
success over a document no listing will ever show is worse than failing.

**A cancel releases at once.** `POST /upload-cancel` takes the same scope as init and finalize
plus `uploads: [{ fileId, reservationId }]` (at most 20 per call) and answers `{ cancelled: n }`.
It deletes the reservations, then the rows that are in that scope, still unfinalized and claimed
by the caller, then their partial objects. A finalized row is never touched. When the user cancels
before finalize, `files.service.ts` sends every session the batch opened (all init groups, in calls
of 20), does not wait for the answer or report a failure, and forgets the remembered descriptors:
their rows are gone, so picking the same files again opens fresh sessions rather than resuming.
The freed names mean the retry lands as `Retainer.pdf`, not `Retainer (1).pdf`.

An upload claimed at step 1 and abandoned without a cancel (a closed tab) leaves an unfinalized
row. It is invisible, its reservation lapses after two hours, and the sweeper collects the row.

**PDF/text previews and downloads are bounded.** `DocumentPreviewOverlay` always hands pdf.js
the signed url, whatever the size. It never fetches a PDF whole and never probes its size with a
HEAD. pdf.js then reads page ranges,
which needs BOTH `disableAutoFetch` and `disableStream`: with only the first it keeps streaming
the whole document in the background. The bucket's CORS allows the ranged reads (`Accept-Ranges`,
`Content-Range`, `Range` exposed; applied by `backend/scripts/set-gcs-cors.ts`).

`PdfPreview` draws at most `MAX_RENDERED_CANVASES` (5) page canvases at a time, centred on the
page in view through one shared `IntersectionObserver`. Pages outside that window keep a measured
placeholder, so the scrollbar, page numbers and scroll position are unchanged and every page stays
reachable; only the pixels are dropped. Without this a 1,000-page document built 1,000 canvases
and browser memory grew with page count however the bytes arrived. Each raster is also capped at
4096 x 4096 pixels (`MAX_CANVAS_PIXELS`, `components/ui/PdfCanvasPage.tsx`): on a high-density
display the device pixel ratio is lowered rather than letting one zoomed page allocate hundreds of
megabytes.

A text file above 5 MB is not previewed. HEIC and HEIF images use the browser's native decoder
on Safari and are converted to JPEG in the tab with `heic2any` elsewhere. The converted blob is
preview-only and is revoked when the viewer closes; the stored object remains the original image.
TIFF still goes to download because browsers do not decode it. `isHeicFormat` and
`isBrowserRenderableImage` (`lib/files/imageTypes.ts`) keep those paths explicit.

Word, Excel, PowerPoint, and supported OpenDocument files use the embedded Google Docs Viewer
with a signed read URL. The MIME and extension allowlists are exact, so an unrelated content type
containing `doc` cannot fall into the viewer and trigger a download named `gview`. The iframe
sandbox deliberately omits downloads.

A single-file download hands the signed url to the browser's own download manager. The page never
fetches the bytes, so nothing is held in tab memory; the previous path built a `Blob` first, which
meant a 3 GB download tried to hold 3 GB. `GET /download-url` mints that url, always as an
attachment and always PINNED to the object's generation, so a document replaced after the caller
was authorized cannot be served under it.

A folder archive is a JOB rather than a response (`zipExportJobs.ts`). `POST /export-jobs` resolves
the scope, filters the selection under the requester's own access and commits a `file_export_jobs`
row; a worker claims it with a lease, walks the subtree one page at a time, and streams STORED
(not deflated) entries straight into one temporary object under `lawfirmids/{firm}/exports/`. ZIP64
headers appear once the archive needs them. `GET /export-job` reports progress and, once the object
lands, mints a short-lived generation-pinned url for the requester alone; `POST /export-job-cancel`
clears the lease, which is what stops a worker already inside the archive from publishing.
`sweepExpiredExports` removes the object after its TTL and clears the row's pointer.

The browser drives all three (`files.service.ts`, `downloadExport`): it creates the job, polls at 1, 2 and 5 seconds and then every 10 (not
while the tab is hidden), and hands the finished url to the download manager. The wait is BOUNDED, and abandoning
it CANCELS the job rather than only stopping the polling.

That wait lives in `FileExportProvider`, mounted in the firm layout beside the running billing
timer and for the same reason: an archive of a real matter takes minutes, and the person will move
around the app while it builds. Held in the file browser instead, opening a matter unmounted the
wait and abandoned the archive. From the provider it survives every move inside the firm, reports
through one global pill, and is stopped only by that pill's Cancel or by leaving the firm. One
archive builds at a time, because browsers honour only the first of several downloads fired
together.

Every write the worker makes re-checks the lease token, and the attempt counter increments on the
CLAIM rather than on the failure. Without that, a worker that stalled past its expiry and its
replacement would both publish: two archives of one folder, two transfers billed, and nothing
erroring. The archive shares one per-instance transfer slot with signing
(`shared/utils/transferSlot.ts`), because both move whole documents through the same 512 MiB.

An archive is capped at 20 GiB (`EXPORT_MAX_BYTES`). The total is counted at enqueue with one
recursive query and refused with `EXPORT_TOO_LARGE`, because a job that cannot finish inside one
drain retries from its first entry until its attempts run out. Each attempt writes its own object
(`exports/{job}-{attempt}.zip`), and a discard is pinned to the generation that attempt wrote, so a
worker that lost its lease can never remove the archive its replacement published. The write is a
resumable upload in 16 MiB chunks, and the signing drain and the export drain share one deadline.

**A name is capped at 255 characters**, by a CHECK on the column and a clean 400 from the repository.
The object path no longer grows with the name, so the limit is about the name being usable: it is
rendered in a listing, sent as a download filename, and written as a zip entry.

## Reading

- **`GET /list`**: everything in a scope, flattened. What the file pickers read. Recursive.
- **`GET /list-matters`**: `/list` for SEVERAL matters at once. See below.
- **`GET /list-folder`**: one level, with recursive file and folder counts on each subfolder. The
  counts are one grouped query, so opening a folder costs the same whether it holds ten documents or
  ten thousand.
- **`GET /search`**: `name ILIKE` across the scope's subtree, at most 200 hits with `truncated` set
  when there were more. Each hit carries `trail`, the folders
  above it, so opening one moves the browser to where the document actually is.
- **`GET /location`**: the scope and trail for one document. "Reveal this file" is what needs it.
- **`GET /refresh-url`**: a fresh signed URL for one `fileId`.

Listings carry an empty `signedUrl` on purpose: a URL minted at list time is already partway through
its TTL by the time a row is clicked.

### Several matters in one request

`GET /list-matters?matterIds=a,b,c` answers for a whole list of matters, as
`{ filesByMatterId: { [matterId]: { files, truncated } } }`. The entries are the ones `/list`
returns, built by the same `entry()` in `files.readers.ts`, so the two cannot drift.

It exists because a page holding a LIST of matters has to fan `/list` out one request per matter.
The client detail page's Files tab did exactly that (`ClientDetail.tsx`, `loadClientFiles`), with no
bound: a corporate client with eighty matters opened eighty simultaneous requests, each taking one
of the instance's twelve pool connections against a session pooler that allows fifteen. One user
could hold the whole pool while everybody else queued behind them.

The cost is constant in the number of ids: `isFirmOwnerOrAdmin`, one query resolving which matters
the caller may read, one recursive pass over every requested tree, and one grouped query for the
folder counts. The pass is seeded with all the matters' roots at once and carries the matter id down
the recursion, the shape `subtreeCounts` already uses, with `row_number()` giving each matter its
own page of the result.

Three rules worth stating, because they are what the tests pin
(`backend/tests/files/matterFilesBatch.test.ts`):

- **A matter the caller cannot read is ABSENT from the map**, not refused and not empty. A batch
  names matters the caller merely holds a list of, so one walled-off matter must not fail the other
  seventy. A matter they can read that holds no documents IS present, with an empty `files`.
- **The access rule is the one `/list` applies** (`resolveReadableMatterIds`, `files.scope.ts`):
  owners and firm admins reach any matter in the firm, everyone else must be staffed on it. Both
  halves are the primitives `assertMatterFirmWideAccess` composes itself from, so the ethical wall
  has one definition.
- **`matterIds` is capped at `MAX_BATCH_MATTER_IDS` (100, `files.validation.ts`)** and an over-long
  list is a 400 from the validation middleware, before any read. The cap is sized from the caller:
  five hundred ids is about 18.5 KB of request line, past the 16 KB Node allows for the request line
  and headers together, and the id count also multiplies the worst-case response, since each matter
  answers with up to `FILES_SUBTREE_PAGE_SIZE` entries. A hundred is about 4.8 KB including the
  bearer token, and matches the matter-clients batch cap so a page firing both chunks them the same
  way. There is no caller-supplied page size, unlike `/list`: a second multiplier on top of the id
  count is how one request asks for every document the firm owns.

The batch does NOT create a scope root. `resolveFileScope` does, on the read path, because a matter
addressed on its own is about to be browsed; a matter merely named in a list is not, and
`ensureScopeRoot` per id would put the per-matter round trips straight back.

## Access

`assertFileReadAccess(lawFirmId, fileId, userId)` is the read gate, and it is a row lookup: a matter
document requires matter read access, a standalone-task document requires task visibility, and
everything else falls back to firm membership. `assertObjectPathReadAccess` is the same decision for
a caller-supplied object path, and reaches the row through `findByObjectPath`.

A **deleted** row still gates. An access rule that stops applying the moment a document is deleted is
not an access rule, and the bytes outlive the row by the length of the retention window.

Write routes resolve the scope first (`resolveFileScope`, which asserts membership) and then require
the named row to be inside it (`requireInScope`). A row from another matter resolves to a
`NotFoundError`, not a 403: probing should not distinguish "not yours" from "not there".

## Deleting

A delete is **soft**: `deleted_at` is stamped on the row and everything under it, in one statement.
The row keeps its id and its object. That is what makes a delete recoverable, keeps a legal hold
holding something, and lets a public share link answer "no longer available" rather than 404-ing on a
token nobody recognises. The firm stops being charged at the delete, not at the destruction.

`files.sweeper.ts` is the other half, run from `POST /api/cron/housekeeping`. It destroys:

- a deleted document once `FILES_RETENTION_DAYS` (default 30) have passed, and
- an unfinalized row once `FILES_UNFINALIZED_HOURS` (default 24) have passed.

A row under a live legal hold is never collected, whatever its age, whether the hold names the
document or its matter. The object is deleted before the row: the other order leaves an object
nothing names.

Deleting a **parent** (a matter, task, client or firm) cascades the rows away through the foreign
key. The rows are gone once the delete commits, so the delete service snapshots the subtree first
(`filesRepository.scopeSnapshot`). After the rows are gone it removes the objects and decrements the
firm's running storage figure itself, eight objects at a time (`files/cascadeSweep.ts`). That runs
INSIDE the delete request: Cloud Run gives a process no CPU once the response is sent, and the event
listener that used to do this did not finish. A document's bytes are credited only when its object
was actually removed. A crash partway through still strands the remaining objects; the durable fix
is a queue table, recorded in `docs/future/tech-debt.md`.

## Sharing with the client portal

### Recoverable share delivery

Share events carry a stable share timestamp. The durable `file_client_access` buffer keeps delivery pending until the bell and any permitted email succeed. Per-client leases serialize timers and cron; acknowledgement matches the precise share version so a re-share during delivery remains pending. Stable event identities deduplicate bells across delayed retries, and digest emails carry provider idempotency keys. Shutdown and test teardown drain scheduled and running deliveries before closing database pools.

`PATCH /client-visibility` sets `client_visible` on one row. Visibility is **inherited down the
subtree**: a document is visible to a client when it, or any folder above it, is shared. Marking a
folder shares everything under it, and moving that folder carries the share with it, because the
share is on the row rather than on a marker object matched by prefix.

`file_client_visibility` narrows a share to named clients on a multi-client matter. Absent rows mean
every client on the scope, including ones added later.

`file_client_access` records what each client was told about: one row per file per client, carrying
shared, notified and first-seen. It keys on `file_id`, so a rename does not orphan a pending
notification.

### Sharing a whole selection

`PATCH /bulk-client-visibility` takes `fileIds` and applies the same change to all of them, under
one scope and one authorization, in a constant number of queries: one read of the rows, one read of
their current audiences, then one transaction holding a flag update, a delete of the old narrowing
and one insert of the new one. The single-file route above is unchanged and still serves the places
that genuinely address one document.

It is a separate path rather than an optional `fileIds` beside `fileId` because the answer is a
different document: a bulk mutation here reports per item and a single-item one reports the item, so
folding both into one handler would make the response shape depend on which key the caller sent.

**It is not atomic, deliberately.** A file the caller cannot reach is named in `errors` and the rest
of the selection is shared:

```
{ message, requested, updated, failed: [fileId], errors: { [fileId]: 'File not found' }, clientVisible }
```

A selection names ids the caller merely holds a list of, from a listing or a search that may be a
moment stale, so one bad id must not refuse the other hundred and ninety-nine; the caller rolls back
exactly what failed and can offer it for retry. `/list-matters` argues the same thing for a read,
with one difference: an unreachable id there is silently ABSENT, and here it is REPORTED, because
this is a write the user asked for and silence would read as success. Every failure says "File not
found" whatever the reason, so probing cannot tell "not yours" from "not there".

`fileIds` is capped at `MAX_BULK_VISIBILITY_FILE_IDS` (1,000, `files.validation.ts`), enforced by
`validate` before the handler and therefore before any write. Over it the route answers 400 and
writes nothing; it is never silently truncated, because a dropped id reads downstream as "this file
was shared" when it was not. The number is the largest selection a read in this module can hand a
caller in one response: `/list` and `/list-matters` clamp their page at `SUBTREE_MAX_PAGE_SIZE`
(1,000) and `/search` stops at 200. `files.service.ts` mirrors the cap and chunks a longer selection
sequentially rather than letting a caller meet the 400.

One `FILE_SHARED` event carries the whole batch as a `files` array, each entry with its own
pre-write share state. `shareNotifications.onFileShared` normalizes the single-file and batched
payloads to one list, so the scope lookup happens once per event; the digest it feeds already
coalesces a burst of shares into one per-client notification.

On the frontend, `ClientShareFilePicker` groups its selection by scope and sends one request per
group (one in the ordinary case), because the scope is what the server authorizes a batch against.
`useClientShare` sends one request and rolls back only the ids the server named; a thrown error
means nothing was applied, so it reverts the whole optimistic selection.

## Storage usage

`GET /usage` is one indexed sum over the firm's live, finalized rows. There is no cache and nothing
to reconcile, so there is no `refresh` parameter and no staleness to report.

`law_firms.storage_used_bytes` is a separate running column, maintained by deltas, and it exists for
one reader: the upload quota gate. It counts **saved files only**: finalize adds what landed, a
delete takes it away.

An upload in flight is not in that column. Each file an init admits holds a `storage_reservations`
row for its declared size (`reserveStorageUsage`, `shared/utils/storageUsage.ts`), written
atomically before any URL is minted. On a hard-limit firm the gate refuses the init (413) when saved
bytes plus the firm's live reservations plus the new files exceed the quota. A reservation ends in one of three ways: finalize deletes it,
a cancel deletes it, or it lapses after two hours (`STORAGE_RESERVATION_TTL_MS`), so an upload
nobody finishes stops blocking the firm the same afternoon. A slow upload that outlives its hold
still finalizes and is charged; the firm may end slightly over its quota and its next init is
refused.

`POST /admin/lawfirms/:id/storage/recount` repairs the column from the rows if a charge is lost (a
process that died between stamping a row and charging it), and purges lapsed reservations. It
leaves live ones to their uploads.

An unfinalized row and a deleted row both count as zero. Neither was ever charged.

## Public share links

This section covers the storage side. Token lifecycle, routes, and the client upload checklists
that also land files here are in [document-requests.md](document-requests.md).

`file_share_links` holds a token, a `file_id`, an expiry and an optional password hash. The link
follows a rename and a move, because it stores the id. `file_id` is `on delete set null`, so a
destroyed document leaves the row in place with nothing to serve.

A link can also name a folder or a selection of up to 100 files and folders (migration 0014). That
link has a null `file_id`, and `file_share_link_items` lists what it names. A shared folder is live:
the recipient reaches whatever is inside it when they open the link, not what was there when it was
made. Reach is checked on every request by walking up from the requested row to a selected folder,
and a row owned by a different task than that folder is out of reach, because the matter's browser
hides a task's own documents. One document still gets the single-file shape.

Creation asserts firm membership AND `assertFileReadAccess`, the same ethical wall the download path
applies. A member walled off from a confidential matter cannot mint a link to its documents. For a
selection the check runs once per distinct matter, task or firm scope, and one refused item refuses
the whole link.

Listing (`GET /?fileId=` for one item, `?fileIds=a,b` for a selection) returns every live link naming
any of them, each once. Every link carries `items`, the files and folders it reaches that the caller
may read, and `hiddenItemCount`, the ones behind a matter or task they cannot. A link can mix
matters, so a walled-off member learns only that something else is on it, never its name. The share
dialog uses this to say what else a link shares, and asks before revoking a link that reaches past
what the dialog was opened for.

Two routers serve them. The firm side is `shareLinks.routes.ts`, mounted at
`/api/lawfirms/:lawFirmId/file-share-links` behind `verifyToken` and `requireFeature('fileSharing')`
(`app.ts:879`): `GET /`, `POST /`, `DELETE /:token`. The public side is `modules/share/share.routes.ts`
at `/api/share` (`app.ts:910`), with no login and `publicShareLimiter` by IP: `GET /:token` answers
landing metadata without the object path, `POST /:token/items` checks the password and lists a
multi-item link's items or one shared folder's contents, and `POST /:token/download` checks the
password and returns a short-lived URL (for a multi-item link, for the `fileId` it names). All three
call `shareLinks.service.ts`.

## The guard

`npm run db:files-tree` (`db/check-files-tree.ts`) fails the build on the shapes that would put the
tree back into the path: a `.folder` marker, an object path built from ids, or an object path parsed
for its segments. It runs in CI and in the Cloud Build deploy gate. The pull back toward the old
shape is real, because a path reads as a natural address for a file.

## What Can Be Improved

- **HEIC conversion has no preview-specific size cap.** Outside Safari,
  `DocumentPreviewOverlay` fetches the whole HEIC/HEIF object into a `Blob`, then `heic2any`
  allocates a decoded image and a JPEG beside it. Closing the viewer stops state updates but does
  not abort the fetch. A large camera image can therefore freeze or exhaust the tab even though
  PDF and text previews are bounded. Check `sizeBytes` before fetching, define a measured HEIC
  preview ceiling, and abort the request on close.
- **A crash inside a parent delete strands objects.** `cascadeSweep.ts` removes a deleted matter's,
  task's or client's objects inside the request after the rows are gone (`cascadeSweep.ts:15-16`), so
  a process that dies partway leaves the rest in the bucket with no row naming them and nothing
  retrying. The durable fix is a queue table (`docs/future/tech-debt.md`).
- **Conversation attachment folders outlive their use.** They have no `files` row, so neither the
  sweeper nor a listing sees them. The only reclaim paths are a person client's direct-thread folder on
  client delete (`files.events.ts:61`) and an archived company thread's `group_{id}/` folder
  (`messaging.repository.ts:1223`). An ad-hoc group's folder, and a device upload that was finalized
  but never sent in a message, stay charged to the firm indefinitely.
- **Name search is an unanchored `ILIKE`.** `searchScope` matches `name ILIKE '%term%'` across the
  subtree, capped at `SEARCH_LIMIT` (200, `files.readers.ts:22`), and `files` has no trigram index on
  `name` (`db/schema/85_files.sql:177-202`). Bounded by scope today; if a large firm's search shows up in
  profiling, measure a `pg_trgm` index with `explain` before adding it.
