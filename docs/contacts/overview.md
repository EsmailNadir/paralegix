# Contacts

The **contact directory** is your firm's address book for everyone who is not a client: opposing counsel, opposing parties, co-counsel, judges, witnesses, experts, adjusters, mediators, court clerks, and anyone else you deal with. Open **Contacts** from the left sidebar.

Before the directory, these people were recorded on each matter separately, which meant the same opposing counsel existed five times with three different phone numbers. Now there is one record per person, and matters link to it.

## The Contacts List

The list shows every contact in your firm, one per row: their name, category, organization, email, phone, and how many matters they are currently on.

At the top you can:

- **Search** by name, organization, email, or phone.
- **Filter** by category, by tag, and by whether a contact is **Active**, **Archived**, or both.
- **Sort** by name, category, organization, email, or when the contact was added.

Click any row to open that contact's page, which shows their full details and every matter they are linked to.

## Adding a Contact

Click **New contact** and fill in what you know: name, category, organization, title, email, phone, address, and any notes. Only the name is required, so you can capture a person the moment you hear of them and fill in the rest later.

You can also create a contact without leaving a matter. On the matter's **Contacts** tab, **Link contact** searches the directory first and offers to create a new record if nobody matches.

::: tip One-time contacts
Creating a contact from a matter's **Link contact** dialog gives you a **"One-time contact for this matter only"** checkbox. Use it for someone you will only ever deal with on this one matter, such as a single witness. A one-time contact does not appear in the firm-wide directory or its picker on other matters, so it never clutters the address book, but it still shows on this matter's Contacts tab like any other.
:::

## Linking Contacts to Matters

A contact and a matter are joined by a **link**, and the link is what carries the matter-specific detail:

| Lives on the link (per matter) | Lives on the contact (shared) |
|---|---|
| The **role** on this matter, for example "Opposing counsel" | Name, organization, title |
| A **note** about their involvement here | Email, phone, address |
| | Category, tags, archived state |

This split is the point of the directory. Correcting an email address once fixes it on every matter that person appears on. Removing a contact from a matter removes the link only, leaving the directory record and every other matter untouched.

See [Related contacts](/matters/overview#related-contacts) on the matter page.

## Importing and Exporting

- **Import** brings contacts in from a **CSV** or a **vCard** (`.vcf`) file, which is the fast way to move an existing address book into Paralegix. Pick the file and Paralegix reports how many contacts it created.
- **Export** downloads the current filtered list as a CSV, so whatever you have searched and filtered down to is what you get.

## Archiving

Archive a contact you no longer deal with instead of deleting them. An archived contact drops out of the default list and out of the picker when linking a contact to a matter, but stays attached to the matters they were on, so the history of those matters stays complete. Restore them at any time.

::: info
Deleting a contact is permanent and removes it from every matter it was linked to. Archive is almost always what you want.
:::

## Who Can Use It

Viewing the directory requires the contacts view permission, and creating, editing, importing, archiving, or deleting requires the contacts management permission. See [Roles and Permissions](/settings/roles).

## Related

- [Matters overview](/matters/overview)
- [Clients overview](/clients/overview)
- [Roles and Permissions](/settings/roles)
