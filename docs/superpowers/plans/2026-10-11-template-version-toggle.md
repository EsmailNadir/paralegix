# Plan: three template versions behind one toggle

Branch `new-templates`, cut from `staging`. Goal: run all three template experiences in the same
Paralegix app so the team can try each and pick a winner. Nothing on `staging` is replaced.

## The three versions

| Toggle label | What it is | Where it lives today |
|---|---|---|
| **Overlay** (Paralegix simple) | Upload any document, pin field boxes on the rendered PDF, fill stamps values with pdf-lib. `type = 'overlay'` | `frontend/src/components/templatesComp/TemplateOverlayEditor.tsx`, `backend/src/modules/templates/overlayFill.service.ts` |
| **Full editor** (Paralegix complex) | WYSIWYG HTML editor, plus DOCX merge fields through docxtemplater. `type = 'html' \| 'docx'` | `frontend/src/components/templatesComp/TemplateEditor.tsx`, `backend/src/modules/templates/docx.service.ts` |
| **Word-first** (JJ Portal) | Upload a .docx or fillable PDF, the scan proposes the blanks, you review and name them, the original file is kept byte-for-byte and filled in place. Matter autofill from one shared vocabulary | JJ `PORTAL-packet` at `70110b1` (`src/lib/templates/**`, `src/components/templates/**`, `src/app/(app)/templates/**`) |

Today both Paralegix versions share one page with no switch: an upload always starts as Overlay,
with a one-way "Use the full editor instead" exit (`templates/page.tsx:214`). The user guide
already calls them "Two Ways to Build a Template" (`docs/templates/overview.md:15`).

Out of scope from JJ, by request: case packets (`/templates/packets`, `src/lib/templates/packet/`),
the matter Documents tab, `generated_documents`, matter-create wiring. The library code never
imports packets (the dependency runs the other way), so the cut is clean.

## Decisions (confirmed 2026-10-11)

The user asked for JJ Portal's EXACT templates tab plus the two Paralegix versions, three
separate versions behind one toggle.

1. **Toggle is per user**, `users.preferences.templateVersion` =
   `'overlay' | 'full-editor' | 'word-first'`, default `'overlay'` (today's behaviour). The
   preferences schema is `.passthrough()` (`settings.validation.ts:75-114`). *Falsifier: the team
   wants to test one version at a time as a group, then it moves to firm settings.*
2. **Word-first gets its own table, `word_templates`.** The two Paralegix versions keep using
   `templates` untouched, so the experiment cannot damage existing templates, the JJ library
   behaves exactly as in JJ (it only ever lists its own html/docx/pdf-form rows), and dropping
   the losing version later is one contract migration. *Falsifier: the team wants to fill the
   same template through two versions, then share `templates` instead.*
3. **JJ's own editor is ported too** (`TemplateEditor.tsx`, 8,698 lines, plus
   `PlaceholderModal`, `TemplateImageCropModal`, `DocxTemplatePreview`, the browser libs
   `pdf-to-html`, `template-reflow`, `template-fill`, `chipify-placeholders`,
   `template-image-objects`, `template-preview`, `placeholders`).
4. **Infrastructure swaps, behaviour kept:** R2 becomes GCS through the existing direct-upload
   init/finalize helpers; Gotenberg becomes Paralegix's LibreOffice conversion
   (`backend/src/shared/documentConversion`); puppeteer HTML-to-PDF becomes the document
   worker's existing Chromium export; server actions become Express routes; Supabase RLS becomes
   `requirePermission` + audited Drizzle tenant contexts. OnlyOffice is not ported: JJ already
   falls back to its own editor when OnlyOffice is not configured, which is exactly what runs here.
5. **Worktree** `~/paralegix-new-templates`, branch `new-templates` (no upstream;
   it must never push to `staging` by accident).
6. Folders: JJ removed them from its screens. The folder actions behind the shim are not ported;
   `word_templates` has no `folder_id`.

## API contract (backend and frontend build against this)

Mounted at `/api/lawfirms/:lawFirmId/word-templates`, behind `verifyToken` and
`requireFeature('templates')`. Reads need `templates.view`; writes need `templates.manage`.
The leftover client-text guard additionally needs `clients.view` and `matters.view`, as in JJ.
JSON responses use the repo's usual `{ success, data }` envelope; binary responses send the file
with `Content-Disposition` and, for fills, an `X-Unfilled-Fields` header in JJ's wire format
(`unfilled-fields.ts`), exposed through CORS.

| Method | Path | Replaces JJ | Notes |
|---|---|---|---|
| GET | `/` | `fetchTemplates` | Library rows (JJ `Template` shape) |
| GET | `/:id` | `editorLoadTemplate` | Adds `html` (from GCS), `assets` with signed `previewUrl` |
| POST | `/` | `editorSaveTemplate` (create) | `{ name, html }`; fields/repeaters re-extracted server-side |
| PUT | `/:id` | `editorSaveTemplate` (update) | Refused by `htmlWriteRejection` for docx/pdf-form |
| PATCH | `/:id` | `renameTemplate` | `{ name }` |
| DELETE | `/:id` | `deleteTemplate` | Row plus objects |
| POST | `/upload-init` | (R2 put) | `{ fileName, contentType, size, purpose: 'source' \| 'asset' \| 'convert' }` opens a direct upload for `.docx`/`.pdf` (images for assets) |
| POST | `/detect` | `detectDocxBrackets` / `detectPdfFormFields` | `{ objectPath, fileName }`; stores nothing |
| POST | `/commit` | `commitDocxBrackets` / `commitPdfFormTemplate` | `{ objectPath, fileName, name, edits, duplicateStrategy?, acknowledgedLeftovers? }` returns `{ templateId }` or `{ duplicate }`; leftovers refusal is a 409 carrying `{ leftovers, clientTextRefused: true }` |
| POST | `/upload-docx` | `uploadDocxTemplate` | No-review path used by JJ's editor |
| POST | `/:id/replace-source` | `replaceTemplateDocx` | `{ objectPath, fileName, acknowledgedLeftovers? }` |
| GET | `/:id/fields` | `fetchTemplateFillFields` | Live re-parse of the stored .docx |
| POST | `/:id/fill-docx` | `api/templates/[id]/fill-docx` | `{ values, repeaterValues, fileName, format: 'docx' \| 'pdf' }` binary |
| POST | `/:id/fill-pdf` | `api/templates/[id]/fill-pdf` | `{ values, fileName }` binary |
| GET | `/:id/preview-pdf` | `api/templates/[id]/preview-pdf` | docx only, via LibreOffice |
| GET | `/:id/docx-source` | `api/templates/[id]/docx-source` | the stored file |
| POST | `/convert-docx-to-pdf` | `api/templates/convert-docx-to-pdf` | `{ objectPath }` of a settled `convert` upload |
| POST | `/export` | `api/templates/export` | `{ html, format: 'pdf' \| 'docx' \| 'txt' }`, 2 MB cap |
| POST | `/:id/assets/finalize` | editor image upload | settles an `asset` upload into `assets` |
| GET | `/document-context?matterId=&clientId=` | `fetchCaseDocumentContext` | `{ values, repeaterValues, billingIncomplete }`; caller must be able to see the matter |

### Backend deviations from the table above (as implemented; build against THIS)

The repo has no `{ success, data }` envelope: every module answers with a domain-named key, and
errors use the central `{ error, code, details?, requestId }` envelope. So:

| Endpoint | Success body |
|---|---|
| `GET /` | `{ templates: WordTemplate[] }`, ordered by name. `WordTemplate` = `{ id, name, type, fields, repeaters, folderId: null, originalFileName, createdAt, updatedAt }` (no html) |
| `GET /:id` | `{ template }`: `WordTemplate` plus `html` (string for html rows, else null), `docxStoragePath` (truthy for docx/pdf-form), `assets: [{ id, objectPath, mimeType, fileName, previewUrl }]` |
| `POST /` | 201 `{ message, templateId, template }` (template as `GET /:id`). Optional body `id` is NOT accepted: create always mints the id |
| `PUT /:id` | `{ message, template }`. Body `{ name, html }` |
| `PATCH /:id` | `{ message, template }` (list shape) |
| `DELETE /:id` | `{ message, templateId }` |
| `POST /upload-init` | `{ uploadUrl, objectPath, contentType }`. The browser PUTs the file to `uploadUrl`, then passes `objectPath` + `fileName` to the next call. Limits: source/convert 50 MB (`.docx` or `.pdf`; convert is `.docx` only), asset 10 MB PNG/JPEG/WEBP/GIF. `purpose: 'asset'` also needs `templateId` |
| `POST /detect` | `{ proposals }` (JJ `TemplateFieldProposal[]`). A `.pdf` fileName routes to the PDF-form scan |
| `POST /commit`, `POST /upload-docx` | 201 `{ message, templateId, template }`; with `duplicateStrategy: 'replace'` 200 `{ message, templateId, template }` |
| `POST /:id/replace-source` | `{ message, templateId, template }`. Accepts `.pdf` for a pdf-form row too (JJ had no way to replace a PDF form) |
| `GET /:id/fields` | `{ fillFields: { fields, repeaters } \| null }` (null when not docx or unreadable, as JJ) |
| `POST /:id/assets/finalize` | 201 `{ message, assetId, asset: { id, objectPath, mimeType, fileName, previewUrl } }`. Body `{ objectPath, fileName }`. Put `data-template-asset-id="{assetId}"` on the img; a later `PUT` drops assets the html no longer references |
| `POST /convert-docx-to-pdf` | binary PDF. Body `{ objectPath, fileName }` |
| `GET /document-context` | `{ context: { values, repeaterValues, billingIncomplete } }`. `matterId` and/or `clientId` (at least one) |

Refusals JJ returned as `{ ok: false, error }` are HTTP errors whose `error` is JJ's exact string:

| Case | Status | `code` | `details` |
|---|---|---|---|
| Same-name template (commit, upload-docx) | 409 | `TEMPLATE_DUPLICATE` | `{ duplicate: { id, name } }` |
| Client details would stay | 409 | `TEMPLATE_CLIENT_TEXT` | `{ leftovers, clientTextRefused: true }` |
| Caller lacks `clients.view` or `matters.view` for the guard | 403 | `TEMPLATE_CLIENT_TEXT_UNCHECKABLE` | `{ clientTextRefused: true }` |
| Guard could not read firm records / document too large to check | 503 / 400 | `TEMPLATE_CLIENT_TEXT_CHECK_FAILED` | `{ clientTextRefused: true }` |
| `htmlWriteRejection` on `PUT` | 400 | `TEMPLATE_HTML_WRITE_REJECTED` | none |
| Every other JJ validation string | 400 | `VALIDATION_ERROR` | none |

Other deviations: same-name detection is case-insensitive and firm-scoped, backed by a partial
unique index on `(law_firm_id, type, lower(name))` for docx and pdf-form rows, and
`upload-docx` now runs the same duplicate check (JJ had none). `export` caps the body at 2 MB,
but `format: 'pdf'` is further capped at 1 MB by the document worker (413 either way). PDF-form
uploads now run the leftover client-text guard too, on the PDF's field values. `export` also
accepts an optional `templateId`, which lends a PDF render that template's own stored images
(nothing else the html points at is fetched). `document-context` reads each billing section only
for a caller holding its permission (`billing.viewInvoices`, `billing.viewTimeEntries`,
`billing.viewExpenses`, `billing.viewPlans`, `billing.viewRates`, `trust.view`), always returns
`billingIncomplete` as a boolean, and prints dates in the firm's `settings.timezone` (the
caller's `X-Timezone` when the firm has none).

Pickers (matters, clients, tasks), "Save to Files" and firm info use the EXISTING Paralegix
frontend services (`matters.service.ts`, `clients.service.ts`, `tasks.service.ts`,
`files.service.ts`, firm settings), not new routes.

## Phases

### Phase 0: setup (30 min)
- Worktree on `new-templates` from `origin/staging`.
- Copy the JJ source slice from `PORTAL-packet` (`70110b1`, which has the redesigned library;
  the local JJ `staging` is 29 commits stale) into a scratch reference folder, not into the repo.

### Phase 1: the toggle shell (half a day, green tier)
- `templateVersion` user preference: frontend type in `types/preferences.ts`, a setter in
  `PreferencesContext.tsx`, default `'overlay'` (today's behaviour).
- A segmented control in the Templates page header: Overlay / Full editor / Word-first.
  Built from an existing `src/components/ui/` primitive per the `paralegix-frontend` skill.
- Split today's page so **Overlay** keeps upload-to-overlay, and **Full editor** sends New
  straight to `TemplateEditor` (HTML or DOCX) with no overlay step.
- **Word-first** shows a placeholder until Phase 4.
- Tests: preference round-trip; each toggle value routes New to the right flow.

### Phase 2: port JJ's pure library to the backend (1 day, green tier)
Into `backend/src/modules/templates/wordFirst/`, verbatim apart from imports (about 7,100 lines):
`auto-bracket/*` (10 files), `vocabulary`, `placeholderize-core`, `fill-values`, `fill-engine`,
`docx` (merged with the existing zip guards in `docx.service.ts`), `unfilled-fields`,
`import-guards`, `pdf-form` + the Liberation Sans font, `duplicates`, plus the pure first ~750
lines of `case-autofill` (formatters and assembly). All dependencies already exist in the
backend (`docxtemplater`, `pizzip`, `pdf-lib`, `@pdf-lib/fontkit`).
- Tests: port JJ's ~25 pure vitest files to Jest (about 380 cases) and the 7 `.docx` fixtures.
  These are what prove the port is faithful.

### Phase 3: backend routes, schema, autofill (1.5 to 2 days, red tier: migration)
- Migration (expand): widen `templates.type` check to add `'pdf-form'`; add
  `original_file_name text check (length <= 255)`; add `unique (law_firm_id, id)`. Then the
  domain file, `db:schema:build`, `db:catalog-parity`, `db:pull`, `db:drift`.
- Routes under `/api/lawfirms/:lawFirmId/templates` (spec table 1.14 of
  `docs/features/handoff-templates-and-payment-intake.md`): `POST /detect`, `POST /commit`,
  `POST /:id/replace-source`, `GET /:id/fields`, `pdf-form` added to the existing `POST /:id/fill`
  plus an `unfilledFields[]` list in its response. Matter context:
  `GET /matters/:matterId/document-context`.
- Re-express JJ's reads against Paralegix tables, every one firm-scoped through the audited
  Drizzle contexts: firm known values (law_firms, clients, matters) and matter autofill (matters,
  clients, events, courts, invoices, `invoice_expected_payments`, payments, `activities` in place
  of time entries / flat fees / expenses, trust balances). The billing mapping is the riskiest
  piece and gets its own tests.
- Firm timezone instead of JJ's hard-coded `America/New_York`.
- Tests: route tests per endpoint, including a cross-firm test that firm B's client names never
  appear in firm A's scan or leftover check.
- Apply the migration to local, then to staging before any push that needs it.

### Phase 4: Word-first UI (2 days, green tier)
In `frontend/src/components/templatesComp/wordFirst/`, rebuilt with Paralegix primitives and
tokens (the JJ library was already restyled to the Paralegix design system in JJ commit `f50934a`):
- Library: search by field label, Recent/A-Z, grid/list, auto-fill ring, field-group strips,
  same-name stacks (`TemplateList`, `template-card-parts`, `template-field-summary`,
  `template-library`).
- New-template chooser, then `AutoBracketReview` + `LeftoverClientText`, then the same-name
  chooser (Replace / Save as a copy / Cancel).
- Detail view: placeholders, source document, Re-upload, Delete.
- `FillTemplateModal` (Word-first): matter/client autofill, Needs-input panel, blank warning,
  Download DOCX/PDF, Save to Files through the existing Paralegix save flow.
- Tests: frontend unit tests for the pure helpers; one end-to-end pass upload, review, save,
  fill.

### Phase 5: verify and hand over (half a day)
- Backend `typecheck`, `lint`, guards, the new and touched Jest suites; frontend `ci:checks`,
  `test:unit`, `build`.
- Seed one template of each version in the demo firm so all three show up on first open.
- Code review pass, then stop before merge (red tier).

## Size

About 7,100 lines ported verbatim (pure), about 400 lines of reads re-expressed, about 4,000
lines of UI rebuilt, plus ~400 ported tests and new route tests. 5 to 6 working days end to end.

## What would change this plan

- If the team wants to compare versions one at a time as a group, the toggle moves to firm
  settings (decision 1).
- If JJ's positional HTML editor is itself one of the things being evaluated, decision 3 flips
  and Phase 4 grows by about 2 days.
- If the billing reads in Phase 3 don't map cleanly to Paralegix tables, autofill ships with
  billing fields off first, and billing follows as a separate step.
