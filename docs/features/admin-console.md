# Platform Admin Console

## Summary

The platform admin console is the internal operator surface for Paralegix staff. It is the one place in the product that deliberately reads and writes across every law firm: it lists all firms, users, client records and sign-in events, edits firm profiles, roles, memberships, plans and Stripe subscriptions, and hosts test tooling (pre-verified test accounts and the email-verification whitelist). The backend is a single Express router, `backend/src/modules/admin/`, mounted at `/api/admin` (`backend/src/app.ts:889`). The frontend lives under `frontend/src/app/admin/` and talks to it through `frontend/src/services/admin.service.ts`.

## Key Takeaways

- **One gate for the whole surface.** `router.use(verifyToken, requireIsAdmin)` at `admin.routes.ts:34` covers all 30 routes. There is no firm permission involved: a firm owner gets nothing here.
- **Platform admin = `users.is_admin = true`, read from Postgres on every request.** `requireIsAdmin` looks the caller's uid up in the `users` table and checks `isAdmin === true` (`requireIsAdmin.ts:16-23`). Token claims are never consulted, and there is no env var or email allowlist for admins. Revocation is immediate because nothing is cached.
- **The last admin cannot be removed.** `updateUserAdmin` refuses to clear the flag when `countAdmins() <= 1` (`admin.service.ts:597-599`).
- **Cross-tenant reads use `adminQuery`, firm-detail reads stay `tenantQuery`.** Platform-wide lists are privileged Drizzle queries with a stated reason (`admin.repository.ts:121`, `:282`, `queryContext.ts:255-262`). Per-firm operations take `:lawFirmId` from the path and scope by it, so a member, role or invite id from another firm answers 404.
- **Every admin write is logged twice.** An `admin.action` security event per mutating request (`admin.routes.ts:40-49`), plus the global `audit_events` row from `auditMutations` (`audit.middleware.ts:44-90`). Neither stores the request body. See [Audit Logging](/dev/security/audit-logging).
- **No impersonation exists.** "Login inspection" is the Login Activity page, a read of `auth.login` audit events.
- **The whitelist is a security relaxation.** An address on it skips email verification. Removals can take up to 15 s to reach other instances (`emailWhitelist.ts:62-94`).

---

## How It Works

### Entry Points

**Backend routes** (all under `/api/admin`, all gated by `verifyToken` + `requireIsAdmin` at `admin.routes.ts:34`; "Zod" means a `validate(...)` schema from `admin.validation.ts`)

| Method & Path | Does | Zod | Line |
|---|---|---|---|
| `GET /outbox-health` | Event-outbox row counts (all zeros unless `EVENT_OUTBOX_WORKER=true`) | none | `:59` |
| `GET /lawfirms` | All firms (unpaged, capped) or a page with `stats` when `limit`/`search` is given | yes | `:70` |
| `GET /lawfirms/lookup` | Firm typeahead, `{ items, hasMore }`, max 50 | yes | `:111` |
| `GET /users` | All users (capped) or a page with `stats` and firm affiliations | yes | `:130` |
| `GET /clients` | Platform-wide `clients` records, always paged (default 50) | yes | `:165` |
| `GET /audit-events` | Cross-firm audit log (`auditService.listAllAuditEvents`) | yes | `:187` |
| `GET /lawfirms/:lawFirmId` | Firm detail: members, roles, pending invites, clients | none | `:200` |
| `PATCH /lawfirms/:lawFirmId/roles/:roleId` | Rename a role or replace its permissions | none | `:203` |
| `PATCH /lawfirms/:lawFirmId/members/:memberId/role` | Move a member to another role | none | `:211` |
| `DELETE /lawfirms/:lawFirmId/members/:memberId` | Remove a non-owner member | none | `:218` |
| `DELETE /lawfirms/:lawFirmId/pending-invites/:inviteId` | Hard-delete a member invite | none | `:224` |
| `DELETE /lawfirms/:lawFirmId/pending-client-invites/:inviteId` | Hard-delete a client invite | none | `:230` |
| `PATCH /lawfirms/:lawFirmId` | Edit profile fields and storage config | yes | `:236` |
| `PATCH /users/:userId/admin` | Grant or revoke platform admin | yes | `:245` |
| `GET /plans` | All plan tiers | none | `:256` |
| `GET /lawfirms/:lawFirmId/plan` | Effective limits, features, usage | none | `:262` |
| `PATCH /lawfirms/:lawFirmId/plan` | Plan tier, billing status, comp, overrides | yes | `:265` |
| `POST /lawfirms/:lawFirmId/storage/recount` | Recompute stored bytes from file rows | none | `:276` |
| `GET /plan-usage` | Over-limit sweep across all firms | none | `:283` |
| `POST /lawfirms/:lawFirmId/subscription/create` | Create a Stripe subscription | yes | `:291` |
| `POST .../subscription/cancel` | Cancel now or at period end | yes | `:304` |
| `POST .../subscription/extend-trial` | Push `trial_end` out by 1 to 365 days | yes | `:314` |
| `POST .../subscription/apply-coupon` | Attach a Stripe coupon | yes | `:323` |
| `POST .../subscription/refund` | Refund the latest paid invoice, full or partial | yes | `:332` |
| `POST .../subscription/comp` | Cancel Stripe, mark the firm comped | yes | `:343` |
| `GET .../subscription/invoices` | Last 50 Stripe invoices | none | `:354` |
| `GET /whitelist` | List whitelist entries | none | `:361` |
| `POST /whitelist` | Add (upsert) an address, 201 | yes | `:364` |
| `DELETE /whitelist` | Remove an address (email in the body) | yes | `:374` |
| `POST /test-accounts` | Create a pre-verified test account, 201 | yes | `:382` |

One more admin-gated read lives outside this router: `GET /api/users/` (`users.routes.ts:15-19`).

**Frontend pages**

| Route | What it does | Backend calls |
|---|---|---|
| `/admin` | Landing grid of six sections (`admin/page.tsx:126-240`) | `getProfile` only |
| `/admin/lawfirms` | Paged firm table with plan and billing filters, profile and quota editor | `getLawFirmsPaged` (`lawfirms/page.tsx:203`), `updateLawFirm` (`:340`) |
| `/admin/lawfirms/[lawFirmId]` | Firm profile, Plan & Subscription panel, collapsible Members, Roles, Pending Member Invites, Pending Client Invites, Clients (`[lawFirmId]/page.tsx:481`, `:1182-1241`); modals for storage ops, limit and feature overrides, "Give Free Access" (comp), Cancel Subscription, Edit Role (`:1255-1348`) | detail, role, member, invite, plan, comp and cancel calls (`:758-962`); `StorageOpsModal.tsx:74,91`; `LimitsOverrideModal`, `FeatureOverridesModal.tsx:76` |
| `/admin/users` | Paged users with type, admin, firm and signup filters; Make Admin / Remove Admin button per row | `getUsersPaged` (`users/page.tsx:142`), `updateUserAdmin` (`:246`) |
| `/admin/clients` | Paged client records with firm, portal, status, type and created filters | `getClientsPaged` (`clients/page.tsx:134`) |
| `/admin/logins` | Audit events, filter "Logins" (`auth.login`) or "All activity", with provider, location, device, IP (`logins/page.tsx:20-24`) | `getAuditEvents` (`:92`) |
| `/admin/test-accounts` | Form to create firm owner, member or client test accounts; shows the password with a copy button | `createTestAccount` (`test-accounts/page.tsx:180`) |
| `/admin/whitelist` | List, add, and remove whitelisted addresses, paged 50 per screen in the browser | `getWhitelist` / `addWhitelistEntry` / `removeWhitelistEntry` (`whitelist/page.tsx:80,150,172`) |

Shared components: `AdminFirmPicker` (typeahead over `/lawfirms/lookup`, `AdminFirmPicker.tsx:48,56`) on users, clients and test-accounts; `AdminStatCards`. The dashboard shows an Admin button only when the profile carries `isAdmin` (`dashboard/page.tsx:189,360-366`), and `/admin` is excluded from indexing (`admin/layout.tsx:3-5`, `lib/seo/site.ts:43`).

### Data Flow: grant platform admin

1. On `/admin/users` the admin clicks "Make Admin". `handleSetAdmin` calls `adminService.updateUserAdmin(uid, true)` (`users/page.tsx:238-246`), which sends `PATCH /api/admin/users/:userId/admin` with `{ isAdmin }` (`admin.service.ts` frontend `:666-672`). There is no confirmation dialog.
2. `verifyToken` validates the Firebase ID token. `requireIsAdmin` loads the caller's `users` row and rejects with 403 unless `isAdmin === true`, then sets `req.adminUser` (`requireIsAdmin.ts:9-36`).
3. The logging middleware emits `admin.action` with method and path (`admin.routes.ts:41-49`).
4. `validate(updateUserAdminSchema)` requires a strict `{ isAdmin: boolean }` (`admin.validation.ts:38-45`).
5. `updateUserAdmin` loads the target (404 if missing), returns early if nothing changes, refuses the last-admin removal, then writes `users.is_admin` (`admin.service.ts:582-608`).
6. On `finish`, `auditMutations` writes an `audit_events` row with `lawFirmId: null` and the caller as actor (`audit.middleware.ts:48-81`).

### Data Model

- **`users.is_admin`** `boolean not null default false` (`backend/db/schema.sql:35`). The only source of platform-admin status. `getUserById` removes `isAdmin` from profiles read by anyone other than the owner, so admins cannot be enumerated (`users.service.ts:100-102`).
- **`email_verification_whitelist`** (`schema.sql:65-72`): `email citext primary key`, `note`, `created_by → users(id) on delete set null`, `created_at`. The citext key makes adds case-insensitive; a second add updates the note (`admin.repository.ts:526-531`).
- **Read, not owned:** `law_firms` (plan columns, typed `storage_*` columns), `members`, `roles`, `invitations`, `clients`, `client_company_links`, `matter_clients`, `matters`, `audit_events`. The plan shape is described in [Law Firms, RBAC & Plans](/features/lawfirms-rbac-plans).
- **Response shapes:** `toAdminLawFirm`, `toAdminUser`, `toAdminClient` (`admin.service.ts:54-178`). Client portal state is derived, not stored: `linked` when `user_id` is set, `pending` when `portal_invite_pending`, else `none` (`admin.repository.ts:273-275`, `:349`).

### Key Logic & Rules

**Access control**
- The frontend check is cosmetic. Each page calls `userService.getProfile()` and renders "Admin Access Required" unless `isAdmin === true` (e.g. `admin/page.tsx:54-55`, `:84-103`). The backend gate is the real control.
- Unlike firm routes, there is no RBAC permission or plan gate on admin routes. Firm-owner status grants nothing.

**Cross-tenant access and safety limits**
- Unpaged `/lawfirms`, `/users` and `/plan-usage` stop at `LIST_CEILING = 5000` (`pagination.ts:189`) and return `truncated` and `ceiling` so a capped list is not mistaken for a complete one (`admin.routes.ts:73-79`, `admin.service.ts:735-781`).
- Paged lists cap `limit` at 200 (`admin.validation.ts:197,212,231`); the lookup caps at 50 and only returns id, name, plan and member count (`admin.repository.ts:104-138`). An `ids` request with no valid uuid returns nothing instead of falling through to search (`:108-114`).
- Per-firm writes load the firm first (404), then look the member, role or invite up scoped to that firm, so ids from another firm miss (`admin.service.ts:356-580`, `admin.repository.ts:208-232`). The invite type is part of the filter, so the client-invite route cannot delete a member invite.
- Owners are protected: their role cannot be changed and they cannot be removed (`admin.service.ts:484-489`, `:532-537`). Built-in roles cannot be renamed, but their permissions can change (`:367-372`).
- Role, member-role and member-removal changes emit `ROLE_PERMISSIONS_CHANGED`, `MEMBER_ROLE_CHANGED` and `MEMBER_REMOVED` so the permission cache drops stale entries (`admin.service.ts:388-390`, `:504-511`, `:545`).
- A storage quota lower than current usage, or not positive, is rejected (`admin.service.ts:428-443`). Plan changes that touch the tier, unlimited override or limit overrides re-sync the typed quota column (`:681-688`).

**Billing operations**
- Every Stripe action except comp returns 400 when Stripe is not configured (`admin.service.ts:786`, `:825`, `:851`, `:874`, `:910`, `:988`).
- `adminCreateSubscription` resolves the price before creating a Stripe customer, so a bad plan and interval pair leaves no orphan customer (`:797-809`).
- `adminRefund` targets only the most recent paid invoice and converts dollars to cents (`:918-936`).
- `adminCompFirm` cancels any Stripe subscription, sets `billingStatus: 'comped'`, and records `canceledSubscriptionId` so late webhooks cannot revert the comp (`:945-985`).

**Email-verification whitelist**
- `verifyToken` rejects password sign-ins with `email_verified=false` unless the address is whitelisted (`auth.ts:38-50`).
- The whitelist is the union of the `EMAIL_VERIFICATION_WHITELIST` env var and the table (`emailWhitelist.ts:21-34`). Reads are synchronous from memory. Admin mutations call `refresh()` on the serving instance; other instances pick changes up on a 15 s timer (disabled under `NODE_ENV=test`). A failed refresh keeps the last known set (`:41-51`, `:92-95`).
- A non-empty env whitelist in production logs a startup warning; DB entries do not (`auth.ts:34-36`).
- The frontend has its own `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` for route guards only (`lib/utils/emailVerification.ts:7-19`, `:44-49`). The console does not write it.

**Test accounts** (`adminCreateAccount`, `admin.service.ts:1085-1171`)
- `kind` is `firm_owner` (new firm on a comped, `unlimitedOverride` Professional plan, `:1047-1058`), `member` (joins `lawFirmId` on the given role or the firm's "member" role, `:1062-1070`), or `client` (optionally linked to a firm's portal).
- Rejects an address already held by Firebase or a `users` row, and validates the target firm before creating the Firebase identity (`:1094-1111`).
- The Firebase user is created with `emailVerified: true`, so no whitelist entry is needed. The plaintext password is returned in the response (`:1115-1148`).
- If the Postgres side fails, both the Firebase user and the `users` row are rolled back so the address can be retried (`:1149-1170`).

**What is audited**
- `admin.action` security log line for every POST, PUT, PATCH or DELETE after the gate passes (`admin.routes.ts:40-49`, `securityLog.ts:32-51`).
- An `audit_events` row per successful mutating request. For `/api/admin/lawfirms/<uuid>/...` paths the firm id is extracted from the URL (`audit.middleware.ts:10`, `:55-56`), so the admin's change lands in that firm's own audit log. Whitelist, test-account and admin-flag writes are recorded with a null firm.
- Reads are not audited. Request bodies are never stored (`audit.middleware.ts:68-69`).

### Dependencies

- **Firebase Admin** (`auth.getUserByEmail`, `createUser`, `deleteUser`) for test accounts.
- **Stripe** (`modules/stripe/stripe.config`) for subscription operations.
- **Other modules:** `lawfirms` repository and service, `members`, `roles`, `invitations`, `users`, `files` (storage recount), `clients/clientIdentityLinking.service`, `audit.service`, `shared/plans/planDefinitions` and `stripePrices`, `shared/utils/storageUsage`, `shared/events/eventBus` and `eventOutbox`.
- **Env vars:** `EMAIL_VERIFICATION_WHITELIST`, `EVENT_OUTBOX_WORKER`, the `STRIPE_*_PRICE_ID` set read by `getPriceId`, and on the frontend `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST`.

### Tests

| File | Covers |
|---|---|
| `backend/tests/admin/adminAuthorizationMatrix.test.ts` | Every admin route refused for a firm member, firm owner and portal client, with a control that proves each path exists; forged `isAdmin`, `is_admin`, `admin`, `role` and `permissions` token claims buy nothing (`:496-517`) |
| `backend/tests/admin/adminMutations.test.ts` | Gate on writes, firm detail isolation, profile and quota edits, roles, members, invite deletes, admin flag incl. last-admin guard (`:640-701`), plans, over-limit sweep, whitelist |
| `backend/tests/admin/adminSubscriptionOps.test.ts` | Create, cancel, extend-trial, coupon, refund, comp and plan patch against stubbed Stripe |
| `backend/tests/admin/adminTestTooling.test.ts` | All three account kinds, rollback, duplicate refusal, whitelist upsert and listing |
| `backend/tests/admin/adminStorageRecount.test.ts` | Recount semantics and its effect on the plan-usage sweep |
| `backend/tests/users/admin.test.ts` | Gate, cross-platform reads, search |
| `backend/tests/live/admin/admin.test.ts`, `lawfirms-lookup.test.ts` | The same gate and lookup contract against a running server |

### Example

```
POST /api/admin/test-accounts
Authorization: Bearer <id token of a user with is_admin = true>
{ "kind": "member", "email": "qa-member@example.test", "password": "hunter22",
  "name": "QA Member", "lawFirmId": "2f5c...-..." }

→ 201 { "message": "Member account created",
        "account": { "uid": "Xk3...", "email": "qa-member@example.test", "password": "hunter22",
                     "userType": "firm_member", "lawFirmId": "2f5c...-...", "roleId": "9a..." } }
```

The account signs in immediately with no verification email. The firm's permission cache is invalidated by `MEMBER_ADDED` (`admin.service.ts:1140`). The request is logged as `admin.action` and recorded in `audit_events` with no firm id (the path has no `/lawfirms/<uuid>` segment) and without the body.

---

## What Can Be Improved

1. **The audit trail cannot answer what an admin changed.** Both records store only method and path (`admin.routes.ts:43-46`, `audit.middleware.ts:68-80`). The whitelisted address, the new admin's uid context, a refund amount, a comp reason or a role's new permission set are nowhere. Record a structured, non-secret summary (target ids, whitelisted email, refund cents, new `isAdmin`) in `metadata` for admin routes. Admin edits to a firm also appear in that firm's own audit log under the admin's identity, which may or may not be wanted.
2. **Comp swallows a failed Stripe cancel.** `stripe.subscriptions.cancel(...).catch(() => {})` (`admin.service.ts:951`) means a Stripe error still marks the firm comped and clears `stripeSubscriptionId`, while Stripe may keep billing. Surface the error, or keep the subscription id so it can be reconciled.
3. **Role and member routes have no Zod schema.** `PATCH .../roles/:roleId` passes `req.body.name` and `req.body.permissions` straight to the service (`admin.routes.ts:203-208`), and nothing checks the permission codes against the catalog or even that `permissions` is an array of strings. Add schemas, and a uuid param check, matching the firm-side roles module.
4. **The last-admin guard is check-then-write.** `countAdmins()` and `updateUser()` run as separate statements (`admin.service.ts:597-601`), so two concurrent demotions can leave zero admins. Use one conditional `UPDATE` or a transaction with a lock.
5. **Test tooling has no environment guard.** Nothing in the admin module or the pages checks `NODE_ENV`, so production can create pre-verified accounts, comped unlimited firms, and whitelist entries. The default password field is `'password'` (`test-accounts/page.tsx:54`), the minimum is 6 characters (`admin.validation.ts:146`), and the password is echoed back in the response (`admin.service.ts:1134-1148`). Consider a flag that disables these routes in production, or at least a stronger minimum.
6. **Several backend operations have no UI.** No frontend code calls `subscription/create`, `extend-trial`, `apply-coupon`, `refund`, `invoices`, `plan-usage`, `plans`, `lawfirms/:id/plan` or `outbox-health` (only the methods at `frontend/src/services/admin.service.ts:478-764` exist, and none cover these). They are curl-only, which makes the riskiest billing actions the least guarded by UI confirmation.
7. **The admin check is copied into eight pages.** Every page repeats the `getProfile` effect and the "Admin Access Required" block (e.g. `users/page.tsx:162-200`, `:275-290`), while `admin/layout.tsx` does nothing but set `robots`. Move the check into the layout or a shared hook.
8. **No confirmation on privilege changes.** "Make Admin" and "Remove Admin" fire immediately (`users/page.tsx:238-246`, `:493-499`).
9. **Firm detail is unbounded.** `listLawFirmClients` and `listLawFirmMembers` load every row for the firm (`admin.repository.ts:173-188`, `:430-462`), which will get slow on large firms.
10. **Doc drift.** `docs/features/lawfirms-rbac-plans.md` cites `admin.service.ts:220,323,364` for the cache-invalidation emits; they are now at `:389`, `:505` and `:545`.
