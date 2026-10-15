/**
 * What a note, a note reply or a task has attached, as rows rather than as a
 * copy of a file inside a jsonb array.
 *
 * Each of those three tables used to carry an `attachments jsonb` column
 * holding `{ id, name, size, type, objectPath }` per attachment. Every one of
 * those fields except `id` is a copy of a `files` row that already exists: the
 * upload route creates the file first and then wrote the copy alongside it. A
 * rename in the file browser changed one and not the other, and a deleted file
 * left the array pointing at bytes that were gone.
 *
 * The link is now a row in `attachments`, which is where the document-request
 * arm already kept them. Everything a reader displays is joined from `files` at
 * read time, so there is one name and one size.
 *
 * The API shape is unchanged: `attachmentsFor` returns exactly what the jsonb
 * array held, so `resignAttachments` still adds the `url` and the frontend sees
 * what it saw before.
 */

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { attachments, files } from '../database/drizzle/schema';
import { tenantQuery, withDrizzleTransaction } from '../database/queryContext';
import { scopedDelete, scopedInsertMany } from '../database/scopedWrite';

/** The three parents whose attachments this module owns. */
export type AttachmentParent = 'noteId' | 'noteReplyId' | 'taskId';

export interface AttachmentEntry {
  id: string;
  name: string;
  size: number;
  type: string;
  objectPath: string | null;
}

const { isUuid } = require('../utils/isUuid');

/**
 * A deleted file keeps its row so the trash can restore it, and its
 * `attachments` links keep pointing at it. A reader must not offer one: the
 * object behind it is on its way out, and a signed URL for it fails.
 */
const liveFile = () => isNull(files.deletedAt);

/**
 * Every parent's attachments in one query, keyed by the parent's id.
 *
 * Callers hand in a whole page of notes or tasks, so this is one round trip per
 * page rather than one per row.
 */
export async function attachmentsFor(
  lawFirmId: string,
  parent: AttachmentParent,
  parentIds: any[],
): Promise<Map<string, AttachmentEntry[]>> {
  const ids = [...new Set((parentIds || []).map(String).filter(isUuid))];
  const byParent = new Map<string, AttachmentEntry[]>();
  if (!lawFirmId || ids.length === 0) return byParent;

  const column: any = (attachments as any)[parent];
  const rows: any[] = await tenantQuery(attachments, lawFirmId, ({ executor, scope }) => executor
    .select({
      parentId: column,
      id: files.id,
      name: files.name,
      size: files.sizeBytes,
      type: files.mimeType,
      objectPath: files.objectPath,
    })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .where(and(scope, inArray(column, ids), liveFile()))
    // `sort_order` is the record's own order, written by `setAttachments`.
    // `created_at` cannot order these: it defaults to now(), the TRANSACTION
    // timestamp, so every row one save writes carries the same value. It is
    // kept as the tiebreak for a row that predates the column.
    .orderBy(asc(attachments.sortOrder), asc(attachments.createdAt)));

  for (const r of rows) {
    const key = String(r.parentId);
    const list = byParent.get(key) || [];
    list.push({
      id: r.id,
      name: r.name,
      size: Number(r.size) || 0,
      type: r.type || 'application/octet-stream',
      objectPath: r.objectPath || null,
    });
    byParent.set(key, list);
  }
  return byParent;
}

/** One parent's attachments. A convenience over `attachmentsFor`. */
export async function attachmentsForOne(
  lawFirmId: string,
  parent: AttachmentParent,
  parentId: any,
): Promise<AttachmentEntry[]> {
  const byParent = await attachmentsFor(lawFirmId, parent, [parentId]);
  return byParent.get(String(parentId)) || [];
}

/**
 * Give each item in a page its `attachments` array.
 *
 * Mutates and returns the list, the same contract `resignAttachmentsOn` has, so
 * a read path adds one `await` rather than restructuring.
 */
export async function withAttachments<T extends { id: any }>(
  lawFirmId: string,
  parent: AttachmentParent,
  items: T[],
): Promise<T[]> {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return list;
  const byParent = await attachmentsFor(lawFirmId, parent, list.map((i) => i.id));
  for (const item of list) {
    (item as any).attachments = byParent.get(String(item.id)) || [];
  }
  return list;
}

/**
 * Refuse attachments that name a file the author could not open directly.
 *
 * The file's own read gate applies (`assertFileRowsReadable`): a matter's file
 * carries the matter's wall, a task's file the task's and a client's file the
 * client's matter wall, so naming one on a note or task would otherwise hand its
 * name (and a signed URL) to someone who cannot open it. Each distinct matter,
 * task or client is resolved once.
 *
 * Run BEFORE the caller's transaction opens: the membership checks take their
 * own pooled connection, and reaching for a second one while a transaction holds
 * the first is how a busy pool deadlocks. The user is required, so a write that
 * forgets its author cannot skip the check.
 */
export async function assertAttachmentsReadable(
  lawFirmId: string,
  entries: any,
  userId: string,
): Promise<void> {
  const asked = (Array.isArray(entries) ? entries : [])
    .map((e: any) => (e && typeof e === 'object'
      ? { id: String(e.id ?? e.fileId ?? ''), objectPath: String(e.objectPath ?? '') }
      : { id: '', objectPath: '' }))
    .filter((e) => isUuid(e.id) || e.objectPath);
  if (asked.length === 0) return;
  const byId = asked.map((e) => e.id).filter(isUuid);
  const byPath = asked.filter((e) => !isUuid(e.id)).map((e) => e.objectPath);
  const rows: any[] = await tenantQuery(files, lawFirmId, ({ executor, scope }) => executor
    .select({ matterId: files.matterId, taskId: files.taskId, clientId: files.clientId }).from(files)
    .where(and(scope, isNull(files.deletedAt), or(
      byId.length ? inArray(files.id, byId) : undefined,
      byPath.length ? inArray(files.objectPath, byPath) : undefined,
    ))));
  // Required here rather than at the top: the files module reaches the tasks
  // repository, which imports this one.
  const { assertFileRowsReadable } = require('../../modules/files/files.scope');
  await assertFileRowsReadable(lawFirmId, rows, userId);
}

/**
 * Make the parent's links exactly the given files, in the given order.
 *
 * Replace-set, like every other junction here: the caller sends the whole array
 * the editor is showing, so a removed attachment is an absent entry rather than
 * a separate delete call.
 *
 * The delete and the insert are ONE transaction. Without that, a failed insert
 * leaves the record with nothing attached, having already thrown away the links
 * it had. A caller already inside a transaction passes its executor and the two
 * statements join that one instead, so a failure here takes the parent's own
 * write with it.
 *
 * Entries name a file by `id`. Anything without a resolvable id is ignored
 * rather than written as a dangling link, since `file_id` is the whole point of
 * the row.
 */
export async function setAttachments(
  lawFirmId: string,
  parent: AttachmentParent,
  parentId: any,
  entries: any,
  { createdBy = null, executor }: { createdBy?: string | null; executor?: any } = {},
): Promise<void> {
  if (!lawFirmId || !isUuid(String(parentId))) return;
  if (executor) return replaceLinks(lawFirmId, parent, parentId, entries, createdBy, executor);
  return withDrizzleTransaction((tx: any) =>
    replaceLinks(lawFirmId, parent, parentId, entries, createdBy, tx));
}

async function replaceLinks(
  lawFirmId: string,
  parent: AttachmentParent,
  parentId: any,
  entries: any,
  createdBy: string | null,
  executor: any,
): Promise<void> {
  const column: any = (attachments as any)[parent];

  await scopedDelete(attachments, lawFirmId, eq(column, parentId), executor);

  // An entry names its file by id. A caller that predates the id carries only
  // the object path, which identifies the same row, so both are accepted.
  const asked = (Array.isArray(entries) ? entries : [])
    .map((e: any) => (e && typeof e === 'object'
      ? { id: String(e.id ?? e.fileId ?? ''), objectPath: String(e.objectPath ?? '') }
      : { id: '', objectPath: '' }))
    .filter((e) => isUuid(e.id) || e.objectPath);
  if (asked.length === 0) return;

  // Only files this firm actually has. A composite foreign key would reject a
  // stranger's id anyway, but as a constraint violation on the note's own save;
  // resolving first turns an id that names nothing into an absent attachment,
  // which is what it is.
  const byId = asked.map((e) => e.id).filter(isUuid);
  const byPath = asked.filter((e) => !isUuid(e.id)).map((e) => e.objectPath);
  // On the caller's executor, not the root one. Reaching for a second pooled
  // connection while a transaction holds the first is how a busy pool
  // deadlocks: every connection waiting on a connection.
  const live: any[] = await tenantQuery(files, lawFirmId, ({ executor: ex, scope }) => ex
    .select({ id: files.id, objectPath: files.objectPath }).from(files)
    .where(and(scope, isNull(files.deletedAt), or(
      byId.length ? inArray(files.id, byId) : undefined,
      byPath.length ? inArray(files.objectPath, byPath) : undefined,
    ))), executor);
  const idFor = (e: { id: string; objectPath: string }) => (isUuid(e.id)
    ? live.find((f: any) => String(f.id) === e.id)?.id
    : live.find((f: any) => f.objectPath === e.objectPath)?.id);

  // The caller's order is what the editor showed, so it is what is kept.
  // Duplicates collapse: one file attached twice in the editor is one link.
  const ordered: string[] = [];
  for (const entry of asked) {
    const id = idFor(entry);
    if (id && !ordered.includes(String(id))) ordered.push(String(id));
  }
  if (ordered.length === 0) return;

  // `sortOrder` is the array's index. It is what every read orders by, so the
  // order the editor showed is the order the record keeps.
  await scopedInsertMany(attachments, lawFirmId, ordered.map((fileId, position) => ({
    fileId,
    [parent]: parentId,
    sortOrder: position,
    createdBy,
  })) as any, executor);
}
