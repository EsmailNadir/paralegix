import { z } from 'zod';
const { paging, sorting, lookup, dateWindow } = require('../../shared/validation/listQuery');

const clientStatusEnum = z.enum(['active', 'inactive', 'archived']);
const preferredContactMethodEnum = z.enum(['email', 'phone', 'sms', 'portal']);
// Immutable after insert (clients_type_immutable DB trigger).
const clientTypeEnum = z.enum(['person', 'company']);

export const createClientSchema = z.object({
  body: z.object({
    clientType: clientTypeEnum.optional(),
    userId: z.string().optional(),
    email: z.string().email().optional(),
    // `.trim()` before the length check, not after: `min(1)` alone accepts a
    // name of three spaces, which passed validation and created a client whose
    // name renders blank in every picker, matter header and invoice in the app.
    // Trimming also stops "  Acme  " and "Acme" becoming two records that look
    // identical in the list.
    name: z.string().trim().min(1, 'Name is required').max(200),
    phone: z.string().max(100).optional(),
    organization: z.string().max(200).optional(),
    address: z.string().max(1000).optional(),
    // null is the form's "None"; leaving the field out takes the 'email' default.
    preferredContactMethod: preferredContactMethodEnum.nullable().optional(),
    status: clientStatusEnum.optional(),
    matterIds: z.array(z.string()).optional(),
    portalInvitePending: z.boolean().optional(),
  }).refine(
    // A company is the legal/billing principal, but it never authenticates:
    // its people sign in as their own Person `clients` rows, linked to it
    // through client_company_links, so no portal login ever sits on a company
    // row (see clients_company_no_user_id_check). Rejecting userId here up
    // front matches that DB invariant instead of failing later as an opaque
    // constraint violation.
    (b) => b.clientType !== 'company' || !b.userId,
    {
      path: ['userId'],
      message: 'A company client cannot be linked to a portal user directly. Portal access for a company is granted per roster contact.',
    },
  ).refine(
    (b) => b.clientType !== 'company' || b.portalInvitePending !== true,
    {
      path: ['portalInvitePending'],
      message: 'Portal access for an Organization is granted per roster contact.',
    },
  ),
});

export const updateClientSchema = z.object({
  body: z.object({
    // Same rule as create: trimmed, non-empty, capped. An update that could
    // blank the name left a client rendering as nothing in every picker.
    name: z.string().trim().min(1, 'Name is required').max(200).optional(),
    // Nullable so an optional field can be explicitly CLEARED (null) rather than
    // only overwritten; undefined still means "leave unchanged".
    email: z.string().email().nullable().optional(),
    // Caps match createClientSchema field for field.
    phone: z.string().max(100).nullable().optional(),
    organization: z.string().max(200).nullable().optional(),
    address: z.string().max(1000).nullable().optional(),
    // null clears a stored preference (the forms' "None"); the column allows it.
    preferredContactMethod: preferredContactMethodEnum.nullable().optional(),
    status: clientStatusEnum.optional(),
    portalInvitePending: z.boolean().optional(),
  }),
});

// Fields the clients list may be sorted by, mirroring the repository's SORT_COLUMNS
// whitelist. Anything outside this set is rejected here rather than silently ignored.
const CLIENT_SORT_FIELDS = ['name', 'email', 'organization', 'createdAt'];

// List query. Every part is optional: omitting `limit` preserves the unlimited
// default (and the `{ clients }` response without `totalItems`), and omitting
// search/sort preserves the historic full-list behaviour.
//
// `ids` (the batch-resolve branch) is deliberately NOT declared here. It carries
// up to 200 comma-joined uuids and enforces its own cap in the route with a
// message that tells the caller to page; a length bound in this schema would
// pre-empt that with a less useful error. `.passthrough()` lets it through.
export const listClientsSchema = z.object({
  query: z.object({
    ...paging({ max: 500 }),
    search: z.string().max(500).optional(),
    portalOnly: z.enum(['true', 'false']).optional(),
    status: clientStatusEnum.optional(),
    // Restrict to the clients linked to this matter. Kept a plain string (not a
    // uuid) so a malformed value yields an empty result rather than a 400,
    // matching how the lookup endpoint handles the same filter.
    matterId: z.string().max(100).optional(),
    clientType: clientTypeEnum.optional(),
    ...sorting(CLIENT_SORT_FIELDS),
  }).passthrough(),
});

// Typeahead query for client pickers.
export const lookupClientsSchema = z.object({
  query: z.object({
    ...lookup({ max: 200 }),
    // Exact, case-insensitive display-name match for the advisory duplicate warning.
    exactName: z.string().max(200).optional(),
    // Exact, case-insensitive organization match, for the "colleagues at this
    // organization" link on the client detail page.
    exactOrganization: z.string().max(200).optional(),
    // Drops one client id from the result, so a client's own record doesn't
    // show up in its own "colleagues" list.
    excludeId: z.string().max(100).optional(),
    // Comma-separated Firebase UIDs of linked portal accounts, mirroring `ids`
    // from the shared lookup() helper. Some pickers select a PERSON rather than a
    // client record (a messaging participant is stored by UID), so the label of a
    // selection they already hold can only be resolved through this key.
    userIds: z.string().max(2000).optional(),
    portalOnly: z.enum(['true', 'false']).optional(),
    // Restrict results to the clients linked to this matter. Kept a plain string
    // (not a uuid) so a malformed value yields an empty result rather than a 400,
    // matching how `ids` handles an unusable value.
    matterId: z.string().max(100).optional(),
    // Restrict results to one client type. Used by the org quick-add picker
    // (organization-clients plan Phase 7 ad-hoc group composition), which must
    // never offer a person client where a company `clients.id` is expected.
    clientType: clientTypeEnum.optional(),
    // Hide archived clients from the browsable result. Applies to search/browse
    // only; label resolution still returns them so a saved selection stays labelled.
    excludeArchived: z.enum(['true', 'false']).optional(),
    // Drops person clients already linked to this company client, for the
    // "add an existing client" picker on a company's Related Clients tab.
    // Malformed/unresolvable values are ignored rather than erroring.
    excludeLinkedToClientId: z.string().max(100).optional(),
    // Return the enriched client instead of the slim picker row.
    full: z.enum(['true', 'false']).optional(),
  }).refine(
    (q) => !(q.ids && q.userIds),
    {
      // `ids` and `userIds` are two spellings of one resolution mode, so a request
      // carrying both is ambiguous. Preferring one silently would let a caller
      // believe it resolved values it never asked about.
      path: ['userIds'],
      message: 'Send either ids or userIds, not both. They are two ways of naming the same resolution.',
    },
  ),
});

export const updateClientMattersSchema = z.object({
  body: z.object({
    matterIds: z.array(z.string().min(1)).min(1),
  }),
});

// Notes: see notes.validation.ts, which uses the shared schemas
// matter/task/client notes all share.

// Adding a related person differs by the TARGET client's own type (resolved
// server-side, not knowable from the request body alone, so this schema is a
// superset of both shapes):
// - Company target: a real, standalone Person client (client_company_links
//   migration) - link an existing one by `personClientId`, or supply the
//   identity fields to create a brand-new person client and link it.
// - Person target: unchanged `contact_clients` roster - link an existing
//   firm-directory contact by `contactId`, or supply the identity fields
//   (including `title`/`notes`, which only a directory contact has) to
//   create a brand-new one.
export const createClientContactSchema = z.object({
  body: z.object({
    personClientId: z.string().max(100).optional(),
    contactId: z.string().max(100).optional(),
    relationship: z.string().max(200).optional(),
    isPrimary: z.boolean().optional(),
    // Billing delivery/access flags for this relationship. Independently
    // editable (see the organization-clients plan's billing contract); the
    // linked person's own portal identity/invite state is managed by the
    // ordinary client portal-invite flow, not here.
    isEmailRecipient: z.boolean().optional(),
    canViewBilling: z.boolean().optional(),

    // --- new-person/new-contact fields (ignored when personClientId/contactId is supplied) ---
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(100).optional(),
    // Person-target-only: a directory contact has these, a Person client does not.
    title: z.string().max(200).optional(),
    notes: z.string().max(5000).optional(),
  }).refine(
    (b) => Boolean(b.personClientId) || Boolean(b.contactId) || Boolean(b.name && b.name.trim()),
    {
      path: ['personClientId'],
      message: 'Pick an existing client/contact or provide a name for a new one.',
    },
  ),
});

// Link-only fields for a company target: the linked person's own name/email/
// phone are edited through the ordinary client update endpoint instead,
// since they belong to that person's own `clients` row. For a person target,
// name/email/phone/title/notes patch the underlying directory contact, same
// as before the client_company_links migration.
export const updateClientContactSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(100).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    relationship: z.string().max(200).nullable().optional(),
    isPrimary: z.boolean().optional(),
    isEmailRecipient: z.boolean().optional(),
    canViewBilling: z.boolean().optional(),
  }),
});

export const updateClientBillingRatesSchema = z.object({
  body: z.object({
    defaultRate: z.number().nonnegative().nullable().optional(),
    memberRates: z.record(z.string(), z.number().nonnegative()).optional(),
  }),
  params: z.object({
    lawFirmId: z.string(),
    clientId: z.string(),
  }),
});

// Firm-wide standalone client events feed for the calendar. `from`/`to` bound the
// read to the days being drawn; omitting them keeps the full-set contract.
export const listAllClientEventsSchema = z.object({
  query: z.object({
    ...dateWindow(),
    tz: z.string().optional(),
  }).passthrough(),
});
