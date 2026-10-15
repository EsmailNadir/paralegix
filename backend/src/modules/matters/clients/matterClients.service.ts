const { auth } = require('../../../shared/database/firebase');
const mattersRepo = require('../matters.repository');
const clientsService = require('../../clients/clients.service');
const eventBus = require('../../../shared/events/eventBus');
const { MATTER_CLIENTS_UPDATED } = require('../../../shared/events/eventTypes');
const {
  assertLawFirmMembership,
  assertMatterWriteAccess,
  getAccessibleMatterIds,
  isFirmOwnerOrAdmin,
} = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

/**
 * Resolve a userId from an email address.
 * Checks Firebase Auth first (still the source of identity), then the users table.
 */
async function resolveUserIdByEmail(email: any) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  // Single users-table lookup. If present it carries the uid + name + email.
  const u = await mattersRepo.findUserByEmail(normalizedEmail);
  if (u) return u;

  // Fall back to Firebase Auth (the identity source) only when the users table
  // has no row. Yields the uid even if the users row hasn't been provisioned.
  try {
    const userRecord = await auth.getUserByEmail(normalizedEmail);
    if (userRecord?.uid) return { uid: userRecord.uid, email: normalizedEmail };
  } catch {
    // user-not-found is expected
  }

  return null;
}

/**
 * Emit MATTER_CLIENTS_UPDATED with the latest clientIds/clientNames for a matter.
 */
async function emitMatterClientsUpdated(lawFirmId: string, matterId: string) {
  const { clientIds, clientNames } = await mattersRepo.getMatterClientsSummary(lawFirmId, matterId);
  eventBus.emit(MATTER_CLIENTS_UPDATED, { lawFirmId, matterId, clientIds, clientNames });
}

/**
 * List clients for a matter (JOIN matter_clients -> clients).
 */
export async function listClients({ lawFirmId, matterId, userId }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);
  const clients = await mattersRepo.listMatterClients(lawFirmId, matterId);
  return { clients };
}

/**
 * Which of `matterIds` this user may read the clients of, resolved in a constant
 * number of queries.
 *
 * This is `assertMatterWriteAccess` (the gate `listClients` above uses) answered
 * for a whole set instead of one matter: owners and firm admins reach any matter
 * that exists IN THIS FIRM, everyone else must be a member of the matter. Both
 * halves are the same shared primitives `assertMatterFirmWideAccess` composes
 * itself from, so the rule has one definition and this has no opinion of its own.
 * Answering a set rather than one id is the whole point of the batch: a
 * per-matter assertion would put the round trips straight back.
 *
 * Nothing here throws on an id the caller cannot reach. A batch names matters the
 * caller merely holds a list of, so an unreachable one is omitted rather than
 * failing the request, the way a per-matter 403 would.
 */
async function resolveReadableMatterIds(lawFirmId: string, userId: string, matterIds: string[]) {
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) {
    // Scoped to the firm, so an id from another firm is dropped here rather than
    // waved through on the strength of who is asking.
    return mattersRepo.filterExistingMatterIds(lawFirmId, matterIds);
  }
  return getAccessibleMatterIds(lawFirmId, matterIds, userId);
}

/**
 * List the clients of SEVERAL matters at once, as `{ [matterId]: [client, ...] }`.
 *
 * Same rows, same permission and same matter-level access rule as `listClients`,
 * in a constant number of queries instead of one round trip per matter. A matter
 * the caller cannot read is absent from the map; a matter they can read but which
 * has no clients is present and empty.
 */
export async function listClientsForMatters({ lawFirmId, userId, matterIds }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const requested = [...new Set((matterIds || []).filter(Boolean))] as string[];
  if (!requested.length) return { clientsByMatterId: {} };

  const readable = await resolveReadableMatterIds(lawFirmId, userId, requested);
  const visible = requested.filter((id) => readable.has(id));
  if (!visible.length) return { clientsByMatterId: {} };

  return { clientsByMatterId: await mattersRepo.listMatterClientsForMatters(lawFirmId, visible) };
}

/**
 * Add a client to a matter. Finds-or-creates a backing firm client record (auto-
 * linking by email when it matches an existing user), then links via matter_clients.
 */
export async function addClient({ lawFirmId, matterId, userId, client }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  const clientEmail = (client.email || '').trim().toLowerCase();
  const isCompany = client.clientType === 'company';
  // A company client can never carry clients.user_id directly (DB invariant);
  // portal access for a company lives on its roster instead, so an inline
  // company creation never resolves the email to a portal user the way a
  // person client does.
  let resolvedUserId = isCompany ? null : (client.userId || null);
  if (!isCompany && !resolvedUserId && clientEmail) {
    const existingUser = await resolveUserIdByEmail(clientEmail);
    if (existingUser) resolvedUserId = existingUser.uid;
  }

  // Find-or-create the backing client and link it in a single transaction so a
  // failure between the insert and the link can't orphan an unlinked client row.
  const [clientId] = await mattersRepo.findOrCreateClientsAndLinkToMatterTx(
    lawFirmId,
    matterId,
    [{ ...client, clientId: client.clientId || null, userId: resolvedUserId, email: clientEmail }],
  );

  emitMatterClientsUpdated(lawFirmId, matterId).catch((err) =>
    console.error('Error emitting MATTER_CLIENTS_UPDATED after add:', err)
  );

  return { message: 'Client added to matter', clientId };
}

/**
 * Update a client's details on a matter (updates the backing client record).
 */
export async function updateClient({ lawFirmId, matterId, clientId, userId, client }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  if (!(await mattersRepo.isClientLinkedToMatter(lawFirmId, matterId, clientId))) {
    throw new NotFoundError('Client on this matter');
  }

  // The shared client record is edited by the clients service, so this path
  // gets its normalisation, its CLIENT_UPDATED event and nothing of its own.
  // The body was validated against the client update schema: a field left out
  // is untouched, null clears an optional one.
  await clientsService.updateClient({ lawFirmId, clientId, body: client });

  emitMatterClientsUpdated(lawFirmId, matterId).catch((err) =>
    console.error('Error emitting MATTER_CLIENTS_UPDATED after update:', err)
  );

  return { message: 'Client updated successfully' };
}

/**
 * Remove a client from a matter (unlinks the matter_clients junction; the firm
 * client record is retained).
 */
export async function removeClient({ lawFirmId, matterId, clientId, userId }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  if (!(await mattersRepo.isClientLinkedToMatter(lawFirmId, matterId, clientId))) {
    throw new NotFoundError('Client on this matter');
  }

  await mattersRepo.removeMatterClient(lawFirmId, matterId, clientId);

  emitMatterClientsUpdated(lawFirmId, matterId).catch((err) =>
    console.error('Error emitting MATTER_CLIENTS_UPDATED after remove:', err)
  );

  return { message: 'Client removed from matter' };
}

/** Basis points representing a whole invoice. */
const FULL_PORTION_BP = 10000;

/**
 * Set (or clear) how a matter's invoices divide between its clients.
 *
 * This is a property of the engagement, not of any one invoice: a matter billed
 * 60/40 is billed 60/40 every time. Invoice generation reads it instead of
 * asking, which is why the rules are enforced here rather than at the point a
 * bill is raised.
 *
 * Two rules the payload cannot express on its own, so they live here:
 *  - every portion must name a client actually on the matter
 *  - a non-empty split must cover every client on the matter and total 100%
 *
 * An empty map clears the split and is always valid.
 */
export async function setBillingPortions({ lawFirmId, matterId, userId, portions }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId);
  const onMatter = new Set(matterClients.map((c: any) => c.id));
  const entries = Object.entries(portions || {});

  if (entries.length > 0) {
    const unknown = entries.map(([clientId]) => clientId).filter((id) => !onMatter.has(id));
    if (unknown.length > 0) {
      throw new ValidationError('Every payer must be a client on this matter.');
    }

    const missing = matterClients.filter((c: any) => !(c.id in portions));
    if (missing.length > 0) {
      throw new ValidationError(
        `Give every client on this matter a share. Missing: ${missing.map((c: any) => c.name || c.id).join(', ')}.`,
      );
    }

    const total = entries.reduce((sum, [, portion]) => sum + Number(portion), 0);
    if (total !== FULL_PORTION_BP) {
      throw new ValidationError(
        `Shares must add up to 100%. They currently add up to ${(total / 100).toFixed(2)}%.`,
      );
    }
  }

  await mattersRepo.setMatterClientBillingPortions(lawFirmId, matterId, portions || {});

  emitMatterClientsUpdated(lawFirmId, matterId).catch((err) =>
    console.error('Error emitting MATTER_CLIENTS_UPDATED after portion change:', err)
  );

  return {
    message: 'Billing split updated successfully',
    clients: await mattersRepo.listMatterClients(lawFirmId, matterId),
  };
}
