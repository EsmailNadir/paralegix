import { withTransactionEffects, type TransactionEffects } from '../../shared/database/transactionEffects';
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
'use strict';

const contactsRepo = require('./contacts.repository');
const { isUuid } = require('../../shared/utils/isUuid');
const {
  assertLawFirmMembership,
  assertMatterReadAccess,
  getAccessibleMatterIds,
  isFirmOwnerOrAdmin,
} = require('../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const eventBus = require('../../shared/events/eventBus');
const { CONTACT_CREATED, CONTACT_UPDATED, CONTACT_DELETED } = require('../../shared/events/eventTypes');

const trimOrNull = (v: any) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
};

// Tags are matched and de-duplicated case-insensitively but stored as typed, so
// "Expert" and "expert" don't both end up in the filter menu.
function normalizeTags(tags: any) {
  if (!Array.isArray(tags)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const tag = trimOrNull(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Resolve the optional court link, rejecting an id that belongs to another firm.
 * `court_id` carries a single-column FK (see the schema note), so this is the
 * layer that enforces the tenant boundary.
 */
async function assertCourtInFirm(lawFirmId: string, courtId: any) {
  if (courtId && !(await contactsRepo.courtExists(lawFirmId, courtId))) {
    throw new ValidationError({ courtId: ['That court does not exist in this firm.'] });
  }
}

/**
 * The page a list request gets when it names no `limit`: the largest page
 * `listContactsSchema` accepts.
 *
 * Omitting `limit` used to return the whole directory, which for a large firm
 * put every row into one JSON response. No screen asks for that (the frontend
 * always sends a page size), so an omitted limit is now bounded like any other
 * request, and `totalItems` tells the caller there is more. The export reads the
 * repository directly with no limit, because a file download must be complete.
 */
const UNSPECIFIED_LIMIT_PAGE = 500;

/** The firm's contact directory, one page at a time, with `totalItems`. */
export async function listContacts({
  lawFirmId, userId, search, category, matterId, courtId, hasCourt, tags, archived, oneTime,
  page, limit, offset, sort, sortBy, order,
}: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  // The contact directory is firm-wide, but `matterId` turns this into the
  // matter-contact view. Do not let its filter reveal which directory people
  // are linked to a matter the caller cannot read.
  if (matterId && isUuid(matterId)) await assertMatterReadAccess(lawFirmId, matterId, userId);

  const { contacts, totalItems } = await contactsRepo.listContactsPaged(lawFirmId, {
    search, category, matterId, courtId, hasCourt, tags, archived, oneTime,
    page, limit: limit ?? UNSPECIFIED_LIMIT_PAGE, offset: offset ?? null, sort, sortBy, order,
  });

  return { contacts, totalItems };
}

/**
 * Typeahead source for contact pickers. Responds with `{ items, hasMore }`
 * rather than the usual list envelope — this backs a per-keystroke read, and
 * `hasMore` falls out of the limit+1 fetch the repository already does.
 */
export async function lookupContacts({ lawFirmId, userId, search, ids, category, excludeMatterId, limit, full }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  // Excluding the contacts already on a matter is an inverse association
  // lookup. It has the same confidentiality boundary as listing that matter's
  // contacts, not the generic firm-wide directory boundary.
  if (excludeMatterId && isUuid(excludeMatterId)) {
    await assertMatterReadAccess(lawFirmId, excludeMatterId, userId);
  }
  return contactsRepo.lookupContacts(lawFirmId, { search, ids, category, excludeMatterId, limit, full });
}

/**
 * One contact, with the matters it appears on (and the role it plays on each).
 */
export async function getContact({ lawFirmId, userId, contactId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const contact = await contactsRepo.getContact(lawFirmId, contactId);
  if (!contact) throw new NotFoundError('Contact');

  const linkedMatters = await contactsRepo.listLinkedMatters(lawFirmId, contactId);
  const seeAllMatters = await isFirmOwnerOrAdmin(lawFirmId, userId);
  const accessibleMatterIds = seeAllMatters
    ? null
    : await getAccessibleMatterIds(lawFirmId, linkedMatters.map((matter: any) => matter.matterId), userId);
  const matters = seeAllMatters
    ? linkedMatters
    : linkedMatters.filter((matter: any) => accessibleMatterIds!.has(matter.matterId));
  // `matterCount` is a disclosure too: without this, an empty `matters` array
  // still reveals how many confidential matters a directory contact appears on.
  contact.matterCount = matters.length;
  return { contact, matters };
}

/** The distinct tags in use across the firm's directory, for the filter menu. */
export async function listTags({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const tags = await contactsRepo.listTags(lawFirmId);
  return { tags };
}

/**
 * Advisory near-match check for the create form: two real people can share a
 * name, so this never blocks anything — it just gives the caller matches to
 * warn about while the user is still typing.
 */
export async function checkDuplicateContact({ lawFirmId, userId, name, email }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const trimmedName = (name || '').trim();
  const trimmedEmail = trimOrNull(email);
  if (!trimmedName && !trimmedEmail) return { duplicates: [] };
  const duplicates = await contactsRepo.findPossibleDuplicates(lawFirmId, { name: trimmedName, email: trimmedEmail });
  return { duplicates };
}

/** Add a contact to the firm's directory. */
export async function createContact({ lawFirmId, userId, data }: any, context?: TransactionEffects) {
  await assertLawFirmMembership(lawFirmId, userId);

  const name = (data.name || '').trim();
  if (!name) throw new ValidationError({ name: ['Contact name is required.'] });

  const courtId = trimOrNull(data.courtId);
  await assertCourtInFirm(lawFirmId, courtId);

  const email = trimOrNull(data.email);

  return withTransactionEffects(async ({ executor, defer }) => {
    const contact = await contactsRepo.createContact(lawFirmId, {
      contactType: data.contactType || 'person',
      name,
      category: data.category || 'other',
      organization: trimOrNull(data.organization),
      title: trimOrNull(data.title),
      barNumber: trimOrNull(data.barNumber),
      email,
      phone: trimOrNull(data.phone),
      phoneAlt: trimOrNull(data.phoneAlt),
      fax: trimOrNull(data.fax),
      website: trimOrNull(data.website),
      address: trimOrNull(data.address),
      courtId,
      notes: trimOrNull(data.notes),
      tags: normalizeTags(data.tags) || [],
      oneTime: data.oneTime === true,
      createdBy: userId,
    }, executor);

    defer(() => {
      eventBus.emit(CONTACT_CREATED, {
        lawFirmId, entityId: contact.id, entityData: contact, userId,
      });
    });

    return { message: 'Contact created successfully', contactId: contact.id, contact };
  }, context);
}

/** Edit a directory contact. Partial patch: an omitted field is left untouched. */
export async function updateContact({ lawFirmId, userId, contactId, data }: any, context?: TransactionEffects) {
  await assertLawFirmMembership(lawFirmId, userId);

  const existing = await contactsRepo.getContact(lawFirmId, contactId, context?.executor);
  if (!existing) throw new NotFoundError('Contact');

  await assertCourtInFirm(lawFirmId, data.courtId !== undefined ? trimOrNull(data.courtId) : null);

  const patch: Record<string, any> = {};
  if (data.name !== undefined) {
    const name = (data.name || '').trim();
    if (!name) throw new ValidationError({ name: ['Contact name is required.'] });
    patch.name = name;
  }
  if (data.contactType !== undefined) patch.contactType = data.contactType;
  if (data.category !== undefined) patch.category = data.category;
  if (data.organization !== undefined) patch.organization = trimOrNull(data.organization);
  if (data.title !== undefined) patch.title = trimOrNull(data.title);
  if (data.barNumber !== undefined) patch.barNumber = trimOrNull(data.barNumber);
  if (data.email !== undefined) patch.email = trimOrNull(data.email);
  if (data.phone !== undefined) patch.phone = trimOrNull(data.phone);
  if (data.phoneAlt !== undefined) patch.phoneAlt = trimOrNull(data.phoneAlt);
  if (data.fax !== undefined) patch.fax = trimOrNull(data.fax);
  if (data.website !== undefined) patch.website = trimOrNull(data.website);
  if (data.address !== undefined) patch.address = trimOrNull(data.address);
  if (data.courtId !== undefined) patch.courtId = trimOrNull(data.courtId);
  if (data.notes !== undefined) patch.notes = trimOrNull(data.notes);
  if (data.tags !== undefined) patch.tags = normalizeTags(data.tags) || [];
  if (data.isArchived !== undefined) patch.isArchived = data.isArchived;
  if (data.oneTime !== undefined) patch.oneTime = data.oneTime;

  return withTransactionEffects(async ({ executor, defer }) => {
    const contact = await contactsRepo.updateContact(lawFirmId, contactId, patch, executor);
    if (!contact) throw new NotFoundError('Contact');

    defer(() => {
      eventBus.emit(CONTACT_UPDATED, {
        lawFirmId, entityId: contact.id, entityData: contact, userId,
      });
    });

    return { message: 'Contact updated successfully', contact };
  }, context);
}

/**
 * Delete a directory contact. The `matter_contacts` FK cascades, so this also
 * removes the contact from every matter it was on — the count comes back in the
 * response, and the list read carries `matterCount` so the caller can warn
 * first. Archiving is the non-destructive alternative for a contact the firm is
 * simply done with.
 */
export async function deleteContact({ lawFirmId, userId, contactId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const existing = await contactsRepo.getContact(lawFirmId, contactId);
  if (!existing) throw new NotFoundError('Contact');

  const linkedMatters = await contactsRepo.countLinkedMatters(lawFirmId, contactId);
  await contactsRepo.deleteContact(lawFirmId, contactId);

  eventBus.emit(CONTACT_DELETED, {
    lawFirmId, entityId: contactId, entityData: existing, userId,
  });

  return { message: 'Contact deleted successfully', contactId, unlinkedMatters: linkedMatters };
}

/**
 * Bring in a batch of contacts parsed from a CSV or vCard file.
 *
 * Rows that match an existing contact on name + email are SKIPPED rather than
 * duplicated or overwritten — an import is usually someone's exported address
 * book, and the overlap with what the firm already has is the normal case, not
 * an error. The response says exactly how many went each way so the UI can
 * report it rather than implying everything landed.
 */
/** Contacts created at once during a CSV import. Row count is caller-controlled. */
const IMPORT_CREATE_CONCURRENCY = Number(process.env.CONTACT_IMPORT_CONCURRENCY) || 6;

export async function importContacts({ lawFirmId, userId, rows }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const created: any[] = [];
  const skipped = [];
  const failed = [];

  // ONE duplicate probe for the whole file instead of one per row. The import
  // body is capped at 2M characters with no row cap, so the per-row probe meant
  // thousands of sequential round trips in a single request.
  const { byName, byEmail } = await contactsRepo.findPossibleDuplicatesBatch(
    lawFirmId,
    rows.map((r: any) => ({ name: trimOrNull(r.name), email: trimOrNull(r.email) })),
  );

  // Resolve a candidate against the batch result the same way the single-row
  // probe does: gather everything matching on name OR email, and report the
  // lowest by name.
  const existingDuplicate = (name: any, email: any) => {
    const ln = (name || '').trim().toLowerCase();
    const le = (email || '').trim().toLowerCase();
    const hits = [...(ln ? byName.get(ln) || [] : []), ...(le ? byEmail.get(le) || [] : [])];
    if (!hits.length) return null;
    const unique = [...new Map(hits.map((h) => [h.id, h])).values()];
    unique.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return unique[0];
  };

  // DECIDE SEQUENTIALLY, CREATE IN PARALLEL. The decision pass has to stay
  // ordered because a file may contain the same contact twice, and the second
  // occurrence must be skipped against the first — that de-duplication used to
  // fall out of creating rows one at a time, and would silently disappear if the
  // whole loop were parallelised. It costs nothing to keep: this pass is pure
  // in-memory work now that the probe is batched.
  const seenInFile = new Map(); // lowercased name/email -> source row that claimed it
  const toCreate: any[] = [];
  for (const [index, parsed] of rows.entries()) {
    // The parsers attach the position of the row in the USER'S file. Numbering
    // by position in this array instead drifts the moment a row is dropped, and
    // sends the user to the wrong line to fix the problem being reported. The
    // fallback covers a caller that passes rows built by hand.
    const { sourceRow, ...row } = parsed;
    const rowNumber = sourceRow ?? index + 1;
    const name = trimOrNull(row.name);
    if (!name) {
      failed.push({ row: rowNumber, reason: 'No name.' });
      continue;
    }
    const email = trimOrNull(row.email);
    const dup = existingDuplicate(name, email);
    if (dup) {
      skipped.push({ row: rowNumber, name, existingContactId: dup.id });
      continue;
    }
    const ln = name.toLowerCase();
    const le = (email || '').toLowerCase();
    const claimedBy = seenInFile.get(ln) ?? (le ? seenInFile.get(le) : undefined);
    if (claimedBy !== undefined) {
      // An earlier row in this same file is this contact. Its id is not known
      // until creation finishes, so it is filled in afterwards.
      skipped.push({ row: rowNumber, name, existingContactId: null, duplicateOfRow: claimedBy });
      continue;
    }
    seenInFile.set(ln, rowNumber);
    if (le) seenInFile.set(le, rowNumber);
    toCreate.push({ rowNumber, row, name });
  }

  // Creation is independent per row now that duplicates are already resolved.
  // Bounded because the row count is caller-controlled.
  const settled = await runWithConcurrency(
    toCreate.map((item) => () => createContact({
      lawFirmId, userId, data: { ...item.row, name: item.name },
    })),
    IMPORT_CREATE_CONCURRENCY,
  );

  const createdIdByRow = new Map();
  settled.forEach((res: any, i: any) => {
    const { rowNumber, name } = toCreate[i];
    if (res.status === 'fulfilled') {
      created.push(res.value.contact);
      createdIdByRow.set(rowNumber, res.value.contact.id);
    } else {
      failed.push({ row: rowNumber, name, reason: res.reason?.message || 'Could not be imported.' });
    }
  });

  // Point within-file duplicates at the row that actually got created, so the
  // report reads the same as it did when rows were created one at a time.
  for (const entry of skipped) {
    if (entry.duplicateOfRow !== undefined) {
      entry.existingContactId = createdIdByRow.get(entry.duplicateOfRow) ?? null;
      delete entry.duplicateOfRow;
    }
  }
  // Report rows in file order regardless of completion order.
  skipped.sort((a, b) => a.row - b.row);
  failed.sort((a, b) => a.row - b.row);

  return {
    message: `Imported ${created.length} contact${created.length === 1 ? '' : 's'}.`,
    imported: created.length,
    skipped,
    failed,
    contacts: created,
  };
}

/**
 * Every contact in the firm, unwindowed, for a file download. Uses the list read
 * with its filters so an export matches whatever the user is looking at.
 */
export async function exportContacts({ lawFirmId, userId, search, category, tags, archived }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const { contacts } = await contactsRepo.listContactsPaged(lawFirmId, {
    search, category, tags, archived, limit: null, sortBy: 'name', order: 'asc',
  });
  return { contacts };
}
