# Matters

A **matter** is a single piece of legal work you handle for a client, such as a lawsuit, a transaction, or a filing. Matters live under the **Matters** menu item, and everything you do for a client, such as tasks, deadlines, notes, time entries, and invoices, hangs off a matter. This is usually where your work starts.

## The Matters List

Open **Matters** from the left sidebar to see every matter in your firm.

Each row shows the matter name, its matter number, the lead attorney (a matter can have more than one), the practice area and category, the linked client, and a status badge (Active, Pending, Closed, and so on).

At the top of the list you can:

- **Search** by matter name, matter number, or client.
- **Filter** by practice area, category, lead, or status.
- **Sort** by name, lead, practice area, category, or status.
- **Export CSV** to download the current list.

## Creating a Matter

Click **Create New Matter** in the top right. You will be asked for the basics:

- **Matter name** and an optional **matter number**
- The **client** (or clients) the matter is for
- A **practice area** and **category** to keep things organized
- The **team** on the matter. Mark one or more team members as a **lead** (the responsible attorney); by default you are set as the lead.

Once created, the matter opens to its own page where you can add everything else.

::: tip
You do not have to fill in every field up front. Create the matter with a name and client, then add details, tasks, and time as the matter moves along.
:::

## The Matter Page

Click any matter to open it. This is the home base for that matter.

Across the top you will find tabs for everything tied to the matter:

| Tab | What it holds |
|---|---|
| **Overview** | Key details, the stage tracker, custom fields, a description, quick stats, and the activity timeline |
| **Tasks** | To-do items and deadlines for this matter |
| **Events** | Court dates, meetings, and other calendar items |
| **Clients** | The client(s) attached to the matter |
| **Contacts** | Other people on the matter who are not your client (see [Related contacts](#related-contacts)) |
| **Messages** | Conversations with the clients on this matter. See [Messages](/messaging/overview) |
| **Team** | The attorneys and staff working the matter |
| **Notes** | Internal notes and updates (see [Notes](#notes)) |
| **Time Tracking** | Billable time logged against the matter |
| **Billing** | Invoices, charges, and the matter budget |
| **Documents** | Files attached to the matter. See [Files](/files/overview) |

The **Quick Stats** panel on the right gives you an at-a-glance count of clients, team members, notes, and tasks, plus upcoming events and tasks.

### The stage tracker

At the top of the Overview tab is a **stage tracker**: a left-to-right pipeline showing where the matter is in its lifecycle, such as Intake, Discovery, Trial Prep, and Closed. Click a stage to move the matter to it. Stages are separate from the matter status, so you can track detailed progress without changing whether the matter is Active or Closed.

Your firm sets up its own stages, and you can define a different pipeline for each practice area. See [setting up stages](#custom-fields-and-stages).

### Custom fields

Every practice area needs to capture different information. **Custom fields** let your firm add its own fields to a matter, such as a date of loss, an insurance policy number, or an opposing party. They appear on the Overview tab and can be filled in from the **Edit** screen or directly on the card. A field can apply to every matter or only to matters in a particular practice area. See [Custom Fields and Stages](#custom-fields-and-stages) for how to set these up.

### Key dates and the statute of limitations

A matter tracks three important dates you can set from **Edit**:

- **Opened** and **Closed** dates for the matter.
- A **Statute of Limitations** date. This is highlighted on the Overview tab and turns amber as it approaches and red once it is within a week or has passed, so a critical deadline never slips.

## Related contacts

Not everyone connected to a matter is your client. The **Contacts** tab holds the other parties, such as opposing counsel, the opposing party, co-counsel, the judge, witnesses, experts, adjusters, and mediators.

Each entry on this tab is a link to a record in your firm's [contact directory](/contacts/overview) rather than a copy of it. The **role** on the matter and any note about it belong to this matter; the name, organization, email, phone, and address belong to the shared contact and are the same everywhere it appears. That means correcting an opposing counsel's phone number once fixes it on every matter they are on, and **Remove** takes someone off this matter without deleting them from the directory.

Use **Link contact** to attach someone already in the directory, or create a new contact from the same dialog if they are not in it yet. Creating one from here lets you mark it a **one-time contact**, so a person who is only relevant to this matter does not end up in your firm-wide directory. See [Contacts](/contacts/overview).

## Notes

The **Notes** tab is where your team's internal discussion about the matter lives, separate from the client-facing side of things. Add a note and anyone on the matter can reply underneath it, so a thread of back-and-forth stays attached to the note it is about instead of getting lost in a long list. Pin the notes that matter most to keep them at the top, and open a note's history to see everything it has been edited to say.

A matter note can also **link out** to a task or a file: turn a note into a task in one step, or attach it to a file already on the matter, so the note, the work, and the document stay connected. Linked tasks show as clickable pills right on the note; linked files show as attachment chips.

## Activity timeline

At the bottom of the **Overview** tab is a running history of what has happened on the matter: when it was created, status and stage changes, legal holds, conflict checks, and contacts added. It gives you a quick, dated record of the matter without digging through notes, and doubles as an audit trail.

## Conflict checks and legal holds

On the Overview tab you will find two compliance tools:

- **Conflict checks.** When a matter is created, Paralegix records a conflict-of-interest check against the matter's clients and keeps the result on file, so you can always show a check was run, by whom, and what it found. You can re-run the check at any time.
- **Legal hold.** Placing a **legal hold** on a matter preserves it against deletion, which is important when litigation or an investigation requires you to retain records. A matter under legal hold cannot be deleted until the hold is lifted. You can add an optional reason when placing the hold.

## Billing preferences, budgets, and invoices

Each matter tracks its own billable time and its own invoices. Open a matter and use its **Time Tracking** and **Billing** tabs to log hours, add flat fees, and raise invoices for the matter with **Generate Invoice**. Invoices raised here belong to the matter, so it always shows what has been billed and paid against it.

From **Edit** you can also set the matter's **billing preferences**:

- The **billing method**: Hourly, Flat Fee, Contingency, or Pro Bono (with a contingency percentage where relevant).
- Whether the matter is **billable** at all.
- A **budget** cap. When you set one, the Billing tab shows a burn-down bar of how much has been billed against the budget, turning amber as you near it and red if you go over.

For how invoices work across the app, see [Invoices](/billing/invoices). For logging time and the billing hub, see [Billing](/billing/overview).

## Custom Fields and Stages

Custom fields and stages are configured once for your firm and then apply to every matter. A firm administrator sets them up under **Settings → Matter Config**:

- **Custom Fields.** Add your own fields (text, number, date, currency, dropdown, checkbox, and more). A field can apply to every matter or only to a chosen practice area, and can be marked required.
- **Stages.** Define the pipeline your matters move through. You can create one shared pipeline or a different set of stages for each practice area, mark a stage as a closing stage, and reorder them.

## Editing or Closing a Matter

Use the **Edit** button on the matter page to change any details, such as the status, lead, or practice area. When a matter wraps up, set its status to **Closed** so it drops out of your active list but stays on record.

::: info
Closing a matter does not delete anything. All of its tasks, time entries, notes, and invoices stay attached, so you can reopen or reference the matter at any time.
:::
