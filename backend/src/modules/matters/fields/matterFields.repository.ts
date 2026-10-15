/**
 * Matter custom-field definitions (Postgres).
 *
 * A firm defines fields that appear on matters. A definition with
 * practice_area_id = NULL applies to every matter; otherwise it only applies to
 * matters in that practice area. The VALUES a matter carries live on
 * matters.custom_fields (jsonb), keyed by the definition id — see matters.service.
 */

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { matterFieldDefs } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatDef(row: any) {
  return {
    id: row.id,
    practiceAreaId: row.practiceAreaId || null,
    label: row.label,
    fieldType: row.fieldType,
    options: row.options || [],
    helpText: row.helpText || null,
    required: row.required === true,
    sortOrder: row.sortOrder ?? 0,
    archived: row.archived === true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

class MatterFieldsRepository {
  /** All field defs for a firm, ordered for display. Excludes archived unless asked. */
  async listForFirm(lawFirmId: string, { includeArchived = false } = {}) {
    const rows = await tenantQuery(matterFieldDefs, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterFieldDefs)
      .where(includeArchived ? scope : and(scope, eq(matterFieldDefs.archived, false)))
      .orderBy(asc(matterFieldDefs.sortOrder), asc(matterFieldDefs.createdAt)));
    return rows.map(formatDef);
  }

  /**
   * Field defs applicable to a matter in a given practice area: the firm-wide
   * defs (practice_area_id is null) plus the ones scoped to that practice area.
   * Archived defs are excluded (they no longer collect new values).
   */
  async listApplicable(lawFirmId: string, practiceAreaId: any) {
    const pa = isUuid(practiceAreaId) ? practiceAreaId : null;
    const area = pa
      ? or(isNull(matterFieldDefs.practiceAreaId), eq(matterFieldDefs.practiceAreaId, pa))
      : isNull(matterFieldDefs.practiceAreaId);
    const rows = await tenantQuery(matterFieldDefs, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterFieldDefs).where(and(scope, eq(matterFieldDefs.archived, false), area))
      .orderBy(asc(matterFieldDefs.sortOrder), asc(matterFieldDefs.createdAt)));
    return rows.map(formatDef);
  }

  async getById(lawFirmId: string, defId: any) {
    if (!isUuid(defId)) return null;
    const rows = await tenantQuery(matterFieldDefs, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterFieldDefs).where(and(scope, eq(matterFieldDefs.id, defId))).limit(1));
    return rows[0] ? formatDef(rows[0]) : null;
  }

  async create(lawFirmId: string, def: any) {
    const rows = await scopedInsert(matterFieldDefs, lawFirmId, {
      practiceAreaId: isUuid(def.practiceAreaId) ? def.practiceAreaId : null,
      label: def.label,
      fieldType: def.fieldType || 'text',
      options: def.options || [],
      helpText: def.helpText || null,
      required: def.required === true,
      sortOrder: def.sortOrder ?? 0,
      createdBy: def.createdBy || null,
    });
    return formatDef(rows[0]);
  }

  async update(lawFirmId: string, defId: any, updates: any) {
    if (!isUuid(defId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['practiceAreaId', 'label', 'fieldType', 'helpText', 'required', 'sortOrder', 'archived']) {
      if (updates[field] !== undefined) {
        let v = updates[field];
        if (field === 'practiceAreaId' && !isUuid(v)) v = null;
        values[field] = v;
      }
    }
    if (updates.options !== undefined) values.options = updates.options || [];
    if (!Object.keys(values).length) return this.getById(lawFirmId, defId);
    const rows = await scopedUpdate(matterFieldDefs, lawFirmId, eq(matterFieldDefs.id, defId), values);
    return rows[0] ? formatDef(rows[0]) : null;
  }

  async delete(lawFirmId: string, defId: any) {
    if (!isUuid(defId)) return false;
    const rows = await scopedDelete(matterFieldDefs, lawFirmId, eq(matterFieldDefs.id, defId));
    return rows.length > 0;
  }
}

export = Object.assign(new MatterFieldsRepository(), { formatDef });
