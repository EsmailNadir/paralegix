# Tech Debt & Known Gaps

Deferred fixes, cleanups, and hardening we know about but have not scheduled.
Keep entries short and link to the code so the next engineer can act without this
context.

This is where a finished plan's leftovers land. The schema consolidation, the redesign proposal
and the legacy-removal plan are all done and deleted; everything of theirs that was still open is
below.

## Testing

- **Day-only date handling.** `YYYY-MM-DD` columns can shift a day for viewers
  behind UTC if a raw `Date` is used. Use the day-only helpers on both ends and
  keep new date columns off the naive path. See [Money & dates
  conventions](/dev/concepts/money) and the affected-column notes.

## Schema

The consolidation reduced the original 110 tables to 96. Five durable infrastructure tables
added since then bring the current schema to 101. The three duplications that drove the
consolidation (the note tables, the event tables, and the calendar-sync columns) remain collapsed.
What is left is blocked on a decision rather than on effort.

- **Three column retypes.** `invoice_expected_payments.matched_payment_index` cannot become a
  foreign key because there is nothing to point one AT: `invoice_payments` is written replace-all,
  so every save mints new uuids and the array position is a payment's only identity. Giving
  payments a stable id means moving the money write path from replace-all to a keyed upsert.
  `signature_sessions.client_id` is blocked on a product question, not a technical one: zero rows
  carry a value and the writer does not settle whether it means a `clients.id` or a Firebase uid.
  `charge_codes.default_rate` must move to cents with the whole eight-level rate chain at once;
  converting one level makes the chain less consistent, not more.
- **`conversations` membership is represented three ways.** `conversations.client_id`, the
  `conversation_participants` rows, and the direct-versus-group discriminator all encode who is on
  a thread, and a read has to consult more than one of them.
- **34 booleans carry no `is_` / `has_` / `can_` prefix**, plus the `archived` and
  `client_visible` columns. A rename sweep: cosmetic, and cheap only if done in one pass.
- **`reminders.next_run_at`** is unused and forward-looking, not legacy. Scheduling against it
  needs an invalidation design before the column is worth reading.

## Decided against, so it is not proposed again

- **Do not "clean up" `messages.sender_name`.** It reads like a cache of `users.name` and is not:
  it is ONE firm's record of who spoke, tombstoned per firm by `anonymizeParticipantIdentity` for
  a person who may still be a live client of another firm. A join has one value platform-wide and
  cannot express that.
- **Do not re-mount the calendar sync routers** under `/api/lawfirms/:lawFirmId`. The reason
  always given, that it would let `requirePermissionFrom` go, does not justify a breaking route
  change. What is left is a consistency argument for 23 routes against a breaking change to two
  live provider integrations, both frontend transports and every call site.

## Files and signing

The three large-file plans (incremental signing, large uploads, signing final touches) shipped and
were deleted on 2026-09-10. The hardening plan that followed them shipped too, apart from the
durable half of its cascade-delete task. What is below was left open on purpose.

- **Fieldless signing still stamps in the browser.** The annotator draws with pdf-lib, so the
  tab holds the whole document and pdf-lib's object graph beside it. The bounded fix is in
  place: a 50 MB cap (`ANNOTATOR_MAX_BYTES`, `frontend/src/hooks/signatureHooks/useAnnotationEditor.ts`).
  The real fix is a bounded annotation operation list (text, style, page, coordinates, small image
  references) that the incremental engine draws server side, the way field values already are.
- **No independent parser inspects a signed revision.** `tests/signatures/pdf/verifySeal.test.ts`
  proves the seal with this code's own reader. A test-time gate with a second PDF parser (pdf.js
  in Node, or `qpdf --check`) would catch a structural defect the reader is blind to.
- **The signing benchmark measures one operation at a time.** `backend/scripts/run-signing-benchmark.sh`
  limits memory but not CPU (`--cpus=1`), and runs one lifecycle. `SLOT_CONCURRENCY` is 3
  (`backend/src/shared/utils/transferSlot.ts`), so the production worst case is three at once on
  one vCPU beside 80 requests. That case has not been measured.
- **The corpus has no licensed fixtures from independent producers.** Every fixture in
  `backend/tests/shared/pdf/fixtures/buildSigningFixtures.ts` is built with pdf-lib. A scanned document
  from a real scanner driver and a form from a real authoring tool would exercise object streams,
  hybrid xref and incremental-update chains this code has only seen synthesised.
- **Templates still consume documents as blobs.** `frontend/src/services/templates.service.ts`
  (`:90`, `:205`, `:350`) returns or consumes a `Blob`, and `overlayFill.service.ts:39` parses a
  whole template with pdf-lib inside the 50 MiB template cap. Both belong to the templates module.
- **A crash during a parent delete can strand objects.** `backend/src/modules/files/cascadeSweep.ts`
  removes a deleted matter's, task's or client's objects inside the delete request, but a process
  that dies partway leaves the rest in the bucket with no row naming them and the firm still charged.
  The durable fix is a `file_object_tombstones` table written in the delete transaction and drained
  by `sweepDestroyedFiles`. It is a schema change, so it waits for `/new-migration`. The design:
  one row per orphaned `object_path` (unique) with its `law_firm_id` and `charged_bytes`, inserted
  by an `insert ... select ... on conflict (object_path) do nothing` over the scope snapshot before
  the parent row goes. A drain claims rows by deleting them (`delete ... where id in (select ...
  for update skip locked) returning ...`) BEFORE removing the objects, so two drains can never
  both credit the firm for one object; a storage delete that fails with anything but 404 puts its
  row back. Request-time sweeps cannot be relied on alone because the API runs as one instance with
  CPU throttled outside requests, so work after the response may never get CPU.
- **The PNG predictor and the ASN.1 parser stay synchronous.** Both are bounded by caps already in
  place (`backend/src/modules/signatures/pdf/filters.ts`), so they were left alone rather than
  rewritten. Revisit only if a profile shows either one blocking the event loop.
- **Portal and messaging finalize still take `declaredSize` back from the browser.** The reservation
  is derived on the server now, capped per file and counted once per path, but the per-file sizes
  come from the finalize body. Pinning them needs either a table of reservations or a server secret
  to sign what init handed out, and both are a schema or configuration change.
- **`filesRepo.listChildren` has no LIMIT.** `/list-folder` on a 20,000-document folder returns
  every row. The browser renders a virtualised list, so this is a transfer cost rather than a
  memory one, but it grows with the folder.
- **Production document conversion still runs in the API.** Staging is recorded and cut over:
  its Cloud Build trigger sets `_DOCUMENT_CONVERTER=worker`, and the private worker is live.
  Production has no worker service yet and the main trigger keeps the checked-in `local`
  default. Until the production cutover, a conversion there still spawns LibreOffice inside
  the 512 MiB API container.
- **`matters.repository.ts` holds a bucket handle.** A data module reaching into storage is the
  shape the storage-facing guard exists to catch; it is listed there rather than fixed.
- **No integration harness for the PDF.js viewer.** Every frontend test that touches
  `PdfPreview` or `PDFPageViewer` mocks react-pdf, so the claim that ranged loading and the
  five-canvas window hold against real PDF.js rests on the manual runs recorded in the feature doc.

## Adding an item

State the gap, the risk if left alone, and a link to the relevant file or feature
doc. Remove the entry when the work lands.
