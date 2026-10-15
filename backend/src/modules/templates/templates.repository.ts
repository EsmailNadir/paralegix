import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { DrizzleRepository } from '../../shared/database/DrizzleRepository';
import { templates, templateFieldPlacements } from '../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../shared/database/queryContext';

class TemplatesRepository extends DrizzleRepository {
  constructor() {
    super(templates as any, {
      aliases: {
        htmlStoragePath: 'htmlObjectPath',
        docxStoragePath: 'docxObjectPath',
      },
    });
  }

  async listByLawFirm(lawFirmId: string) {
    const rows = await tenantQuery(
      templates,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          id: templates.id,
          lawFirmId: templates.lawFirmId,
          name: templates.name,
          type: templates.type,
          fields: templates.fields,
          repeaters: templates.repeaters,
          folderId: templates.folderId,
          htmlObjectPath: templates.htmlObjectPath,
          docxObjectPath: templates.docxObjectPath,
          createdAt: templates.createdAt,
          updatedAt: templates.updatedAt,
        })
        .from(templates)
        .where(scope)
        .orderBy(desc(templates.createdAt)),
    );
    return rows.map((row) => this.toEntity(row));
  }

  /**
   * Lock one template row for the rest of the caller's transaction. Used to
   * serialize writes that replace a template's child rows wholesale (the
   * overlay placement save), which READ COMMITTED alone does not.
   */
  async lockForUpdate(lawFirmId: string, templateId: string, executor: DrizzleExecutor) {
    const rows = await tenantQuery(
      templates,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select({ id: templates.id })
        .from(templates)
        .where(and(scope, eq(templates.id, templateId)))
        .for('update'),
      executor,
    );
    return rows[0] || null;
  }

  async listReferencedObjectPaths(lawFirmId: string) {
    const rows = await tenantQuery(
      templates,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          htmlObjectPath: templates.htmlObjectPath,
          docxObjectPath: templates.docxObjectPath,
          overlaySourceObjectPath: templates.overlaySourceObjectPath,
          overlayPdfObjectPath: templates.overlayPdfObjectPath,
          assets: templates.assets,
        })
        .from(templates)
        .where(scope),
    );
    const paths = new Set<string>();
    for (const row of rows) {
      if (row.htmlObjectPath) paths.add(row.htmlObjectPath);
      if (row.docxObjectPath) paths.add(row.docxObjectPath);
      if (row.overlaySourceObjectPath) paths.add(row.overlaySourceObjectPath);
      if (row.overlayPdfObjectPath) paths.add(row.overlayPdfObjectPath);
      const assets = Array.isArray(row.assets) ? row.assets : [];
      for (const asset of assets as any[]) {
        if (asset?.objectPath) paths.add(asset.objectPath);
      }
    }

    // Overlay 'image'-type placements stamp straight from their own object
    // path (never added to templates.assets), so it has to be pulled in
    // separately or the GC sweep below would treat every one of them as
    // orphaned the moment it runs.
    const imageRows = await tenantQuery(
      templateFieldPlacements,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ imageObjectPath: templateFieldPlacements.imageObjectPath })
        .from(templateFieldPlacements)
        .where(and(scope, isNotNull(templateFieldPlacements.imageObjectPath))),
    );
    for (const row of imageRows) {
      if (row.imageObjectPath) paths.add(row.imageObjectPath);
    }

    return paths;
  }
}

export = new TemplatesRepository();
