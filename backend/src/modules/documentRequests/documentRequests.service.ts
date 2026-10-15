const requestsRepo = require('./documentRequests.repository');
const filesRepo = require('../files/files.repository');
const clientsRepo = require('../clients/clients.repository');
const {
  assertMatterMembership, assertMatterReadAccess, getAccessibleMatterIds, isFirmOwnerOrAdmin,
} = require('../../shared/utils/membership');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../shared/errors/AppError');
const eventBus = require('../../shared/events/eventBus');
const { DOCUMENT_REQUEST_CREATED } = require('../../shared/events/eventTypes');

/**
 * Create a document request, either on a matter (addressed to a client on
 * that matter) or, when `matterId` is omitted, as a client-level "General"
 * request not tied to any matter. Matter-scoped requests keep the original
 * membership + matter-client checks; general requests only need the client
 * to actually belong to the firm (the route's `documents.request` permission
 * check already covers the acting user's authorization). Emits
 * DOCUMENT_REQUEST_CREATED so the client is notified (bell + email).
 */
export async function createRequest({
  lawFirmId, userId, matterId, clientId, title, note, dueDate, items, contactClientId,
}: any) {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) throw new ValidationError('Title is required');

  let client;
  if (matterId) {
    await assertMatterMembership(lawFirmId, matterId, userId);
    client = await requestsRepo.getClientOnMatter(lawFirmId, matterId, clientId);
    if (!client) throw new ValidationError('The selected client is not on this matter');
  } else {
    const found = await clientsRepo.findByIdOrFail(lawFirmId, clientId, 'Client');
    client = {
      clientId: found.id, userId: found.userId || null, clientType: found.clientType || 'person',
      name: found.name || '', email: found.email || null,
    };
  }

  // Targeting one specific roster contact only makes sense for a company: a
  // person client has exactly one recipient already, so there is nothing to
  // narrow. Validated up front so a bad id fails the create instead of
  // silently falling back to notifying the whole roster.
  let targetedContact = null;
  if (contactClientId) {
    if (client.clientType !== 'company') {
      throw new ValidationError('Only a company client has roster contacts to target');
    }
    targetedContact = await requestsRepo.getRosterContactById(lawFirmId, clientId, contactClientId);
    if (!targetedContact) {
      throw new ValidationError('The selected contact does not have portal access on this client');
    }
  }

  const request = await requestsRepo.create(lawFirmId, {
    matterId: matterId || null,
    clientId,
    title: cleanTitle,
    note: note?.trim() || null,
    dueDate: dueDate || null,
    createdBy: userId,
    items,
  });

  eventBus.emit(DOCUMENT_REQUEST_CREATED, {
    lawFirmId,
    matterId: matterId || null,
    clientId,
    clientType: client.clientType,
    // A person client's own portal uid, when they have one. A company target
    // has no single uid of its own (Phase 1 invariant) - the event handler
    // resolves its whole portal-enabled roster via clientId + clientType,
    // unless contactClientId narrows it to one already-validated contact.
    clientUserId: client.userId,
    clientName: client.name,
    clientEmail: client.email,
    contactClientId: contactClientId || null,
    requestId: request.id,
    title: request.title,
    itemCount: request.items.length,
    createdBy: userId,
  });

  return { message: 'Document request created successfully', request };
}

export async function listRequests({ lawFirmId, userId, matterId, page, limit, offset }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  return requestsRepo.listByMatter(lawFirmId, matterId, { page, limit, offset });
}

export async function getRequest({ lawFirmId, userId, requestId }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.matterId) await assertMatterReadAccess(lawFirmId, request.matterId, userId);
  return { request };
}

export async function updateRequest({ lawFirmId, userId, requestId, title, note, status, dueDate, addItems }: any) {
  const existing = await requestsRepo.getById(lawFirmId, requestId);
  if (!existing) throw new NotFoundError('Document request');
  // A general request has no matter to check membership against; the route's
  // firm-level `documents.request` permission is the only gate for it.
  if (existing.matterId) await assertMatterMembership(lawFirmId, existing.matterId, userId);

  const fields: Record<string, any> = {};
  if (title !== undefined) {
    const clean = (title || '').trim();
    if (!clean) throw new ValidationError('Title cannot be empty');
    fields.title = clean;
  }
  if (note !== undefined) fields.note = note?.trim() || null;
  if (status !== undefined) fields.status = status;
  if (dueDate !== undefined) fields.dueDate = dueDate || null;

  await requestsRepo.withLockedRequest(lawFirmId, requestId, async (transaction: any) => {
    if (Object.keys(fields).length) await requestsRepo.updateRequest(lawFirmId, requestId, fields, transaction);
    if (Array.isArray(addItems) && addItems.length) await requestsRepo.addItems(lawFirmId, requestId, addItems, transaction);

    // A manual status change is authoritative; otherwise keep the rollup honest.
    if (status === undefined) await requestsRepo.recomputeStatus(lawFirmId, requestId, transaction);
  });

  const request = await requestsRepo.getById(lawFirmId, requestId);
  return { message: 'Document request updated successfully', request };
}

export async function deleteRequest({ lawFirmId, userId, requestId }: any) {
  const existing = await requestsRepo.getById(lawFirmId, requestId);
  if (!existing) throw new NotFoundError('Document request');
  if (existing.matterId) await assertMatterMembership(lawFirmId, existing.matterId, userId);
  await requestsRepo.deleteRequest(lawFirmId, requestId);
  return { message: 'Document request deleted successfully', requestId };
}

/** Firm-side manual item status change (mark received without an upload, or waive). */
export async function updateItem({ lawFirmId, userId, requestId, itemId, status }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.matterId) await assertMatterMembership(lawFirmId, request.matterId, userId);
  const item = await requestsRepo.getItem(lawFirmId, requestId, itemId);
  if (!item) throw new NotFoundError('Checklist item');

  await requestsRepo.withLockedRequest(lawFirmId, requestId, async (transaction: any) => {
    await requestsRepo.setItemStatus(lawFirmId, itemId, status, transaction);
    await requestsRepo.recomputeStatus(lawFirmId, requestId, transaction);
  });

  const updated = await requestsRepo.getById(lawFirmId, requestId);
  return { message: 'Item updated successfully', request: updated };
}

/**
 * Link an already-uploaded file (picked from the matter's Files tab) to a
 * checklist item, as an alternative to waiting on the client to upload one.
 * References the file record rather than copying it, so it keeps its storage
 * path and place in the matter's folder tree. Only meaningful for a
 * matter-scoped request: a general request has no matter Files tab to pick
 * from, so linking is rejected outright (the frontend also hides the
 * control, but the backend enforces it independently).
 */
export async function linkFile({ lawFirmId, userId, requestId, itemId, fileId }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (!request.matterId) {
    throw new ValidationError('Cannot link a file to a request that is not tied to a matter');
  }
  await assertMatterMembership(lawFirmId, request.matterId, userId);
  const item = await requestsRepo.getItem(lawFirmId, requestId, itemId);
  if (!item) throw new NotFoundError('Checklist item');

  // The picker names the file by its row id, which is what the file browser
  // already shows it. It used to send the object path, and this resolved that
  // back to the row; the path was the identifier because the tree lived in it.
  const file = await filesRepo.findById(lawFirmId, fileId);
  if (!file) throw new NotFoundError('File');
  if (file.matterId && String(file.matterId) !== String(request.matterId)) {
    throw new ValidationError('That file belongs to a different matter');
  }

  await requestsRepo.withLockedRequest(lawFirmId, requestId, async (transaction: any) => {
    await requestsRepo.linkFile(lawFirmId, itemId, {
      fileId: file.id,
      objectPath: file.objectPath,
      fileName: file.name,
      linkedBy: userId,
    }, transaction);
    await requestsRepo.recomputeStatus(lawFirmId, requestId, transaction);
  });

  const updated = await requestsRepo.getById(lawFirmId, requestId);
  return { message: 'File linked successfully', request: updated };
}

/** Remove one fulfillment (uploaded or linked file) from a checklist item. */
export async function unlinkFile({ lawFirmId, userId, requestId, itemId, fulfillmentId }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.matterId) await assertMatterMembership(lawFirmId, request.matterId, userId);
  const item = await requestsRepo.getItem(lawFirmId, requestId, itemId);
  if (!item) throw new NotFoundError('Checklist item');

  const removed = await requestsRepo.removeFulfillment(lawFirmId, itemId, fulfillmentId);
  if (!removed) throw new NotFoundError('Fulfillment');

  const updated = await requestsRepo.getById(lawFirmId, requestId);
  return { message: 'File removed successfully', request: updated };
}

/**
 * Portal read: the open/completed requests addressed to a client (resolved by
 * the portal from the client's identity), optionally scoped to one matter.
 */
export async function listClientRequests({ lawFirmId, clientId, matterId = null }: any) {
  const requests = await requestsRepo.listForClient(lawFirmId, clientId, { matterId });
  return { requests };
}

/**
 * Firm-side read of every request addressed to one client, behind the same
 * ethical wall `getRequest` applies per row: general requests plus requests on
 * matters the caller may read. Owners and firm admins read every matter; other
 * members only the matters they are staffed on. `listClientRequests` stays
 * unfiltered because its other caller is the portal, where the client is the
 * addressee of every row.
 */
export async function listClientRequestsForMember({ lawFirmId, userId, clientId }: any) {
  const { requests } = await listClientRequests({ lawFirmId, clientId });
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) return { requests };
  const readable = await getAccessibleMatterIds(
    lawFirmId,
    requests.map((request: any) => request.matterId).filter(Boolean),
    userId,
  );
  return { requests: requests.filter((request: any) => !request.matterId || readable.has(request.matterId)) };
}

/**
 * Portal helper: verify a request is addressed to the given client and return the
 * matter it targets (needed to file the uploaded document before recording the
 * fulfillment). Throws if the request is missing or belongs to another client.
 */
export async function getClientRequestTarget({ lawFirmId, clientId, requestId }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.clientId !== clientId) throw new ForbiddenError('This request is not addressed to you');
  return { matterId: request.matterId, clientId: request.clientId, status: request.status, title: request.title };
}

/** Validate the checklist target before an upload can create or finalize files. */
export async function assertClientRequestItem({ lawFirmId, clientId, requestId, itemId }: any) {
  await getClientRequestTarget({ lawFirmId, clientId, requestId });
  if (!await requestsRepo.getItem(lawFirmId, requestId, itemId)) throw new NotFoundError('Checklist item');
}

/**
 * Portal fulfillment: called by the portal upload endpoint AFTER a client's
 * file(s) have been stored, to attach them to a checklist item. Verifies the
 * request is addressed to this client and the item belongs to it, then records
 * every file as one batch (single transaction, see repo `recordFulfillments`)
 * and recomputes the request rollup. Returns the item's new status.
 */
export async function recordFulfillment({ lawFirmId, clientId, requestId, itemId, files, uploadedBy }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.clientId !== clientId) throw new ForbiddenError('This request is not addressed to you');
  if (request.status === 'cancelled') throw new ValidationError('This request has been cancelled');

  const item = await requestsRepo.getItem(lawFirmId, requestId, itemId);
  if (!item) throw new NotFoundError('Checklist item');

  const status = await requestsRepo.withLockedRequest(lawFirmId, requestId, async (transaction: any) => {
    const current = await requestsRepo.getById(lawFirmId, requestId, transaction);
    if (current.status === 'cancelled') throw new ValidationError('This request has been cancelled');
    await requestsRepo.recordFulfillments(lawFirmId, itemId, files.map(({ fileId }: any) => ({
      fileId, uploadedBy,
    })), transaction);
    return requestsRepo.recomputeStatus(lawFirmId, requestId, transaction);
  });
  return { matterId: request.matterId, requestStatus: status };
}

/** Shared ownership check for the two client-facing fulfillment actions below. */
async function getOwnedFulfillment({ lawFirmId, clientId, requestId, itemId, fulfillmentId }: any) {
  const request = await requestsRepo.getById(lawFirmId, requestId);
  if (!request) throw new NotFoundError('Document request');
  if (request.clientId !== clientId) throw new ForbiddenError('This request is not addressed to you');

  const item = await requestsRepo.getItem(lawFirmId, requestId, itemId);
  if (!item) throw new NotFoundError('Checklist item');

  const fulfillment = await requestsRepo.getFulfillment(lawFirmId, itemId, fulfillmentId);
  if (!fulfillment) throw new NotFoundError('File');
  return fulfillment;
}

/**
 * Portal read: resolve a fulfillment's current file location so the caller can
 * mint a signed preview URL. Any file attached to a request addressed to this
 * client is viewable, whether the client or the firm attached it.
 */
export async function getClientFulfillmentFile({ lawFirmId, clientId, requestId, itemId, fulfillmentId }: any) {
  const fulfillment = await getOwnedFulfillment({ lawFirmId, clientId, requestId, itemId, fulfillmentId });
  return { objectPath: fulfillment.objectPath, fileName: fulfillment.fileName };
}

/**
 * Portal write: remove a fulfillment the client side uploaded. Unlike the
 * firm's own unlink action, this is restricted to files a client actually
 * sent, not one a firm member attached on the client's behalf via linkFile.
 * `attachedByFirm` carries that (see fulfillmentEntity); it used to be implied
 * by `fileId` being set, until every attachment gained one. Unlike the
 * firm's action too, the client has no separate control to flip an item's
 * status, so an item left with zero fulfillments after this reverts to
 * 'pending' rather than staying stuck on 'received' with nothing to show for it.
 *
 * Ownership is scoped to the active client RECORD (clientId), not to the
 * uploading uid: a company's request is addressed to the company, and any
 * roster contact currently authorized for that client record (already
 * verified by getOwnedFulfillment's clientId match, resolved from
 * getActiveClientAccessContext before this is called) may remove a
 * colleague's upload, the same way any of them may fulfill the request in
 * the first place. This intentionally does not gate on `clientUserId`
 * matching `uploadedBy` - for a person client that comparison was always a
 * no-op (a person has exactly one uid), so relaxing it changes nothing there
 * and only extends the existing behavior to a company's shared roster.
 */
export async function deleteClientFulfillment({ lawFirmId, clientId, requestId, itemId, fulfillmentId }: any) {
  const fulfillment = await getOwnedFulfillment({ lawFirmId, clientId, requestId, itemId, fulfillmentId });
  if (fulfillment.attachedByFirm) {
    throw new ForbiddenError('This file was attached by your law firm and can only be removed by them');
  }

  await requestsRepo.withLockedRequest(lawFirmId, requestId, async (transaction: any) => {
    await requestsRepo.removeFulfillment(lawFirmId, itemId, fulfillmentId, transaction);

    const item = await requestsRepo.getItem(lawFirmId, requestId, itemId, transaction);
    if (item?.status === 'received') {
      const remaining = await requestsRepo.countFulfillments(lawFirmId, itemId, transaction);
      if (remaining === 0) await requestsRepo.setItemStatus(lawFirmId, itemId, 'pending', transaction);
    }
    await requestsRepo.recomputeStatus(lawFirmId, requestId, transaction);
  });

  const updated = await requestsRepo.getById(lawFirmId, requestId);
  return { message: 'File removed successfully', request: updated };
}
