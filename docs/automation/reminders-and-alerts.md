# Reminders and Alerts

Paralegix sends reminders on your behalf so nobody has to chase a due date manually. Everything on this page is automatic once it is configured.

## When Reminders Go Out

Most time-based reminders (invoices, tasks, matter events, signatures) are sent by a maintenance job that runs once a day. That means a reminder lands on the day it is due rather than at the exact hour something was created. The daily digest works a little differently: it is checked every hour so it can land at each person's own chosen local time, explained below.

Every reminder records when it was last sent for that invoice, task, event, or signer, and will not send again inside its window. Re-running the job never produces a duplicate.

## Invoice Reminders

Paralegix chases unpaid invoices for you.

**Overdue reminders** go to the client once an invoice passes its due date, on a schedule your firm sets. The default schedule is 7, 14, and 30 days past due. Each reminder shows the remaining balance, the original due date, and a link to pay in the client portal when online payments are set up.

**Pre-due reminders** go out ahead of the due date. You can set a firm-wide default number of days, and any individual invoice can use its own.

**Payment plan installments** get their own pre-due reminder. When an invoice is split into scheduled installments, each pending installment is reminded separately as its own date approaches.

An invoice is skipped when:

- it has been opted out of reminders,
- the balance is already settled,
- there is no email address to send to, or
- a reminder was already sent inside the current window.

You can also send a reminder for one invoice immediately from the invoice itself, which bypasses the schedule.

See [Invoices](/billing/invoices) and [Payments and Plans](/billing/payments).

## Daily Digest

Instead of a stream of separate emails, most people get one **daily digest**: a single email bundling everything that needs attention, grouped into overdue, due today, due tomorrow, and due this week. It covers tasks, matter events, and invoices due, and flags a matter's statute-of-limitations date landing in that same window as critical, so it stands out instead of blending in with routine items.

The digest is on by default. Configure it from **Settings > Notifications**: pick the hour it goes out (each person gets it at their own chosen local time) and whether it sends every day or weekdays only.

## Task Due Reminders

The assignee gets an email on the day a task is due, unless they have the daily digest on (the default), in which case that task's due date is folded into their digest instead of triggering a separate email. Turn the digest off in Settings > Notifications to go back to a standalone email per due task. If a task has no assignee, the reminder goes to the firm owner and admins instead.

A task can also opt into a reminder one day early, and can name extra recipients who should be reminded alongside the assignee. Both settings carry over to every future occurrence of a recurring task.

Task reminders are on by default for the firm. Completed tasks are never reminded.

## Deadline and Matter Event Reminders

Court dates, filing deadlines, hearings, depositions, and every other matter event get reminders automatically. By default the team is emailed:

- **7 days before** the event,
- **1 day before**,
- **on the day** itself, and
- **after it passes**, for up to 7 days, if the event was never marked complete or cancelled.

Recipients are the people assigned to the event. If nobody is assigned, it falls back to whoever created it, and then to the firm owner and admins. Each recipient sees the date and time rendered in their own timezone.

Cancelled and completed events are skipped.

## Signature Reminders

Signers who have not signed yet are nudged automatically at **1, 3, and 5 days** after the signing request reaches them, and again when the request is close to expiring. A signer is never reminded more than once in 24 hours, and reminders stop the moment they sign or the session is completed, declined, or voided.

With sequential routing, only the signer whose turn it is gets reminded. Later signers are not contacted until the request reaches them.

You can also send a manual nudge to a specific signer from the signing history, with a short cooldown to prevent accidental double-sends.

See [Document Signing](/document-signing/overview).

## Trust Minimum Balance Alerts

Set a minimum balance for a client's trust account and Paralegix watches it for you. When a withdrawal takes the balance below that minimum, it immediately:

- posts a message in the client's portal conversation asking them to replenish the retainer,
- emails the client a replenishment request showing the shortfall, and
- notifies the firm so you know the request went out.

The alert fires on the crossing, not on every subsequent transaction, so a client already below their minimum is not asked repeatedly.

## Document and File Alerts

**Shared files.** When you share files with a client, they get one digest email rather than a message per file. A burst of shares in a single sitting collapses into a single notification listing what they can now see.

**Document requests.** Posting a document request notifies the client in the portal and by email, with a direct link to the checklist they need to fulfill. When they upload something, the firm is notified back.

See [Documents and Calendar](/automation/documents-and-calendar).

## Payment Receipts

Every payment recorded against an invoice, whether partial or in full, emails the client a receipt showing the amount paid and the remaining balance. This is on by default and can be turned off in your firm's billing settings.

Refunds and reversals notify the client the same way.

## In-App Notifications

The bell in the sidebar fills in as things happen around you: task assignments, notes added to your matters, new messages, payments received, completed and declined signatures, credit notes, client document uploads, and trust alerts.

Notifications only ever reach people who can already see the underlying record, and you are never notified about your own actions.

## Things to Know

- **Reminders respect access.** Nobody is emailed about a matter, task, or invoice they could not open in the app.
- **Email addresses matter.** Client-facing reminders use the invoice billing email first, then the client's email on file. An invoice with no reachable address is skipped rather than failing.
- **A quiet day is normal.** Most days the job finds nothing due and sends nothing.

## Related

- [Invoices](/billing/invoices)
- [Tasks overview](/tasks/overview)
- [Deadline Sets](/settings/deadline-sets)
- [Document Signing](/document-signing/overview)
