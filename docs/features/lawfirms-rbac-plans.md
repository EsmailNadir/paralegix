# Law Firms, Members, Roles (RBAC) & Subscription Plans

## Summary

This is the multi-tenancy and access-control core of Paralegix. Every piece of firm data is owned by a `law_firms` row (the tenant root); almost every other table carries a `law_firm_id` FK and is scoped by it. Users become firm participants through `members` rows keyed `(law_firm_id, user_id)`; what a member may do is governed by RBAC: each member points at a `roles` row whose `permissions text[]` is the granted set. Subscription tier (Starter / Basic / Professional / Enterprise) is stored on the firm and enforced server-side along three independent axes: **count limits** (matters, members) throw a `PlanLimitError` (403, `PLAN_LIMIT_REACHED`); **storage limits** (firm quota, per-file cap) throw a 413 from the atomic quota reservation; **feature gates** (calendar sync, analytics, templates, trust accounting, document signing, file sharing, messaging, flat fees, client portal) throw a `ForbiddenError` (403). These are wired into the routers via a `requireFeature` middleware. A fourth, independent gate is **payment state**: a firm whose `billing_status` is not `active`, `trialing` or `comped` gets 402 `BILLING_INACTIVE` from `requireActiveBilling` on the whole workspace. Firms can be comped, given per-resource overrides, or flagged `unlimitedOverride` to bypass limits entirely. Stripe drives plan changes through the subscriptions module (checkout, change, cancel, webhook, nightly reconcile).

## Key Takeaways

- **Tenancy is enforced in app code, not the DB.** The backend connects as `postgres` and bypasses Postgres RLS (except messaging). Audited Drizzle tenant contexts, including the Drizzle-backed `DrizzleRepository` CRUD base, require `law_firm_id` on every read/write. A bug that drops the scope leaks cross-tenant data, so it is treated as a security defect.
- **RBAC = `roles.permissions text[]` unioned with a baseline.** A request resolves the caller's `members` row, reads its `role_id` → `roles.permissions`, unions `DEFAULT_PERMISSIONS` (`permissions.ts:133`), and checks the required code (or any of an array of accepted codes, for renamed permissions). Owners (`is_owner = true`) hold `ALL_PERMISSIONS` and skip the check (`requirePermission.ts:110-121`, `roles.service.ts:224-231`).
- **Financial reads require explicit grants.** The 17-code collaboration baseline excludes invoice, time-entry, rate, plan, expense and trust reads. Built-in role grants remain explicit. Frontend permission arrays, including empty arrays, take precedence over role-name fallbacks.
- **Per-role enforcement is behind `RBAC_ENFORCED`.** Unless the backend env sets `RBAC_ENFORCED=true`, every member resolves to `ALL_PERMISSIONS` and only membership is enforced (`roles.service.ts:7-17,181,228`). With it on, a member with no role (or a deleted one) gets the baseline, not `[]`; only a non-member resolves to nothing.
- **Permission resolution is a single members⋈roles JOIN, memoized by a short-TTL cache.** `loadResolvedMember` (`requirePermission.ts:35-60`) refuses a non-uuid firm id up front, checks an in-memory cache keyed by `(lawFirmId, userId)`, and on a miss runs one `findByUserIdWithRole` query that also excludes firms pending deletion (`members.repository.ts:40-58`). The cache stores only the derived permission set, with a 30s TTL backstop, a 5000-entry LRU ceiling, and explicit invalidation on `MEMBER_ROLE_CHANGED` / `MEMBER_REMOVED` / `ROLE_PERMISSIONS_CHANGED` / `LAWFIRM_DELETION_REQUESTED` (`permissionCache.ts:32-51`, `permissionCache.events.ts:23-61`). The events fire from both the firm-facing services and the admin module.
- **The frontend learns a viewer's permissions from one row, not the roster.** `GET /api/lawfirms/:lawFirmId/members/me` (`members.routes.ts:37`, `membersService.getMyMembership`, `members.service.ts:97`) returns the CALLING member's row with `resolvedPermissions`, and `PermissionsContext` is its only caller. It resolves through `loadResolvedMember`, the same cached members-to-roles JOIN `requirePermission` uses, so its answer cannot drift from the roster's. It is gated on membership alone, like `POST /:lawFirmId/leave`: a permission code in front of it would render a narrow member's whole app as denied, and a non-member gets the same `ForbiddenError('Not a member of this firm')` 403 the roster's `members.view` check raises. Cost is flat at two connection checkouts (the membership JOIN plus the caller's own identity row); the roster read it replaced resolves an identity and signs an avatar for every member of the firm (`backend/tests/lawfirms/myMembershipConnections.test.ts` pins both).
- **Four independent gates: permission, payment state, plan-count, plan-feature.** `requirePermission(...)` is authorization; `requireActiveBilling` (mounted `app.use('/api/lawfirms/:lawFirmId', verifyToken, requireActiveBilling)`, `app.ts:858`) returns 402 for a lapsed firm, exempting `/subscriptions` and `/invitations` (`requireActiveBilling.ts:37-70`); `enforceCountLimit` (service layer) is count enforcement; `requireFeature(...)` is feature enforcement and also re-asserts payment state for routers that mount outside the workspace gate (`requireFeature.ts:58-81`). Both billing and feature gates answer only members: a non-member falls through to the route's own 403, so the gates are not an oracle for a firm's plan or payment state.
- **`verifyToken` runs before `requireFeature` on every gated router** (`app.use(path, verifyToken, requireFeature(feature), router)`, `app.ts:870,874,879,897,906-907,911,917`). Unauthenticated → **401**; wrong-plan authenticated member → **403**; lapsed firm → **402**.
- **Calendar gates check permission first, then plan.** The shared `calendarSyncGates.ts` builds `requirePermissionFrom(<firm id resolver>, 'calendar.sync')` and `requireFeature('calendarSync', <resolver>)` for body-scoped firm ids (`calendarSyncGates.ts:17-37`). Every provider route that pushes or imports (`sync-from-*`, `sync-tasks-to-*`, `sync-events-to-*`, `enable-silent-sync`) runs both.
- **Plan feature gates are enforced at the API.** A Starter firm that hits a gated endpoint directly (e.g. `POST /trust/accounts`) gets a 403, honoring the plan ceiling + `featureOverrides` + the firm `settings.features` opt-out (`featureCheck.ts:12-43`). Frontend page wrappers exist for most gated features, but not analytics (see Frontend gating).
- **`plan_id` and `billing_status` columns are authoritative.** The old trigger that copied them out of the jsonb is gone (migration 0200, historical number); the jsonb no longer carries `planId`/`billingStatus` (`backend/db/schema/10_identity.sql:116-127`). `lawfirms.repository.mergePlan` routes those two keys to the columns and normalizes stray spellings (`unpaid` → `past_due`; `suspended`/`cancelled`/`incomplete_expired` → `canceled`; anything unknown → `incomplete`) (`lawfirms.repository.ts:22-36,246-264`). `loadFirmPlan` and `toEntity` put them back onto `plan.planId`/`plan.billingStatus` for readers, failing closed to `incomplete` (`planEnforcement.ts:17-38`).
- **Plan tiers live in code, not the DB** (`planDefinitions.ts`). The jsonb only stores Stripe ids, trial/comp metadata and overrides; limits/features are looked up from the in-code table. An unknown persisted `planId` logs loudly instead of silently downgrading.
- **The storage quota is enforced from the TYPED columns, never the jsonb.** `reserveStorageUsage` tests `storage_hard_limit` / `storage_quota_bytes` inline in its `UPDATE ... WHERE`, so a null quota or a false hard limit means no enforcement at all. Firm creation (`lawfirms.service.createLawFirm`) seeds both from the firm's plan, and every plan change writes them through `updateStorageConfig`: the Stripe path (`syncStorageQuota`, `subscriptions.service.ts:328-330`) and the admin path both. The `settings->storage` jsonb is a back-compat mirror that only answers reads.

---

## How It Works

### Transaction boundaries

`createLawFirm` locks the founder's user row before rechecking the firm cap. The firm, built-in roles, owner membership, practice areas, charge codes, lead stages and default intake form share one transaction. Provisioning events and analytics follow commit.

Deletion publishes access-revocation events immediately after the deletion stamp commits, before external-resource teardown. A teardown failure cannot leave a warm permission cache granting access to the deleted firm.

Ownership transfer and owner departure lock the user and firm, recheck ownership on the transaction executor, and commit role changes and departure together. Member removal and role edits use these locks too, so a queued request rechecks protection after its target becomes the owner. A confirmed invitation switch includes the old membership or firm-deletion stamp and the destination membership in the invitation transaction. Subscription cancellation, calendar teardown and member events follow the outer commit (`shared/database/transactionEffects.ts`).


### Entry Points

| Surface | File:line | Purpose |
|---|---|---|
| Auth middleware | `backend/src/shared/middleware/auth.ts` (`verifyToken`) | Verifies Firebase ID token (short-TTL cache keyed on the full token string + `checkRevoked: true` on the cold path), sets `req.user`. |
| Permission middleware | `backend/src/modules/lawfirms/roles/requirePermission.ts:80` (`requirePermission`), `:136` (`assertFirmPermission`), `:158` (`requirePermissionFrom`) | Resolves member + role permissions (cache-first), gates the route; the `From` variant takes the firm id from the body. |
| Billing gate | `backend/src/shared/plans/requireActiveBilling.ts:47` | Workspace-wide 402 for a lapsed firm; exempts `/subscriptions`, `/invitations`. |
| Feature middleware | `backend/src/shared/plans/requireFeature.ts:58` (`requireFeature`) | Member-only gate: payment state (402) then `enforceFeatureAccess` (403). Mounted in `app.ts`, `calendarSyncGates.ts`, and four `signing.routes.ts` routes (`:630,662,748,814`). |
| Permission cache | `backend/src/modules/lawfirms/roles/permissionCache.ts` + `permissionCache.events.ts` | Short-TTL, bounded `(firmId,userId)` cache of the resolved set; listeners registered at `app.ts:141`. |
| Firm service | `backend/src/modules/lawfirms/lawfirms.service.ts` | Create / get / update / soft-delete / restore / purge firm. |
| Member service | `backend/src/modules/lawfirms/members/members.service.ts` | List / get / remove members, change role, transfer ownership, leave, set rate. |
| Own-membership read | `backend/src/modules/lawfirms/members/members.service.ts:97` (`getMyMembership`), route at `members.routes.ts:37` | The caller's own member row with resolved permissions. Membership-gated, one row, no roster. What `PermissionsContext` mounts on. |
| Role service | `backend/src/modules/lawfirms/roles/roles.service.ts` | Seed built-ins, list / get / create / update / delete roles, permission resolution. |
| Plan enforcement | `backend/src/shared/plans/planEnforcement.ts:106` (`enforceCountLimit`), `:173` (`enforceFeatureAccess`), `:59` (`isFirmBillingActive`) | Counts from the service layer, features from `requireFeature`. Both enforcers accept `opts.firmData` to skip the plan-load round-trip. |
| Subscriptions | `backend/src/modules/subscriptions/` | Self-serve plan lifecycle + Stripe webhook (see "Subscription lifecycle" below). |
| Admin overrides | `backend/src/modules/admin/admin.service.ts:356` (`updateLawFirmRole`), `:473` (`updateMemberRole`), `:521` (`removeMember`), `:945` (`adminCompFirm`) | Super-admin role/member/plan edits; emit the same cache-invalidation events. |
| Frontend services | `frontend/src/services/lawfirm.service.ts`, `roles.service.ts`, `subscription.service.ts` | API layer for the settings pages. |
| Frontend feature gate | `frontend/src/components/ui/RequireFeature.tsx` | Wraps a page in the firm's `features` flag; renders `FeatureDisabledPage` if off. |

### Data Flow — Permission check on a request

Example: `GET /api/lawfirms/:lawFirmId/members`.

1. `verifyToken` reads the `Authorization: Bearer` header and resolves the decoded token from the short-TTL token-string cache, verifying fresh against Firebase (`checkRevoked: true`) only on a miss. On success `req.user = decodedToken`.
2. `requirePermission('members.view')` runs (`requirePermission.ts:80`). It reads `lawFirmId = req.params.lawFirmId` only (no `req.params.id` fallback), refuses a non-uuid id with the non-member 403 before any query, and requires `req.user.uid` (`requirePermission.ts:88-103`).
3. `loadResolvedMember(lawFirmId, userId)` (`requirePermission.ts:35`):
   - **Cache hit** (`permissionCache.get`, `permissionCache.ts:70-80`): returns a fresh defensive copy of the shaped member with `resolvedPermissions` already attached; no DB round trip.
   - **Cache miss**: one `membersRepo.findByUserIdWithRole(lawFirmId, userId)`: `members` joined to `law_firms` (excluding a firm pending deletion) and left-joined to `roles` (`members.repository.ts:40-58`). No row → `null` → `ForbiddenError('Not a member of this firm')`.
4. On a miss, permissions are resolved in memory with **no second query** via `rolesService.resolveFromRolePermissions(member, member.rolePermissions)` (`roles.service.ts:224-231`): owner → `ALL_PERMISSIONS`; `RBAC_ENFORCED` off → `ALL_PERMISSIONS`; no `roleId` or a gone role → `DEFAULT_PERMISSIONS`; else role permissions ∪ baseline. The result is cached (`permissionCache.set`, `permissionCache.ts:86-94`).
5. `member.isOwner` → pass immediately (`requirePermission.ts:110-114`). Otherwise at least one accepted code must be in `resolvedPermissions`, else `ForbiddenError` with `details.requiredPermission` (`requirePermission.ts:117-121`).
6. `req.member` is attached and the handler runs. The data query is again scoped by `law_firm_id`.

Net: a gated read costs **token verify + (cache hit) 0 auth DB queries, or (cache miss) 1 JOIN query** before the handler's own queries.

### Data Flow: Feature-gate enforcement

Example: `POST /api/lawfirms/:lawFirmId/trust/accounts` on a Starter firm.

1. The router is mounted with `verifyToken` then the gate: `app.use('/api/lawfirms/:lawFirmId/trust', verifyToken, requireFeature('trustAccounting'), trustModuleRoutes)` (`app.ts:911`), behind the workspace billing gate at `app.ts:858`. An unauthenticated caller gets a 401 before any plan state is revealed.
2. `requireFeature('trustAccounting')` (`requireFeature.ts:58-81`) resolves `lawFirmId`, then resolves the caller as a member through the permission cache. A non-member (or a request with no user) falls through untouched, so they get the route's own 403 rather than a plan answer.
3. It loads the firm through `loadFirmPlanForRequest`, which memoizes `loadFirmPlan` for the one request, so the workspace gate and this gate share a single query and nothing is reused on the next request, throws 402 `BILLING_INACTIVE` if the firm is not in an access-granting billing state (`assertFirmBillingActive`, `planEnforcement.ts:82-92`), then calls `enforceFeatureAccess` with the loaded `firmData` (`planEnforcement.ts:173-189`), which applies `featureCheck.isFeatureEnabled`: plan ceiling (incl. `unlimitedOverride` / `featureOverrides`) AND the firm `settings.features.trustAccounting !== false` opt-out.
4. Starter's `trustAccounting: false` → `ForbiddenError` (403). The router's own per-route `verifyToken` + `requirePermission` still run after; the inner `verifyToken` recognises the already-verified token and only re-runs the email gate (`auth.ts:231-240`).
5. If the firm id can't be resolved, the gate is a **no-op** (`requireFeature.ts:62`) and downstream middleware handles the missing id; the gate never fabricates access.

**The gated routes and how each resolves `lawFirmId`:**

| Feature | Route(s) | Gate location | lawFirmId source |
|---|---|---|---|
| `analytics` | `/billing/analytics/*` | `app.ts:874` | `req.params.lawFirmId` |
| `flatFees` | `/billing/flat-fees/*` | `app.ts:870` | `req.params.lawFirmId` |
| `fileSharing` | `/file-share-links/*` | `app.ts:879` | `req.params.lawFirmId` |
| `messaging` | `/messaging/*` | `app.ts:897`, a gate-only mount that falls through to the `/api`-mounted messaging router | `req.params.lawFirmId` |
| `documentSigning` | `/signature-links/*`, `/signing-templates/*` | `app.ts:906-907` | `req.params.lawFirmId` |
| `documentSigning` | four firm-side routes on the `/api/signing` router | `signing.routes.ts:630,662,748,814` | `req.body.lawFirmId` |
| `trustAccounting` | `/trust/*` | `app.ts:911` | `req.params.lawFirmId` |
| `templates` | `/templates/*` (folders + templates) | `app.ts:917` | `req.params.lawFirmId` |
| `clientPortal` | `/api/client-portal/lawfirm/:lawFirmId/*` | `portal.routes.ts:84-95`, inside the portal's per-firm billing gate | `req.params.lawFirmId` |
| `calendarSync` | google: `sync-from-google`, `enable-silent-sync` | `google.routes.ts:84,139` (`requireSyncPerm` + `requireCalendarSync`) | `req.body.lawFirmId` (`firmIdFromBody`, `calendarSyncGates.ts:17`) |
| `calendarSync` | google batch: `sync-tasks-to-google`, `sync-events-to-google` | `google.routes.ts:105,122` (`...FromItems`) | body `lawFirmId` else first array item's (`calendarSyncGates.ts:20-28`) |
| `calendarSync` | outlook: the same four routes | `outlook.routes.ts:92,113,130,147` | as for Google |

**Not gated:** the external-signer endpoints on `/api/signing` and the unscoped `/api/signatures` router carry no firm context (external participants).

### Frontend gating

`PermissionsProvider` (`frontend/src/contexts/PermissionsContext.tsx`) wraps the firm workspace and is what every gated control asks. On mount it makes ONE request, `lawfirmService.getMyMembership(lawFirmId)` against `GET /api/lawfirms/:lawFirmId/members/me`, and unions the returned `resolvedPermissions` / `permissions` with the frontend's own `DEFAULT_PERMISSIONS` mirror; an owner short-circuits to `ALL_PERMISSIONS`. A **403 is an answer, not a failure**: it means the viewer is not a member, so the context reports no permissions with `loadError` false. Every other failure sets `loadError`, which gated pages render as a retry state rather than a wrong "access denied". `getLawFirmMembers` (the roster) is still the right read for the members settings screen, `useFirmMembers`, the signature field placer and the get-started checklist; it is the wrong read for a page mount.

`RequireFeature` (`RequireFeature.tsx`) reads `useFirmSettings().features` and renders `FeatureDisabledPage` when off:

- `messages` → `feature="messaging"` (`messages/page.tsx:144`, `messages/[conversationId]/page.tsx:53`)
- `files` → `feature="fileSharing"` (`files/page.tsx:1213`)
- `signatures` → `feature="documentSigning"` (`signatures/page.tsx:18`)
- `trust` → `feature="trustAccounting"` (`trust/page.tsx:148`)
- `templates` → `feature="templates"` (`templates/page.tsx:72`)
- **analytics** has no page wrapper or `features.analytics` check anywhere in `frontend/src/app` or `components` (only the admin `FeatureOverridesModal` lists the key), so a tier without it hits the API's 403 (see Improvements).
- **calendar** is not page-wrapped (viewing the calendar is not plan-gated, only sync is). `Calendar.tsx` reads `features.calendarSync` (`components/calendarComp/Calendar.tsx:107`) and skips the sync-flag fetch, the auto-sync effect and the sync controls when off (`:214,243-277,1380`).

### Data Flow — Plan-limit enforcement on create

Example: invite a member, or create a matter.

1. Route passes RBAC (`requirePermission('members.invite')` / `requirePermission('matters.create')`).
2. Service calls `enforceCountLimit(lawFirmId, 'maxMembers', () => repo.countMembersAndPendingMembers(lawFirmId))` (`invitations.service.ts:161`) or `enforceCountLimit(lawFirmId, 'maxMatters', () => mattersRepo.countMatters(lawFirmId))` (`matters.service.ts:296`; lead conversion at `leads.service.ts:223`).
3. `enforceCountLimit` loads the firm plan via `loadFirmPlan(lawFirmId)`: `select plan_id, billing_status, plan, settings from law_firms`, shaped as `{ plan: { ...jsonb, planId, billingStatus }, settings }` from the columns (`planEnforcement.ts:17-38`). Missing or malformed firm → returns silently.
4. `getEffectiveLimits(firmData)` resolves the limit (`planDefinitions.ts:194-215`): `unlimitedOverride` → all `-1` (storage capped at 50 GB); else `limitOverrides[resource] ?? PLAN_TIERS[planId].limits[resource]`.
5. Limit `=== -1` (`UNLIMITED`) → return **before** the count query (`planEnforcement.ts:124`).
6. Otherwise `countFn()` runs a `count(*)` (members + unexpired pending member invitations; or every `matters` row).
7. `current >= limit` → `throw new PlanLimitError(resource, { current, limit, planId })` → 403 `PLAN_LIMIT_REACHED` (`planEnforcement.ts:128-134`, `AppError.ts:102-109`).
8. The paths that actually add a seat or a matter re-check under a firm-row lock on the insert's own transaction: the matter create (`lockFirmForMatterCountCheck`, `matters.service.ts:407-416`), the invite accept and the direct add of an existing user (`lockFirmForSeatCheck` then `countMembers`, `invitations.service.ts:246-252,423-434`). The step-2 check is a fast fail; the locked one is authoritative.

### Data Model

`backend/db/schema/10_identity.sql` (generated into `backend/db/schema.sql`).

**`law_firms`** (tenant root, `:51-114`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | The tenant key referenced everywhere as `law_firm_id`. |
| `plan_id` | text | CHECK in `('starter','basic','professional','enterprise')`, default `'starter'` (`:63-64`). **Authoritative**; written by `mergePlan`. |
| `billing_status` | text | CHECK in `('comped','active','trialing','incomplete','past_due','canceled')`, default `'comped'` (`:65-66`). **Authoritative**; normalized by `mergePlan`. |
| `plan` | jsonb | Stripe ids, period bounds, trial/comp metadata and overrides (see below), default `'{}'` (`:67`). No longer carries `planId`/`billingStatus`. |
| `settings` | jsonb | Firm-level settings incl. `settings.features` opt-outs (`:102`). See [Settings](/features/settings). |
| `stripe_account_id`, `stripe_charges_enabled`, `stripe_onboarding_complete`, `direct_charges_enabled` | | Stripe Connect (payments). Subscription Stripe ids live in `plan` jsonb. |
| `storage_quota_bytes`, `storage_used_bytes`, `storage_reserved_bytes`, `storage_hard_limit`, `storage_warn_at_percent` | bigint/bool/int | Storage-quota enforcement (`:78-95`). |
| `pending_deletion_at`, `deletion_purge_after`, `deletion_requested_by` | | Soft-delete retention (`:99-101`). |
| index | `law_firms_plan_idx (plan_id, billing_status)` (`:107`) | Admin filtering. No trigger: the one that derived the columns from the jsonb was removed (`:116-127`). |

**`plan` jsonb shape** (written by `lawfirms.service.ts`, `subscriptions.service.ts`, `admin.service.ts`, merged via `lawfirms.repository.mergePlan` `:246-264`, which strips `planId`/`billingStatus` into the columns):

```jsonc
{
  "comped": false,
  "compedReason": "…", "compedBy": "<adminUserId>", "compedAt": "ISO",
  "unlimitedOverride": true,        // bypass all count/feature limits
  "limitOverrides":  { "maxMatters": 500, "maxMembers": 50, "storageQuotaBytes": … },
  "featureOverrides":{ "analytics": true, "templates": false },
  "stripeCustomerId": "cus_…",
  "stripeSubscriptionId": "sub_…",
  "canceledSubscriptionId": "sub_…", // the subscription last cancelled; stale webhooks for it are ignored
  "stripePriceId": "price_…",
  "billingInterval": "monthly",
  "currentPeriodStart": "ISO", "currentPeriodEnd": "ISO",
  "cancelAtPeriodEnd": false, "trialEndsAt": "ISO",
  "trialConsumed": true,            // once true, checkout never offers another trial
  "lastPaymentAt": "ISO", "lastPaymentAmount": 5000,   // cents
  "assignedAt": "ISO", "assignedBy": "system|stripe|<adminUserId>"
}
```

**`roles`** (`:191-203`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK; also `unique (law_firm_id, id)`. |
| `law_firm_id` | uuid FK | ON DELETE CASCADE. |
| `name` | text | `unique (law_firm_id, name)`. |
| `is_built_in` | bool | Built-in roles can't be renamed; only the role named `Owner` can't be deleted. |
| `permissions` | text[] | The granted permission strings; default `'{}'`. |
| index | `roles_perms_gin on roles using gin (permissions)` (`:203`) | GIN on the array. Not used by the RBAC hot path (which looks up by id), but used by `r.permissions @> array[...]` recipient queries. Keep it. |

**`members`** (`:205-232`)

| Column | Type | Notes |
|---|---|---|
| `(law_firm_id, user_id)` | PK | No surrogate `id`. |
| `role_id` | uuid | Single-column FK `members_role_fk → roles(id) ON DELETE SET NULL` (`:224`). It used to be composite, which made deleting any in-use role fail with a NOT NULL violation on `law_firm_id` (migration 0186, historical). Tenant agreement is checked in the application. |
| `is_owner` | bool | Owner shortcut; bypasses permission checks. At most one per firm: `members_one_owner_per_firm_idx` (`:231-232`). |
| `default_hourly_rate_cents` | bigint | Stored in cents, exposed as dollars. |
| `present_as_firm` | bool | "Send as firm" member preference. |
| `joined_at`, `invited_at`, `invited_by` | | Membership provenance. Name/email NOT stored; JOINed from `users`. |
| index | `members_user_idx on members (user_id)` (`:226`) | Supports "which firms is this user in" lookups. |

Built-in roles (Owner, Admin, Attorney, Paralegal, Staff, `permissions.ts:157-246`), the always-on `DEFAULT_PERMISSIONS` baseline (`:133`) and the full catalog are defined in code and seeded per firm on creation by the idempotent `seedBuiltInRoles` (`roles.service.ts:32-52`).

### Key Logic & Rules

- **Tenant scoping**: audited Drizzle contexts verify `law_firm_id` in emitted SQL. The `DrizzleRepository` CRUD methods take `lawFirmId` first and force it into reads/writes; the members repository uses its explicit member-keyed scoped path.
- **Note time and note retraction follow one rule on every parent.** The three notes mounts (matter, task, client) are generated by `createNotesRouter`, each with its own permission map. Time on a note is billable work, so adding, editing or removing a note's time entry needs `billing.manageTimeEntries` on all three, and so does posting a note with a `timeEntries` array (the notes engine asserts it before the note is written, so a refusal leaves no half-written note). Retracting a note needs the parent's own write permission: `matters.update`, `tasks.update`, `clients.manage`. The independent permission table is pinned in `backend/tests/crosscutting/parentNotesParity.test.ts`.
- **Editing a client from a matter needs `clients.manage` as well as `matters.manageClients`.** `PUT /matters/:matterId/clients/:clientId` writes the shared client record, not a matter link, so a role that can attach clients to a matter (the built-in Paralegal) cannot rename one or change its contact details. The route reuses the clients update schema and goes through `clientsService.updateClient`, so it emits `CLIENT_UPDATED` like the clients route does. Pinned in `backend/tests/matters/matterClientEdit.test.ts`.
- **Other members' time entries need a second code.** `billing.manageTimeEntries` covers the holder's own entries. Editing, moving or deleting an entry whose timekeeper is someone else (or firm-level time, which has none), bulk-deleting a selection that contains one, and logging time in another member's name all additionally need `billing.manageOthersTimeEntries`, asserted in `timeEntries.service.ts` through `assertFirmPermission`. A bulk delete containing such an entry is refused whole with a 403 (an entry on a matter the caller is not staffed on still gets the per-entry matter-wall error, so the refusal never confirms a teammate's entry). Owners and admins hold it through `ALL_PERMISSIONS`; Attorney and Paralegal carry it, and migration `0025_backfill_manage_others_time_entries.sql` copied it onto every existing role that held `billing.manageTimeEntries`, so no firm changed behaviour. A firm removes it from a role to get "own entries only". It is not in `DEFAULT_PERMISSIONS`. Expenses and flat fees are not gated this way: they record the creator rather than a selectable timekeeper, and `billing.manageExpenses` is a separate grant. Pinned in `backend/tests/billing/timeEntriesOthers.test.ts` and `backend/tests/permissions/manageOthersBackfill.test.ts`.
- **Permission resolution** (`roles.service.ts:177-231`): owner → all; `RBAC_ENFORCED` off → all; no role or a deleted role → the baseline; otherwise role ∪ baseline; a non-member → `[]`. Two resolvers: `resolvePermissions` (does its own `roles.findById`, used by `getMember`) and the pure `resolveFromRolePermissions` (no query, used by the cached JOIN path and the `listMembers` batch path). `resolvePermissions` rethrows DB errors (→ 500), never a silent empty set and never a grant (`roles.service.ts:197-207`).
- **Owner protections** (service layer): can't remove the owner (`members.service.ts:98-101`), can't change the owner's role (`:118-121`), only the owner can assign the Owner role (`:127-130`). The owner of a one-member firm can leave only with `confirmDeletion` (else 409 `CONFIRM_FIRM_DELETION_REQUIRED`), which schedules the firm for soft-deletion; the owner of a larger firm must name `newAdminUserId` (else 409 `LAST_ADMIN_TRANSFER_REQUIRED` with the eligible members), which transfers ownership and then leaves (`:232-293`).
- **Ownership transfer** (`POST /api/lawfirms/:lawFirmId/transfer-ownership`, `members.routes.ts:94-103`): needs `firm.transferOwnership` AND the service's own `isOwner` check (`members.service.ts:167-176`). The two are not redundant: a custom role can hold every code, but only the real owner passes the second. The outgoing owner is demoted to the built-in Admin role and the target promoted to Owner in one transaction. If the firm deleted Admin (or Owner), `seedBuiltInRoles` recreates the missing role first, so the outgoing owner never drops to the baseline (`:180-210`). Both members' cache entries are invalidated (`:213-224`).
- **No privilege escalation via role grant or role edit** (service layer): the invite path (`invitations.service.ts:176-194`) and the role-change path (`members.service.ts:132-146`) reject assigning a role whose effective permissions exceed the actor's; `createRole` and `updateRole` reject writing permissions the actor does not hold (`assertNoPermissionEscalation`, `roles.service.ts:86-116`). The owner bypasses all three. The role-edit guard closed the shortest path: a `firm.manageRoles` holder could otherwise edit their own role into everything, which also flips `isFirmOwnerOrAdmin` and so the matter ethical wall.
- **Paralegal reads billing plans.** `billing.viewPlans` left the member baseline, so the built-in Paralegal definition carries it explicitly (Paralegals log time against retainer matters and need to see the plans). Staff deliberately has no billing reads. Migration `0026_backfill_paralegal_view_plans.sql` appends it to every existing built-in Paralegal row, identified as `is_built_in = true and name = 'Paralegal'` (the same identification `resync-builtin-roles.ts` uses), skips rows that already hold it, and leaves custom roles alone. Pinned in `backend/tests/permissions/paralegalViewPlansBackfill.test.ts` and `builtInRolesKeepFinancialReads.test.ts`.
- **Manage implies view.** A role that holds a manage code also holds the reads that go with it, because the baseline carries no financial reads and a manage screen with a 403 on its own read calls renders empty. `MANAGE_IMPLIES_VIEW` in `permissions.ts` lists each manage code with its reads (time entries and invoices also imply `billing.viewRates` for the charge-code picker; `billing.recordPayments` implies `billing.viewInvoices`; `trust.manage` and `trust.reconcile` imply `trust.view`), and the pure `withImpliedViewPermissions(codes)` applies it: it de-duplicates, keeps unknown codes, appends missing reads in map order, and is idempotent. `roles.repository.ts` overrides `create` and `update` to run every written `permissions` array through it, so the firm roles API, the platform admin console and built-in seeding all store normalized roles. Removing a manage code never removes its read, since the member may still want to view. Baseline reads (matters, tasks, clients, files and the like) are not listed because they are always held, and `billing.manageOthersTimeEntries` is not listed because it only widens `billing.manageTimeEntries`. Migration `0027_manage_implies_view_backfill.sql` appends the implied reads to every existing role, built-in or custom, one statement per manage code in map order, touching only roles that are missing one, and removing nothing. Built-in definitions equal their own closure. To add a manage code, add its entry to the map, regenerate the matching statement in a new migration, and mirror the map in the frontend constants. Pinned in `backend/tests/permissions/manageImpliesView.test.ts` and `manageImpliesViewBackfill.test.ts`, which fails if the SQL's pairs differ from the map.
- **Built-in role protections**: can't rename a built-in role (`roles.service.ts:121-123`); can't delete the `Owner` role, but Admin, Attorney, Paralegal and Staff can be deleted (`:152-154`). Deleting a role nulls `members.role_id` and `invitations.role_id` through their single-column FKs, so holders fall back to the baseline. Editing permissions and deleting a role both emit `ROLE_PERMISSIONS_CHANGED` (`:136,162`).
- **Plan limit resolution order** (`getEffectiveLimits`, `planDefinitions.ts:194-215`): `unlimitedOverride` → all unlimited (storage still capped at 50 GB); else `limitOverrides` > `PLAN_TIERS[planId]`. `-1` = unlimited. Feature resolution (`getEffectiveFeatures`, `:217-237`): `unlimitedOverride` → all true; else `{ ...plan.features, ...featureOverrides }`.

#### The tiers

Four tiers, defined in `planDefinitions.ts:3-112`. Starter has no Stripe price (`stripePrices.ts` maps only basic/professional/enterprise), so it is not self-serve purchasable. It remains `DEFAULT_PLAN_ID`, the fallback `getPlanById`/`getEffectiveLimits`/`getEffectiveFeatures` resolve to when a firm has no `planId` at all, or an unresolved one (`planDefinitions.ts:1,143-157,205,232`). New self-serve firms no longer start here, though: `createLawFirm` (`lawfirms.service.ts`) now seeds every new firm directly on Professional with `billingStatus: 'trialing'` and a 14-day `trialEndsAt` (see below), and `adminCompFirm` defaults an unset `planId` to Professional too. Starter is reached today only via an explicit downgrade or an explicit admin override.

| | Starter | Basic | Professional | Enterprise |
|---|---|---|---|---|
| Price (monthly / annual) | — | $20 / $200 | $50 / $500 | $100 / $1000 |
| `maxMatters` | 25 | 75 | 250 | unlimited |
| `maxMembers` | 3 | 5 | 15 | unlimited |
| `storageQuotaBytes` | 1 GB | 3 GB | 10 GB | 50 GB |
| `maxFileSizeBytes` | 100 MB | 500 MB | 3 GB | 10 GB |
| clientPortal, messaging, flatFees, fileSharing | ✓ | ✓ | ✓ | ✓ |
| calendarSync, analytics, templates, trustAccounting, documentSigning | ✗ | ✗ | ✓ | ✓ |

The per-file cap is enforced on the direct-to-storage upload path: files uploads compare each declared size against the plan's `maxFileSizeBytes` (`files.upload.routes.ts:220-268`), and `enforceMaxFileSize` answers 413 `FILE_TOO_LARGE` for the other callers (`storageUsage.ts:321-343`). Template uploads use the same browser-to-storage transport but apply their own 50 MB document limit, so templates never reach the higher tier values.

#### What the counts count

- **`maxMatters`** counts every `matters` row for the firm, closed and archived ones included, since matters are hard-deleted and carry no soft-delete column (`matters.repository.ts:2088`). A firm that has closed 25 matters on Starter is at its cap; closing work does not free a slot.
- **`maxMembers`** counts seats, not just people: `members` rows **plus** outstanding `invitations` of `invite_type = 'member'`, `status = 'pending'` and not yet expired (`invitations.repository.ts:381-406`). An unaccepted, live invite holds a seat; an expired one no longer does. The accept path counts members only (`countMembers`), because the acceptor is the pending row being converted. `getSubscriptionStatus` reports the same seat figure with the same expiry predicate and breaks out `activeMembers` / `pendingInvites` (`subscriptions.service.ts:249-266`).
- **Storage** counts everything the files module tracks (firm files, client-portal uploads, message attachments), template objects (HTML bodies, DOCX sources, inline images), and the permanent signing artifacts (the filed copy and the delivery attachment). It does **not** count signing scratch (uploaded sources under `signing-uploads/`, and per-participant working copies), which is transient by design (10-day TTL, swept per session and on firm deletion), nor firm logos and profile photos.

#### Downgrades are grandfathered, not reconciled

Nothing listens for `SUBSCRIPTION_UPDATED` or `SUBSCRIPTION_PLAN_CHANGED`, and `changePlan` does not compare the target tier against current usage (`subscriptions.service.ts:149-176`). A firm that drops from Professional (15 seats, 10 GB) to Starter (3 seats, 1 GB) keeps every existing member and file; only the *next* create is refused, and uploads are refused until it is back under quota. Users are not warned at checkout that they will land over their new limits. This is the current behavior by omission rather than by decision. See Improvements.
- **Unknown planId is loud, not silent** (`planDefinitions.ts:143-157`): `getPlanById` falls back to Starter to keep requests functional, but a non-empty unresolved `planId` logs a misconfiguration error. `assertPlanTiersValid()` (`:164-180`) runs once at module load, so a bad tier table fails at boot.
- **Comped / override / unlimitedOverride**: `comped` is a billing fact ("do not invoice or paywall this firm"), not an entitlement, so comped firms keep their planId's limits; the reasoning is written beside `BILLING_ACTIVE_STATUSES` (`planEnforcement.ts:40-58`). The entitlement bypasses are `unlimitedOverride` (everything) and `limitOverrides`/`featureOverrides` (per-resource). New self-serve firms are NOT created comped: `createLawFirm` seeds `planId: 'professional'`, `billingStatus: 'trialing'`, `comped: false`, a 14-day `trialEndsAt`, and `trialConsumed: true`, plus the typed storage quota, built-in roles, the owner membership, default practice areas, charge codes, a lead pipeline and an intake form (`lawfirms.service.ts:37-100`). A no-card trial has no Stripe subscription, so `isFirmBillingActive` expires it itself once `trialEndsAt` passes (`planEnforcement.ts:64-68`). Only admin tooling (`adminCompFirm`, which cancels any live subscription and defaults to the firm's current plan, else Professional, `admin.service.ts:945-983`; and the admin test-firm seeder) creates comped firms.
- **Firm cap per user**: `MAX_LAW_FIRMS_PER_USER` (env, default 1) blocks creating more firms (`userLimits.ts`, `lawfirms.service.ts:42-44`). An invite to an existing user already at the cap becomes a pending invite; accepting it returns 409 `FIRM_SWITCH_REQUIRED` until the user confirms leaving their current firm (`invitations.service.ts:201-209,373-409`).
- **Firm deletion is soft-delete with a retention window, not immediate.** `requestLawFirmDeletion` (`lawfirms.service.ts:227`; owner-initiated via `DELETE /api/lawfirms/:lawFirmId`, or fired when the sole owner leaves) stamps `pending_deletion_at` / `deletion_purge_after` (default 10 years, `FIRM_DELETION_RETENTION_YEARS`, `:30`) and, after commit, emits `LAWFIRM_DELETION_REQUESTED` to drop the firm's permission-cache entries before releasing external resources (Stripe subscription, calendar sync). The firm becomes inaccessible immediately (`findByUserIdWithRole` and `assertLawFirmMembership` treat a pending-deletion firm as gone). `purgeEligibleFirms` (`:296`) runs from `POST /api/cron/housekeeping` (`app.ts:754`) and calls `purgeLawFirm` for each firm past its window: only then does the row cascade, GCS files get purged, and `LAWFIRM_DELETED` fires. `assertLawFirmIsDeletable` (`:160`) blocks the purge while a matter or client is under legal hold or while the firm has permanent trust-ledger activity, so such a firm stays pending indefinitely. `restoreLawFirm` (`:245`, `POST /:lawFirmId/restore-deletion`) undoes a pending soft-delete.

### Subscription lifecycle (`modules/subscriptions`)

Self-serve billing for the firm's own Paralegix plan (distinct from Stripe Connect, which collects the firm's client payments; see [Stripe Payments](/features/stripe-payments)).

**Routes** (`subscriptions.routes.ts`, mounted at `/api/lawfirms/:lawFirmId/subscriptions`, `app.ts:919`, exempt from the billing gate so a locked firm can pay):

| Method & Path | Permission | Service |
|---|---|---|
| `POST /checkout` | `settings.manageFirm` | `createCheckoutSession` (`subscriptions.service.ts:123`) |
| `POST /portal` | `settings.manageFirm` | `createPortalSession` (`:220`), Stripe billing portal |
| `GET /status` | `members.view` | `getSubscriptionStatus` (`:235`) |
| `POST /change-plan` | `settings.manageFirm` | `changePlan` (`:149`) |
| `POST /cancel` | `settings.manageFirm` | `cancelSubscription` (`:178`) |
| `POST /reactivate` | `settings.manageFirm` | `reactivateSubscription` (`:196`) |

- **Checkout** refuses a firm that already has an active/trialing/past_due subscription, creates the Stripe customer on first use, and offers a 14-day trial only if the firm is not comped, has never had a subscription, and has not `trialConsumed` (`:94-147`). The subscription carries `metadata.lawFirmId`, which is how every webhook finds the firm.
- **Change plan** swaps the price on the existing subscription item with `create_prorations` and emits `SUBSCRIPTION_PLAN_CHANGED`; the plan columns change only when the resulting webhook lands (`:149-176`).
- **Cancel** sets `cancel_at_period_end` on Stripe and `cancelAtPeriodEnd` on the plan; **reactivate** reverses it unless the subscription has already ended (`:178-218`).
- **Status** returns plan, billing state, trial/period dates, the owner's name and email (so a locked member knows whom to ask), usage against limits, and the effective feature map in one query (`:235-317`).

**Webhook** (`POST /api/webhooks/stripe-subscriptions`, raw body, mounted before `express.json()` at `app.ts:362`; `subscriptions.webhook.routes.ts`). The signature is checked against `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, then the event id is claimed in the `subscriptions` half of the `stripe_events` ledger (`10_identity.sql`) so a finished duplicate acks 200 and is skipped, one still in flight gets 409 so Stripe retries, and a processing failure releases the claim and 500s so Stripe retries. See /dev/ops/webhooks for the full protocol.

| Stripe event | Handler | Effect |
|---|---|---|
| `customer.subscription.created` / `.updated` | `handleSubscriptionChange` (`:342`) | Maps the price to a tier (`planFromPriceId`), writes plan + status + period + Stripe ids via `mergePlan`, sets `trialConsumed` when trialing, re-syncs the storage quota, emits `SUBSCRIPTION_UPDATED`. Ignores a terminal status, an event for the `canceledSubscriptionId`, and an event whose period starts before the stored one. |
| `customer.subscription.deleted` | `handleSubscriptionDeleted` (`:426`) | Status `canceled` (the firm hits the paywall; there is no free fallback tier), clears the Stripe pointers, records `canceledSubscriptionId`, drops the quota to Starter's, emits `SUBSCRIPTION_CANCELLED`. Ignored if the firm already has a different subscription. |
| `customer.subscription.trial_will_end` | `handleTrialEnding` (`:485`) | Emits `SUBSCRIPTION_TRIAL_ENDING`. |
| `invoice.paid` | `handleSubscriptionInvoicePaid` (`:497`) | Re-derives status from the live subscription (never forces `active`) and records `lastPaymentAt`/`lastPaymentAmount` when money moved. |
| `invoice.payment_failed` | `handlePaymentFailed` (`:524`) | Sets `past_due`; emits `SUBSCRIPTION_PAYMENT_FAILED` only on the transition into `past_due`, so dunning retries alert once. |

Stripe statuses map straight across (`mapSubscriptionBillingStatus`, `:77-82`); anything off the CHECK list is normalized by `mergePlan`.

**Listeners** (`subscriptions.events.ts:73-125`): payment failure and trial ending each email the firm's admins and create an in-app notification (`subscription_payment_failed`, `subscription_trial_ending`) for them.

**Reconcile sweep**: `POST /api/cron/reconcile-billing` (`app.ts:688-693`) runs `reconcileBillingStatuses` (`subscriptions.service.ts:577-638`), which retrieves the live subscription for every firm with one (oldest first, bounded by count and a shared deadline), skips comped and unlimited firms, and re-runs the canonical webhook handler only where the stored status diverges. A price id missing from the plan map is reported as a failure rather than counted as reconciled.

### The Permission Cache (detail)

`permissionCache.ts` is an in-process bounded cache (`createBoundedCache`, `:47-51`) with a 30s `TTL_MS` and an LRU ceiling of `PERMISSION_CACHE_MAX_ENTRIES` (default 5000), keyed `"${lawFirmId} ${userId}"` (a space separator that cannot appear in an id, `:53-59`). It stores the shaped member object **with `resolvedPermissions` attached**. `get` and `set` copy both the object and the array so a caller mutating `req.member` cannot corrupt the entry (`:70-94`). A miss returns `undefined` (never an empty/full set) so the caller resolves fresh; the cache never fails open or fabricates permissions.

`invalidateFirm` is a prefix sweep over the bounded store (`:106-113`). The earlier `firmIndex` secondary map was removed because it was itself an unbounded map of every firm id ever seen.

Invalidation (`permissionCache.events.ts`, registered at `app.ts:141`):
- `MEMBER_ROLE_CHANGED` → `invalidate(lawFirmId, userId)` (`:23-29`)
- `MEMBER_REMOVED` → `invalidate(lawFirmId, userId)` (`:33-39`)
- `ROLE_PERMISSIONS_CHANGED` → `invalidateFirm(lawFirmId)` (`:44-50`)
- `LAWFIRM_DELETION_REQUESTED` → `invalidateFirm(lawFirmId)` (`:55-61`)

**Emitters:**
- Firm-facing: `members.service` `removeMember` → `MEMBER_REMOVED` (`:106`); `changeRole` → `MEMBER_ROLE_CHANGED` (`:150`); `transferOwnership` → `MEMBER_ROLE_CHANGED` ×2 (`:213-224`); `leaveFirm` → `MEMBER_REMOVED` (`:283,290`); `roles.service` `updateRole`/`deleteRole` → `ROLE_PERMISSIONS_CHANGED` (`:136,162`).
- Admin (`admin.service.ts`): `updateLawFirmRole` → `ROLE_PERMISSIONS_CHANGED` (`:389`); `updateMemberRole` → `MEMBER_ROLE_CHANGED` only when `member.userId` is present, else logs and skips (`:505-509`); `removeMember` → `MEMBER_REMOVED` (`:545`).

The TTL is the backstop for any missed invalidation. The cache is process-local: under multiple backend instances an invalidation on one does not clear the others (the TTL still bounds staleness). See Improvements.

### Dependencies

- **Firebase Auth**: `auth.verifyIdToken` on every request. Identity = Firebase UID = `users.id` = `members.user_id`.
- **Stripe**: subscription lifecycle (see above). Plan ↔ price mapping in `shared/plans/stripePrices.ts` from six `STRIPE_*_{MONTHLY,ANNUAL}_PRICE_ID` env vars.
- **GCS**: firm logo + file storage; storage quota tracked on `law_firms`.
- **Event bus**: emits `MEMBER_ADDED`, `MEMBER_REMOVED`, `MEMBER_ROLE_CHANGED`, `ROLE_PERMISSIONS_CHANGED`, `LAWFIRM_DELETION_REQUESTED`, `LAWFIRM_DELETED`, `SUBSCRIPTION_*`.
- **Cron**: `/api/cron/housekeeping` (firm purge) and `/api/cron/reconcile-billing`.

### Example: `PlanLimitError` response

A Starter firm (limit `maxMembers: 3`) already has 3 members/pending invites and tries to invite a 4th. `enforceCountLimit` throws `PlanLimitError('maxMembers', { current: 3, limit: 3, planId: 'starter' })` (`planEnforcement.ts:128-134`), surfaced as:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "Plan limit reached: maxMembers",
  "code": "PLAN_LIMIT_REACHED",
  "details": { "resource": "maxMembers", "current": 3, "limit": 3, "planId": "starter" }
}
```

The frontend keys off `code === 'PLAN_LIMIT_REACHED'` to render a contextual upgrade prompt.

---

## What Can Be Improved

Ordered by impact. Server-side unless noted.

> **Resolved and dropped:** the feature-gate order; calendar provider-push coverage; `plan_id`/`billing_status` drift (the columns are now authoritative, no trigger); `invalidateFirm` cost (prefix sweep over a bounded cache); the double `verifyToken` on gated routers (the repeat pass now short-circuits, `auth.ts:231-240`); the calendar gate running before membership (`requirePermissionFrom(..., 'calendar.sync')` now runs first, and `requireFeature` only answers members); count-then-insert races on matter create, invite accept and direct member add (firm-row lock, see the plan-limit flow step 8); the unreachable per-file cap on file uploads (direct-to-storage, checked against the plan); the missing tests for plan limits and feature gates (`backend/tests/plans/planEnforcement.test.ts`, `featureGateRouteMatrix.test.ts`, `billingLockout.test.ts`); role edits as an escalation path; ownership transfer leaving the old owner on the baseline when Admin was deleted; deleting an in-use role failing with 500.

### STILL-OPEN

1. **A downgrade is never reconciled and never warned about.** `changePlan` (`subscriptions.service.ts:149-176`) swaps the Stripe price without comparing the target tier's limits against current usage, and nothing subscribes to `SUBSCRIPTION_UPDATED` or `SUBSCRIPTION_PLAN_CHANGED`. A firm can move to a tier it is already over and only discovers it at the next create or upload. Two separate pieces of work: a pre-checkout warning ("you have 12 members; Starter allows 3"), and a decision about what the over-limit state should mean, which today is grandfathering by omission.

2. **Per-role RBAC is off unless an env var says otherwise.** `RBAC_ENFORCED` defaults to false, and while it is false every member of a firm resolves to `ALL_PERMISSIONS` (`roles.service.ts:17,181,228`). Every permission code, the escalation guards and the role editor are then inert apart from owner-only checks. Whether production sets the flag is not visible in the repo. At minimum, log it at boot the way the email whitelist does.

3. **Sending a member invite still counts without a lock.** `inviteMember` checks `countMembersAndPendingMembers` (`invitations.service.ts:161`) and then inserts the pending invite with no firm-row lock, so two invites at `limit - 1` can both be created. The overshoot cannot become a seat (accept re-checks real members under `lockFirmForSeatCheck`), but the seat figure the firm sees can briefly exceed the plan.

4. **No frontend gate for analytics.** Every other plan-gated feature has a `RequireFeature` wrapper or an in-component `features.*` check; analytics has neither, so a firm without it sees the billing analytics UI and gets 403s from `/billing/analytics/*` (`app.ts:874`).

5. **Signing scratch storage is deliberately unaccounted.** Uploaded signing sources (`signing-uploads/`) and per-participant working copies are not charged against the firm quota; only the filed copy and the delivery attachment are (transient, 10-day TTL). Worth revisiting if signing volume makes the untracked footprint material.

6. **Template uploads stop at 50 MB whatever the plan says.** The direct-upload init/finalize routes enforce a 50 MB document cap, below every tier's `maxFileSizeBytes`. Probably right for templates, but the plan table should say so.

7. **Count-limit enforcement runs a `COUNT(*)` plus an uncached plan load per create.** For unlimited plans the count is skipped (`planEnforcement.ts:124`), but `loadFirmPlan` (`:17-38`) still runs on every create, and the locked re-check runs a second one. `opts.firmData` exists to avoid the repeat load (`:106-114`) but the create paths don't pass it. Options: a denormalized counter (the `firm_counters` table pattern exists), or fold the plan load into the count query.

8. **The permission cache is process-local.** `permissionCache.ts` holds a module-level bounded store (`:47-51`). Under more than one backend instance an invalidation on one does not reach the others, so a permission change is only guaranteed effective after the 30s TTL elsewhere. Acceptable given the TTL; move to a shared store or pub-sub if instances scale and that window matters.

9. **Batch calendar routes are gated against the first item's firm only.** `firmIdFromItems` takes the body `lawFirmId`, else the first array item's (`calendarSyncGates.ts:21-29`), so a mixed-firm batch passes the permission and plan gates for one firm; the per-item membership assertion in the handler is what contains it.

10. **Member-add / owner-seed paths don't pre-warm the cache, and shouldn't.** `members.repository.addMember` and the owner seed don't populate `permissionCache`. This is correct (the next request resolves and caches naturally). Documented to prevent a regression; no action needed.
