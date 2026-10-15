# Functionality research, 2026-10-04

This covers all 29 open entries in [the question ledger](./functionality-questions.md).
Recommendations are proposals, not approved decisions or implemented changes. Fixed entries
are outside this research. Sources are official product help pages and engineering references,
reviewed on the date above. Product documentation describes supported behavior; it does not
prove an undocumented database schema, cache strategy, or retry guarantee.

Evidence labels distinguish **competitor** behavior, **adjacent** behavior that does not answer
the exact question, and **engineering/UX** guidance. The recommendation in each entry is our
judgment. No claim here establishes a jurisdiction's trust-accounting or retention requirements.

## Q02

**Evidence: competitor, partial.** Clio has explicit trust-transfer workflows and records
transfers in its trust journal. Its help page does not establish the internal transaction type
on each receiving ledger row. [Clio trust account management](https://help.clio.com/hc/en-au/articles/9285403397915-Trust-Account-Management).

**Recommend:** identify both sides as transfers in the UI, filters, and exports using
`transfer_group_id`. Keep the existing debit/credit accounting unless a separate schema review
establishes a reason to change it. An incoming transfer should not be reported as new external funds.

## Q03

**Evidence: competitor, adjacent.** Clio limits account and payment changes to administrators
with the appropriate permissions; this does not prove how its locked-workspace page appears
to ordinary members. [Clio account and payment information](https://help.clio.com/hc/en-150/articles/11268277839771-Manage-Account-and-Payment-Information-in-Clio-Manage).

**Recommend:** let an ordinary member see a minimal billing-inactive explanation and contact-admin
action. Show subscription details and purchase/change buttons only to authorized billing managers.

## Q04

**Evidence: competitor and local correction.** Filevine documents that removing a user prevents
new logins but an already signed-in user is signed out after one hour. Immediate removal has
additional steps. There is no universal immediate-session-cutoff convention.
[Filevine member removal](https://support.filevine.com/hc/en-us/articles/360004187631-Add-or-Remove-Members).

The current local `permissionCache.events.ts` already invalidates member removal, member role
changes, role permission changes, and firm deletion. The ledger's blanket TTL description is
therefore incomplete. Token revocation and permission-cache invalidation are separate mechanisms;
their TTLs cannot simply be added without checking the request path.

**Recommend:** retain event invalidation with TTL as a backstop. Verify propagation across server
instances and requests already in flight before promising immediate revocation. Document the
actual worst-case window; do not weaken current invalidation merely because a competitor is slower.

## Q05

**Evidence: competitor, adjacent.** Clio Draft supports multiple organizations under the same
email and an explicit organization switch action. That is different from switching between
two login identities. [Clio Draft account settings](https://help.clio.com/hc/en-us/articles/24313887490203-Clio-Draft-Account-Settings-and-User-Invitation).

**Recommend:** add a clear "Sign in as a different user" action that signs out and clears the old
firm's `next` destination. Treat a same-identity workspace switcher as a separate feature.

## Q06

**Evidence: UX, not verified competitor login behavior.** Carbon's empty-state guidance calls
for a useful next action when a system error prevents loading.
[Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Recommend:** preserve the deep link, retry a transient membership lookup once, and offer a
recoverable retry screen if it still fails. Unknown membership should not become "not a member."
The backend must continue authorizing every subsequent request.

## Q07

**Evidence: competitor, adjacent only.** Clio distinguishes bill-editing rules by bill state
and lets staff explicitly choose bill recipients. Neither page answers whether changing a
matter's client automatically moves existing invoices.
[Clio editing bills](https://help.clio.com/hc/en-us/articles/9285222010395-Edit-Bills),
[Clio sending bills](https://help.clio.com/hc/en-us/articles/9285343645595-Send-Bills-for-Billing-in-Clio).

**Recommend:** preserve issued invoice identity and history. Offer an explicit correction workflow
with different rules for draft and issued/paid invoices. Give authorized bill recipients
invoice-specific access without retaining access to the old client's whole matter. Do not silently
rewrite all invoices when a matter-client link changes, and do not leave either party guessing
where an outstanding bill went.

## Q08

**Evidence: engineering counterexample.** AWS EventBridge Scheduler explicitly skips a cron
occurrence at a nonexistent spring-forward time and runs only once at the repeated fall-back
time. Catch-up is not a universal scheduling rule.
[AWS schedule types and DST](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html).

**Recommend:** for a daily digest, send at the next valid local hour on the same day and keep
per-recipient/day deduplication. This is a product preference, not a competitor requirement.
Keeping skip behavior is defensible if clearly documented and observable.

## Q09

**Evidence: engineering.** TanStack Query supports conditional fetching through `enabled`;
this is an implementation reference, not evidence of a legal competitor's internal hooks.
[TanStack disabling queries](https://tanstack.com/query/latest/docs/framework/react/guides/disabling-queries).

**Recommend:** mount the data-loading component only after the permission/feature gate allows it,
or explicitly enable fetching after authorization resolves. Use one shared convention across
surfaces, preserving unconditional React hook ordering and backend authorization.

## Q10

**Evidence: adjacent competitor plus engineering.** MyCase intake forms can allow multiple
documents in one upload field. Stripe documents request-key idempotency for retried writes.
Neither establishes MyCase document-request retry behavior.
[MyCase intake upload fields](https://supportcenter.mycase.com/en/articles/9628063-dynamic-intake-forms-with-conditional-logic),
[Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

**Recommend:** allow deliberate additional attachments, but give each upload action a stable
idempotency key. Replaying that action must return the same fulfillment without another object,
storage charge, or notification. A fresh action key represents a new attachment.

## Q11

**Evidence: UX.** Carbon distinguishes error empty states from successful no-data states.
[Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Recommend:** show an error with retry when loading fails; show filter advice only after a
successful empty result. Keep already-loaded rows visible during a failed refresh when possible.
Apply this to the shared list pattern.

## Q13

**Evidence: engineering.** Stripe's webhook guidance describes identifying repeated deliveries
by event identity, rather than rendered notification text. Competitors' trust-alert deduplication
internals are not established by the reviewed help pages.
[Stripe duplicate-event guidance](https://docs.stripe.com/webhooks).

**Recommend:** deduplicate repeat delivery of the same domain event per recipient. Give each
distinct balance crossing its own identity, even if the balance and text repeat. If alert throttling
is wanted, define it separately and make suppression observable.

## Q14

**Evidence: adjacent DMS product.** iManage exposes legal-hold management for workspaces,
folders, and records; removing the last hold resumes retention. This is not evidence that Clio
or MyCase implements a person-client hold switch.
[iManage modifying legal holds](https://docs.imanage.com/cloud/idm-user-help/en-US/Modifying_legal_holds.html).

**Recommend:** if client holds are a supported product capability, provide authorized hold/unhold
actions with a reason and audit history, and clearly define which related records they protect.
Keep database enforcement. Direct SQL should not be the ordinary user workflow.

## Q15

**Evidence: competitor.** Clio restricts individual matters to selected users/groups; MyCase
offers access limited to assigned matters. Role grants and resource access can coexist.
[Clio matter permissions](https://help.clio.com/hc/en-us/articles/9286062516123-Matter-Permissions-and-Rates),
[MyCase user access](https://supportcenter.mycase.com/en/articles/12758100-how-can-i-manage-user-access-and-permissions-effectively-in-8am).

**Recommend:** retain both gates and document them beside the permission matrix. A global edit
grant should not automatically bypass a restricted matter. Decide administrator exceptions under Q35.

## Q16

**Evidence: UX, not a verified competitor calendar failure screen.** Error states should offer
a useful recovery action. [Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Recommend:** add retry for the current calendar range without requiring month navigation or a
whole-page reload. Preserve the selected date and view.

## Q17

**Evidence: competitor, adjacent.** Clio documents plan-dependent automated workflows and
directs users to an administrator for an upgrade. This supports explaining entitlement limits,
but does not establish a competitor API error code.
[Clio automated workflow availability](https://help.clio.com/hc/en-150/articles/35132279298843-Clio-Manage-Automated-Workflows).

**Recommend:** preserve indistinguishable denials for outsiders. For verified firm members,
return a structured plan-limit reason, distinct from missing role permissions, and show upgrade
actions only to billing managers; other members get contact-admin guidance.

## Q18

**Evidence: competitor, partial.** Clio supports flat-fee matter rates. That does not determine
our pricing, nor prove a stable cross-product tier convention for file sharing.
[Clio rates](https://help.clio.com/hc/en-us/articles/9289801180187-Rates-and-Rate-Hierarchies).

**Recommend:** retain availability on all current tiers unless pricing strategy independently
changes. Document these gates as firm-configurable features with currently universal entitlement.
Do not invent a paywall to make the implementation look less redundant.

## Q19

**Evidence: competitor plus engineering.** Clio Accounting offers matching imported bank
transactions to existing records and excluding imports, and documents automatic matching for
Clio Payments. Stripe request idempotency addresses retries, a different problem.
[Clio Accounting banking](https://help.clio.com/hc/en-us/articles/21004158222235-Clio-Accounting-Banking),
[Clio Accounting automations](https://help.clio.com/hc/en-us/articles/41922722162843-Clio-Accounting-Automations),
[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

**Recommend:** use stable request keys for manual retries and provider references for known payment
matching. Warn about likely duplicates during reconciliation and offer match instead of add.
Equal amount/date/client alone must not block two genuine deposits.

## Q20

**Evidence: competitor plus internal contract.** Clio distinguishes matter deletion from
other action permissions. Locally, the backend already defines the required matter/task grant.
[Clio custom-role permissions](https://help.clio.com/hc/en-us/articles/40062980685467-Overview-of-Custom-Role-Permissions).

**Recommend:** use the target entity's delete permission and explicitly name the entity in the
confirmation. This is a UI/backend contract mismatch, not a reason to change permission policy.

## Q21

**Evidence: provider engineering guidance.** Google recommends revoking and deleting tokens
that are no longer needed. This does not establish how competitors cancel queued jobs.
[Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

**Recommend:** disconnect cancels queued syncs and invalidates the integration generation;
the worker rechecks current authorization before provider calls. Revoke provider tokens where
supported. Already-dispatched provider requests may still finish, so avoid promising cancellation
of every operation already in flight.

## Q22

**Evidence: UX.** Error recovery applies to details as well as lists.
[Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Recommend:** offer retry alongside back navigation on invoice, matter, and task detail failures.
Preserve context rather than forcing users to leave and find the same item again.

## Q23

**Evidence: UX.** A failed settings list needs a next action as much as an operational list.
[Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Recommend:** wire the existing role/member reload functions to retry. Use the same shared error
component and behavior as the other lists.

## Q25

**Evidence: engineering.** Transactional outboxes make persisted work deliverable after commit;
dead-letter queues retain failed messages for diagnosis. These sources do not dictate our
listener registry, and competitor outbox internals were not verified.
[AWS transactional outbox](https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html),
[AWS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).

**Recommend:** acknowledge explicitly retired event types only. Unknown or required types with
no consumer must remain recoverable, with bounded retry, quarantine, and an alert. A zero-listener
dispatch should not silently count as completed required work.

## Q26

**Evidence: engineering.** Microsoft's asynchronous request-reply pattern uses accepted/pending
work and an observable status resource when completion takes place later. This is not evidence
of a competitor's storage architecture.
[Microsoft asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply).

**Recommend:** make finalization idempotent and persist repair work when SQL registration fails.
Return completed success only when the file is usable; otherwise expose a durable pending state,
such as 202 with a status resource. Track and reconcile orphaned storage objects.

## Q27

**Evidence: adjacent competitor plus engineering.** Multiple-document inputs are supported in
MyCase intake; request idempotency is a documented retry pattern, not proof of its implementation.
[MyCase intake upload fields](https://supportcenter.mycase.com/en/articles/9628063-dynamic-intake-forms-with-conditional-logic),
[Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

**Recommend:** implement together with Q10. Concurrent requests sharing an action key must
converge on one object/fulfillment; different keys may attach different documents to the same
item. Do not impose one fulfillment per checklist item merely to prevent retries.

## Q30

**Evidence: engineering.** The outbox pattern addresses reliable delivery of side effects after
database changes. Legal competitors' request/background-task ownership is undocumented here.
[AWS transactional outbox](https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).

**Recommend:** persist notification work before acknowledging the share and give a worker explicit
ownership, retries, and shutdown/drain behavior. Tests must await or drain that worker. This is
a lifecycle/reliability issue rather than a new notification preference.

## Q31

**Evidence: engineering.** Observable asynchronous operations can expose pending and terminal
states and reuse an existing job for retried submissions. No exact legal competitor erasure
failure policy was verified.
[Microsoft asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply).

**Recommend:** make erasure a durable, idempotent workflow. Deny application access when erasure
starts, retry provider deletion, and expose pending/completed/needs-repair status. Preserve legally
required business records under a separately defined retention policy. A generic 500 must not
be the only explanation of already-committed partial erasure.

## Q34

**Evidence: competitor.** Clio separates contact edit, delete, and bulk-delete permissions;
delete depends on edit. Filevine reserves contact deletion/archiving to organization admins
while allowing configurable creation/editing. A comparable MyCase delete-only grant was not
verified in this research.
[Clio custom-role permissions](https://help.clio.com/hc/en-us/articles/40062980685467-Overview-of-Custom-Role-Permissions),
[Filevine contact permissions](https://support.filevine.com/hc/en-us/articles/29256739216027-Contact-Permissions).

**Recommend:** add a separate client-delete grant, with an explicit migration/backfill preserving
intended existing roles. Editing contact details should not inherently authorize destructive deletion.
Retain linked-matter, trust-activity, and hold protections regardless of the grant.

## Q35

**Evidence: competitor with an important limit.** Clio documents restricted matters for
administrators and administrator control over access. However, it also warns that billing,
accounts, and reports can expose information from otherwise inaccessible matters. MyCase
documents assigned-only user access but does not establish that administrators have no exemption.
[Clio matter permissions](https://help.clio.com/hc/en-us/articles/9286062516123-Matter-Permissions-and-Rates),
[MyCase user access](https://supportcenter.mycase.com/en/articles/12758100-how-can-i-manage-user-access-and-permissions-effectively-in-8am).

**Recommend:** distinguish ordinary administrator access from an explicit ethical wall. A wall
should apply to admins too, with deliberately authorized, audited emergency access. Cover tasks,
files, search, reports, billing, notifications, and exports together. Do not promise a wall based
solely on filtering the matter Tasks tab or assume Clio's model is leak-proof across modules.

## Q36

**Evidence: adjacent competitor only.** Clio Draft supports multiple organizations for the same
email. Clio Manage deactivation preserves historical work while separating user access from
license management. Neither establishes how a soft-deleted firm should count against a
one-firm-per-user cap.
[Clio Draft organization switching](https://help.clio.com/hc/en-us/articles/24313887490203-Clio-Draft-Account-Settings-and-User-Invitation),
[Clio deactivating users](https://help.clio.com/hc/en-us/articles/9201286624923-Deactivate-Users-and-Cancel-Account).

**Recommend:** count active firm memberships toward the cap; retain restoration authority
separately. Restoration must atomically recheck the cap and require an available slot or an
explicitly confirmed membership switch. Soft delete followed by restore must not bypass the cap.

## Suggested order

1. Reliability and authorization boundaries: Q13, Q19, Q21, Q25, Q26, Q30, Q31; settle the
   ethical-wall contract in Q35 before claiming it. Verify Q04's real cross-instance behavior.
2. User-visible workflow corrections: Q03, Q05, Q07, Q10/Q27, Q20, Q34, Q36.
3. Shared recovery and fetching conventions: Q06, Q09, Q11, Q16, Q22, Q23, then Q17.
4. Explicit product choices/documentation: Q02, Q08, Q14, Q15, Q18.

The ledger's blanket "not bugs" description is too strong: matching an existing implementation
or passing a characterization test does not establish correct functionality. Q20 is already a
UI/backend inconsistency; the delivery and lifecycle entries need reliability work, even though
the exact recovery contract remains a design choice. Keep proposals open until a decision is made.
