# Contacts (Firm-Wide Directory)

The firm-wide directory of non-client parties, and the junctions that link them to matters and clients. Mounted at `/api/lawfirms/:lawFirmId/contacts` (`backend/src/app.ts:863`); the module is `backend/src/modules/contacts/`, and the tables live in `backend/db/schema/20_parties.sql` and `30_matters.sql`.

## Summary

Before the directory, a matter's contacts were rows owned by that matter, and a client's contacts were rows owned by that client. The same opposing counsel therefore existed once per matter, with independently drifting phone numbers, and nothing could answer "which matters is this person on?".

`contacts` is now the single record per person or organization. `matter_contacts` and `contact_clients` are junctions onto it, and each junction owns only what is genuinely per-relationship: the **role** on a matter, or the **relationship** to a client. Everything intrinsic to the person lives on the directory row and is shared.

## Key Takeaways

- **The junction carries the relationship, the row carries the person.** `matter_contacts.role` is per matter, so an attorney who is opposing counsel on one matter and co-counsel on another is one contact with two links. `contacts.category` is what they usually are, independent of any matter. The two share a vocabulary but not a value.
- **No unique constraint on name or email, deliberately.** Two real people share a name, and one person legitimately has a personal and a work address. Duplicates are a **soft, advisory warning** from `GET /duplicate-check` (`checkDuplicateContact`, `contacts.service.ts:120`), which the create form polls while the user types; creating a contact never blocks, even on an exact match.
- **Archive, not delete, is the intended retirement.** `is_archived` drops a contact out of the default list and out of the link picker while leaving every junction intact. `delete` cascades the junctions and destroys matter history, so it is the sharp edge.
- **Tenant scoping is composite except for `court_id`.** The junction FKs are `(law_firm_id, contact_id)` composite. `contacts.court_id` is a single-column FK on purpose: a composite `on delete set null` would try to null `law_firm_id`, which is `not null`. Tenant agreement for the court is asserted in the service (`assertCourtInFirm`, `contacts.service.ts:44`), exactly as `matters.court_id` does. Courts themselves are covered in [Reference Data](reference-data.md).

## Transaction boundaries

Creating a contact from a matter or person-client roster shares one transaction between the directory record and its relationship link. Removing a one-time matter contact commits the relationship and directory deletions together. Directory events and matter activity publication follow the outer commit (`shared/database/transactionEffects.ts`). A failed relationship write leaves no orphan directory record or event.

## Schema

### `contacts` (`db/schema/20_parties.sql:91`)

| Column | Notes |
|---|---|
| `contact_type` | `person` \| `company`. A company row (a carrier, an expert firm) puts the organization in `name` and leaves `organization` null. |
| `category` | What they usually are: `opposing_counsel`, `opposing_party`, `co_counsel`, `judge`, `witness`, `expert`, `adjuster`, `court_clerk`, `mediator`, `guardian_ad_litem`, `court_reporter`, `vendor`, `other`. |
| `organization`, `title`, `bar_number` | Professional identity. |
| `email` (`citext`), `phone`, `phone_alt`, `fax`, `website`, `address` | Contact details. `citext` so case never splits a match. |
| `court_id` | Judges and clerks belong to a court. Nullable single-column FK, `on delete set null`. |
| `notes` | Free text. |
| `tags` | `text[]`, firm-defined. Powers the tag filter and the `/tags` endpoint. |
| `is_archived` | Soft retirement. |
| `one_time` | `boolean not null default false`. See below. |

Firm-scoped `lower()` expression indexes on name, email and organization (`20_parties.sql:125-127`) back the duplicate lookup and the conflict-of-interest check, which match case-insensitively; trigram GIN indexes on the same three columns back search (`95_deferred_fks.sql:95-97`). There is no generated `search` tsvector column.

**One-time contacts.** `one_time` is a flag on the same row, not a separate table or a different kind of record. A one-time contact is still linked to its matter through the ordinary `matter_contacts` junction. The flag only changes *visibility*: the directory list defaults to `oneTime = 'false'` (`listContactsPaged`, `contacts.repository.ts:113,128-129`, surfaceable with `?oneTime=true|all`), and the link picker (`lookupContacts`, `:353-363`) and both duplicate probes (`:316`, `:346`) always exclude one-time and archived rows. The "One-time contact for this matter only" checkbox on `ContactFormModal` appears only when the modal is opened with matter context on a **create**, which is how the "create a new contact" branch of `LinkContactModal` opens it.

### `matter_contacts` (`db/schema/30_matters.sql:189`)

One link per contact per matter, enforced by `matter_contacts_unique_link (law_firm_id, matter_id, contact_id)`. `role` lives on the link, so a contact who changes hats on a matter is an UPDATE, not a second row. Carries `notes` and `sort_order`. Both FKs are composite and cascade on delete.

Note the role enum is the category enum **minus** `court_reporter` and `vendor`: those describe what someone is, not a party role on a matter.

### `contact_clients` (`db/schema/20_parties.sql:154`)

Links a directory contact to a client, so the in-house counsel who is also co-counsel on a matter is one record rather than two. `relationship` is free text ("General Counsel", "Spouse") because firms describe these in their own words. `is_email_recipient` and `can_view_billing` are per-client delivery and access preferences for that contact.

`contact_clients_one_primary_idx` is a partial unique index on `(law_firm_id, client_id) where is_primary`, so a concurrent pair of writes cannot leave a client with two primary contacts. That invariant is in the database rather than in the service on purpose.

## Routes

All under `/api/lawfirms/:lawFirmId/contacts` (`contacts.routes.ts`), gated by `contacts.view` for reads and `contacts.manage` for writes. The one read that needs `contacts.manage` is `/duplicate-check`, because only the create form calls it.

| Method | Path | Permission | Purpose | Line |
|---|---|---|---|---|
| `GET` | `/` | view | Paged, sorted, filtered list. Sorts: `name`, `category`, `organization`, `email`, `createdAt`. | `:27` |
| `GET` | `/lookup` | view | Typeahead for the link pickers. Supports `excludeMatterId` so a matter's existing contacts drop out of its own picker. Always excludes archived and one-time contacts. | `:54` |
| `GET` | `/duplicate-check` | manage | Advisory near-match check by `name`/`email`, polled by the create form while typing. Never blocks creation. | `:73` |
| `GET` | `/tags` | view | Distinct tags in the firm, for the tag filter. | `:86` |
| `GET` | `/export` | view | CSV of the current filter set. | `:100` |
| `POST` | `/import` | manage | Bulk create from parsed CSV or vCard rows. | `:125` |
| `GET` | `/:contactId` | view | One contact plus its links. | `:146` |
| `POST` | `/` | manage | Create. Never rejects on a duplicate; see `/duplicate-check` above. | `:157` |
| `PUT` | `/:contactId` | manage | Update. | `:169` |
| `DELETE` | `/:contactId` | manage | Delete (cascades junctions). | `:184` |

Import parses on the **server**: the caller posts the file's text with a `csv` \| `vcard` format discriminator, so there is one parser and no trust in client-shaped rows. `importContacts` (`contacts.service.ts:289`) runs **one** duplicate probe for the whole file (`findPossibleDuplicatesBatch`, `contacts.repository.ts:301`), skips rows that match an existing contact or an earlier row in the same file, creates the rest, and reports each skipped row with the id it collided with.

## Frontend

| Surface | Component |
|---|---|
| Directory page | `contactsComp/ContactsGrid.tsx` (via `app/lawfirm/[lawFirmId]/contacts/page.tsx`) |
| Create / edit | `contactsComp/ContactFormModal.tsx` |
| Matter tab | `matterComp/MatterContactsTab.tsx` + `matterComp/LinkContactModal.tsx` |
| Client tab | `clientComp/ClientContacts.tsx` |

The list runs on `useContactsTable` (`hooks/contactHooks/useContactsTable.ts`), the standard server-table hook, so paging, sorting, and search are all in SQL. There is no import UI: `ImportContactsModal.tsx` no longer exists and nothing in the frontend calls `/import`.

## What Can Be Improved

- **Import is API-only.** The server route and its duplicate handling work (`contacts.service.ts:289`), but the frontend has no import surface, so a firm cannot bring in an address book from the app. Either restore an import modal (with a preview of created vs skipped rows) or retire the route.
- **No conflict-of-interest surface on the directory itself.** The matter conflict check does search directory contacts (`matters.repository.ts:2183`, see [Matters](matters.md)), but nothing runs a check from the contact side ("what else is this person involved in?") beyond the matter list on the detail page.

## Source

- `backend/src/modules/contacts/`: routes, service, repository, validation, serializers
- `backend/src/modules/matters/contacts/matterContacts.routes.ts`: the matter-side junction
- `backend/db/schema/20_parties.sql` (`contacts`, `contact_clients`) and `30_matters.sql` (`matter_contacts`)
- `frontend/src/components/contactsComp/`: directory UI
