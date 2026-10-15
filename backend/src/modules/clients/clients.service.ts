import { withTransactionEffects } from '../../shared/database/transactionEffects';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  clientCompanyLinks,
  clients,
  contactClients,
  matters,
  users,
} from '../../shared/database/drizzle/schema';
import {
  systemQuery,
  tenantParameterizedQuery,
  tenantQuery,
  withDrizzleTransaction,
} from '../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';
import { rowIso } from '../../shared/utils/dateConversion';
import { invalidateClientAssociations } from './portal/clientAssociation.resolver';
const clientsRepo = require('./clients.repository');
const filesRepo = require('../files/files.repository');
const { removeCascadeObjects } = require('../files/cascadeSweep');
const clientEventsService = require('./clientEvents.service');
const invitationsService = require('../invitations/invitations.service');
const invitationsRepo = require('../invitations/invitations.repository');
const eventBus = require('../../shared/events/eventBus');
const {
  CLIENT_CREATED,
  CLIENT_DELETED,
  CLIENT_UPDATED,
  MATTER_CLIENTS_UPDATED,
} = require('../../shared/events/eventTypes');
const { NotFoundError, ValidationError, ForbiddenError, ConflictError } = require('../../shared/errors/AppError');
const { isUuid } = require('../../shared/utils/isUuid');
const { trustTxnRepo } = require('../trust/trust.repository');
const messagingRepo = require('../messaging/messaging.repository');
const { normalizeEmail } = require('../../shared/utils/normalizeEmail');
const contactsRepo = require('../contacts/contacts.repository');
const contactsService = require('../contacts/contacts.service');
const { assertFirmPermission } = require('../lawfirms/roles/requirePermission');
const {
  assertMatterReadAccess,
  assertMatterWriteAccess,
  getAccessibleMatterIds,
  isFirmOwnerOrAdmin,
} = require('../../shared/utils/membership');

function uniq(values: any) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

async function visibleMatterIdSet(lawFirmId: string, userId: string, matterIds: string[]) {
  const ids = uniq(matterIds);
  if (!ids.length) return new Set();
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) return new Set(ids);
  return getAccessibleMatterIds(lawFirmId, ids, userId);
}

function withVisibleMatterIds(client: any, visibleMatterIds: Set<any>) {
  return {
    ...client,
    matterIds: (client.matterIds || []).filter((matterId: string) => visibleMatterIds.has(matterId)),
  };
}

async function getClientOrThrow(lawFirmId: string, clientId: string) {
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');
  return client;
}

/**
 * Drop the portal access-context cache entry for a client's linked portal user
 * after a firm-side mutation that changes their association (revoke, matter
 * add/remove, delete). Lazy-required to avoid a clients<->portal require cycle
 * (portal.service already requires clients.service). No-op for placeholder rows
 * (no userId => no cached context).
 */
function invalidatePortalAccessContext(lawFirmId: string, clientUserId: string) {
  if (!clientUserId) return;
  try {
    // eslint-disable-next-line global-require
    require('./portal/portal.service').invalidateAccessContext({ lawFirmId, clientUserId });
  } catch (err: any) {
    console.warn('clients.service: failed to invalidate portal access context:', err.message);
  }
  // Also drop the central association resolver's cache entry for the same
  // (firm, uid) pair, so a just-revoked/relinked user can't keep reading a
  // stale association through the new resolver for the remainder of its TTL.
  invalidateClientAssociations({ lawFirmId, userId: clientUserId });
}

/**
 * Every portal uid whose access changes when `client`'s associations change.
 * A person client is just their own linked user. A COMPANY never carries a
 * `user_id` of its own (`clients_company_no_user_id_check`): its people reach
 * its matters through `client_company_links`, so their uids have to be
 * collected from the links or a company-side change would invalidate nothing
 * at all and leave every linked person reading stale access for the full TTL.
 */
async function portalUserIdsAffectedBy(lawFirmId: string, client: any): Promise<string[]> {
  const own = client.userId ? [client.userId] : [];
  if (client.clientType !== 'company') return own;
  const rosterUserIds = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: clients.userId })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, eq(clientCompanyLinks.companyClientId, client.id), sql`${clients.userId} is not null`)))
    .then((rows: any[]) => rows.map((row) => row.userId));
  return uniq([...own, ...rosterUserIds]) as string[];
}

/** `invalidatePortalAccessContext` for every uid `portalUserIdsAffectedBy` finds. */
async function invalidatePortalAccessForClient(lawFirmId: string, client: any) {
  const userIds = await portalUserIdsAffectedBy(lawFirmId, client);
  userIds.forEach((userId) => invalidatePortalAccessContext(lawFirmId, userId));
}

/** Fall back to the linked user's name/email when the client row lacks them. */
export async function enrichClientWithUserData(client: any) {
  const result = { ...client };
  if (!result.userId || (result.name && result.email)) return result;
  const rows = await systemQuery('auth_identity', (executor) => executor
    .select({ name: users.name, email: users.email }).from(users)
    .where(eq(users.id, result.userId)).limit(1));
  const u = rows[0];
  if (u) {
    result.name = result.name || u.name || null;
    result.email = result.email || u.email || null;
  }
  return result;
}

/**
 * The page a list request gets when it names no `limit`: the largest page
 * `listClientsSchema` accepts.
 *
 * Omitting `limit` used to return every client, which for a large firm put the
 * whole directory into one JSON response. No screen asks for that (the frontend
 * always sends a page size), so an omitted limit is now bounded like any other
 * request, and `totalItems` tells the caller there is more.
 */
const UNSPECIFIED_LIMIT_PAGE = 500;

/**
 * List the firm's clients, with free-text search, sorting and windowing all
 * resolved server-side. Clients have no ethical wall, so `clients.view` on the
 * route is the whole access check and every firm client is in scope.
 *
 * Search, filters and sort are applied to the whole set before the page is cut,
 * so a page reflects the full filtered result rather than a filtered page.
 * `matterId` narrows to the clients on one matter and `status` to one client
 * status.
 *
 * The response is `{ clients, totalItems }`, where `totalItems` is the size of
 * the full filtered result, so a client can render page controls without
 * fetching every row. Omitting `limit` returns the largest page, not every
 * client (see `UNSPECIFIED_LIMIT_PAGE`).
 *
 * Each client is enriched with its `matterIds` and, when its own name/email are
 * blank, the linked portal user's (the repository folds those in via a JOIN, so
 * this costs no extra round-trip).
 */
export async function listClients({
  lawFirmId, userId, portalOnly = false, matterId, status, clientType,
  page, limit, offset, search, sort, sortBy, order,
}: any) {
  // A plain client directory is firm-wide, but narrowing it by a matter asks
  // which clients are on that matter and must use the matter read boundary.
  if (matterId && isUuid(matterId)) await assertMatterReadAccess(lawFirmId, matterId, userId);
  const { clients: docs, totalItems } = await clientsRepo.listClientsPaged(lawFirmId, {
    portalOnly,
    matterId,
    status,
    clientType,
    page,
    limit: limit ?? UNSPECIFIED_LIMIT_PAGE,
    offset: offset ?? null,
    search,
    sort,
    sortBy,
    order,
  });
  const visibleMatterIds = await visibleMatterIdSet(
    lawFirmId,
    userId,
    docs.flatMap((client: any) => client.matterIds || []),
  );
  const clients = docs.map(({ userName, userEmail, ...c }: any) => ({
    ...withVisibleMatterIds(c, visibleMatterIds),
    name: c.name || userName || null,
    email: c.email || userEmail || null,
  }));
  return { clients, totalItems };
}

/**
 * Typeahead source for client pickers. `matterId` restricts the result to that
 * matter's linked clients, for pickers whose choice must stay inside one matter;
 * `excludeArchived` hides archived clients from the browsable result, for pickers
 * that attach a client to new work; `full` returns the enriched client instead of
 * the slim picker row. All three are optional and additive, so existing callers
 * are unaffected.
 *
 * `ids` and `userIds` are the two spellings of the label-resolution mode: `ids`
 * addresses the `clients` row, `userIds` the linked portal account's Firebase
 * UID, for pickers whose value identifies a person rather than a client record.
 * They are mutually exclusive and the route rejects a request carrying both.
 *
 * Enriched items get the same name/email backfill from the linked portal user as
 * the list and by-ids reads, so a client created from an invite whose own name
 * was never filled in still carries one.
 */
export async function lookupClients({
  lawFirmId, userId, search, exactName, exactOrganization, excludeId, ids, userIds, portalOnly = false, matterId, clientType, excludeArchived = false, excludeLinkedToClientId, limit, full,
}: any) {
  if (matterId && isUuid(matterId)) await assertMatterReadAccess(lawFirmId, matterId, userId);
  const result = await clientsRepo.lookupClients(lawFirmId, {
    search, exactName, exactOrganization, excludeId, ids, userIds, portalOnly, matterId, clientType, excludeArchived, excludeLinkedToClientId, limit, full,
  });
  if (!full) return result;

  // The enriched client carries its matterIds, which are not firm-wide: list
  // and get hide the ones the caller is walled from, and so must this.
  const visibleMatterIds = await visibleMatterIdSet(
    lawFirmId,
    userId,
    result.items.flatMap((client: any) => client.matterIds || []),
  );
  return {
    ...result,
    items: result.items.map(({ userName, userEmail, ...c }: any) => ({
      ...withVisibleMatterIds(c, visibleMatterIds),
      name: c.name || userName || null,
      email: c.email || userEmail || null,
    })),
  };
}

/** Create or upsert a client (upsert keyed by linked userId when present). */
export async function createClient({ lawFirmId, actingUserId, body }: any) {
  const requestedMatterIds = uniq(body.matterIds || []);

  // `matterIds` creates the same matter_clients relationships as the dedicated
  // matter-client endpoints. Validate their capability and ethical-wall access
  // before an invite email or client row can be created, so this convenience
  // path cannot become a partial side door around either boundary.
  if (requestedMatterIds.length > 0) {
    await assertFirmPermission(lawFirmId, actingUserId, 'matters.manageClients');
    for (const matterId of requestedMatterIds) {
      // eslint-disable-next-line no-await-in-loop
      await assertMatterWriteAccess(lawFirmId, matterId, actingUserId);
    }
  }

  let userData = null;
  if (body.userId) {
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ name: users.name, email: users.email }).from(users)
      .where(eq(users.id, body.userId)).limit(1));
    userData = rows[0] || null;
  }

  const resolvedEmail = normalizeEmail(body.email) || normalizeEmail(userData && userData.email) || null;
  const shouldAutoInviteToPortal = body.portalInvitePending === true && !body.userId && !!resolvedEmail;

  const existing = body.userId ? await clientsRepo.findByUserId(lawFirmId, body.userId) : null;

  return withTransactionEffects(async ({ executor, defer }) => {
    // Invitation preparation shares the client transaction; delivery follows its commit.
    let portalStatus = 'none';
    let inviteResolvedClientId = null;
    let preparedClient = null;
    if (shouldAutoInviteToPortal) {
      try {
        const inviteEffects: Array<() => void | Promise<void>> = [];
        const prepared = await withDrizzleTransaction<any>(async (inviteExecutor: any) => {
          const result = await invitationsService.sendClientInvite({
            lawFirmId, userId: actingUserId, body: { email: resolvedEmail },
          }, { executor: inviteExecutor, defer: (effect: () => void | Promise<void>) => { inviteEffects.push(effect); } });
          const linked = result.status === 'added'
            ? await invitationsRepo.findClientByEmail(lawFirmId, resolvedEmail, inviteExecutor)
            : null;
          const clientId = linked?.id || (result.status === 'added' ? null : result.clientId);
          const client = clientId ? await clientsRepo.findByIdRaw(lawFirmId, clientId, inviteExecutor) : null;
          if (clientId && !client) throw new NotFoundError('Client');
          if (result.status === 'added' && !client) throw new NotFoundError('Client');
          return { result, client };
        }, executor);
        for (const effect of inviteEffects) defer(effect);
        portalStatus = prepared.result.status || 'none';
        preparedClient = prepared.client;
        inviteResolvedClientId = preparedClient?.id || null;
      } catch (inviteErr: any) {
        console.warn('clients.service: sendClientInvite failed (non-fatal):', inviteErr.message);
        portalStatus = 'invite_failed';
      }
    }

    // Resolve exactly one target client row. Priority:
    //  1. The row sendClientInvite created/resolved (existing client by userId, or a
    //     placeholder it already owned). Never insert a second row alongside it.
    //  2. An existing row keyed by the request's userId.
    //  3. A fresh placeholder via upsertTxn.
    let targetExistingId = existing ? existing.id : null;
    let reuseExisting = existing;
    let invitePortalState = shouldAutoInviteToPortal;
    if (inviteResolvedClientId) {
      const inviteClient = preparedClient;
      if (inviteClient) {
        // The invite path already wrote portal/invite metadata on this row; reuse it
        // as the single target and don't clobber its invite state from here (it may
        // have cleared portalInvitePending or linked the row to a real uid).
        targetExistingId = inviteClient.id;
        reuseExisting = inviteClient;
        invitePortalState = inviteClient.portalInvitePending === true;
      }
    }

    const data = {
      // Immutable after insert (DB trigger): on an update path this must stay the
      // reused row's own value, never re-derive from body.clientType, or a caller
      // that omits clientType on an update-shaped request would attempt to reset
      // a company back to the 'person' default and the trigger would reject it.
      clientType: (reuseExisting && reuseExisting.clientType) || body.clientType || 'person',
      userId: body.userId || (reuseExisting && reuseExisting.userId) || null,
      email: resolvedEmail || (reuseExisting && reuseExisting.email) || null,
      name: body.name ?? (reuseExisting && reuseExisting.name) ?? (userData && userData.name) ?? '',
      phone: body.phone ?? (reuseExisting && reuseExisting.phone) ?? null,
      organization: body.organization ?? (reuseExisting && reuseExisting.organization) ?? null,
      address: body.address ?? (reuseExisting && reuseExisting.address) ?? null,
      // An explicit null is a chosen "None" and is stored as such; only an
      // absent field falls back to the reused row's value, then to 'email'.
      preferredContactMethod: body.preferredContactMethod === null
        ? null
        : body.preferredContactMethod || (reuseExisting && reuseExisting.preferredContactMethod) || 'email',
      status: body.status || (reuseExisting && reuseExisting.status) || 'active',
      portalInvitePending: invitePortalState ? true : ((reuseExisting && reuseExisting.portalInvitePending) || false),
      invitedBy: (reuseExisting && reuseExisting.invitedBy) || (shouldAutoInviteToPortal ? actingUserId : null),
      invitedAt: (reuseExisting && reuseExisting.invitedAt) || (shouldAutoInviteToPortal ? new Date() : null),
    };

    const finalClientId = await clientsRepo.upsertTxn(lawFirmId, targetExistingId, data, executor);
    const links = requestedMatterIds.length
      ? await clientsRepo.linkMattersTxn(lawFirmId, finalClientId, requestedMatterIds, executor)
      : { added: [], failed: [] };
    if (links.failed.length) throw new NotFoundError('Matter');
    defer(() => {
      for (const matterId of links.added) {
        eventBus.emit(MATTER_CLIENTS_UPDATED, { lawFirmId, matterId });
      }
      eventBus.emit(CLIENT_CREATED, { lawFirmId, clientId: finalClientId, userId: data.userId });
    });
    return { message: 'Client created successfully', clientId: finalClientId, portalStatus };
  });
}

export async function getClient({ lawFirmId, clientId, userId }: any) {
  const client = await getClientOrThrow(lawFirmId, clientId);
  const enriched = await enrichClientWithUserData(client);
  // Include the client's matter associations (from the matter_clients junction) so
  // the detail view can resolve its matters, tasks, and billing from matterIds.
  // The list endpoint already aggregates these; getClient must match so both views
  // agree even for clients with no linked portal user (clientUserIds is empty then).
  const matterIds = await clientsRepo.listMatterIds(lawFirmId, clientId);
  return withVisibleMatterIds(
    { ...enriched, matterIds },
    await visibleMatterIdSet(lawFirmId, userId, matterIds),
  );
}

/**
 * List the companies a Person client belongs to. These are intentionally a
 * separate read from the client's free-text `organization` field: primary,
 * email delivery, and billing visibility are properties of each company link.
 */
export async function listClientCompanyRelationships({ lawFirmId, clientId }: any) {
  const person = await getClientOrThrow(lawFirmId, clientId);
  if (person.clientType !== 'person') return { relationships: [] };

  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: clientCompanyLinks.id,
      companyClientId: clientCompanyLinks.companyClientId,
      companyName: clients.name,
      relationship: clientCompanyLinks.relationship,
      isPrimary: clientCompanyLinks.isPrimary,
      isEmailRecipient: clientCompanyLinks.isEmailRecipient,
      canViewBilling: clientCompanyLinks.canViewBilling,
    })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.companyClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(
      scope,
      eq(clientCompanyLinks.personClientId, clientId),
      eq(clients.clientType, 'company'),
    ))
    .orderBy(asc(clients.name)));

  // How many people each of those companies has flagged "Receives emails", so
  // an editor here can tell whether clearing THIS person's flag would leave the
  // company with nobody to bill. Without it the person-side form is the one
  // place that can silently strip a company's last billing recipient: it only
  // ever loads this person's own links, so it cannot see the rest of the
  // roster. One grouped query over the companies already in hand, not a
  // per-company lookup.
  const companyIds = Array.from(new Set((rows as any[]).map((row) => row.companyClientId)));
  const recipientCounts = new Map<string, number>();
  if (companyIds.length) {
    const counts = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
      .select({
        companyClientId: clientCompanyLinks.companyClientId,
        total: count(),
      })
      .from(clientCompanyLinks)
      .where(and(
        scope,
        inArray(clientCompanyLinks.companyClientId, companyIds),
        eq(clientCompanyLinks.isEmailRecipient, true),
      ))
      .groupBy(clientCompanyLinks.companyClientId));
    for (const row of counts as any[]) recipientCounts.set(row.companyClientId, Number(row.total) || 0);
  }

  return {
    relationships: rows.map((row: any) => ({
      ...row,
      isPrimary: Boolean(row.isPrimary),
      isEmailRecipient: Boolean(row.isEmailRecipient),
      canViewBilling: Boolean(row.canViewBilling),
      companyEmailRecipientCount: recipientCounts.get(row.companyClientId) || 0,
    })),
  };
}

/**
 * Resolve the effective client id set (own id + linked companies) that a
 * person client's items on other tabs (Tasks, Matters, Events, Notes, Time
 * Tracking, Billing) should be widened across. Re-exported from
 * `clientCompanyLinks.util.ts`, which reads the same `client_company_links`
 * table `listClientCompanyRelationships` above does; the resolver lives in
 * its own file so tasks/matters/billing can import it without a circular
 * require back into this module.
 */
export { resolveEffectiveClientIds, resolveBillingEffectiveClientIds } from './clientCompanyLinks.util';

/**
 * Resolve multiple clients by id in one round-trip (replaces the frontend
 * getClientProfilesByIds N+1). Each client is enriched with linked-user
 * name/email so an item matches the single-client GET shape exactly. Unknown /
 * cross-firm / malformed ids are silently omitted. Returns `{ clients: [...] }`.
 */
export async function getClientsByIds({ lawFirmId, ids }: any) {
  const requested = uniq(ids);
  if (!requested.length) return { clients: [] };

  const docs = await clientsRepo.findByIdsRaw(lawFirmId, requested);

  // Linked-user name/email are folded into findByIdsRaw via LEFT JOIN users
  // (userName/userEmail), so the previous separate `users` lookup is gone.
  // backfill the client row's missing name/email from the joined values.
  const clients = docs.map(({ userName, userEmail, ...c }: any) => ({
    ...c,
    name: c.name || userName || null,
    email: c.email || userEmail || null,
  }));
  return { clients };
}

export async function updateClient({ lawFirmId, clientId, body }: any) {
  const existing = await getClientOrThrow(lawFirmId, clientId);
  const updates: Record<string, any> = {};
  ['name', 'phone', 'organization', 'address', 'preferredContactMethod', 'status'].forEach((f) => {
    if (typeof body[f] !== 'undefined') updates[f] = body[f];
  });
  if (typeof body.email !== 'undefined') updates.email = normalizeEmail(body.email);
  if (Object.keys(updates).length === 0) return { message: 'No changes applied' };

  await clientsRepo.update(lawFirmId, clientId, updates);
  eventBus.emit(CLIENT_UPDATED, { lawFirmId, clientId, userId: existing.userId || null, updates });
  return { message: 'Client updated successfully' };
}

export async function revokePortalAccess({ lawFirmId, clientId }: any) {
  const existing = await getClientOrThrow(lawFirmId, clientId);
  if (!existing.userId) {
    throw new ValidationError({ userId: ['This client does not have portal access'] });
  }
  await clientsRepo.update(lawFirmId, clientId, { userId: null, joinedAt: null, portalInvitePending: false });
  // Drop the cached access context immediately so the just-revoked user can't keep
  // reading this firm's portal data for the remainder of the TTL window.
  invalidatePortalAccessContext(lawFirmId, existing.userId);
  return { message: 'Portal access revoked successfully' };
}

export async function removeClient({ lawFirmId, clientId, actingUserId }: any) {
  const existing = await getClientOrThrow(lawFirmId, clientId);
  // The delete cascades the client's links, notes, events and files on every
  // matter it is linked to. Linking or unlinking one matter takes write access
  // to it, so a delete may not do the same to matters the caller is walled from.
  // Read and write access to a matter are the same audience (a firm owner or
  // admin, or a member of the matter), so the visible set is the writable set.
  // The refusal gives a count and no names: the caller may not learn what the
  // matters are.
  const linkedMatterIds = await clientsRepo.listMatterIds(lawFirmId, clientId);
  const accessibleMatterIds = await visibleMatterIdSet(lawFirmId, actingUserId, linkedMatterIds);
  const walledCount = linkedMatterIds.filter((matterId: string) => !accessibleMatterIds.has(matterId)).length;
  if (walledCount > 0) {
    throw new ForbiddenError(
      `This client is linked to ${walledCount} ${walledCount === 1 ? 'matter' : 'matters'} you do not have access to, so it cannot be deleted. Ask a member of ${walledCount === 1 ? 'that matter' : 'those matters'} or a firm admin to delete it.`,
    );
  }
  // The `clients_legal_hold_delete_guard` trigger refuses this too, and that is
  // what makes it a guarantee for a delete path that forgets to ask. This check
  // stays because a trigger raises a raw error and this raises a sentence.
  if (await clientsRepo.hasLiveLegalHold(lawFirmId, clientId)) {
    throw new ForbiddenError('This client is under legal hold and cannot be deleted.');
  }
  // Trust ledger entries are append-only and reference the client by FK. Deleting
  // a client with any trust activity would violate that FK (raw 500) and orphan
  // immutable records, so block it with a clear message.
  if (await trustTxnRepo.countByClientId(lawFirmId, clientId) > 0) {
    throw new ConflictError('This client has trust account activity and cannot be removed. Trust ledger entries are permanent.');
  }
  // A retainer replenishment threshold is a setting rather than a permanent
  // record, so it gets its own message telling the firm how to clear it. Its FK
  // became `restrict` in migration 0225; without this check that constraint
  // would surface as a raw 500 from inside deleteClientCascade.
  if (await trustTxnRepo.countMinimumBalancesByClientId(lawFirmId, clientId) > 0) {
    throw new ConflictError('This client has a trust minimum balance configured and cannot be removed. Remove the minimum balance first.');
  }
  // Deleting the client cascades away its client-context invoices (with payment
  // history), time entries, flat fees, and expenses. Block it so financial
  // records aren't silently destroyed; archive the client instead.
  if (await clientsRepo.countBillingRecords(lawFirmId, clientId) > 0) {
    throw new ConflictError('This client has billing records (invoices, time entries, or expenses) and cannot be removed. Archive the client instead.');
  }
  // A company's canonical conversation (conversations.client_record_id,
  // migration 0172) is bound to clients.id with no ON DELETE action: that FK
  // deliberately RESTRICTs a delete rather than cascading message history away,
  // per that migration's own comment. Check for a LIVE (non-archived) one up
  // front so a firm sees a clear, actionable error instead of a raw
  // FK-violation 500 surfacing from deep inside deleteClientCascade's
  // transaction. Archiving the conversation first (PUT
  // .../conversations/:id/archive) clears this check; deleteClientCascade then
  // severs the archived row's client_record_id itself so the FK no longer
  // blocks the delete, while leaving the conversation and its messages intact
  // as the historical record - only the attachment bytes are reclaimed, below.
  if (await messagingRepo.findCanonicalCompanyConversation(lawFirmId, clientId)) {
    throw new ConflictError('This company has an active conversation and cannot be removed. Archive the conversation first.');
  }
  const userId = existing.userId || null;
  const email = existing.email || null;
  const matterIds = linkedMatterIds;

  // Collected BEFORE the cascade: for a company, the affected uids live on the
  // `clients` rows the `client_company_links` being cascade-deleted below
  // point at, so afterwards there is nothing left to find them by.
  const affectedPortalUserIds = await portalUserIdsAffectedBy(lawFirmId, existing);

  // The guard above proves no LIVE canonical conversation exists, so every row
  // this finds is already archived. Collect their ids before the cascade nulls
  // out client_record_id on them (deleteClientCascade), which is the only way
  // to find them by this client afterward - see the sweep call below.
  const archivedConversationIds = await messagingRepo.listArchivedCompanyConversationIds(lawFirmId, clientId);

  // Purge the client's own synced calendar events BEFORE the cascade removes
  // events out from under it (`events.client_id ... on delete
  // cascade`, schema.sql) - there is no application-level subcollection
  // delete for this table the way matters has `deleteAllForMatter`. Without
  // this, a client meeting or deadline already pushed to a member's real
  // Google/Outlook calendar survives the client's removal indefinitely, and
  // the `calendar_mappings` row naming the now-gone event is never cleaned
  // up either. Mirrors `purgeExternalCalendarsBeforeMatterRemoval`'s matter-
  // event purge; billing.events.ts's own CLIENT_DELETED listener already
  // does the equivalent for this client's synced invoices.
  await clientEventsService.emitCalendarDeletesForAllClientEvents({ lawFirmId, clientId });

  // Targeted pending invitations are removed transactionally with everything else
  // in deleteClientCascade, not after the fact, see that method's doc for why
  // order matters here.
  // Snapshotted before the cascade: the client's file rows go with them, and
  // nothing afterwards could name their stored objects or their bytes.
  const clientFiles = await filesRepo.scopeSnapshot(lawFirmId, { clientId });
  await clientsRepo.deleteClientCascade(lawFirmId, clientId);
  // Inside the request: after the response Cloud Run gives this process no
  // CPU, and a sweep left to an event listener did not finish.
  await removeCascadeObjects('CLIENT_DELETED', lawFirmId, clientFiles);

  // The client's portal association is gone; drop any cached access context so a
  // still-authenticated portal session can't read the firm's data until the TTL.
  affectedPortalUserIds.forEach((affectedUserId: any) => invalidatePortalAccessContext(lawFirmId, affectedUserId));

  // Reclaim the GCS attachments of any archived canonical conversation(s) this
  // client leaves behind - see sweepArchivedCompanyConversationAttachments for
  // why nothing else in the app would ever reach them otherwise. Best-effort:
  // it never throws, so a storage hiccup can't undo the delete that already committed.
  if (archivedConversationIds.length) {
    await messagingRepo.sweepArchivedCompanyConversationAttachments(lawFirmId, archivedConversationIds);
  }

  await eventBus.emitAsync(CLIENT_DELETED, {
    lawFirmId,
    clientId,
    userId,
    matterIds,
    files: clientFiles,
    // Every portal uid this delete affects. For a company that is its linked
    // people, since the company itself never carries `user_id`. Listeners union
    // this with `userId` and dedupe, so passing the superset changes nothing
    // for a person client.
    rosterUserIds: affectedPortalUserIds,
  });
  return { message: 'Client removed successfully' };
}

/**
 * Attach a client to one or more matters via `matter_clients`.
 *
 * This is the SAME junction the direct `POST /matters/:matterId/clients` route
 * writes, gated there on `matters.manageClients` plus `assertMatterWriteAccess`
 * (owner/admin bypass, else real matter membership). This route is gated at the
 * middleware layer on `clients.manage` only, so both checks are repeated here -
 * otherwise a caller holding `clients.manage` but nothing under `matters.*`
 * (and not even a member of the target matter) could attach any client to any
 * matter in the firm by routing the write through this client-side endpoint,
 * something the direct matter route correctly 403s them for. Same class of gap
 * as the matter/client events permission-parity fix.
 */
export async function addClientMatters({ lawFirmId, clientId, matterIds, actingUserId }: any) {
  const existing = await getClientOrThrow(lawFirmId, clientId);
  const uniqueMatterIds = uniq(matterIds);
  if (uniqueMatterIds.length === 0) {
    throw new ValidationError({ matterIds: ['At least one matterId is required'] });
  }
  await assertFirmPermission(lawFirmId, actingUserId, 'matters.manageClients');
  // Check every matter before linking any: one the caller cannot write refuses
  // the whole request, so a 403 never leaves earlier matters linked. Matters
  // that do not exist are not an access question and are reported as failed
  // below, with the rest still linked.
  for (const matterId of uniqueMatterIds) {
    if (!(await clientsRepo.matterExists(lawFirmId, matterId))) continue;
    await assertMatterWriteAccess(lawFirmId, matterId, actingUserId);
  }
  // One transaction for the links, then the announcements, as createClient does.
  // An already linked matter counts as added: the caller asked for the link and
  // it exists, which is what `added` has always meant here.
  const { failed } = await clientsRepo.linkMattersTxn(lawFirmId, clientId, uniqueMatterIds);
  const failedIds = new Set(failed.map((entry: any) => entry.matterId));
  const added = uniqueMatterIds.filter((matterId: any) => !failedIds.has(matterId));
  for (const matterId of added) {
    eventBus.emit(MATTER_CLIENTS_UPDATED, { lawFirmId, matterId });
  }
  // The client's accessible matterIds changed; drop the cached access context so the
  // new links are reflected on the next portal request instead of after the TTL.
  if (added.length > 0) await invalidatePortalAccessForClient(lawFirmId, existing);
  return { message: 'Client-matter associations updated', added, failed };
}

/** See `addClientMatters` for why both checks are repeated on this side of the link. */
export async function removeClientMatter({ lawFirmId, clientId, matterId, actingUserId }: any) {
  const existing = await getClientOrThrow(lawFirmId, clientId);
  if (!(await clientsRepo.matterExists(lawFirmId, matterId))) throw new NotFoundError('Matter');
  await assertFirmPermission(lawFirmId, actingUserId, 'matters.manageClients');
  await assertMatterWriteAccess(lawFirmId, matterId, actingUserId);
  await clientsRepo.unlinkMatter(lawFirmId, matterId, clientId);
  eventBus.emit(MATTER_CLIENTS_UPDATED, { lawFirmId, matterId });
  // The client lost access to this matter; drop the cached access context so the
  // revoked matterId can't be read for the remainder of the TTL window.
  await invalidatePortalAccessForClient(lawFirmId, existing);
  return { message: 'Matter association removed successfully' };
}

export async function listClientMatters({ lawFirmId, clientId, userId }: any) {
  await getClientOrThrow(lawFirmId, clientId);
  const matterIds = await clientsRepo.listMatterIds(lawFirmId, clientId);
  const visibleMatterIds = [...await visibleMatterIdSet(lawFirmId, userId, matterIds)];
  if (!visibleMatterIds.length) return { matters: [] };
  const { rows } = await tenantParameterizedQuery(matters, lawFirmId,
    `select c.id, c.name, c.matter_number, c.status, c.description, c.created_at, c.updated_at,
            pa.name as practice_area_name
       from matters c
       left join practice_areas pa on pa.id = c.practice_area_id
      where c.law_firm_id = $1 and c.id = any($2)`,
    [lawFirmId, visibleMatterIds],
    'c',
  );
  const matterEntities = rows.map((r: any) => ({
    id: r.id, matterId: r.id, name: r.name || null, matterNumber: r.matter_number || null,
    status: r.status || 'active', practiceAreaName: r.practice_area_name || null,
    description: r.description || null, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
  return { matters: matterEntities };
}

// Standalone (firm-scoped) tasks the client is linked to via task_clients.
// used by the firm-side "share files with client" picker. Matter-scoped tasks are
// covered by the client's matters, so they're not repeated here.
export async function listClientStandaloneTasks({ lawFirmId, clientId }: any) {
  await getClientOrThrow(lawFirmId, clientId);
  const tasksRepo = require('../tasks/tasks.repository');
  const taskIds = await clientsRepo.listTaskIds(lawFirmId, clientId);
  if (!taskIds.length) return { tasks: [] };
  const titlesById = await tasksRepo.findTitlesByIds(lawFirmId, taskIds);
  const tasks = taskIds
    .map((id: any) => ({ id, title: titlesById[id] || 'Untitled task' }))
    .sort((a: any, b: any) => a.title.localeCompare(b.title));
  return { tasks };
}

// Notes: see modules/clients/notes/, which uses the shared notes engine
// matter/task/client notes all share.

// ---- client relationships (client_company_links) ----
//
// A company's people are real, standalone Person `clients` rows now (their
// own matters, billing, portal identity), linked to the company via
// `client_company_links` (migration 0174) instead of the old `contact_clients`
// roster junction onto the firm-wide `contacts` directory. So a client's
// in-house counsel who is also a person client on their own matter is ONE
// `clients` row: edit their name/email/phone through the ordinary client
// update endpoint and every place they appear is correct too. Only the
// relationship fields (relationship label, primary/billing flags) belong to
// the link itself and are editable here.
//
// `id` on the wire is the LINK id (`client_company_links.id`), which is what
// the PUT/DELETE routes address. `personClientId` is the linked person's own
// `clients.id`, for a caller that wants to open/edit that record directly.

const COMPANY_LINK_SELECT_COLUMNS = {
  id: clientCompanyLinks.id,
  personClientId: clientCompanyLinks.personClientId,
  relationship: clientCompanyLinks.relationship,
  isPrimary: clientCompanyLinks.isPrimary,
  isEmailRecipient: clientCompanyLinks.isEmailRecipient,
  canViewBilling: clientCompanyLinks.canViewBilling,
  createdBy: clientCompanyLinks.createdBy,
  createdAt: clientCompanyLinks.createdAt,
  updatedAt: clientCompanyLinks.updatedAt,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
  status: clients.status,
  userId: clients.userId,
  portalInvitePending: clients.portalInvitePending,
  invitedAt: clients.invitedAt,
  joinedAt: clients.joinedAt,
};

/** Shape a `client_company_links` row joined onto its linked person client for the API. */
function formatCompanyLink(r: any) {
  return {
    id: r.id,
    personClientId: r.personClientId,
    name: r.name,
    email: r.email,
    phone: r.phone,
    status: r.status,
    relationship: r.relationship,
    isPrimary: r.isPrimary,
    isEmailRecipient: Boolean(r.isEmailRecipient),
    canViewBilling: Boolean(r.canViewBilling),
    // The linked person's OWN portal identity/invite lifecycle (clients.user_id
    // etc.), not a per-link column - granting/revoking portal access for this
    // person happens through the ordinary client portal-invite flow, not here.
    userId: r.userId || null,
    portalInvitePending: Boolean(r.portalInvitePending),
    invitedAt: rowIso(r.invitedAt),
    joinedAt: rowIso(r.joinedAt),
    createdBy: r.createdBy,
    createdAt: rowIso(r.createdAt),
    updatedAt: rowIso(r.updatedAt),
  };
}

async function fetchCompanyLinkRow(lawFirmId: string, linkId: string) {
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select(COMPANY_LINK_SELECT_COLUMNS)
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, eq(clientCompanyLinks.id, linkId)))
    .limit(1));
  return rows[0] || null;
}

// ---- person contacts (contact_clients, unchanged) ----
//
// `client_company_links` only replaced the roster for a COMPANY client's
// people. A PERSON client's own related contacts (a guardian, an assistant)
// were never part of that decision and still work exactly as before: rows in
// the firm-wide `contacts` directory joined through `contact_clients`, not
// records of their own. `listClientContacts`/`createClientContact`/
// `updateClientContact`/`deleteClientContact` below dispatch to this section
// or the company-relationship section above based on the target client's
// own `clientType`.

/** Shape a `contact_clients` row joined onto its contact for the API. */
function formatPersonContact(r: any) {
  return {
    id: r.id,
    contactId: r.contact_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    title: r.title,
    organization: r.organization || null,
    relationship: r.relationship,
    notes: r.notes,
    isPrimary: r.is_primary,
    isEmailRecipient: Boolean(r.is_email_recipient),
    canViewBilling: Boolean(r.can_view_billing),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PERSON_CONTACT_SELECT = `
  select cc.id, cc.contact_id, cc.relationship, cc.is_primary, cc.created_by,
         cc.created_at, cc.updated_at,
         cc.is_email_recipient, cc.can_view_billing,
         c.name, c.email, c.phone, c.title, c.organization, c.notes
    from contact_clients cc
    join contacts c on c.id = cc.contact_id and c.law_firm_id = cc.law_firm_id`;

async function listPersonContacts(lawFirmId: string, clientId: string) {
  const { rows } = await tenantParameterizedQuery(contactClients, lawFirmId,
    `${PERSON_CONTACT_SELECT}
      where cc.law_firm_id = $1 and cc.client_id = $2
      order by cc.is_primary desc, c.name asc`,
    [lawFirmId, clientId],
    'cc',
  );
  return { contacts: rows.map(formatPersonContact) };
}

async function createPersonContact(lawFirmId: string, clientId: string, actingUserId: string, body: any) {
  return withTransactionEffects(async (transition) => {
    const { executor } = transition;
    let contactId = body.contactId || null;
    if (contactId) {
      const found = await contactsRepo.getContact(lawFirmId, contactId, executor);
      if (!found) throw new NotFoundError('Contact');
    } else {
      await assertFirmPermission(lawFirmId, actingUserId, 'contacts.manage');
      const { contact } = await contactsService.createContact({
        lawFirmId,
        userId: actingUserId,
        data: {
          name: body.name,
          email: body.email,
          phone: body.phone,
          title: body.title,
          notes: body.notes,
        },
      }, transition);
      contactId = contact.id;
    }

    const existing = await tenantQuery(contactClients, lawFirmId, ({ executor, scope }) => executor
      .select({ id: contactClients.id }).from(contactClients).where(and(
        scope, eq(contactClients.clientId, clientId), eq(contactClients.contactId, contactId),
      )).limit(1), executor);
    if (existing.length) throw new ConflictError('That contact is already on this client.');

    // Clearing the old primary and setting the new one has to be atomic: the
    // partial unique index on (firm, client) where is_primary rejects the pair
    // outright if the clear does not land first.
    if (body.isPrimary === true) {
      await scopedUpdate(contactClients, lawFirmId, eq(contactClients.clientId, clientId), { isPrimary: false }, executor);
    }
    const rows = await scopedInsert(contactClients, lawFirmId, {
      contactId,
      clientId,
      relationship: body.relationship || null,
      isPrimary: body.isPrimary === true,
      isEmailRecipient: body.isEmailRecipient === true,
      canViewBilling: body.canViewBilling === true,
      createdBy: actingUserId,
    }, executor);
    return { message: 'Client contact created', linkId: rows[0].id, contactId };
  });
}

async function updatePersonContact(lawFirmId: string, clientId: string, linkId: string, actingUserId: string, body: any) {
  return withTransactionEffects(async (transition) => {
    const { executor } = transition;
    // `contact_clients.id` is a uuid column, so a malformed link id reaches
    // Postgres as a cast error and surfaces as a 500. It can never name a real
    // link, so answer it the way a well-formed id for a link that does not exist
    // is answered.
    if (!isUuid(linkId)) throw new NotFoundError('Client contact');
    const linkRows = await tenantQuery(contactClients, lawFirmId, ({ executor, scope }) => executor
      .select({ contactId: contactClients.contactId }).from(contactClients).where(and(
        scope, eq(contactClients.clientId, clientId), eq(contactClients.id, linkId),
      )).limit(1), executor);
    if (!linkRows.length) throw new NotFoundError('Client contact');
    const { contactId } = linkRows[0];

    const contactPatch: Record<string, any> = {};
    if (typeof body.name !== 'undefined') contactPatch.name = body.name;
    if (typeof body.phone !== 'undefined') contactPatch.phone = body.phone;
    if (typeof body.title !== 'undefined') contactPatch.title = body.title;
    if (typeof body.notes !== 'undefined') contactPatch.notes = body.notes;

    // A bearer invitation (targeted or legacy) is addressed to the OLD email; if
    // it kept working after the contact's email changed, whoever holds the old
    // inbox could still accept it and claim this roster link. Look up the
    // pre-change email before writing the new one, and revoke the invite this
    // exact link targeted once the change is applied.
    let staleInviteEmail: string | null = null;
    if (typeof body.email !== 'undefined') {
      const newEmail = normalizeEmail(body.email);
      contactPatch.email = newEmail;
      const currentContact = await contactsRepo.getContact(lawFirmId, contactId, executor);
      const currentEmail = currentContact && currentContact.email ? normalizeEmail(currentContact.email) : null;
      if (currentEmail && currentEmail !== newEmail) staleInviteEmail = currentEmail;
    }

    if (Object.keys(contactPatch).length) {
      await assertFirmPermission(lawFirmId, actingUserId, 'contacts.manage');
      await contactsService.updateContact({
        lawFirmId, userId: actingUserId, contactId, data: contactPatch,
      }, transition);
    }

    if (staleInviteEmail) {
      const stalePending = await invitationsRepo.findByEmailTypeForTarget(
        lawFirmId, staleInviteEmail, 'client', { clientId, contactClientId: linkId }, executor,
      );
      // Only the retired roster-invite shape carries a `contact_client_id`, and
      // `acceptInviteByToken` refuses one outright, so this can find something
      // only in data that predates that cutover. Revoking it costs one statement
      // and closes the window a still-holdable link would otherwise leave open.
      if (stalePending) {
        await invitationsRepo.revokePendingById(lawFirmId, stalePending.id, 'client', executor);
      }
    }

    if (body.isPrimary === true) {
      await scopedUpdate(contactClients, lawFirmId, and(
        eq(contactClients.clientId, clientId), ne(contactClients.id, linkId),
      )!, { isPrimary: false }, executor);
    }
    const values: Record<string, unknown> = {};
    if (typeof body.relationship !== 'undefined') values.relationship = body.relationship;
    if (typeof body.isPrimary !== 'undefined') values.isPrimary = body.isPrimary === true;
    if (typeof body.isEmailRecipient !== 'undefined') values.isEmailRecipient = body.isEmailRecipient === true;
    if (typeof body.canViewBilling !== 'undefined') values.canViewBilling = body.canViewBilling === true;
    if (Object.keys(values).length) await scopedUpdate(contactClients, lawFirmId, and(
      eq(contactClients.clientId, clientId), eq(contactClients.id, linkId),
    )!, values, executor);

    return { message: 'Client contact updated' };
  });
}

async function deletePersonContact(lawFirmId: string, clientId: string, linkId: string) {
  // Same uuid guard as updatePersonContact: a malformed link id is a 404, not a
  // cast error on the way to the delete.
  if (!isUuid(linkId)) throw new NotFoundError('Client contact');
  const rows = await scopedDelete(contactClients, lawFirmId, and(
    eq(contactClients.clientId, clientId), eq(contactClients.id, linkId),
  )!);
  if (!rows.length) throw new NotFoundError('Client contact');
  // No portal identity to revoke. A contact on a person client's roster is a
  // `contacts` directory entry, not a portal user; the roster link stopped
  // carrying a `user_id` with migration 0261, and a company's people are
  // ordinary Person clients reached through `client_company_links`.
  return { message: 'Client contact removed' };
}

// ---- dispatchers: person contacts vs company relationships ----

export async function listClientContacts({ lawFirmId, clientId }: any) {
  const client = await getClientOrThrow(lawFirmId, clientId);
  if (client.clientType !== 'company') return listPersonContacts(lawFirmId, clientId);
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select(COMPANY_LINK_SELECT_COLUMNS)
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, eq(clientCompanyLinks.companyClientId, clientId)))
    .orderBy(desc(clientCompanyLinks.isPrimary), asc(clients.name)));
  return { contacts: rows.map(formatCompanyLink) };
}

/**
 * Link a person to a client. For a COMPANY client: reuse an existing Person
 * client by `personClientId`, or create a brand-new one from the identity
 * fields (via the ordinary `createClient`) and link that. For a PERSON
 * client: the unchanged `contact_clients` flow (a guardian/assistant from
 * the firm-wide contacts directory).
 */
export async function createClientContact({ lawFirmId, clientId, actingUserId, body }: any) {
  const company = await getClientOrThrow(lawFirmId, clientId);
  if (company.clientType !== 'company') return createPersonContact(lawFirmId, clientId, actingUserId, body);

  let personClientId = body.personClientId || null;
  if (personClientId) {
    const person = await clientsRepo.findByIdRaw(lawFirmId, personClientId);
    if (!person) throw new NotFoundError('Client');
    if (person.clientType !== 'person') {
      throw new ValidationError({ personClientId: ['Only a person client can be linked to a company.'] });
    }
  } else {
    const created = await createClient({
      lawFirmId,
      actingUserId,
      body: {
        clientType: 'person',
        name: body.name,
        email: body.email,
        phone: body.phone,
      },
    });
    personClientId = created.clientId;
  }

  const existing = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clientCompanyLinks.id }).from(clientCompanyLinks).where(and(
      scope, eq(clientCompanyLinks.companyClientId, clientId), eq(clientCompanyLinks.personClientId, personClientId),
    )).limit(1));
  if (existing.length) throw new ConflictError('That client is already linked to this company.');

  // Clearing the old primary and setting the new one has to be atomic: the
  // partial unique index on (firm, company) where is_primary rejects the pair
  // outright if the clear does not land first.
  const linkId = await withDrizzleTransaction(async (db: any) => {
    if (body.isPrimary === true) {
      await scopedUpdate(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.companyClientId, clientId), { isPrimary: false }, db);
    }
    const rows = await scopedInsert(clientCompanyLinks, lawFirmId, {
      personClientId,
      companyClientId: clientId,
      relationship: body.relationship || null,
      isPrimary: body.isPrimary === true,
      isEmailRecipient: body.isEmailRecipient === true,
      canViewBilling: body.canViewBilling === true,
      createdBy: actingUserId,
    }, db);
    return rows[0].id;
  });

  // The linked person may already hold portal access to another association;
  // if so, drop both their cached association list AND their cached access
  // context so the new organization shows up immediately instead of after the
  // TTL. Dropping only the association list would leave the access context
  // still serving the pre-link view for the rest of its own window.
  const personRow = await clientsRepo.findByIdRaw(lawFirmId, personClientId);
  if (personRow) invalidatePortalAccessContext(lawFirmId, personRow.userId);

  // Seat them on the company's canonical conversation, mirroring the removal
  // `deleteClientContact` already performs. Conversation membership is its own
  // table, not derived from `client_company_links`, so without this a person
  // linked after the thread existed never reached it. Best-effort: a messaging
  // failure must not fail the link that already committed.
  try {
    await messagingRepo.addPersonToCompanyConversation(
      lawFirmId,
      clientId,
      { userId: personRow ? personRow.userId : null, clientRecordId: personClientId },
      actingUserId,
    );
  } catch (err: any) {
    console.error('clients.service: company conversation sync on link failed:', err?.message || err);
  }

  const row = await fetchCompanyLinkRow(lawFirmId, linkId);
  return { message: 'Client relationship created successfully', linkId, relationship: row ? formatCompanyLink(row) : null };
}

/**
 * Edit a company relationship: `relationship` and the primary/billing flags
 * belong to the link. The linked person's own name/email/phone are edited
 * through the ordinary client update endpoint instead - they belong to that
 * person's `clients` row, not to this link.
 */
export async function updateClientContact({ lawFirmId, clientId, linkId, actingUserId, body }: any) {
  const company = await getClientOrThrow(lawFirmId, clientId);
  if (company.clientType !== 'company') return updatePersonContact(lawFirmId, clientId, linkId, actingUserId, body);
  // `client_company_links.id` is a uuid column: the company arm needs the same
  // guard the person arm has, or a malformed link id is a 500 here instead.
  if (!isUuid(linkId)) throw new NotFoundError('Client relationship');
  const linkRows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clientCompanyLinks.id, personClientId: clientCompanyLinks.personClientId }).from(clientCompanyLinks).where(and(
      scope, eq(clientCompanyLinks.companyClientId, clientId), eq(clientCompanyLinks.id, linkId),
    )).limit(1));
  if (!linkRows.length) throw new NotFoundError('Client relationship');
  const { personClientId } = linkRows[0];

  await withDrizzleTransaction(async (db: any) => {
    if (body.isPrimary === true) {
      await scopedUpdate(clientCompanyLinks, lawFirmId, and(
        eq(clientCompanyLinks.companyClientId, clientId), ne(clientCompanyLinks.id, linkId),
      )!, { isPrimary: false }, db);
    }
    const values: Record<string, unknown> = {};
    if (typeof body.relationship !== 'undefined') values.relationship = body.relationship;
    if (typeof body.isPrimary !== 'undefined') values.isPrimary = body.isPrimary === true;
    if (typeof body.isEmailRecipient !== 'undefined') values.isEmailRecipient = body.isEmailRecipient === true;
    if (typeof body.canViewBilling !== 'undefined') values.canViewBilling = body.canViewBilling === true;
    if (Object.keys(values).length) await scopedUpdate(clientCompanyLinks, lawFirmId, and(
      eq(clientCompanyLinks.companyClientId, clientId), eq(clientCompanyLinks.id, linkId),
    )!, values, db);
  });

  // Billing/portal-relevant link fields may have just changed (canViewBilling,
  // isEmailRecipient); drop this person's cached association list AND access
  // context, if they hold a portal uid, so a revoked `canViewBilling` cannot
  // keep authorizing billing reads for the rest of the cached context's window.
  const personRow = await clientsRepo.findByIdRaw(lawFirmId, personClientId);
  if (personRow) invalidatePortalAccessContext(lawFirmId, personRow.userId);

  const row = await fetchCompanyLinkRow(lawFirmId, linkId);
  return { message: 'Client relationship updated successfully', relationship: row ? formatCompanyLink(row) : null };
}

/**
 * Take a person off a company. The person's own `clients` row survives - they
 * may have their own matters, or be linked to another company.
 */
export async function deleteClientContact({ lawFirmId, clientId, linkId }: any) {
  const company = await getClientOrThrow(lawFirmId, clientId);
  if (company.clientType !== 'company') return deletePersonContact(lawFirmId, clientId, linkId);
  // Same uuid guard as the person arm above.
  if (!isUuid(linkId)) throw new NotFoundError('Client relationship');
  const rows = await scopedDelete(clientCompanyLinks, lawFirmId, and(
    eq(clientCompanyLinks.companyClientId, clientId), eq(clientCompanyLinks.id, linkId),
  )!);
  if (!rows.length) throw new NotFoundError('Client relationship');
  const personClientId = (rows[0] as any).personClientId || null;
  const personRow = personClientId ? await clientsRepo.findByIdRaw(lawFirmId, personClientId) : null;
  const removedUserId = personRow ? (personRow.userId || null) : null;
  // The link is gone: drop the cached portal-access context/association for
  // the removed person's portal uid, if they have one (no-ops otherwise), and
  // take them out of the company's canonical conversation. Conversation
  // membership (conversation_participants) is an independent table, not
  // derived from client_company_links, so it would otherwise survive this
  // delete and leave a removed person still able to read/send in the
  // company's thread.
  invalidatePortalAccessContext(lawFirmId, removedUserId);
  const conversationId = await messagingRepo.findCanonicalCompanyConversation(lawFirmId, clientId);
  if (conversationId) {
    if (removedUserId) await messagingRepo.removeParticipant(conversationId, removedUserId);
    // Someone with no portal account yet sits on the thread as a PENDING
    // recipient instead, which no participant removal reaches. Left behind, that
    // row outlives the link that justified it and seats them on the thread
    // anyway the day they register. Only this company's own thread: a group a
    // firm member added them to separately is not this link's to undo.
    else if (personClientId) {
      await messagingRepo.removePendingClientRecipient(lawFirmId, conversationId, personClientId);
    }
  }
  return { message: 'Client relationship removed successfully', linkId };
}

// ---- billing rates (stored as clients.billing_rates jsonb) ----

export async function getClientBillingRates({ lawFirmId, clientId }: any) {
  const client = await getClientOrThrow(lawFirmId, clientId);
  const br = client.billingRates && Object.keys(client.billingRates).length
    ? client.billingRates
    : { defaultRate: null, memberRates: {} };
  return { billingRates: br };
}

export async function updateClientBillingRates({ lawFirmId, clientId, body }: any) {
  await getClientOrThrow(lawFirmId, clientId);
  const patch: Record<string, any> = {};
  if (typeof body.defaultRate !== 'undefined') patch.defaultRate = body.defaultRate;
  if (typeof body.memberRates !== 'undefined') patch.memberRates = body.memberRates;
  await scopedUpdate(clients, lawFirmId, eq(clients.id, clientId), {
    billingRates: sql`${clients.billingRates} || ${JSON.stringify(patch)}::jsonb`,
  });
  return { message: 'Client billing rates updated successfully' };
}

// The three event handlers that used to live here are gone. They existed to keep
// denormalized copies of client data in step across matters and tasks, and the
// denormalization was removed: those surfaces JOIN now, `matter_clients` rows go
// with the matter through ON DELETE CASCADE, and `deleteClientCascade` already
// unwinds a client's links before it returns. Each handler had shrunk to an
// empty function that its listener still awaited on every delete.
//
// The database cascades they refer to are doing the work and must stay.
