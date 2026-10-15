# Automation Overview

Paralegix does a lot of routine work for you in the background. Deadlines get calculated, reminders go out, invoices number themselves, calendars stay in sync, and the work that needs your attention is surfaced without anyone having to go looking for it.

This section is the map of everything the system does on its own, what turns each thing on, and where to control it.

## The Two Kinds of Automation

**Scheduled.** A maintenance job runs once a day and handles anything time based: due-date reminders, upcoming deadline alerts, signature nudges, automatic late fees, and creating the next occurrence of a recurring task. The daily digest is checked every hour instead, so it can land at each person's own chosen local time rather than only one timezone's morning.

**Instant.** Everything else happens the moment something changes. Recording a payment sends the receipt. Sharing a file notifies the client. Creating a task pushes it to the assignee's connected calendar. A trust balance dropping below its minimum warns both you and the client.

You do not schedule or trigger any of this by hand. You configure it once and it runs.

## What Runs Automatically

| Automation | What it does | Where to set it up |
|---|---|---|
| **Invoice reminders** | Emails clients before and after an invoice is due | Firm billing settings |
| **Daily digest** | One email summarizing what's overdue, due today, due tomorrow, and due this week across tasks, events, and invoices | On by default. Settings > Notifications |
| **Task reminders** | Emails the assignee when a task is due (folded into the daily digest instead, for anyone who has it on) | On by default, per task opt-in for a day early |
| **Deadline reminders** | Emails the team ahead of court dates and filing deadlines | On by default |
| **Signature reminders** | Nudges signers who have not signed yet | On by default |
| **Recurring tasks** | Recreates a task on a schedule after you complete it | The Repeat panel on any task |
| **Deadline sets** | Turns one trigger date into a whole chain of deadlines | Settings > Matter Config > Deadline Sets |
| **Evergreen retainers** | Bills a fixed amount every period and tracks included hours | Billing > Recurring plans |
| **Late fees** | Adds a one-time fee to invoices past the grace period | Billing > Rates & setup > Settings |
| **Time rounding** | Rounds each time entry up to your billing increment | Billing > Rates & setup > Settings |
| **Invoice numbering** | Allocates the next number in your series | Automatic |
| **Invoice status** | Marks invoices outstanding, overdue, partly paid, or paid | Automatic |
| **Online payments** | Records the payment against the invoice when a client pays | Payments setup |
| **Template auto-fill** | Prefills a document from a matter, client, and your firm details | Automatic when filling a template |
| **Calendar sync** | Two-way sync with Google Calendar and Outlook | Settings > General |
| **Share link expiry** | Revokes a secure file link when its window closes | Set when you create the link |
| **Trust minimum alerts** | Warns you and the client when a retainer runs low | Trust Accounting > minimum balances |
| **Notifications** | Fills the in-app bell as things happen around you | Automatic |
| **Intake form alerts** | Notifies your team when a public intake form is submitted | Automatic, see [Leads](/leads/overview) |

## How to Read the Rest of This Section

- [Reminders and Alerts](/automation/reminders-and-alerts) covers every automatic email and notification, who receives it, and when.
- [Recurring Work](/automation/recurring-work) covers work that repeats: recurring tasks, deadline sets, and evergreen retainer plans.
- [Billing Automation](/automation/billing-automation) covers what the billing system does on its own, from rate selection through to recording payments.
- [Documents and Calendar](/automation/documents-and-calendar) covers template auto-fill, document requests, share links, signing workflows, and calendar sync.

## Things to Know

- **Nothing is sent twice.** Every automatic email records when it was sent and will not repeat inside its window, so a re-run of the daily job never double-sends.
- **Automation follows permissions.** Reminders and notifications only reach people who can already see the matter, task, or invoice. Turning something on does not widen anyone's access. See [Roles and Permissions](/settings/roles).
- **Clients only see what you share.** Automatic client-facing emails go to the client's billing or contact address and link into the client portal. Internal alerts stay internal.
- **Firm settings are firm wide.** A reminder schedule or late-fee rule applies to every matter in the firm. Per-invoice and per-task overrides exist where they matter.
