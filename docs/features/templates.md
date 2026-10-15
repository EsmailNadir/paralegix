# Templates

## Summary

The Templates feature gives a law firm reusable **document templates** organized into nested **folders**, in one of three authoring modes: **Document Overlay** (upload any document, pin fields on top of the rendered page; the default), **DOCX** (upload a Word file, merge fields substituted server-side via docxtemplater), or **HTML** (built in an in-browser WYSIWYG editor). DOCX and Document Overlay templates carry fields and repeating sections that are merged with caller-supplied values to generate a finished document (PDF/DOCX/ODT/RTF/TXT). HTML templates embed images that are extracted to GCS as **assets**.

Access is gated by the `templates.view` / `templates.manage` RBAC permissions.

## Key Takeaways

- **Three authoring modes share one `templates` row shape.** `type` is `'html'`, `'docx'`, or `'overlay'` (check constraint, `db/schema/85_files.sql:23`). Uploading any accepted file as a Document Overlay creates an `'overlay'` row immediately (`createOverlayTemplateFromStored`, `templates.service.ts:844`), rather than staying unsaved in memory the way html/docx do until an explicit Save.
- **Field substitution is DOCX- and overlay-only, and runs through two different engines.** HTML templates are *not* server-rendered, they have no `/fill` path; substitution there, if any, is the editor/client's job (`templateFill.ts`). DOCX templates are filled with docxtemplater's text-reflow (`fillDocxTemplate`, `docx.service.ts:94`). Document Overlay templates are filled by stamping resolved values onto the source PDF with `pdf-lib` instead (`fillOverlayTemplate`, `overlayFill.service.ts:36`), reusing the same page-relative percent-box math and text-fit sizing as the signatures module's field stamping. Both branches live in one `renderFilledTemplate` (`templates.service.ts:1311`), which `fillTemplate` (`:1416`) wraps.
- **Document Overlay fields are placed on the page, not typed into the document.** A separate table, `template_field_placements`, holds one row per field (or per repeater column) as page-relative percentages (`x_percent`/`y_percent`/`width_percent`/`height_percent`, mirroring `signature_fields`; `85_files.sql:44-91`). A placement is one of five types: `text`, `date`, `checkbox` bind to a field value; `textbox` (literal or rich text) and `image` (an uploaded PNG/JPEG) are fixed content. `templates.fields`/`templates.repeaters` stay the source of truth for *what fields exist*; the placements table is *where they sit*. Saving a layout replaces the full placement set in one transaction and re-derives `templates.fields`/`repeaters` from it, so the jsonb summary can never drift from the placement rows (`savePlacements`, `templates.service.ts:1085`). A field chip inside a text box's `rich_text` counts as a fillable field too: a chip naming a sibling column stays a repeater field, any other chip lands in the flat list, and the save also refuses a repeater column taller than its row height.
- **Storage is GCS, not Postgres, for the heavy bytes.** Template HTML, DOCX binaries, Document Overlay source + rendered-PDF canvas, placement images and HTML image assets are all stored as GCS objects under `lawfirmids/{lawFirmId}/templates/…`; the Postgres row holds only metadata and object paths. HTML is deliberately not inlined to dodge the historical Firestore 1 MiB limit (a constraint left over from before the Postgres migration, still true of the storage layout today). Every write under that prefix is charged to the firm's storage figure as a size DELTA (`saveTemplateObject` / `copyTemplateObject`, `templates.service.ts:162`, `:182`), and a template save is never quota-rejected.
- **Uploads go browser to storage.** The frontend opens a direct upload (`POST /upload-overlay-init`, `/upload-docx-init`, `/:templateId/placement-images-init`), PUTs the bytes to a temporary bucket-root object, and the matching `-finalize` route verifies it and copies that exact generation into the template prefix (`templates.routes.ts:65-177`, `:212-260`, `:305-351`). The API has no multipart template-upload routes and does not buffer request bodies for these uploads.
- **Assets live on `templates.assets` jsonb.** There is no relational assets table; HTML-editor assets are exclusively a jsonb array on the `templates` row (`85_files.sql:34`; `templates.repository.ts`). Overlay placement images are NOT assets: they sit on their placement row's `image_object_path`.
- **The list query skips the heavy columns.** `listByLawFirm` (`templates.repository.ts:16-39`) selects an explicit column list (no `html`, no `assets`, no overlay object paths) so the list endpoint never pulls big payloads; the single-GET path (`getTemplate` → `findById`) still loads them and additionally mints a fresh signed preview URL for an overlay template's PDF.
- **Fill and preview answer with a link, not the document.** `POST /:templateId/fill` and `GET /:templateId/preview` return a 15-minute, generation-pinned signed URL (`TEMPLATE_RENDER_URL_TTL_MS`, `templates.service.ts:220`). An overlay preview signs the stored canvas PDF where it sits; a DOCX preview and every fill write their output to `lawfirmids/{firm}/template-renders/{templateId}/{user}/{kind}.{ext}` first (`publishRender`, `:344`). That segment is a system working prefix (`recordArchive.ts:70`), outside the quota, one object per person per template per kind, swept after 24 hours. HTML templates have no preview endpoint; the frontend renders their own HTML.
- **Document → final document → e-signature.** Fill reuses the signatures module's `convertDocument` (LibreOffice, local or the document worker; see [document-conversion.md](document-conversion.md)) for format conversion in both the DOCX and overlay branches, and overlay creation converts from storage with `convertStoredDocument`. A filled PDF/DOCX is the typical input to an e-signature session.
- **Once saved, a template's authoring mode is fixed.** There is no converting an HTML template to DOCX, a DOCX template to Document Overlay, or vice versa. The frontend offers a one-time bail from Document Overlay into the full HTML/DOCX editor, but only right after upload, before the template has ever been saved.
- **Folder delete is a single transaction.** `deleteFolder` reparents templates + child folders up one level and deletes the folder via `deleteWithReparent`, which does two bulk `UPDATE`s and one `DELETE` in one `begin/commit` (`templateFolders.repository.ts`).
- **Orphaned GCS objects can be reconciled by a GC sweep.** `gcSweep` / `gcSweepLawFirm` (`templates.service.ts:1656-1770`) list every object under `lawfirmids/{firm}/templates/` and delete those not referenced by any live row (`listReferencedObjectPaths`, `templates.repository.ts:41-68`, which now also tracks the overlay source/PDF paths). It is scheduled by `POST /api/cron/housekeeping` (not a boot-time interval, which does not survive Cloud Run's request-based CPU allocation) and defaults to `dryRun: true` unless `TEMPLATES_GC_DELETE=true` is set.
- **Tenancy is enforced by `requirePermission` + `law_firm_id`-scoped Drizzle queries.** Document templates rely on permission middleware plus audited tenant query contexts (`tenantQuery`, `withDrizzleTransaction`); the retained `DrizzleRepository` CRUD base follows that same Drizzle path.
- **The HTML editor is a large refactored module cluster, not one file.** `TemplateEditor.tsx` is the orchestrator; the codebase also extracted pure DOM/pagination helpers (`templateEditorDom.ts`), shared types/option constants (`templateEditorTypes.ts`), and presentational leaf components (`TemplateFormattingToolbar.tsx`, `TemplateRulers.tsx`, `UploadZone.tsx`). All editor state and behavior still live in `TemplateEditor.tsx`; the leaves are controlled by props/callbacks. The Document Overlay editor is a separate, smaller component, `TemplateOverlayEditor.tsx`, built around a read-only `PDFPageViewer` (shared with the signatures module) with field/repeater boxes placed on top.

---

## How It Works

### Entry Points

Routes mounted in `backend/src/app.ts`:

| Mount | Router(s) | app.ts |
|---|---|---|
| `/api/lawfirms/:lawFirmId/templates` | `[templateFoldersModuleRoutes, templatesModuleRoutes]`, behind `verifyToken` + `requireFeature('templates')` | `:917` |

Both routers are mounted on the same base path as an array, in that order. The folder router only registers `/folders…` sub-paths, so it never collides with the template router, but the order still matters, because `templates.routes.ts` has a `/:templateId` wildcard that would otherwise shadow `/folders` if it came first. The whole prefix also gets a 50 MB JSON body ceiling (`app.ts:392-398`), because the HTML editor PUTs pasted images as `data:` URLs.

Document template endpoints (`templates.routes.ts`):

| Method | Path | Permission | Handler | Line |
|---|---|---|---|---|
| GET | `/` | `templates.view` | `listTemplates` | `:46` |
| POST | `/` | `templates.manage` | `createTemplate` (HTML) | `:55` |
| POST | `/upload-docx-init` | `templates.manage` | opens a direct upload under `template-docx-uploads/{firm}/{uid}/` | `:65` |
| POST | `/upload-docx-finalize` | `templates.manage` | settle, download, `createDocxTemplate`, delete the temp object | `:88` |
| POST | `/upload-overlay-init` | `templates.manage` | opens a direct upload under `template-uploads/{firm}/{uid}/` | `:125` |
| POST | `/upload-overlay-finalize` | `templates.manage` | settle, `createOverlayTemplateFromStored`, delete the temp object | `:150` |
| GET | `/:templateId/placements` | `templates.view` | `listPlacements` | `:186` |
| PUT | `/:templateId/placements` | `templates.manage` | `savePlacements` | `:196` |
| POST | `/:templateId/placement-images-init` | `templates.manage` | direct upload, PNG/JPEG only, 10 MB | `:212` |
| POST | `/:templateId/placement-images-finalize` | `templates.manage` | `uploadPlacementImageFromStored` | `:234` |
| POST | `/:templateId/fill` | `templates.view` | `fillTemplate`, returns a signed link | `:278` |
| GET | `/:templateId/preview` | `templates.view` | `previewTemplate`, returns a signed link | `:295` |
| POST | `/:templateId/upload-docx-init` | `templates.manage` | direct upload for a DOCX re-upload | `:305` |
| POST | `/:templateId/upload-docx-finalize` | `templates.manage` | settle, download, `updateDocxTemplate` | `:328` |
| GET | `/:templateId` | `templates.view` | `getTemplate` | `:356` |
| PUT | `/:templateId` | `templates.manage` | `updateTemplate` | `:366` |
| DELETE | `/:templateId` | `templates.manage` | `deleteTemplate` | `:384` |

Every more specific route is registered before the bare `/:templateId` wildcard, so none of them are shadowed by it. All upload routes carry `uploadLimiter`.

The init/finalize routes check the extension and require the finalize `objectPath` to sit under the caller's own temporary prefix. `settleDirectUpload` (`shared/storage/directUpload.ts`) checks the object's `uploadedBy` stamp, its stored size (50 MB for documents, 10 MB for images) and, for images, its stored content type. Each finalize deletes the temporary object in a `finally`.

Folder endpoints (`templateFolders.routes.ts`): `GET /folders` (`:11`), `POST /folders` (`:20`), `PUT /folders/:folderId` (`:37`), `DELETE /folders/:folderId` (`:56`).

Frontend:
- Page: `frontend/src/app/lawfirm/[lawFirmId]/templates/page.tsx`: gates on `RequireFeature feature="templates"` and renders a view-state machine (`list` / `list-fill` / `new` (full editor) / `edit` / `overlay`).
- Services: `frontend/src/services/templates.service.ts` (document templates + folders + fill + preview + convert). `uploadOverlay` (`:323`), `uploadDocxTemplate` (`:249`), `reuploadDocxTemplate` (`:292`) and `uploadPlacementImage` (`:425`) use the init/finalize pairs; `previewPdf` (`:105`) and `fillDocxTemplate` (`:463`) return `{ url, fileName, contentType, sizeBytes, generation, urlExpiresAt }`.

### Frontend: two authoring surfaces

| Component | Role |
|---|---|
| `TemplateCreatePanel.tsx` | The page's primary "New Template" target. Any accepted file dropped or picked here is uploaded immediately as a Document Overlay template (`uploadOverlay`) and its editor opens right away, since the overlay editor needs a real PDF to render. |
| `TemplateOverlayEditor.tsx` | Renders the template's PDF read-only via `PDFPageViewer` (shared with the signatures module) and lets the user click to place field/repeater boxes on top of it as page-relative percentages. Offers **"Use the full editor instead"** only for the template this session's own upload just created, before it has been saved, a one-way bail into the classic flow below. |
| `TemplateEditor.tsx` | The classic full editor: builds an HTML template from a blank canvas or an uploaded/converted document, or edits a DOCX template's merge fields. The state/behavior all live here; `templateEditorDom.ts`, `templateEditorTypes.ts`, `TemplateFormattingToolbar.tsx`, `TemplateRulers.tsx`, and `UploadZone.tsx` are its extracted stateless/presentational helpers. |

### Data Flow: Create a Document Overlay template

The frontend (`templatesService.uploadOverlay`) calls `POST /upload-overlay-init`, PUTs the file to `template-uploads/{firm}/{uid}/{uuid}/source{ext}`, then calls `POST /upload-overlay-finalize`, which settles the upload and hands the settled path, size and generation to `createOverlayTemplateFromStored` (`templates.service.ts:844`).

1. Validate the extension is one of `.pdf`, `.docx`, `.doc`, `.odt`, `.rtf`, `.txt` (`OVERLAY_ACCEPTED_EXTENSIONS`, `:53`); optional folder existence check.
2. Insert a row with `type: 'overlay'` and empty `fields`/`repeaters`/`assets` to obtain an id. No placeholder parsing happens here, unlike the DOCX path, since fields are placed later in the editor.
3. Copy the settled generation server side to `…/templates/{id}/overlay-source{ext}` (`copyTemplateObject`, which charges the size delta). The bytes never enter the API process.
4. If the upload was already a PDF, that source object doubles as the canvas. Otherwise, convert it to PDF once from storage via the signatures module's `convertStoredDocument`, copy the pinned result to `…/templates/{id}/overlay.pdf`, and clean up the conversion scratch.
5. Update the row with both object paths, mint a 7-day signed URL for the PDF (`overlayPdfUrl`, needed because `react-pdf` fetches an actual URL, not just an object path), and return the created template.
6. Any failure after step 2 deletes the row (`discardDraftTemplate`, `:729`) and rethrows the original error; objects already written are left for `gcSweep`.

### Data Flow: Place fields on a Document Overlay template

`PUT /:templateId/placements` → `savePlacements` (`templates.service.ts:1085-1229`):

1. Reject if the template isn't `type: 'overlay'`.
2. The caller sends the full current placement set plus repeater metadata (`anchorPage`/`anchorYPercent`/`rowHeightPercent`/`rowCount`), always a full replace, matching the junction-table convention used elsewhere (e.g. `task_assignees`). `savePlacementsSchema` (`templates.validation.ts:162`) refuses a `textbox` with no content, an `image` with no `imageObjectPath`, and a `repeaterRowIndex` other than `0` on a repeater placement. It also bounds the payload: `x`/`y` in [0, 100], `width`/`height` in (0, 100], and a box that runs past the right or bottom edge (beyond a 1e-6 float tolerance) is refused; `anchorYPercent` in [0, 100), `rowHeightPercent` at most 100, `rowCount` (rows per page) at most 100; at most 1,000 placements and 50 repeaters; field and repeater names at most 120 characters and `imageObjectPath` at most 1,024.
3. Validate every placement's `repeaterName` (if set) against the supplied repeater metadata list, and derive each repeater's `fields` array from the placements that actually reference it, never from anything the client claims directly, so `templates.repeaters` can't drift from `template_field_placements`. `image` placements cannot sit in a repeater; `textbox` and `image` placements never become fields. Any `imageObjectPath` must be a single file name directly under THIS template's `…/templates/{id}/placement-images/` folder (`isOwnPlacementImagePath`, built from the same `overlayPlacementImagePrefix` the upload uses); anything else is a 400, because the fill reads that path and a later save deletes it.
4. In one transaction: lock the template row (`templatesRepo.lockForUpdate`, `select … for update`), read the previous placements under that lock, then `placementsRepo.replaceForTemplate` deletes and re-inserts `template_field_placements` (`templateFieldPlacements.repository.ts:61`), and `templates.fields`/`templates.repeaters` are updated from the same derived data.
5. After commit, image objects the new set no longer references are deleted (`deleteRemovedAssets`, `:1347`). A removed path outside the template's own image folder is logged and never deleted.

The lock is what keeps two overlapping saves from both inserting: without it, each save's delete runs before the other commits and the template keeps the union of both layouts.

An image placement is uploaded first (`placement-images-init`/`-finalize` → `uploadPlacementImageFromStored`, `:1112`), which copies it to `…/templates/{id}/placement-images/{imageId}.{ext}` and returns `imageObjectPath`; the editor then includes that path in its next save.

### Data Flow: Create an HTML template

`createTemplate` (`templates.service.ts:733-765`):

1. If `folderId` given, verify the folder exists in this firm.
2. Insert a **draft** row with empty `assets` to obtain an `id` (needed for the GCS object paths).
3. `normalizeTemplateHtmlAssets` scans the HTML for `<img … data-template-object-image="true">` tags. For each tag whose `src` is a `data:image/...` URL it decodes the data URL, uploads the bytes to GCS, replaces `src` with a `data-template-asset-id`, and records an asset object. Existing-asset tags are retained; assets no longer referenced are deleted from GCS.
4. The normalized HTML is written to GCS (`saveTemplateHtmlToStorage`) and the row is updated with `htmlStoragePath` and the `assets` jsonb array.
5. Asset preview URLs (7-day signed URLs) are attached and the hydrated template is returned.

### Data Flow: Create a DOCX template

`createDocxTemplate` (`templates.service.ts:770`), called from `POST /upload-docx-finalize` with the settled temporary object downloaded whole because placeholder parsing needs the ZIP bytes. Storage verifies the 50 MB cap before that bounded download:

1. Optional folder existence check.
2. `parseDocxPlaceholders` (`docx.service.ts:55-84`) loads the DOCX via PizZip, runs zip-bomb guards (≤2000 entries, ≤200 MB uncompressed, must contain `word/document.xml`, `docx.service.ts:16-44`), then instantiates docxtemplater with `InspectModule` to enumerate tags. Tags with sub-keys become **repeaters**; the rest are simple **fields**.
3. Insert the row with `type='docx'`, a flattened field list (`buildFlatFieldList` joins repeater fields as `repeaterName.field`), and any repeaters.
4. Upload the DOCX buffer to `…/templates/{id}.docx` in GCS.
5. Optionally, if `html` was also supplied (an editable HTML rendition), normalize+store it like the HTML path.

### Data Flow: Organize in folders

Folders are a self-referential tree (`template_folders.parent_folder_id`).

- `createFolder` (`templateFolders.service.ts:88-110`): loads **all** folders, verifies the parent exists, rejects a duplicate sibling name (case-insensitive), computes the next `sort_order` among siblings, inserts.
- `updateFolder` (`:115-158`): recomputes parent/name, guards against cycles (`ensureNoCycle` walks the ancestor chain), rejects duplicate siblings, and re-orders when reparented.
- `deleteFolder` (`:163-189`): computes the destination parent (the deleted folder's parent, or null) and the starting order for reparented children, then calls `templateFoldersRepo.deleteWithReparent`. That repo method does the whole reparent + delete in a **single transaction**: `begin`, one `UPDATE templates SET folder_id = destination WHERE folder_id = $folder`, one window-function `UPDATE template_folders` that reparents child folders and renumbers their `sort_order` to slot after the destination's existing siblings, a `DELETE` of the folder, then `commit` (rollback on error). DB FKs are `on delete set null` on both `folder_id` and `parent_folder_id`, so the manual reparenting is the app choosing "move up" semantics over "orphan to root".

### Data Flow: Fill a template (render / generate)

`POST /:templateId/fill` → `fillTemplate` (`templates.service.ts:1416-1450`) → `renderFilledTemplate` (`:1311-1401`):

1. Load the row under the caller's firm; reject if not found or if `type` isn't `docx` or `overlay` (HTML templates have no server fill path). Nothing is signed before this lookup succeeds.
2. **DOCX branch:** read the source DOCX with `readBounded`, which checks the object's stored size against `TEMPLATE_MAX_BYTES` (25 MB, `:1620`) BEFORE downloading and answers 413 `TEMPLATE_OBJECT_TOO_LARGE` over it. `fillDocxTemplate` (`docx.service.ts:94`) re-validates the zip, merges `values` (simple fields) and `repeaterValues` (loop arrays) into one data object, and calls `doc.render(data)`. The render is wrapped in try/catch: docxtemplater tag errors (and multi-error `err.properties.errors`) are flattened into a `ValidationError` with `{ message, errors[] }` instead of escaping as a 500. If `format === 'docx'`, the filled DOCX is used directly; otherwise it's converted via `convertDocument`.
3. **Overlay branch:** read the canvas PDF (`overlayPdfObjectPath`, same 25 MB bound) and the template's saved placements. Image placements' bytes are fetched ONE AT A TIME, each capped at `TEMPLATE_IMAGE_MAX_BYTES` (10 MB) and the running total at `TEMPLATE_IMAGE_TOTAL_MAX_BYTES` (25 MB), checked from metadata before each read (`:1512-1542`). An image path outside the template's own `placement-images/` folder is skipped and logged, never read, so a legacy row cannot pull another firm's object into a fill. `fillOverlayTemplate` (`overlayFill.service.ts:36`) stamps the resolved `values`/`repeaterValues`, text boxes and images onto the PDF with `pdf-lib`, laying out repeater rows below their anchor row with page-overflow continuation pages. `fillTemplateSchema` caps a fill at 1,000 values, 50 repeaters and 500 rows per repeater, and `fillOverlayTemplate` refuses (400, naming the repeater) a fill whose rows need more than 200 continuation pages in total, before copying any page. Text is drawn in the placement's own font when that face covers every character; otherwise in the first bundled face that does (`FONT_FALLBACKS`: Helvetica and Courier go to PT Sans, Times and Cambria to PT Serif, then Carlito, which also covers Greek and Vietnamese), so a name like "Łukasz Żółć" prints instead of leaving the box blank. No bundled face has CJK, Hebrew or Arabic: those characters print as "?" and the field is reported back. `format === 'pdf'` (the default) is used as-is; any other format is converted via `convertDocument`.
4. `publishRender` (`:344-361`) writes the result to `lawfirmids/{firm}/template-renders/{templateId}/{uid}/fill.{ext}` (replacing that person's previous fill) and signs a 15-minute URL pinned to the new generation. `disposition` (`attachment` by default, `inline` for a preview tab) and a sanitized `fileName` go into the URL's `Content-Disposition`.
5. The route answers `{ downloadUrl, disposition, fileName, contentType, sizeBytes, generation, urlExpiresAt, incompleteFields }`. The document itself never passes back through the API. `incompleteFields` is `[{ fieldName, characters }]` for every overlay field whose text did not fully print (`characters` is empty when the box could not be drawn at all), and always `[]` for DOCX; the fill dialog turns a non-empty list into a warning toast (`incompleteFieldsNotice`).

Frontend `templatesService.fillDocxTemplate` posts `{ values, repeaterValues, format, fileName, disposition }` and returns the link (`templates.service.ts:463-489`); `FillTemplateModal` opens it or fetches it.

### Data Flow: Preview a template

`GET /:templateId/preview` → `previewTemplate` (`templates.service.ts:1525-1598`):

1. Load the row under the caller's firm first. HTML templates are previewed by the client from the HTML it already has, so only the two document-backed types are served here, both as PDF.
2. **Overlay:** the stored canvas PDF IS the preview, so the object is signed where it sits (`signTemplateObject`, `:326`). Nothing is read.
3. **DOCX:** the source is read (25 MB bound), converted with `convertDocument`, and published as a `preview.pdf` render, `inline`. It is deliberately **not** written under the firm's templates prefix, where `gcSweep` would read it as an orphan and the quota would charge for it.
4. Either way the answer is `{ previewUrl, fileName, contentType, sizeBytes, generation, urlExpiresAt }`. Frontend: `templatesService.previewPdf` (`useTemplatePreview.ts:65`) hands the URL to `TemplatePreviewModal`, which renders it with the same `PdfPreview` component used elsewhere in the app.

Renders are collected two ways: `deleteTemplate` removes the template's whole render prefix, and `sweepExpiredRenders` (`:1893`) deletes renders older than `TEMPLATE_RENDER_TTL_MS` (24 hours) on every housekeeping pass, regardless of `TEMPLATES_GC_DELETE`.

### Data Model

**Document templates** (`backend/db/schema/85_files.sql:19-38`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id` | uuid FK → law_firms | tenant scope, cascade delete |
| `name` | text | |
| `type` | text | `'html'`, `'docx'`, or `'overlay'` (check constraint, default `'html'`) |
| `fields` | text[] | flat field-name list (for overlay: non-repeater placement field names) |
| `repeaters` | jsonb | `[{ name, fields[] }]`; for overlay templates also carries `anchorPage`/`anchorYPercent`/`rowHeightPercent`/`rowCount` |
| `folder_id` | uuid FK → template_folders | `on delete set null` |
| `html_object_path` | text | GCS path (entity alias `htmlStoragePath`). The row's HTML lives in GCS and nowhere else; the `html` column that used to sit beside this one, always written as `''`, was dropped by migration 0251. `html` survives as an API and service field, hydrated from storage on the single-GET path. |
| `docx_object_path` | text | GCS path (alias `docxStoragePath`) |
| `overlay_pdf_object_path` | text | the rendered editor canvas: the upload itself if it was already a PDF, otherwise a one-time LibreOffice-converted copy |
| `overlay_source_object_path` | text | the original upload, kept for reference/re-conversion |
| `assets` | jsonb | `[{ id, objectPath, mimeType, fileName, width, height, source }]` |

Index: `templates_firm_folder_idx (law_firm_id, folder_id)` (`85_files.sql:38`).

**`template_field_placements`** (`85_files.sql:44-93`): page-relative overlay boxes for `overlay`-type templates, one row per field (or per repeater column on its authored row). `id`, `law_firm_id`, `template_id` (FK, cascade delete), `field_name`, `field_type` (`'text'`/`'date'`/`'checkbox'`/`'textbox'`/`'image'`, check constraint), `page`, `x_percent`/`y_percent`/`width_percent`/`height_percent` (numeric, percent-of-page, mirroring `signature_fields`), `repeater_name`, `repeater_row_index`, `sort_order`, plus content and styling: `text_content` and `rich_text` (jsonb paragraph blocks of styled runs, a run may carry a `fieldName` chip) for text boxes, `image_object_path`/`image_mime_type` for images, and `font_size` (null auto-fits), `font_family` (`helvetica`/`times`/`courier` built in; `calibri`/`cambria`/`pt-serif`/`pt-sans` embedded from `modules/templates/fonts`), `bold`, `italic`, `color`, `text_align`, `bullet_list`. Index: `template_field_placements_template_id_idx (template_id)`.

**`template_folders`** (`85_files.sql:5-17`): `id`, `law_firm_id`, `name`, `color`, `parent_folder_id` (self-FK, set null), `sort_order` (nullable; alias `order`). Tree structure; ordering is sibling-scoped. Index: a **non-unique** `template_folders_sibling_name_idx (law_firm_id, parent_folder_id, lower(name))`. The schema comment marks it to be promoted to `UNIQUE` once duplicate sibling names are de-duped in existing data, so it does **not** yet enforce uniqueness at the DB level.

**Relationships:**
- `templates.folder_id → template_folders.id` (nullable).
- `template_folders.parent_folder_id → template_folders.id` (nested tree).
- `template_field_placements.template_id → templates.id` (cascade delete).

### Key Logic & Rules

**Fields / merge variables:**
- DOCX syntax is docxtemplater's: `{field}` for simple, `{#loop}…{/loop}` for repeaters.
- DOCX fields are extracted *at upload time* and cached on the row; if the DOCX is re-uploaded, fields/repeaters are re-derived (`updateDocxTemplate`).
- Overlay fields are placed, not typed: their names come from whatever the user labels a box as in the editor, and their positions live only in `template_field_placements`, never duplicated elsewhere.
- HTML templates store a `fields` list but have **no server merge**: substitution, if any, is the editor/client's job (`templateFill.ts`).

**Asset storage (GCS):**
- Bucket resolved as `process.env.GCS_BUCKET || 'lawfirms'`, via Firebase Admin `admin.storage()` (Firebase is used only for Auth/GCS, never data; project convention).
- Object layout under `lawfirmids/{firm}/`: HTML `templates/{id}.html`, DOCX `templates/{id}.docx`, Document Overlay `templates/{id}/overlay-source{ext}` + `templates/{id}/overlay.pdf`, HTML assets `templates/{id}/assets/{assetId}.{ext}`, overlay images `templates/{id}/placement-images/{imageId}.{ext}` (`templates.service.ts:42-112`), and renders `template-renders/{templateId}/{uid}/{fill|preview}.{ext}` (`:236-262`).
- Direct uploads land first at bucket-root temporary prefixes, `template-uploads/{firm}/{uid}/`, `template-docx-uploads/{firm}/{uid}/` and `template-placement-uploads/{firm}/{templateId}/{uid}/` (`templates.routes.ts:24-29`), and are deleted by the finalize route whether it succeeds or not.
- Data-URL images (HTML templates) are extracted to GCS on every save so the stored HTML never contains base64 blobs; the rendered `<img>` is rewritten to drop `src` and carry `data-template-asset-id`, and a 7-day signed preview URL is generated on read.
- On delete (`deleteTemplate`, `:1760-1794`), the service explicitly removes the DOCX/HTML/overlay source+PDF (skipping a duplicate delete when the overlay source and PDF are the same object), every asset object, and the template's render prefix, swallowing failures. Placement images are not removed here; they are left to `gcSweep`. Objects leaked by a swallowed failure can be reclaimed later by the `gcSweep` reconciliation, which credits the freed bytes back to the firm.

**Validation:**
- Document Zod schemas (`templates.validation.ts`): `createTemplateSchema` / `updateTemplateSchema`, `fillTemplateSchema` (defaults `values={}`, `repeaterValues={}`, `format='pdf'`, `disposition='attachment'`; restricts `format` to a 5-value enum and `disposition` to `inline`/`attachment`), and `savePlacementsSchema` (the placement array plus overlay repeater layout metadata, with refinements that `repeaterRowIndex` is `0` for a repeater placement and omitted otherwise, a `textbox` has content, and an `image` has an `imageObjectPath`; `textContent` is capped at 2,000 characters and `rich_text` at 200 blocks of 200 runs).
- DOCX file-content defense is still the zip-bomb guard in `loadDocxZip` (`docx.service.ts:16-44`) plus the render try/catch.

**Permissions & tenancy:**
- Document templates: `templates.view` to read/fill/preview, `templates.manage` to mutate. Tenancy is enforced by `law_firm_id`-scoped audited Drizzle queries (`tenantQuery`, `withDrizzleTransaction`).
- All queries scope by `law_firm_id`; the backend connects as `postgres` and bypasses RLS (project convention).

### Dependencies

- **GCS** (via Firebase Admin): all template HTML, DOCX, Document Overlay source/PDF, and asset bytes.
- **docxtemplater + pizzip + inspect-module**: placeholder parsing and rendering for DOCX templates (`docx.service.ts`).
- **pdf-lib**: stamping resolved field values onto a Document Overlay template's source PDF (`overlayFill.service.ts`), reusing the box/text-fit helpers from the signatures module's `signingFieldValues.ts`.
- **signatures module / document conversion**: `convertStoredDocument` (storage to storage) for the overlay-upload conversion step, and the buffer `convertDocument` for the DOCX fill/preview paths and the overlay fill path's non-PDF output formats. Both resolve to `shared/documentConversion/converter.ts`, which runs LibreOffice in-process or calls the separate document worker when `DOCUMENT_CONVERTER=worker`.
- **`shared/storage/directUpload.ts`**: `beginDirectUpload` / `settleDirectUpload` for every init/finalize pair.
- **Housekeeping cron**: `POST /api/cron/housekeeping` runs `sweepOrphanedTemplateObjects` (`app.ts:740`), which does the render sweep and then `gcSweep`.
- **e-signatures (downstream):** filled documents (PDF/DOCX) are a natural input to a signature session; the link is by data flow, not a direct call from the templates module.
- **frontend pdf→html**: `convertPdfToHtml` / `@/lib/pdfToHtml` feeds the HTML editor when a PDF is uploaded through "Use the full editor instead".

### Example

Generate a signed-ready engagement letter, two ways:

**DOCX (merge fields):**
1. Upload `engagement.docx` containing `{client_name}`, `{matter}`, and `{#fees}{description}{amount}{/fees}` by opening `POST /templates/upload-docx-init`, PUTting the file to storage, and finalizing with `POST /templates/upload-docx-finalize`. Server parses fields `["client_name","matter","fees.description","fees.amount"]` and repeater `{ name:"fees", fields:["description","amount"] }`.
2. Fill it → `POST /templates/{id}/fill` with
   ```json
   {
     "values": { "client_name": "Acme Corp", "matter": "Trademark filing" },
     "repeaterValues": { "fees": [
       { "description": "Filing fee", "amount": "$350" },
       { "description": "Attorney hours", "amount": "$1,200" }
     ] },
     "format": "pdf"
   }
   ```
   Server reads the DOCX (25 MB bound), renders it with docxtemplater (tag errors → 400), converts to PDF, writes it to `template-renders/{id}/{uid}/fill.pdf`, and answers `{ "downloadUrl": "https://storage.googleapis.com/…", "disposition": "attachment", "fileName": "filled-template.pdf", "contentType": "application/pdf", "urlExpiresAt": "…" }`. The browser downloads from that URL.

**Document Overlay (pinned fields on an existing PDF):**
1. Upload `engagement.pdf` → `POST /templates/upload-overlay-init`, PUT the bytes to the returned session URL, then `POST /templates/upload-overlay-finalize`. Server copies it into the template prefix as both the source and the canvas (already a PDF, no conversion needed) and returns a signed preview URL.
2. In the overlay editor, place `client_name` and `matter` text boxes on the page, plus a `fees` repeater anchored under the fee table's header row → `PUT /templates/{id}/placements`.
3. Fill it → `POST /templates/{id}/fill` with the same `values`/`repeaterValues` shape as above. Server reads the canvas PDF and the saved placements, stamps the values on with `pdf-lib`, and answers with a link to the flattened PDF.

3. (Downstream, either path) upload that PDF into an e-signature session.

---

## What Can Be Improved

Ordered by impact.

### 1. A document can be uploaded that can never be filled (correctness) - OPEN
Document uploads accept 50 MB (`OVERLAY_UPLOAD_MAX_BYTES`, `templates.routes.ts:20`, used for DOCX and overlays), but fill and DOCX preview read through `readBounded` with `TEMPLATE_MAX_BYTES` = 25 MB (`templates.service.ts:1462`, `:1481-1491`). A 30 MB overlay PDF or DOCX is accepted, saved, shown in the editor (the overlay canvas is only signed, never read), and then refused with 413 `TEMPLATE_OBJECT_TOO_LARGE` on every fill. Either lower the upload cap to the fill cap or refuse at finalize with the same message.

### 2. Abandoned direct uploads are never collected (storage leak) - OPEN
Each `-init` route opens a session under a bucket-root prefix (`template-uploads/`, `template-docx-uploads/`, `template-placement-uploads/`, `templates.routes.ts:24-29`). The matching `-finalize` deletes the object in a `finally`, but an upload whose finalize never arrives (tab closed after the PUT) stays forever: `gcSweep` only lists `lawfirmids/{firm}/templates/` and the render sweep only `template-renders/`, and nothing else in `backend/src` names these prefixes. Being outside `lawfirmids/{firm}/`, they also survive a firm deletion. Add an age-based sweep of the three prefixes to the housekeeping pass, as `cleanupExpiredUploads` does for `signing-uploads/`.

### 3. Deleting a template leaves its placement images to a sweep that defaults to dry-run (storage leak) - OPEN
`deleteTemplate` removes the source, canvas, HTML, assets and renders, but not the `placement-images/` objects its placement rows pointed at. Once the rows cascade away, only `gcSweep` can find them, and it deletes nothing unless `TEMPLATES_GC_DELETE=true` (item 9). They stay charged to the firm. List the template's placements before the row delete and remove their images there.

### 4. Fill conversion still holds the output in the API process (memory) - OPEN
Every non-native fill format goes through the buffer `convertDocument` (`templates.service.ts:1336`, `:1399`), and the result is then held again by `publishRender`'s `file.save`. The overlay upload path already converts storage to storage with `convertStoredDocument`; fill could write its filled source to a render object and convert from there.

### 5. Assets jsonb forces a full-array rewrite on every edit (perf/consistency) - STILL OPEN
Assets live entirely in the `templates.assets` jsonb column. `normalizeTemplateHtmlAssets` rebuilds the whole asset array from scratch on every save and the repo rewrites the entire jsonb value. For an image-heavy template this rewrites all N asset records on any edit, and there is no way to query/inspect assets relationally. It's a reasonable simplification at small N, but it is the standing cost of not having a relational assets table (unlike the newer `template_field_placements`, which is relational).

### 6. Asset preview URL generation is an unbatched N-call fan-out on every read (perf) - STILL OPEN
`attachAssetPreviewUrls` (`templates.service.ts:468`) calls `getSignedUrl` once per asset (bounded by `ASSET_SIGN_CONCURRENCY`, default 8) on every `getTemplate` / create / update, and `attachPlacementImagePreviewUrls` (`:1031`) does the same per image placement on every `listPlacements` / `savePlacements`. Signed-URL generation is local crypto (cheap) but the 7-day TTL means URLs are regenerated on every load rather than cached; for image-heavy templates this is wasteful. Consider caching the signed URL with the asset until near expiry.

### 7. Sibling-name uniqueness is enforced in JS, not the DB, still racy (correctness) - STILL OPEN
`createFolder` / `updateFolder` load all folders and check duplicate sibling names in JS. The supporting index `template_folders_sibling_name_idx` (`85_files.sql:17`) exists but is intentionally **non-unique** pending data de-dup, so two concurrent creates can still both pass the JS check and insert duplicate siblings. Finish the de-dup and promote the index to `UNIQUE (law_firm_id, parent_folder_id, lower(name))` so the DB enforces it atomically.

### 8. `assets` (and `previewUrl`) still accepted in write schemas but ignored (minor / misleading API) - STILL OPEN
`createTemplateSchema` / `updateTemplateSchema` still accept an `assets` array including `objectPath` and `previewUrl` (`templates.validation.ts:43`, `:54`), but the service derives assets entirely from the HTML scan (`normalizeTemplateHtmlAssets`) and never reads the request's `assets`. The schema field is dead and misleading; remove `assets` from the create/update body schemas.

### 9. The GC sweep reclaims nothing unless an env var is set (robustness) - STILL OPEN
`gcSweep` / `gcSweepLawFirm` (`templates.service.ts:1656-1770`) list objects under `lawfirmids/{firm}/templates/` (including overlay source/PDF paths and placement images) and delete those not referenced by any live row. It is scheduled by `POST /api/cron/housekeeping`, but the handler passes `dryRun: !TEMPLATES_GC_DELETE` (`templates.routes.ts:404`, `:419`), so unless `TEMPLATES_GC_DELETE=true` is set in the environment it logs orphan counts and deletes nothing. Leaked objects (`deleteTemplateAsset` still swallows delete errors) therefore accumulate in any deployment that hasn't set the flag. Confirm the sweep's dry-run counts look right in staging, then set `TEMPLATES_GC_DELETE=true` there and in production.

### 10. Document Overlay templates can't be renamed by field once placed, only replaced (usability, minor) - STILL OPEN
`savePlacements` always writes a full replacement set. There is no partial-update path for, say, renaming one field without resending every placement, which is fine for the editor's own save flow (it always has the full current layout in memory) but makes any future programmatic/bulk edit of an overlay template's fields more awkward than the DOCX path, where re-parsing on re-upload is the only mutation path anyway.

### 11. toolbar↔editor coupling is a wide implicit contract (fragility, frontend) - STILL OPEN
The HTML editor's `TemplateFormattingToolbar` is a controlled component wired by many individually-named callbacks plus a shared style-state object. The contract is large and positional-by-name: a renamed/forgotten handler is a silent no-op button (not a type error if a stray prop is optional). This is inherent to the split, not a bug, but it is a wide surface worth a small integration check (or grouping the callbacks into one `handlers` object) to make drift detectable.

### 12. pagination/footer heuristics in `templateEditorDom.ts` carry real regression risk (fragility, frontend) - STILL OPEN
The extracted footer-band/page-flow detection helpers are dense, threshold-laden DOM-measurement heuristics (font-size medians, gap ratios, `offsetHeight` reads). They depend on the exact DOM/attribute shape the HTML editor produces and read live layout, so they are sensitive to when they run (pre/post reflow). No bug observed, but this is the most fragile surface in the HTML editor and the one to cover first if templates regress (page breaks / large gaps on page 1).
