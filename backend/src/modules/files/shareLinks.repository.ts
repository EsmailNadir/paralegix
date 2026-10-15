import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { fileShareLinkItems, fileShareLinks } from '../../shared/database/drizzle/schema';
import { tenantQuery, tokenQuery, withDrizzleTransaction } from '../../shared/database/queryContext';
import { scopedInsert, scopedInsertMany, scopedUpdate } from '../../shared/database/scopedWrite';

const { rowIso: iso } = require('../../shared/utils/dateConversion');

function linkEntity(r: any, { frontendUrl }: any = {}) {
  if (!r) return null;
  return {
    token: r.token,
    lawFirmId: r.lawFirmId,
    fileId: r.fileId,
    // A multi-item link names its contents in `file_share_link_items` and
    // points at no single document.
    isMultiItem: !r.fileId,
    displayName: r.displayName || '',
    mimeType: r.mimeType || null,
    permission: r.permission || 'download',
    hasPassword: !!r.passwordHash,
    expiresAt: iso(r.expiresAt),
    revoked: !!r.revokedAt,
    accessCount: typeof r.accessCount === 'number' ? r.accessCount : Number(r.accessCount) || 0,
    lastAccessedAt: iso(r.lastAccessedAt),
    createdBy: r.createdBy || null,
    createdAt: iso(r.createdAt),
    url: frontendUrl ? `${frontendUrl}/share/${r.token}` : undefined,
  };
}

class ShareLinksRepository {
  async create(lawFirmId: string, { token, fileId, displayName, mimeType, permission, passwordHash, expiresAt, createdBy }: any) {
    const rows = await scopedInsert(fileShareLinks, lawFirmId, {
      token,
      fileId,
      displayName,
      mimeType: mimeType || null,
      permission,
      passwordHash: passwordHash || null,
      expiresAt: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
      createdBy: createdBy || null,
    });
    return linkEntity(rows[0]);
  }

  /**
   * A link to several files and folders: the link row and one item row per
   * selected id, in one transaction. A link whose items did not land would
   * resolve to nothing, so the two are written together or not at all.
   */
  async createMultiItem(lawFirmId: string, { token, fileIds, displayName, permission, passwordHash, expiresAt, createdBy }: any) {
    return withDrizzleTransaction(async (tx) => {
      const rows = await scopedInsert(fileShareLinks, lawFirmId, {
        token,
        fileId: null,
        displayName,
        mimeType: null,
        permission,
        passwordHash: passwordHash || null,
        expiresAt: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
        createdBy: createdBy || null,
      }, tx);
      await scopedInsertMany(fileShareLinkItems, lawFirmId,
        fileIds.map((fileId: string) => ({ token, fileId })), tx);
      return linkEntity(rows[0]);
    });
  }

  /** The ids each of these multi-item links names, keyed by token. */
  async listItemIdsForTokens(lawFirmId: string, tokens: string[]): Promise<Map<string, string[]>> {
    const byToken = new Map<string, string[]>();
    if (tokens.length === 0) return byToken;
    const rows = await tenantQuery(fileShareLinkItems, lawFirmId, ({ executor, scope }) => executor
      .select({ token: fileShareLinkItems.token, fileId: fileShareLinkItems.fileId }).from(fileShareLinkItems)
      .where(and(scope, inArray(fileShareLinkItems.token, tokens))));
    for (const row of rows as any[]) {
      byToken.set(row.token, [...(byToken.get(row.token) || []), row.fileId]);
    }
    return byToken;
  }

  /** The ids a multi-item link names, in no particular order. */
  async listItemIds(lawFirmId: string, token: any): Promise<string[]> {
    const rows = await tenantQuery(fileShareLinkItems, lawFirmId, ({ executor, scope }) => executor
      .select({ fileId: fileShareLinkItems.fileId }).from(fileShareLinkItems)
      .where(and(scope, eq(fileShareLinkItems.token, token))));
    return rows.map((r: any) => r.fileId);
  }

  /**
   * Active (not revoked, not expired) links for any of these files, newest
   * first, each once: the links to one of those documents, and every
   * multi-item link that names one of them among its selected items.
   */
  async listActiveForFiles(lawFirmId: string, fileIds: string[]) {
    if (fileIds.length === 0) return [];
    const rows = await tenantQuery(fileShareLinks, lawFirmId, ({ executor, scope }) => executor
      .select().from(fileShareLinks).where(and(
        scope,
        or(
          inArray(fileShareLinks.fileId, fileIds),
          inArray(fileShareLinks.token, executor
            .select({ token: fileShareLinkItems.token }).from(fileShareLinkItems)
            .where(and(
              eq(fileShareLinkItems.lawFirmId, lawFirmId),
              inArray(fileShareLinkItems.fileId, fileIds),
            ))),
        ),
        isNull(fileShareLinks.revokedAt),
        gt(fileShareLinks.expiresAt, sql`now()`),
      )).orderBy(desc(fileShareLinks.createdAt)));
    return rows.map((r: any) => linkEntity(r));
  }

  async revoke(lawFirmId: string, token: any) {
    const rows = await scopedUpdate(fileShareLinks, lawFirmId, eq(fileShareLinks.token, token), { revokedAt: sql`now()` });
    return rows.length > 0;
  }

  /**
   * Revoke every live link pointing at any of these files. Called when they are
   * deleted, so the token stops resolving the moment the document is gone rather
   * than at its own expiry.
   *
   * There is no repointing counterpart any more. A link stores a file id, and a
   * rename or a move does not change one, so the link follows the document for
   * free. The two repoint helpers this replaces existed only because the link
   * stored a path that a rename invalidated.
   */
  async revokeForFiles(lawFirmId: string, fileIds: any[]) {
    const ids = (fileIds || []).filter(Boolean);
    if (!lawFirmId || ids.length === 0) return 0;
    const rows = await scopedUpdate(fileShareLinks, lawFirmId, and(
      inArray(fileShareLinks.fileId, ids),
      isNull(fileShareLinks.revokedAt),
    )!, { revokedAt: sql`now()` });
    return rows.length;
  }

  /** Public resolve: fetch a link by its token (the credential). Firm-agnostic. */
  async getByToken(token: any) {
    if (typeof token !== 'string' || !token) return null;
    const rows = await tokenQuery(token, (executor) => executor.select({
      token: fileShareLinks.token,
      law_firm_id: fileShareLinks.lawFirmId,
      file_id: fileShareLinks.fileId,
      display_name: fileShareLinks.displayName,
      mime_type: fileShareLinks.mimeType,
      permission: fileShareLinks.permission,
      password_hash: fileShareLinks.passwordHash,
      expires_at: fileShareLinks.expiresAt,
      revoked_at: fileShareLinks.revokedAt,
      access_count: fileShareLinks.accessCount,
      last_accessed_at: fileShareLinks.lastAccessedAt,
      created_by: fileShareLinks.createdBy,
      created_at: fileShareLinks.createdAt,
    }).from(fileShareLinks).where(eq(fileShareLinks.token, token)).limit(1));
    return rows[0] || null;
  }

  async recordAccess(token: any) {
    await tokenQuery(token, (executor) => executor.update(fileShareLinks).set({
      accessCount: sql`${fileShareLinks.accessCount} + 1`,
      lastAccessedAt: sql`now()`,
    }).where(eq(fileShareLinks.token, token)));
  }
}

export = Object.assign(new ShareLinksRepository(), { linkEntity });
