/**
 * Document request templates (Postgres).
 *
 * A firm-level, reusable set of {name, defaultTitle, defaultNote, items} that
 * the "New document request" modal can apply to prefill the form. `items` is
 * a plain jsonb array of label strings, ordered by array position; template
 * items carry no independent state, unlike document_request_items.
 */

import { and, asc, eq } from 'drizzle-orm';
import { documentRequestTemplates } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
import { scopedInsert, scopedUpdate } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatItem(item: any) {
  return { label: item?.label || '', description: item?.description || null };
}

function formatTemplate(row: any) {
  return {
    id: row.id,
    name: row.name,
    defaultTitle: row.defaultTitle,
    defaultNote: row.defaultNote || null,
    items: Array.isArray(row.items) ? row.items.map(formatItem) : [],
    archived: row.archived === true,
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

class DocumentRequestTemplatesRepository {
  async listForFirm(lawFirmId: string, { includeArchived = false } = {}) {
    const rows = await tenantQuery(documentRequestTemplates, lawFirmId, ({ executor, scope }) => executor
      .select().from(documentRequestTemplates)
      .where(includeArchived ? scope : and(scope, eq(documentRequestTemplates.archived, false)))
      .orderBy(asc(documentRequestTemplates.name)));
    return rows.map(formatTemplate);
  }

  async getById(lawFirmId: string, templateId: string) {
    if (!isUuid(templateId)) return null;
    const rows = await tenantQuery(documentRequestTemplates, lawFirmId, ({ executor, scope }) => executor
      .select().from(documentRequestTemplates).where(and(scope, eq(documentRequestTemplates.id, templateId))).limit(1));
    return rows[0] ? formatTemplate(rows[0]) : null;
  }

  async create(lawFirmId: string, template: any) {
    const rows = await scopedInsert(documentRequestTemplates, lawFirmId, {
      name: template.name,
      defaultTitle: template.defaultTitle,
      defaultNote: template.defaultNote || null,
      items: template.items || [],
      createdBy: template.createdBy || null,
    });
    return formatTemplate(rows[0]);
  }

  async update(lawFirmId: string, templateId: string, updates: any) {
    if (!isUuid(templateId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['name', 'defaultTitle', 'defaultNote', 'archived']) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (updates.items !== undefined) values.items = updates.items || [];
    if (!Object.keys(values).length) return this.getById(lawFirmId, templateId);
    const rows = await scopedUpdate(documentRequestTemplates, lawFirmId, eq(documentRequestTemplates.id, templateId), values);
    return rows[0] ? formatTemplate(rows[0]) : null;
  }
}

export = Object.assign(new DocumentRequestTemplatesRepository(), { formatTemplate });
