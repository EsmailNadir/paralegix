import { withTransactionEffects } from '../../../shared/database/transactionEffects';
const matterContactsRepo = require('./matterContacts.repository');
const contactsRepo = require('../../contacts/contacts.repository');
const contactsService = require('../../contacts/contacts.service');
const matterActivityService = require('../activity/matterActivity.service');
const { assertMatterReadAccess, assertMatterWriteAccess } = require('../../../shared/utils/membership');
const { assertFirmPermission } = require('../../lawfirms/roles/requirePermission');
const { NotFoundError, ConflictError, ValidationError } = require('../../../shared/errors/AppError');

// Human-readable labels for contact roles, used in the activity feed summary.
const ROLE_LABELS: any = {
  opposing_counsel: 'opposing counsel',
  opposing_party: 'opposing party',
  co_counsel: 'co-counsel',
  judge: 'judge',
  witness: 'witness',
  expert: 'expert',
  adjuster: 'adjuster',
  court_clerk: 'court clerk',
  mediator: 'mediator',
  guardian_ad_litem: 'guardian ad litem',
  other: 'contact',
};

const trimOrNull = (v: any) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
};

/**
 * List the directory contacts linked to a matter, ordered by sort order.
 *
 * Each row is the link (role, matter notes) joined onto the canonical contact,
 * so the caller sees one flat object but is reading one shared record.
 */
export async function listContacts({ lawFirmId, matterId, userId }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  const contacts = await matterContactsRepo.listContacts(lawFirmId, matterId);
  return { contacts };
}

/**
 * The contacts on a matter are part of the matter record, like its linked
 * clients, so every write here uses the same `assertMatterWriteAccess` gate as
 * `matterClients.service`: owners and firm admins on any matter, everyone else
 * only on a matter they are a member of.
 *
 * Put a contact on a matter, in either of two ways:
 *
 *  - `{ contactId, role }` links a contact that is already in the directory.
 *    This is the normal path, and the reason the directory exists.
 *  - `{ name, category, email, … , role }` creates the directory record first
 *    and then links it, so adding an opposing counsel nobody has entered yet is
 *    still one step. Because that branch writes to the shared directory, it
 *    additionally requires `contacts.manage` — `matters.update` alone lets a
 *    member arrange their own matter, not add records every other matter sees.
 */
export async function createContact({ lawFirmId, matterId, userId, data }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async (transition) => {
    const { executor, defer } = transition;
    const role = data.role || 'other';
    const linkNotes = trimOrNull(data.notes);

    let contactId = trimOrNull(data.contactId);
    let createdContact = null;

    if (contactId) {
      const contact = await contactsRepo.getContact(lawFirmId, contactId, executor);
      if (!contact) throw new NotFoundError('Contact');
    } else {
      if (!trimOrNull(data.name)) {
        throw new ValidationError({
          name: ['Pick an existing contact or provide a name for a new one.'],
        });
      }
      await assertFirmPermission(lawFirmId, userId, 'contacts.manage');
      // The matter-specific note stays on the link; it is not the new contact's
      // own note, which would follow them onto every other matter.
      const { contact } = await contactsService.createContact({
        lawFirmId,
        userId,
        data: { ...data, notes: null, category: data.category || role },
      }, transition);
      createdContact = contact;
      contactId = contact.id;
    }

    const existingLink = await matterContactsRepo.findLink(lawFirmId, matterId, contactId, executor);
    if (existingLink) {
      throw new ConflictError(`${existingLink.name} is already on this matter.`);
    }

    const contact = await matterContactsRepo.linkContact(lawFirmId, matterId, {
      contactId,
      role,
      notes: linkNotes,
      sortOrder: data.sortOrder,
      createdBy: userId,
    }, executor);

    defer(async () => { await matterActivityService.recordActivity({
      lawFirmId, matterId, activityType: 'contact.added', actorUserId: userId,
      summary: `Added ${ROLE_LABELS[contact.role] || 'contact'} ${contact.name}`,
      metadata: { linkId: contact.id, contactId, role: contact.role },
    }); });

    return {
      message: 'Contact added successfully',
      contact,
      // Tells the caller a new directory record was created rather than reused,
      // so it can invalidate the contacts list it may already be showing.
      contactCreated: Boolean(createdContact),
    };
  });
}

/**
 * Update what a contact is on this matter — their role, the matter-specific
 * note, the display order. Their name and contact details are shared with every
 * other matter and are edited through the contacts module.
 */
export async function updateContact({ lawFirmId, matterId, linkId, userId, data }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  const existing = await matterContactsRepo.getContact(lawFirmId, matterId, linkId);
  if (!existing) throw new NotFoundError('Contact on this matter');

  // Partial patch: only touch fields the caller actually sent.
  const patch: Record<string, any> = {};
  if (data.role !== undefined) patch.role = data.role;
  if (data.notes !== undefined) patch.notes = trimOrNull(data.notes);
  if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;

  const contact = await matterContactsRepo.updateContact(lawFirmId, matterId, linkId, patch);
  if (!contact) throw new NotFoundError('Contact on this matter');

  return { message: 'Contact updated successfully', contact };
}

/**
 * Take a contact off a matter. The directory record survives if other matters
 * may still be pointing at it. A one-time contact never gains a second link
 * (it is excluded from every picker), so removing it from the one matter it
 * was created for deletes the directory record too, rather than leaving an
 * orphaned row nothing can reach.
 */
export async function deleteContact({ lawFirmId, matterId, linkId, userId }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async (transition) => {
    const { executor, defer } = transition;
    const existing = await matterContactsRepo.getContact(lawFirmId, matterId, linkId, executor);
    if (!existing) throw new NotFoundError('Contact on this matter');

    await matterContactsRepo.deleteContact(lawFirmId, matterId, linkId, executor);
    if (existing.oneTime) {
      await contactsRepo.deleteContact(lawFirmId, existing.contactId, executor);
    }

    defer(async () => { await matterActivityService.recordActivity({
      lawFirmId, matterId, activityType: 'contact.removed', actorUserId: userId,
      summary: `Removed ${ROLE_LABELS[existing.role] || 'contact'} ${existing.name}`,
      metadata: { linkId: existing.id, contactId: existing.contactId, role: existing.role },
    }); });

    return { message: 'Contact removed successfully', linkId, contactId: existing.contactId };
  });
}
