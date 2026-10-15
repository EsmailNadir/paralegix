# Cron Jobs

The scheduled `/api/cron/*` endpoints, what they do, why they exist, and what breaks
if they stop running.

## Summary

The backend exposes **eight** POST endpoints under `/api/cron/*`. They are plain HTTP
routes on the same Cloud Run service as the rest of the API, invoked on a schedule
by **Google Cloud Scheduler**. There is no in-process scheduler: each job is a
request that runs a batch of maintenance work and returns a JSON summary. The one
durable queue is rows, not a timer: signing jobs and folder exports sit in
`signature_processing_jobs` and `file_export_jobs` until `signing-jobs` drains them.

Every cron endpoint is gated by a shared `CRON_SECRET` compared with a timing-safe
check (`authorizeCronRequest` in `backend/src/app.ts:217`). The same gate protects
`GET /api/health/deep`, the operator probe that reports database reachability and
pool saturation. They are mounted **before** the global rate limiter
(`backend/src/app.ts:549`-`834`, limiter at `backend/src/app.ts:836`) so scheduler
traffic is never throttled, and they are kept in the request logs (unlike calendar
webhooks) because they are rare and ops-critical.

Each job is **idempotent** and safe to re-run: they only touch rows in a specific
state (e.g. `status='accrued'` fees, firms whose stored billing status diverged),
so a double-fire or a manual re-trigger never double-applies an effect.

## Key Takeaways

- **Eight endpoints, one auth gate.** `reminders`, `digest`, `calendar-watch`,
  `trust-fee-sweep`, `reconcile-billing`, `reconcile-trust-deposits`,
  `housekeeping`, and `signing-jobs`, all behind `CRON_SECRET`.
- **Only one run of a pass at a time, platform-wide.** Every handler except
  `signing-jobs` runs through `runCronPass` (`backend/src/app.ts:300`), which takes a
  `CRON_PASS` lease row in `lock_leases` keyed on its own name
  (`shared/database/advisoryLock.ts`). The lease is one upsert and holds no pool
  connection while the pass runs; it expires after `CRON_LOCK_MAX_HOLD_MS`, so a
  crashed pass stops blocking later runs. A run that cannot get the lock
  answers **`200 {"status":"skipped","reason":"already running"}`** — 200 rather
  than an error on purpose, because a non-2xx makes Cloud Scheduler retry, which
  is the opposite of what a "someone else is already doing this" skip wants.
  Cloud Scheduler is at-least-once and retries on timeout, so overlapping runs
  were reachable at any instance count, and overlap was not harmless: the
  per-firm rotation cursor got clobbered, recurring tasks were cloned twice, and
  reminder emails went out twice.
- **`housekeeping` is NEW and needs a scheduler job.** The sweeps it runs used to
  sit on `setInterval` timers inside their own modules. Those never fired on
  Cloud Run — background timers get almost no CPU between requests, and no
  autoscaled instance lives 24 hours — so until this job is scheduled, that work
  does not run at all.
- **The schedule is not in this repo.** No Cloud Scheduler config or cron YAML is
  checked in (`backend/cloudbuild.yaml` has none). The endpoints are the contract;
  the cadence lives in Cloud Scheduler.
- **Auth is timing-safe.** The secret is accepted as either `Authorization: Bearer`
  `<secret>` or an `x-cron-secret` header, compared with `crypto.timingSafeEqual`.
  With no `CRON_SECRET` set, every request is rejected `503` on any deployment.
  The only bypass is for a developer's own machine: `NODE_ENV` exactly `test` or
  `development`, a loopback socket peer with no forwarding header, and
  `x-cloudscheduler: true`. There is no "not production" fallback.
- **Three of them are money-critical.** `trust-fee-sweep` recovers ACH fees the
  platform would otherwise silently eat; `reconcile-billing` is the safety net that
  stops a missed subscription webhook from leaving a firm with indefinite free
  access or stuck locked; `reconcile-trust-deposits` posts client trust deposits
  that succeeded at Stripe but never reached the IOLTA ledger.
- **Jobs return summaries, not just `200`.** Each response body reports what it
  scanned/changed, so a scheduler run history is a usable audit trail.

## What is actually scheduled (and what is deliberately not)

The endpoints are the contract; the cadence lives in Cloud Scheduler. A live GCP check on
2026-09-16 UTC found **six jobs for eight endpoints**, split across environments:

| Job | Target | Schedule | State |
|---|---|---|---|
| `cron-reminders` | production | `0 8 * * *` | **paused, deliberately** |
| `cron-calendar-watch` | production | `0 */12 * * *` | enabled |
| `cron-staging-reconcile-billing` | staging | `0 9 * * *` | enabled |
| `cron-staging-trust-fee-sweep` | staging | `0 10 * * *` | enabled |
| `cron-staging-housekeeping` | staging | `30 3 * * *` | enabled |
| `cron-staging-signing-jobs` | staging | `* * * * *`, 30 min attempt deadline | enabled |

The live signing job still carries the obsolete `Authorization` header from its first failed
configuration in addition to the working `x-cron-secret` header. The backend authenticates the
second one; recent attempts returned HTTP 200 during this audit. Removing the redundant header is
cleanup, not an outage fix.

**`cron-reminders` is paused on purpose** — the owner does not want reminder email going out at
present. Do not resume it as a "fix". Everything it drives (invoice reminders, auto late fees,
matter-event and signing and task reminders, recurring-task spawning, notification purge) is
therefore not running in production, which is the intended state, not a gap.

**`digest` and `reconcile-trust-deposits` have no job in any region.** Both are unscheduled by
current choice rather than by oversight, and both are worth a deliberate decision later rather
than a quiet one now:

- `digest` is written to run **hourly**, not daily, because each recipient picks a delivery hour
  in their own timezone and a single daily fire could only ever serve one zone.
- `reconcile-trust-deposits` is the backstop that posts client trust deposits which succeeded at
  Stripe but never reached the IOLTA ledger. While it is unscheduled, that reconciliation only
  happens if someone runs it by hand.

**`cron-staging-housekeeping` is the one that must stay**, because the `setInterval` timers it
replaced have been deleted from the code. Without it, templates GC, invitation expiry, the four
signing sweeps, event-outbox retention, the soft-deleted firm purge, the unverified-account
sweep, and the files sweep do not run at all.

## Authentication

`authorizeCronRequest` (`backend/src/app.ts:217`) enforces the gate:

| Condition | Result |
|---|---|
| `CRON_SECRET` set and Bearer token or `x-cron-secret` matches (timing-safe) | `next()`, runs |
| `CRON_SECRET` set but neither matches | `403 Forbidden` |
| `CRON_SECRET` unset, `NODE_ENV` is exactly `test` or `development`, the socket peer is loopback (`req.socket.remoteAddress`, not `req.ip`) with no `X-Forwarded-For` or `Forwarded` header, and `x-cloudscheduler: true` | `next()`, local dev bypass |
| `CRON_SECRET` unset otherwise (any other or unset `NODE_ENV`, or any proxied request) | `503 Cron authorization is not configured` |

The comparison uses `timingSafeMatch` (`backend/src/app.ts:170`), which length-checks
then calls `crypto.timingSafeEqual`, so a wrong secret cannot be probed byte-by-byte
via response timing. Configure `CRON_SECRET` per environment (see
/dev/ops/environment-variables).

## The endpoints

| Endpoint | Work it does | Failure impact if it stops |
|---|---|---|
| `POST /api/cron/reminders` | Sends invoice, matter-event, signing, and task reminder emails; applies auto late fees; spawns the next occurrence of completed recurring tasks; purges old notifications; flushes file-share digests whose in-process debounce died with its instance | Clients/staff stop getting due-date and signature nudges, overdue invoices never accrue their configured late fee, recurring tasks stop regenerating, and the `notifications` table only grows; no data corruption |
| `POST /api/cron/digest` | Sends each recipient's daily digest of overdue and upcoming work, then purges old `digest_sends` rows | Staff stop receiving the daily deadline summary; no data corruption |
| `POST /api/cron/calendar-watch` | Renews expiring Google/Outlook push channels; retries stopping Google channels a previous stop failed to shut off; retries failed webhook syncs | Calendar sync silently goes stale as watch channels expire; orphaned Google channels keep pushing; dropped changes never recover |
| `POST /api/cron/trust-fee-sweep` | Charges accrued-but-unbilled trust ACH processing fees | Platform silently eats ACH deposit fees it fronted |
| `POST /api/cron/reconcile-billing` | Converges firm billing status against live Stripe subscriptions | A missed subscription webhook leaves a firm with indefinite free access, or stuck locked after a recovered payment |
| `POST /api/cron/reconcile-trust-deposits` | Posts succeeded Stripe trust deposits that never made it into the trust ledger | A client's money sits at Stripe with no matching IOLTA ledger entry, so the account under-reports and cannot reconcile |
| `POST /api/cron/signing-jobs` | Drains durable signing work (preparation hashes, finalization seals), then drains queued folder-export zips under the same deadline, deletes expired export archives, and fully re-reads one sampled sealed artifact and checks it against its session | Documents sent for signature never become ready, completed sessions never produce their executed artifacts, and folder downloads never finish; nothing is lost, because the work is a row and the next drain picks it up |
| `POST /api/cron/housekeeping` | Templates GC (and expired template renders), invitation expiry, the four signing sweeps (expired uploads, expired sessions, settled workspaces, stuck-finalization recovery), event-outbox retention, soft-deleted firm purge, the unverified-account sweep, and the files sweep | Orphaned template objects and expired invitations accumulate; signing scratch copies leak; deleted documents and abandoned upload rows are never destroyed, so storage keeps growing; **a signed document that failed to persist stays undownloadable**. The recovery pass exists to make that self-heal within minutes |

### `POST /api/cron/signing-jobs`

Handler at `backend/src/app.ts:798`, worker in
`backend/src/modules/signatures/signingJobs.ts`. Staging schedules it at **one
minute** with a **30 minute HTTP attempt deadline**. Production needs the same
job as part of cutover.

It also drains **folder exports** (`drainExportJobs` in
`backend/src/modules/files/zipExportJobs.ts`). A folder download is a row in
`file_export_jobs` that streams one zip into a temporary object, and it shares the
per-instance transfer slot with signing. The export drain works to the SAME
deadline as the signing drain rather than starting its own, because two stacked
25 minute budgets would outlive the 30 minute scheduler attempt. After it,
`sweepExpiredExports` deletes finished archives past `FILES_EXPORT_TTL_MS`.

It is deliberately unlike every other pass here, in three ways.

It **holds an open request while it works**, for up to 25 minutes with five
minutes of headroom, well inside Cloud Run's 3600s ceiling. Preparation hashes a
whole document and finalization seals two artifacts, and Cloud Run stops
scheduling CPU once a response is sent, so there is no such thing as finishing
after responding. The default scheduler attempt deadline is far shorter than the
work, and one that gives up mid-drain retries a job the drain is still inside.

It **does not take the `CRON_PASS` lock**. `runCronPass`'s lease expires after
`CRON_LOCK_MAX_HOLD_MS` (10 minutes), far short of a 25 minute drain, so it could
not keep a second drain out anyway.
Mutual exclusion here is per JOB, through a lease token re-checked on every
write, which is both stronger and free while idle. Two instances draining at
once cannot be inside the same job.

It **audits one artifact per run**. Production verification resumes the same
saved hash state that signing used, so a defect in that path is invisible to it:
the same wrong answer computed twice agrees with itself. The audit streams a
sampled artifact back out of storage, recomputes its digest from nothing, and
verifies its seal. A mismatch is logged as an alert and recorded on the session,
never retried quietly. It cannot fail the drain, because an audit that can break
the drain is one that gets turned off.

The response is `{ status, signingJobs, exportJobs, expiredExports, audit }`.
`signingJobs` reports `succeeded`, `failed`, `retried`, `lost`, `remaining` and
`truncated`. Read `remaining` to see whether the queue is keeping up and
`truncated` to see whether the budget is too small. An export or audit failure is
reported as `{ error }` in its own key and never fails the signing drain.

### `POST /api/cron/reminders`

Handler at `backend/src/app.ts:573`. Runs the invoice-reminder pass, the late-fee
sweep, the matter-event, signing and task reminder passes, then the
recurring-task generator, notification retention and the share-digest flush, and
returns their per-pass stats plus a top-level `truncated`:

- `sendOverdueReminders()`: `backend/src/modules/billing/invoices/invoiceReminders.service.ts:168`.
  Iterates every firm (or one), and for firms with `invoiceReminderEnabled` sends
  overdue and pre-due invoice reminders on the firm's configured reminder-day
  schedule (default `[7, 14, 30]`). Skips opted-out invoices, paid balances, and
  invoices already reminded within the window (`lastReminderSentAt` guard), so a
  re-run does not re-send.
- `sendMatterEventReminders()`: `backend/src/modules/matters/matterEventReminders.service.ts:74`.
- `sendSigningReminders()` — `backend/src/modules/signatures/signingReminders.service.ts:37`.
  Candidates are pre-filtered in SQL to active participants at 1/3/5 days in that
  were not reminded in the last 24h; the predicate is re-asserted in JS as a guard.
- `sendTaskReminders()` — `backend/src/modules/tasks/taskReminders.service.ts:131`.

Four non-email passes run alongside them:

- `applyAutoLateFees()`: `backend/src/modules/billing/invoices/lateFees.service.ts:20`.
  Only firms with `lateFee.enabled && lateFee.autoApply`; eligibility and
  once-per-invoice idempotency live in `invoices.service.applyLateFeeCore`, under
  the invoice row lock.
- `processRecurringTasks()` — `backend/src/modules/tasks/taskRecurrence.service.ts:101`.
  Finds completed tasks with active recurrence, clones each into its next
  occurrence at the computed due date, and disables recurrence on the completed
  row so a task can never spawn two successors. Honors `endDate` and
  `maxOccurrences` by disabling recurrence instead of generating.
- `notificationsRepo.purgeOld()`: `backend/src/modules/notifications/notifications.repository.ts:372`.
  Nothing else deletes notifications. Read items age out after 90 days, anything
  older than 365 days goes regardless, in bounded batches worked down over runs.
- `flushExpiredDebounces()`: `backend/src/modules/files/shareNotifications.service.ts:230`.
  Sends client file-share digests whose in-process debounce timer died with its
  instance (every deploy and scale-in). Claim-protected, so it cannot double-send
  against a live timer.

All four reminder passes honor a global reminders kill switch (`remindersGloballyDisabled()`) and
guard against duplicate sends with per-entity `lastReminderSentAt` timestamps, so
the job is idempotent within its window. Outbound mail additionally passes through
the per-recipient daily email cap (see /dev/admin/rate-limiting).

### `POST /api/cron/digest`

Handler at `backend/src/app.ts:628`. Sends each firm member their daily digest of
overdue and upcoming work, then purges `digest_sends` rows older than 30 days.

**This one runs hourly.** Every other cron here is fine on a fixed daily or
recovery cadence; this one is not. A recipient picks a delivery hour in their own
IANA timezone (`user_settings.timezone`, captured from the request header by
`shared/middleware/timezone.ts`), and `sendDailyDigests`
(`backend/src/modules/notifications/digest/digest.service.ts`) serves only those
whose local clock currently reads that hour. Fire it once a day and everyone
outside that single zone silently never receives a digest.

Firing it often is safe. The claim is an `insert ... on conflict do nothing` on
`digest_sends (law_firm_id, user_id, sent_on)`, where `sent_on` is the recipient's
LOCAL date — so at most one digest per recipient per local day regardless of how
many times the endpoint is hit. A send that fails releases its claim so the next
hour retries rather than losing the day.

Skipped without sending: a recipient whose local hour has not arrived, whose
`notifications.digest.enabled` is false, who has no items due inside the window,
or whose `days` setting is `weekdays` on a weekend. An empty digest is never sent
— a recurring "nothing due" email teaches people to filter it.

Honors the same global kill switch as the reminder passes
(`remindersGloballyDisabled()`), and the firm-level
`settings.emailNotificationsEnabled` and `settings.dailyDigest.enabled` switches.

Returns `{ status, digest: { sent, skipped, errors, firmsProcessed, firmsTotal,
truncated }, digestSendsPurged, truncated }`. If this job stops, staff lose the
daily deadline summary; because it also suppresses the per-task reminder emails
for anyone with the digest enabled (`taskReminders.service.ts`), an environment
that never schedules it loses task reminders entirely rather than falling back.

### `POST /api/cron/calendar-watch`

Handler at `backend/src/app.ts:642`. All passes share one `cronDeadline()` budget,
and each defers what it did not reach to the next run. Three concerns:

1. **Channel renewal.** Google watch channels and Outlook subscriptions expire on a
   provider-imposed short lifetime. `renewExpiringChannels()`
   (`backend/src/modules/calendar/google/google.service.ts:1394`) and
   `renewExpiringSubscriptions()`
   (`backend/src/modules/calendar/outlook/outlook.service.ts:1559`) re-arm the ones
   nearing expiry so push notifications keep flowing.
2. **Unstopped channels.** `retryUnstoppedWatchChannels()`
   (`google.service.ts:1440`) retries stopping Google channels a previous stop
   attempt failed to shut off, after purging ones Google has already expired.
   Google keeps pushing to an unstopped channel until its TTL runs out, so without
   this the live-channel count grows on every failed renewal.
3. **Durable webhook retry.** `retryFailedWebhooks()`
   (`backend/src/modules/calendar/shared/calendarWebhookRetry.ts:77`) drains the
   `calendar_webhook_failures` work queue. Calendar webhooks respond immediately and
   process async; when async processing throws, the webhook route persists a
   coalesced work item (one row per provider+user). This sweep re-runs the
   **idempotent** incremental sync with exponential backoff, resolves the row on
   success, reschedules on failure, and dead-letters after
   `WEBHOOK_RETRY_MAX_ATTEMPTS` (logging a count + sample of stranded rows on every
   run).

The response is `{ status, googleRenewal, outlookRenewal, unstoppedChannels,
webhookRetry, truncated }`, where `webhookRetry` is
`{ attempted, succeeded, failed, deadLettered, truncated }`.

If this job stops, watch channels lapse and calendar sync quietly stops updating,
and any change whose live-webhook processing failed is never retried.

### `POST /api/cron/trust-fee-sweep`

Handler at `backend/src/app.ts:676`. Calls `sweepAccruedTrustFees({ deadline })`
(`backend/src/modules/stripe/stripe.service.ts:2274`). When a client makes a trust
(IOLTA) ACH deposit, Paralegix owes Stripe the ACH processing fee and bills it to
the firm's card. If that up-front charge fails at settlement (no card on file,
decline, or SCA) or the firm had no Stripe customer yet, the fee row is left
`status='accrued'` instead of failing the deposit (the client's funds already
landed in trust).

The sweep lists accrued fees (default `limit` 500), charges each firm's card now via
`chargeAccruedTrustFee`, marks the fee billed, and returns
`{ status, trustFeeSweep: { scanned, processed, billed, skippedNoCustomer, truncated,
failures }, truncated }`. Each row is a serial card charge, so the run also stops at
its `cronDeadline()`; fees it did not reach stay accrued for the next run. It **only touches accrued rows**,
and the finalized fee invoice id is persisted on the row before it is paid, so a
retry reuses that invoice (pays it if still open, or just marks it billed if already
paid) rather than ever creating a second charge — even past Stripe's 24h
idempotency-key TTL. If this job stops, those fronted ACH fees are never recovered
and the platform absorbs them as a silent loss.

### `POST /api/cron/reconcile-billing`

Handler at `backend/src/app.ts:688`. Calls `reconcileBillingStatuses({ deadline })`
(`backend/src/modules/subscriptions/subscriptions.service.ts:577`). This is the
safety net for a missed or failed subscription webhook. It pulls the live Stripe
subscription for every firm that has one and, **only when the mapped status diverges
from what is stored**, re-runs the canonical webhook handler
(`handleSubscriptionChange` / `handleSubscriptionDeleted`) to converge — reusing all
their guards and side effects rather than duplicating them.

- Comped / `unlimitedOverride` firms are skipped (intentionally free).
- In-sync firms are never rewritten (no spurious plan writes or notifications);
  cosmetic drift in period dates is left alone.
- Subscriptions gone or terminal on Stripe (`canceled` / `incomplete_expired`)
  **lock the firm** exactly as the delete webhook would (`billing_status = 'canceled'`,
  `comped = false`); there is no free self-serve tier.
- A firm whose Stripe price id is not in the plan map (a rotated/legacy price) cannot
  be converged; it is counted as a `failure` (not silently as reconciled) and logged,
  so a firm silently keeping paid access on an unmapped price is visible.

Returns `{ status, billingReconciliation: { scanned, processed, reconciled, inSync,
skipped, skippedStale, truncated, failures }, truncated }`. If this job stops, a
webhook that Stripe failed to deliver (or that errored) can leave a firm with
**indefinite free access** (payment lapsed but never locked) or **stuck locked**
(payment recovered but never unlocked) until the next successful webhook.

### `POST /api/cron/reconcile-trust-deposits`

Handler at `backend/src/app.ts:702`. Calls `reconcileStripeTrustDeposits({ dryRun: false, deadline })`
(`backend/src/modules/stripe/stripe.service.ts:3214`). This is the trust-side
counterpart to `reconcile-billing`: the Stripe webhook is what normally posts a
client's trust deposit into the IOLTA ledger, so a webhook Stripe failed to deliver
leaves the client's money settled at Stripe with **no ledger entry backing it**. The
account then under-reports its balance and will not reconcile against the bank.

It scans Stripe payment intents created in the last 14 days (`sinceDays`), keeps only
those with `metadata.depositType === 'trust'` and `status === 'succeeded'`, and for
each one checks whether the trust ledger already has it.

- The existence check is **void-inclusive**
  (`findDepositByStripePaymentIntentIncludingVoid`). A deposit that was posted and
  later clawed back and voided must not be re-posted. Matching only live rows would
  resurrect it on every run.
- A recovered deposit is dated at **discovery time**, not settlement time, which is
  not recoverable here. That also keeps the entry out of an already-closed prior
  reconciliation period.
- Per-intent errors are collected into `failures` rather than aborting the sweep, so
  one bad intent does not block the rest.
- The service defaults to `dryRun: true`; the cron route passes `dryRun: false`
  explicitly. Call it directly with the default to see what a run *would* post.

Returns `{ status, trustDepositReconciliation: { dryRun, scanned, trust, missing,
posted, truncated, failures }, truncated }`. It auto-paginates every payment intent in
the window, so it is the pass most likely to hit its deadline; Stripe pages
newest first, so a truncated scan still covers the most recent deposits. It keeps
the 240s non-resumable budget (see [Budgets and scheduler deadlines](#budgets-and-scheduler-deadlines)).
`missing > 0` on a
steady-state run means webhooks are being dropped, which is worth investigating on
its own rather than just letting the sweep paper over it. Requires Stripe to be
configured, otherwise `503 STRIPE_NOT_CONFIGURED`.

### `POST /api/cron/housekeeping`

Handler at `backend/src/app.ts:723`. Runs the sweeps that used to sit on
`setInterval` timers, in sequence. Each is isolated: one that throws is reported as
`"failed: <message>"` under its own key and the rest still run. Returns
`{ status, housekeeping: { <pass>: <result> } }` with these passes:

| Key | What it does | Source |
|---|---|---|
| `templatesGc` | Collects expired template renders, then finds orphaned template objects. Deletes them only with `TEMPLATES_GC_DELETE=true`; otherwise a dry run that logs counts | `templates.routes.ts` `sweepOrphanedTemplateObjects` |
| `invitationsExpiry` | Expires stale firm invitations | `invitations.routes.ts` `sweepExpiredInvitations` |
| `signingExpiredUploads` / `signingExpiredSessions` / `signingSettledWorkspaces` | The three signing cleanup sweeps | `signing.routes.ts` |
| `signingFinalizeRecovery` | Recovers finalizations that failed to persist, capped at three minutes so the later passes still run. Wants the reminders cadence or better | `signing.routes.ts` `recoverStuckFinalizations` |
| `outboxRetention` | Event-outbox retention; a no-op when `EVENT_OUTBOX_WORKER` is off | `eventOutbox.ts` `runCleanupSweep` |
| `firmPurge` | Hard-purges soft-deleted firms past `FIRM_DELETION_RETENTION_YEARS` (10). Firms under a legal hold or with trust-ledger history stay pending | `lawfirms.service.ts:296` `purgeEligibleFirms` |
| `unverifiedAccounts` | Deletes accounts whose email was never verified, after `UNVERIFIED_ACCOUNT_GRACE_DAYS` (7). **Defaults to dry run** (`UNVERIFIED_ACCOUNT_SWEEP_MODE`); `on` deletes, `off` skips | `unverifiedAccounts.service.ts:182` `purgeUnverifiedAccounts` |
| `filesSweep` | Destroys documents soft-deleted more than `FILES_RETENTION_DAYS` (30) ago and upload rows claimed but never finished after `FILES_UNFINALIZED_HOURS` (24), object first and then row, skipping anything under a legal hold; then collects empty deleted folders. Returns `{ examined, destroyed, objectsRemoved, foldersDestroyed }` | `files/files.sweeper.ts:55` `sweepDestroyedFiles` |

Daily suits everything here except `signingFinalizeRecovery`, which backs a promise
that a signed document which failed to persist becomes downloadable within minutes.

## Triggering manually

Any endpoint can be fired by hand for testing or recovery. Send the shared secret in
either accepted form. Against the deployed backend:

```bash
# Bearer form
curl -X POST https://api-staging.paralegix.com/api/cron/trust-fee-sweep \
  -H "Authorization: Bearer $CRON_SECRET"

# x-cron-secret header form
curl -X POST https://api-staging.paralegix.com/api/cron/reconcile-billing \
  -H "x-cron-secret: $CRON_SECRET"
```

Locally (`http://localhost:5001`):

```bash
curl -X POST http://localhost:5001/api/cron/reminders \
  -H "Authorization: Bearer $CRON_SECRET"
```

Because every job is idempotent, a manual run is safe even if the scheduled run also
fires. The JSON summary in the response tells you exactly what it touched.

## Scheduling

No Cloud Scheduler definition or cron YAML is committed to this repo — the schedule
(cadence, target URL, and the secret header/OIDC config) is configured directly in
**Google Cloud Scheduler** per environment. Treat the eight endpoints and their
`CRON_SECRET` gate as the contract; the scheduler jobs point at them. Rough intended
cadence: `reminders` daily, `housekeeping` daily (more often if stuck-finalization
recovery should be faster), `signing-jobs` every minute with a 30 minute attempt
deadline, `calendar-watch` frequently (watch channels expire on a
short provider lifetime), `trust-fee-sweep`, `reconcile-billing`, and
`reconcile-trust-deposits` on a regular recovery interval (the deposit sweep looks
back 14 days, so it must run comfortably more often than that). See /dev/ops/deployment for how the service is deployed and
/dev/ops/incident-runbook for recovery steps.

### Budgets and scheduler deadlines

A pass must stop inside its Cloud Scheduler attempt deadline. Past it, the scheduler
records a failed attempt and retries into the `CRON_PASS` lock (answered `skipped`),
and the pass never reports how far it got. The daily staging jobs
(`reconcile-billing`, `trust-fee-sweep`) have a 180s attempt deadline.

| Budget | Default | Used by | Why |
|---|---|---|---|
| `CRON_BUDGET_MS` (`reminderHelpers.ts`) | 150s | `reminders`, `digest`, `calendar-watch`, `trust-fee-sweep` | Each resumes where it stopped: `forEachFirm` persists its cursor in `cron_pass_state`, calendar work is a due-set, and unreached trust fees stay `accrued`. 150s leaves margin for the unit of work already running at the deadline. |
| `NON_RESUMABLE_CRON_BUDGET_MS` (`reminderHelpers.ts`) | 240s | `reconcile-billing`, `reconcile-trust-deposits` | Each restarts from the same end on every run (oldest firms, newest payment intents), so stopping sooner drops more of the tail for good. This budget **outlives the 180s attempt deadline**, which is a known gap: the fix is a checkpoint, after which these move to `CRON_BUDGET_MS`. |
| `SIGNING_JOB_DRAIN_BUDGET_MS` | 25 min | `signing-jobs` | Its own budget under a 30 minute attempt deadline; see above. |

`REMINDER_CRON_BUDGET_MS` overrides both of the first two. `housekeeping` uses
neither: its sweeps run in sequence with no shared deadline, and only
`signingFinalizeRecovery` is bounded (3 minutes), so a slow day can outlive its
300s attempt deadline.

**`digest` must be scheduled HOURLY, not daily.** Each recipient chooses a
delivery hour in their own timezone, and the pass sends only to those whose local
clock has just reached it. A single daily fire can therefore only ever serve one
timezone: schedule it daily and every recipient outside that zone silently never
receives a digest. Hourly firing is safe because the `digest_sends` primary key
means at most one send per recipient per local day no matter how often it runs.

### Staging Queue Drain Configuration

The live staging job already exists. Use this shape when recreating it after an
intentional deletion, or when provisioning the production counterpart with the
production name, URL, and secret:

```bash
gcloud scheduler jobs create http cron-staging-signing-jobs \
  --location=us-east4 \
  --schedule="* * * * *" \
  --uri="https://api-staging.paralegix.com/api/cron/signing-jobs" \
  --http-method=POST \
  --headers="x-cron-secret=$CRON_SECRET" \
  --attempt-deadline=1800s \
  --description="Drains durable signing jobs and folder export archives"
```

Send the secret as `x-cron-secret`, the header every other staging and production job uses.
The staging drain was once created with an `Authorization` header holding the bare secret
without its `Bearer ` prefix, and it answered `403` on every run until it was switched. While
that job fails, nothing drains: a signer whose seal did not finish inline waits on "Sealing
document" until the page gives up, and the executed document is never produced.

## Source

- `backend/src/app.ts`: the eight cron handlers, `GET /api/health/deep`, `authorizeCronRequest` / `timingSafeMatch`, `runCronPass`
- `backend/src/modules/signatures/signingJobs.ts`, `signingAudit.ts`: signing drain and artifact audit
- `backend/src/modules/files/zipExportJobs.ts`: `drainExportJobs` / `sweepExpiredExports`
- `backend/src/modules/files/files.sweeper.ts`: `sweepDestroyedFiles`
- `backend/src/modules/users/unverifiedAccounts.service.ts`: `purgeUnverifiedAccounts`
- `backend/src/modules/lawfirms/lawfirms.service.ts`: `purgeEligibleFirms`
- `backend/src/modules/notifications/digest/digest.service.ts` — `sendDailyDigests`
- `backend/src/modules/notifications/digest/digest.repository.ts` — the windowed reads + `purgeOldDigestSends`
- `backend/src/shared/utils/localTime.ts` — recipient-local hour/day helpers the digest schedules on
- `backend/src/modules/billing/invoices/invoiceReminders.service.ts` — `sendOverdueReminders`
- `backend/src/modules/matters/matterEventReminders.service.ts` — `sendMatterEventReminders`
- `backend/src/modules/signatures/signingReminders.service.ts` — `sendSigningReminders`
- `backend/src/modules/tasks/taskReminders.service.ts` — `sendTaskReminders`
- `backend/src/modules/tasks/taskRecurrence.service.ts` — `processRecurringTasks`
- `backend/src/modules/billing/invoices/lateFees.service.ts` — `applyAutoLateFees`
- `backend/src/modules/calendar/google/google.service.ts` — `renewExpiringChannels`
- `backend/src/modules/calendar/outlook/outlook.service.ts` — `renewExpiringSubscriptions`
- `backend/src/modules/calendar/shared/calendarWebhookRetry.ts` — `retryFailedWebhooks`
- `backend/src/modules/stripe/stripe.service.ts` — `sweepAccruedTrustFees`
- `backend/src/modules/subscriptions/subscriptions.service.ts` — `reconcileBillingStatuses`
