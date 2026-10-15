# Documents and Calendar

Document work and calendar work are the two places where the same information usually gets retyped. Paralegix carries it across for you instead.

## Template Auto-Fill

When you fill a template, pick a matter, a client, or both, and every placeholder whose name matches known data is prefilled. Your firm details and today's date fill in without you picking anything.

| Source | Fills placeholders like |
|---|---|
| **Matter** | `case_name`, `case_number`, `matter_number`, `file_number`, `docket_number`, `practice_area`, `case_status`, `lead_attorney` |
| **Client** | `client_name`, `client_address`, `client_email`, `client_phone`, `organization` |
| **Your firm** | `firm_name`, `firm_address`, `firm_city`, `firm_state`, `firm_zip`, `firm_phone`, `firm_email` |
| **Dates** | `today`, `current_date`, `date`, `long_date`, `document_date` |

Matching ignores capitalisation and word separators, so a placeholder named `client_name`, `clientName`, `ClientName`, or `Client Name` all fill from the same source. Any of the names in the table above work in whichever style your templates already use.

Each field is filled as a suggestion you can overwrite. Once you type in a field yourself, changing the matter or client no longer overwrites what you typed. Fields inside repeating sections are auto-filled per row, so a date column in a payment schedule starts populated.

Selecting a matter narrows the client picker to the clients on that matter, so you cannot accidentally merge one client's details into another client's document.

A field stays blank when the record genuinely has no value for it. If `client_address` does not fill, the client has no address on file rather than the placeholder being named wrong.

::: tip
Auto-fill matches on the placeholder's ID, not its on-screen label. Name placeholders after the data they hold, for example `client_name` rather than "Name of the client below", and every template you build will fill itself.
:::

See [Filling a Template](/templates/fill).

## Document Requests

A document request is a checklist you post to a client. Creating one immediately notifies the client in the portal and by email with a direct link to the checklist.

From there the loop runs itself: the client uploads against each item, each upload is marked off the checklist, and the firm is notified as items come in. You can see at a glance which items are still outstanding without emailing to ask.

A request can belong to a specific matter, or be a **general** request tied to the client directly, for anything that is not about one particular matter. Post either kind from the client's **Document Requests** tab. If a file the client needs is already sitting in that matter's Files tab, you can link it straight to a checklist item instead of waiting on the client to upload it again.

Building the same checklist over and over gets old, so you can save one as a **preset** (Settings > Matter Config > Document Request Presets) and start new requests from it instead of typing the same items each time.

## Shared File Notifications

Sharing files with a client sends one digest rather than a message per file. A run of shares in the same sitting is collapsed into a single email listing what the client can now see, with the rest summarized as a count. Clients who already had access to a file are not re-notified.

## Secure Share Links

A share link is a self-expiring way to send a file to someone outside the firm. When you create it you choose:

- **How long it lives**: 1 hour, 24 hours, 7 days (the default), or 30 days.
- **What it allows**: download, or view only.
- **An optional password** the recipient must enter.

Once the window closes the link stops working on its own. There is nothing to remember to revoke, though you can revoke a link early at any time.

## Signing Workflows

Sending a document for signature starts a workflow that runs itself:

- **Non-PDF files are converted** to PDF before signing. You can send DOCX, DOC, ODT, RTF, or TXT and the signer sees a PDF.
- **Sequential routing hands off automatically.** The next signer's link is issued the moment the previous signer finishes. Nobody has to forward anything.
- **Signers are reminded** at 1, 3, and 5 days, and again as the request nears expiry, until they sign. See [Reminders and Alerts](/automation/reminders-and-alerts).
- **Every action is recorded** into an audit trail, and a signing certificate is generated with the completed document.
- **You are notified** when a document is completed or declined.

See [Document Signing](/document-signing/overview).

## Calendar Sync

Connect Google or Microsoft and your Paralegix dates keep themselves in step with the calendar you already live in.

Sync is set per person, not per firm, so each team member connects their own account and picks their own direction:

| Direction | What happens |
|---|---|
| **None** | No sync |
| **Send events to Google / Outlook** | Paralegix pushes out, nothing comes back |
| **Import events from Google / Outlook** | Your external events appear in Paralegix, nothing is pushed out |
| **Two-way sync** | Changes flow both ways |

Once it is on, sync is continuous rather than a button you press:

- **Outbound is instant.** Creating or changing a task, matter event, client event, or billing date pushes it to every relevant person's connected calendar.
- **Inbound is push based.** Changes made in Google or Outlook come back to Paralegix as they happen, with a background poll as backup while the calendar page is open.
- **Both providers stay in step.** If you have Google and Outlook connected, a change made in one is carried to the other.
- **Deletions and cancellations reconcile**, so a cancelled meeting does not linger on one side.
- **Nothing loops.** An edit is never bounced back and forth between the two systems, and the most recent change wins.

Deadlines created by a [deadline set](/automation/recurring-work) sync like any other matter event, so applying a set puts the whole schedule on everyone's calendar at once.

## Things to Know

- **Calendar connections are personal.** Connecting your Google account does not connect anyone else's, and each person controls their own sync direction. Your firm administrator may lock this setting.
- **Auto-fill never overwrites your typing.** Once you edit a field it is yours.
- **Share links do not require an account.** Anyone with the link, and the password if you set one, can open the file until it expires. Choose the shortest window that works.

## Related

- [Templates overview](/templates/overview)
- [Filling a Template](/templates/fill)
- [Document Signing](/document-signing/overview)
- [Reminders and Alerts](/automation/reminders-and-alerts)
