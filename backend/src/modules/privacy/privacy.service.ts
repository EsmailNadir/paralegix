import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  clientCompanyLinks,
  notes as notesTable,
  clients,
  contactClients,
  contacts as contactsDirectory,
  members,
} from '../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../shared/database/queryContext';
import { scopedDelete, scopedUpdate } from '../../shared/database/scopedWrite';
import { deleteAnalyticsPerson } from '../../shared/analytics/serverAnalytics';
const usersRepo = require('../users/users.repository');
const clientsRepo = require('../clients/clients.repository');
const filesRepo = require('../files/files.repository');
const { removeCascadeObjects } = require('../files/cascadeSweep');
const { trustTxnRepo } = require('../trust/trust.repository');
const messagingRepo = require('../messaging/messaging.repository');
const { auth } = require('../../shared/database/firebase');
const { deleteUserPhotoObjects } = require('../../shared/utils/userPhoto');
const { NotFoundError, ForbiddenError, ConflictError } = require('../../shared/errors/AppError');
const eventBus = require('../../shared/events/eventBus');
const { CLIENT_DELETED } = require('../../shared/events/eventTypes');
import { withLock, tryLock } from '../../shared/database/advisoryLock';

// Version stamped onto a recorded acceptance so a later policy change can be
// distinguished from an earlier one. Override via env when the policy changes.
const POLICY_VERSION = process.env.POLICY_VERSION || '1.0';

/** Remove the Firebase Auth identity, tolerating an already-absent account. */
async function deleteAuthIdentity(uid: string) {
  try {
    await auth.deleteUser(uid);
  } catch (err: any) {
    if (err && err.code === 'auth/user-not-found') return;
    console.error('privacy.service deleteAuthIdentity failed', { uid, message: err?.message });
    throw err;
  }
}

/**
 * Delete this uid's `client_company_links` rows - the relationships between
 * their own Person `clients` record(s) and any company they're linked to -
 * across every firm, dropping them from each affected company's canonical
 * conversation first. Only ever removes the RELATIONSHIP, never the person's
 * own `clients` row (their name/email/phone - firm-owned contact history) or
 * the company's own record; erasing the person's own identity goes through
 * `eraseClientPortalLinks`/`erasePersonalIdentity` like any other person
 * client. Never touches another person's link to the same or any other
 * company.
 *
 * Resolves the person's `clients.id` row(s) via `clients.user_id` while it is
 * still set, so this must run BEFORE `eraseClientPortalLinks` clears it (see
 * `erasePersonalIdentity`'s call order).
 */
async function eraseCompanyRosterAssociations(userId: string) {
  const personRows = await systemQuery('auth_identity', (executor) => executor
    .select({ id: clients.id, lawFirmId: clients.lawFirmId })
    .from(clients)
    .where(eq(clients.userId, userId)));
  if (!personRows.length) return;

  for (const person of personRows) {
    // eslint-disable-next-line no-await-in-loop
    const links = await tenantQuery(clientCompanyLinks, person.lawFirmId, ({ executor, scope }) => executor
      .select({ id: clientCompanyLinks.id, companyClientId: clientCompanyLinks.companyClientId })
      .from(clientCompanyLinks)
      .where(and(scope, eq(clientCompanyLinks.personClientId, person.id))));
    if (!links.length) continue;

    for (const link of links) {
      // eslint-disable-next-line no-await-in-loop
      const conversationId = await messagingRepo.findCanonicalCompanyConversation(person.lawFirmId, link.companyClientId);
      if (conversationId) {
        // eslint-disable-next-line no-await-in-loop
        await messagingRepo.removeParticipant(conversationId, userId);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await scopedDelete(clientCompanyLinks, person.lawFirmId, eq(clientCompanyLinks.personClientId, person.id));
  }
}

/**
 * Clear this uid's PORTAL association (`clients.user_id`) on every person-
 * client record it is directly linked to, across every firm. The person-
 * client row itself (name/email/phone/address - the firm's own contact
 * history about who their client is) is never touched or deleted here, only
 * the link that let this uid log in as that client. Mirrors
 * `eraseCompanyRosterAssociations` for the company arm; together the two
 * cover every association a uid can hold, per "process both arms for someone
 * who is a personal client and company contact."
 */
async function eraseClientPortalLinks(userId: string) {
  const rows = await systemQuery('auth_identity', (executor) => executor
    .select({ id: clients.id, lawFirmId: clients.lawFirmId })
    .from(clients)
    .where(eq(clients.userId, userId)));

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await scopedUpdate(clients, row.lawFirmId, eq(clients.id, row.id), {
      userId: null,
      portalInvitePending: false,
      joinedAt: null,
    });
  }
}

/**
 * Strip everything that identifies one person: the profile row's personal
 * fields, their stored profile picture, and the Firebase Auth identity. The
 * picture is part of the erasure, since leaving it in storage would keep
 * serving a recognizable face next to the "Deleted user" tombstone.
 *
 * This is AUTHENTICATION identity (the `users` row and the Firebase Auth
 * account) plus every portal-association surface that keys off it directly
 * (messaging participant snapshots, person-client links, company-link
 * relationships). It is distinct from FIRM CONTACT DATA (`clients` rows' own
 * name/email/phone, which are the firm's own record of who this person is
 * and survive this call untouched beyond losing the portal link) and from
 * ACCOUNTING RECORDS (invoices and their frozen billing snapshots, which this
 * function never reaches at all - see `eraseClient`'s billing-records guard
 * and the `billing_*` snapshot columns, migration 0171).
 */
async function erasePersonalIdentity(userId: string) {
  await usersRepo.anonymizeAccount(userId);
  // Messaging snapshots a sender's name onto every message it sends, and nothing
  // else reaches that copy, so without this the person stays identifiable in the
  // thread after the profile row has been anonymized.
  await messagingRepo.anonymizeParticipantIdentity(userId);
  // Both arms of client association this uid might hold. Company-link
  // relationships MUST be cleared first: it resolves the person's `clients`
  // row(s) via `clients.user_id`, which `eraseClientPortalLinks` (next) nulls
  // out - reversing this order would leave it nothing to resolve.
  await eraseCompanyRosterAssociations(userId);
  await eraseClientPortalLinks(userId);
  await deleteUserPhotoObjects(userId);
  await deleteAuthIdentity(userId);
  // Product analytics are keyed to the same uid, so they go with the identity.
  // Never throws: a PostHog outage must not fail an erasure that already ran.
  await deleteAnalyticsPerson(userId);
  await usersRepo.markIdentityErased(userId);
}

/**
 * Record that the calling user accepted the current terms and privacy policy.
 * Stores the policy version, server time, and source IP for accountability.
 */
export async function recordConsent({ userId, ip, version }: any) {
  const now = new Date().toISOString();
  await usersRepo.recordConsent(userId, {
    termsAcceptedAt: now,
    privacyAcceptedAt: now,
    consentVersion: version || POLICY_VERSION,
    consentIp: ip || null,
  });
  return { message: 'Consent recorded', consentVersion: version || POLICY_VERSION };
}

/**
 * Compile the personal data held about the calling user into a single
 * machine-readable object (GDPR Art. 15 access / Art. 20 portability).
 *
 * A uid can hold two independent kinds of client association (a person may be
 * both at once, e.g. the acceptance matrix's Jane): `personalClientRecords`
 * is this uid's own Person `clients` row(s) (`clients.user_id`), and
 * `companyAssociations` is each company that uid's own Person record is
 * linked to via `client_company_links` - the company itself is never this
 * uid's own record, only its relationship to it. The person's portal status
 * (invited/joined) is a single, per-person fact now (`personalClientRecords`
 * below), not a per-company one - a company link carries only the
 * relationship and billing flags, since the linked person's portal identity
 * is their own `clients` row's, shared across every company they're linked
 * to.
 */
export async function exportMyData({ userId }: any) {
  const user = await usersRepo.findByIdOrFail(userId);
  const [memberships, settings, clientRows] = await Promise.all([
    usersRepo.getMemberships(userId),
    usersRepo.getSettings(userId),
    systemQuery('auth_identity', (executor) => executor
      .select({
        id: clients.id,
        lawFirmId: clients.lawFirmId,
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
        portalInvitePending: clients.portalInvitePending,
        invitedAt: clients.invitedAt,
        joinedAt: clients.joinedAt,
        createdAt: clients.createdAt,
      })
      .from(clients)
      .where(eq(clients.userId, userId))),
  ]);

  const personClientIds = clientRows.map((r: any) => r.id);
  const companyLinkRows = personClientIds.length
    ? await systemQuery('auth_identity', (executor) => executor
      .select({
        linkId: clientCompanyLinks.id,
        personClientId: clientCompanyLinks.personClientId,
        clientId: clientCompanyLinks.companyClientId,
        lawFirmId: clientCompanyLinks.lawFirmId,
        companyName: clients.name,
        relationship: clientCompanyLinks.relationship,
        isPrimary: clientCompanyLinks.isPrimary,
        isEmailRecipient: clientCompanyLinks.isEmailRecipient,
        canViewBilling: clientCompanyLinks.canViewBilling,
        createdAt: clientCompanyLinks.createdAt,
      })
      .from(clientCompanyLinks)
      .innerJoin(clients, and(
        eq(clients.id, clientCompanyLinks.companyClientId),
        eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
      ))
      .where(inArray(clientCompanyLinks.personClientId, personClientIds)))
    : [];

  const iso = (v: any) => (v instanceof Date ? v.toISOString() : v);

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      userType: user.userType,
      termsAcceptedAt: user.termsAcceptedAt || null,
      privacyAcceptedAt: user.privacyAcceptedAt || null,
      consentVersion: user.consentVersion || null,
      consentIp: user.consentIp || null,
      createdAt: user.createdAt,
    },
    settings: settings || null,
    firmMemberships: memberships,
    // This uid's own Person client record(s), including its own portal status.
    personalClientRecords: clientRows.map((r: any) => ({
      id: r.id,
      lawFirmId: r.lawFirmId,
      name: r.name,
      email: r.email,
      phone: r.phone,
      portalStatus: r.joinedAt ? 'active' : (r.portalInvitePending ? 'pending' : 'none'),
      invitedAt: iso(r.invitedAt),
      joinedAt: iso(r.joinedAt),
      createdAt: iso(r.createdAt),
    })),
    // Every company this uid's own Person client record(s) are linked to.
    // Never the company's own legal identity - see clientId/companyName for
    // which company, and the relationship/billing flags for what this
    // specific association grants. Portal access itself is reported once,
    // per person, in personalClientRecords above.
    companyAssociations: companyLinkRows.map((r: any) => ({
      linkId: r.linkId,
      personClientId: r.personClientId,
      clientId: r.clientId,
      lawFirmId: r.lawFirmId,
      companyName: r.companyName,
      relationship: r.relationship,
      isPrimary: r.isPrimary === true,
      isEmailRecipient: r.isEmailRecipient === true,
      canViewBilling: r.canViewBilling === true,
      createdAt: iso(r.createdAt),
    })),
  };
}

/**
 * Erase the calling user's account (GDPR Art. 17). A firm owner must transfer or
 * delete the firms they own first (deleting the owner would orphan the firm).
 * Personal data is stripped and the Firebase Auth identity removed; the row is
 * kept as an anonymized tombstone so non-cascading references remain valid.
 *
 * Unlike `eraseClient` (firm-initiated, scoped to one client relationship,
 * conservative about leaving the account intact when it's still legitimately
 * used elsewhere), this is the person choosing to leave the platform
 * entirely, so it always erases the identity - but first cleans up both
 * arms of client association this uid might hold: a person-client record
 * (`eraseClientPortalLinks`, inside `erasePersonalIdentity`) and every company
 * roster link (`eraseCompanyRosterAssociations`, inside
 * `erasePersonalIdentity`), so neither is left dangling a portal identity
 * that no longer resolves to anyone.
 */
export async function eraseMyAccount({ userId, ip }: any) {
  const user = await usersRepo.findByIdOrFail(userId);
  if (user.identityErasedAt) {
    return { message: 'Your account and personal data have been erased.', erasureStatus: 'completed', erasedAt: user.identityErasedAt };
  }
  const memberships = await usersRepo.getMemberships(userId);
  const ownedFirms = memberships.filter((m: any) => m.isOwner);
  if (ownedFirms.length) {
    throw new ForbiddenError(
      'Transfer ownership or delete the firms you own before deleting your account.'
    );
  }

  return withLock('HOUSEKEEPING', `account-erasure:${userId}`, async () => {
    try {
      await erasePersonalIdentity(userId);
      return { message: 'Your account and personal data have been erased.', erasureStatus: 'completed', erasedAt: new Date().toISOString() };
    } catch (err) {
      const current = await usersRepo.findByIdOrFail(userId);
      if (!current.deletedAt) throw err;
      return { message: 'Your account is closed. Personal-data erasure is still being completed.', erasureStatus: 'pending' };
    }
  });
}

/** Retry tombstoned identities until all external and SQL cleanup completes. */
export async function recoverPendingAccountErasures() {
  const pending = await usersRepo.pendingIdentityErasures();
  let completed = 0;
  let failed = 0;
  for (const user of pending) {
    try {
      const outcome = await tryLock('HOUSEKEEPING', `account-erasure:${user.id}`, async () => {
        const current = await usersRepo.findByIdOrFail(user.id);
        if (current.identityErasedAt) return false;
        await erasePersonalIdentity(user.id);
        return true;
      });
      if (outcome.acquired && outcome.result) completed += 1;
    } catch (err) {
      failed += 1;
      console.error('privacy: pending identity erasure failed', { userId: user.id });
    }
  }
  return { completed, failed };
}

/**
 * Compile the personal data a firm holds about one client (so the firm can
 * fulfill a client's access/portability request).
 */
export async function exportClientData({ lawFirmId, clientId }: any) {
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  // A company client's people are real standalone Person `clients` rows,
  // linked through client_company_links. A person client's own related
  // contacts (a guardian, an assistant) are unchanged by that migration -
  // they're still `contact_clients` rows into the firm-wide contacts
  // directory (see clients.service.ts's person-contact dispatch for why).
  const contactsQuery = client.clientType === 'company'
    ? tenantQuery(
      clientCompanyLinks,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          id: clientCompanyLinks.id,
          relationship: clientCompanyLinks.relationship,
          is_primary: clientCompanyLinks.isPrimary,
          created_at: clientCompanyLinks.createdAt,
          updated_at: clientCompanyLinks.updatedAt,
          name: clients.name,
          email: clients.email,
          phone: clients.phone,
        })
        .from(clientCompanyLinks)
        .innerJoin(
          clients,
          and(
            eq(clients.id, clientCompanyLinks.personClientId),
            eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
          ),
        )
        .where(and(scope, eq(clientCompanyLinks.companyClientId, clientId))),
    )
    : tenantQuery(
      contactClients,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          id: contactClients.id,
          relationship: contactClients.relationship,
          is_primary: contactClients.isPrimary,
          created_at: contactClients.createdAt,
          updated_at: contactClients.updatedAt,
          name: contactsDirectory.name,
          email: contactsDirectory.email,
          phone: contactsDirectory.phone,
        })
        .from(contactClients)
        .innerJoin(
          contactsDirectory,
          and(
            eq(contactsDirectory.id, contactClients.contactId),
            eq(contactsDirectory.lawFirmId, contactClients.lawFirmId),
          ),
        )
        .where(and(scope, eq(contactClients.clientId, clientId))),
    );

  const [contacts, notes, matterIds] = await Promise.all([
    contactsQuery,
    tenantQuery(
      notesTable,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          id: notesTable.id,
          law_firm_id: notesTable.lawFirmId,
          client_id: notesTable.clientId,
          content: notesTable.content,
          created_by: notesTable.createdBy,
          edited_by: notesTable.editedBy,
          created_at: notesTable.createdAt,
          updated_at: notesTable.updatedAt,
        })
        .from(notesTable)
        .where(and(scope, eq(notesTable.clientId, clientId))),
    ),
    clientsRepo.listMatterIds(lawFirmId, clientId),
  ]);

  const iso = (v: any) => (v instanceof Date ? v.toISOString() : v);
  const shape = (r: any) => {
    const out: Record<string, any> = {};
    for (const k in r) out[k] = iso(r[k]);
    return out;
  };

  // Explicit allowlist rather than `shape(client)`. `clientsRepo.findByIdRaw`
  // returns every column on the `clients` row, and several of those are
  // internal plumbing rather than the client's own personal data: `userId` is
  // the Firebase Auth identity link (an authentication credential, not
  // something the export should hand back), `stripeCustomerId` is a payment
  // provider identifier, and
  // `invitedBy`/`billingRates`/`settings`/the invitation-bookkeeping columns
  // and the legal-hold columns are the firm's internal operational state
  // about the client rather than data about the client themself. A subject
  // access request should not leak any of it.
  const clientExport = {
    id: client.id,
    clientType: client.clientType,
    name: client.name,
    email: client.email,
    phone: client.phone,
    organization: client.organization,
    address: client.address,
    preferredContactMethod: client.preferredContactMethod,
    status: client.status,
    portalInvitePending: client.portalInvitePending,
    invitedAt: iso(client.invitedAt),
    joinedAt: iso(client.joinedAt),
    createdAt: iso(client.createdAt),
    updatedAt: iso(client.updatedAt),
  };

  return {
    exportedAt: new Date().toISOString(),
    client: clientExport,
    contacts: contacts.map(shape),
    notes: notes.map(shape),
    matterIds,
  };
}

/**
 * Permanently erase a client and their personal data (GDPR Art. 17, exercised by
 * the firm on the client's behalf). Blocked while the client is under legal hold.
 * If the client is linked to a portal user that has no other association anywhere
 * (no other person-client record, no firm membership, and no company roster
 * link), the portal user's personal data and Auth identity are erased too.
 *
 * Erasing a COMPANY client only ever removes ITS `client_company_links` rows
 * (`deleteClientCascade` deletes the links scoped to this `clientId` via the
 * table's `on delete cascade` FK); it never touches a linked person's own
 * `clients` record or their links to any OTHER company, which is firm-owned/
 * unrelated data this call has no business erasing.
 */
export async function eraseClient({ lawFirmId, clientId }: any) {
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');
  // The `clients_legal_hold_delete_guard` trigger refuses this too. This check
  // stays so the caller gets a 403 naming the reason instead of the 500 a raw
  // trigger error produces (migration 0221).
  if (await clientsRepo.hasLiveLegalHold(lawFirmId, clientId)) {
    throw new ForbiddenError('This client is under legal hold and cannot be erased.');
  }
  // Trust ledger entries are append-only and FK-reference the client; erasing a
  // client with trust activity would violate that FK. Block it so the erase
  // request fails cleanly rather than 500-ing mid-cascade.
  if (await trustTxnRepo.countByClientId(lawFirmId, clientId) > 0) {
    throw new ConflictError('This client has trust account activity and cannot be erased. Trust ledger entries are permanent.');
  }
  // Erasing cascades away the client's invoices (with payment history), time
  // entries, flat fees, and expenses. Block it so financial records aren't
  // silently destroyed by a GDPR erase.
  if (await clientsRepo.countBillingRecords(lawFirmId, clientId) > 0) {
    throw new ConflictError('This client has billing records (invoices, time entries, or expenses) and cannot be erased while they exist.');
  }
  // Same RESTRICT FK deleteClientCascade shares with removeClient (clients.
  // service.ts) - a live canonical company conversation must be archived
  // first, or this would 500 mid-cascade instead of failing cleanly. See that
  // guard's comment (migration 0172) for the full reasoning.
  if (await messagingRepo.findCanonicalCompanyConversation(lawFirmId, clientId)) {
    throw new ConflictError('This company has an active conversation and cannot be erased. Archive the conversation first.');
  }

  const linkedUserId = client.userId || null;
  const matterIds = await clientsRepo.listMatterIds(lawFirmId, clientId);

  // Company clients never carry their own userId (the invariant blocks it) -
  // the people linked to this company are their own standalone Person
  // `clients` rows, reached through the client_company_links rows being
  // cascade-deleted below, so collect their portal uids before the cascade
  // removes the links that name them. Mirrors removeClient's own collection
  // in clients.service.ts.
  const rosterUserIds = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: clients.userId })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, eq(clientCompanyLinks.companyClientId, clientId), isNotNull(clients.userId))))
    .then((rows: any[]) => rows.map((row) => row.userId));

  // The guard above proves no LIVE canonical conversation exists, so every row
  // this finds is already archived. Collect their ids before the cascade nulls
  // out client_record_id on them (deleteClientCascade) - it's the only way to
  // find them by this client afterward, for the attachment sweep below.
  const archivedConversationIds = await messagingRepo.listArchivedCompanyConversationIds(lawFirmId, clientId);

  // Snapshotted before the cascade, for the same reason as the ordinary client
  // delete: the file rows go with the client, and the stored objects and the
  // firm's storage figure would otherwise be left behind.
  const clientFiles = await filesRepo.scopeSnapshot(lawFirmId, { clientId });
  await clientsRepo.deleteClientCascade(lawFirmId, clientId);
  await removeCascadeObjects('CLIENT_DELETED', lawFirmId, clientFiles);

  // Reclaim the GCS attachments of any archived canonical conversation(s) this
  // erase leaves behind - see sweepArchivedCompanyConversationAttachments for
  // why nothing else in the app would ever reach them otherwise. Best-effort:
  // it never throws, so a storage hiccup can't undo the erase that already committed.
  if (archivedConversationIds.length) {
    await messagingRepo.sweepArchivedCompanyConversationAttachments(lawFirmId, archivedConversationIds);
  }

  // Converge with removeClient on one cleanup contract: both delete paths fire
  // the same event, with the same payload shape, in the same position relative
  // to the cascade (right after it - and its own attachment sweep - succeed).
  // Without this, an erasure left every CLIENT_DELETED listener's cleanup
  // undone for the GDPR path specifically: open document-request checklists
  // (documentRequests.events.ts), stale external-calendar entries for the
  // client's invoices (billing.events.ts, effectively a no-op here since the
  // billing-records guard above already proves there are none to purge), live
  // open signing session links (signatures.events.ts), and a person client's
  // direct-thread GCS attachments (files.events.ts). Every listener keys off
  // the ids captured above (clientId/userId/rosterUserIds), not off rows the
  // cascade or the portal-identity cleanup below might already have touched,
  // so firing here - before that conditional cleanup runs - is safe.
  await eventBus.emitAsync(CLIENT_DELETED, {
    lawFirmId, clientId, userId: linkedUserId, matterIds, rosterUserIds, files: clientFiles,
  });

  if (linkedUserId) {
    // The name and email messaging snapshotted onto this firm's thread are this
    // firm's copy of the client's personal data, so they go regardless of whether
    // the person is still a client elsewhere. Scoped to this firm for that reason.
    await messagingRepo.anonymizeParticipantIdentity(linkedUserId, { lawFirmId });

    // Only erase the portal identity (Firebase Auth account) if it is no
    // longer associated with anything else: no remaining person-client
    // record and no firm membership, ANYWHERE on the platform - not just this
    // firm. A company-linked person no longer needs its own third check here:
    // being linked to a company (client_company_links.person_client_id) IS
    // having a `clients` row with this uid on `user_id` (the migration off
    // `contact_clients` removed the separate roster identity space), so
    // `stillClient`'s unscoped search across every firm already catches that
    // case - missing it would let erasing one person-client relationship
    // delete an account still legitimately in use as a company-linked person
    // elsewhere (e.g. Pat, a portal user for two companies in the acceptance
    // matrix), which would silently break that unrelated association instead
    // of just removing this one.
    const [stillClient, stillMember] = await Promise.all([
      systemQuery('auth_identity', (executor) => executor
        .select({ found: clients.id })
        .from(clients)
        .where(eq(clients.userId, linkedUserId))
        .limit(1)),
      systemQuery('auth_identity', (executor) => executor
        .select({ found: members.userId })
        .from(members)
        .where(eq(members.userId, linkedUserId))
        .limit(1)),
    ]);
    if (!stillClient.length && !stillMember.length) {
      await erasePersonalIdentity(linkedUserId);
    }
  }

  return { message: 'Client and associated personal data have been erased.', clientId };
}
