# Leads

Pre-client pipeline: prospect capture, a firm-configurable stage pipeline, public intake forms, and conversion into a `client` (optionally with a `matter`). Tables live in `backend/db/schema/30_matters.sql:217-328`; the module is `backend/src/modules/leads/` plus the public `backend/src/modules/intake/`.

## Summary

A **lead** is deliberately not a `client`: it must not count against plan client limits, and it must not surface client-detail tabs that assume financial or matter history. Leads get their own table, their own branching-tree pipeline (`lead_stages`), and their own RBAC permissions, gated on nothing plan-related. The only place a plan gate applies is converting a lead **into a matter**, which runs the ordinary `maxMatters` count check.

There is no dedicated top-level nav entry. Leads live as a tab on the Clients page (`ClientsPageTabs.tsx:47`), shown only when the caller has `leads.view`, and deep-linkable with `?tab=leads` (`:24`).

## Key Takeaways

- **Leads are excluded from plan limits by design.** Converting to a client only skips `enforceCountLimit` entirely; converting to client+matter runs the normal `maxMatters` check (`leads.service.ts:223`) because a real matter is created.
- **The lead pipeline is scoped by practice area, not by named pipelines.** `lead_stages.parent_stage_id` self-references for a branching tree, `practice_area_id` null means firm-wide, `is_closed` marks an ending. `listApplicable` (`stages/leadStages.repository.ts:43`) picks practice-area stages if any exist for that practice area, else the firm-wide set. (Matter stages moved to named `matter_stage_pipelines`; lead stages did not. See [Matters](matters.md#matter-stages-branching-pipeline).)
- **`stage_date` is not a transition timestamp.** It is a plain editable `date` the user sets by hand (e.g. a scheduled consultation), independent of `stage_id`.
- **Two distinct intake token flows**, both resolved by `resolveToken` (`intake/intake.service.ts:38`):
  - *Generic embed*: the token is the template's own `public_token`. A submission row is created only at submit time. The lead is found by email (`leadsRepo.findByEmail`, `:284`) or created in the default open stage (`getDefaultOpenStage`, `leadStages.repository.ts:206`).
  - *Targeted send*: `POST /leads/:leadId/send-intake-form` pre-creates an `intake_submissions` row with a fresh token tied to that lead and emails it. Submitting fills in **only blank fields** on the existing lead (`intake.service.ts:208`).
- **Conversion has no notification wired up.** `LEAD_CONVERTED` is emitted but its listener is an empty placeholder (`leads.events.ts:62-64`), unlike intake submission, which notifies the owner and everyone with `leads.view` or `leads.manage`.
- **Intake submission notifications link to the Clients page, not the lead.** The `actionUrl` is `${FRONTEND_URL}/lawfirm/{lawFirmId}/clients` (`leads.events.ts:44`), not `?tab=leads` and not the specific lead.
- **Lead conversion is atomic and single-use.** `claimLeadConversion` locks the lead and rechecks conversion state. Both conversion paths commit the claim, client creation and final lead pointers together. The matter path includes its matter and member inserts, rechecks the matter cap under the firm lock, and stamps final pointers in `createMatterWithMembersTx`'s `afterInsert` hook. Events follow commit.

## Schema

### `lead_stages` (`30_matters.sql:217`)

| Column | Notes |
|---|---|
| `practice_area_id` | Nullable. Null = part of the firm-wide default pipeline. |
| `parent_stage_id` | Self-FK (set null). Branching tree. |
| `is_closed` | Marks an ending (won or lost) branch. |
| `sort_order`, `color`, `name` | Display. |

Firm-scoped, unique on `(law_firm_id, id)`.

### `leads` (`30_matters.sql:234`)

| Column | Notes |
|---|---|
| `stage_id` | Composite FK `(law_firm_id, stage_id)` → `lead_stages`, set null. |
| `name`, `email`, `phone`, `organization`, `referral_source`, `notes` | Contact capture, all nullable except `name`. `notes` is one text column; the lead page's quick-add note writes it through `updateLead` (`QuickAddLeadNoteModal.tsx:36`). |
| `stage_date` | Plain `date`, user-set, independent of `stage_id`. |
| `disqualify_reason` | Free text for a closed-lost stage. |
| `converted_client_id`, `converted_matter_id`, `converted_at` | Set at conversion. `converted_client_id` has no FK (a soft reference); `converted_matter_id` → `matters` set null. |
| `created_by` | The firm member who added the lead. |

### `intake_form_templates` (`30_matters.sql:279`)

`name`, `practice_area_id` (nullable), `public_token` (unique), `fields` (jsonb array, `text`/`textarea`/`email`/`phone`/`select`, each with `required`), `access_code_hash` (nullable), `is_active`, `created_by`.

### `intake_submissions` (`30_matters.sql:298`)

`intake_form_template_id`, `token` (unique), `field_values` (jsonb), `status` (`sent` \| `completed` \| `rejected`), `lead_id`, `sent_to_email`, `sent_by`, `sent_at`, `opened_at`, `submitted_ip`, `completed_at`. Supports both the generic-embed flow (row created at submit) and the targeted-send flow (row pre-created with a token and emailed). `delivery_status` tracks `pending`, `sent` or `failed` separately from completion. Provider refusal returns 503 (429 for the daily cap) and does not emit a sent event. Same-recipient resends retain the token. Changing recipients replaces the token and address only after provider acceptance, preserving the previous link on failure.

`lead_id` is a **single-column** FK to `leads` with `on delete set null` (`:320-327`). It used to be composite `(law_firm_id, lead_id)`, and set-null on a composite key also nulls the NOT NULL tenant column, so deleting any lead that had ever touched an intake form failed. Deleting a lead now keeps its submissions with `lead_id` null.

## Default Seeding

Every new firm gets a default pipeline and intake form, seeded alongside practice areas and charge codes in `lawfirms.service.ts:96-97` (see [Reference Data](reference-data.md) for the rest of the seeded reference data):

```
leadStagesRepo.seedDefaultPipeline(lawFirmId)
intakeFormsRepo.createDefaultTemplate(lawFirmId, { createdBy: userId })
```

Default pipeline (`defaults.ts::DEFAULT_LEAD_STAGE_PIPELINE`), a branching tree:

```
New → Contacted → Consultation Scheduled → Retained (closed)
                → Unresponsive (closed)
      Consultation Scheduled → Not a Fit (closed)
```

Default intake form (`DEFAULT_INTAKE_FORM`): "General Intake" with `full_name`, `email`, `phone`, `matter_type` (select), `details` (textarea).

## Conversion

`POST /leads/:leadId/convert` → `convertLead` (`leads.service.ts:210`), branching on `createMatter`. `clientType: 'company'` converts into an organization client with the lead as its roster contact, chosen by `conversionClientInputs` (`:183`) in this order: `organizationClientId`, an existing active organization in the firm (anything else is a 400); `organizationName`, a new organization, or an existing one with the same name; and finally the lead's own `organization` text. With none of the three, the conversion is refused. The lead is added to the organization's roster once, so the same email arriving twice is not duplicated. In the dialog, the organization field is the shared `ClientOrganizationAutocomplete`, prefilled from the lead.

- **`createMatter: false`** (client-only): one transaction claims the lead, finds or creates the client and any organization roster contact, sets `converted_client_id`, and moves the lead to its first closed stage. No plan check. Response: `{ lead, matterId: null, clientId }`.
- **`createMatter: true`** (default): validate the practice area and court, generate a reference id, then use `createMatterWithMembersTx`. Its `beforeInsert` hook locks the firm, rechecks `maxMatters` and claims the lead; its `afterInsert` hook stores conversion pointers and the closed stage. The client, matter, members and lead commit together before `LEAD_CONVERTED` and `MATTER_CREATED` are emitted.

Either path emits `LEAD_CONVERTED` (placeholder listener only, see Key Takeaways).

## Routes

**Leads**, mounted at `/api/lawfirms/:lawFirmId/leads` (`app.ts:865`, `leads.routes.ts`):

| Method | Path | Permission | Line |
|---|---|---|---|
| `GET` | `/` | `leads.view` | `:20` |
| `POST` | `/` | `leads.manage` | `:43` |
| `POST` | `/:leadId/convert` | `leads.convert` | `:55` |
| `POST` | `/:leadId/send-intake-form` | `leads.manage` | `:68` |
| `GET` | `/:leadId` | `leads.view` | `:82` |
| `PUT` | `/:leadId` | `leads.manage` | `:93` |
| `DELETE` | `/:leadId` | `leads.manage` | `:106` |

**Lead stages**, mounted at `/api/lawfirms/:lawFirmId/lead-stages` (`app.ts:864`): `GET /` (`leads.view`), `POST /reorder`, `POST /`, `PUT /:stageId`, `DELETE /:stageId` (all `leads.manageStages`, `stages/leadStages.routes.ts:16-65`).

**Intake form templates**, mounted at `/api/lawfirms/:lawFirmId/intake-forms` (`app.ts:866`): reads (`GET /`, `GET /:templateId`) need `leads.view`; writes (`POST /`, `PUT /:templateId`, `DELETE /:templateId`, `POST /:templateId/regenerate-token`) need `leads.manage` (`intakeForms.routes.ts:15-74`).

**Public intake**, mounted at `/api/intake` (`app.ts:909`), no auth: `GET /:token` (`intakeReadLimiter`), `POST /:token/verify-access-code` (`intakeGateLimiter`, keyed on the token so an access code cannot be brute-forced across IPs), `POST /:token/submit` (`intakeSubmitLimiter`) (`intake/intake.routes.ts:13-28`).

## Permissions

Four codes (`backend/src/modules/lawfirms/roles/permissions.ts:59-62`), gated on RBAC only, no plan-tier `requireFeature`/`requireActiveBilling` anywhere in the leads routes:

- `leads.view`, `leads.manage`, `leads.convert`, `leads.manageStages`

`leads.view` is in `DEFAULT_PERMISSIONS`, the baseline every member holds (`permissions.ts:147-176`). The Attorney and Paralegal templates get view/manage/convert but not `manageStages` (`:202`, `:231`). Owners bypass via the `ALL_PERMISSIONS` short-circuit. See [Firms, RBAC & Plans](lawfirms-rbac-plans.md).

## Frontend

| Route | What it is |
|---|---|
| `/lawfirm/[lawFirmId]/clients?tab=leads` | Leads tab on the Clients page (`ClientsPageTabs.tsx`) |
| `/lawfirm/[lawFirmId]/leads/[leadId]` | Lead detail page |
| `/lawfirm/[lawFirmId]/settings/lead-stages` (also a tab inside `settings/matter-config`) | Stage pipeline editor |
| `/lawfirm/[lawFirmId]/settings/intake-forms` | Intake form builder |
| `/intake/[token]` | Public, unauthenticated intake form |

`LeadsGrid.tsx` renders a paged list (`useLeadsTable`). A lead changes stage from its detail page. `LeadDetailModal.tsx` is shared by create, edit, and "send intake form". `ConvertLeadModal.tsx` holds the "Also create a matter" checkbox. `QuickAddLeadNoteModal.tsx` (lead detail page) replaces the lead's single `notes` field; `IntakeFormsQuickAccess.tsx` and `IntakeFormPreviewModal.tsx` surface the firm's intake forms from the leads tab. Service: `frontend/src/services/leads.service.ts`. Hooks: `frontend/src/hooks/leadHooks/` (`useLeads.ts`, `useLeadStages.ts`, `useLeadsTable.ts`, `useIntakeForms.ts`).

## What Can Be Improved

- **Conversion doesn't notify anyone.** `LEAD_CONVERTED` has a placeholder listener only (`leads.events.ts:62-64`). A firm member converting a lead someone else was tracking gives that person no signal. `LEAD_STAGE_CHANGED` and `LEAD_DELETED` listeners are empty placeholders too.
- **Intake-submission notifications don't deep-link.** The `actionUrl` lands on the generic Clients page (`leads.events.ts:44`) rather than `?tab=leads` or the lead itself.
- **"Quick add note" overwrites.** A lead has one `notes` text column, and `QuickAddLeadNoteModal` saves by replacing it (`QuickAddLeadNoteModal.tsx:36`), so there is no history or authorship. Leads could use the shared `notes` table the way matters, tasks and clients do.
- **No sidebar nav entry.** Leads is reachable only as a tab under Clients (`ClientsPageTabs.tsx:47`), which is easy to miss for a feature this size.
