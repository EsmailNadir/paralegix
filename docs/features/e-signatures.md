# E-Signatures

## Summary

The E-Signatures feature lets a law firm send a PDF (or auto-converted document) out for electronic signature, collect one or more signers' marks/initials/text/date/checkbox values, and produce a tamper-evident, digitally-sealed signed PDF that is auto-filed into the firm's GCS storage. Signers access the document through a **public, token-based link** with no firm login required; their identity is established by possession of an unguessable token plus an optional sender-set access-code gate. (The email one-time-code gate was removed in ba189940; its columns and `signature_challenges` kind remain in the schema, but no route sends or checks a code.) Every meaningful action (view, consent, sign, decline, access code, completion, cancellation, expiry) is written to an **append-only, DB-enforced** audit trail that backs a downloadable Certificate of Completion. Multi-signer flows support both **sequential** and **parallel** routing.

The module spans the public signing router plus a firm-side links router, a relational repository, helper modules, and one public signing page on the frontend. A session row has a uuid primary key and a unique 24-byte hex `token` that the API uses as its `sessionId`; each participant additionally has its own 24-byte `publicToken` that is what actually ends up in the shared link.

## Key Takeaways

- **A session has a uuid PK and a text token the API calls `sessionId`.** `signature_sessions.id` is the uuid primary key that every child table's `session_id` references; `signature_sessions.token` is a unique 24-byte hex string (`createId(24)`, `signingSessions.ts:8`/`:195`) used by the routes and the repository as `sessionId`/`token` (`db/schema/87_signatures.sql:97-99`). Each participant gets a *separate* 24-byte `publicToken` stored in `signature_participant_tokens` (`signingSessions.ts:219`), and that participant token is what goes in the signing link.
- **The stored signed PDF is tamper-evident.** Finalization (`signingPipeline.ts`) appends the Signature Certificate page and an inline PKCS#7 seal to the filed copy, and a seal alone to the delivered copy, before either is published. The hash stored for `/verify` is computed AFTER sealing so it matches the persisted bytes.
- **Signing links are single-use, and a spent link still renders a friendly "already signed" screen.** When a signer's turn ends, their `publicToken` row is **stamped `consumed_at = now()`** (not deleted) via `invalidateParticipantToken` inside the same completion transaction (`signing.routes.ts:1744`, `:1871`; `signatures.repository.ts:963`). Active-token resolution filters `consumed_at is null` so the spent link can no longer authorize signing, but the retained row lets `getConsumedTokenCompletion` recognize a reloaded completed link and return `alreadySigned:true` (`signing.routes.ts:1076-1080`, `signatures.repository.ts:982`). The NEXT signer's token (a different `participant_id`) is untouched, so the sequential flow continues uninterrupted.
- **Completion is transactional on BOTH routing modes.** Parallel and sequential `/complete` both run through `repo.runSessionTransaction()` (`signatures.repository.ts:1896`; called at `signing.routes.ts:1676`, `:1787`), which locks the session row + its participants `FOR UPDATE`, re-validates status/turn under the lock, then advances. `/decline` uses the same transaction (`:2190`); `/cancel` uses the set-based `cancelSession` (`:2464`).
- **Auth for public signers = token + optional gate.** No Firebase login is required. The token resolves a participant (`resolveSigningContext`, `signingSessions.ts:303`); access is then gated by an optional sender-set access code (SHA-256 hashed), with a 5-attempt / 60-second soft lock and a cumulative cap of 20 failures that locks the gate until the firm reissues the link (`GATE_SOFT_ATTEMPT_LIMIT`, `GATE_HARD_ATTEMPT_CAP`, `signing.routes.ts:259-263`). **Secret compares are constant-time** via `hashesEqual()` → `crypto.timingSafeEqual` (`signing.routes.ts:193`).
- **There is one session shape.** Every session has a `participants[]` array. The legacy v1 single-signer shape, `schemaVersion` and `isV2Session()` were removed in 1e130b14; a few comments still say "v2".
- **Integrity is hash-based, and a completed session has TWO sealed PDFs.** The copy filed in the firm's documents carries the appended Signature Certificate page (`signed_document_hash`); the copy emailed to signers and posted into the client portal does not (`delivery_document_hash`). Sealing makes their bytes differ, so `/verify` re-hashes an uploaded file and matches **either**, returning `matchedCopy: 'filed' | 'delivered'`. Matching only the filed copy meant telling every signer who checked the PDF they were actually sent that it was unrecognised.
- **Audit immutability is DB-enforced.** A `before update` trigger blocks any UPDATE of `signature_audit_events` (`signature_audit_immutable`, `db/schema/87_signatures.sql:496-501`). DELETE is intentionally allowed so the session `on delete cascade` and cleanup job can purge audit rows. The app also never issues an UPDATE.
- **The signing certificate is env-driven, and production refuses to seal without it.** `digitalSign.ts:19-22` reads `SIGNING_P12_PATH` / `P12_PASSPHRASE` from the environment, falling back to the in-repo dev cert at `backend/paralegix-signing.p12` with an empty passphrase. With `NODE_ENV=production` that fallback throws instead (`assertProductionCertConfig`, `:30`), so every finalize job fails until both are provisioned. Staging mounts its cert from Secret Manager (see /STAGING_SETUP).

---

## How It Works

### Entry Points

**Backend route registration** (`backend/src/app.ts`):

| Mount | Router | Auth |
|---|---|---|
| `/api/signatures` | `signatures.routes.ts` | `verifyToken` + `documentConvertLimiter`: `POST /convert/upload-init` (`:62`) and `POST /convert/run` (`:86`), generic storage-to-storage document conversion |
| `/api/lawfirms/:lawFirmId/signature-links` | `signatureLinks.routes.ts` | `verifyToken` + `requireFeature('documentSigning')` + `requirePermission` (`app.ts:906`) |
| `/api/lawfirms/:lawFirmId/signing-templates` | `signingTemplates.routes.ts` | `verifyToken` + `requireFeature('documentSigning')` + permission (`app.ts:907`) |
| `/api/signing` | `signing.routes.ts` | mostly **public** / `optionalVerifyToken` (`app.ts:908`) |

**Firm-side endpoints** (authenticated, `signatureLinks.routes.ts`):

| Method/Path | Permission | Purpose |
|---|---|---|
| `POST /prepare` (`:603`) | `signatures.send` | Turn a firm document into a signing-ready PDF server side (freeze or convert) and return the prepared path |
| `POST /generate` (`:622`) | `signatures.send` | Create session, return a copyable link |
| `POST /send-email` (`:658`) | `signatures.send` | Create session + email a single signer |
| `POST /send` (`:718`) | `signatures.send` | Create multi-signer session + notify |
| `GET /recipients` (`:813`) | `signatures.send` | The signer picker's client list, annotated with company links |
| `GET /pending-for-user` (`:828`) | `signatures.view` | "Needs my signature" + "created by me" |
| `POST /:sessionToken/resend-participant/:participantId` (`:892`) | `signatures.send` | Resend invite/reminder |
| `GET /sessions/summary` (`:1002`) | `signatures.view` | Per-status counts over the firm's whole history |
| `GET /sessions` (`:1025`) | `signatures.view` | Firm session list, windowed |
| `GET /workspace` | `signatures.view` | The Signatures page's opening read, `{ sessions, summary, pendingForUser, templates }`, each the body of `GET /sessions` (same query), `GET /sessions/summary`, `GET /pending-for-user` and `GET /signing-templates`. All five routes share `signatureWorkspaceReads.ts` |

**Public / optional-auth endpoints** (`signing.routes.ts`):

| Method/Path | Purpose |
|---|---|
| `POST /upload-init` (`:742`), `POST /upload-finalize` (`:809`) (`verifyToken`) | Open a resumable GCS session for a PDF, then vouch for what landed |
| `POST /convert-upload-init` (`:625`), `POST /convert-upload-finalize` (`:658`) (`verifyToken`) | The same pair for a non-PDF source, converted storage to storage |
| `GET /source/:sourceId` (`:933`, `verifyToken`) | Poll whether an admitted source is `ready`, for a preparation too large to finish inline |
| `GET /preview-url` (`:960`, `verifyToken`) | Mint a short-lived, generation-pinned read URL for field placement |
| `GET /pending-for-client` (`:1017`, `verifyToken` + client) | Docs awaiting this client |
| `GET /:token/status` | Lightweight status poll (1 query, no audit). A spent link answers nothing, EXCEPT to the signer whose own turn completed: their turn consumed the token that carries the poll, and they still have to watch the executed document being produced. A token spent by a decline or a cancellation answers nothing at all. |
| `GET /:token` (`:1067`) | Session metadata + this participant's fields |
| `GET /:token/file` (`:1158`) | Authorize a signer and mint a short-lived, generation-pinned working-document URL |
| `POST /:token/complete-upload-init` (`:1369`) | A fieldless session opens an upload for its executed document |
| `POST /:token/complete` (`:1412`) | Submit consent plus field values, as JSON. Nothing else is accepted |
| `POST /:token/decline` (`:2153`) | Signer declines; session is cancelled |
| `POST /:token/verify-access-code` (`:2301`) | Verify sender-set access code |
| `POST /verify` (`:2401`) | Check a SHA-256 the caller computed, against both sealed copies (no token) |
| `POST /:token/cancel` (`:2445`, `verifyToken`) | Creator-only cancellation |
| `GET /:token/audit` (`:2502`, `verifyToken`) | Full audit trail |
| `GET /:token/certificate` (`:2545`, `verifyToken`) | Certificate of Completion PDF |
| `GET /:token/verification` (`:2608`, `verifyToken`) | Re-verify a stored artifact's hash and seal for a firm member |
| `GET /:token/signed-document` (`:2726`, `verifyToken`) | Link to the filed (or delivered) executed copy |

The status, metadata and file reads carry `signingReadLimiter`; completion and decline `signingActionLimiter`; the access-code check `signingGateLimiter`; `/verify` `signingVerifyLimiter` (`signing.routes.ts:91-97`).

**Frontend entry point**: the single public route `frontend/src/app/signature/page.tsx` reads `?token=` from the URL (`page.tsx:76`) and orchestrates the access-code gate → waiting screen → signing view (`AccessCodeGate`, `page.tsx:62`). The waiting screen polls `GET /:token/status` with a backoff from 90 seconds up to 5 minutes (`page.tsx:369-402`). Declining is wired through `RestrictedSigningView.tsx` (`handleDecline`, `:376`). The API client is `frontend/src/services/signatures.service.ts` (`declineToSign`, `:601`).

### Data Flow: create → invite → token sign → field capture → audit → completion/PDF

This traces the canonical sequential multi-signer flow. File:line references are to `backend/src/modules/signatures/` unless noted.

1. **Firm requests a session.** A member with `signatures.send` calls `POST .../signature-links/send` (`signatureLinks.routes.ts:415`). Body is validated by `sendSigningRequestSchema` (`signatureLinks.validation.ts:59`): `objectPath`, `fileName`, ≥1 `fields`, ≥1 `signers`, optional `routingMode`.

2. **Source PDF is prepared.** `preparePdfForSigning()` (`signatureLinks.routes.ts`) validates the source path stays within `lawfirmids/<firm>/` or a `signing-uploads/` object the caller owns (`validateSigningSourcePath`). File Manager calls `/prepare` with `requireFlatteningConfirmation`; that route inspects the selected PDF first and returns `PDF_REQUIRES_FLATTENING` when it has interactive AcroForm fields. The frontend then shows its flattening confirmation modal and uploads the flattened result as a transient signing source. Already prepared transient uploads skip that confirmation, and callers outside the File Manager flow retain automatic server-side form preparation. Non-PDFs are converted to PDF via LibreOffice (`convertDocument`, `signatures.service.ts`; local or worker mode, caps and failures are in [document-conversion.md](document-conversion.md)) and re-stored under a fresh `signing-uploads/<uniqueId>/` path. Source admission streams the stored bytes to compute the SHA-256 `documentHash` without buffering the full document.

3. **Fields are validated against signers.** Before creating the session, `assertFieldSignerIdsMatchSigners()` (`signatureLinks.routes.ts:210`, called at `:265`) checks every `field.signerId` against a supplied signer's `participantId`. It collects **all** unmatched fields via `.filter(...)` and reports them together (`:224-232`) rather than one error per round-trip. A mis-keyed `signerId` would otherwise be silently dropped at read time (the public read filters fields by participant), so this fails fast with a 400.

4. **Session + participants + fields are created in one transaction.** `createSigningSession()` (`signingSessions.ts:177`) builds the session record (`buildSessionRecord`, `:118`) and participants (`buildParticipants` → `buildParticipant`, `:59`). It mints the session token (`createId(24)`, `:195`) and a distinct `publicToken` per participant (`:217`). In **sequential** mode the lowest-`order` participant starts `active`, the rest `waiting`; in **parallel** mode all start `active` (`buildParticipant:74`). `repo.createSession()` (`signatures.repository.ts:408`) writes `signature_sessions`, each `signature_participants` row, each `signature_participant_tokens` row, and a single multi-row INSERT into `signature_fields` (`insertFields`, `:345`) — all inside `begin/commit`.

5. **(Parallel only) per-signer working copies.** For parallel routing, `createParallelWorkingCopies()` (`signatureLinks.routes.ts:180`) saves a copy of the source PDF to `signing-working/<sessionId>/<participantId>.pdf` per participant and stamps `workingObjectPath` onto each participant via `repo.replaceParticipants` (`:295`).

6. **`SESSION_CREATED` audit + invitations.** `writeAuditEvent(..., SESSION_CREATED, ...)` appends to `signature_audit_events` (`signatureLinks.routes.ts:303`). The active participant(s) are notified via `sendParticipantInvitation()` (sequential: only the first; parallel: all actives, `:441-470`) and an `EMAIL_SENT` audit event is written per invite. The link is `${APP_URL}/signature?token=<publicToken>` (`signingNotifications.ts:577`).

7. **Signer opens the link.** The frontend loads `GET /api/signing/:token` (`signing.routes.ts:436`). `resolveSigningContext(token)` (`signingSessions.ts:301`) first tries the token as a *session* token, then as a *participant* token (`repo.getSessionByParticipantToken`, `signatures.repository.ts:303` — a single JOIN query). For v2, `resolveAuthorizedParticipant()` (`signing.routes.ts:131`) maps the token (or a facilitator's UID for `in_person`) to a participant. Expiry is checked (`isSessionExpired`, `signingSessions.ts:25`; 410 if past `expiresAt`).

8. **Gate.** If the participant has an access code and hasn't verified it, the metadata response is reduced to gate flags. The code's hash, attempt counters and lock live on the participant's `signature_challenges` row (`kind = 'access_code'`), read through a join in the repository. `POST /:token/verify-access-code` (`signing.routes.ts:2301`, `signingGateLimiter`) refuses outright once the non-resettable `lifetimeAttempts` reaches `GATE_HARD_ATTEMPT_CAP` (20), then compares SHA-256 hashes with the constant-time `hashesEqual()` (`:193`, `:2362`). A failure is recorded atomically (`repo.recordGateFailure` with `GATE_POLICY`): 5 failures lock for 60 seconds, 20 lock for about a year, until the firm reissues the link. Attempts emit `ACCESS_CODE_VERIFIED` / `ACCESS_CODE_FAILED` audit events. There is no email one-time-code gate any more: `requires_verification` / `email_verified` and the `otp` challenge kind survive in the schema, but no route issues or checks a code (removed in ba189940).

9. **Turn check.** If `participant.status !== 'active'` the response carries empty `fields` and the frontend renders a "Waiting for Your Turn" screen that polls `GET /:token/status` (`signing.routes.ts:422`; `repo.getParticipantStatusByToken` is one query, `signatures.repository.ts:832`). If active, the response includes the participant's `fields` (filtered by `field.signerId === participant.participantId`, `signing.routes.ts:493`), `objectPath`, and `lawFirmId`.

10. **View audits.** `GET /:token` and `GET /:token/file` write `SESSION_VIEWED` / `DOCUMENT_VIEWED` non-blockingly, throttled to once/hour per actor. The throttle is **atomic** — `repo.stampViewIfStale()` (`signatures.repository.ts:756`) is a single conditional `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` that stamps only if the prior stamp is older than the window and returns whether it won; the audit event is written only when it did (`maybeWriteSessionViewed`/`maybeWriteDocumentViewed`, `signing.routes.ts:171-215`). The stale `data.last*ViewedAt` map is no longer consulted.

11. **Field capture (client side).** The signer fills fields in the signing view. Signature and initials are PNG data URLs; date, text and checkbox are scalar values. The client sends the raw `fieldValues` array and the server rebuilds the executed document from the stored original plus those values.

12. **Completion submission.** `submitSignedDocument()` POSTs JSON to `POST /:token/complete`, validated by `completeSigningJsonSchema` (`signing.validation.ts`): `consentAgreed`, `consentName`, `consentTimestamp`, the `sourceRevision` the signer's view carried, an `idempotencyKey`, and `fieldValues`. A non-JSON request is refused with 415. The body is capped at 1 MiB, half the API's global default, and the refusal happens while the body is still being read.

    A FIELDLESS session is the one case the server cannot rebuild: its marks were drawn freehand in the browser, so the executed document is the bytes the browser produced. It calls `POST /:token/complete-upload-init` first, which opens a resumable upload under `lawfirmids/<firmId>/signing-work/<token>/completion/`, and then names that object in `signedObjectPath`. The route checks the path against that session's own prefix and the `uploadedBy` stamp before it reads anything, because the path decides which bytes become an executed legal document.

13. **Server records the signer transactionally.** After re-resolving and re-checking gates/turn/status, the route enters `repo.runSessionTransaction()` for BOTH routing modes:
    - **Parallel**: locks the session + participants `FOR UPDATE`, re-validates, marks this participant `completed`, sets the session `'in_progress'` or `'completed'` if all are done, and consumes this participant's token (`:836`).
    - **Sequential**: same lock + re-validation, marks this participant `completed`, promotes the next `waiting` participant (lowest order) to `active`, sets the session `'in_progress'`/`'completed'`, and consumes this participant's token (`:942`). The next signer's token survives.

14. **Working copy persistence + final build.** Nothing here loads a whole document. An intermediate signer's turn refreshes the working copy the NEXT signer sees by composing an APPENDED revision over the admitted source (`stampStoredPdf`), and its hash is the source's saved SHA-256 state resumed over that suffix, so the turn never reads the document. The last signer's turn commits a durable `finalize` job in the same transaction as the consent, and `signingPipeline.ts` produces both artifacts the same way: stamps, certificate and two seals are all suffixes, and storage joins them server side. That is why a 500 MB document costs the same as a 100 MB one. The filed copy carries the appended Signature Certificate page and an inline PKCS#7 seal; the delivered copy carries the seal without the certificate. Each artifact is SHA-256 hashed AFTER sealing, giving `signedDocumentHash` and `deliveryDocumentHash`, and the session row records `finalObjectPath`, `signedObjectPath` and both hashes.

   Completion records that delivery is owed. A worker claims it with a lease and marks it delivered only after the sender email, signer copies, and any portal posts succeed. Provider refusals and failed posts leave it owed for a later drain after the lease expires, within the configured attempt limit. Delivery is at least once: a partial success or a crash before the marker is saved can repeat copies already sent.

    A FIELDLESS session takes the one other path. Its uploaded object is verified BEFORE anything is committed: the storage record is settled against the participant's own `uploadedBy` stamp and the PDF content type, and its page count is compared with the stored original through bounded reads. A refusal therefore leaves the turn takeable, with the token unspent, rather than ending it with nothing executed. Only then is anything committed: the upload's path is recorded on the session in the same transaction as the consent, and sealing is the same durable `finalize` job a field session gets. It runs inside the request below `SIGNING_INLINE_FINALIZE_BYTES` and in the drain above it. The job admits the uploaded copy before appending to it (the page cap, encryption, an existing signature field), because the browser built that copy and nothing downstream should depend on it being well formed.

15. **Completion audits + notifications.** `CONSENT_GIVEN` and `SESSION_COMPLETED` are written (`signing.routes.ts:1035-1059`). On finalize: the sender (`notifyEmail`) gets an email with the signed PDF attached (`sendDocumentSignedEmail`, `:1082-1091`), and if the session is tied to a `clientId`, the signed PDF is posted into the client's messaging thread (`:1093-1130`). On a non-final signer, a confirmation email is sent (`sendSignerConfirmationEmail`, `:1063`) and the next participant is invited (`notifyNextParticipant`, `:1075`).


17. **Verification & certificate.** Anyone can `POST /verify` to check a document. The BROWSER hashes it, in a worker, one slice at a time, and posts the 64 hex characters; the document itself never travels. The route refuses anything that is not a SHA-256 digest, then matches it with `findSessionBySignedHash` against both `signed_document_hash` and `delivery_document_hash` (uses the slim graph), and the response names which copy matched. `GET /:token/verification` re-verifies a stored artifact for a firm member. It reads the artifact ONCE, under the transfer slot, and takes the whole-file hash and the ByteRange hash from that one pass (`digestWholeAndSpans`); a caller who leaves stops the read. The filed copy (`signedObjectPath`) is checked against `signedDocumentHash` and the delivered copy (`finalObjectPath`) against `deliveryDocumentHash`, and `GET /:token/signed-document` hands the firm the filed copy by default. A firm member can pull the audit trail (`GET /:token/audit`) or a generated, digitally-signed **Certificate of Completion** PDF that renders the full audit timeline (`generateCompletionCertificate`). The certificate is archived on first write and then frozen, so it is not rendered until the completion audit events have settled. `archiveCertificateAfterCompletion` takes the pending-writes promise and waits on it, because a certificate built too early permanently records a timeline that stops before the signature and a signer IP of N/A.

### Producing the two executed artifacts

The steps above describe the path that was replaced. It ran five whole document
passes through pdf-lib: stamp, flatten, seal the delivery copy, append the
certificate, seal the stored copy. That peaked at 299 MB for a 20 MB document
and 858 MB for a 48 MB one, against a 512 MiB container, which is why
`SIGNING_MAX_FILE_BYTES` used to be 20 MB. That cap described the
implementation, not anything a law firm would recognise.

`SIGNING_MAX_FILE_BYTES` is now **500 MB**, and it is measured rather than
chosen. The whole lifecycle ran inside a 512 MiB container with swap disabled,
against real persisted bytes through a GCS-compatible endpoint
(`scripts/run-signing-benchmark.sh`):

| document | process baseline | peak | signing costs | bytes read |
|---|---|---|---|---|
| 100 MiB | 101 MiB | 129 MiB | 28 MiB | 53,481 in 7 ranges |
| 500 MiB | 102 MiB | 134 MiB | 32 MiB | 53,481 in 7 ranges |

The baseline is what the process costs before any signing happens. A five-fold
increase in document size did not move the third column, and the reads are
identical byte for byte. The cap is 500 MB because that is the largest fixture
the local harness can build, not because anything measured says the engine stops
there.

The incremental path (`signingPipeline.ts`) never holds the document. Every step
appends a suffix of kilobytes and storage joins that suffix to the immutable
object it belongs to, so executing a document costs its stamps, its certificate
and two signatures whatever the document weighs. The order is load-bearing:

1. **The stamped source is composed once**, and both artifacts are built on it.
   They differ only after the last shared byte, which is what lets one saved
   hash state serve both seals.
2. **Delivery is sealed first**, because the certificate states the delivered
   copy's hash. A page cannot state the hash of the file that contains it, so
   the certificate names a file real recipients actually hold.
3. **The certificate is appended to the unsealed stamped source**, never to the
   sealed delivery copy. Appending to a sealed document invalidates the seal it
   already carries, and the result opens showing a broken signature.
4. **Nothing is published unless both seals verify**, and nothing at all is
   published if a field could not be placed. An executed document missing a mark
   the signer agreed to is a signature on something else.

Sealing resumes the SHA-256 state that preparation saved over the prepared
source, so finalizing does not read the document again. A source with no usable
state is streamed once instead. That fallback is not a degraded mode: a source
prepared before the state existed always takes it, and it produces byte
identical output.

The stamped source both artifacts are composed from is a full-size copy that
nothing reads once they are published, so publication removes it, with any
scratch suffix a crash stranded (`removeArtifactIntermediates`). The
settled-workspace sweep is the backstop for a publication that died first.

Reading structure is bounded in CPU as well as memory. A decoded object stream
is cached on the index for the life of one operation, up to 16 MiB, so a
1,000-page tree packed into object streams decodes each container once rather
than once per page (about 3,300 reads fell to under 200 in the lifecycle test).
Flate streams inflate on the threadpool, so a 64 MiB stream does not stall
every other request on the instance. Only signature-image samples, bounded by
the pixel cap, still inflate synchronously.

Field values are bounded before anything measures them: a non-image value at
5,000 characters (`SIGNING_TEXT_VALUE_MAX_CHARS`), an image at 128 KiB and
4 million declared pixels. The signing profile and the appearance engine read
the same constants as the submit route, in `signing.validation.ts`.

Verification (`pdf/verifySeal.ts`) reports three separate things, and keeping
them apart is the point. IDENTITY is a hash lookup: these bytes are the artifact
we recorded. SEAL VALIDITY is a fact about the bytes in front of you, and is
still not a claim about public CA trust or about a timestamp. COVERAGE is
whether the signature covers the whole file: a `/ByteRange` that stops short is
mathematically valid over the bytes it covers, and a revision appended after
signing sits outside that range and can say anything.

### Data Model

Schema in `backend/db/schema/87_signatures.sql` (the old numbered migrations `0029`, `0037`, `0038`, `0042` are historical; the chain was collapsed into `schema.sql`). The relational repo reconstructs one session object graph from these tables (`loadSessionGraph`, `signatures.repository.ts:183`). Slim variants load only session + participants for list/verify paths: `loadSessionGraphSlim` for a single row (`:258`) and **`loadSessionGraphsSlimForRows` for a SET of rows** (`:291`) using one batched participants query + one batched tokens query (`= any($1)`).

| Table | PK | Key columns | Notes |
|---|---|---|---|
| `signature_sessions` | `id` (uuid) | `token` (text, unique), `law_firm_id`, `created_by`, `routing_mode`, `source_id`, `object_path`/`working_object_path`/`final_object_path`/`signed_object_path`, `file_name`, `destination_folder_id`, `destination_label`, `status`, `current_signer_order`, `document_hash`, `signed_document_hash`, `delivery_document_hash`, `notify_email`, `notify_name`, `email_signers_on_complete`, `started_at`/`completed_at`, `audited_at`/`audit_result`/`audit_detail`, `expires_at` | `token` is the 24-byte hex handle the API calls `sessionId`; children reference `id`. The destination is a folder ROW (FK, `set null` files into General Files) rather than a path. The two signed hashes are the filed copy (with certificate page) and the delivered copy (without); both are indexed and `/verify` matches either. `routing_mode` CHECK = `sequential`/`parallel` (`:102-103`). `status` CHECK = `pending`/`in_progress`/`completed`/`cancelled`/`expired` (`:122-123`). Indexed on `(law_firm_id, created_at desc)`, `signed_document_hash` and `delivery_document_hash` (`:173-175`). |
| `signature_participants` | `id` (text = participantId) | `session_id` (uuid FK), `law_firm_id`, `role_label`, `signing_order`, `delivery_method`, `name`, `email`, `member_user_id`, `client_user_id`, `status`, `requires_verification`/`email_verified` (left from the removed email gate), `consent` (jsonb), `signer_uid/name/ip`, `facilitated_by`, `field_values` (jsonb), `working_object_path` | `status` CHECK = `active`/`waiting`/`completed`/`declined`/`cancelled`/`expired` (`:203-204`). Reminder bookkeeping lives in the shared `reminders` table, not here. |
| `signature_challenges` | `id` (uuid) | `session_id`, `participant_id`, `law_firm_id`, `kind` (`otp`/`access_code`), `secret_hash`, `expires_at`, `attempts`, `lifetime_attempts`, `locked_until`, `verified_at` | One row per participant per gate (`:292-318`). Only `access_code` rows are written today. `lifetime_attempts` never resets, and is what the 20-failure cap reads. |
| `signature_participant_tokens` | `token` (text = publicToken) | `session_id` (FK), `participant_id`, `law_firm_id`, `delivery_method`, `consumed_at` | The per-participant public link token. **Stamped `consumed_at` by `invalidateParticipantToken` once that signer's turn ends** (single-use; the row is retained so a spent link can still render an "already signed" screen). Indexed on `participant_id`, `session_id`, and `(law_firm_id, session_id)`. |
| `signature_fields` | `id` (text) | `session_id` (FK), `law_firm_id`, `signer_id`, `page`, `x_percent`/`y_percent`/`width_percent`/`height_percent`, `field_type`, `label`, `required`, `style`, `sort_order`, `config` (jsonb) | Field placement as page-relative percentages. `signer_id` ties a field to a participant. Unknown extra keys spill into `config` (`mapFieldRow`/`fieldToColumns`). |
| `signature_templates` | `id` (uuid) | `law_firm_id`, `name`, `fields` (jsonb), `signer_roles` (jsonb), `source_object_path`, `routing_mode` | Reusable field+role layouts. Gets its `set_updated_at` trigger from the whole-schema sweep (`db/schema/99_sweeps.sql:45-46`). |
| `signature_sources` | `id` (uuid) | `law_firm_id`, `uploaded_by`, `object_path`, `object_generation`, `size_bytes`, `document_hash`, `profile_version`, `status`, `failure_code`/`failure_detail`, `prepared_object_path`/`prepared_generation`/`prepared_size_bytes`/`prepared_hash`, `page_count`, `digest_algorithm`/`digest_library_version`/`digest_state`/`digest_state_bytes`/`digest_state_generation`, `operation_id` | The admission boundary. Every document that reaches a signer has a row here, whichever route uploaded it, and nothing downstream reads bytes until `status` is `ready`. `object_generation` is TEXT because a GCS generation is 64-bit and a JS number rounds past 2^53, so two versions would compare equal. `digest_state` is the saved SHA-256 position over the prepared source, in base64: sealing resumes it instead of reading the document a second time, and the three columns beside it are what make that safe. `profile_version` records which policy admitted the document. Unique on `(law_firm_id, object_path)`. |
| `signature_processing_jobs` | `id` (uuid) | `law_firm_id`, `source_id`, `session_id`, `kind`, `status`, `input_revision`, `attempt`, `next_attempt_at`, `lease_owner`/`lease_token`/`lease_expires_at`, `phase`/`phase_state`, `failure_code`/`failure_detail` | Durable work for preparation and finalization, which do not fit in a request: Cloud Run stops scheduling CPU once a response is sent. The LEASE TOKEN is re-checked on every write, so a worker that stalls past its expiry loses the job and its later writes are refused rather than landing on top of its replacement's. A partial unique index keeps one LIVE job per logical operation, because two finalize jobs for one session would each seal, publish and notify. Drained by `POST /api/cron/signing-jobs`. |
| `signature_audit_events` | `id` (uuid) | `session_id` (FK), `law_firm_id`, `participant_id`, `event_type`, `ip`, `user_agent`, `actor_uid`, `metadata` (jsonb), `created_at` | **Append-only, DB-enforced**: a `before update` trigger (`signature_audit_immutable`, `87_signatures.sql:496-501`) raises on any UPDATE. Event vocabulary in `AUDIT_EVENTS` (`audit.ts:9-23`; includes `PARTICIPANT_DECLINED` and the two `ACCESS_CODE_*` events, no OTP events). |

**Relationships**: one `signature_sessions` → many `signature_participants`, `signature_participant_tokens`, `signature_fields`, `signature_challenges`, `signature_audit_events` (all `ON DELETE CASCADE` from the session's uuid). One participant → one public token (1:1 via `participant_id`, until invalidated). Fields link to participants by `signer_id`. Templates are independent (firm-scoped). Every child carries `law_firm_id` beside `session_id`, and a composite foreign key to `(law_firm_id, id)` on the session keeps the two in step, so a child cannot end up attributed to a different firm than its session.

### Key Logic & Rules

- **Token auth for public signers.** There is no login. `resolveSigningContext()` (`signingSessions.ts:303`) accepts either the session token or a participant `publicToken`; if it resolves and the participant matches, the holder is authorized. Tokens are 24 random bytes = 192 bits of entropy (`createId(24)`, `signingSessions.ts:8`, `:195`, `:219`). `optionalVerifyToken` lets a logged-in firm user (e.g. an `in_person` facilitator, or a member/client whose UID matches a participant) act through the same routes.
- **Single-use links.** `invalidateParticipantToken(token, participantId)` (`signatures.repository.ts:963`) stamps `consumed_at = now()` on the participant's `signature_participant_tokens` row (it no longer deletes it). It runs inside the completion transaction (`signing.routes.ts:1744`, `:1871`), through the tx-bound repo. A leaked link can no longer resolve for signing once that signer is done (active resolution filters `consumed_at is null`), while the retained row still backs the reload-completed "already signed" screen via `getConsumedTokenCompletion`; other participants' tokens are unaffected.
- **Transactional completion / decline / cancel.** `runSessionTransaction()` (`signatures.repository.ts:1896`) locks the session row + participants `FOR UPDATE`, loads the graph, runs the callback against a tx-bound repo (`updateSession`/`updateParticipant`/`replaceParticipants`/`invalidateParticipantToken`), and commits. Both `/complete` branches and `/decline` (`signing.routes.ts:2190`) use it; `/cancel` uses the set-based `cancelSession()` (`:2464`).
- **Constant-time secret comparison.** `hashesEqual()` (`signing.routes.ts:193`) guards length, hex-decodes both digests, and calls `crypto.timingSafeEqual`. Used for the access-code hash compare.
- **Verification gate.** The sender-set access code (SHA-256 in `hashAccessCode`, `signingSessions.ts:36`) blocks `GET /:token` metadata, `GET /:token/file`, and `POST /:token/complete` until cleared. 5 failures lock it for 60 seconds; 20 cumulative failures lock it until the firm reissues the link (`signing.routes.ts:259-263`, `:2342-2347`).
- **Routing.** Sequential promotes one signer at a time by `order`; parallel activates everyone and finalizes only when all are `completed`. Both use the row-locking transaction.
- **Decline.** `POST /:token/decline` (`signing.routes.ts:2153`) marks the declining participant `declined`, marks other non-completed participants `cancelled`, and sets the session `cancelled`, all inside `runSessionTransaction` (`:2190`) with a terminal-state re-check so a concurrent `/complete` cannot race it (returns idempotently if already terminal). It then writes `PARTICIPANT_DECLINED` and notifies the sender plus remaining signers; the cancellation notification is fed the **updated** participant array so the decliner is not re-emailed.
- **Audit trail.** Immutable inserts only — `writeAuditEvent` (`audit.ts:27`) and batched `writeAuditEvents` (`:49`, used by the expiry cleanup). A DB trigger blocks UPDATE; DELETE is intentionally allowed for the FK cascade and cleanup. IP/user agent captured from `x-forwarded-for` / socket (`extractRequestMeta`, `audit.ts:105`).
- **Consent.** Required at completion (`completeSigningSchema`, `signing.validation.ts`); the consent statement cites the ESIGN Act and UETA (`buildConsentStatement`, single source of truth in `signingNotifications.ts:59`, re-exported through `signing.routes.ts`).
- **Document integrity.** `documentHash` (original), `signedDocumentHash` (filed copy, with certificate page) and `deliveryDocumentHash` (copy sent to signers, without it) are SHA-256 over the sealed PDF bytes (`hashDocument`, `audit.ts`). `/verify` re-hashes and matches either signed hash; both columns are indexed. The final PDF gets an invisible PKCS#7 signature from the configured P12 cert (`digitalSign.ts`) on finalize (both artifacts) and on the downloadable certificate, so Adobe Reader shows "Signed by Paralegix" on the stored signed PDF.
- **The hash printed on a certificate is always one a reader can reproduce.** The Signature Certificate page bound into the filed PDF prints the DELIVERED copy's hash, because a page cannot state the hash of the file containing it — it used to print the unsealed pre-certificate bytes, a value that existed only inside the finalize function and matched no artifact anyone could hold. The standalone Certificate of Completion sits outside both PDFs and so prints both hashes, labelled.
- **Signing certificate provisioning.** `digitalSign.ts:19-22` resolves the cert path from `SIGNING_P12_PATH` (else the in-repo dev cert) and the passphrase from `P12_PASSPHRASE` (else `''`). `loadCertificate()` (`:47-60`) runs the production guard, caches the buffer, and throws a descriptive error if the file is missing. The executed documents never fall back to an unsigned PDF: the finalize job reaches the key through `signingIdentity()` (`digitalSign.ts:81`, `signingFinalize.ts`), and a certificate error fails the job, which retries with backoff and dead-letters after `SIGNING_JOB_MAX_ATTEMPTS` (default 6, `signingJobs.ts:63`). Only the standalone Certificate of Completion falls back: if its seal throws, `signing.routes.ts:546-550` logs and returns the unsealed certificate PDF.
- **Tenancy (firm side).** `signatureLinks.routes.ts` requires `verifyToken` + `requirePermission('signatures.view'|'signatures.send')`. Source and destination paths are forced inside `lawfirmids/<lawFirmId>/`, and a matter-scoped **source** additionally requires matter membership (`validateSigningSourcePath`) so a `signatures.send` holder off the matter can't send-for-signature (and exfiltrate) its documents. Staying inside the firm is necessary but not sufficient for either path: the firm prefix also holds the preserved archives, the scratch prefix an open session works in, and per-conversation attachment folders. A **source** under any of those is refused (`isSystemObjectPath` — sending an archived executed document for signature would copy it out of the archive and past the matter wall), and a **destination** must resolve through `parseFilingPath` to one of the four filing locations (General Files, a matter, a task, a client, at any depth), because filing into `signatures/` leaves the executed document invisible and delete-protected while filing into `signing-work/<token>/` hands it to the session's own sweep. The `signatures.send` **template** save path enforces the same source check (`persistTemplateSource` validates the copied `sourceObjectPath` by matter membership / `signing-uploads` `uploadedBy`, rejecting anything else). The completed-session output routes (`/signed-document`, `/certificate`, `/audit`) go through the shared `assertSessionOutputAccess`: creator OR `signatures.view` (via `canViewSignatureSession`, a 30s-cached membership+permission lookup) AND matter membership when the document is matter-scoped — so a `signatures.view` holder off a walled matter can't stream its executed PDF, certificate, or audit trail (which carries signer IPs). The public signing routes are intentionally NOT tenant-scoped — possession of the token is the authorization.
- **Signed-document integrity.** Field-bearing sessions always rebuild the signed PDF server-side from the pristine original + ownership-validated field values, so a signer can't swap the body. Fieldless sessions (signer marks the doc client-side and uploads it) can't be rebuilt, so the final buffer requires the uploaded **page count to match the stored original** — a signature adds marks but never changes the page count, so a mismatch (a document swap) is rejected. Submitted signature/initials PNGs are validated to be actually embeddable at submit (`findUnembeddableSignatureFields` attempts the same `embedPng` finalize does), so a valid-header-but-corrupt image can't be stored and then wedge finalization; the finalize stamp also skips (rather than throws on) an un-embeddable image as a defense-in-depth net.
- **Document storage (GCS).** Bucket = `process.env.GCS_BUCKET || 'lawfirms'`. Uploads land in `signing-uploads/<firmId>/<id>/` (bucket root, because their authorization is by object `uploadedBy` rather than firm membership; the firm id is a path segment so firm deletion can still sweep them). A PDF gets there without passing through the API: `POST /signing/upload-init` opens a resumable session on that path, stamped with the uploader, the browser PUTs the bytes in chunks (`lib/files/resumableUpload.ts`), and `POST /signing/upload-finalize` vouches for the object (this firm's prefix, this caller's stamp, `%PDF` leading bytes, under the cap). Non-PDF sources use the equivalent `POST /signing/convert-upload-init` and `/convert-upload-finalize` route pair: the converter reads and writes GCS objects, so source and converted bytes never travel in an API request. A firm document sent for signature that needs converting meets the same conversion cap before the converter reads it, in either converter mode: 100 MB when the document worker converts, 25 MB when the API does (`signingConversionCapBytes()`). The refusal says the limit comes from the conversion and that the same document saved as a PDF is accepted up to 500 MB. Vouching is now a ROW rather than a code path: finalize creates a `signature_sources` record through `signingSources.ts`, which pins the landed generation, compares the stored length to the declaration, and inspects structure through bounded windows (encrypted refused, an existing signature field refused, XFA refused, the page tree resolved). Nothing downstream may read the bytes until that row says `ready`, so a new entry point cannot skip the check the way the template routes once did. The limits it applies come from the versioned profile in `signingProfile.ts`, which reads the engine's own ceilings instead of restating them. A PDF whose name carries no extension is accepted when its declared content type says PDF, and the stored name is normalized to `.pdf`; the declared type is only a hint, and finalize's leading-byte sniff is what actually decides. The cap is `SIGNING_MAX_FILE_BYTES` (500 MB, `signing.validation.ts`), and it is a MEMORY decision, measured rather than guessed: the whole lifecycle ran inside a 512 MiB container against real persisted bytes, and signing added 28 MiB over a 101 MiB process baseline at 100 MiB and 32 MiB at 500 MiB. See *Producing the two executed artifacts* above for the table and for why the number is 500 MB rather than higher. Preparation and finalization each have their own, separate inline thresholds (`SIGNING_INLINE_PREPARE_BYTES`, `SIGNING_INLINE_FINALIZE_BYTES`): past those the route answers 202 with a job id and a durable job finishes the work, because the limit there is an interactive request deadline rather than memory. Working copies live under `lawfirmids/<firmId>/signing-work/<token>/`, preserved records under `lawfirmids/<firmId>/signatures/<token>/`. The filed signed PDF goes into the firm's destination folder and is quota-charged like any other document; client copies go into the messaging path under a random-prefixed name, so signing the same document twice for one client no longer overwrites the earlier post's bytes. The archive and working prefixes are excluded from the quota (`isSystemObjectPath`) and have no `files` row at all, which is what keeps them out of every listing and out of the firm's reach. Uploads older than 10 days and pending sessions past expiry are swept by `POST /api/cron/housekeeping` (`cleanupExpiredUploads`, `cleanupExpiredSessions`). Expiry claims sessions set-based with `bulkExpireSessions`, sweeps their workspaces eight at a time, and writes one batched audit INSERT. The finalize recovery pass in the same request stops claiming after three minutes, so the passes after it still run.
- **Expiry.** `SESSION_TTL_MS` = 7 days (`signingSessions.ts:6`); set at create time on `expires_at`.
- **Reminders.** `sendSigningReminders()` (`signingReminders.service.ts:35`) emails the active participant at 1/3/5 days. Candidates are SQL-pre-filtered and loaded as slim set-based graphs (`repo.listReminderCandidates` → `loadSessionGraphsSlimForRows`, `signatures.repository.ts:805`) to the active participant 0–6 days in and not reminded in 24h, then the JS re-asserts the exact `{1,3,5}` membership. Sending is CLAIMED first: `repo.claimReminderSend` moves the window into the `where` of one upsert, so two overlapping sweeps cannot both mail the same signer, and the claim itself is what stamps `last_sent_at` and bumps `sent_count`. A send that fails calls `releaseReminderClaim` to hand the window back. The manual re-send route claims through the same function with a 60-second window and `waiting` signers allowed.

### Dependencies

| Dependency | Used for | Where |
|---|---|---|
| `pdf-lib` | Build/stamp PDFs, certificate pages, form flatten | `certificatePage.ts`, `signingFieldValues.ts`, `signing.routes.ts:18` |
| `@signpdf/signpdf` + `@signpdf/signer-p12` + `@signpdf/placeholder-pdf-lib` | PKCS#7 digital seal | `digitalSign.ts` |
| `libreoffice-convert` (LibreOffice `soffice`) | DOCX/other → PDF and PDF → office formats | `signatures.service.ts` |
| Firebase Admin Storage (GCS) | All document bytes | `admin.storage().bucket()` in route files |
| Drizzle on the shared `node-postgres` pool | All relational data | `signatures.repository.ts`, `audit.ts` |
| Email service (`sendEmail`) | Invitations, reminders, completion/decline notifications | `signing.routes.ts`, `signingNotifications.ts` |
| `shared/storage/directUpload.ts` + `lib/files/resumableUpload.ts` | Browser-to-GCS uploads; no document passes through the API, so there is no multer | `signing.routes.ts` |
| `shared/documentConversion/converter.ts` | Non-PDF to PDF, in process or on the document worker (`DOCUMENT_CONVERTER=worker`) | `signatures.service.ts` |
| Shared rate limiters | Conversion, uploads, and the signing read/action/gate/verify limiters | `shared/middleware/rateLimiters.ts`, imported at `signing.routes.ts:91-97` |
| `crypto` | Token generation, SHA-256 hashing, constant-time compare | `signingSessions.ts`, `audit.ts`, `signing.routes.ts` |
| Messaging repo | Post signed PDF into client thread | `signing.routes.ts:1112` |
| Firebase Auth (frontend) | Optional bearer token on public routes | `signatures.service.ts` |

### Example

Send a 2-signer sequential request from a firm:

```http
POST /api/lawfirms/<firmId>/signature-links/send
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "objectPath": "lawfirmids/<firmId>/<matterId>/retainer.pdf",
  "fileName": "Retainer Agreement.pdf",
  "routingMode": "sequential",
  "fields": [
    { "id": "sig1", "page": 1, "xPercent": 60, "yPercent": 80,
      "widthPercent": 25, "heightPercent": 6, "fieldType": "signature",
      "signerId": "<participantId-of-client>" }
  ],
  "signers": [
    { "participantId": "<participantId-of-client>", "roleLabel": "Client",
      "order": 1, "deliveryMethod": "email",
      "name": "Jane Roe", "email": "jane@example.com", "accessCode": "4821" },
    { "roleLabel": "Partner", "order": 2, "deliveryMethod": "internal_dashboard",
      "memberUserId": "<firebaseUid>" }
  ]
}
```

Jane receives an email linking to `https://app/signature?token=<firstParticipantToken>`, enters access code `4821`, signs the signature field, and consents. The completion transaction marks her `completed`, **invalidates her token**, promotes the Partner to `active`, and emails the Partner. The Partner signs — triggering the final PDF build (certificate page + PKCS#7 seal), GCS save, and sender notification. (The supplied `signerId` must match a signer's `participantId` or the create returns a 400 listing every mismatched field.)

---

## What Can Be Improved

Ordered by impact. References are `backend/src/modules/signatures/` unless noted. **Items fixed in the latest batch are omitted**: the v2 finalize now appends the certificate page + inline PKCS#7 seal; signing tokens are single-use; sequential completion runs under `runSessionTransaction`; the firm list / reminder / pending finders are set-based; the view-stamp throttle is atomic; shared email/OTP/consent builders live in `signingNotifications.ts`; the Firestore timestamp shims are gone. **Verified fixed in THIS pass and removed from the list below:** the consumed-token completion screen (tokens are now stamped `consumed_at` rather than deleted, and a reloaded completed link renders "Your Signature Is Complete" — see *Verified fixed* note); the access-code minimum raised to 6 (`signatureLinks.validation.ts:28`/`:41`/`:57`, `min(6)`); the three overlapping timestamp helpers collapsed into the shared `timeUtils.ts` (`toIso`/`toMs`/`toDbTs`) with every former local helper now a thin alias; and the dead graph-loading `listExpiredPending` + the unused `findActiveSessionsForClient` exports both deleted.

### Correctness / data integrity

1. **The signing cert must be provisioned in prod (dev fallback is a bundled empty-passphrase cert).** `digitalSign.ts` falls back to `P12_PASSPHRASE || ''` and an in-repo `paralegix-signing.p12` for local dev. The code now **fails fast in production**: `assertProductionCertConfig()` (called from `loadCertificate()`) throws when `NODE_ENV === 'production'` and `P12_PASSPHRASE` is unset/empty OR `SIGNING_P12_PATH` still resolves to the bundled dev cert — so prod can never silently seal documents with the dev key. The remaining action is purely operational: provision a real passphrase-protected cert via `SIGNING_P12_PATH` + `P12_PASSPHRASE` in the prod secret store. **Code guard in place; provisioning is a deploy step.**

2. **Token-rotation/revocation scope is still narrow.** Tokens are now single-use *on completion* (stamped `consumed_at`), but there is no rotation during the 7-day TTL and no explicit per-participant revoke endpoint (only whole-session `/cancel` and `/decline`). A leaked token for a signer who has NOT yet signed is valid for the full TTL. Consider a firm-side "revoke this signer's link / reissue" action. **Still open (security, medium).**

3. **The email one-time-code gate left schema behind.** The routes were removed in ba189940, but `signature_participants.requires_verification` / `email_verified`, the `otp` kind on `signature_challenges` (`db/schema/87_signatures.sql:205-209`, `:297`) and the OTP read-model in the repository (`buildOtp`, `signatures.repository.ts:35-47`) remain, and nothing can set a participant to require a code. Either drop them in a contract migration or document the gate as parked. **Open (cleanup, low).**

4. **Client-side PDF flattening is capped at 50 MB, not bounded server-side.**
   `frontend/src/lib/pdfFlatten.ts` still reads the whole `File`, loads pdf-lib's object graph and
   writes a second complete PDF, so it now refuses anything over `FLATTEN_MAX_BYTES` (50 MB, the
   annotator's ceiling) before reading it, and `FlattenPdfModal` shows the limit and the manual
   Print to PDF route up front with the button disabled. A fillable PDF over 50 MB can still only
   be sent by flattening it by hand. The fuller fix is to run the existing streaming flattener
   (`pdf/forms.ts`) server-side after the confirmation. **Mitigated (availability, low).**

### Maintainability / duplication

5. **`replaceParticipants` is still a per-row UPDATE loop.** `signatures.repository.ts:1050` updates each participant one statement at a time. It is reached on parallel working-copy creation (`signatureLinks.routes.ts:568`), any `updateSession({ participants })` whole-array patch (`signatures.repository.ts:767`) and the tx-bound repo (`:1917`); the hot per-turn paths use targeted `updateParticipant`, so impact is low. The remaining whole-array writers (the parallel/sequential completion callbacks that hand `runSessionTransaction` the full `participants` array) could pass only the changed participant to `updateParticipant` to avoid N single-row UPDATEs per turn. **Still open (performance, low).**

### Smaller findings

6. **`signature_participant_tokens.law_firm_id` is denormalized but never used for tenant scoping.** The column is written at create (`signatures.repository.ts:443`) but no query filters on it (verified: no `t.law_firm_id`/`pt.law_firm_id` predicate anywhere in the repo); tenant scoping always goes through the session. Either use it (e.g. to scope participant-token lookups) or drop it. **Still open (cleanup, low).**

### Verified fixed in this pass (no action)

- **Consumed-token completion screen — FIXED.** `invalidateParticipantToken` now stamps `consumed_at = now()` instead of deleting the row (`signatures.repository.ts:687-695`); all active-token resolve paths filter `consumed_at is null` (`:157`, `:223`, `:261`, `:305`); and a new `getConsumedTokenCompletion(publicToken)` (`:705-726`) returns the completed participant's status/role/fileName for a *spent* token. `GET /:token` special-cases the unresolved-but-consumed case and returns `{ status:'completed', alreadySigned:true, participantStatus:'completed', ... }` (`signing.routes.ts:441-457`), which the frontend reads to render "Your Signature Is Complete" (`frontend/src/app/signature/page.tsx:150`, `:526-530`) instead of `InvalidLinkPage`. The guard `participant_status !== 'completed'` prevents leaking "completed" for a non-completed spent token. End-to-end correct.
- **Timestamp helper consolidation — FIXED.** `backend/src/modules/signatures/timeUtils.ts` now exports `toIso`/`toMs`/`toDbTs`, and every former local helper is a thin re-export alias: `ts`=`toIso` (`signingSessions.ts:14`), `tsMillis`=`toMs` (`signatureLinks.routes.ts:41`), `getTimestampMs`=`toMs`/`tsToIso`=`toIso` (`signing.routes.ts:77-78`), `isoOrNull`=`toIso` (`signatures.repository.ts:20`); `signingReminders.service.ts:6` imports `toMs` directly. No duplicated coercion logic remains.
- **Dead exports removed — FIXED.** `listExpiredPending` (full-graph N+1) and `findActiveSessionsForClient` are gone; only the slim `listExpiredPendingTokens` (`signatures.repository.ts:959`, wired at `signing.routes.ts:2303`) and `findPendingDocumentsForClient` survive.
- **Constant-time secret compares: VERIFIED.** `hashesEqual()` (`signing.routes.ts:193`) guards type + length, hex-decodes, re-checks buffer length, then `crypto.timingSafeEqual`; used on the access-code compare (`:2362`).
