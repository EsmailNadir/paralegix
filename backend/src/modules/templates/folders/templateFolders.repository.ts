import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DrizzleRepository } from '../../../shared/database/DrizzleRepository';
import { templateFolders, templates } from '../../../shared/database/drizzle/schema';
import {
  tenantQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from '../../../shared/database/queryContext';
import { scopedDelete, scopedUpdate } from '../../../shared/database/scopedWrite';

class TemplateFoldersRepository extends DrizzleRepository {
  constructor() {
    super(templateFolders as any, { aliases: { order: 'sortOrder' } });
  }

  async listByLawFirm(lawFirmId: string) {
    const rows = await tenantQuery(
      templateFolders,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(templateFolders)
        .where(scope)
        .orderBy(asc(templateFolders.sortOrder), asc(templateFolders.name)),
    );
    return rows.map((row) => this.toEntity(row));
  }

  async findByName(lawFirmId: string, name: string) {
    const rows = await tenantQuery(
      templateFolders,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(templateFolders)
        .where(and(scope, eq(templateFolders.name, name)))
        .limit(1),
    );
    return this.toEntity(rows[0]);
  }

  /** Delete a folder and reparent its templates and child folders atomically. */
  async deleteWithReparent(
    lawFirmId: string,
    folderId: string,
    destinationParentFolderId: string | null,
    childOrderStart: number,
    executor?: DrizzleExecutor,
  ) {
    return withDrizzleTransaction(async (transaction) => {
      const movedTemplates = await scopedUpdate(
        templates,
        lawFirmId,
        eq(templates.folderId, folderId),
        { folderId: destinationParentFolderId },
        transaction,
      );

      const children = await tenantQuery(
        templateFolders,
        lawFirmId,
        ({ executor, scope }) => executor
          .select({ id: templateFolders.id })
          .from(templateFolders)
          .where(and(scope, eq(templateFolders.parentFolderId, folderId)))
          .orderBy(asc(templateFolders.sortOrder), asc(templateFolders.name))
          .for('update'),
        transaction,
      );

      let reparentedFolders: unknown[] = [];
      if (children.length) {
        const branches = children.map((child, index) =>
          sql`when ${child.id}::uuid then ${childOrderStart + index}::integer`);
        const nextOrder = sql`case ${templateFolders.id} ${sql.join(branches, sql.raw(' '))} end`;
        reparentedFolders = await scopedUpdate(
          templateFolders,
          lawFirmId,
          inArray(templateFolders.id, children.map((child) => child.id)),
          { parentFolderId: destinationParentFolderId, sortOrder: nextOrder },
          transaction,
        );
      }

      await scopedDelete(templateFolders, lawFirmId, eq(templateFolders.id, folderId), transaction);
      return {
        movedTemplateCount: movedTemplates.length,
        reparentedFolderCount: reparentedFolders.length,
      };
    }, executor);
  }
}

export = new TemplateFoldersRepository();
