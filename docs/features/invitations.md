# Invitations

## Summary

Paralegix uses a single, token-based invitation system to onboard two kinds of users into a law firm: **firm members** (staff who get a `members` row + role) and **clients** (portal users linked to a `clients` row). Both flows share one Postgres table, `invitations`, distinguished by an `invite_type` column (`'member'` | `'client'`). When a firm sends an invite, the backend either acts immediately (if the invitee already has a platform account and can take it) or persists a pending invite with a unique random token and a 14-day expiry, then emails an invite link. The invitee accepts either explicitly (via the accept pages, which call the accept endpoints) or implicitly: when a profile is first created with an already-verified email (`createUser` / `completeRegistration`, never `login`), the auth service claims pending, unexpired invites matching that email.

## Key Takeaways

- **One table, two types.** `invitations` (`backend/db/schema/90_platform.sql:73-110`) holds both member and client invites; `invite_type` is the discriminator (CHECK `in ('member','client')`, `:77`). Member invites carry a `role_id`; client invites carry `matter_ids` and, for targeted invites, `client_id` / `contact_client_id` (a CHECK forbids either on a member invite, `:106-109`).
- **Token is unique and is the link.** `token text not null unique` (`:79`) is a 64-hex-char random string (`crypto.randomBytes(32).toString('hex')`, `invitations.service.ts:128`, `:216`). The token *is* the invite; there is no separate token table. Token reads go through the audited `tokenQuery` context (`invitations.repository.ts:72-84`).
- **Invites expire after 14 days.** `repo.create` sets `expires_at = now + 14 days` (`invitations.repository.ts:201`); the column is `NOT NULL` with a 7-day default for any other writer (`90_platform.sql:88`). Every live read uses the shared `livePending` predicate (`status = 'pending'` and not expired, `repository.ts:67-70`): `findByToken`, `listPending`, `findPendingByIdType`, `findPendingMemberInvitesByEmail`, the claim transaction (which re-checks expiry on the locked row, `:243`), and both auto-process queries in `auth.service.ts`. Expired links 404 at lookup/accept.
- **`findByToken` returns ONLY live, pending invites** (`repository.ts:72-77`), so a consumed or expired invite is indistinguishable from "not found". A read-only sibling `findByTokenAnyStatus` (`:79-84`) ignores status and is used ONLY to surface "already processed" in the lookup GET.
- **Accept is a locked, transactional status transition, not a delete.** `repo.withInviteClaimTxn({ by, key, userId, join, onMissing })` (`repository.ts:235-261`) opens a Drizzle transaction, reads the invite row `for update`, rejects it unless pending and unexpired, flips it `pending → accepted` (stamping `accepted_at`/`accepted_by`) with a guarded `scopedUpdate`, then runs `join(transaction)` on the same transaction. A throw anywhere rolls the claim back, so the invite stays `pending` and is retryable. The two callers are thin wrappers: `withInviteAcceptTxn` (claim-by-token, `invitations.service.ts:63-65`) and `claimAndJoinInviteById` (claim-by-id, `auth.service.ts:121-129`). A missing/consumed row → `NotFoundError` on the token path, `false` (skip) on the id path.
- **Two ways to accept.** (1) Explicit accept via `POST /api/invitations/accept` (client) / `POST /api/invitations/member-accept` (member). (2) Auto-process in `createUser` and `completeRegistration` (`auth.service.ts:137-246`, `:252-293`, called at `:436-444` and `:625-633`), **only when Firebase already reports the email verified**, so a fresh password signup always goes through (1). Login never auto-processes.
- **`alreadyProcessed` lookup gives a clean redirect, not 404.** When a token is no longer pending but the invitee IS now a member/client of that firm, the public lookup GET returns `{ invitation: { alreadyProcessed: true, lawFirmId, lawFirmName, email } }` (`lookupInviteOfType`, `invitations.service.ts:271-289`). All four accept/register pages branch on it (`accept-member-invite/page.tsx:77`, `register/member-invite/page.tsx:68`, `accept-invite/AcceptInvitePageClient.tsx:47`, `register/invite/page.tsx:68`). The membership check is **by email**, not uid (see How It Works).
- **Existing-user fast path, with a cap exception.** An existing account that can take the membership is added directly: no token row for members, a stale pending row deleted for clients. An existing user already at `MAX_LAW_FIRMS_PER_USER` gets a pending invite instead, and accepting it answers 409 `FIRM_SWITCH_REQUIRED` (listing the firms in the way) until the caller retries with `confirmSwitch: true`, which leaves the current firm(s) first (`invitations.service.ts:201-209,373-409`).
- **Inviting can't escalate privileges or cross identities.** `inviteMember` lets only the owner grant the Owner role and rejects a role whose effective permissions exceed the inviter's (`invitations.service.ts:164-194`); a `client`-type account can't be invited as a member (`:196-200`); a firm member can't accept a client invite to the same firm (`:320-324`). See [Law Firms / RBAC](/features/lawfirms-rbac-plans).
- **Pending-invite listings don't expose the token.** The token is the bearer secret and the listings are gated by the broad `members.view`/`clients.view`, so they strip it (`stripToken`, `invitations.service.ts:547-561`). Re-notifying uses the id-based resend endpoint.
- **Email match is the anti-hijack gate at accept time.** Explicit accept requires the account email to equal `invite.email` (case-insensitive) inside the shared `acceptInviteOfType` (`invitations.service.ts:308-332`, check at `:314-317`); the type guard is at `:310`. `acceptInviteByToken` / `acceptMemberInviteByToken` are strategy wrappers (`:334`, `:366`).
- **Revoke is wired on both sides.** Firm-scoped POST endpoints flip a pending invite to `revoked` (`invitations.routes.ts:99,112` → `revokeInvite`, `invitations.service.ts:593-597` → `revokePendingById`, `repository.ts:548-556`). A no-op 404s. The members-settings page calls `lawfirmService.revokeMemberInvitation` / `clientsService.revokeClientInvitation` (`settings/members/page.tsx:482-534`).
- **Expiry sweep runs from cron.** `sweepExpiredInvitations` (`invitations.routes.ts:129-146`) is called by `POST /api/cron/housekeeping` (`app.ts:741`) and flips still-pending, past-`expires_at` rows to `expired` (`repository.ts:370-379`). The old boot timer + 24h `setInterval` pair is gone.
- **Atomic resend throttle.** A 10-resend cap and a 24h cooldown are enforced in ONE conditional `UPDATE`: `claimResendSlot` on the invite row (cooldown keyed on `invitation_sent_at`, `repository.ts:272-288`) and `claimClientResendSlot` on the joined `clients` row (cooldown keyed on the dedicated `clients.last_resend_at`, `repository.ts:290-321`, column at `20_parties.sql:33`). 0 rows back = throttled.
- **One live pending invite per target, enforced by partial unique indexes.** Member invites: `invitations_member_pending_idx on (law_firm_id, email) where invite_type = 'member' and status = 'pending'` (`90_platform.sql:119-121`); client invites are keyed on `(law_firm_id, client_id)` or `(law_firm_id, contact_client_id)` with matching predicates. `repo.create` upserts against whichever applies (`conflictTargetFor`, `repository.ts:169-194`) and resets the row to `pending` with a fresh expiry and cleared `accepted_*` (`:196-231`). The old `(law_firm_id, email, invite_type)` unique constraint no longer exists.
- **Joins emit `MEMBER_ADDED` after commit.** The direct add, the member accept and the auto-process loop all emit it only once the transaction has committed (`invitations.service.ts:251,440`, `auth.service.ts:228`).

---

## How It Works

### Transaction boundaries

Member provisioning paths serialize on the invitee's user row before checking their firm cap. Sending a member invite also locks the firm and rechecks members plus live pending invitations, so two senders cannot reserve the same final seat. Explicit acceptance and registration auto-accept recheck real members under the firm lock. A skipped or failed registration join leaves its invitation pending.

Member joins also check that the destination firm is active under the firm lock. A firm scheduled for deletion cannot acquire a new member through an outstanding invitation or registration auto-accept; the invitation remains pending.

Confirmed firm switches compose departure, ownership changes or a deletion stamp, invitation acceptance and the destination membership in one transaction. Events and external teardown follow its commit. Client invitation preparation can participate in client creation's outer transaction; identity linking, stale invitation cleanup and metadata changes roll back together, while email and pending-message reconciliation run after commit. Email delivery remains a separate external operation with persisted failure metadata.


### Entry Points

**Backend routes**

| Method & Path | Auth / Permission | Handler | File:line |
|---|---|---|---|
| `POST /api/lawfirms/:lawFirmId/invitations/invite-member` | `verifyToken` + `members.invite` | `inviteMember` | `invitations.routes.ts:43` |
| `POST .../invitations/send-client-invite` | `verifyToken` + `clients.invite` | `sendClientInvite` | `invitations.routes.ts:31` |
| `POST .../invitations/associate-client-direct` | `verifyToken` + `clients.invite` | `associateClientDirect` | `invitations.routes.ts:19` |
| `POST .../invitations/resend-client-invite` | `verifyToken` + `clients.invite` | `resendClientInvite` | `invitations.routes.ts:56` |
| `GET .../invitations/pending-client-invites` | `verifyToken` + `clients.view` | `listPendingClientInvites` | `invitations.routes.ts:68` |
| `POST .../invitations/resend-member-invite` | `verifyToken` + `members.invite` | `resendMemberInvite` | `invitations.routes.ts:77` |
| `GET .../invitations/pending-member-invites` | `verifyToken` + `members.view` | `listPendingMemberInvites` | `invitations.routes.ts:89` |
| `POST .../invitations/member-invites/:inviteId/revoke` | `verifyToken` + `members.invite` | `revokeInvite('member')` | `invitations.routes.ts:99` |
| `POST .../invitations/client-invites/:inviteId/revoke` | `verifyToken` + `clients.invite` | `revokeInvite('client')` | `invitations.routes.ts:112` |
| `GET /api/invitations/member-accept/:token` | **public**, `inviteLookupLimiter` | `lookupMemberInviteByToken` | `invitationAccept.routes.ts:28` |
| `POST /api/invitations/member-accept` | `verifyToken` + `validate(acceptTokenSchema)`; body `{ token, confirmSwitch? }` | `acceptMemberInviteByToken` | `invitationAccept.routes.ts:32` |
| `GET /api/invitations/accept/:token` | **public**, `inviteLookupLimiter` | `lookupInviteByToken` (client) | `invitationAccept.routes.ts:13` |
| `POST /api/invitations/accept` | `verifyToken` + `validate(acceptTokenSchema)` | `acceptInviteByToken` (client) | `invitationAccept.routes.ts:17` |
| `GET /api/invitations/my-pending-member-invites` | `verifyToken` | `listMyPendingMemberInvites`: pending member invites addressed to the caller's own email, across firms, token stripped | `invitationAccept.routes.ts:44` |

Route registration: firm-scoped router under `/api/lawfirms/:lawFirmId/invitations` and the public accept router under `/api/invitations` (`backend/src/app.ts:899-900`). The firm-scoped path is exempt from the workspace billing gate so a locked firm's invitee can still accept.

**Frontend pages**

| Page | Purpose | File |
|---|---|---|
| `/register/member-invite?token=` | New-user signup landing for a member invite | `frontend/src/app/register/member-invite/page.tsx` |
| `/register/invite?token=` | New-user signup landing for a client invite | `frontend/src/app/register/invite/page.tsx` |
| `/accept-member-invite?token=` | Logged-in member explicitly accepts | `frontend/src/app/accept-member-invite/page.tsx` |
| `/accept-invite?token=` | Logged-in client explicitly accepts | `frontend/src/app/accept-invite/AcceptInvitePageClient.tsx` |

**Frontend service methods**

| Method | Calls | File:line |
|---|---|---|
| `inviteUserToLawFirm` | `invite-member` | `frontend/src/services/lawfirm.service.ts:77` |
| `listPendingMemberInvites` | `pending-member-invites` | `lawfirm.service.ts:99` |
| `resendMemberInvitation` | `resend-member-invite` | `lawfirm.service.ts:111` |
| `revokeMemberInvitation` | `member-invites/:id/revoke` | `lawfirm.service.ts:128` |
| `inviteClientToLawFirm` | `send-client-invite` | `frontend/src/services/clients.service.ts:839` |
| `associateClientDirect` | `associate-client-direct` | `clients.service.ts:1032` |
| `listPendingClientInvites` | `pending-client-invites` | `clients.service.ts:854` |
| `revokeClientInvitation` | `client-invites/:id/revoke` | `clients.service.ts:879` |
| `resendClientInvitation` | `resend-client-invite` | `clients.service.ts:896` |
| (direct `apiFetch`) | `my-pending-member-invites` | `frontend/src/app/dashboard/page.tsx:224`, `components/PendingMemberInviteBanner.tsx:27` |

The members-settings page consumes both the member and client listing/resend/revoke methods; `onRevokeMemberInvite` / `onRevokeClientInvite` (`settings/members/page.tsx:482,490`) call the two revoke services (`:532`, `:534`).

### Data Flow: Send a Member Invite

`inviteMember()`: `invitations.service.ts:154`

1. Verify the firm exists (`repo.lawFirmExists`, `:157`).
2. Enforce the plan's `maxMembers` limit, counting members + live pending member invites (`enforceCountLimit` → `repo.countMembersAndPendingMembers`, `:161`, `repository.ts:381-406`).
3. Look up the invitee by email (`lookupUserByEmail`, `:163`): **local `users` table first**, Firebase Auth only on a local miss (`:25-44`).
4. Validate the role belongs to the firm, only the owner may grant Owner, and a non-owner may not grant more than they hold (`:165-194`).
5. Refuse a `client`-type account (`:196-200`) and an existing member (`ConflictError`, `:202-204`); compute whether an existing user is at the per-user firm cap (`:206-209`).
6. **No existing user, or one at the cap →** reject a duplicate pending invite (`findByEmailType`), generate a token, upsert the invite with a 14-day `expires_at` (`repo.create`), and email `/accept-member-invite?token=…` for an existing account or `/register/member-invite?token=…` for a new one; record send status (`repo.markSent`) (`:211-235`). Returns `status: 'invited'` with the token.
7. **Existing user under the cap →** in one transaction: lock the firm row (`lockFirmForSeatCheck`), re-check membership, re-count real members against `maxMembers`, insert into `members`, emit `MEMBER_ADDED` (`:246-252`); then email a "you've been added" notice. Returns `status: 'added'`. **No invitation row is created in this branch.**

### Data Flow: Accept a Member Invite

**Explicit accept**: `acceptMemberInviteByToken()` (`invitations.service.ts:366`), a strategy wrapper over `acceptInviteOfType(..., 'member', join)` (`:308`)

1. Frontend `GET /api/invitations/member-accept/:token` to display the firm name (`lookupMemberInviteByToken` → `lookupInviteOfType`, `:296-298`); a non-member token or a dead one returns `alreadyProcessed` or 404 (see below).
2. User clicks Accept → `POST /api/invitations/member-accept` with `{ token }`.
3. `acceptInviteOfType` looks up the live invite by token and rejects a missing/expired/consumed token or the wrong type (`:309-310`), loads the user (`:312`), and applies the email match gate (`:314-317`).
4. **Transactional claim + join** via `withInviteAcceptTxn` → `repo.withInviteClaimTxn` (`repository.ts:235-261`). The member join: if the user is not already a member, check the per-user firm cap (409 `FIRM_SWITCH_REQUIRED` with `currentFirms`, or leave them when `confirmSwitch` is true), lock the firm row, re-count real members against `maxMembers`, and insert the member with the invite's `role_id`/`invited_by` (`invitations.service.ts:375-438`).
5. After commit, emit `MEMBER_ADDED` (`:440`). The frontend redirects into the firm; on `FIRM_SWITCH_REQUIRED` it asks the user to confirm and retries (`accept-member-invite/page.tsx:92-114`).

**Implicit accept (profile creation with a verified email)**: `checkAndProcessMemberInvites()` (`auth.service.ts:137`)

1. Called for non-client users from `completeRegistration` (`auth.service.ts:442`) and `createUser` (`:630`), only when `userRecord.emailVerified`.
2. Query all pending, unexpired member invites for the normalized email across all firms (`:142-151`).
3. The user's firm ids are fetched once and member counts for all candidate firms in one batched query (`:157-173`); both are updated in memory as joins succeed so later invites in the pass still respect the caps (`:233-235`).
4. For each invite: already a member → mark the stale invite accepted with a guarded update (`:180-191`); skip if at the per-user cap (`:196-198`) or the firm is full (`:202-210`); otherwise claim + join in one transaction via `claimAndJoinInviteById` (`:216-227`) and emit `MEMBER_ADDED` after commit (`:228`).
5. Errors are logged per invite and per pass; auto-processing never blocks registration (`:236-242`).

### Data Flow: Send a Client Invite

`sendClientInvite()`: `invitations.service.ts:90`

1. Normalize email; if a person `clients` row with that email already has a `user_id`, throw `ConflictError` (`:93-96`).
2. Look up the platform user by email (`:98`).
3. **Existing user →** must be `userType === 'client'` else `ValidationError`; link them to the firm immediately (`addClientToFirm` → `linkClientIdentityToFirm`); delete any stale pending client invite (`findByEmailType` + `deleteById`); email a portal link and stamp the client row's invite metadata (`:100-122`). Returns `status: 'added'`.
4. **No existing user →** reject a duplicate pending invite, generate a token, upsert an invite with `invite_type='client'` and empty `matter_ids`, email `/register/invite?token=…`, `repo.markSent`, and clear `portalInvitePending` on any placeholder client row (`:124-147`). Returns `status: 'invited'`.

`associateClientDirect()` (`:70-85`) is the existing-user-only variant: links an existing client account to the firm but errors if no such user exists, directing the caller to `send-client-invite`.

### Data Flow: Accept a Client Invite

**Explicit accept**: `acceptInviteByToken()` (`invitations.service.ts:334`), a strategy wrapper over `acceptInviteOfType(..., 'client', join)`

1. Frontend `GET /api/invitations/accept/:token` to display the firm name (`lookupInviteByToken`, `:291-294`). A member-invite token 404s here (type guard in `lookupInviteOfType`, `:274`).
2. User clicks Accept → `POST /api/invitations/accept` with `{ token }`.
3. `acceptInviteOfType` applies the live-token + type guard, the email match gate, and refuses a firm member accepting a client invite to the same firm (`:308-324`).
4. **Transactional claim + join**: the join calls `linkClientIdentityToFirm({ ..., matterIds, client })` on the same transaction executor (`:344-362`). An invite still carrying a `contactClientId` (the retired company-roster shape) is refused with a `ValidationError` asking the firm to re-invite.
5. After commit, `messagingRepo.reconcilePendingClientRecipientsForUser` runs (`:361`). The frontend redirects to `/client/dashboard`.

**Implicit accept**: `checkAndProcessClientInvites()` (`auth.service.ts:252`), same shape as the member version, with `linkClientIdentityToFirm` as the join step (`:273-285`); runs for `userType === 'client'` registrations with a verified email (`auth.service.ts:439`, `:627`).

### The `alreadyProcessed` lookup path

`lookupInviteOfType(token, inviteType, alreadyLinked)`: `invitations.service.ts:271-289`

1. `repo.findByToken(token)` — if a live (pending, non-expired) invite of the right type exists, return the display payload (`lawFirmId`, `lawFirmName`, `email`, `invitedAt`).
2. Otherwise `repo.findByTokenAnyStatus(token)` — a status-agnostic read. If the row exists, is the right type, AND `alreadyLinked(lawFirmId, email)` is true, return `{ alreadyProcessed: true, lawFirmId, lawFirmName, email }`.
3. Else `NotFoundError('Invitation')`.

**Membership check is by EMAIL, not uid**, and that is correct here. The lookup GET is **public/unauthenticated** (no `req.user`), so the only identity it has is the invite's recorded `email`. `isMemberByEmail` joins `members → users` on `lower(u.email)` scoped to the firm (`invitations.repository.ts:520-531`); `isClientLinkedByEmail` matches a `clients` row with `lower(email)` and `user_id is not null` (`:533-546`).

### Data Model

`invitations` table: `backend/db/schema/90_platform.sql:73-130`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `law_firm_id` | uuid NOT NULL | FK → `law_firms`, `on delete cascade` |
| `email` | citext NOT NULL | case-insensitive comparisons |
| `invite_type` | text NOT NULL | check `in ('member','client')` |
| `role_id` | uuid | member invites only; single-column FK `invitations_role_fk → roles(id) on delete set null` (`:105`), so deleting a role no longer fails |
| `token` | text NOT NULL **unique** | 64-hex random; the invite link identifier |
| `status` | text NOT NULL | default `'pending'`; check `in ('pending','accepted','revoked','expired')` |
| `matter_ids` | uuid[] | client invites; matters to associate on accept |
| `invited_by` | text | FK → `users(id)` on delete restrict |
| `invited_at`, `invitation_sent_at` | timestamptz | `invitation_sent_at` is also the pending-row resend cooldown anchor |
| `invitation_email`, `invitation_failed` | citext / boolean | last delivery target + failure flag |
| `invitation_resend_count` | int NOT NULL default 0 | bumped on resend |
| `expires_at` | timestamptz NOT NULL | default `now() + 7 days`; `repo.create` always writes 14 days |
| `accepted_at`, `accepted_by` | timestamptz / text | accept audit; `accepted_by` FK → `users(id)` on delete restrict |
| `client_id`, `contact_client_id` | uuid | targeted client invites; single-column FKs `on delete set null`; both must be null on a member invite, and a roster link implies `client_id` |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `unique (token)`; partial `invitations_email_type_pending_idx on (email, invite_type) where status='pending'`; `invitations_client_idx` / `invitations_contact_client_idx`; partial unique `invitations_member_pending_idx on (law_firm_id, email) where invite_type='member' and status='pending'` (`:119-121`) and the per-client pending unique index that follows it.

**Status lifecycle:** rows are created `'pending'` with a 14-day `expires_at`. On accept (explicit or auto) the row transitions `pending → accepted` with `accepted_at`/`accepted_by` stamped inside `withInviteClaimTxn` (`repository.ts:235-261`). The "already a member, mark the stale invite accepted" branch of the member auto-process uses an equivalent guarded update (`auth.service.ts:180-191`). `'revoked'` is written by `revokePendingById` (`repository.ts:548-556`); `'expired'` by `expireStaleInvitations` (`:370-379`) from the housekeeping cron. Rows are **never hard-deleted on accept**; `deleteById` (`:337-340`) is only used to clear a stale pending client invite during the existing-user send fast path (`invitations.service.ts:107-108`).

### Key Logic & Rules

- **Token generation / entropy.** `crypto.randomBytes(32).toString('hex')` → 256 bits, 64 hex chars (`invitations.service.ts:128`, `:216`).
- **Expiry.** 14 days from insert. Live reads use `livePending` (`repository.ts:67-70`); the claim re-checks expiry on the locked row (`:243`). The cron sweep flips rows the filters already hide.
- **Single-use / race-safety.** The claim reads the row `for update` and flips it with a guarded `status = 'pending'` update (`repository.ts:238-253`), so among concurrent accepts exactly one claims it; the others block on the lock, then see it consumed and hit `onMissing` (default `NotFoundError` → 404; the id path passes `() => false` → skip). The join only commits for the winner, and a failed join rolls the claim back.
- **Transaction correctness.** `withInviteClaimTxn` runs inside `withDrizzleTransaction` (which accepts an outer executor, so it nests as a savepoint) and hands the same transaction to `join` (`repository.ts:235-261`). `linkClientIdentityToFirm` accepts that executor as `client` and does not open its own transaction.
- **Email matching.** Explicit accept requires the logged-in user's email to equal the invite email, case-insensitive (`invitations.service.ts:314-317`). Auto-process matches on `lower(email::text)` and runs only for a verified email. Primary anti-hijack control.
- **What happens on accept.**
  - *Member:* `repo.addMember` inserts into `members` with the invite's `role_id` and `invited_by` (`repository.ts:498-518`), after the firm-row lock and seat re-check.
  - *Client:* `linkClientIdentityToFirm({ lawFirmId, userId, email, matterIds, client })` sets `clients.user_id`, merges placeholders, and associates any `matter_ids`.
- **Re-invite semantics.** `repo.create` upserts on the matching partial unique index (`conflictTargetFor`, `repository.ts:169-194`) and resets `status='pending'`, `expires_at`, and clears `accepted_at`/`accepted_by` (`:196-231`).
- **Revoke semantics.** `revokePendingById` only touches `status='pending'` rows scoped by firm + type (`repository.ts:548-556`); 0 rows → 404 (`invitations.service.ts:593-597`).
- **Resend throttling (atomic).** The member and client *pending-invite* resends share `resendPendingInvite()` (`invitations.service.ts:471-489`), which calls `claimResendSlot` (`repository.ts:272-288`). The *joined-client* resend is a separate branch in `resendClientInvite` (`invitations.service.ts:491-539`) using `claimClientResendSlot` (`repository.ts:290-321`), gated on `clients.last_resend_at`. 0 rows back ⇒ throttled; the service distinguishes cap-reached vs cooldown from the pre-claim count. Delivery outcome is recorded afterward via `setInviteResendFailed`/`setClientResendFailed`.
- **Validation.** Zod schemas (`invitations.validation.ts`): `email` validated + lowercased; `invite-member` requires non-empty `roleId`; `resend-client-invite` requires `clientId` (a client row id, or the pending invite's email when no row exists yet); `resend-member-invite` requires `inviteId`; revoke requires a uuid `inviteId` param (`:36-41`); accept endpoints require `token` and accept an optional boolean `confirmSwitch` (`acceptTokenSchema`, `:43-47`).
- **Permissions.** Firm-scoped send/manage/revoke endpoints require RBAC (`members.invite/view`, `clients.invite/view`). Accept endpoints require only a valid Firebase token (which implies a verified email); the email-match check substitutes for ownership. The public lookup GETs are unauthenticated and rate-limited by `inviteLookupLimiter`.
- **Tenancy.** Send/list/resend/revoke/associate routes are scoped under `/api/lawfirms/:lawFirmId/...` and their repo queries run in `tenantQuery`/`scopedUpdate`. Accept/lookup routes are firm-agnostic: the firm is derived from the invite row, read through `tokenQuery`, which is safe because the token is the bearer credential.

### Dependencies

- **Email**: `sendMemberInvitationEmail` / `sendClientInvitationEmail` (`backend/src/shared/services/emailService.ts`). Both return `{ sent: boolean }`; failures are recorded via `invitation_failed` but do not fail the request.
- **Auth / identity**: `lookupUserByEmail` checks the local `users` table first and only consults Firebase Auth (`auth.getUserByEmail`) on a local miss (`invitations.service.ts:25-44`). Auto-processing is wired into `createUser` / `completeRegistration` (`auth.service.ts`).
- **RBAC / Plans**: `rolesService.getRole` + `resolveFromRolePermissions`, `enforceCountLimit`, `canUserJoinMoreFirms`.
- **Client linking**: `linkClientIdentityToFirm` (`clients/clientIdentityLinking.service.ts`), transaction-aware via an optional `client` arg.
- **Sweep scheduling**: `POST /api/cron/housekeeping` (`app.ts:741`) calls `sweepExpiredInvitations`; nothing runs on a timer.
- **Events**: there is no `invitations.events.ts`; the module only emits `MEMBER_ADDED`.

### Example

Invite a new staff member who has no account yet:

```
POST /api/lawfirms/2f.../invitations/invite-member
Authorization: Bearer <firebase-id-token>      # caller has members.invite
{ "email": "newhire@example.com", "roleId": "9a..." }

→ 200 { "message": "Invitation sent to new team member", "email": "newhire@example.com", "status": "invited", "token": "<64-hex>" }
```

The invitee receives an email linking to `/register/member-invite?token=<64-hex>` (valid 14 days). They sign up and verify their email, then hit `/accept-member-invite?token=…` and `POST /api/invitations/member-accept` to join (a brand-new password account is never auto-joined at signup, because its email is not yet verified). If an OAuth signup with a verified email already auto-claimed the invite, the lookup GET returns `alreadyProcessed: true` and the page redirects them straight into the firm. Either way they land in `members` with `role_id = 9a...` and the invite row transitions to `status='accepted'`, inside one transaction.

---

## What Can Be Improved

Ordered by priority. Fixed and dropped: revoke wired on both sides; one shared claim transaction; deduped accept/resend pairs; the joined-client cooldown on `last_resend_at`; `markAccepted`/`incrementResend` deleted; expired invites no longer holding a seat; the in-process sweep timers that never fired under Cloud Run replaced by the housekeeping cron; direct add and accept now re-check seats under a firm-row lock; auto-claim limited to verified emails.

1. **Is the expiry sweep scheduled in production?** The sweep now runs only when `POST /api/cron/housekeeping` is called. A comment in the seat-count query says the sole scheduler job for that sweep is staging-only (`invitations.repository.ts:388-391`). Reads are unaffected (they filter on `expires_at`), but `status` stays `'pending'` forever for expired rows and the table never sheds them. Scheduler config is outside this repo; confirm the production job exists.

2. **The column default and the application disagree on invite lifetime.** `expires_at` defaults to 7 days (`90_platform.sql:88`) while `repo.create` writes 14 (`invitations.repository.ts:201`). Every current writer goes through `repo.create`, so the default never applies today, but a future writer that omits the column would silently issue a 7-day invite. Align them, or drop the default so an omission fails.

3. **Residual member/client duplication: the joined-client resend branch is not shared.** Pending-invite resends are unified in `resendPendingInvite` (`invitations.service.ts:471`), but the joined-client resend (`:516-539`) is a hand-rolled near-copy of the same claim → distinguish cap vs cooldown → send → record-failure shape. Parameterize `resendPendingInvite` over `claimSlot`/`recordFailure`/`sendEmail` so only the repo calls differ.

4. **`resend-client-invite` overloads one field with two meanings.** `clientId` is a `clients.id` when a row exists and the pending invite's email address when it does not (`invitations.service.ts:491-516`). The service resolves which up front, but the API contract is ambiguous; the targeted-invite `client_id` column now exists, so the email branch could be retired.

5. **`deleteById` is not tenant-scoped.** It deletes by id through `systemQuery` with no `law_firm_id` predicate (`invitations.repository.ts:337-340`). Its one caller passes an id it just read through a firm-scoped `findByEmailType`, so it is safe today, but it is the only write in the module that relies on the caller for tenancy.
