# Functionality questions


Observed behavior that may not fit a firm's workflow, including open product decisions and
reliability concerns. Characterization tests describe current behavior; they do not prove it is
the right behavior. Fixed entries identify completed changes and their regression coverage.

[Competitor research and recommendations for all 29 open questions](./functionality-research-2026-10-04.md)
were reviewed on 2026-10-04. The selected reliability and usability fixes are recorded below; larger feature proposals remain open.

## How to read an entry

| Field | Meaning |
| --- | --- |
| **What the code does** | The behaviour, with the file that decides it. |
| **Why it may not fit** | The firm workflow it collides with. |
| **Elsewhere** | How another product handles the same problem, where I am confident of the fact. |
| **Decision** | Open until someone records an answer here. |

Add an entry when a test forces you to encode a rule that surprised you. A test that
pins surprising behaviour without recording the surprise is how a wrong rule becomes
permanent.

---

## Q01: financial reads cannot be withheld

**Decision.** Fixed. The six financial reads were removed from the baseline on both sides. Empty roles now retain only 17 collaboration codes. Built-in grants remain explicit; frontend explicit permission arrays take precedence over role labels. Route tests cover denial, explicit access and cross-firm refusal.

---

## Q02: a trust transfer is not labelled a transfer on the receiving account

**What the code does.** `backend/src/modules/trust/trust.repository.ts` writes a transfer
as two rows sharing a `transfer_group_id`: the source account gets `type = 'transfer'`,
and the destination account gets `type = 'deposit'` with the description
`Transfer from trust account`.

**Why it may not fit.** Filtering a trust ledger by transfers shows only outflows. On the
receiving account the money appears as an ordinary deposit, and only the description says
otherwise. A reconciliation that groups by `type` counts one side of every transfer as new
client money.

The double-entry itself is correct, and the `transfer_group_id` link is there. The
question is only what the receiving row is called.

**Elsewhere.** Clio documents explicit trust transfers and a trust journal, but its help page
does not establish the receiving row's internal transaction type or both accounts' exact labels.
See [the sourced comparison](./functionality-research-2026-10-04.md#q02).

**Decision.** Open. A `transfer_in` type, or a UI that reads `transfer_group_id` rather
than `type`, would both close it. The second needs no migration.

---

## Q03: a locked workspace still opens for anyone who can reach billing settings

**What the code does.** `frontend/src/app/lawfirm/[lawFirmId]/layout.tsx` replaces the
whole workspace with the paywall when billing is inactive, except on a path ending
`/settings/billing`. The exception is by path, not by permission, so every member of a
locked firm can open that page, not only the owner or someone holding
`settings.manageFirm`.

**Why it may not fit.** The backend is safe. Every mutation on
`backend/src/modules/subscriptions/subscriptions.routes.ts` requires
`settings.manageFirm`; only `GET /status` is open, and it is gated on `members.view`,
which is in the Q01 baseline.

The frontend page is the problem. `frontend/src/app/lawfirm/[lawFirmId]/settings/billing/page.tsx`
imports no permission helper at all. A member with no billing rights sees the plan, the
billing status, the period dates, and a full pricing table whose buttons call endpoints
that will answer 403. That contradicts the house rule that a page degrades to read-only
rather than offering an action it cannot complete.

**Decision.** Fixed. The billing settings page checks `settings.manageFirm` before mounting billing data or controls. Other members see the existing contact-administrator message. Regression: `frontend/tests/app/lawfirm/settings/BillingSettingsPage.test.tsx`.

---

## Q04: a member removed from the firm mid-session keeps working until a cache expires

**Research correction (2026-10-04).** `permissionCache.events.ts` already explicitly invalidates
member removal and role changes, with TTL as a backstop. The description below is incomplete,
not a verified blanket delay. Permission invalidation and token revocation need separate analysis;
their windows do not automatically add together. See [Q04 research](./functionality-research-2026-10-04.md#q04).

**What the code does.** The permission cache (`permissionCache` under
`backend/src/modules/lawfirms/roles/`) holds a member's resolved permissions for up to 30
seconds. Removing a member, or emptying their role, takes effect either when the app calls
`invalidate` or when that window elapses.

**Why it may not fit.** Thirty seconds is a deliberate and defensible bound. It is worth
naming because it is the same order as the token cache's own 30-second revocation window,
so the two stack: a revoked user can keep an authenticated session slightly longer than
either number suggests on its own.

**Decision.** Open, and probably "accept". The reason to record it is that a firm
terminating an employee expects "removed" to mean immediately, and nobody reading the code
would find both windows in one place.

**Covered by.** `backend/tests/auth/tokenCache.test.ts` pins the invalidated path. Nothing
pins the elapsed-TTL path.

---

## Q05: a signed-in user cannot reach the login page to switch accounts

**What the code does.** `frontend/src/app/login/LoginClient.tsx` redirects away as
soon as a Firebase session exists. There is no branch that keeps the form on screen
for someone who is already signed in.

**Why it may not fit.** Two accounts on one browser is normal in a firm: a partner
with a personal portal login as a client of another firm, an admin testing a
paralegal's view, a shared machine at reception. Today the only way to switch is to
sign out first, and the sign-out path leaves `/login?next=<the previous firm>` in the
URL, which the second account cannot open. `resolveLoginDestination` exists
specifically to catch that and send them somewhere valid, which is a fix for a
symptom of this.

**Decision.** Open. The cheapest answer is a "sign in as a different user" link that
signs out and returns to `/login` with no `next`. An account switcher is the larger
one.

**Note.** Until this session the redirect did not work at all, so a signed-in visitor
did in fact sit on the login form. That was a defect (DF05 in the progress ledger) and
is fixed. This entry is about the intended behaviour, now that it happens.

---

## Q06: a deep link is honoured when the membership check cannot run

**What the code does.** `resolveLoginDestination` in
`frontend/src/lib/utils/redirect.ts` checks a firm-scoped `next` against the account's
memberships. If that lookup throws, it returns the deep link anyway.

**Why it may not fit.** The comment defends it: the backend still refuses a firm the
user cannot open, and discarding the deep link on a network blip defeats the parameter.
Both are true. The cost is that the user lands on the workspace shell's full-page
"your account is not a member of this workspace", which is the exact dead end the
function was written to prevent, reached by a different route.

The trade is real either way. Recording it because the failure mode is invisible: it
only appears when the lookup fails, which is precisely when nobody is watching.

**Decision.** Open. A third option exists: retry the lookup once, as `getRedirectPath`
already does for the same endpoint, before deciding.

---

## Q07: reassigning a matter's client leaves an existing invoice's bill-to stranded

**What the code does.** A matter's attached organization is changed through two
independent calls, `remove-client-names` then `add-client-names`
(`backend/src/modules/matters/matters.service.ts`) - there is no dedicated transfer
endpoint. Neither call touches `invoices.client_id`, which is set once at invoice
creation and never revisited. Files, matter notes, and matter events all resolve
access live off the current `matter_clients` link, so they move with the matter
immediately and symmetrically. An invoice does not: `ensureMatterAccess` refuses the
old organization the matter itself the moment the link is removed, and
`invoiceBelongsToClient` on the new organization's side refuses the invoice because its
stored `client_id` still names the old organization. The invoice becomes reachable by
neither the old nor the new organization.

**Why it may not fit.** A firm reassigning a matter to a different client (a conflict
resolution, a referral, correcting a data-entry mistake) would reasonably expect the
matter's existing invoices to move with it, the same way its files and notes do. Instead
the invoice is orphaned in a way that looks, from either portal, like the invoice simply
vanished - no error, no note that it moved, nothing to search for.

**Elsewhere.** Not compared; no confident claim about how a comparable product handles a
client reassignment on an already-invoiced matter.

**Decision.** Open. This matches the existing "frozen bill-to" design already used for
billing-recipient snapshots (`billingRecipientSnapshot.service.ts`: an issued invoice's
recipient list is frozen at send time, not live), so it may be a deliberate extension of
that same philosophy to the bill-to identity itself. The alternative is to repoint
`invoices.client_id` during a matter-client reassignment, the way
`clientIdentityLinking.service.ts`'s `mergePlaceholder` already repoints every other
reference during an identity merge. Confirmed and pinned as a characterisation (not a
bug) in `backend/tests/organizations/matterClientTransferScope.test.ts`.

---

## Q08: a digest recipient gets no digest at all on the day of a spring-forward transition

**What the code does.** The digest cron polls hourly and sends to a recipient once their
configured local hour matches the current hour, deduped per calendar day
(`claimDigestSend`). On a spring-forward day, the wall clock skips directly from
(say) 1:59 AM to 3:00 AM, so a recipient configured for 2:00 AM never sees that hour
occur at all that day. Nothing catches this: no digest goes out, and no error or gap is
recorded anywhere.

**Why it may not fit.** A recipient who configured "send at 2 AM" would not expect one
specific day a year to silently produce nothing, with no signal that anything was
skipped. The fall-back direction is handled correctly (the hour occurs twice; same-day
dedupe already collapses it to one send), so only the spring-forward gap is asymmetric.

**Elsewhere.** Not compared; no confident claim about how a comparable scheduled-digest
product handles a skipped local hour on the transition day.

**Decision.** Open. A firm running that configured hour would simply see no digest that
one day and no indication why. Confirmed and pinned as a CHARACTERISATION (not a bug) in
`backend/tests/cron/cronEndpoints.test.ts`, with the transition date computed dynamically
from the real clock rather than hardcoded, so the test does not go stale.

---

## Q09: a permission-gated page fires its data requests before the gate decides anything

**What the code does.** `BillingPage` and `TrustPage` (`frontend/src/app/lawfirm/[lawFirmId]/`)
call their data hooks (`useBillingWorkbench`, `useTrustAccounts`, and the rest) unconditionally
at the top of the component. `RequirePermission`/`RequireFeature` only gate what the JSX
*renders* further down the tree. A viewer the page will ultimately refuse to show anything to
still triggers every one of the page's requests before that refusal is decided.

**Why it may not fit.** The backend's own authorization is the real boundary here - a refused
viewer gets no data back regardless - so nothing is actually disclosed. The cost is purely
wasted requests and a moment where network activity doesn't match what the screen shows. This
shape is not unique to these two pages: it is how `RequirePermission` is used as a wrapping
component across the codebase, so fixing it in isolation on billing/trust would be inconsistent
with every other gated page.

**Elsewhere.** Not compared; this is a structural question about this codebase's own gating
pattern, not a claim about how another product handles it.

**Decision.** Open, and scoped wider than one page: worth deciding once, for the pattern, rather
than per page. Confirmed deliberate-looking (matches the codebase-wide convention) rather than a
one-off bug. Pinned with characterization tests in
`frontend/tests/app/lawfirm/billing/BillingPage.test.tsx` and
`frontend/tests/app/lawfirm/trust/TrustPage.test.tsx`.

**Elsewhere confirmed.** The messages surface splits on this pattern instead of following it
uniformly. `FirmMessagesPage` (the conversation list) reproduces the same gap: `useConversations`
fires before `RequirePermission` decides, so an outsider's render still sends the inbox request.
The conversation detail page does not: its data hook sits inside `RequirePermission`, so a
refused viewer triggers zero thread requests. Both facts are pinned in
`frontend/tests/app/lawfirm/messages/MessagesListPage.test.tsx` and
`frontend/tests/app/lawfirm/messages/ConversationDetailPage.test.tsx`. This is evidence the
"wrapping component" convention is applied inconsistently even within one surface, not just
across surfaces.

---

## Q10: a retried document-request upload is charged and filed twice, but notified once

**What the code does.** `fulfillDocumentRequestItem` (`portal.service.ts`) is one HTTP request
that both stores the file and records the fulfillment, with nothing idempotent keyed on anything
the client can present again: `saveClientMatterUploads` names every object
`${timestamp}_${randomId}_${safeName}` (always fresh), and `document_request_fulfillments`
carries no unique constraint on `(item_id, object_path)`. A genuine retry - the client's browser
never saw the 201 and resubmitted the same file - is indistinguishable from intentionally
attaching a second document: it creates a second fulfillment row and a second storage charge.
The one exception is the firm-side notification, which collapses to one via
`notifications.repository.ts`'s `dedupe_hash` (type+title+body+entity, a 60s window) - built for
event-outbox retry idempotency, not for this, and content-blind (two genuinely different files
fulfilling the same item within the window dedupe identically).

**Why it may not fit.** A firm reviewing a checklist item sees two uploaded documents (and pays
storage for two) for what the client experienced as one action, with no notification hinting
that anything doubled.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Fixed. Checklist upload-init accepts a client action key and persists its original file/session references. Retries reuse those files and quota; finalize links each file once. The client retains the action through failed attempts and skips bytes the server already finalized. Separate submissions notify separately. Regressions: `backend/tests/documentRequests/documentRequestFulfillmentRetry.test.ts` and `frontend/tests/components/portal/clientPortalService.test.ts`.

---

## Q11: a failed matters-list load shows both the real error and the generic "adjust your filters" empty state

**What the code does.** `MattersGrid` (and `ContactsGrid`, same pattern) renders `ListView`'s
empty state purely off `rows.length === 0`, with no awareness of whether the list is empty
because the request failed or because there is genuinely nothing to show. So a failed list read
correctly shows a real, correctly-worded error banner (this is not the silently-swallowed-error
bug found on the billing/trust pages) AND, directly underneath it, "No matters found / Try
adjusting your search or filters" - technically true (there are zero rows) but worded as though
the user's own filters were the problem.

**Why it may not fit.** A viewer who sees an error banner AND a "try different filters" caption
in the same breath may reasonably widen or clear filters expecting that to help, when the actual
problem is that the request failed and nothing was ever loaded.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Fixed. The shared `ListView` distinguishes failed loads from successful empty results. Matters, tasks, clients and contacts pass their load failure state; leads apply the same distinction. Existing rows remain visible. Regressions: `frontend/tests/app/lawfirm/matters/MattersListPage.test.tsx` and `frontend/tests/components/ui/ListView.test.tsx`.

---

## Q12: concurrent invoice requests can double-bill a source

**Decision.** Fixed. Normal creates, split creates and edits now lock their firm/context and recheck billed sources inside the write transaction. Legitimate split shares remain allowed. Real HTTP concurrency tests cover competing creates, splits and edits.

---

## Q13: a generic notification-dedup window can silently drop a second, real trust alert

**What the code does.** `notifications.repository.ts`'s `createMany` suppresses a second insert
with the same `(type, title, body)` for the same recipient inside a roughly 60-second window (a
sliding-window pre-check plus a unique index keyed on a per-unix-minute dedupe bucket). The
`TRUST_LOW_BALANCE` alert's body text embeds the dollar balance. A client that crosses below the
firm's minimum, recovers, and crosses again at the exact same dollar figure within about a minute
gets only one alert, because the second insert reads as a duplicate of the first.

**Why it may not fit.** The suppression mechanism's own comment states it exists for outbox-retry
idempotency only - collapsing repeat deliveries of the SAME event, not coalescing two DIFFERENT
events that happen to render identical text. Nothing scopes it to that case: any two calls with
matching `(type, title, body)` collide regardless of cause, so a real second crossing can be
silently dropped as if it were a retry of the first.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Fixed. Trust alerts identify the crossing by its transaction ID. Notification storage uses a stable event bucket, so retries converge while distinct crossings with identical text both survive. Regression: `backend/tests/trust/trustMinimumBalanceAlerts.test.ts`.

---

## Q14: a client can be placed under legal hold, but only by direct database access

**What the code does.** `clients.legal_hold` exists as a real column and `removeClient` checks it
before allowing a delete (403, checked before the trust-activity guard). Matters have a full,
authorized route for this: `PATCH .../matters/:id/legal-hold`. Clients do not - no route in
`clients.routes.ts` or anywhere else ever writes `clients.legal_hold`. The protection exists and
works, but nothing in the product can currently turn it on for a client.

**Why it may not fit.** A firm handling a litigation hold on a person or organization client has
no way to invoke this protection through the UI or API; it is reachable only by someone with
direct database access setting the column by hand.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Open. Characterized (not fixed) in
`backend/tests/trust/trustRetentionAndDeletion.test.ts` by setting `legal_hold` directly via SQL,
since adding a route is a product decision (what permission should gate it, what UI surfaces it)
outside the scope of writing test coverage for the existing guard.

---

## Q15: `matters.update` is necessary but not sufficient to edit a matter

**What the code does.** The `matters.update` permission gates the write route, but
`updateMatter` also calls `assertMatterWriteAccess` -> `assertMatterFirmWideAccess`
(`backend/src/shared/utils/membership.ts:139-161`), which additionally requires the caller to be
firm owner/admin OR a member of that specific matter's `matter_members`. A member holding exactly
`matters.update` but not staffed on the matter is still refused with a 403 - just from the
service layer (`'User is not a member of this matter'`) rather than from `requirePermission`,
and with no distinct permission code of its own. Tasks carry an analogous, narrower rule
(`tasks.service.ts:205-209`) that only applies when the task is attached to a matter.

**Why it may not fit.** This isn't a functionality gap so much as a trap for future test authors:
a test that grants exactly `matters.update` and expects success will get a 403 for a completely
different reason (the "ethical wall" matter-membership rule) unless it also stages the caller
onto the matter. It reads like a permission-code bug until the second gate is known.

**Elsewhere.** Documented in code comments at the cited lines; matches the codebase-wide
"ethical wall" pattern used elsewhere for matter-scoped confidential work.

**Decision.** Open only as a documentation gap, not a behavior question - the stacking looks
intentional. Worth a note near the B02.2 route matrix so an A08/A09 test for a matter-scoped
write doesn't misattribute this as a missing permission grant. Pinned in
`backend/tests/permissions/writeGrantBoundary.test.ts`, which deliberately stages matter
membership before asserting the A09 success case.

---

## Q16: the calendar's initial-load failure has no retry affordance

**What the code does.** The calendar's load-failure banner (`ErrorNotification error={calendarError}
compact`, `Calendar.tsx:1573-1579`) is rendered with no `onRetry`. Every other primary
list/detail surface checked in this expansion round (billing, trust, matters, tasks, messages)
gives a failed initial load an explicit "Try again" button. On the calendar the banner only
clears via background navigation to a month whose data has never been attempted, or a full page
reload.

**Why it may not fit.** A first-time viewer who lands on a broken calendar has no visible way to
retry short of guessing to change the month.

**Elsewhere.** `frontend/tests/app/lawfirm/messages/MessagesListPage.test.tsx` and the
billing/trust/matters equivalents all assert a `role="button", name: "Try again"` on initial-load
failure; the calendar is the one surface in this round without it.

**Decision.** Fixed. The calendar error banner retries the failed window queries through the existing data hooks. Regression: `frontend/tests/app/lawfirm/calendar/CalendarPage.test.tsx`.

---

## Q17: `enforceFeatureAccess` gives an authenticated member's own plan limit the same error code as an unrelated permission refusal

**What the code does.** `enforceFeatureAccess` throws the shared `ForbiddenError` (403,
`code: 'FORBIDDEN'`) for a plan-excluded feature - the identical shape and code an ordinary
`requirePermission` refusal produces. There is no distinct code (e.g. `PLAN_FEATURE_DENIED`) the
way billing lockout gets its own `BILLING_INACTIVE`.

**Why it may not fit.** A client cannot distinguish "you lack `matters.create`" from "your plan
doesn't include trust accounting" by `code` alone, only by parsing the `error` message text. This
sameness is deliberate for a non-member (`requireFeature.ts`'s own header comment: the two
denials must be indistinguishable so the gate can't be used to probe a firm's plan/existence from
outside it) - but the new coverage shows it applies equally to a firm's own authenticated member
being refused their own plan's limits, where the oracle risk doesn't apply and a distinguishing
code would read as better UX.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Open. Pinned in `backend/tests/plans/featureGateRouteMatrix.test.ts`.

---

## Q18: `fileSharing` and `flatFees` are tier-gated in code but not denied by any real tier

**What the code does.** `planDefinitions.ts` sets `fileSharing: true` and `flatFees: true` on
every tier from starter through enterprise. `requireFeature('fileSharing')` /
`requireFeature('flatFees')` are mounted in `app.ts` exactly like the other five tier-gated
features (`trustAccounting`, `documentSigning`, `templates`, `analytics`, `calendarSync`), but no
pricing tier can currently deny either one - only a firm's own `settings.features` opt-out can.

**Why it may not fit.** Reads as vestigial tier-gating: a reviewer skimming `app.ts` would
reasonably assume these two follow the same "upgrade to unlock" model as the other five, but
today no plan choice withholds them.

**Elsewhere.** No comment near either feature's tier definitions explains why it's uniformly on;
nothing states this is intentional.

**Decision.** Open. Pinned in `backend/tests/plans/featureGateRouteMatrix.test.ts`, which denies
both via the firm-level opt-out rather than a tier, since no tier can produce the denial.

---

## Q19: the manual trust-deposit route has no dedupe against an already-posted Stripe deposit

**What the code does.** The ordinary manual trust-deposit route (`createTransactionSchema` /
`createTransaction`) has no field or mechanism to correlate an entry with a Stripe payment
intent, and therefore no dedupe against a deposit Stripe already posted. Two identical manual
`POST /transactions` calls both succeed and both post; the same is true of one manual call
against an already-webhook-posted Stripe deposit.

**Why it may not fit.** During bank reconciliation, staff who see a settled ACH deposit might
manually re-enter it without realizing the Stripe webhook already posted it, silently doubling a
client's trust funds with no application-level guard - only a human noticing two ledger lines
would catch it.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Open. This is an architecture question (a client-supplied idempotency key, or a
UI warning on a likely-duplicate manual entry, would be the shape of a fix), not a small guard,
so nothing was implemented. Pinned as current behavior in
`backend/tests/trust/trustConcurrency.test.ts`.

---

## Q20: the Files page's row-delete action is gated on `files.delete`, not the entity's own delete permission

**What the code does.** On the Files page's Matters/Tasks dashboard tabs, the per-row "Delete"
action calls `MattersService.deleteMatter`/`TasksService.deleteTask` - a full matter/task delete,
not a file delete - gated on `hasPermission("files.delete")`
(`frontend/src/app/lawfirm/[lawFirmId]/files/page.tsx:117`). The real Matters page gates the same
action on `matters.delete` (`MattersGrid.tsx:99`), and the real Tasks page on `tasks.delete`
(`TasksGrid.tsx:126`).

**Why it may not fit.** A member granted `files.delete` but not `matters.delete` sees a delete
icon on this page that the backend still refuses (`matters.routes.ts`'s own
`requirePermission('matters.delete')` catches it - no security bypass, just a misleading
affordance that fails on click instead of never appearing).

**Elsewhere.** Not evaluated for this entry.

**Decision.** Fixed. Verified the current Files page already checks `matters.delete` and `tasks.delete` for their respective rows. The permission regression cases in `frontend/tests/app/lawfirm/files/FilesPage.test.tsx` pass; no additional source change was needed.

---

## Q21: a queued calendar sync still uses a pre-disconnect token snapshot

**What the code does.** `syncToCalendars` (`backend/src/modules/calendar/calendar.events.ts`)
resolves each user's `{ userData, settings }` once per fan-out, then hands that snapshot into a
1.5-second debounced call. If the user disconnects their Google/Outlook account (deletes the
`user_oauth_tokens` row) after that snapshot was taken but before the debounce fires, the queued
sync never re-reads the database - it completes using the now-deleted token, up to ~1.5 seconds
after the user revoked consent.

**Why it may not fit.** This is distinct from the already-correctly-handled case of a matter
member being removed while a create is queued, which does not leak (the removal's delete for the
same debounce key overwrites the pending create - "latest wins"). A user who explicitly
disconnects a calendar mid-request has no equivalent protection.

**Elsewhere.** Not compared to a specific competitor; flagged as a narrow, real (not
hypothetical) consent-timing edge confirmed with a genuine gated race, not a theoretical read of
the source.

**Decision.** Fixed. Google and Outlook create/update/delete operations read current connection data at dispatch time, including queued calls that carry an older snapshot. Regressions: `backend/tests/calendar/calendarEventListeners.test.ts`.

---

## Q22: the invoice detail load failure has no retry affordance, matching a pattern seen across every detail page

**What the code does.** `InvoiceDetailView`'s initial-load failure panel shows the real error and
a "Back to [Client/Matter] Billing" button, but no `onRetry` - unlike `BillingPage` and
`TrustPage`, which both use `ErrorNotification` with `onRetry` for the equivalent load failure.

**Why it may not fit.** The plan's own per-page requirement states "API failure with retry," and
`ErrorNotification` already supports `onRetry` - it just isn't wired up here, so recovering from a
transient failure means leaving the page and coming back rather than one click. This is not
unique to invoices: the matter and task detail pages (found in earlier ticks) have the identical
gap, and Q16 already logged it for the calendar. This may be a pattern across every *_detail_
page specifically (as opposed to *_list_ pages, which generally do wire `onRetry`), rather than a
one-off omission.

**Elsewhere.** `BillingPage`, `TrustPage`, and the matters/tasks/messages LIST pages all wire
`onRetry`; every DETAIL page checked so far (matter, task, invoice, calendar) does not.

**Decision.** Fixed. Invoice, matter, task, client and lead initial-load errors use the existing retry affordance. Failed client reads no longer display a removal message. Regressions: the corresponding detail-page suites under `frontend/tests/app/lawfirm/`.

---

## Q23: the roles and members settings pages break the list-page retry pattern

**What the code does.** `RolesSettingsPage`'s and `MembersPage`'s `ErrorNotification` banners on
the top-level load failure render with no `onRetry`, even though `useRoles` exposes `refetch` and
`MembersPage` already has its own `load()` callback - both are unused for this purpose.

**Why it may not fit.** Every LIST page checked elsewhere in this app (matters, tasks, messages,
billing, trust) wires `onRetry` on this same `ErrorNotification` component for exactly this
failure shape. Q22 already logged the DETAIL-page version of this gap; these two are LIST pages
breaking that same list-page convention - a fresh instance, not a restatement of Q22.

**Elsewhere.** Matters/tasks/messages/billing/trust list pages all wire `onRetry`;
`RolesSettingsPage` and `MembersPage` do not.

**Decision.** Fixed. Roles and members settings expose retry using their existing loaders. Regressions: `RolesSettingsPage.test.tsx` and `MembersPage.test.tsx`.

---

## Q24: partial task reminder success suppresses recipient retries

**Decision.** Fixed. Recipient-level rows now track expiring token claims and successful-send windows. Failed recipients retry independently; accepted recipients remain suppressed. Tests cover overlapping sweeps, partial failure, expired claims, stale workers and firm scoping.

---

## Q25: outbox events without listeners are acknowledged as successful work

**What the code does.** `eventOutbox.dispatchRow` obtains the listeners registered for the persisted
event type and treats an empty listener list as a successful dispatch. The row is marked `done`,
with its attempt incremented and no error, even though no consumer ran.

**Why it may not fit.** A deliberately retired event type may be safe to drain this way, but a
renamed listener, deployment skew, or malformed persisted event can otherwise be silently lost.
The worker has no distinction between "no work is expected" and "required work has no consumer."

**Elsewhere.** Not evaluated for this entry.

**Decision.** Fixed. A missing consumer fails the outbox row with an explicit error and leaves it available for retry. Registering the consumer later allows it to complete. Regression: `backend/tests/events/eventOutbox.test.ts`.

---

## Q26: a resumable upload can succeed while its SQL mirror is missing

**What the code does.** `/upload-finalize` treats the GCS object as authoritative. If
`upsertFileRecord` fails, it logs the mirror failure and still returns `201` with the uploaded
file. The bytes remain in storage, but the normal SQL-backed Files browser has no row to list,
and the response does not identify the mirror failure or provide a repair state.

**Why it may not fit.** A signer or uploader can receive an apparent success and later be unable
to find the document in Files. The object then remains stored and counted, while cleanup, sharing,
and ordinary browsing depend on a mirror row that is absent. A retry may repair it only if the
client knows to retry despite the successful response.

**Elsewhere.** Not evaluated for this entry.

**Decision.** Open. Current behavior is pinned by
`backend/tests/files/resumableUploads.test.ts`'s
`CHARACTERIZATION: returns the uploaded file while leaving no files mirror row` test.

---

## Q27: concurrent document-request fulfillment can file two documents for one checklist item

**What the code does.** Two portal fulfillment requests for the same item can both succeed in
parallel. Each stores a separate object, inserts a separate fulfillment row, charges storage for
both files, and recomputes the same item/request status. The item ends in `received`, but there is
no idempotency key or single-fulfillment guard to distinguish a deliberate second attachment from
a browser retry whose first response was delayed or lost.

**Why it may not fit.** Multiple documents may be intentionally allowed for one checklist item,
but a retry caused by a timeout can duplicate storage and leave the client with two filed copies.
Adding a uniqueness constraint would be too strong if the product permits multiple documents, while
leaving the behavior unchanged makes the retry outcome depend on timing.

**Elsewhere.** Sequential retry already exhibits the same duplicate-record and double-charge
behavior; the new concurrent route test confirms it is not prevented by request overlap.

**Decision.** Fixed. Concurrent retries of one upload action reuse its original files, and repeated finalization inserts each item/file link once under the request lock. Multiple deliberate documents for an item remain supported. Regression: `backend/tests/documentRequests/documentRequestFulfillmentRetry.test.ts`.

---

## Q28: resumable-upload filenames exactly equal to `..` were preserved as path segments

**What the code did.** The resumable-init sanitizer replaced disallowed characters but allowed a
filename whose complete basename was `..`. The resulting object path ended in
`/<matter-id>/..`. GCS keys are opaque, but the application also parses and walks these slash-
separated object paths for listing, cleanup, and scope checks, so a traversal-shaped segment was
being introduced by user input.

**What changed.** Exact `.` and `..` basenames are now prefixed with `_` before unique-name
resolution. Ordinary dots inside a filename remain unchanged, and all existing duplicate-name and
prefix behavior stays intact.

**Decision.** Fixed as an unambiguous path-safety defect. Regression coverage is in
`backend/tests/files/resumableUploads.test.ts` under
`keeps traversal-shaped filenames inside the resolved firm and parent prefix`.

## Q29: “my pending member invites” exposed the invitation token

**What the code did.** The authenticated cross-firm endpoint returned the repository projection
directly. That projection included the token so the invitee could accept it, but the dashboard
banner does not need to expose the bearer secret in JSON.

**Why it may not fit.** Returning a live token creates another place for a credential to enter
browser state, logs, or telemetry. This endpoint can return invitations from several firms, so one
response can expose several credentials at once.

**Decision.** Fixed by applying the existing `stripToken` policy used by the firm pending-list
routes. The new route test in `backend/tests/users/invitations.test.ts` proves matching invites
from two firms are returned while their exact tokens are absent. A mutation that returned the raw
projection failed on the token assertion.

## Q31: account erasure can partially commit when Firebase deletion fails

**What the code does.** The self-service erasure anonymizes the Postgres user, removes
memberships/portal links, and then deletes the Firebase Auth identity. If the Firebase call fails,
the route returns `500`, but the SQL-side tombstone and membership removal have already committed.

**Why it may not fit.** A failed response suggests the user can retry the same untouched operation,
but the account is already partially erased. A later login may still be possible if the provider
identity was not deleted, while the application has removed the profile and memberships. The
operation also has no visible repair state or retry job for the provider deletion.

**Decision.** Fixed. Account closure creates a durable tombstone, blocks ordinary authenticated access immediately, and returns 202/pending when external cleanup fails. Housekeeping retries incomplete identities; successful cleanup stamps `identity_erased_at`. Ownership guards remain enforced. Regression: `backend/tests/privacy/privacySubjectRights.test.ts`.
## Q30: share-notification flushes outlive the test/request lifecycle

**What was observed.** The normal four-worker backend run emitted repeated `Cannot log after tests
are done` errors from `shareNotifications.flushClient`. Its fire-and-forget flush attempted to
update `pending_share_notifications` after the test lifecycle had already closed or truncated the
database connection, producing failed-query logs against the finished run.

**Why it matters.** In production, the same timing can lose notification delivery or report a
successful sharing request before its notification persistence has completed. In tests, it creates
cross-suite races and obscures the actual assertion failure; the broad run is not reliable evidence
until this background work has an explicit await/drain boundary.

**Decision.** Fixed. Scheduled and running share deliveries have a drain boundary for shutdown and test teardown. Per-client leases serialize delivery, the buffer is acknowledged only after successful delivery, and version checks preserve shares arriving in flight. Stable notification and email identities protect retries; replaying a delivered share event does not reopen it. Regression: `backend/tests/files/shareNotificationsEmailPreference.test.ts`.
## Q32: intake sends acknowledge failed delivery

**Decision.** Fixed. Intake delivery refusal now returns 503 or 429 and persists failed delivery state. Same-recipient resends preserve links. Replacement recipients receive a new token only after provider acceptance. Tests cover refusal, recovery, stable links and successful replacement.

## Q34: deleting a client needs no separate permission

**What the code does.** `clients.manage` covers creating, editing, archiving and deleting a client
(`backend/src/modules/clients/clients.service.ts`, `removeClient`). A delete is now refused when the
client is linked to a matter the caller cannot access, naming only the count, but a caller who can
reach every linked matter deletes with the same permission that edits a phone number.

**Why it may not fit.** A deletion cascades the client's notes, events and matter links, so a firm
may want to grant "edit clients" to staff without letting them erase one.

**Elsewhere.** Clio separates contact edit, delete, and bulk-delete grants. Filevine reserves
contact deletion/archiving to organization admins while allowing configurable creation/editing.
A comparable MyCase delete-only grant was not verified. See [Q34 research and sources](./functionality-research-2026-10-04.md#q34).

**Decision.** Open. Adding `clients.delete` needs a role migration and a backfill of the built-in
roles; not done in the matters, clients and tasks parity work.

## Q35: firm admins see every matter's tasks even when not on the matter

**What the code does.** Admins and owners are exempt from the matter-membership filter on lists and
reads (`isFirmOwnerOrAdmin`, `seeAll`). The matter Tasks tab now follows the same rule as the rest
of the app.

**Why it may not fit.** A firm with an ethical wall around one matter cannot keep an administrator
out of it.

**Elsewhere.** Clio documents restricted matters for administrators and administrator control
over permissions, but also warns of exposure through billing, accounts, and reports. MyCase
documents assigned-only access without establishing whether administrators are exempt. Neither
supports a blanket claim of strict isolation across all modules. See [Q35 research and sources](./functionality-research-2026-10-04.md#q35).

**Decision.** Open. Adopting Clio's model touches every read path that uses `seeAll`.

---

## Q36: a deleted firm still consumes its owner's firm membership slot

**What the code does.** Soft deletion retains the owner membership so the firm can be restored. `users.repository.getLawFirmIdsForUser` and `invitations.repository.getUserFirmIds` count all membership rows, including firms pending deletion. The one-firm cap therefore prevents that owner creating a replacement firm. A confirmed invitation switch can retain the deleted firm's owner row while adding the destination membership.

**Why it may not fit.** The deleted workspace is inaccessible, but its retained membership still counts toward the active user's cap throughout the retention period. Changing this needs a decision about restoring a firm when the owner has since joined another firm.

**Decision.** Open. Decide whether pending-deletion memberships count toward the cap and, if they do not, how restoration should enforce that cap. `tests/lawfirms/lawfirmsServiceOps.test.ts` characterizes the current retention and cap behavior.

---
