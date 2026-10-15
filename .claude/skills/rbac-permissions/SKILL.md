---
name: rbac-permissions
description: Adding, renaming or removing a permission code; editing a role; changing what a member can see or do; debugging a 403 or a page that renders empty for one role.
---

# RBAC and permissions

A permission change is never one file. Five places must agree, and the failure mode when they do
not is silent: a member sees a page with nothing on it, or a 403 arrives from a route the UI
already let them click.

## The five places

| # | File | What it holds |
|---|---|---|
| 1 | `backend/src/modules/lawfirms/roles/permissions.ts` | `PERMISSIONS` (the code and its description), `DEFAULT_PERMISSIONS` (the member baseline), `BUILT_IN_ROLES` |
| 2 | `frontend/src/lib/constants/permissions.ts` | The mirror of all three. It is a hand-kept copy, not generated |
| 3 | `backend/src/modules/<domain>/<domain>.routes.ts` | `requirePermission('code')` in the middleware chain |
| 4 | The frontend surface | `usePermissions().hasPermission('code')` to degrade the UI |
| 5 | `backend/tests/permissions/` | Thirteen specs that pin the boundary. `permissionBoundary.test.ts` asserts the exact 17-code baseline as a list |

**Permission data in files 1 and 2 must stay in sync.**
`frontend/tests/lib/permissionsParity.test.ts` checks codes, the member baseline, built-in role
permissions, the manage-implies-view map and helper outputs. Run that spec after changing either
file; it compares code sets rather than line counts or unrelated formatting.

## The member baseline

Every firm member holds a 17-code baseline (`DEFAULT_PERMISSIONS`), unioned into the resolved set
at read time on both sides independently. Consequences:

- **A baseline permission can never be taken away by a role.** Only add a code to
  `DEFAULT_PERMISSIONS` if you would never want to deny it to anyone.
- **An empty role holds only the collaboration baseline.** Financial reads require explicit
  grants. Use an empty-role member to test financial denial and a non-member to test membership.
- The baseline is read-only page visibility plus navigation, with one write: `messaging.send`.
  Every other write, every `manage`, every `trust.manage`/`reconcile`, and all firm
  administration are deliberately excluded.
- The real confidentiality boundary is **row-level**, not page-level. Matters and matter-linked
  billing lists already filter to the matters a non-owner, non-admin member belongs to
  (`isFirmOwnerOrAdmin` from `backend/src/shared/utils/membership.ts` drives the matter filter in
  `matters.service.ts`; `firmBilling.service.ts` scopes through `getAccessibleMatters`).
  Granting the page does not grant the rows.

## Pages degrade, they never deny

Core collaboration pages render in a read-only state when a member lacks write permissions.
Financial pages require their explicit read permission and use the existing denial state when
it is absent. Hide or disable write affordances when read access is granted. A denial screen was the pattern that produced the `clients.view`
baseline decision, which is documented in the comment above `DEFAULT_PERMISSIONS`.

Before widening the baseline to fix an empty page, audit the routes that page calls. The gap is
usually a missing `requirePermission` code on one route, not a missing baseline entry.

## Existing firms hold stale role rows

Built-in roles are seeded per firm at creation time. A role seeded before a permission existed
does not have it. `DEFAULT_PERMISSIONS` covers that for baseline codes, because it is unioned at
read time. For a non-baseline code added to a built-in role, existing firms need the resync:

```bash
npx tsx backend/scripts/resync-builtin-roles.ts
```

It resets built-in roles to the canonical `BUILT_IN_ROLES` definitions and leaves custom roles
untouched. It is idempotent, and it writes to whatever `DB_TARGET` selects. Run it on local
whenever you change `BUILT_IN_ROLES`. Run it on staging (`DB_TARGET=staging`) only when the user
asks in that request: staging is a shared database.

## Checklist

1. Add the code and its description to `PERMISSIONS` in the backend file.
2. Mirror it into `frontend/src/lib/constants/permissions.ts`.
3. Decide baseline or not. If baseline, add it to **both** `DEFAULT_PERMISSIONS` arrays and
   confirm you would never deny it to any member.
4. Add it to the right `BUILT_IN_ROLES` entries in both files.
   A new manage code that is unusable without a read that is not in the baseline also goes in
   `MANAGE_IMPLIES_VIEW` (both files), with a backfill migration for existing roles.
5. Guard the route with `requirePermission('code')`, after `verifyToken` and before `validate`.
6. Gate the UI with `hasPermission`. Degrade to read-only; never deny.
7. Update `backend/tests/permissions/`. Adding a code to `DEFAULT_PERMISSIONS` WILL turn
   `permissionBoundary.test.ts` red, because it asserts the baseline as an exact list. That red
   is the test working. Update the list there deliberately, and check
   `memberPermissionResolution`, `roleEscalation` and `writeGrantBoundary` in the same directory.
8. Write a route test where the caller holds everything **except** the new code, and assert the
   403. Then one where the caller is from another firm, and assert the refusal.
9. If you changed `BUILT_IN_ROLES`, run `resync-builtin-roles.ts` on local, and name staging's
   pending resync in your report rather than running it unasked.

## Testing

The frontend harness has baseline-aware presets in `frontend/tests/support/permissions.ts`:
`grantBaselineMember([extra])`, `grantReadOnly()`, `grantOutsider()`, `grantPermissions([...])`.
Reach for a baseline preset when the case is about a person; `grantPermissions` is an exact set,
for a case about what a component is told. **Call `resetPermissions()` in `afterEach`.** The
object is shared, and a spec that narrows it without restoring breaks an unrelated later spec.

On the backend, `memberWith(firm, [codes])` from the in-process harness builds the caller. Clear
the permission cache between changes with the `caches.ts` helper, or a spec reads a value
resolved before its own change and passes for the wrong reason.
