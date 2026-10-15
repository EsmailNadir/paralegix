# Privacy & Data-Subject Rights

What data-subject rights Paralegix actually implements, how erasure and export work, and the email-compliance controls.

## Summary

Paralegix exposes a small, concrete set of privacy endpoints under
`/api/privacy` plus firm-facing client variants
(`backend/src/modules/privacy/privacy.routes.ts`). Two rights are implemented in
code today:

- **Access / portability (export)** — a machine-readable JSON copy of a subject's
  personal data, either self-service or compiled by a firm on a client's behalf.
- **Erasure** — self-service account deletion and firm-initiated client erasure,
  both of which anonymize the DB row and delete the Firebase Auth identity.

Consent capture (`POST /api/privacy/accept-terms`) records terms/privacy
acceptance with version, timestamp, and IP. Outbound email carries a CAN-SPAM /
CASL compliance footer, a `List-Unsubscribe` header, and honors firm-level opt-out
toggles. Every export and erasure is logged as a `data.export` / `data.erasure`
security event for the audit trail (see /dev/security/audit-logging).

A firm itself can also be retired: `DELETE /api/lawfirms/:lawFirmId` soft-deletes
the firm, stopping access and billing immediately while retaining its data for a
configurable legal-retention window before a housekeeping cron hard-purges it
(`backend/src/modules/lawfirms/lawfirms.service.ts`). See "Firm deletion" below.

## Key Takeaways

- **Erasure is anonymize-in-place, not row-deletion.** The user row is stripped of
  personal data and kept as an anonymized **tombstone** so non-cascading foreign
  references stay valid (`erasePersonalIdentity`, `privacy.service.ts:124`). The
  Firebase Auth identity *is* hard-deleted.
- **Self-erasure is blocked for firm owners.** A user who owns any firm must
  transfer or delete those firms first, otherwise the firm would be orphaned
  (`privacy.service.ts:282`). This returns 403.
- **Client erasure is blocked when it would destroy financial records.** `eraseClient`
  refuses (403) under legal hold, and (409) when the client has trust-account activity or
  any billing records (client-context invoices with payment history, time entries, flat
  fees, or expenses). Those billing rows cascade-delete on client removal and trust ledger
  entries are append-only, so removing such a client would silently wipe financial history.
  A company client with an active conversation is also refused (409) until the
  conversation is archived. The same trust + billing guards apply to the firm-side `removeClient` (archive the client
  instead). It only erases the linked portal identity if that user has no remaining firm
  association at all.
- **Export scope is deliberately narrow.** The self-export returns the user
  record, settings, firm memberships, and any client records keyed to that user —
  not the full contents of every matter (that is the firm's privileged work
  product, not the subject's personal data).
- **PostHog is outside the database export, and only partly inside erasure.**
  Product events are held by PostHog under a Firebase UID or firm-scoped
  identifier. Erasing an account (self-service, or a firm erasing a client with a
  linked account) asks PostHog to delete that UID's person with its events and
  recordings, when `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are set.
  Firm-keyed events (`law_firm:<id>`) and firm deletion are not covered, and an
  export never includes PostHog data. See
  [PostHog Analytics & Cookie Consent](/dev/security/posthog-analytics).
- **Firm deletion is soft-delete + retention, not instant.** `DELETE
  /api/lawfirms/:lawFirmId` (`firm.delete`) revokes access and stops
  Stripe/calendar-sync immediately but only stamps a retention window
  (`deletion_purge_after`, default 10 years, `FIRM_DELETION_RETENTION_YEARS`);
  a daily cron (`purgeEligibleFirms`) hard-deletes the firm (cascading every
  child table) plus its GCS files only once that window has cleared, and never
  for a firm with permanent trust-ledger activity.
- **Retention elsewhere is still largely manual.** Below the firm level there is
  no global scheduled purge or recycle-bin: trust records carry a configured
  `retentionYears`, firm deletion carries its own retention window, but most
  other data (individual subject erasure aside) persists until a firm or
  subject acts.

## Implemented rights

### Consent — `POST /api/privacy/accept-terms`

`verifyToken`-gated. Records the caller's acceptance of the current terms and
privacy policy: `termsAcceptedAt`, `privacyAcceptedAt`, `consentVersion`, and the
source `consentIp` (`recordConsent`, `privacy.service.ts:143`). The version defaults to
`POLICY_VERSION` (env, default `1.0`) so a later policy change is distinguishable
from an earlier acceptance. Written to consent columns on the `users` row.

### Self access / export — `GET /api/privacy/me/export`

`verifyToken`-gated; emits a `data.export` security event
(`privacy.routes.ts:26`). Compiles, into one JSON object (GDPR Art. 15 access /
Art. 20 portability, `exportMyData`, `privacy.service.ts:170`):

- the `users` record (id, name, email, userType, consent timestamps and IP,
  createdAt),
- the caller's settings (`timezone` and `preferences`, now columns on `users`;
  there is no `user_settings` table),
- their firm memberships,
- every `clients` row linked to their uid (id, firm, name, email, phone, portal
  status, createdAt),
- their links to company clients (relationship, primary / email-recipient /
  billing-view flags).

This JSON is compiled from Paralegix's database. It does not query PostHog.
Handle an access request for product analytics data separately in the applicable
PostHog project. The Firebase UID identifies browser events; webhook events can
use a firm-scoped identifier, so review their event properties and avoid
deleting other users' events when fulfilling an individual request.

### Self erasure — `DELETE /api/privacy/me`

`verifyToken`-gated; emits `data.erasure` (`privacy.routes.ts:36`). Flow
(`eraseMyAccount`, `privacy.service.ts:279`): reject if the caller owns any firm →
`erasePersonalIdentity(uid)`, which runs `anonymizeAccount(uid)` to strip personal
data to an anonymized tombstone and then `deleteAuthIdentity(uid)` to remove
the Firebase Auth user (tolerating `auth/user-not-found`). Returns an `erasedAt`
timestamp. A user who owns a firm must first delete that firm (see "Firm
deletion" below) or transfer ownership before their own account can be erased.

### Firm-compiled client export — `GET /api/lawfirms/:lawFirmId/clients/:clientId/data-export`

`verifyToken + requirePermission(['clients.manage', 'clients.erase'])` (either
code passes; `clients.view` is baseline and deliberately not enough). Lets a firm
fulfill a client's access/portability request (`exportClientData`,
`privacy.service.ts:298`): the client record plus their `client_contacts`,
`client_notes`, and associated `matterIds`. Emits a scoped `data.export` event.

### Firm-initiated client erasure — `POST /api/lawfirms/:lawFirmId/clients/:clientId/erase`

`verifyToken + clients.erase`. Refuses under legal hold (403), and with 409 for
trust activity, billing records, or (for a company) an active conversation;
otherwise cascades the client's data (`clientsRepo.deleteClientCascade`) and, if
the linked portal user has no other client record or firm membership anywhere,
anonymizes that user and deletes its Auth identity (`eraseClient`,
`privacy.service.ts:435`). Emits `data.erasure`.

### Firm deletion (`DELETE /api/lawfirms/:lawFirmId`)

`verifyToken + firm.delete`. Not a data-subject right in the GDPR sense, but the
mechanism by which a firm's entire tenant (and therefore every subject's data
within it) is eventually removed
(`backend/src/modules/lawfirms/lawfirms.service.ts:227`):

1. `requestLawFirmDeletion` cancels the firm's Stripe subscription and stops its
   Google/Outlook calendar watches (`releaseExternalResources`, best-effort per
   resource so an unreachable provider never blocks the delete), then
   soft-deletes the firm: `pending_deletion_at` is stamped now and
   `deletion_purge_after` is stamped `now() + retentionYears` (default **10**,
   `FIRM_DELETION_RETENTION_YEARS` env, deliberately longer than the trust
   ledger's 5, since state-bar client-file retention rules commonly run
   5-10 years).
2. The firm becomes inaccessible to every member immediately:
   `assertLawFirmMembership` and `loadResolvedMember` both treat a firm with
   `pending_deletion_at` set as gone.
3. A pending deletion can be undone via `restoreLawFirm`, which clears
   `pending_deletion_at`, but only before the purge below has actually run.
4. A daily cron (`purgeEligibleFirms`, `app.ts` `firmPurge`) hard-deletes every
   firm whose `deletion_purge_after` has passed: `delete from law_firms`
   cascades through every child table (members, clients, matters, tasks,
   invoices, roles, conversations, messages, signature sessions, …), then the
   firm's GCS files are wiped by prefix. A firm with permanent trust-ledger
   activity is skipped indefinitely (the append-only trigger would abort the
   cascade), the same way `eraseClient` refuses to destroy trust history.

## What "a firm's data" spans

Erasure and export operate against the multi-tenant model, where nearly every
table carries a `law_firm_id`. A data subject's personal data can appear as:

- a `users` row (identity, settings, consent, memberships),
- `clients` + `client_contacts` + `client_notes` (portal identity and contact PII),
- association rows across `matters` / `matter_clients`, tasks, messaging,
  invoices, and trust ledger entries.

Consequences worth knowing:

- **Trust ledger rows are immutable and cannot be erased in place.** The
  append-only `trust_transactions` trigger blocks edits/deletes of completed
  entries (see /dev/security/audit-logging), so financial records survive an
  erasure by design; only reversing entries can adjust them.
- **`audit_events` are append-only** and are not scrubbed by an erasure — the
  actor uid/email persist in the security trail.
- Client erasure is cascade-based within one firm; a portal user shared across
  firms is only fully removed when the *last* association is gone.

## Unverified-account sweep

Signup writes the Firebase identity *and* the `users` row before the address is
proven (`POST /auth/create-user` runs on `verifyTokenAllowUnverified`, since the
record must exist before the user can verify). Firebase then refuses a second
signup for that email, so an account created with someone else's address
occupied it permanently and the victim had no self-service way out.

`purgeUnverifiedAccounts` (`backend/src/modules/users/unverifiedAccounts.service.ts`)
runs in the daily `housekeeping` cron and deletes accounts still unverified after
`UNVERIFIED_ACCOUNT_GRACE_DAYS` (default **7**), freeing the address.

**Full detail, and the assumptions that keep this from deleting a real person, are
in /dev/security/unverified-account-sweep.** Read that before changing a foreign
key to `users(id)`, the invite-claiming gate, or the erasure tombstone format.

**It ships in dry-run.** `UNVERIFIED_ACCOUNT_SWEEP_MODE` defaults to `dry-run`:
every guard is evaluated and the counts are reported, but nothing is deleted
until the mode is explicitly set to `on`. `off` skips the pass.

This is the only path in the app that deletes a live account without a human
asking, so every rule is written so that anything unknown keeps the account.

- **Verification state is only in Firebase.** `users` has no `email_verified`
  column, so the repository selects on age alone and the service confirms every
  candidate against Firebase (`auth.getUsers`, 100 uids per call).
- **Systemic failures abort the run**, they never degrade into a permissive
  default. An unreadable whitelist, an unreadable firm record or an unreachable
  Firebase throws before anything is deleted.
- **Two layers decide "in use".** Of the roughly 98 foreign keys to `users(id)`
  in `schema.sql`, all but fourteen have no delete action (or restrict), so
  Postgres aborts a delete that would orphan them and no application check is
  needed. `findAccountActivity` covers the exceptions: **every FK declared `on
  delete cascade` or `on delete set null`**, which are the only references the
  database would quietly destroy or unlink. Adding a new cascading or set-null FK
  to `users(id)` means adding it to that list (`npm run db:user-delete-guards`
  fails otherwise). It probes `members`, `matter_members`, `matters`
  (created/lead - no-action, checked anyway so a skip reads as a reason rather
  than an FK error), `clients`, `file_client_access`, `task_assignees`,
  `task_subtasks`, `event_assignees`, `conversation_participants`,
  `conversations`, `user_oauth_tokens`, `oauth_states`, `notifications` and
  `digest_sends`, and returns the name of the first hit so the cron output says
  why an account was kept. Two keys are deliberate omissions:
  `email_verification_whitelist.created_by` (records who added an entry, not a
  relationship to the account) and `file_export_jobs.requested_by` (a temporary
  zip swept within 24 hours).
- **A foreign-key violation on the delete (SQLSTATE 23503) counts as a clean
  skip**, not a failure. That is the database backstop doing its job against one
  of the no-action keys, so it is tallied as `keptReferenced` rather than logged
  as an error on every run.
- **Skipped by email:** the verification whitelist (read straight from
  `email_verification_whitelist` rather than through `isWhitelisted`, whose
  cached set is loaded fire-and-forget at import and refreshed on a 15s timer -
  fine for the auth path, not for a caller that deletes), a **pending
  invitation**, or an existing **`clients` record** at that address. The last two
  matter for client portal users: an invited client who signs up and has not
  verified yet has nothing linking the account to the firm, because invites are
  only claimed once `emailVerified` is true.
- **Also skipped:** verified accounts, any non-password provider, accounts with
  no provider data at all, platform admins, rows with a blank email, accounts
  whose Firebase creation time is still inside the grace period, and anonymized
  erasure tombstones (excluded in SQL by their `@deleted.invalid` email, since a
  tombstone has no Firebase identity either and would otherwise look like an
  orphan every run).
- **A missing Firebase identity is re-confirmed one-to-one** with `auth.getUser`
  before it is acted on, so a batch anomaly cannot be read as "this user is
  gone". Only an explicit `auth/user-not-found` counts.
- **Deletion order is the row FIRST, then the Firebase identity.** The row delete
  is the guarded step - every foreign key with no delete action aborts it - so a
  uid the activity check somehow missed keeps both its data and its login. The
  cost is that a crash between the two steps leaves a Firebase identity with no
  row pointing at it, keeping that one address blocked until an operator clears
  it: a recoverable inconvenience for one account, where the reverse order risks
  taking the login off a real user.
- Deleting the row cascades `user_oauth_tokens`, `oauth_states`, `members`,
  `matter_members`, `task_assignees`, `event_assignees`, `file_client_access`,
  `file_export_jobs`, `notifications` and `digest_sends`; the service
  also wipes the GCS profile-photo prefix. Email-keyed firm records
  (`invitations`, a firm's own `clients` rows) are deliberately left, since they
  belong to the firm rather than to the account.

## Email compliance & opt-outs

Every outbound email funnels through `sendEmail()`
(`backend/src/shared/services/emailService.ts`).

### CAN-SPAM / CASL footer + List-Unsubscribe

`withComplianceFooterHtml` / `withComplianceFooterText` append a footer with the
sender's physical mailing address (`COMPANY_POSTAL_ADDRESS`) and a link to manage
email preferences (`APP_URL/settings`) or contact support
(`emailService.ts:112`). Every message also sets a `List-Unsubscribe` header
pointing at the support mailbox and the preferences URL
(`emailService.ts:212`). Note: `COMPANY_POSTAL_ADDRESS` ships with a placeholder
default and must be set per environment for the footer to be compliant (backlog
item).

### Notification opt-outs

- **Client payment emails** (receipts + refund/reversal notices) are gated by the
  firm's `clientPaymentEmails` billing setting (default ON,
  `backend/src/modules/billing/shared/billingSettings.ts:17`). Both the Stripe
  webhook path (`stripe.events.ts:105`) and the internal billing path
  (`billing.events.ts:63`) check it before sending; the email functions
  themselves only format and send.
- **Per-recipient daily cap.** `sendEmail()` enforces a per-inbox daily send cap
  (default 100, `EMAIL_MAX_PER_RECIPIENT_PER_DAY`) so a single address cannot be
  mail-bombed through the public signing endpoints. See /dev/admin/rate-limiting.
- **Resend not configured** short-circuits sending entirely (`emailService.ts:169`),
  so a misconfigured environment silently skips rather than errors.

## Gaps & backlog

- **No subject-level retention schedule / recycle-bin.** Below the firm level,
  only the legal-hold subset and trust `retentionYears` exist; there is no
  scheduled purge for an individual client's or user's data outside an explicit
  erasure request. (Firm-level retention is implemented, see "Firm deletion"
  above. Never-verified accounts are also swept, see below.)
- **Erasure is anonymize-in-place**, so tombstones remain. Fully hard-deleting a
  subject across every referencing table is not implemented.
- **No published DPA.** The sub-processor page exists; a signed Data Processing
  Addendum needs counsel.
- **`COMPANY_POSTAL_ADDRESS` placeholder** must be filled (or the app kept to
  transactional-only mail) for a fully compliant footer.
- **Consent version bumps are manual** via the `POLICY_VERSION` env var; there is
  no re-consent prompt flow when the policy changes.

## Source

- `backend/src/modules/privacy/privacy.routes.ts` — the five privacy endpoints
- `backend/src/modules/privacy/privacy.service.ts` — consent, export, erasure logic
- `backend/src/modules/lawfirms/lawfirms.service.ts` (firm soft-delete, retention window, purge cron)
- `backend/src/modules/lawfirms/lawfirms.routes.ts` (`DELETE /api/lawfirms/:lawFirmId`)
- `backend/src/shared/services/emailService.ts` — compliance footer, `List-Unsubscribe`, per-recipient cap
- `backend/src/modules/billing/shared/billingSettings.ts` — `clientPaymentEmails` toggle
- `backend/src/shared/utils/securityLog.ts` — `data.export` / `data.erasure` events
- `backend/db/schema.sql` — multi-tenant tables, consent columns, legal-hold, trust immutability
