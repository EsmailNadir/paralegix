/**
 * Fixture builders shared by the files specs.
 *
 * Every spec here needs TWO firms at once (the whole point of a tenancy case is
 * that firm B's document really exists), so these take the firm explicitly.
 *
 * A file is a row plus an object; a folder is a row alone. The object sits at
 * `lawfirmids/{firm}/objects/{id}` and never moves, so a fixture states where a
 * file IS by naming its parent, not by building a path.
 *
 * These write rows through the repository and objects straight into the bucket
 * stub. The repository is the one piece a fixture may use, because a hand-rolled
 * insert would have to reproduce the naming and scope rules it enforces; no
 * fixture here calls a files ROUTE, since a fixture built by the code under test
 * cannot fail when that code is wrong. `uploadThroughRoutes` is the exception by
 * design: it is not a fixture but the upload itself, for specs whose subject is
 * what an upload does.
 */
import { randomBytes, randomUUID, scryptSync } from 'crypto';

import { putObject } from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { completeResumableUpload } from './richBucket';

export const BASE = 'lawfirmids';

const repo = require('../../src/modules/files/files.repository');

/** The scope root a file or folder hangs off. Creates it on first use. */
export const rootOf = (
  lawFirmId: string,
  scope: { matterId?: string; taskId?: string; clientId?: string } = {},
): Promise<string> => {
  if (scope.taskId) return repo.ensureScopeRoot(lawFirmId, { scope: 'task', taskId: scope.taskId });
  if (scope.matterId) return repo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId: scope.matterId });
  if (scope.clientId) return repo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId: scope.clientId });
  return repo.ensureScopeRoot(lawFirmId, { scope: 'firm' });
};

/** A matter, with `member` joined to it so the write gate lets them address it. */
export async function seedMatter(
  lawFirmId: string,
  memberUid: string | null,
  name: string,
): Promise<string> {
  const id = randomUUID();
  const created = await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(created.rowCount).toBe(1);
  if (memberUid) await joinMatter(lawFirmId, id, memberUid);
  return id;
}

export async function joinMatter(
  lawFirmId: string,
  matterId: string,
  uid: string,
): Promise<void> {
  const { rowCount } = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'member', now())`,
    [matterId, uid, lawFirmId],
  );
  expect(rowCount).toBe(1);
}

/** A task. `matterId: null` makes it standalone, which owns its own prefix. */
export async function seedTask(
  lawFirmId: string,
  opts: { matterId?: string | null; title?: string; attachedFileIds?: string[] } = {},
): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into tasks (id, law_firm_id, title, matter_id) values ($1, $2, $3, $4)`,
    [id, lawFirmId, opts.title ?? `Task ${id.slice(0, 8)}`, opts.matterId ?? null],
  );
  expect(rowCount).toBe(1);
  for (const fileId of opts.attachedFileIds ?? []) {
    // eslint-disable-next-line no-await-in-loop
    await attachFileToTask(lawFirmId, id, fileId);
  }
  return id;
}

export interface SeedFileOptions {
  parentId: string;
  name: string;
  bytes?: number;
  contentType?: string;
  taskId?: string | null;
  clientVisible?: boolean;
  /** Leave the row unfinalized, as an abandoned upload would. */
  finalized?: boolean;
}

/**
 * A file that has landed: a row and the bytes behind it.
 *
 * Both halves are needed. The row is what every listing, permission check and
 * rename reads, and the object is what a download streams, so a fixture with
 * only one of them cannot show the two staying in step.
 *
 * A file is not a document until `finalize` stamps it. Pass `finalized: false`
 * to seed an upload that was started and abandoned.
 */
export async function seedFile(
  lawFirmId: string,
  opts: SeedFileOptions,
): Promise<{ id: string; name: string; objectPath: string }> {
  const bytes = opts.bytes ?? 1024;
  const contentType = opts.contentType ?? 'application/pdf';
  const row = await repo.createFile(lawFirmId, {
    parentId: opts.parentId,
    name: opts.name,
    mimeType: contentType,
    uploadedBy: null,
  });
  putObject(row.objectPath, { bytes, contentType });
  if (opts.finalized !== false) {
    await repo.finalize(lawFirmId, row.id, { sizeBytes: bytes, mimeType: contentType });
  }
  if (opts.taskId) {
    await testPool.query('update files set task_id = $2 where id = $1', [row.id, opts.taskId]);
  }
  if (opts.clientVisible) {
    await repo.setVisibility(lawFirmId, row.id, { visible: true, clientIds: null });
  }
  return { id: row.id, name: row.name, objectPath: row.objectPath };
}

/** A folder row. There is no marker object: a folder is a row. */
export async function seedFolder(
  lawFirmId: string,
  opts: {
    parentId: string;
    name: string;
    color?: string | null;
    clientVisible?: boolean;
    visibleToClientIds?: string[] | null;
    taskId?: string | null;
  },
): Promise<{ id: string; name: string }> {
  const row = await repo.createFolder(lawFirmId, {
    parentId: opts.parentId,
    name: opts.name,
    createdBy: null,
    folderColor: opts.color ?? null,
  });
  if (opts.taskId) {
    await testPool.query('update files set task_id = $2 where id = $1', [row.id, opts.taskId]);
  }
  if (opts.clientVisible) {
    await repo.setVisibility(lawFirmId, row.id, {
      visible: true,
      clientIds: opts.visibleToClientIds ?? null,
    });
  }
  return { id: row.id, name: row.name };
}

/** One row by id, straight from the table. */
export async function fileRowById(lawFirmId: string, fileId: string) {
  const { rows } = await testPool.query(
    `select id, name, kind, parent_id, client_visible, folder_color, scope, size_bytes,
            task_id, client_id, matter_id, object_path, finalized_at, deleted_at
       from files where law_firm_id = $1 and id = $2`,
    [lawFirmId, fileId],
  );
  return rows[0];
}

/**
 * The slash-joined path of a row, for a readable assertion.
 *
 * Built from the ancestor chain rather than from the object name, because the
 * object name says nothing about where the file sits. This is what a breadcrumb
 * and a zip entry name are built from too.
 */
export async function pathOf(lawFirmId: string, fileId: string): Promise<string> {
  const chain = await repo.ancestors(lawFirmId, fileId);
  const row = await repo.findById(lawFirmId, fileId, { includeDeleted: true });
  return [...chain.slice(1).map((a: any) => a.name), row?.name].filter(Boolean).join('/');
}

/** Every live row under a folder, as `path` strings. Compare trees with this. */
export async function treeUnder(lawFirmId: string, folderId: string): Promise<string[]> {
  // Paged at the repository, so this walks pages. A helper that compares whole
  // trees has to cover every row; the pages are what keep it from holding them
  // all at once.
  const rows: any[] = [];
  for await (const page of repo.iterateSubtree(lawFirmId, folderId)) rows.push(...page);
  const paths = await Promise.all(rows.map((r: any) => pathOf(lawFirmId, r.id)));
  return paths.sort();
}

export async function storageUsedBytes(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select storage_used_bytes from law_firms where id = $1',
    [lawFirmId],
  );
  return Number(rows[0].storage_used_bytes || 0);
}

/**
 * The quota the firm's in-flight uploads are HOLDING: the sum of its live
 * `storage_reservations` rows.
 *
 * `upload-init` inserts one row per file and never touches
 * `storage_used_bytes`; finalize and cancel delete the rows, and an expired row
 * stops counting on its own. It must return to zero once an upload is done: a
 * row left standing holds quota the firm is not using until it lapses.
 */
export async function storageReservedBytes(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    `select coalesce(sum(bytes), 0)::bigint as held from storage_reservations
      where law_firm_id = $1 and expires_at > now()`,
    [lawFirmId],
  );
  return Number(rows[0].held || 0);
}

/** Every reservation row the firm has, live or lapsed. */
export async function storageReservationRows(
  lawFirmId: string,
): Promise<Array<{ id: string; created_by: string; bytes: number; is_live: boolean }>> {
  const { rows } = await testPool.query(
    `select id, created_by, bytes::bigint as bytes, expires_at > now() as is_live
       from storage_reservations where law_firm_id = $1 order by created_at, id`,
    [lawFirmId],
  );
  return rows.map((r: any) => ({ ...r, bytes: Number(r.bytes) }));
}

/**
 * A reservation held by `createdBy`, as another upload in flight would hold it.
 * A negative `expiresInMs` seeds one that has already lapsed.
 */
export async function seedReservation(
  lawFirmId: string,
  createdBy: string,
  bytes: number,
  { expiresInMs = 60 * 60 * 1000 }: { expiresInMs?: number } = {},
): Promise<string> {
  // A lapsed row still has to satisfy `expires_at > created_at`, so its
  // creation is backdated past its expiry.
  const createdAgoMs = expiresInMs > 0 ? 0 : -expiresInMs + 60 * 60 * 1000;
  const { rows } = await testPool.query(
    `insert into storage_reservations (law_firm_id, created_by, bytes, created_at, expires_at)
     values ($1, $2, $3,
             now() - ($5::bigint * interval '1 millisecond'),
             now() + ($4::bigint * interval '1 millisecond'))
     returning id`,
    [lawFirmId, createdBy, bytes, expiresInMs, createdAgoMs],
  );
  return rows[0].id;
}

export async function setStorageUsed(lawFirmId: string, bytes: number): Promise<void> {
  const { rowCount } = await testPool.query(
    'update law_firms set storage_used_bytes = $2 where id = $1',
    [lawFirmId, bytes],
  );
  expect(rowCount).toBe(1);
}

/**
 * What the task has attached, as the read paths see it.
 *
 * The link is an `attachments` row and the display fields come from the file,
 * so a deleted file drops out here rather than lingering as a stale copy.
 */
export async function taskAttachments(taskId: string): Promise<any[]> {
  const { rows } = await testPool.query(
    `select f.id, f.name, f.size_bytes as size
       from attachments a
       join files f on f.id = a.file_id
      where a.task_id = $1 and f.deleted_at is null
      order by a.created_at`,
    [taskId],
  );
  return rows;
}

/** Link an existing file to a task, the way the task's own save does. */
export async function attachFileToTask(lawFirmId: string, taskId: string, fileId: string) {
  await testPool.query(
    'insert into attachments (law_firm_id, file_id, task_id) values ($1, $2, $3)',
    [lawFirmId, fileId, taskId],
  );
}

/**
 * Another firm with an owner, a matter, and one landed document in that
 * matter's root: the far side of a tenancy case. The document is real so a
 * refusal to reach it has to come from the scope check, not a missing row.
 */
export async function rivalFirmWithDocument(opts: {
  firmName?: string;
  matterName?: string;
  fileName?: string;
  bytes?: number;
} = {}): Promise<{
  firm: Firm;
  owner: Actor;
  matterId: string;
  root: string;
  file: { id: string; name: string; objectPath: string };
}> {
  const firm = await createFirm({ name: opts.firmName ?? 'Rival LLP' });
  const owner = await ownerOf(firm.id);
  const matterId = await seedMatter(firm.id, owner.uid, opts.matterName ?? 'Vance v. Orrick');
  const root = await rootOf(firm.id, { matterId });
  const file = await seedFile(firm.id, {
    parentId: root, name: opts.fileName ?? 'Theirs.pdf', bytes: opts.bytes,
  });
  return { firm, owner, matterId, root, file };
}

/**
 * One upload as the product performs it: `upload-init` claims the rows and
 * reserves the declared bytes, the browser PUTs each file straight to storage,
 * and `upload-finalize` stamps the rows and charges what landed.
 *
 * `scope` goes to both requests (context, matterId, taskId, attachmentFolder),
 * because finalize re-resolves the scope init was given. Returns the finalize
 * response, or the init response when init refused, so a caller asserts on one
 * status either way. Needs the rich bucket (`installRichBucket`).
 */
export async function uploadThroughRoutes(
  actor: Actor,
  lawFirmId: string,
  scope: Record<string, unknown>,
  files: Array<{ name: string; size: number; contentType?: string }>,
) {
  const F = `/api/lawfirms/${lawFirmId}/files`;
  const opened = await actor.api.post(`${F}/upload-init`).send({ ...scope, files });
  if (opened.status !== 200) return opened;

  opened.body.uploads.forEach((upload: any, i: number) => {
    completeResumableUpload(upload.objectPath, { bytes: files[i].size });
  });

  return actor.api.post(`${F}/upload-finalize`).send({
    ...scope,
    // `declaredSize` is what finalize releases the reservation against. Without
    // it nothing is released, and the landed bytes are then added on top of a
    // reservation that already counted them, so the firm is charged twice.
    uploads: opened.body.uploads.map((u: any) => ({
      fileId: u.fileId,
      objectPath: u.objectPath,
      contentType: u.contentType,
      declaredSize: u.declaredSize,
      reservationId: u.reservationId,
    })),
  });
}

/**
 * Rows in `table` matching `where`, a fixed SQL predicate with `$n`
 * placeholders. The table name is interpolated, so pass only literals.
 */
export async function countRows(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as n from ${table} where ${where}`,
    params,
  );
  return rows[0].n;
}

/**
 * A share-link password in the stored format: `salt:scrypt(password, salt)`,
 * both hex, 64-byte key. Copied from the service rather than imported, so a
 * change to the hashing shape fails the share-link specs instead of both sides
 * agreeing on something wrong.
 */
export function hashSharePassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
