import { and, asc, eq } from 'drizzle-orm';
import { templateFieldPlacements } from '../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../shared/database/queryContext';
import { scopedDelete, scopedInsertMany } from '../../shared/database/scopedWrite';

// Field/repeater-column overlay boxes for a Document Overlay template. Always
// written as a full replace-set (delete-then-insert in one caller-supplied
// transaction), since the overlay editor always saves its whole current layout at
// once, the same junction-table convention used elsewhere (e.g. task_assignees).

// x/y/width/height percent columns are `numeric`, which Postgres (and Drizzle,
// absent an explicit `{ mode: 'number' }`) returns as a string to avoid
// precision loss. Cast on the way out, mirroring signature_fields'
// signatures.repository.ts.
function toEntity(row: Record<string, any>) {
  return {
    id: row.id,
    fieldName: row.fieldName,
    fieldType: row.fieldType || 'text',
    page: row.page,
    xPercent: Number(row.xPercent),
    yPercent: Number(row.yPercent),
    widthPercent: Number(row.widthPercent),
    heightPercent: Number(row.heightPercent),
    repeaterName: row.repeaterName ?? null,
    repeaterRowIndex: row.repeaterRowIndex ?? null,
    sortOrder: row.sortOrder ?? 0,
    textContent: row.textContent ?? null,
    imageObjectPath: row.imageObjectPath ?? null,
    imageMimeType: row.imageMimeType ?? null,
    fontSize: row.fontSize == null ? null : Number(row.fontSize),
    fontFamily: row.fontFamily || 'times',
    bold: Boolean(row.bold),
    italic: Boolean(row.italic),
    color: row.color || '#000000',
    textAlign: row.textAlign || 'left',
    bulletList: Boolean(row.bulletList),
    richText: row.richText ?? null,
  };
}

async function listByTemplate(lawFirmId: string, templateId: string, executor?: DrizzleExecutor) {
  const rows = await tenantQuery(
    templateFieldPlacements,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor
      .select()
      .from(templateFieldPlacements)
      .where(and(scope, eq(templateFieldPlacements.templateId, templateId)))
      .orderBy(asc(templateFieldPlacements.sortOrder), asc(templateFieldPlacements.page)),
    executor,
  );
  return rows.map((row) => toEntity(row as Record<string, any>));
}

/**
 * Replace the full placement set for a template. Callers pass the transaction
 * executor so this delete+insert and the accompanying
 * templates.fields/templates.repeaters sync commit atomically.
 */
async function replaceForTemplate(
  lawFirmId: string,
  templateId: string,
  placements: any[],
  executor: DrizzleExecutor,
) {
  await scopedDelete(
    templateFieldPlacements,
    lawFirmId,
    eq(templateFieldPlacements.templateId, templateId),
    executor,
  );

  if (!placements.length) return [];

  const rows = await scopedInsertMany(
    templateFieldPlacements,
    lawFirmId,
    placements.map((placement: any) => ({
      templateId,
      fieldName: placement.fieldName,
      fieldType: placement.fieldType || 'text',
      page: placement.page,
      xPercent: String(placement.xPercent),
      yPercent: String(placement.yPercent),
      widthPercent: String(placement.widthPercent),
      heightPercent: String(placement.heightPercent),
      repeaterName: placement.repeaterName || null,
      repeaterRowIndex: placement.repeaterName ? (placement.repeaterRowIndex ?? 0) : null,
      sortOrder: placement.sortOrder ?? 0,
      textContent: placement.fieldType === 'textbox' ? null : placement.textContent || null,
      imageObjectPath: placement.imageObjectPath || null,
      imageMimeType: placement.imageMimeType || null,
      fontSize: placement.fontSize == null ? null : String(placement.fontSize),
      fontFamily: placement.fontFamily || 'times',
      bold: Boolean(placement.bold),
      italic: Boolean(placement.italic),
      color: placement.color || '#000000',
      textAlign: placement.textAlign || 'left',
      bulletList: placement.fieldType === 'textbox' ? false : Boolean(placement.bulletList),
      richText: placement.richText ?? null,
    })) as any,
    executor,
  );

  return rows.map((row) => toEntity(row as Record<string, any>));
}

export = { listByTemplate, replaceForTemplate };
