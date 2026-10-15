import { and, asc, eq, sql } from 'drizzle-orm';
import { wordTemplates } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate, type UpdateValues } from '../../shared/database/scopedWrite';
import { isUuid } from '../../shared/utils/isUuid';
import { rowIso } from '../../shared/utils/dateConversion';
import type { WordTemplateType } from './lib/types';

export type WordTemplateRow = typeof wordTemplates.$inferSelect;

/** One image an html template embeds, as stored in `assets`. */
export interface StoredAsset {
  id: string;
  object_path: string;
  mime_type: string;
  file_name?: string | null;
}

export interface StoredRepeater {
  name: string;
  fields: string[];
}

/** A library row, in the shape JJ's `Template` carried (no body, no paths). */
export function formatWordTemplate(row: WordTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type as WordTemplateType,
    fields: row.fields ?? [],
    repeaters: (Array.isArray(row.repeaters) ? row.repeaters : []) as StoredRepeater[],
    // The library has no folders; the key stays so the ported list code reads it.
    folderId: null,
    originalFileName: row.originalFileName ?? null,
    createdAt: rowIso(row.createdAt),
    updatedAt: rowIso(row.updatedAt),
  };
}

export function rowAssets(row: WordTemplateRow): StoredAsset[] {
  return (Array.isArray(row.assets) ? row.assets : []) as StoredAsset[];
}

export async function listWordTemplates(lawFirmId: string): Promise<WordTemplateRow[]> {
  return tenantQuery(wordTemplates, lawFirmId, ({ executor, scope }) => executor
    .select().from(wordTemplates).where(scope)
    .orderBy(asc(wordTemplates.name), asc(wordTemplates.id)));
}

export async function findWordTemplate(lawFirmId: string, templateId: string): Promise<WordTemplateRow | null> {
  if (!isUuid(templateId)) return null;
  const rows = await tenantQuery(wordTemplates, lawFirmId, ({ executor, scope }) => executor
    .select().from(wordTemplates).where(and(scope, eq(wordTemplates.id, templateId))).limit(1));
  return rows[0] ?? null;
}

/**
 * A template of this type whose name matches, ignoring case, within the firm.
 * The partial unique index on (law_firm_id, type, lower(name)) is what makes
 * the answer binding; this is how the chooser learns of a clash before the
 * insert would refuse it.
 */
export async function findSameNameTemplate(
  lawFirmId: string,
  name: string,
  type: WordTemplateType,
): Promise<WordTemplateRow | null> {
  const rows = await tenantQuery(wordTemplates, lawFirmId, ({ executor, scope }) => executor
    .select().from(wordTemplates)
    .where(and(scope, eq(wordTemplates.type, type), sql`lower(${wordTemplates.name}) = lower(${name})`))
    .orderBy(asc(wordTemplates.createdAt))
    .limit(1));
  return rows[0] ?? null;
}

export async function insertWordTemplate(
  lawFirmId: string,
  values: {
    id: string;
    name: string;
    type: WordTemplateType;
    htmlObjectPath?: string | null;
    sourceObjectPath?: string | null;
    originalFileName?: string | null;
    fields: string[];
    repeaters: StoredRepeater[];
    assets: StoredAsset[];
    createdBy: string;
  },
): Promise<WordTemplateRow> {
  const [row] = await scopedInsert(wordTemplates, lawFirmId, {
    id: values.id,
    name: values.name,
    type: values.type,
    htmlObjectPath: values.htmlObjectPath ?? null,
    sourceObjectPath: values.sourceObjectPath ?? null,
    originalFileName: values.originalFileName ?? null,
    fields: values.fields,
    repeaters: values.repeaters,
    assets: values.assets,
    createdBy: values.createdBy,
  });
  return row;
}

export async function updateWordTemplate(
  lawFirmId: string,
  templateId: string,
  values: UpdateValues<typeof wordTemplates>,
): Promise<WordTemplateRow | null> {
  if (!isUuid(templateId)) return null;
  const rows = await scopedUpdate(wordTemplates, lawFirmId, eq(wordTemplates.id, templateId), values);
  return rows[0] ?? null;
}

export async function deleteWordTemplate(lawFirmId: string, templateId: string): Promise<WordTemplateRow | null> {
  if (!isUuid(templateId)) return null;
  const rows = await scopedDelete(wordTemplates, lawFirmId, eq(wordTemplates.id, templateId));
  return rows[0] ?? null;
}
