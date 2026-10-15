# Reference Data (Catalogs, Courts, Practice Areas, Note Types, Note Templates, Deadline Sets)

The small lists that other records point at: the platform-wide court and UTBMS catalogs, and the per-firm courts, practice areas, note types, note templates and deadline-set templates. Charge codes and expense categories are also reference data, but they are covered in [Billing](billing.md); only their catalog adoption path is described here.

## Summary

Paralegix has two tiers of reference data. The **platform tier** is two global, read-only tables (`court_catalog`, `utbms_codes`) that no request path writes. They are loaded by seed scripts and shared by every firm. The **firm tier** is a set of tenant-scoped tables that each firm edits from **Settings → Matter Config** or from the note composer. A firm pulls entries from the platform tier with **copy-on-adopt**: the catalog row is copied into the firm's own table, with a provenance link back to the catalog, and the copy can then be edited freely. Matters, tasks, calendar events, contacts, leads and notes all consume the firm-tier lists.

## Key Takeaways

- **Courts and practice areas share one implementation.** Both modules are three-line wrappers around `createLookupRepository` and `createLookupService` (`shared/lookup/`). A fix to list ordering, create, update or delete applies to both.
- **Deleting a court or practice area never blocks.** There is no "in use" check. The database decides what happens: most references are set to `NULL`, but `matter_field_defs` **cascades**, so deleting a practice area silently deletes that practice area's custom field definitions (`backend/db/schema/30_matters.sql:161`).
- **The catalog is global and written only by scripts.** `court_catalog` and `utbms_codes` have no `law_firm_id` and are read through `systemQuery`. Adoption copies rows into `courts` or `billing_codes`, and adoption is idempotent per catalog link.
- **Note types and note templates are append-only.** Their APIs have list and create (plus recolor for note types). There is no update or delete route and no settings screen. They are managed only from the note composer's quick-add.
- **Built-in note types and templates live in frontend code.** The DB holds only firm additions and color overrides. A `note_types` row whose `value` matches a built-in slug exists only to carry a color.
- **Court reads need `courts.manage`.** `GET /courts` is gated by the manage code, not a view code, and the built-in Staff role does not hold it (`permissions.ts:247-262`).
- **Courts are deliberately not seeded.** New firms get ten practice areas and ten charge codes. Expense categories are seeded lazily on first list. Courts start empty and come from the catalog (`shared/referenceData/defaults.ts:8-11`).

---

## How It Works

### Entry Points

All routers are mounted under the firm scope in `backend/src/app.ts`, so `requirePermission` resolves the caller's membership in `:lawFirmId` before any handler runs (`lawfirms/roles/requirePermission.ts:80-105`).

| Mount (`app.ts`) | Module | Read guard | Write guard |
|---|---|---|---|
| `/catalog` (`:913`) | `modules/catalog/` | `courts.manage` (courts), `billing.viewRates` (UTBMS) | `courts.manage`, `billing.manageRates` |
| `/courts` (`:912`) | `modules/courts/` | `courts.manage` | `courts.manage` |
| `/practice-areas` (`:901`) | `modules/practiceAreas/` | `practiceAreas.view` | `practiceAreas.manage` |
| `/note-types` (`:902`) | `modules/noteTypes/` | `noteTypes.view` | `noteTypes.manage` |
| `/note-templates` (`:903`) | `modules/noteTemplates/` | `noteTemplates.view` | `noteTemplates.manage` |
| `/deadline-sets` (`:861`) | `modules/matters/deadlineSets/` | `matters.view` | `settings.manageFirm` |

Who holds these codes (`backend/src/modules/lawfirms/roles/permissions.ts`): `practiceAreas.view`, `noteTypes.view`, `noteTemplates.view`, `billing.viewRates` and `matters.view` are in the always-granted baseline `DEFAULT_PERMISSIONS` (`:147-171`). `courts.manage`, `noteTypes.manage` and `noteTemplates.manage` are granted to Attorney (`:211-213`) and Paralegal (`:240-242`). `practiceAreas.manage`, `billing.manageRates` and `settings.manageFirm` are held only by Owner and Admin, which receive `ALL_PERMISSIONS` (`:178-187`). See [RBAC permissions](/dev/security/rbac-permissions) for how the baseline and plan ceiling work.

Frontend settings live in one tabbed shell, `settings/matter-config/page.tsx`. Its tab list (`:29-38`) embeds `PracticeAreasPage`, `CourtsPage` and `DeadlineSetsPage` as sub-tabs (`:63-71`). The same pages are also reachable directly at `settings/practice-area`, `settings/courts` and `settings/deadline-sets`.

### Data Flow: adopt a court from the directory

1. **UI.** The Courts sub-tab renders `CourtCatalogPickerModal` (`settings/courts/page.tsx:500`). The picker calls `catalogService.searchCourts(lawFirmId, { search, limit: 50 })` (`components/courtsComp/CourtCatalogPickerModal.tsx:27`), which issues `GET .../catalog/courts` (`services/catalog.service.ts:51-63`).
2. **Route.** `verifyToken` → `requirePermission('courts.manage')` → `validate(searchCourtsSchema)` (`catalog/catalog.routes.ts:20-24`). The schema caps `limit` at 200 and `state` at two characters (`catalog.validation.ts:5-15`).
3. **Service.** `searchCourts` asserts firm membership and delegates (`catalog.service.ts:28-31`).
4. **Repository.** `searchCourts` ORs `websearch_to_tsquery` with a prefix `to_tsquery` over the generated `search` column (`catalog.repository.ts:44-55`), then pages through `resolvePage` (`:60`). Each row carries `alreadyAdded`, an `EXISTS` against the caller's `courts`. It is written table-qualified on purpose: an unqualified column once made the subquery uncorrelated and the flag was false everywhere (`:66-79`). Reads run through `systemQuery('catalog', ...)` because the table has no tenant column (`:63`).
5. **Adopt.** The picker posts the selected ids (`CourtCatalogPickerModal.tsx:32`) to `POST .../catalog/courts/adopt` (`catalog.routes.ts:37-46`). `adoptCourts` (`catalog.service.ts:41-72`) loads the catalog rows, loads the firm's already-adopted catalog ids, reads the current max `sort_order`, then creates one `courts` row per new entry with `name = fullName` and `abbreviation = citationAbbrev || shortName`, linked by `catalog_court_id`.
6. **Response.** `{ message, requested, adopted, skipped }` with HTTP 201. The picker's `onAdopted` reloads the list.

### Data Model

| Table | Tier | Key columns | Defined at |
|---|---|---|---|
| `court_catalog` | platform | `source` + `source_id` unique, `full_name`, `short_name`, `citation_abbrev`, `jurisdiction`, `court_type`, `state`, `in_use`, generated `search` tsvector (GIN) | `db/schema/15_catalogs.sql:8-29` |
| `utbms_codes` | platform | `code` unique, `name`, `code_type` (`task`/`activity`/`expense`), `practice_set`, `is_active` | `15_catalogs.sql:31-40` |
| `practice_areas` | firm | `name`, `sort_order`, `created_by` | `15_catalogs.sql:46-56` |
| `courts` | firm | `name`, `abbreviation`, `city`, `state`, `address`, `court_type`, `sort_order`, `catalog_court_id` (FK to catalog, set null) | `15_catalogs.sql:58-78` |
| `note_types` | firm | `value` (slug, unique per firm), `label`, `color` | `db/schema/50_notes.sql:1-12` |
| `note_templates` | firm | `label`, `note_type` (default `general`), `subject`, `content_html` | `50_notes.sql:14-25` |
| `deadline_set_templates` | firm | `name`, `description`, `adjust_for_weekends`, `items` jsonb | `db/schema/60_calendar.sql:308-320` |
| `billing_codes` | firm | `kind` (`charge`/`expense`), `code` unique per `(law_firm_id, kind)`, `utbms_code_id` (FK to catalog, set null) | `db/schema/70_billing.sql:10-39` |

Every firm table has `law_firm_id ... on delete cascade` and `unique (law_firm_id, id)`, so deleting a firm removes its reference data. No firm table has a uniqueness constraint on `name` or `label`. Tests pin this for courts (`tests/courts/courts.test.ts:144`), practice areas (`tests/practiceAreas/practiceAreas.test.ts:106`) and templates (`tests/noteTemplates/noteTemplates.test.ts:180`).

### Key Logic & Rules

**What happens when an in-use row is deleted.** Neither the lookup service nor the UI checks for references. `delete` confirms the row exists in the firm and then runs a tenant-scoped delete (`shared/lookup/lookupService.ts:76-80`, `shared/database/DrizzleRepository.ts:145-148`). The settings pages show only a generic "cannot be undone" confirm (`settings/courts/page.tsx:489-494`, `settings/practice-area/page.tsx:271-276`). The practice-area page carries a TODO to block deletes of linked rows (`settings/practice-area/page.tsx:18`). The foreign keys decide the outcome:

| Referencing column | On delete | Where |
|---|---|---|
| `matters.practice_area_id`, `matters.court_id` | set null | `30_matters.sql:102-103` |
| `tasks.practice_area_id`, `tasks.court_id` | set null | `40_tasks.sql:41-42` |
| `events.court_id` | set null | `60_calendar.sql:224` |
| `contacts.court_id` | set null | `20_parties.sql:132` |
| `matter_stage_pipelines.practice_area_id` | set null | `30_matters.sql:24` |
| `lead_stages.practice_area_id`, `intake_form_templates.practice_area_id` | set null | `30_matters.sql:220,282` |
| `matter_field_defs.practice_area_id` | **cascade** | `30_matters.sql:161` |
| `courts.catalog_court_id`, `billing_codes.utbms_code_id` | set null (catalog side) | `15_catalogs.sql:71`, `70_billing.sql:27` |

The `set null` references into `courts` and `practice_areas` are single-column FKs, not composite tenant FKs. A composite `on delete set null` would also null `law_firm_id`, which is `not null` (`60_calendar.sql:218-223`, `30_matters.sql:256-266`). Tenant agreement is therefore enforced by the application. On the reverse FK side, partial indexes keep the delete's reference probe cheap (`40_tasks.sql:46-50`, `95_deferred_fks.sql:50-58`).

**Tenant validation on write.** Consumers validate a supplied court or practice area against the firm through `mattersRepo.validatePracticeArea` / `validateCourt` (`matters/matters.repository.ts:2056-2070`). Matter create quietly coerces an unknown id to `null` (`matters.service.ts:330-340`). Matter update (`:630-643`), tasks (`tasks/tasks.service.ts:33-43`), client events (`clients/clientEvents.service.ts:91`) and leads (`leads/leads.service.ts:235`) reject it. Contacts use their own `assertCourtInFirm` (`contacts/contacts.service.ts:44`).

### Dependencies

- `shared/lookup/` (courts, practice areas), `DrizzleRepository` (note types, note templates, deadline sets), `tenantQuery` / `systemQuery` / `scopedUpsert` (`shared/database/`).
- `lawfirms.service` seeds defaults at firm creation. `billing/chargeCodes` and `billing/expenseCategories` repositories are the adoption targets for UTBMS.
- `matters/matterEvents.service` and the event bus are used by deadline-set apply.
- `COURTLISTENER_TOKEN` (optional) and `DATABASE_URL` are read only by the seed scripts, not by the running app ([environment variables](/dev/ops/environment-variables)).

### Example

```http
POST /api/lawfirms/3f.../catalog/courts/adopt
{ "catalogCourtIds": ["a1...", "b2..."] }

201
{ "message": "Adopted 1 court from the catalog", "requested": 2, "adopted": 1, "skipped": 1 }
```

The second id was skipped because the firm already had a `courts` row with that `catalog_court_id` (`catalog.service.ts:52`). An id not in the catalog is neither adopted nor counted as skipped, because only rows found by `getCourtsByIds` enter the loop (`catalog.service.ts:45,51`, `tests/catalog/catalogAdopt.test.ts:304`).

---

## Global Catalog (`modules/catalog/`)

**Who edits it:** nobody at runtime. The schema header says the tables are written only by the import scripts (`15_catalogs.sql:1-6`).

- `db/seed/import-courts.ts` pulls the US courts directory from the CourtListener v4 API, maps jurisdiction codes to `jurisdiction`/`court_type` (`:24-45`), and upserts on `(source, source_id)`, so re-running refreshes (`:1-15`, `:95-115`).
- `db/seed/import-utbms.ts` upserts `db/seed/utbms-codes.json` on `code` (`:1-9`).

**Routes** (`catalog.routes.ts`): `GET /courts` (`:20`), `POST /courts/adopt` (`:37`), `GET /utbms?codeType&practiceSet` (`:49`, active codes only, `catalog.repository.ts:110`), `POST /charge-codes/adopt` (`:62`), `POST /expense-categories/adopt` (`:74`). Adopt bodies accept 1 to 500 uuids (`catalog.validation.ts:25-37`).

**UTBMS adoption** (`catalog.service.ts:78-120`) filters the requested rows to the right `code_type` (`task` for charge codes, `expense` for categories). It skips a row whose `utbms_code_id` is already linked **or** whose upper-cased code text already exists in the firm's `billing_codes` of that `kind` (`catalog.repository.ts:145-177`). It also adds each new code to the in-memory set so two catalog rows that normalize to one code adopt once (`catalog.service.ts:110`). Since charge codes and expense categories share `billing_codes`, the historical table name is mapped to a `kind` predicate (`catalog.repository.ts:25-36`).

**Frontend:** `services/catalog.service.ts`; `CourtCatalogPickerModal` and `CourtNameAutocomplete` (catalog typeahead in the court form, `CourtNameAutocomplete.tsx:59`); `billingComp/UtbmsPickerModal.tsx`, rendered from the Charge Codes page with `codeType="task"` (`settings/charge-codes/page.tsx:539-545`).

**Tests:** `tests/catalog/catalogAdopt.test.ts` covers search, cross-firm `alreadyAdded` scoping (`:175`), idempotent adopt (`:281`, `:468`), wrong-kind rejection (`:456`, `:572`) and permission refusals. `tests/smallModules/smallModules.test.ts:37` smoke-tests the catalog routes.

## Courts (`modules/courts/`)

**Who edits it:** the firm, from Settings → Matter Config → Courts, or inline from the court fields on matter and task forms (`MatterCourtField.tsx`, `TaskCourtField.tsx`).

**Routes** (`courts.routes.ts:15-65`): `POST /`, `GET /`, `GET /:courtId`, `PUT /:courtId`, `DELETE /:courtId`, all behind `courts.manage`. Writable fields are `name`, `abbreviation`, `city`, `state`, `address`, `courtType` (`courts.service.ts:22`, `courts.validation.ts:3-23`). `catalog_court_id` is set only by adoption.

**Behavior** (from `lookupService.ts`): create stores omitted fields as `null` and returns only `{ message, courtId }` (`:42-49`). List returns `{ courts, totalItems }` ordered by `sort_order`, then `name` (`lookupRepository.ts:27-41`). Get returns the bare row, not an envelope (`lookupService.ts:56-60`). Update checks existence first so a missing id returns 404, and still returns the vestigial `mattersUpdated: 0` (`:62-74`).

**Consumed by:** matters (`matters.court_id`), tasks, calendar events, contacts (judges and clerks). Frontend readers go through `hooks/courtHooks/useCourts.ts` (query key `['courts', lawFirmId]`, create and update only). Its callers include `CreateMatterModal.tsx:107`, `EditMatterModal.tsx:77`, `TasksGrid.tsx:144`, `Calendar.tsx:123`, `MatterEventsTab.tsx:1090`, `ClientEventsTab.tsx:65` and `ClientDetail.tsx:223`. The Courts settings page also groups contacts by court with one `hasCourt: true` read capped at 500 (`settings/courts/page.tsx:37-60`).

**Tests:** `tests/courts/courts.test.ts` (tenancy, delete unlinks a matter `:333`, read gated by manage `:238`), `tests/courts/courtsServiceOps.test.ts`, `tests/live/courts/courts.test.ts`, `tests/schema/clientEventCourt.test.ts:89` (event reference nulled on delete), `tests/tasks/taskReferenceTenancy.test.ts:47`.

## Practice Areas (`modules/practiceAreas/`)

**Who edits it:** the firm (Owner and Admin by default), from Settings → Matter Config → Practice Areas. `createPracticeArea` is also exposed from `usePracticeAreas` for inline creation in `CreateMatterModal.tsx:106`, `EditMatterModal.tsx:76` and `ConvertLeadModal.tsx:38`.

**Routes** (`practiceAreas.routes.ts:15-65`): the same five as courts. Reads use `practiceAreas.view`, writes use `practiceAreas.manage`. The only field is `name`, and it is required on update as well as create (`practiceAreas.validation.ts:3-13`).

**Consumed by:** matters (drives which stage pipeline and custom fields apply, see [Matters](matters.md#matter-stages-branching-pipeline) and [custom fields](matters.md#matter-custom-fields)), tasks, lead stages and intake forms ([Leads](leads.md)), and the files page filter (`files/page.tsx:805`). Frontend readers use `hooks/practiceHooks/usePracticeAreas.ts` (query key `['practiceAreas', lawFirmId]`), including `MattersGrid.tsx:128`, `MatterStagesSettings.tsx:47`, `MatterFieldsSettings.tsx:42`, `LeadStagesSettings.tsx:29` and `usePipelineBuilder.ts:32`.

**Tests:** `tests/practiceAreas/practiceAreas.test.ts` (rename keeps matters linked `:237`, delete unlinks a matter `:301`, empty-role read `:202`), `practiceAreasServiceOps.test.ts`, `tests/live/practiceAreas/practiceAreas.test.ts`, and the tenancy matrix `tests/tenancy/tenancy.test.ts:93`.

## Note Types (`modules/noteTypes/`)

**Who edits it:** any member with `noteTypes.manage`, from the note composer's "Note Type" quick-add and color picker (`notesComp/NotesSection.tsx:767-786`). No settings page exists.

**Routes** (`noteTypes.routes.ts`): `GET /` (`:12`), `POST /` with `{ label }` up to 50 characters (`:19`), and `PATCH /:value/color` with a `StatusVariant` enum color (`:31`, `noteTypes.validation.ts:11-19`).

**Logic** (`noteTypes.service.ts`):
- The eight built-in slugs are hard-coded to mirror the frontend's `NOTE_TYPE_META` (`:4-20`, frontend `constants/statusMeta.ts:332-341`).
- Create never fails on a collision. A label matching a built-in or an existing custom label (case-insensitive) returns the existing type (`:50-61`). Otherwise the label is slugified and suffixed `-2`, `-3` until free of built-ins and firm values (`:22-35`, `:63-64`).
- Recoloring a built-in upserts a row keyed on `(law_firm_id, value)` using the built-in label (`:87-91`, `noteTypes.repository.ts:37-51`). Recoloring an unknown custom slug returns 404 (`:93-95`).

**Consumed by:** note rows on matters, tasks and clients. `note_type` there is free text (`50_notes.sql:77`) and is not validated against `note_types`. Matter notes cap it at 50 characters (`matters/notes/matterNotes.validation.ts:45`), and the shared notes engine defaults it to `general` (`shared/notes/notesEngine.ts:289`). The composer merges built-ins first, then custom rows that are not built-in color overrides (`NotesSection.tsx:286-302`). `useNoteTypes` derives a `value → color` map from every row with a color (`hooks/notesHooks/useNoteTypes.ts:39-43`).

**Tests:** `tests/noteTypes/noteTypes.test.ts` (slug collisions `:110-134`, built-in override `:254-266`, cross-firm recolor `:309`).

## Note Templates (`modules/noteTemplates/`)

**Who edits it:** any member with `noteTemplates.manage`, through "Save as Template" in the composer, which captures the current draft's type, subject and body (`NotesSection.tsx:748-763`).

**Routes** (`noteTemplates.routes.ts`): `GET /` and `POST /` only. The body is `label` (up to 100 characters), optional `noteType`, `subject` and `contentHtml` (up to 50,000 characters) (`noteTemplates.validation.ts:3-10`). The service trims the label, defaults the other fields, and runs `contentHtml` through `sanitizeRichText` (`noteTemplates.service.ts:7-17`).

**Consumed by:** the composer's template dropdown, which lists the ten static `NOTE_TEMPLATES` (`config/noteTemplates.ts:10`) followed by firm templates (`NotesSection.tsx:308-314`). Applying a template is client-side: it copies subject, HTML and type into the draft (`:334-340`).

**Tests:** `tests/noteTemplates/noteTemplates.test.ts` (sanitization `:122-151`, size ceiling `:167`, tenancy).

## Deadline Sets (`modules/matters/deadlineSets/`)

Templates that turn one trigger date into a cascade of matter events. Routes, date math and the apply flow are documented in [Matters: Deadline Sets](matters.md#deadline-sets). Firm-tier facts for this page:

- **Who edits it:** `settings.manageFirm` (Owner and Admin) from Settings → Matter Config → Deadline Sets (`settings/deadline-sets/page.tsx:25`). Anyone with `matters.view` can list them to apply one.
- **Stored shape:** each `items[]` entry is `{ title, type, offsetDays, offsetDirection, relativeTo, clientVisible, notes }`, 1 to 50 items (`deadlineSets.validation.ts:7-26`). `relativeTo: 'previous'` chains an item off the date computed for the item before it, and it is forced back to `trigger` for the first item (`deadlineSets.service.ts:37-47`, `:157-163`).
- **Apply is now transactional.** All events are written inside one `withDrizzleTransaction`, and `MATTER_EVENT_CREATED` is emitted only after commit (`deadlineSets.service.ts:123-194`). `matters.md` still describes it as a non-transactional loop (`matters.md:320,365`).
- **Delete:** nothing references a template, so delete is a plain tenant-scoped delete (`deadlineSets.service.ts:115-121`). Events already created stay, and the confirm dialog says so (`settings/deadline-sets/page.tsx:215-220`).
- **Tests:** `tests/matters/deadlineSets.test.ts` (chaining `:307`, weekend roll `:327`, rollback on partial failure `:448`, permissions `:518`).

## Default Seeding (`shared/referenceData/defaults.ts`)

| List | Seeded when | Source |
|---|---|---|
| Ten practice areas | Firm creation, in parallel with roles and lead pipeline | `defaults.ts:13-17`, `lawfirms/lawfirms.service.ts:90-98` |
| Ten charge codes | Firm creation | `defaults.ts:19-30`, `lawfirms.service.ts:94-95` |
| Lead pipeline, intake form | Firm creation | `defaults.ts:40-62`, see [Leads](leads.md) |
| Eight expense categories | Lazily, the first time the list is read and empty | `defaults.ts:64-73`, `billing/expenseCategories/expenseCategories.service.ts:32-39` |
| Courts, note types, note templates, deadline sets | Never | `defaults.ts:8-11` |

`db/seed/bootstrap-demo-firm.ts` creates its firm through the real `createLawFirm`, so it gets the same defaults (`:15-20`). `db/seed/seed-local-testdata.ts` adds practice areas matched case-insensitively by name, because the table has no unique name constraint (`:210-234`).

---

## What Can Be Improved

1. **Deleting a practice area has hidden side effects.** It cascades `matter_field_defs` (`30_matters.sql:161`), which silently drops that practice area's custom field definitions and orphans their values in `matters.custom_fields`. It also nulls `matter_stage_pipelines.practice_area_id` (`:24`). If the firm already has a firm-wide default pipeline, that null appears to collide with `matter_stage_pipelines_one_default_idx` (`:37-40`), which would make the delete fail with a unique violation. This needs a test. Either way the UI gives no warning (`settings/practice-area/page.tsx:18`). Add a reference count to the delete confirm, or refuse deletes of in-use rows.
2. **Court reads are gated by `courts.manage`** (`courts.routes.ts:27-42`). The court list feeds every matter, task and calendar form (`useCourts` callers above). The built-in Staff role lacks the code, but it also lacks `matters.create`, `tasks.create` and `calendar.view` (`permissions.ts:247-262`), so it never reaches those forms. The real exposure is a custom role that can create or edit tasks, matters or events without `courts.manage`: its court dropdown gets a 403. Practice areas avoid this with a baseline `practiceAreas.view`. Add a `courts.view` to the baseline and use it on the two GET routes. `tests/courts/courts.test.ts:238` pins the current behavior and would need updating.
3. **Court adoption is check-then-insert without a constraint.** `adoptCourts` reads the adopted set, then inserts row by row outside a transaction (`catalog.service.ts:45-64`). `courts_catalog_idx` is not unique (`15_catalogs.sql:78`), so two concurrent adopts can duplicate a court. A partial unique index on `(law_firm_id, catalog_court_id)` with `on conflict do nothing` would make the idempotency real. UTBMS adoption is backed by `unique (law_firm_id, kind, code)` (`70_billing.sql:32`), but a race there would surface as a 500 rather than a skip.
4. **Note types and templates cannot be renamed or removed.** Their routers have no PUT or DELETE (`noteTypes.routes.ts`, `noteTemplates.routes.ts`). The composer shows quick-add to every user without checking `noteTypes.manage` or `noteTemplates.manage` (`NotesSection.tsx:755,776`), so Staff get an error on submit.
5. **The built-in note-type list is duplicated** in `noteTypes.service.ts:10-19` and `statusMeta.ts:332-341`, and note rows accept any `note_type` string (`notesEngine.ts:289`). Drift between the two lists would let a custom type shadow a new built-in.
6. **`court_catalog.in_use` is imported but never filtered** (`import-courts.ts:115` vs `catalog.repository.ts:43-58`), so defunct courts show in the picker.
7. **The expense-category UTBMS import has no UI entry point.** `UtbmsPickerModal` supports it (`UtbmsPickerModal.tsx:33-36`), but it is rendered only with `codeType="task"` (`settings/charge-codes/page.tsx:539-545`).
8. **Small API mismatches.** The frontend types a practice-area create response as `{ practiceArea }` (`services/practiceArea.service.ts:5`), but the backend returns `{ practiceAreaId }` (`lookupService.ts:48`). The update response still carries `mattersUpdated: 0` (`lookupService.ts:73`).
9. **Doc drift.** [Matters: Deadline Sets](matters.md#deadline-sets) should be updated for the transactional apply and for `relativeTo`. Its note that the editor's drag handle is decorative still holds (`DeadlineSetEditorModal.tsx:197`).
