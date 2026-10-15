import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  billingPlans,
  clientCompanyLinks,
  events,
  noteReplies,
  notes,
  clients,
  contactClients,
  conversationParticipants,
  documentRequests,
  activities,
  invitations,
  invoices,
  leads,
  matterClients,
  taskClients,
  tasks,
  trustMinimumBalances,
  trustTransactions,
} from '../../shared/database/drizzle/schema';
import {
  privilegedParameterizedQuery,
  tenantQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsert,
  scopedInsertOnConflictDoNothing,
  scopedUpdate,
} from '../../shared/database/scopedWrite';
const { isUuid } = require('../../shared/utils/isUuid');
const { normalizeEmail } = require('../../shared/utils/normalizeEmail');
const { ConflictError } = require('../../shared/errors/AppError');

/**
 * Carry the placeholder's organization memberships onto the target.
 *
 * `client_company_links` is unique on (firm, person, company), so a company both
 * rows are already linked to cannot simply be repointed. Those links merge
 * instead: each flag is OR-ed onto the target's own link, because a permission
 * granted on either record was granted to this person, and the merge must not
 * take one away. Every other link moves across unchanged.
 *
 * `is_primary` is unique per COMPANY, not per person, so it can only collide on
 * a company both rows link to - exactly the merge branch, which writes the
 * target's existing row rather than inserting a second primary.
 */
async function moveCompanyLinks(
  executor: DrizzleExecutor,
  lawFirmId: string,
  targetId: string,
  placeholderId: string,
) {
  const links = await tenantQuery(
    clientCompanyLinks,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select()
      .from(clientCompanyLinks)
      .where(and(scope, inArray(clientCompanyLinks.personClientId, [targetId, placeholderId]))),
    executor,
  );
  const targetByCompany = new Map<string, any>();
  for (const link of links as any[]) {
    if (link.personClientId === targetId) targetByCompany.set(link.companyClientId, link);
  }

  for (const link of links as any[]) {
    if (link.personClientId !== placeholderId) continue;
    const existing = targetByCompany.get(link.companyClientId);
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await scopedUpdate(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.id, link.id), {
        personClientId: targetId,
      }, executor);
      continue;
    }
    // Clear the placeholder's primary flag FIRST.
    //
    // `client_company_links_one_primary_idx` is a partial unique index over
    // (law_firm_id, company_client_id) WHERE is_primary. Setting the survivor's
    // flag while the placeholder still holds it puts two primaries on the
    // organization for the length of one statement, and the index rejects it, so
    // merging an organization's primary contact failed outright. The placeholder's
    // links are deleted a few lines below, but not soon enough.
    // eslint-disable-next-line no-await-in-loop
    await scopedUpdate(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.id, link.id), {
      isPrimary: false,
    }, executor);
    // eslint-disable-next-line no-await-in-loop
    await scopedUpdate(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.id, existing.id), {
      isPrimary: Boolean(existing.isPrimary || link.isPrimary),
      isEmailRecipient: Boolean(existing.isEmailRecipient || link.isEmailRecipient),
      canViewBilling: Boolean(existing.canViewBilling || link.canViewBilling),
      relationship: existing.relationship || link.relationship || null,
    }, executor);
  }
  await scopedDelete(
    clientCompanyLinks,
    lawFirmId,
    eq(clientCompanyLinks.personClientId, placeholderId),
    executor,
  );
}

/**
 * Carry the placeholder's own related contacts (a guardian, an assistant) onto
 * the target. Unique on (firm, contact, client), so a contact already on the
 * target is dropped rather than duplicated, and the partial unique index
 * allowing one primary contact per client means a moved row can only keep
 * `is_primary` when the target has no primary of its own.
 */
async function moveRelatedContacts(
  executor: DrizzleExecutor,
  lawFirmId: string,
  targetId: string,
  placeholderId: string,
) {
  const rows = await tenantQuery(
    contactClients,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select()
      .from(contactClients)
      .where(and(scope, inArray(contactClients.clientId, [targetId, placeholderId]))),
    executor,
  );
  const targetContactIds = new Set(
    (rows as any[]).filter((row) => row.clientId === targetId).map((row) => row.contactId),
  );
  let targetHasPrimary = (rows as any[])
    .some((row) => row.clientId === targetId && row.isPrimary);

  for (const row of rows as any[]) {
    if (row.clientId !== placeholderId || targetContactIds.has(row.contactId)) continue;
    const keepPrimary = Boolean(row.isPrimary) && !targetHasPrimary;
    if (keepPrimary) targetHasPrimary = true;
    // eslint-disable-next-line no-await-in-loop
    await scopedUpdate(contactClients, lawFirmId, eq(contactClients.id, row.id), {
      clientId: targetId,
      isPrimary: keepPrimary,
    }, executor);
  }
  await scopedDelete(contactClients, lawFirmId, eq(contactClients.clientId, placeholderId), executor);
}

/**
 * Fold `placeholderId` into `targetId`: repoint everything that references it,
 * then hard-delete the placeholder row.
 *
 * EVERY reference has to move, because the delete is the end of the row. This
 * used to repoint only `matter_clients` and `invoices.client_context_id` and let
 * the rest go: fourteen tables cascade on `clients`, so a merge silently
 * destroyed the placeholder's notes, events, tasks, document requests, time
 * entries, flat fees, expenses, billing plans, trust minimums and organization
 * memberships, nulled the bill-to on its issued invoices, and hit a foreign-key
 * violation on `trust_transactions` (no ON DELETE action) that aborted the
 * caller's whole transaction.
 *
 * That was survivable while a placeholder was a thin stub written by the invite
 * flow. It is not now: adding someone to an organization creates a full Person
 * client with no `user_id`, which then collects real work for as long as it
 * takes anyone to invite them, and a second record for the same email is easy to
 * create because the roster-add path does no duplicate check. The merge fires on
 * ordinary portal sign-in through `selfHealPersonAssociation`, not only on
 * invite acceptance.
 *
 * Contract: `placeholderId` must be
 * a genuine placeholder for the SAME person as `targetId` - i.e. a client row
 * that has never been claimed by a Firebase identity of its own (`user_id is
 * null`), or is already claimed by the exact same uid as `targetId`. Anything
 * else is a distinct person's (or, once organization clients exist, a distinct
 * organization's) record that only happens to share this email, and merging it
 * would silently combine two identities' matter/invoice history while
 * destroying one of their client rows.
 *
 * Callers are expected to pre-filter to safe placeholders (see
 * `linkClientIdentityToFirm`); this check is a last-line-of-defense assertion,
 * not the primary guard, so a future/direct caller can't bypass it by skipping
 * the filter.
 */
async function mergePlaceholder(
  executor: DrizzleExecutor,
  lawFirmId: string,
  targetId: string,
  placeholderId: string,
) {
  const rows = await tenantQuery(
    clients,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select().from(clients)
      .where(and(scope, inArray(clients.id, [targetId, placeholderId])))
      .for('update'),
    executor,
  );
  const target = rows.find((row) => row.id === targetId);
  const placeholder = rows.find((row) => row.id === placeholderId);
  if (!target || !placeholder) return;

  if (placeholder.userId && placeholder.userId !== target.userId) {
    throw new ConflictError(
      `Refusing to merge client ${placeholderId}: already linked to a different account`,
    );
  }

  // A company row is never a placeholder for a person, however much its email
  // looks like one. `clients_company_no_user_id_check` forbids a company from
  // carrying `user_id`, so the unclaimed test above passes for EVERY company and
  // cannot catch this on its own. Without this check, a person registering with
  // an address that matches a company's contact email folds that company's
  // matters and invoices into themselves and hard-deletes the company row.
  if (placeholder.clientType === 'company' || target.clientType === 'company') {
    throw new ConflictError(
      `Refusing to merge client ${placeholderId}: organization records are not personal placeholders`,
    );
  }

  await scopedUpdate(clients, lawFirmId, eq(clients.id, targetId), {
    phone: target.phone ?? placeholder.phone,
    organization: target.organization ?? placeholder.organization,
    address: target.address ?? placeholder.address,
    preferredContactMethod: target.preferredContactMethod ?? placeholder.preferredContactMethod,
    email: target.email ?? placeholder.email,
    stripeCustomerId: target.stripeCustomerId ?? placeholder.stripeCustomerId,
    name: target.name || placeholder.name || target.name,
  }, executor);

  const links = await tenantQuery(
    matterClients,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select().from(matterClients)
      .where(and(scope, inArray(matterClients.clientId, [targetId, placeholderId])))
      .for('update'),
    executor,
  );
  const targetMatterIds = new Set(links
    .filter((link) => link.clientId === targetId)
    .map((link) => link.matterId));
  for (const link of links) {
    if (link.clientId !== placeholderId || targetMatterIds.has(link.matterId)) continue;
    // eslint-disable-next-line no-await-in-loop
    await scopedInsertOnConflictDoNothing(
      matterClients,
      lawFirmId,
      { matterId: link.matterId, clientId: targetId },
      [matterClients.matterId, matterClients.clientId],
      executor,
    );
  }
  await scopedDelete(matterClients, lawFirmId, eq(matterClients.clientId, placeholderId), executor);

  await moveCompanyLinks(executor, lawFirmId, targetId, placeholderId);
  await moveRelatedContacts(executor, lawFirmId, targetId, placeholderId);

  // Junctions whose primary key includes client_id: the target may already hold
  // the same row, so each is copied conflict-do-nothing and the originals are
  // dropped, the way matter_clients is handled above.
  // `task_clients` carries no `law_firm_id` of its own, so it is scoped through
  // the owning task the same way tasks.repository.ts scopes it.
  const taskLinks = await tenantQuery(
    tasks,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select({ taskId: taskClients.taskId })
      .from(taskClients)
      .innerJoin(tasks, eq(tasks.id, taskClients.taskId))
      .where(and(scope, eq(taskClients.clientId, placeholderId))),
    executor,
  );
  if (taskLinks.length) {
    // The task ids came out of the firm-scoped read above, so the values are
    // already proven to belong to this firm; the context is what keeps the write
    // on the audited path rather than reaching for the executor directly.
    await tenantQuery(
      tasks,
      lawFirmId,
      ({ executor: queryExecutor }) => queryExecutor.insert(taskClients)
        .values((taskLinks as { taskId: string }[]).map((link) => ({
          lawFirmId, taskId: link.taskId, clientId: targetId,
        })))
        .onConflictDoNothing(),
      executor,
    );
    await tenantQuery(
      tasks,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.delete(taskClients).where(and(
        eq(taskClients.clientId, placeholderId),
        inArray(taskClients.taskId, queryExecutor.select({ id: tasks.id }).from(tasks).where(scope)),
      )),
      executor,
    );
  }

  const pendingRecipients = await tenantQuery(
    conversationParticipants,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor
      .select({
        conversationId: conversationParticipants.conversationId,
        participantUserId: conversationParticipants.participantUserId,
        participantType: conversationParticipants.participantType,
        addedBy: conversationParticipants.addedBy,
        historyVisibleFrom: conversationParticipants.historyVisibleFrom,
      })
      .from(conversationParticipants)
      .where(and(scope, eq(conversationParticipants.clientId, placeholderId), isNull(conversationParticipants.participantUserId))),
    executor,
  );
  for (const row of pendingRecipients as any[]) {
    // eslint-disable-next-line no-await-in-loop
    await scopedInsertOnConflictDoNothing(
      conversationParticipants,
      lawFirmId,
      {
        conversationId: row.conversationId,
        clientId: targetId,
        participantUserId: null,
        participantType: row.participantType || 'client',
        addedBy: row.addedBy,
        historyVisibleFrom: row.historyVisibleFrom,
      },
      [conversationParticipants.conversationId, conversationParticipants.clientId],
      executor,
    );
  }
  await scopedDelete(
    conversationParticipants,
    lawFirmId,
    and(eq(conversationParticipants.clientId, placeholderId), isNull(conversationParticipants.participantUserId))!,
    executor,
  );

  const trustMinimums = await tenantQuery(
    trustMinimumBalances,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select()
      .from(trustMinimumBalances)
      .where(and(scope, eq(trustMinimumBalances.clientId, placeholderId))),
    executor,
  );
  for (const row of trustMinimums as any[]) {
    // eslint-disable-next-line no-await-in-loop
    await scopedInsertOnConflictDoNothing(
      trustMinimumBalances,
      lawFirmId,
      {
        clientId: targetId,
        trustAccountId: row.trustAccountId,
        minimumCents: row.minimumCents,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
      },
      [trustMinimumBalances.lawFirmId, trustMinimumBalances.clientId, trustMinimumBalances.trustAccountId],
      executor,
    );
  }
  await scopedDelete(
    trustMinimumBalances,
    lawFirmId,
    eq(trustMinimumBalances.clientId, placeholderId),
    executor,
  );

  // Plain repoints: nothing here is unique per client, so the whole set moves in
  // one statement each. `trust_transactions.client_id` is the one FK with no ON
  // DELETE action at all, so failing to move it does not lose the row - it makes
  // the delete below raise a foreign-key violation and abort the caller's
  // transaction, which for the portal self-heal path means the client cannot
  // sign in at all.
  // Replies are not repointed and do not need to be: a reply's parent is its
  // note, and the note above just moved. Migration 0207 dropped the copied
  // parent columns that this line used to maintain.
  await scopedUpdate(notes, lawFirmId, eq(notes.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(events, lawFirmId, eq(events.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(documentRequests, lawFirmId, eq(documentRequests.clientId, placeholderId), { clientId: targetId }, executor);
  // Time, expenses and flat fees are one table since migration 0232, so one
  // statement repoints all three kinds. The billed-source freeze lets a
  // `client_id`-only change through on purpose; see that trigger.
  await scopedUpdate(activities, lawFirmId, eq(activities.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(billingPlans, lawFirmId, eq(billingPlans.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(billingPlans, lawFirmId, eq(billingPlans.defaultClientId, placeholderId), { defaultClientId: targetId }, executor);
  // Trust history is repointed under an explicitly declared exemption.
  //
  // `trust_txn_immutable` freezes every field of a completed entry, attribution
  // included, so that a silent edit cannot hide misappropriation. Repointing
  // client_id here is not that: the two client rows are the same person by
  // construction (same email, one never claimed), so the money did not move
  // between people, only the record it hangs off did. The FK to clients(id) has
  // no delete action, so the placeholder cannot be removed until this runs.
  //
  // The setting names the exact pair being merged and is transaction-local, so
  // the permission cannot outlive this merge and cannot be used to move money
  // between two unrelated clients. Every other column stays frozen; see
  // migration 0183. Without the migration applied, the trigger ignores the
  // setting and still refuses, which is the safe order to deploy in.
  await privilegedParameterizedQuery(
    'client_merge_trust_remap',
    "select set_config('paralegix.trust_client_remap', $1, true)",
    [`${placeholderId}:${targetId}`],
    executor,
  );
  await scopedUpdate(trustTransactions, lawFirmId, eq(trustTransactions.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(invitations, lawFirmId, eq(invitations.clientId, placeholderId), { clientId: targetId }, executor);
  await scopedUpdate(leads, lawFirmId, eq(leads.convertedClientId, placeholderId), { convertedClientId: targetId }, executor);
  // Both invoice pointers: `client_context_id` owns a client-context invoice,
  // `client_id` is the bill-to on a matter invoice and would otherwise be set to
  // null by its FK, quietly detaching an issued bill from whoever owes it.
  await scopedUpdate(invoices, lawFirmId, eq(invoices.clientContextId, placeholderId), {
    clientContextId: targetId,
  }, executor);
  await scopedUpdate(invoices, lawFirmId, eq(invoices.clientId, placeholderId), {
    clientId: targetId,
  }, executor);

  // `conversations.client_record_id` needs no repoint: it names the COMPANY a
  // canonical thread belongs to, and the company check above already refused to
  // treat a company row as a placeholder, so it can never point here.
  await scopedDelete(clients, lawFirmId, eq(clients.id, placeholderId), executor);
}

/**
 * Resolve (and self-heal) a single Firebase identity's `clients` row for a
 * firm: find the row already linked to `userId`, or adopt/merge a matching
 * unclaimed placeholder row (created by email before the client ever signed
 * up), or create a fresh row.
 *
 * Restricted to person-shaped records on purpose: `userId` is always exactly
 * one Firebase uid, and every row this function adopts or merges must be
 * unclaimed by anyone else first. A `clients` row already linked to a
 * DIFFERENT uid is left completely untouched, even when it shares the same
 * email - that is a distinct person's (or, once organization clients exist,
 * a distinct organization's) identity, not a duplicate of this one, and this
 * helper must never repoint or delete someone else's record. Organization
 * acceptance (Phase 2/3) must not call this personal identity-linker.
 */
export async function linkClientIdentityToFirm({
  lawFirmId,
  userId,
  email,
  name = null,
  invitedBy = null,
  matterIds = [],
  client: externalExecutor = null,
}: any) {
  if (!lawFirmId || !userId) return null;
  const normalizedEmail = normalizeEmail(email);

  const result = await withDrizzleTransaction(async (executor) => {
    const linkedRows = await tenantQuery(
      clients,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select().from(clients)
        .where(and(scope, eq(clients.userId, userId)))
        .limit(1)
        .for('update'),
      executor,
    );
    const emailMatches = normalizedEmail
      ? await tenantQuery(
          clients,
          lawFirmId,
          ({ executor: queryExecutor, scope }) => queryExecutor.select().from(clients)
            .where(and(
              scope,
              eq(clients.email, normalizedEmail),
              // Person rows only. A company shares this email as its contact
              // address, not as an identity, and can never be adopted or merged
              // into a person (see mergePlaceholder). It is excluded here rather
              // than filtered later so it is never even considered: the
              // `user_id is null` placeholder test below is true for every
              // company, since the schema forbids a company from holding one.
              eq(clients.clientType, 'person'),
              or(isNull(clients.userId), ne(clients.userId, userId)),
            ))
            .orderBy(asc(clients.createdAt), asc(clients.id))
            .for('update'),
          executor,
        )
      : [];

    // Only a row nobody has claimed yet (`user_id is null`) is a genuine
    // placeholder for this same person and safe to adopt or merge. A row
    // already linked to a different uid merely shares this email and must be
    // left alone - refuse to combine it rather than silently repointing or
    // deleting someone else's client record.
    const placeholders = emailMatches.filter((row) => !row.userId);
    const conflicting = emailMatches.filter((row) => row.userId);
    if (conflicting.length) {
      console.warn(
        `clientIdentityLinking: refusing to merge ${conflicting.length} client record(s) `
        + `in firm ${lawFirmId} that share email but are already linked to a different account`,
      );
    }

    let targetId: string;
    if (linkedRows[0]) {
      targetId = linkedRows[0].id;
      await scopedUpdate(clients, lawFirmId, eq(clients.id, targetId), {
        name: linkedRows[0].name || name,
        status: linkedRows[0].status || 'active',
        portalInvitePending: false,
        joinedAt: linkedRows[0].joinedAt || sql`now()`,
      }, executor);
      for (const placeholder of placeholders) {
        // eslint-disable-next-line no-await-in-loop
        await mergePlaceholder(executor, lawFirmId, targetId, placeholder.id);
      }
    } else if (placeholders.length) {
      const primary = placeholders[0];
      targetId = primary.id;
      await scopedUpdate(clients, lawFirmId, eq(clients.id, targetId), {
        userId,
        name: name || primary.name,
        email: primary.email || normalizedEmail,
        status: primary.status || 'active',
        portalInvitePending: false,
        invitedBy: primary.invitedBy || invitedBy,
        joinedAt: primary.joinedAt || sql`now()`,
      }, executor);
      for (const placeholder of placeholders.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        await mergePlaceholder(executor, lawFirmId, targetId, placeholder.id);
      }
    } else {
      const inserted = await scopedInsert(clients, lawFirmId, {
        userId,
        email: normalizedEmail,
        name: name || normalizedEmail || 'Client',
        status: 'active',
        portalInvitePending: false,
        invitedBy,
        joinedAt: sql`now()` as any,
      }, executor);
      targetId = inserted[0].id;
    }

    for (const matterId of matterIds || []) {
      if (!isUuid(matterId)) continue;
      // eslint-disable-next-line no-await-in-loop
      await scopedInsertOnConflictDoNothing(
        matterClients,
        lawFirmId,
        { matterId, clientId: targetId },
        [matterClients.matterId, matterClients.clientId],
        executor,
      );
    }

    const finalRows = await tenantQuery(
      clients,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select({
        id: clients.id,
        userId: clients.userId,
        email: clients.email,
        name: clients.name,
        status: clients.status,
      }).from(clients).where(and(scope, eq(clients.id, targetId))).limit(1),
      executor,
    );
    return { clientRecord: finalRows[0] || null, matterIds: matterIds || [] };
  }, externalExecutor || undefined);

  // Invitation processing may supply its outer transaction, in which case the
  // caller reconciles after commit. Standalone portal/account linking reaches
  // this path directly, so promote pending message recipients immediately.
  if (!externalExecutor && result?.clientRecord?.id) {
    try {
      // eslint-disable-next-line global-require
      await require('../messaging/messaging.repository').reconcilePendingClientRecipients(
        lawFirmId, result.clientRecord.id, userId,
      );
    } catch (err: any) {
      console.error('clientIdentityLinking: pending message recipient reconciliation failed:', err);
    }
  }
  return result;
}

export { normalizeEmail };
