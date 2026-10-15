import { z } from 'zod';
const { VALID_CONTACT_CATEGORIES } = require('../../contacts/contacts.validation');

// The role a contact plays ON THIS MATTER. Deliberately narrower than the
// directory's `category` vocabulary (no 'vendor'/'court_reporter'), because
// these are the parties to a matter rather than everyone the firm deals with.
export const VALID_CONTACT_ROLES = [
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
  'other',
];

// Adding a contact to a matter takes one of two shapes: `contactId` links a
// contact that is already in the directory, or the identity fields create one
// and link it in a single step. The identity fields mirror the contacts
// module's create bounds so the two paths accept exactly the same values.
export const createContactSchema = z.object({
  body: z.object({
    contactId: z.string().max(100).optional(),
    role: z.enum(VALID_CONTACT_ROLES).optional().default('other'),
    // The matter-specific note. The contact's own notes are edited through the
    // contacts module, so they are not accepted here.
    notes: z.string().max(2000).nullable().optional(),
    sortOrder: z.coerce.number().int().optional(),

    // --- new-contact fields (ignored when `contactId` is supplied) ---
    name: z.string().min(1).max(300).optional(),
    contactType: z.enum(['person', 'company']).optional(),
    category: z.enum(VALID_CONTACT_CATEGORIES).optional(),
    organization: z.string().max(300).nullable().optional(),
    title: z.string().max(300).nullable().optional(),
    barNumber: z.string().max(300).nullable().optional(),
    email: z.string().max(300).nullable().optional(),
    phone: z.string().max(300).nullable().optional(),
    phoneAlt: z.string().max(300).nullable().optional(),
    fax: z.string().max(300).nullable().optional(),
    website: z.string().max(1000).nullable().optional(),
    address: z.string().max(1000).nullable().optional(),
    courtId: z.string().nullable().optional(),
    clientId: z.string().nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(25).optional(),
    oneTime: z.boolean().optional(),
  }).refine(
    (b) => Boolean(b.contactId) || Boolean(b.name && b.name.trim()),
    {
      path: ['contactId'],
      message: 'Pick an existing contact or provide a name for a new one.',
    },
  ),
});

// Only the per-matter facts are editable here. The contact's name and details
// are shared with every other matter and are edited through the contacts
// module, which is the entire point of the directory holding one copy.
export const updateContactSchema = z.object({
  body: z.object({
    role: z.enum(VALID_CONTACT_ROLES).optional(),
    notes: z.string().max(2000).nullable().optional(),
    sortOrder: z.coerce.number().int().optional(),
  }),
});
