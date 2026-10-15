import { and, asc, eq } from 'drizzle-orm';
import { contacts, matterContacts } from '../../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

// The link plus the directory contact it points at, flattened into one object.
// `id` is the LINK id (what the per-matter routes address); `contactId` is the
// directory record, which is what a caller follows to the contact page.
//
// `notes` is the matter-specific note stored on the link; the contact's own
// notes come back separately as `contactNotes`, so editing one on a matter can
// never overwrite the other.
const CONTACT_SELECT = {
  id: matterContacts.id,
  matterId: matterContacts.matterId,
  contactId: matterContacts.contactId,
  role: matterContacts.role,
  notes: matterContacts.notes,
  sortOrder: matterContacts.sortOrder,
  createdBy: matterContacts.createdBy,
  createdAt: matterContacts.createdAt,
  updatedAt: matterContacts.updatedAt,
  name: contacts.name,
  contactType: contacts.contactType,
  category: contacts.category,
  organization: contacts.organization,
  title: contacts.title,
  barNumber: contacts.barNumber,
  email: contacts.email,
  phone: contacts.phone,
  phoneAlt: contacts.phoneAlt,
  fax: contacts.fax,
  website: contacts.website,
  address: contacts.address,
  contactNotes: contacts.notes,
  isArchived: contacts.isArchived,
  oneTime: contacts.oneTime,
  courtId: contacts.courtId,
};

function formatContact(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    matterId: r.matterId,
    contactId: r.contactId,
    role: r.role || 'other',
    notes: r.notes || null,
    sortOrder: r.sortOrder == null ? 0 : Number(r.sortOrder),
    name: r.name || '',
    contactType: r.contactType || 'person',
    category: r.category || 'other',
    organization: r.organization || null,
    title: r.title || null,
    barNumber: r.barNumber || null,
    email: r.email || null,
    phone: r.phone || null,
    phoneAlt: r.phoneAlt || null,
    fax: r.fax || null,
    website: r.website || null,
    address: r.address || null,
    contactNotes: r.contactNotes || null,
    isArchived: Boolean(r.isArchived),
    oneTime: Boolean(r.oneTime),
    courtId: r.courtId || null,
    createdBy: r.createdBy || null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

class MatterContactsRepository {
  async listContacts(lawFirmId: string, matterId: string) {
    const rows = await tenantQuery(matterContacts, lawFirmId, ({ executor, scope }) => executor
      .select(CONTACT_SELECT).from(matterContacts).innerJoin(contacts, and(
        eq(contacts.id, matterContacts.contactId),
        eq(contacts.lawFirmId, matterContacts.lawFirmId),
      )).where(and(scope, eq(matterContacts.matterId, matterId)))
      .orderBy(asc(matterContacts.sortOrder), asc(contacts.name), asc(matterContacts.createdAt)));
    return rows.map(formatContact);
  }

  /** One link, addressed by its own id. */
  async getContact(lawFirmId: string, matterId: string, linkId: string, transaction?: DrizzleExecutor) {
    if (!isUuid(linkId)) return null;
    const rows = await tenantQuery(matterContacts, lawFirmId, ({ executor, scope }) => executor
      .select(CONTACT_SELECT).from(matterContacts).innerJoin(contacts, and(
        eq(contacts.id, matterContacts.contactId), eq(contacts.lawFirmId, matterContacts.lawFirmId),
      )).where(and(scope, eq(matterContacts.matterId, matterId), eq(matterContacts.id, linkId))).limit(1), transaction);
    return rows[0] ? formatContact(rows[0]) : null;
  }

  /** The existing link between a matter and a directory contact, if any. */
  async findLink(lawFirmId: string, matterId: string, contactId: any, transaction?: DrizzleExecutor) {
    if (!isUuid(contactId)) return null;
    const rows = await tenantQuery(matterContacts, lawFirmId, ({ executor, scope }) => executor
      .select(CONTACT_SELECT).from(matterContacts).innerJoin(contacts, and(
        eq(contacts.id, matterContacts.contactId), eq(contacts.lawFirmId, matterContacts.lawFirmId),
      )).where(and(scope, eq(matterContacts.matterId, matterId), eq(matterContacts.contactId, contactId))).limit(1), transaction);
    return rows[0] ? formatContact(rows[0]) : null;
  }

  /** Link an existing directory contact to a matter. */
  async linkContact(lawFirmId: string, matterId: string, { contactId, role, notes, sortOrder, createdBy }: any, transaction?: DrizzleExecutor) {
    const rows = await scopedInsert(matterContacts, lawFirmId, {
      matterId, contactId, role: role || 'other', notes: notes ?? null,
      sortOrder: sortOrder == null ? 0 : sortOrder, createdBy: createdBy || null,
    }, transaction);
    return this.getContact(lawFirmId, matterId, rows[0].id, transaction);
  }

  /**
   * Update the per-matter facts of a link. The contact's own fields are edited
   * through the contacts module, never from here — that is the whole point of
   * the directory holding one canonical copy.
   */
  async updateContact(lawFirmId: string, matterId: string, linkId: string, patch: any) {
    if (!isUuid(linkId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['role', 'notes', 'sortOrder']) if (patch[field] !== undefined) values[field] = patch[field];
    if (!Object.keys(values).length) return this.getContact(lawFirmId, matterId, linkId);
    const rows = await scopedUpdate(matterContacts, lawFirmId, and(
      eq(matterContacts.matterId, matterId), eq(matterContacts.id, linkId),
    )!, values);
    return rows[0] ? this.getContact(lawFirmId, matterId, rows[0].id) : null;
  }

  /** Unlink a contact from a matter. The directory record is left alone. */
  async deleteContact(lawFirmId: string, matterId: string, linkId: string, transaction?: DrizzleExecutor) {
    if (!isUuid(linkId)) return;
    await scopedDelete(matterContacts, lawFirmId, and(
      eq(matterContacts.matterId, matterId), eq(matterContacts.id, linkId),
    )!, transaction);
  }
}

export = Object.assign(new MatterContactsRepository(), { formatContact });
