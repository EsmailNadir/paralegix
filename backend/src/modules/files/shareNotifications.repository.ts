import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  max,
  min,
  sql,
} from 'drizzle-orm';
import {
  clientCompanyLinks,
  clients,
  fileClientAccess,
  files,
  lawFirms,
  matterClients,
  taskClients,
} from '../../shared/database/drizzle/schema';
import { firmQuery, systemQuery, tenantQuery } from '../../shared/database/queryContext';
import { scopedInsertManyOnConflictDoNothing, scopedUpsert } from '../../shared/database/scopedWrite';
import { runWithConcurrency } from '../../shared/utils/runWithConcurrency';
const { isUuid } = require('../../shared/utils/isUuid');

/**
 * Data access for the client "document shared" digest (see
 * shareNotifications.service.js). Resolves who a share reaches and manages the
 * `file_client_access` buffer that the debounce coalesces into digests.
 */

/**
 * Portal-enabled recipients linked to one company client: every
 * `client_company_links` row for the company, joined to its linked Person
 * `clients` row, minus anyone who muted `fileShared` in their own settings.
 * Same row shape as `mapClientRow` so callers can concatenate person and
 * company-linked rows without a branch - `flushClient` keys everything off
 * `userId`, so a company's several linked portal users each get their own
 * digest, same as any two unrelated person clients would.
 */
async function resolveCompanyRosterRecipients(lawFirmId: string, companyClientId: string) {
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({
      userId: clients.userId,
      isEmailRecipient: clientCompanyLinks.isEmailRecipient,
      settings: clients.settings,
      name: clients.name,
      email: clients.email,
    })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, eq(clientCompanyLinks.companyClientId, companyClientId), isNotNull(clients.userId))));
  return (rows as any[])
    .filter((r) => r.settings?.notifications?.fileShared !== false)
    .map((r) => ({ clientId: companyClientId, userId: r.userId, email: r.email || null, name: r.name || null, emailEnabled: r.isEmailRecipient === true }));
}

/**
 * Roster recipients for several company clients, in input order. At most three
 * roster reads run at once so a scope with many company clients cannot take the
 * shared pool; the first failure rejects, exactly as a `Promise.all` would.
 */
async function rosterRecipientsForCompanies(lawFirmId: string, companyClientIds: string[]) {
  const settled = await runWithConcurrency(
    companyClientIds.map((id) => () => resolveCompanyRosterRecipients(lawFirmId, id)),
    3,
  );
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof resolveCompanyRosterRecipients>>>).value);
}

/** Company client ids (clients.id) on a matter, for expanding each to its roster. */
async function companyClientIdsOnMatter(lawFirmId: string, matterId: string) {
  const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
    .select({ clientId: clients.id })
    .from(matterClients)
    .innerJoin(clients, and(eq(clients.lawFirmId, matterClients.lawFirmId), eq(clients.id, matterClients.clientId)))
    .where(and(scope, eq(matterClients.matterId, matterId), eq(clients.clientType, 'company'))));
  return (rows as any[]).map((r) => r.clientId);
}

/** Company client ids (clients.id) on a task, for expanding each to its roster. */
async function companyClientIdsOnTask(lawFirmId: string, taskId: string) {
  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({ clientId: clients.id })
    .from(clients)
    .innerJoin(taskClients, eq(taskClients.clientId, clients.id))
    .where(and(scope, eq(taskClients.taskId, taskId), eq(clients.clientType, 'company'))));
  return (rows as any[]).map((r) => r.clientId);
}

/**
 * Clients on a share scope that have someone to notify: a PERSON client with a
 * linked portal account (`clients.user_id`), or a COMPANY client's linked
 * people (`client_company_links` joined to their own `clients.user_id`). A
 * client/linked person without a portal account hasn't registered and can't
 * view the portal, so notifying them is pointless - they're excluded.
 * Returns `{ clientId, userId, email, name }` rows, one per recipient (a
 * company scope can return several rows for one `clientId`).
 */
export async function resolveScopeClients(lawFirmId: string, { scopeType, matterId, taskId, clientId }: any) {
  if (scopeType === 'matter') {
    if (!isUuid(matterId)) return [];
    const [personRows, companyClientIds] = await Promise.all([
      tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor.select({
        clientId: clients.id,
        userId: clients.userId,
        email: clients.email,
        name: clients.name,
      }).from(matterClients).innerJoin(clients, and(
        eq(clients.lawFirmId, matterClients.lawFirmId),
        eq(clients.id, matterClients.clientId),
      )).where(and(scope, eq(matterClients.matterId, matterId), isNotNull(clients.userId)))),
      companyClientIdsOnMatter(lawFirmId, matterId),
    ]);
    const companyRows = await rosterRecipientsForCompanies(lawFirmId, companyClientIds);
    return [...personRows.map(mapClientRow), ...companyRows.flat()];
  }
  if (scopeType === 'task') {
    if (!isUuid(taskId)) return [];
    const [personRows, companyClientIds] = await Promise.all([
      tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor.select({
        clientId: clients.id,
        userId: clients.userId,
        email: clients.email,
        name: clients.name,
      }).from(clients).innerJoin(taskClients, eq(taskClients.clientId, clients.id))
        .where(and(scope, eq(taskClients.taskId, taskId), isNotNull(clients.userId)))),
      companyClientIdsOnTask(lawFirmId, taskId),
    ]);
    const companyRows = await rosterRecipientsForCompanies(lawFirmId, companyClientIds);
    return [...personRows.map(mapClientRow), ...companyRows.flat()];
  }
  if (scopeType === 'client') {
    if (!isUuid(clientId)) return [];
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor.select({
      clientId: clients.id,
      userId: clients.userId,
      email: clients.email,
      name: clients.name,
      clientType: clients.clientType,
    }).from(clients).where(and(scope, eq(clients.id, clientId))));
    const row = rows[0] as any;
    if (!row) return [];
    if (row.clientType === 'company') return resolveCompanyRosterRecipients(lawFirmId, clientId);
    return row.userId ? [mapClientRow(row)] : [];
  }
  return [];
}

function mapClientRow(r: any) {
  return { clientId: r.clientId, userId: r.userId, email: r.email || null, name: r.name || null };
}

function pendingRow(r: any) {
  return {
    id: r.id,
    law_firm_id: r.lawFirmId,
    client_user_id: r.clientUserId,
    object_path: r.fileId,
    file_name: r.fileName,
    scope_type: r.scopeType,
    scope_id: r.scopeId,
    is_folder: r.isFolder,
    shared_by: r.sharedBy,
    created_at: r.createdAt,
    notified_at: r.notifiedAt,
  };
}

/**
 * Buffer a batch of shares (one row per client × object). Collapses on the
 * partial unique index so re-sharing the same object to the same client before a
 * flush doesn't stack duplicate rows.
 */
export interface PendingShareRow {
  clientUserId: string;
  fileId: string;
  fileName: string;
  scopeType: string;
  /** Stored only when it is a real uuid; anything else is written as null. */
  scopeId?: string | null;
  isFolder?: boolean;
  /**
   * The relationship-level email decision. Only ever false for a company-linked
   * person; a person client has no such flag and stays true.
   */
  emailEnabled?: boolean;
  sharedBy?: string | null;
}

export async function enqueuePending(lawFirmId: string, rows: PendingShareRow[], sharedAt = new Date()) {
  if (!rows || !rows.length) return;
  for (const r of rows) {
    await scopedUpsert(
      fileClientAccess,
      lawFirmId,
      {
        clientUserId: r.clientUserId,
        fileId: r.fileId,
        isFolder: !!r.isFolder,
        isEmailEnabled: r.emailEnabled !== false,
        sharedBy: r.sharedBy || null,
        notifiedAt: null,
        sharedAt,
      },
      [
        fileClientAccess.lawFirmId,
        fileClientAccess.clientUserId,
        fileClientAccess.fileId,
      ],
      {
        isFolder: !!r.isFolder,
        isEmailEnabled: r.emailEnabled !== false,
        sharedBy: r.sharedBy || null,
        // A replay must not reopen work already delivered for this share.
        notifiedAt: sql`case when ${fileClientAccess.sharedAt} < ${sharedAt}::timestamptz then null else ${fileClientAccess.notifiedAt} end`,
        sharedAt: sql`greatest(${fileClientAccess.sharedAt}, ${sharedAt}::timestamptz)`,
      },
    );
  }
}

/** Read pending shares while the caller holds the client's delivery lease. */
export async function claimPendingForClient(lawFirmId: string, clientUserId: string) {
  const claimed = await tenantQuery(fileClientAccess, lawFirmId, ({ executor, scope }) => executor
    .select({ row: fileClientAccess, sharedAt: sql<string>`${fileClientAccess.sharedAt}::text` }).from(fileClientAccess)
    .where(and(scope, eq(fileClientAccess.clientUserId, clientUserId), isNull(fileClientAccess.notifiedAt))));
  if (!claimed.length) return [];
  const ids = claimed.map((c) => c.row.fileId).filter(Boolean);
  const fileRows = await tenantQuery(files, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: files.id,
      name: files.name,
      objectPath: files.objectPath,
      matterId: files.matterId,
      taskId: files.taskId,
      clientId: files.clientId,
    })
    .from(files)
    .where(and(scope, inArray(files.id, ids as string[]))));
  const fileById = new Map(fileRows.map((f) => [f.id, f]));
  return claimed.map(({ row: r, sharedAt }) => {
    const f = r.fileId ? fileById.get(r.fileId) : null;
    const scopeType = f?.matterId ? 'matter' : (f?.taskId ? 'task' : (f?.clientId ? 'client' : null));
    const scopeId = f?.matterId || f?.taskId || f?.clientId || null;
    // The name comes from the row. A deleted file leaves the queued digest
    // entry pointing at nothing, which reads as "a document" rather than as a
    // fragment of a path.
    const fileName = f?.name || 'a document';
    return {
      id: r.id,
      law_firm_id: r.lawFirmId,
      client_user_id: r.clientUserId,
      file_id: r.fileId,
      object_path: f?.objectPath || r.fileId,
      shared_at: sharedAt,
      file_name: fileName,
      scope_type: scopeType,
      scope_id: scopeId,
      is_folder: r.isFolder,
      email_enabled: r.isEmailEnabled,
      shared_by: r.sharedBy,
      created_at: r.createdAt,
      notified_at: r.notifiedAt,
    };
  });
}

/** Acknowledge only the share versions included in the successfully sent digest. */
export async function markNotified(lawFirmId: string, rows: any[]) {
  if (!rows.length) return;
  await tenantQuery(fileClientAccess, lawFirmId, ({ executor, scope }) => executor
    .update(fileClientAccess).set({ notifiedAt: new Date() })
    .where(and(scope, isNull(fileClientAccess.notifiedAt), or(...rows.map((row) => and(
      eq(fileClientAccess.id, row.id), sql`${fileClientAccess.sharedAt} = ${row.shared_at}::timestamptz`,
    ))))));
}

/**
 * Clients that still have unsent pending rows, with the age of their oldest one.
 * Used by the startup sweep to reschedule flushes after a restart.
 */
export async function listPendingClients() {
  const rows = await systemQuery('scheduler', (executor) => executor.select({
    lawFirmId: fileClientAccess.lawFirmId,
    clientUserId: fileClientAccess.clientUserId,
    oldest: min(fileClientAccess.sharedAt),
  }).from(fileClientAccess).where(isNull(fileClientAccess.notifiedAt))
    .groupBy(fileClientAccess.lawFirmId, fileClientAccess.clientUserId));
  return rows;
}

/**
 * Clients whose debounce window has expired without anything flushing it.
 *
 * The share digest is coalesced by an in-process `setTimeout`, which means the
 * pending rows belong to whichever instance happened to serve the share. If that
 * instance is scaled in or redeployed before the window elapses, which happens
 * on every deploy, the timer dies and the rows simply sit there until some
 * future cold boot notices them. At more than one instance there is a second
 * problem: one client's shares can land on different instances, and each flushes
 * its own partial digest, so the client gets N emails instead of one.
 *
 * This is the backstop for both. It groups by client and compares the NEWEST
 * unsent row against the debounce window, deliberately not the oldest: each new
 * share resets the timer, so the newest row is what the in-process debounce
 * would have been waiting on. A grace margin on top keeps the cron from racing a
 * timer that is about to fire on its own.
 *
 * Delivery leases serialize the cron and timer paths for each client.
 */
export async function listClientsWithExpiredDebounce(windowMs: any) {
  const seconds = Math.max(0, Number(windowMs) || 0) / 1000;
  return systemQuery('scheduler', (executor) => executor.select({
    lawFirmId: fileClientAccess.lawFirmId,
    clientUserId: fileClientAccess.clientUserId,
    newest: max(fileClientAccess.sharedAt),
  }).from(fileClientAccess).where(isNull(fileClientAccess.notifiedAt))
    .groupBy(fileClientAccess.lawFirmId, fileClientAccess.clientUserId)
    .having(sql`max(${fileClientAccess.sharedAt}) < now() - make_interval(secs => ${seconds}::float8)`));
}

/**
 * The digest's addressee name/email for one portal uid (for the digest). A
 * company-linked person is a real `clients` row now, same as any other
 * client, so this is the one lookup every portal uid resolves through - no
 * fallback to a directory row needed anymore.
 */
export async function getClientContact(lawFirmId: string, clientUserId: string) {
  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor.select({
    name: clients.name,
    email: clients.email,
  }).from(clients).where(and(scope, eq(clients.userId, clientUserId)))
    .orderBy(asc(clients.createdAt)).limit(1));
  return rows[0] ? { name: rows[0].name || null, email: rows[0].email || null } : null;
}

/** Firm display name for the digest subject/body. */
export async function getFirmName(lawFirmId: string) {
  const rows = await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
    .select({ name: lawFirms.name }).from(lawFirms).where(scope).limit(1));
  return (rows[0] && rows[0].name) || null;
}
