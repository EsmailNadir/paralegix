# Unverified-Account Sweep

How accounts that never verified their email are deleted, and the assumptions that
keep that from deleting a real person.

## Summary

Signup writes a Firebase Auth identity **and** a `users` row before the address is
proven. `POST /auth/create-user` runs on `verifyTokenAllowUnverified` because the
record has to exist before the user can verify. Firebase then refuses a second
signup for that email, so an account created with someone else's address occupied
it permanently, and the victim had no self-service way out: the verify-email page
offers only resend and sign-out.

`purgeUnverifiedAccounts`
(`backend/src/modules/users/unverifiedAccounts.service.ts`) runs in the daily
`housekeeping` cron and deletes accounts still unverified after
`UNVERIFIED_ACCOUNT_GRACE_DAYS` (default **7**), freeing the address.

This is the only code path in the app that deletes a live account with no human
asking, so it is built on one rule: **anything unknown, unreachable or unexpected
KEEPS the account.**

## Key Takeaways

- **It ships inert.** `UNVERIFIED_ACCOUNT_SWEEP_MODE` defaults to `dry-run`: every
  guard is evaluated and the counts are reported, but nothing is deleted until the
  mode is explicitly set to `on`. `off` skips the pass entirely.
- **An unverified account is already harmless.** Every route except
  `create-user` and `user-type` answers 403 `EMAIL_NOT_VERIFIED`, and invites are
  only claimed once `emailVerified` is true. The harm this fixes is the squatted
  address and the indefinitely retained third-party email, not access.
- **Two layers decide "in use".** `findAccountActivity` checks every reference
  Postgres would change *silently*; the database itself refuses the rest.
- **The row is deleted before the Firebase identity**, so the database is the last
  line of defence rather than the first casualty.
- **`npm run db:user-delete-guards` fails the build** if a new cascading foreign
  key to `users(id)` is added without a matching probe.
- 33 offline tests in `backend/tests/users/unverifiedAccounts.test.ts`.

## What it depends on

Each of these is load-bearing. Changing one without changing the sweep is how this
starts deleting real accounts.

### 1. Foreign-key delete rules on `users(id)`

**The single most important dependency.** Of the roughly 98 foreign keys to
`users(id)` in `schema.sql`, all but fourteen have **no delete action** (or
`restrict`), so Postgres aborts a delete that would orphan them. Those need no
application check: they cannot be lost silently.

The fourteen declared `on delete cascade` or `on delete set null` are the
exception. Those are the only references the database will quietly destroy or
unlink, so `findAccountActivity` (`backend/src/modules/users/users.repository.ts`)
probes twelve of them: `members`, `matter_members`, `clients`,
`file_client_access`, `task_assignees`, `task_subtasks`, `event_assignees`,
`conversations`, `user_oauth_tokens`, `oauth_states`, `notifications`,
`digest_sends`. It also probes `matters` (created/lead) and
`conversation_participants`, which are no-action/restrict, because a named skip
reads better in the cron output than a foreign-key error.

::: danger Adding a cascading FK to users(id) means adding a probe
`members`, `matter_members`, `task_assignees`, `event_assignees`,
`file_client_access` and `notifications` CASCADE, and `clients.user_id`,
`conversations.client_id` and `task_subtasks.assignee_user_id` are SET NULL. An
unguarded delete would strip a real person out of their firm, or silently
unassign their work, **and report success**.

`npm run db:user-delete-guards` (`backend/db/check-user-delete-guards.ts`) parses
`db/schema.sql` (generated from `db/schema/*.sql`), extracts every
cascading/set-null FK to `users(id)`, and fails if one is not probed. Two keys are
deliberate exemptions, each listed with its reason in `ALLOWED_UNGUARDED`:
`email_verification_whitelist.created_by` (records who added an entry) and
`file_export_jobs.requested_by` (a temporary zip of firm documents, swept within
24 hours). Today the check reports 12 guarded and 2 exempt.
:::

### 2. Verification state lives only in Firebase

`users` has **no `email_verified` column**. The repository can therefore only
filter on age, and the service must confirm every candidate against Firebase Auth
(`auth.getUsers`, 100 uids per call). If a verified flag is ever added to Postgres,
the age-only query is no longer the whole story and both halves need revisiting.

### 3. Invites are claimed only after verification

`createUser` gates `checkAndProcessMemberInvites` / `checkAndProcessClientInvites`
on `userRecord.emailVerified`. That is what makes an unverified account harmless,
and it is also why the sweep needs its **email-keyed** guards: an invited client
who has not verified has nothing linking their account to the firm, so a uid-keyed
check cannot see them. If invite claiming ever moves before verification, both the
squatting threat model and these guards change.

### 4. Erasure keeps an anonymized tombstone

`anonymizeAccount` deletes the Firebase identity but deliberately keeps the row, so
the no-action foreign keys stay valid. To a Firebase lookup a tombstone is
indistinguishable from an orphan. `findOlderThanDays` therefore excludes them in
SQL by their `@deleted.invalid` email. Without that filter the sweep would try to
delete a tombstone every run and fail against whatever still references it. The
domain is a shared constant, `ERASED_ACCOUNT_EMAIL_DOMAIN`; changing the tombstone
format in one place and not the other silently breaks the exclusion.

### 5. Cron ordering inside `housekeeping`

`invitationsExpiry` runs earlier in the same pass than `unverifiedAccounts`. That
ordering is why a lapsed invite stops holding an address within one cycle: it is
flipped `pending` → `expired` before the sweep reads it. Only `pending` invites
block.

### 6. The whitelist is read from the table, not the cache

`isWhitelisted()` answers from a set loaded fire-and-forget at module import and
refreshed on a 15-second timer. That is the right trade on the auth path, where a
stale entry only delays a sign-in. It is the **wrong** trade here: a cron process
firing before the first load completes would have seen only the env whitelist.
`findWhitelistedEmails` reads `email_verification_whitelist` directly, unioned with
`ENV_WHITELIST`. Do not "simplify" it back to `isWhitelisted`.

## What blocks a sweep

| Guard | Counter | Why |
|---|---|---|
| Platform admin | `keptAdmin` | Never sweep a super-admin |
| Blank email | `keptNoEmail` | An account that cannot be reasoned about |
| Verification whitelist | `keptWhitelisted` | Test accounts bypass verification by design |
| Pending invitation at that address | `keptInvited` | A real person is mid-onboarding |
| A firm has a client at that address | `keptClientRecord` | Same, for portal clients |
| Verified, or any non-password provider | `keptVerified` | The provider vouches for the address |
| Firebase creation time inside the window | `keptRecent` | The more generous clock wins |
| Any `findAccountActivity` hit | `keptInUse` (+ `keptInUseBy`) | The account is in real use |
| Firebase identity actually present | `keptAuthPresent` | A batch absence was wrong |
| Foreign-key violation (SQLSTATE 23503) | `keptReferenced` | The database backstop working |

`keptInUseBy` breaks the in-use count down by which probe matched, which is what
makes a dry run readable.

## Failure behaviour

- **Systemic failures abort the run** before anything is deleted: an unreadable
  whitelist, unreadable firm records, or an unreachable Firebase all throw. They
  never degrade into "assume not whitelisted" or "assume no identity".
- **A missing Firebase identity is re-confirmed one-to-one** with `auth.getUser`.
  Only an explicit `auth/user-not-found` counts, so a batch anomaly cannot be read
  as "this user is gone".
- **Per-account failures are counted and skipped**, never retried destructively.
- **Deletion order is the row first, then the identity.** The row delete is the
  guarded step, so a uid the checks somehow missed keeps both its data and its
  login. The cost is that a crash between the two steps leaves a Firebase identity
  with no row pointing at it, keeping that one address blocked until an operator
  clears it: a recoverable inconvenience for one account, where the reverse order
  risks taking the login off a real user.
- **Config cannot be made dangerous.** `GRACE_DAYS` is floored at 1 and validated
  as finite; an empty, zero or negative value would otherwise select every account
  ever created. `SWEEP_BATCH` is clamped and capped at 1000.

## What a delete actually removes

Deleting the row cascades `user_oauth_tokens`, `oauth_states`, `members`,
`matter_members`, `task_assignees`, `event_assignees`, `file_client_access`,
`file_export_jobs`, `notifications` and `digest_sends`, and the service also
wipes the GCS profile-photo prefix. (Settings are columns on `users`; there is no
separate `user_settings` table.)

Email-keyed firm records are deliberately left, because they belong to the firm
rather than to the account. **Invitations are never removed**: `invitations` has no
foreign key from its address columns, and its `invited_by` / `accepted_by` columns
have no delete action, so they abort a user delete rather than cascade from it.
`expireStaleInvitations` only flips a status; it never deletes a row.

## Tests

`backend/tests/users/unverifiedAccounts.test.ts`, 33 cases, fully offline. The
repository, Firebase, whitelist and GCS are mocked:

```bash
__TEST_TOKEN__=offline npx jest tests/users/unverifiedAccounts.test.ts
```

They cover each guard above, all three modes, orphan re-confirmation, the deletion
order, config clamping, Firebase chunking at 100, and every dependency-failure
path. The suite was mutation-checked: removing the whitelist, invitation,
client-record, admin, orphan-re-confirmation or grace-period-floor guards, reversing
the deletion order, or making dry-run delete each produce failures.

::: warning The service reads its env into consts at import
`MODE`, `GRACE_DAYS` and `SWEEP_BATCH` are evaluated once at module load, which is
what stops a misconfigured env being changed under a running process. Tests must
therefore `jest.resetModules()` and re-require to change them; setting
`process.env` after import has no effect.
:::

## Improvements

- **Nothing tells the victim.** A person whose address was squatted gets no notice
  when it is freed, and no way to report it in the moment. A "this is not my
  account" link on the verify-email page would fix the case directly rather than
  waiting seven days.
- **The `keptClientRecord` guard is deliberately conservative.** It also protects a
  squatter who targeted a real client's address, which is the exact case the sweep
  exists for. Read the dry-run counters before deciding whether to relax it.
- **No admin visibility.** There is no route to list or force-sweep a squatted
  address; an operator needs database access.
- **The sweep is uid-by-uid.** Fine for a daily pass, but the per-account probe
  list is up to fifteen queries; a single `EXISTS` union would matter if the
  candidate set ever gets large.
