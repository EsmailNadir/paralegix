import { z } from 'zod';
const { paging, sorting, lookup } = require('../../shared/validation/listQuery');

// What a contact usually IS, independent of any one matter. Mirrors the
// `contacts.category` check constraint.
export const VALID_CONTACT_CATEGORIES = [
  'opposing_counsel',
  'opposing_party',
  'co_counsel',
  'judge',
  'witness',
  'expert',
  'adjuster',
  'court_clerk',
  'mediator',
  'guardian_ad_litem',
  'court_reporter',
  'vendor',
  'other',
];

const contactTypeEnum = z.enum(['person', 'company']);

// Shared field bounds, so create and update can't drift apart on length limits.
const nameField = z.string().min(1, 'Contact name is required').max(300);
const emailField = z.string().max(300);
const shortText = z.string().max(300);
const longText = z.string().max(1000);
const notesField = z.string().max(5000);

export const createContactSchema = z.object({
  body: z.object({
    name: nameField,
    contactType: contactTypeEnum.optional(),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    organization: shortText.nullable().optional(),
    title: shortText.nullable().optional(),
    barNumber: shortText.nullable().optional(),
    email: emailField.nullable().optional(),
    phone: shortText.nullable().optional(),
    phoneAlt: shortText.nullable().optional(),
    fax: shortText.nullable().optional(),
    website: longText.nullable().optional(),
    address: longText.nullable().optional(),
    courtId: z.string().nullable().optional(),
    notes: notesField.nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(25).optional(),
    // Scoped to the matter it is created for; excluded from the shared
    // directory and every picker unless explicitly filtered in.
    oneTime: z.boolean().optional(),
  }),
});

// Update is a partial patch: a field left out of the payload is left untouched,
// not blanked. Nullable so an optional field can be explicitly CLEARED.
export const updateContactSchema = z.object({
  body: z.object({
    name: nameField.optional(),
    contactType: contactTypeEnum.optional(),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    organization: shortText.nullable().optional(),
    title: shortText.nullable().optional(),
    barNumber: shortText.nullable().optional(),
    email: emailField.nullable().optional(),
    phone: shortText.nullable().optional(),
    phoneAlt: shortText.nullable().optional(),
    fax: shortText.nullable().optional(),
    website: longText.nullable().optional(),
    address: longText.nullable().optional(),
    courtId: z.string().nullable().optional(),
    notes: notesField.nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(25).optional(),
    isArchived: z.boolean().optional(),
    oneTime: z.boolean().optional(),
  }),
});

// Fields the contacts list may be sorted by, mirroring the repository's
// SORT_COLUMNS whitelist. Anything outside this set is rejected here rather
// than silently ignored.
export const CONTACT_SORT_FIELDS = ['name', 'category', 'organization', 'email', 'createdAt'];

export const listContactsSchema = z.object({
  query: z.object({
    ...paging({ max: 500 }),
    search: z.string().max(500).optional(),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    // Restrict to the contacts linked to this matter / court. Kept plain
    // strings (not uuids) so a malformed value yields an empty result rather
    // than a 400, matching how the lookup endpoint handles the same filters.
    matterId: z.string().max(100).optional(),
    courtId: z.string().max(100).optional(),
    // Every contact tied to any court, for the courts settings page, which
    // needs one read to label all of its rows rather than one read per court.
    hasCourt: z.enum(['true', 'false']).optional(),
    // Comma-separated tag names; a contact matches if it carries any of them.
    tags: z.string().max(1000).optional(),
    // Archived contacts are hidden by default: the directory is a working list,
    // and a retired opposing counsel should not crowd it. 'true' shows only
    // archived, 'all' shows both.
    archived: z.enum(['true', 'false', 'all']).optional(),
    oneTime: z.enum(['true', 'false', 'all']).optional(),
    ...sorting(CONTACT_SORT_FIELDS),
  }).passthrough(),
});

// Typeahead query for contact pickers.
export const lookupContactsSchema = z.object({
  query: z.object({
    ...lookup({ max: 200 }),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    // Drop contacts already linked to this matter from the browsable result, so
    // the "add a contact to this matter" picker doesn't offer duplicates it
    // would then reject. Label resolution by id is unaffected.
    excludeMatterId: z.string().max(100).optional(),
    // Return the full contact record instead of the slim picker row, for
    // pickers that pre-fill a form from the selection.
    full: z.enum(['true', 'false']).optional(),
  }),
});

// Advisory near-match check the create form polls while the user types, so the
// warning can show before submit instead of only after a failed one.
export const checkContactDuplicateSchema = z.object({
  query: z.object({
    name: z.string().max(300).optional(),
    email: z.string().max(300).optional(),
  }),
});

// Import takes the raw file text and parses it server-side, so the CSV and
// vCard dialects this app accepts are defined in exactly one place.
export const importContactsSchema = z.object({
  body: z.object({
    format: z.enum(['csv', 'vcard']),
    // ~2MB of text, which is a very large address book in either format.
    content: z.string().min(1, 'The file is empty.').max(2_000_000),
  }),
});

export const exportContactsSchema = z.object({
  query: z.object({
    format: z.enum(['csv', 'vcard']).optional(),
    search: z.string().max(500).optional(),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    tags: z.string().max(1000).optional(),
    archived: z.enum(['true', 'false', 'all']).optional(),
  }).passthrough(),
});
