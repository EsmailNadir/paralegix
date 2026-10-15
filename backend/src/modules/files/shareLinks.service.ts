const crypto = require('crypto');
const { admin } = require('../../shared/database/firebase');
const shareLinksRepo = require('./shareLinks.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { assertFileReadAccess } = require('./files.scope');
const filesRepo = require('./files.repository');
const { dispositionFor } = require('../../shared/utils/attachmentDisposition');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { MAX_SHARE_LINK_ITEMS } = require('./shareLinks.validation');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);

// A resolved link mints this short-lived GCS URL per access. The share link's own
// expiry (expires_at) is the durable control; this just bounds one download.
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const MAX_EXPIRES_HOURS = 24 * 365; // 1 year

function hashPassword(password: any) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: any, stored: any) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password || '', salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Read gate for a whole selection, before any link is written.
 *
 * Every item goes through the same `assertFileReadAccess` a single-file link
 * uses (matter ethical wall, task visibility, firm membership). The gate is a
 * property of the scope a row lives in, so it runs once per distinct matter,
 * task or firm scope rather than once per item. One refused item refuses the
 * whole selection: a link that silently dropped it would tell the sender it was
 * shared when it was not.
 */
/** The read gate a row sits behind: its matter, its task, or the firm. */
const readScopeKey = (row: any) => (row.matterId ? `m:${row.matterId}` : row.taskId ? `t:${row.taskId}` : 'firm');

async function assertSelectionReadable(lawFirmId: string, fileIds: string[], userId: string): Promise<any[]> {
  const rows = await filesRepo.findManyByIds(lawFirmId, fileIds);
  const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
  if (fileIds.some((id) => !byId.has(id))) throw new NotFoundError('File');

  const checked = new Set<string>();
  for (const row of rows as any[]) {
    const key = readScopeKey(row);
    if (checked.has(key)) continue;
    checked.add(key);
    // eslint-disable-next-line no-await-in-loop -- one check per scope, bounded by the selection cap
    await assertFileReadAccess(lawFirmId, row.id, userId);
  }
  return fileIds.map((id) => byId.get(id));
}

/**
 * Mint an expiring external share link. The acting user must be a firm member
 * AND have read access to every item (matter ethical wall / task visibility /
 * firm membership), so a member walled off from a matter can't leak its
 * documents. Optional password is scrypt-hashed; the plaintext is never stored.
 *
 * One document keeps the original single-file shape (`file_id`). Anything else,
 * a folder or several items, is a multi-item link whose selection is recorded
 * in `file_share_link_items`. A shared folder shares what is inside it when the
 * link is opened, the same way sharing a folder with the client portal does.
 */
export async function createShareLink({ lawFirmId, userId, fileId = null, fileIds = null, permission = 'download', expiresInHours = 168, password = null }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const hours = Number(expiresInHours);
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_EXPIRES_HOURS) {
    throw new ValidationError('Expiry must be between 1 hour and 1 year');
  }
  if (permission !== 'view' && permission !== 'download') {
    throw new ValidationError('Permission must be view or download');
  }

  const ids: string[] = [...new Set<string>(Array.isArray(fileIds) ? fileIds : [fileId].filter(Boolean))];
  if (ids.length === 0) throw new ValidationError('A file is required');
  if (ids.length > MAX_SHARE_LINK_ITEMS) {
    throw new ValidationError(`Select at most ${MAX_SHARE_LINK_ITEMS} items to share at once`);
  }
  const rows = await assertSelectionReadable(lawFirmId, ids, userId);

  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const token = crypto.randomBytes(24).toString('hex');
  const passwordHash = password ? hashPassword(String(password)) : null;
  const common = { token, permission, passwordHash, expiresAt, createdBy: userId };

  // The link records the name the recipient will see. It is a snapshot on
  // purpose: renaming the document later should not silently change what a
  // recipient was told they were sent.
  const single = rows.length === 1 && rows[0].kind === 'file' ? rows[0] : null;
  const link = single
    ? await shareLinksRepo.create(lawFirmId, {
      ...common,
      fileId: single.id,
      displayName: single.name || 'document',
      mimeType: single.mimeType || null,
    })
    : await shareLinksRepo.createMultiItem(lawFirmId, {
      ...common,
      fileIds: rows.map((r: any) => r.id),
      displayName: rows.length === 1 ? rows[0].name : `${rows.length} items`,
    });

  return {
    message: 'Share link created',
    link: { ...link, url: `${FRONTEND_URL}/share/${token}` },
  };
}

/**
 * Which of these rows the caller may read, without refusing on the ones they
 * may not. Answered once per read scope, as `assertSelectionReadable` does.
 */
async function readableRowIds(lawFirmId: string, rows: any[], userId: string): Promise<Set<string>> {
  const verdicts = new Map<string, boolean>();
  const readable = new Set<string>();
  for (const row of rows) {
    const key = readScopeKey(row);
    if (!verdicts.has(key)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one check per scope, bounded by the rows the links name
        await assertFileReadAccess(lawFirmId, row.id, userId);
        verdicts.set(key, true);
      } catch (err: any) {
        if (err?.statusCode !== 403 && err?.statusCode !== 404) throw err;
        verdicts.set(key, false);
      }
    }
    if (verdicts.get(key)) readable.add(row.id);
  }
  return readable;
}

/**
 * The live links on one item (`fileId`) or on any item of a selection
 * (`fileIds`), newest first.
 *
 * Each link says what it holds, because a link made from a selection reaches
 * more than the item the dialog was opened on: `items` names the ones the
 * caller may read, and `hiddenItemCount` counts the rest. A link can mix
 * matters, so a member walled off from one learns only that something else is
 * on the link, never its name.
 */
export async function listShareLinks({ lawFirmId, userId, fileId = null, fileIds = null }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ids: string[] = [...new Set<string>(Array.isArray(fileIds) ? fileIds : [fileId].filter(Boolean))];
  const selected = await assertSelectionReadable(lawFirmId, ids, userId);
  const links = await shareLinksRepo.listActiveForFiles(lawFirmId, selected.map((r: any) => r.id));

  const itemIdsByToken = await shareLinksRepo.listItemIdsForTokens(
    lawFirmId, links.filter((l: any) => l.isMultiItem).map((l: any) => l.token),
  );
  const itemIdsOf = (link: any): string[] => (link.isMultiItem
    ? itemIdsByToken.get(link.token) || []
    : [link.fileId].filter(Boolean));

  // A deleted item is gone from the link, not hidden on it.
  const rows = await filesRepo.findManyByIds(lawFirmId, [...new Set(links.flatMap(itemIdsOf))]);
  const rowById = new Map<string, any>(rows.map((r: any) => [r.id, r]));
  const readable = await readableRowIds(lawFirmId, rows, userId);

  return {
    links: links.map((link: any) => {
      const present = itemIdsOf(link).map((id) => rowById.get(id)).filter(Boolean);
      const visible = present
        .filter((row: any) => readable.has(row.id))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      return {
        ...link,
        url: `${FRONTEND_URL}/share/${link.token}`,
        items: visible.map((row: any) => ({ fileId: row.id, name: row.name, isFolder: row.kind === 'folder' })),
        hiddenItemCount: present.length - visible.length,
      };
    }),
  };
}

export async function revokeShareLink({ lawFirmId, userId, token }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ok = await shareLinksRepo.revoke(lawFirmId, token);
  if (!ok) throw new NotFoundError('Share link');
  return { message: 'Share link revoked', token };
}

// ── Public resolution (no auth; the token is the credential) ────────────────

/** Load a live link by token, throwing 404 (missing/revoked) or 410 (expired). */
async function loadLiveLink(token: any) {
  const row = await shareLinksRepo.getByToken(token);
  if (!row || row.revoked_at) throw new NotFoundError('Share link');
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new AppError('This share link has expired', 410, 'SHARE_LINK_EXPIRED');
  }
  return row;
}

/** Refuse a password-protected link unless the caller supplied its password. */
function assertPassword(row: any, password: any) {
  if (row.password_hash && !verifyPassword(password, row.password_hash)) {
    throw new AppError('Incorrect password', 401, 'SHARE_LINK_PASSWORD');
  }
}

/**
 * Public metadata for the landing page. Never exposes the object path, and for
 * a multi-item link never names what is inside it: this answers before the
 * password, so the list of items waits for `listPublicItems`.
 */
export async function getPublicMeta(token: any) {
  const row = await loadLiveLink(token);
  return {
    isMultiItem: !row.file_id,
    displayName: row.display_name || 'document',
    permission: row.permission || 'download',
    requiresPassword: !!row.password_hash,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    contentType: row.mime_type || null,
  };
}

/**
 * Where a row sits relative to a multi-item link, or null when the link does
 * not reach it.
 *
 * A row is reachable when it is one of the selected items, or when it is inside
 * a selected folder. Inside means the folder is an ancestor AND nothing on the
 * way down is deleted or belongs to a different task than the folder does: a
 * matter's browser hides a task's own documents, and a task may restrict who
 * sees it, so a folder link shares what the folder shows and no more.
 *
 * Returns the row, the selected item it was reached through, and the chain of
 * folders from that item down to the row's parent, for breadcrumbs.
 */
async function reachThroughLink(lawFirmId: string, itemIds: string[], targetId: any) {
  const target = await filesRepo.findById(lawFirmId, targetId);
  if (!target) return null;
  if (itemIds.includes(target.id)) return { row: target, via: target, between: [] as any[] };

  const chain = await filesRepo.ancestors(lawFirmId, target.id);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ancestor = chain[i];
    if (ancestor.deletedAt) return null;
    if (!itemIds.includes(ancestor.id)) continue;
    if (ancestor.kind !== 'folder') return null;
    const between = chain.slice(i + 1);
    const taskOf = (r: any) => r.taskId || null;
    if ([...between, target].some((r: any) => taskOf(r) !== taskOf(ancestor))) return null;
    return { row: target, via: ancestor, between };
  }
  return null;
}

/** What a recipient is shown for one row. Never the object path. */
function publicItem(row: any) {
  const isFolder = row.kind === 'folder';
  return {
    id: row.id,
    name: row.name,
    isFolder,
    sizeBytes: isFolder ? null : row.sizeBytes,
    contentType: isFolder ? null : row.mimeType || null,
  };
}

/** Folders first, then files, each by name. The order the file browser uses. */
function byFolderThenName(a: any, b: any) {
  if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
}

/** A file that has landed its bytes. An abandoned upload is not a document. */
const isServable = (row: any) => row.kind === 'folder' || !!row.finalizedAt;

/**
 * The items a recipient can see through a link: its selected items, or the
 * contents of one shared folder when `folderId` names one. Password-gated, so
 * the names of what was shared are never readable without it.
 */
export async function listPublicItems(token: any, { password, folderId = null }: any = {}) {
  const row = await loadLiveLink(token);
  assertPassword(row, password);

  if (row.file_id) {
    // A single-file link has one item and nothing to open.
    if (folderId) throw new NotFoundError('Folder');
    const file = await filesRepo.findById(row.law_firm_id, row.file_id);
    return { folder: null, path: [], items: file ? [publicItem(file)] : [] };
  }

  const itemIds = await shareLinksRepo.listItemIds(row.law_firm_id, token);

  if (!folderId) {
    const rows = await filesRepo.findManyByIds(row.law_firm_id, itemIds);
    return {
      folder: null,
      path: [],
      items: rows.filter(isServable).sort(byFolderThenName).map(publicItem),
    };
  }

  const reached = await reachThroughLink(row.law_firm_id, itemIds, folderId);
  if (!reached || reached.row.kind !== 'folder') throw new NotFoundError('Folder');
  const { folders, files } = await filesRepo.listChildren(row.law_firm_id, reached.row.id);
  const taskOf = (r: any) => r.taskId || null;
  const visible = [...folders, ...files].filter((r: any) => taskOf(r) === taskOf(reached.via));
  const trail = reached.via.id === reached.row.id
    ? [reached.row]
    : [reached.via, ...reached.between, reached.row];

  return {
    folder: { id: reached.row.id, name: reached.row.name },
    path: trail.map((r: any) => ({ id: r.id, name: r.name })),
    items: visible.map(publicItem),
  };
}

/**
 * Resolve a public download: validate the password (if any), mint a short-lived
 * signed URL with the disposition the link's permission dictates, record the
 * access, and return the URL for the caller to redirect to.
 *
 * A single-file link serves its own document and ignores any `fileId` the
 * caller names. A multi-item link needs one, and serves it only when the link
 * reaches it (see `reachThroughLink`).
 *
 * The file is confirmed to still be live before a URL is signed. A deleted
 * document keeps its row through the retention window, so the link has to check
 * the row rather than only its own revocation: the delete revokes as it goes,
 * and this is what answers correctly if that write did not land.
 */
export async function resolveDownload(token: any, password: any, fileId: any = null) {
  const row = await loadLiveLink(token);
  assertPassword(row, password);

  let file: any;
  let name: string;
  let contentType: string;
  if (row.file_id) {
    file = await filesRepo.findById(row.law_firm_id, row.file_id);
    if (!file) {
      throw new AppError('This file is no longer available', 410, 'SHARE_LINK_FILE_GONE');
    }
    name = row.display_name || 'document';
    contentType = row.mime_type || 'application/octet-stream';
  } else {
    if (!fileId) throw new ValidationError('Choose a file to download');
    const itemIds = await shareLinksRepo.listItemIds(row.law_firm_id, token);
    const reached = await reachThroughLink(row.law_firm_id, itemIds, fileId);
    if (!reached || reached.row.kind !== 'file' || !isServable(reached.row)) throw new NotFoundError('File');
    file = reached.row;
    name = file.name || 'document';
    contentType = file.mimeType || 'application/octet-stream';
  }

  // 'view' asks for inline where the type is safe (dispositionFor still forces a
  // download for active content); 'download' always forces an attachment.
  const responseDisposition = row.permission === 'view'
    ? dispositionFor(contentType, name)
    : `attachment; filename="${name.replace(/["\\]/g, '_')}"`;

  const [url] = await bucket.file(file.objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
    responseDisposition,
  });

  await shareLinksRepo.recordAccess(token).catch(() => {});
  return { url, contentType, displayName: name };
}
