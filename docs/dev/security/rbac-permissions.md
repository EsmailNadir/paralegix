# Roles & Permissions

How Paralegix authorizes an authenticated firm member: the permission catalog, per-route enforcement, the resolution rules, the process-local cache, and the plan-tier ceiling layered on top.

## Summary

Authorization has two independent layers that both must pass:

1. **RBAC** — does this member hold the permission this route requires? Enforced
   by `requirePermission('domain.action')` after `verifyToken`. A member's
   effective permission set is resolved from their assigned role
   (`members.role_id` → `roles.permissions`, a Postgres `text[]`), unioned with a
   universal baseline. The firm **owner** (`members.is_owner`) bypasses every
   check.
2. **Plan enforcement** — even a permitted action is capped by the firm's
   subscription tier. `enforceCountLimit` blocks creates past a tier's numeric
   cap (`403 PLAN_LIMIT_REACHED`); `enforceFeatureAccess` / `requireFeature` gate
   whole features (`calendarSync`, `analytics`, `templates`, `trustAccounting`,
   `documentSigning`) behind the tier.

RBAC lives in `backend/src/modules/lawfirms/roles/`; plan enforcement lives in
`backend/src/shared/plans/`.

## Key Takeaways

- **The owner short-circuits.** `requirePermission` returns early for
  `member.isOwner` before any permission-array check
  (`requirePermission.ts:111`). An owner implicitly holds every permission.
- **RBAC has a master switch, default OFF.** `RBAC_ENFORCED` (env) gates
  per-role enforcement. When off (the default), every firm **member** resolves to
  the full permission set, so no feature is blocked — but non-members still
  resolve to `[]` and are rejected. Turn it on to enforce real per-role limits.
- **Fail closed, never fail open on error.** A non-member resolves to `null`
  → `403`. A member with no/dead role resolves to the baseline only. A genuine DB
  error **propagates as 500** — it is never silently converted into an empty
  set (a wrongful deny) or granted permissions.
- **The permission cache is process-local.** Resolved sets are memoized in an
  in-memory `Map` with a 30s TTL, invalidated on the relevant mutations. On a
  multi-instance deployment each instance has its own cache, so an explicit
  invalidation on one instance does not reach the others — staleness is bounded
  by the 30s TTL there.
- **Plan is a ceiling, not a grant.** A feature the plan lacks is always denied;
  no firm-level setting can grant it. Within a plan-allowed feature, a firm can
  still opt out (`settings.features[feature] === false`).

## The permission catalog

`backend/src/modules/lawfirms/roles/permissions.ts` defines every permission
string as `domain.action` (e.g. `matters.create`, `billing.recordPayments`,
`trust.reconcile`, `clients.erase`). `ALL_PERMISSIONS` is the full key list.

- **`DEFAULT_PERMISSIONS`** (`permissions.ts:147`) is the always-on baseline
  unioned into every member's set. It covers the universal chrome
  (`dashboard.view`, `members.view`, `settings.viewFirm`, `messaging.view`,
  `messaging.send`, `calendar.view`, `templates.view`, `practiceAreas.view`,
  `noteTypes.view`, `noteTemplates.view`) and every read-only view of core
  records and money: `matters.view`, `tasks.view`, `files.view`,
  `signatures.view`, `leads.view`, `contacts.view`, `clients.view`, the
  `billing.view*` codes (time entries, invoices, rates, plans, expenses) and
  `trust.view`. It still excludes every write/manage action (including
  `trust.manage` / `trust.reconcile`) and all firm administration
  (`firm.viewAuditLog`, `settings.manageFirm`, `members.changeRole`). Because the
  baseline can never be removed from a role, a read permission here cannot be
  denied to anyone, so per-record access for those reads comes from the service
  layer (matter membership, the ethical wall), not from RBAC. Only permissions
  you would never deny anyone belong here.
- **`BUILT_IN_ROLES`** (`permissions.ts:177`) seeds five roles per firm at
  creation: `Owner` (all), `Admin` (all except `firm.transferOwnership`),
  `Attorney`, `Paralegal`, and `Staff` (progressively narrower). Built-in roles
  cannot be renamed, and their permission arrays can be customized. Only the
  `Owner` role is protected from deletion (`deleteRole` in `roles.service.ts`);
  a firm can delete `Admin` or any other built-in role.

## Per-route enforcement

The standard middleware chain, per `backend/AGENTS.md`, is:

```
verifyToken → requirePermission → validate → requireTimezone → handler
```

`verifyToken` establishes identity (`req.user.uid`). `requirePermission` then
runs in `backend/src/modules/lawfirms/roles/requirePermission.ts`:

1. Reads the firm id strictly from `req.params.lawFirmId` (never a fallback
   `:id` — a route with a different `:id` could otherwise authorize against the
   wrong firm). Missing id → `403`. A non-uuid id is refused as
   `403 Not a member of this firm` before any query, rather than surfacing as a
   Postgres cast error (500).
2. Loads the resolved member via `loadResolvedMember(lawFirmId, userId)`, which
   checks the cache, then on a miss does a **single `members ⋈ roles` JOIN**.
3. Non-member → `403 Not a member of this firm`.
4. `member.isOwner` → pass immediately, attach `req.member`.
5. Otherwise the member must hold the permission. `requirePermission` also
   accepts an array, meaning any one of the listed codes passes (for example
   `requirePermission(['clients.manage', 'clients.erase'])`). A miss is a `403`
   whose `details.requiredPermission` lists the accepted codes.

A sibling `resolveMember()` attaches `req.member` without requiring a specific
permission, for routes any member may hit. For the few route families that carry
the firm id somewhere other than `:lawFirmId` (calendar sync puts it in the
body), `requirePermissionFrom(getFirmId, permission)` and
`assertFirmPermission(lawFirmId, userId, permission)` apply the same resolution
and owner bypass.

The files module does not use `requirePermission` per route. Its router gates
through one `routePermissions` Map keyed on `"<METHOD> <path>"`
(`backend/src/modules/files/files.routes.ts:32`). The path is lowercased before
the lookup because Express routing is case-insensitive, and a route with no Map
entry is refused (`files.routes.ts:90`) rather than waved through.

## Permission resolution

`resolvePermissions(lawFirmId, member)` and the query-free
`resolveFromRolePermissions(member, rolePermissions)` in `roles.service.ts`
compute the effective set with identical semantics:

| Case | Result |
|---|---|
| no member | `[]` (fail closed → `403`) |
| `member.isOwner` | `ALL_PERMISSIONS` |
| `RBAC_ENFORCED` off (default) | `ALL_PERMISSIONS` |
| member, no role / role gone | `DEFAULT_PERMISSIONS` (baseline) |
| member with a role | role's `permissions` unioned with `DEFAULT_PERMISSIONS` |

`withBaseline()` (`roles.service.ts:23`) does the de-duplicated union, so a role
seeded before a baseline permission existed still gets it at read time without a
table backfill. `resolvePermissions` deliberately does **not** swallow DB errors:
a transient failure rethrows (→ 500) rather than masquerading as a silent deny.
The `<domain>` prefix on a permission has no special meaning to the resolver — it
is an exact-string membership test.

Deleting a role sets its members' `role_id` to `null` via the FK
(`members ... on delete set null`), so they fall back to the baseline; no member
row is removed. `members.role_id` and `invitations.role_id` are deliberately
**single-column** foreign keys (`backend/db/schema/10_identity.sql:224`,
`90_platform.sql:107`): a composite `(law_firm_id, role_id)` key with
`on delete set null` would null `law_firm_id` too and fail the delete. Tenant
scoping is unaffected because the resolver fetches the role with its own
`law_firm_id` predicate.

## Escalation and ownership guards

Holding a management permission is not enough to hand out more than you have:

- **Roles.** `createRole` and `updateRole` call `assertNoPermissionEscalation`
  (`roles.service.ts:86`), so a non-owner with `firm.manageRoles` cannot build or
  edit a role holding permissions they lack themselves. Before this guard, editing
  your own role granted every permission, including `members.changeRole`, which
  is what `isFirmOwnerOrAdmin` reads for firm-wide matter visibility.
- **Members and invitations.** `changeRole`
  (`backend/src/modules/lawfirms/members/members.service.ts:132`) and invite
  creation (`backend/src/modules/invitations/invitations.service.ts:175`) compare
  the target role's effective set against the acting member's.
- **Ownership transfer.** `firm.transferOwnership` can be satisfied by a custom
  role, so the service also requires `actingMember.isOwner`
  (`members.service.ts:173`); that check is the one no role can satisfy. The
  outgoing owner is moved to `Admin`, and because a firm can delete `Admin`,
  the transfer first re-seeds any missing built-in role
  (`seedBuiltInRoles`, `members.service.ts:200`) instead of leaving the old owner
  on the baseline.

## The permission cache

`backend/src/modules/lawfirms/roles/permissionCache.ts` memoizes the resolved
member (with `resolvedPermissions` attached) keyed by **both** `(lawFirmId,
userId)`, with a 30s TTL:

- **Safe by construction.** This stores a derived permission set (never an auth
  token or identity), and the
  compound key means one user's entry can never be served for another user or
  firm. A cached copy is returned so a caller mutating `req.member` cannot
  corrupt the entry.
- **Never fails open.** A miss returns `undefined` so the caller resolves fresh;
  the cache never fabricates an empty or full set on its own.
- **Explicit invalidation.** `permissionCache.events.ts` listens for
  `MEMBER_ROLE_CHANGED` and `MEMBER_REMOVED` (invalidate that member) and
  `ROLE_PERMISSIONS_CHANGED` (invalidate the whole firm, since the cache key is
  per-member, not per-role). `LAWFIRM_DELETION_REQUESTED` also drops the whole
  firm, so a soft-deleted firm locks its members out immediately. A `firmIndex`
  secondary index makes the firm-wide drop O(firm members).
- **Single-instance caveat.** The `Map` is per-process. On multiple Cloud Run
  instances an invalidation only clears the instance that handled the mutation;
  other instances keep their cached set until the 30s TTL expires. The 30s TTL is
  the cross-instance staleness bound.

## Plan enforcement (the tier ceiling)

Plan data lives on the `law_firms` row (`plan` jsonb + `plan_id` /
`billing_status` columns). Tiers are defined in code in
`backend/src/shared/plans/planDefinitions.ts` — `starter`, `basic`,
`professional`, `enterprise` — each with numeric `limits` and boolean
`features`. `getEffectiveLimits` / `getEffectiveFeatures` apply per-firm
`limitOverrides` / `featureOverrides`, and `unlimitedOverride` bypasses all
numeric caps.

`backend/src/shared/plans/planEnforcement.ts` provides:

- **`enforceCountLimit(lawFirmId, resource, countFn)`** — for `maxMatters`,
  `maxMembers`, etc. `UNLIMITED` (`-1`) short-circuits before any `COUNT(*)`; at
  or over the limit it throws `PlanLimitError` → `403 PLAN_LIMIT_REACHED` with
  `{ resource, current, limit, planId }`.
- **`enforceFeatureAccess(lawFirmId, featureName)`** — a feature passes only when
  **both** the plan allows it (the ceiling — plan-deny always wins) **and** the
  firm has not opted out via `settings.features[featureName] === false`. Denied
  → `ForbiddenError` (403).
- **`assertFirmBillingActive(firmData)`**: the shared paywall. Throws
  `402 BILLING_INACTIVE` unless `billing_status` is `active`, `trialing` or
  `comped`, or the plan carries a `comped` / `unlimitedOverride` flag
  (`BILLING_ACTIVE_STATUSES`, `planEnforcement.ts:58`). A no-card trial (no Stripe
  subscription) also fails once `trialEndsAt` has passed. A missing status fails
  **closed** (`incomplete`), never granting access.

`backend/src/shared/plans/requireFeature.ts` wraps these as route middleware.
Per its own header, it must be placed **after** `verifyToken` (and
`requirePermission` where present): the plan gate is a ceiling on top of
authorization, not a substitute for it. It also runs `assertFirmBillingActive`,
which matters for feature routers (e.g. calendar sync) that mount outside the
`/api/lawfirms/<lawFirmId>` workspace gate — otherwise a lapsed firm would keep a
paid feature just because its route isn't under that gate. When no firm id can be
resolved it no-ops and lets downstream membership/validation handle it; it never
fabricates access.

## Source

- `backend/src/modules/lawfirms/roles/permissions.ts` — catalog, baseline, built-in roles
- `backend/src/modules/lawfirms/roles/requirePermission.ts` — route middleware + owner bypass
- `backend/src/modules/lawfirms/roles/roles.service.ts` — `resolvePermissions`, `RBAC_ENFORCED`
- `backend/src/modules/lawfirms/roles/permissionCache.ts` — process-local cache
- `backend/src/modules/lawfirms/roles/permissionCache.events.ts` — invalidation listeners
- `backend/src/modules/lawfirms/members/members.service.ts`: `changeRole` escalation guard, `transferOwnership`
- `backend/src/modules/invitations/invitations.service.ts`: invite escalation guard
- `backend/src/modules/files/files.routes.ts`: files `routePermissions` Map
- `backend/src/shared/plans/planEnforcement.ts` — count/feature/billing enforcement
- `backend/src/shared/plans/requireFeature.ts` — feature-gate middleware
- `backend/src/shared/plans/planDefinitions.ts` — tiers, limits, features, overrides

## Related

- [/dev/security/auth-tokens](/dev/security/auth-tokens) — establishing identity first
- [/dev/security/multi-tenancy](/dev/security/multi-tenancy) — firm scoping and membership
- [/dev/admin/rate-limiting](/dev/admin/rate-limiting) — abuse throttling
