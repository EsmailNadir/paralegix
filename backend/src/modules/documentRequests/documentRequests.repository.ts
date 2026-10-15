import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  ne,
  sql,
} from 'drizzle-orm';
import { NotFoundError } from '../../shared/errors/AppError';
import { alias } from 'drizzle-orm/pg-core';
import {
  attachments,
  clientCompanyLinks,
  clients,
  documentRequestItems,
  documentRequests,
  files,
  matterClients,
  matterMembers,
  users,
} from '../../shared/database/drizzle/schema';
import { tenantQuery, withDrizzleTransaction, type DrizzleExecutor } from '../../shared/database/queryContext';

// The reads join `users` twice: once for the name of whoever uploaded the file
// and once for the account type of whoever attached it.
const attachedBy = alias(users, 'attachment_actor');
import {
  scopedDelete,
  scopedInsert,
  scopedInsertMany,
  scopedUpdate,
} from '../../shared/database/scopedWrite';
const { isUuid } = require('../../shared/utils/isUuid');
const { resolvePage } = require('../../shared/database/pagination');

const { rowIso: iso } = require('../../shared/utils/dateConversion');

/** Trim item inputs and drop any with a blank label; `description` normalizes to null. */
function cleanItemInputs(items: any): { label: string; description: string | null }[] {
  return (items || [])
    .map((item: any) => ({
      label: (item?.label || '').trim(),
      description: (item?.description || '').trim() || null,
    }))
    .filter((item: { label: string }) => item.label.length > 0);
}

function requestEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    lawFirmId: r.lawFirmId,
    matterId: r.matterId,
    clientId: r.clientId,
    title: r.title || '',
    note: r.note || '',
    status: r.status || 'open',
    dueDate: r.dueDate || null, // day-only 'YYYY-MM-DD'
    createdBy: r.createdBy || null,
    createdByName: r.createdByName || '',
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    items: [],
  };
}

function itemEntity(r: any) {
  return {
    id: r.id,
    requestId: r.requestId,
    label: r.label || '',
    description: r.description || '',
    status: r.status || 'pending',
    sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : Number(r.sortOrder) || 0,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    fulfillments: [],
  };
}

/**
 * Name and path come from the live `files` row rather than a copy, so a file
 * moved or renamed in the Files tab after it was attached still resolves.
 *
 * `attachedByFirm` answers "did the firm put this here, or did the client?".
 * Before migration 0236 that was implied by `fileId` being set, because only a
 * firm member's link carried one. Every attachment is keyed on a file now, so
 * the actor is recorded explicitly (`attachments.created_by`, migration 0242)
 * and their account type is the answer. Null created_by is unknown, and is
 * treated as not-the-firm so an old row stays removable by the client it
 * belongs to.
 */
function fulfillmentEntity(r: any) {
  return {
    id: r.id,
    itemId: r.itemId,
    objectPath: r.objectPath || '',
    fileName: r.fileName || '',
    fileId: r.fileId || null,
    uploadedBy: r.uploadedBy || null,
    uploadedByName: r.uploadedByName || '',
    uploadedAt: iso(r.uploadedAt),
    attachedBy: r.attachedBy || null,
    attachedByFirm: r.attachedByType === 'firm_member',
  };
}

const requestColumns = {
  id: documentRequests.id,
  lawFirmId: documentRequests.lawFirmId,
  matterId: documentRequests.matterId,
  clientId: documentRequests.clientId,
  title: documentRequests.title,
  note: documentRequests.note,
  status: documentRequests.status,
  dueDate: documentRequests.dueDate,
  createdBy: documentRequests.createdBy,
  createdAt: documentRequests.createdAt,
  updatedAt: documentRequests.updatedAt,
  createdByName: users.name,
};

class DocumentRequestsRepository {
  async withLockedRequest<TResult>(lawFirmId: string, requestId: string, work: (transaction: DrizzleExecutor) => Promise<TResult>) {
    return withDrizzleTransaction(async (transaction) => {
      const rows = await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
        .select({ id: documentRequests.id }).from(documentRequests)
        .where(and(scope, eq(documentRequests.id, requestId))).for('update'), transaction);
      if (!rows.length) throw new NotFoundError('Document request');
      return work(transaction);
    });
  }

  /**
   * Stitch items and their fulfillments onto a set of request rows in two extra
   * queries (avoids an N+1 across requests). Returns requests in the given order.
   */
  async hydrate(lawFirmId: string, requestRows: any, transactionExecutor?: DrizzleExecutor) {
    const requests = requestRows.map(requestEntity);
    if (!requests.length) return requests;
    const byId = new Map(requests.map((r: any) => [r.id, r]));
    const requestIds = requests.map((r: any) => r.id);

    const itemRows = await tenantQuery(documentRequestItems, lawFirmId, ({ executor, scope }) => executor
      .select().from(documentRequestItems).where(and(scope, inArray(documentRequestItems.requestId, requestIds)))
      .orderBy(asc(documentRequestItems.sortOrder), asc(documentRequestItems.createdAt)), transactionExecutor);
    const items: any[] = itemRows.map(itemEntity);
    const itemById = new Map<string, any>(items.map((i: any) => [i.id, i]));
    for (const item of items) (byId.get(item.requestId) as any)?.items.push(item);

    if (items.length) {
      const aRows = await tenantQuery(attachments, lawFirmId, ({ executor, scope }) => executor
        .select({
          id: attachments.id,
          itemId: attachments.documentRequestItemId,
          fileId: attachments.fileId,
          objectPath: files.objectPath,
          fileName: files.name,
          uploadedBy: files.uploadedBy,
          uploadedAt: attachments.createdAt,
          uploadedByName: users.name,
          attachedBy: attachments.createdBy,
          attachedByType: attachedBy.userType,
        }).from(attachments)
        .innerJoin(files, eq(files.id, attachments.fileId))
        .leftJoin(users, eq(users.id, files.uploadedBy))
        .leftJoin(attachedBy, eq(attachedBy.id, attachments.createdBy))
        .where(and(scope, inArray(attachments.documentRequestItemId, items.map((i: any) => i.id))))
        .orderBy(asc(attachments.createdAt)), transactionExecutor);
      for (const ar of aRows) itemById.get(ar.itemId!)?.fulfillments.push(fulfillmentEntity(ar));
    }
    return requests;
  }

  async getById(lawFirmId: string, requestId: string, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(requestId)) return null;
    const rows = await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
      .select(requestColumns).from(documentRequests).leftJoin(users, eq(users.id, documentRequests.createdBy))
      .where(and(scope, eq(documentRequests.id, requestId))).limit(1), transactionExecutor);
    if (!rows[0]) return null;
    const [hydrated] = await this.hydrate(lawFirmId, rows, transactionExecutor);
    return hydrated;
  }

  /**
   * One page of a matter's document requests, newest first.
   *
   * Requests are never pruned, so a long-running matter accumulates them for its
   * whole life. Omitting `limit` still returns every request, which keeps the
   * unwindowed contract for any caller that needs the whole set.
   */
  async listByMatter(lawFirmId: string, matterId: string, { page, limit, offset }: any = {}) {
    if (!isUuid(matterId)) return { requests: [], totalRequests: 0 };
    const paging = limit == null ? null : resolvePage({ limit, offset, page, fallbackLimit: 10, max: 200 });
    const rows = await tenantQuery<any[]>(documentRequests, lawFirmId, ({ executor, scope }) => {
      let query: any = executor.select({ ...requestColumns, totalCount: sql<number>`count(*) over()` })
        .from(documentRequests).leftJoin(users, eq(users.id, documentRequests.createdBy))
        .where(and(scope, eq(documentRequests.matterId, matterId)))
        .orderBy(desc(documentRequests.createdAt), desc(documentRequests.id));
      if (paging) query = query.limit(paging.limit).offset(paging.offset);
      return query;
    });
    let totalRequests = rows.length ? Number(rows[0].totalCount) : 0;
    if (!rows.length && paging?.offset) {
      const [total] = await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
        .select({ total: count() }).from(documentRequests)
        .where(and(scope, eq(documentRequests.matterId, matterId))));
      totalRequests = total?.total || 0;
    }
    return { requests: await this.hydrate(lawFirmId, rows), totalRequests };
  }

  /**
   * Requests addressed to a specific client (the portal read). Optionally scoped
   * to one matter. Only 'open' and 'completed' requests are surfaced to the
   * client; 'cancelled' ones are hidden.
   */
  async listForClient(lawFirmId: string, clientId: string, { matterId = null }: any = {}) {
    if (!isUuid(clientId)) return [];
    const filters = [eq(documentRequests.clientId, clientId), ne(documentRequests.status, 'cancelled')];
    if (matterId && isUuid(matterId)) filters.push(eq(documentRequests.matterId, matterId));
    const rows = await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
      .select(requestColumns).from(documentRequests).leftJoin(users, eq(users.id, documentRequests.createdBy))
      .where(and(scope, ...filters)).orderBy(desc(documentRequests.createdAt)));
    return this.hydrate(lawFirmId, rows);
  }

  /**
   * Create a request header plus its checklist items in one transaction.
   * `items` is an array of { label, description } (blank labels are dropped).
   */
  async create(lawFirmId: string, { matterId, clientId, title, note, dueDate, createdBy, items }: any) {
    const cleanItems = cleanItemInputs(items);
    const requestId = await withDrizzleTransaction(async (transaction) => {
      const [request] = await scopedInsert(documentRequests, lawFirmId, {
        matterId,
        clientId,
        title,
        note: note || null,
        dueDate: dueDate || null,
        createdBy: createdBy || null,
      }, transaction);
      await scopedInsertMany(documentRequestItems, lawFirmId, cleanItems.map((item, sortOrder: number) => ({
        requestId: request.id,
        label: item.label,
        description: item.description,
        sortOrder,
      })), transaction);
      return request.id;
    });
    return this.getById(lawFirmId, requestId);
  }

  async updateRequest(lawFirmId: string, requestId: string, fields: any, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(requestId)) return null;
    const values: Record<string, unknown> = {};
    for (const key of ['title', 'note', 'status', 'dueDate']) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) values[key] = fields[key] === undefined ? null : fields[key];
    }
    if (!Object.keys(values).length) return this.getById(lawFirmId, requestId, transactionExecutor);
    const rows = await scopedUpdate(documentRequests, lawFirmId, eq(documentRequests.id, requestId), values, transactionExecutor);
    return rows.length ? this.getById(lawFirmId, requestId, transactionExecutor) : null;
  }

  async deleteRequest(lawFirmId: string, requestId: string) {
    if (!isUuid(requestId)) return false;
    const rows = await scopedDelete(documentRequests, lawFirmId, eq(documentRequests.id, requestId));
    return rows.length > 0;
  }

  /** Drop every request addressed to one client (items cascade with the row). */
  async deleteByClientId(lawFirmId: string, clientId: string) {
    if (!isUuid(clientId)) return 0;
    const rows = await scopedDelete(documentRequests, lawFirmId, eq(documentRequests.clientId, clientId));
    return rows.length;
  }

  /** Append checklist items to an existing request, after its current max sort_order. */
  async addItems(lawFirmId: string, requestId: string, items: any, transactionExecutor?: DrizzleExecutor) {
    const clean = cleanItemInputs(items);
    if (!clean.length) return;
    await withDrizzleTransaction(async (transaction) => {
      // Serialize appends on the request header so concurrent appends cannot
      // calculate the same next sort order.
      await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
        .select({ id: documentRequests.id }).from(documentRequests)
        .where(and(scope, eq(documentRequests.id, requestId))).for('update'), transaction);
      const [row] = await tenantQuery(documentRequestItems, lawFirmId, ({ executor, scope }) => executor
        .select({ maxOrder: max(documentRequestItems.sortOrder) }).from(documentRequestItems)
        .where(and(scope, eq(documentRequestItems.requestId, requestId))), transaction);
      const next = Number(row?.maxOrder ?? -1) + 1;
      await scopedInsertMany(documentRequestItems, lawFirmId, clean.map((item, index: number) => ({
        requestId,
        label: item.label,
        description: item.description,
        sortOrder: next + index,
      })), transaction);
    }, transactionExecutor);
  }

  async getItem(lawFirmId: string, requestId: string, itemId: string, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(itemId) || !isUuid(requestId)) return null;
    const rows = await tenantQuery(documentRequestItems, lawFirmId, ({ executor, scope }) => executor
      .select().from(documentRequestItems).where(and(
        scope,
        eq(documentRequestItems.requestId, requestId),
        eq(documentRequestItems.id, itemId),
      )).limit(1), transactionExecutor);
    return rows[0] ? itemEntity(rows[0]) : null;
  }

  async setItemStatus(lawFirmId: string, itemId: string, status: any, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(itemId)) return false;
    const rows = await scopedUpdate(documentRequestItems, lawFirmId, eq(documentRequestItems.id, itemId), { status }, transactionExecutor);
    return rows.length > 0;
  }

  async removeItem(lawFirmId: string, requestId: string, itemId: string) {
    if (!isUuid(itemId) || !isUuid(requestId)) return false;
    const rows = await scopedDelete(documentRequestItems, lawFirmId, and(
      eq(documentRequestItems.requestId, requestId),
      eq(documentRequestItems.id, itemId),
    )!);
    return rows.length > 0;
  }

  /**
   * Record one or more uploaded files against an item in a single transaction,
   * flipping the item to 'received' once at the end. A client upload can submit
   * several files together; recording them one call at a time (its own
   * transaction each) let an error partway through leave earlier files
   * permanently committed while the request as a whole reported failure, a
   * silent partial write. Batching means the whole submission commits or none
   * of it does.
   */
  async recordFulfillments(lawFirmId: string, itemId: string, fileList: any[], transactionExecutor?: DrizzleExecutor) {
    if (!fileList.length) return;
    await withDrizzleTransaction(async (transaction) => {
      // The upload already created the `files` rows, so this only links them.
      // It used to create a row when it could not find one by path, which was
      // the mirror being best-effort: a file could reach the item without ever
      // having been recorded as the firm's.
      const existing = await tenantQuery(attachments, lawFirmId, ({ executor, scope }) => executor
        .select({ fileId: attachments.fileId }).from(attachments)
        .where(and(scope, eq(attachments.documentRequestItemId, itemId))), transaction);
      const linked = new Set(existing.map((row) => row.fileId));
      const fresh = fileList.filter((file) => {
        if (linked.has(file.fileId)) return false;
        linked.add(file.fileId);
        return true;
      });
      await scopedInsertMany(attachments, lawFirmId, fresh.map((f: any) => ({
        fileId: f.fileId,
        documentRequestItemId: itemId,
        createdBy: f.uploadedBy || null,
      })), transaction);

      await scopedUpdate(documentRequestItems, lawFirmId, eq(documentRequestItems.id, itemId), {
        status: 'received',
      }, transaction);
    }, transactionExecutor);
  }

  /**
   * A single fulfillment, with the live object_path/file_name from the files row.
   */
  async getFulfillment(lawFirmId: string, itemId: string, fulfillmentId: any) {
    if (!isUuid(itemId) || !isUuid(fulfillmentId)) return null;
    const rows = await tenantQuery(attachments, lawFirmId, ({ executor, scope }) => executor
      .select({
        id: attachments.id,
        itemId: attachments.documentRequestItemId,
        fileId: attachments.fileId,
        objectPath: files.objectPath,
        fileName: files.name,
        uploadedBy: files.uploadedBy,
        uploadedAt: attachments.createdAt,
        uploadedByName: users.name,
        attachedBy: attachments.createdBy,
        attachedByType: attachedBy.userType,
      }).from(attachments)
      .innerJoin(files, eq(files.id, attachments.fileId))
      .leftJoin(users, eq(users.id, files.uploadedBy))
      .leftJoin(attachedBy, eq(attachedBy.id, attachments.createdBy))
      .where(and(scope, eq(attachments.documentRequestItemId, itemId), eq(attachments.id, fulfillmentId)))
      .limit(1));
    return rows[0] ? fulfillmentEntity(rows[0]) : null;
  }

  /**
   * Remove one fulfillment (an uploaded or linked file) from an item. The
   * underlying file is untouched; the item's status is left as-is, since the
   * firm may have removed evidence while deliberately keeping the item
   * received/waived, or may want to flip status separately via the pills.
   */
  async removeFulfillment(lawFirmId: string, itemId: string, fulfillmentId: any, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(itemId) || !isUuid(fulfillmentId)) return false;
    const rows = await scopedDelete(attachments, lawFirmId, and(
      eq(attachments.documentRequestItemId, itemId),
      eq(attachments.id, fulfillmentId),
    )!, transactionExecutor);
    return rows.length > 0;
  }

  /** How many fulfillments an item still has, used to decide whether a delete emptied it out. */
  async countFulfillments(lawFirmId: string, itemId: string, transactionExecutor?: DrizzleExecutor) {
    if (!isUuid(itemId)) return 0;
    const [row] = await tenantQuery(attachments, lawFirmId, ({ executor, scope }) => executor
      .select({ total: count() }).from(attachments)
      .where(and(scope, eq(attachments.documentRequestItemId, itemId))), transactionExecutor);
    return row?.total ?? 0;
  }

  /**
   * Link an already-uploaded file (picked from the matter's Files tab) against
   * an item and flip the item to 'received', same as recordFulfillment.
   */
  async linkFile(lawFirmId: string, itemId: string, { fileId, linkedBy }: any, transactionExecutor?: DrizzleExecutor) {
    await withDrizzleTransaction(async (transaction) => {
      // A firm member linking a document they already have. The file is a row
      // in the tree, so there is nothing to create here.
      const resolvedFileId = fileId;
      await scopedInsert(attachments, lawFirmId, {
        fileId: resolvedFileId,
        documentRequestItemId: itemId,
        createdBy: linkedBy || null,
      }, transaction);
      await scopedUpdate(documentRequestItems, lawFirmId, eq(documentRequestItems.id, itemId), {
        status: 'received',
      }, transaction);
    }, transactionExecutor);
  }

  /**
   * Recompute a request's rollup status from its items: 'completed' when it has
   * items and none remain 'pending', otherwise 'open'. Never overrides a
   * 'cancelled' request. Returns the resulting status.
   */
  async recomputeStatus(lawFirmId: string, requestId: string, transactionExecutor?: DrizzleExecutor) {
    return withDrizzleTransaction(async (transaction) => {
      const rows = await tenantQuery(documentRequests, lawFirmId, ({ executor, scope }) => executor
        .select({ status: documentRequests.status }).from(documentRequests)
        .where(and(scope, eq(documentRequests.id, requestId))).limit(1).for('update'), transaction);
      if (!rows[0] || rows[0].status === 'cancelled') return rows[0]?.status || null;
      const [counts] = await tenantQuery(documentRequestItems, lawFirmId, ({ executor, scope }) => executor.select({
        total: count(),
        pending: sql<number>`count(*) filter (where ${documentRequestItems.status} = 'pending')::int`,
      }).from(documentRequestItems).where(and(scope, eq(documentRequestItems.requestId, requestId))), transaction);
      const next = counts.total > 0 && counts.pending === 0 ? 'completed' : 'open';
      await scopedUpdate(documentRequests, lawFirmId, eq(documentRequests.id, requestId), { status: next }, transaction);
      return next;
    }, transactionExecutor);
  }

  /**
   * Verify a client is linked to a matter and return their portal identity.
   * Returns { clientId, userId, name, email } or null when the client is not on
   * the matter.
   */
  async getClientOnMatter(lawFirmId: string, matterId: string, clientId: string) {
    if (!isUuid(matterId) || !isUuid(clientId)) return null;
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor.select({
      id: clients.id,
      userId: clients.userId,
      clientType: clients.clientType,
      name: clients.name,
      email: clients.email,
    }).from(clients).innerJoin(matterClients, and(
      eq(matterClients.lawFirmId, clients.lawFirmId),
      eq(matterClients.clientId, clients.id),
    )).where(and(scope, eq(matterClients.matterId, matterId), eq(clients.id, clientId))).limit(1));
    const r = rows[0];
    return r
      ? { clientId: r.id, userId: r.userId || null, clientType: r.clientType || 'person', name: r.name || '', email: r.email || null }
      : null;
  }

  /**
   * Portal-enabled linked contacts for a company client, with the fields the
   * document-request fan-out needs to bell AND email each one. Every
   * `client_company_links` row for this company, joined to its linked Person
   * `clients` row for the portal identity (`user_id`) and preferences
   * (`settings`, holding the same `notifications.<category>` shape the old
   * per-link `portal_settings` used) - the event handler applies the
   * `documentRequested` preference.
   */
  async getCompanyRosterContacts(lawFirmId: string, clientId: string) {
    if (!isUuid(clientId)) return [];
    const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor.select({
      userId: clients.userId,
      isEmailRecipient: clientCompanyLinks.isEmailRecipient,
      portalSettings: clients.settings,
      name: clients.name,
      email: clients.email,
    }).from(clientCompanyLinks).innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    )).where(and(scope, eq(clientCompanyLinks.companyClientId, clientId), isNotNull(clients.userId))));
    return rows.map((r: any) => ({
      userId: r.userId, isEmailRecipient: r.isEmailRecipient === true, name: r.name || '', email: r.email || null, portalSettings: r.portalSettings || {},
    }));
  }

  /**
   * One portal-enabled linked contact on a company client, by its exact
   * `client_company_links.id`, for the "notify one explicitly selected
   * contact" creation option. Returns null when the link doesn't belong to
   * this client/firm or its linked person has no portal user yet - a request
   * cannot be targeted at a contact with nobody to notify.
   */
  async getRosterContactById(lawFirmId: string, clientId: string, contactClientId: any) {
    if (!isUuid(clientId) || !isUuid(contactClientId)) return null;
    const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor.select({
      userId: clients.userId,
      isEmailRecipient: clientCompanyLinks.isEmailRecipient,
      portalSettings: clients.settings,
      name: clients.name,
      email: clients.email,
    }).from(clientCompanyLinks).innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    )).where(and(
      scope,
      eq(clientCompanyLinks.id, contactClientId),
      eq(clientCompanyLinks.companyClientId, clientId),
      isNotNull(clients.userId),
    )).limit(1));
    const r = rows[0];
    return r ? { userId: r.userId, isEmailRecipient: r.isEmailRecipient === true, name: r.name || '', email: r.email || null, portalSettings: r.portalSettings || {} } : null;
  }

  /** Firm-member user ids on a matter (recipients for client-upload notices). */
  async getMatterMemberIds(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return [];
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: matterMembers.userId }).from(matterMembers)
      .where(and(scope, eq(matterMembers.matterId, matterId))));
    return rows.map((r: any) => r.userId);
  }
}

export = new DocumentRequestsRepository();
