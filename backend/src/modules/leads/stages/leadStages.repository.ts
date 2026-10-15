/**
 * Lead stages (Postgres). An ordered pipeline a lead progresses through
 * (New -> Qualified -> Retained), distinct from clients/matters.
 * A stage with practice_area_id = NULL belongs to a firm-wide default pipeline;
 * otherwise it belongs to that practice area's pipeline.
 */

const { isUuid } = require('../../../shared/utils/isUuid');
const { and, asc, eq, inArray, isNull, sql } = require('drizzle-orm');
const { leadStages, leads } = require('../../../shared/database/drizzle/schema');
import { tenantQuery, withDrizzleTransaction, type DrizzleExecutor } from '../../../shared/database/queryContext';
const { scopedInsert, scopedUpdate, scopedDelete } = require('../../../shared/database/scopedWrite');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');
const { DEFAULT_LEAD_STAGE_PIPELINE } = require('../../../shared/referenceData/defaults');

function formatStage(row: any) {
  return {
    id: row.id,
    practiceAreaId: row.practiceAreaId || null,
    name: row.name,
    color: row.color || null,
    sortOrder: row.sortOrder ?? 0,
    isClosed: row.isClosed === true,
    parentStageId: row.parentStageId || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

class LeadStagesRepository {
  async listForFirm(lawFirmId: string) {
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages).where(scope)
      .orderBy(sql`${leadStages.practiceAreaId} asc nulls first`, asc(leadStages.sortOrder), asc(leadStages.createdAt)));
    return rows.map(formatStage);
  }

  /**
   * Stages that apply to a lead in a given practice area: that area's stages
   * if it has any, otherwise the firm-wide default pipeline (practice_area_id null).
   */
  async listApplicable(lawFirmId: string, practiceAreaId: any) {
    const pa = isUuid(practiceAreaId) ? practiceAreaId : null;
    if (pa) {
      const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
        .select().from(leadStages).where(and(scope, eq(leadStages.practiceAreaId, pa)))
        .orderBy(asc(leadStages.sortOrder), asc(leadStages.createdAt)));
      if (rows.length) return rows.map(formatStage);
    }
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages).where(and(scope, isNull(leadStages.practiceAreaId)))
      .orderBy(asc(leadStages.sortOrder), asc(leadStages.createdAt)));
    return rows.map(formatStage);
  }

  async getById(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return null;
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages).where(and(scope, eq(leadStages.id, stageId))).limit(1));
    return rows[0] ? formatStage(rows[0]) : null;
  }

  async create(lawFirmId: string, stage: any, executor?: DrizzleExecutor) {
    const rows = await scopedInsert(leadStages, lawFirmId, {
      practiceAreaId: isUuid(stage.practiceAreaId) ? stage.practiceAreaId : null,
      name: stage.name,
      color: stage.color || null,
      sortOrder: stage.sortOrder ?? 0,
      isClosed: stage.isClosed === true,
      parentStageId: isUuid(stage.parentStageId) ? stage.parentStageId : null,
    }, executor);
    return formatStage(rows[0]);
  }

  async update(lawFirmId: string, stageId: string, updates: any) {
    if (!isUuid(stageId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['name', 'color', 'sortOrder', 'isClosed', 'parentStageId']) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (!Object.keys(values).length) return this.getById(lawFirmId, stageId);
    const rows = await scopedUpdate(leadStages, lawFirmId, eq(leadStages.id, stageId), values);
    return rows[0] ? formatStage(rows[0]) : null;
  }

  async delete(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return false;
    const rows = await scopedDelete(leadStages, lawFirmId, eq(leadStages.id, stageId));
    return rows.length > 0;
  }

  /** True if any stage in this firm has `stageId` as its parent. */
  async hasChildren(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return false;
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select({ id: leadStages.id }).from(leadStages)
      .where(and(scope, eq(leadStages.parentStageId, stageId))).limit(1));
    return rows.length > 0;
  }

  /**
   * Delete a stage, promoting its children to the deleted stage's parent so the
   * tree stays connected (the subtree moves up one level; a root's children
   * become roots). Runs in a transaction.
   */
  async deleteWithReparent(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return false;
    return withDrizzleTransaction(async (transaction: any) => {
      const rows = await tenantQuery(
        leadStages,
        lawFirmId,
        ({ executor, scope }) => executor
          .select({ parentStageId: leadStages.parentStageId })
          .from(leadStages)
          .where(and(scope, eq(leadStages.id, stageId)))
          .for('update'),
        transaction,
      );
      if (!rows.length) return false;

      const parentId = rows[0].parentStageId;
      await scopedUpdate(
        leadStages,
        lawFirmId,
        eq(leadStages.parentStageId, stageId),
        { parentStageId: parentId },
        transaction,
      );
      // Take the leads off this stage BEFORE deleting it. `leads_stage_fk` is a
      // COMPOSITE key, (law_firm_id, stage_id), declared `on delete set null`,
      // so Postgres tries to null the tenant column too and the delete dies on
      // `leads.law_firm_id` being not-null (23502) -- a 500 on the ordinary act
      // of deleting a stage that has any leads on it. Clearing `stage_id` here
      // produces what that clause was meant to produce.
      await scopedUpdate(
        leads,
        lawFirmId,
        eq(leads.stageId, stageId),
        { stageId: null },
        transaction,
      );
      const deleted = await scopedDelete(
        leadStages,
        lawFirmId,
        eq(leadStages.id, stageId),
        transaction,
      );
      return deleted.length > 0;
    });
  }

  /** Set sort_order to array position for the given stage ids (one statement). */
  async reorder(lawFirmId: string, stageIds: any) {
    const ids = (stageIds || []).filter(isUuid);
    if (!ids.length) return;
    const cases = sql.join(ids.map((id: string, index: number) => sql`when ${id} then ${index}`), sql` `);
    await scopedUpdate(leadStages, lawFirmId, inArray(leadStages.id, ids), {
      sortOrder: sql`case ${leadStages.id}::text ${cases} else ${leadStages.sortOrder} end`,
    });
  }

  /** True if `stageId` is a stage in this firm (validation before assigning to a lead). */
  async existsInFirm(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return false;
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select({ id: leadStages.id }).from(leadStages)
      .where(and(scope, eq(leadStages.id, stageId))).limit(1));
    return rows.length > 0;
  }

  /**
   * Seed the firm-wide default lead pipeline (see DEFAULT_LEAD_STAGE_PIPELINE).
   * Sequential, not parallelized: each later stage's parentStageId depends on
   * the id an earlier `create()` call just returned.
   */
  async seedDefaultPipeline(lawFirmId: string, executor?: DrizzleExecutor) {
    const idByKey: Record<string, any> = {};
    const stages = [];
    for (let i = 0; i < DEFAULT_LEAD_STAGE_PIPELINE.length; i++) {
      const def = DEFAULT_LEAD_STAGE_PIPELINE[i];
      const stage = await this.create(lawFirmId, {
        name: def.name,
        color: def.color,
        sortOrder: i,
        isClosed: def.isClosed,
        parentStageId: def.parentKey ? idByKey[def.parentKey] : null,
      }, executor);
      idByKey[def.key] = stage.id;
      stages.push(stage);
    }
    return stages;
  }

  /** First closed stage by sort order (e.g. "Retained"), or null if none. */
  async getFirstClosedStage(lawFirmId: string) {
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages)
      .where(and(scope, eq(leadStages.isClosed, true)))
      .orderBy(asc(leadStages.sortOrder), asc(leadStages.createdAt))
      .limit(1));
    return rows[0] ? formatStage(rows[0]) : null;
  }

  /** Lowest-sort-order non-closed stage — default landing stage for new leads. */
  async getDefaultOpenStage(lawFirmId: string) {
    const rows = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages)
      .where(and(scope, eq(leadStages.isClosed, false), isNull(leadStages.practiceAreaId)))
      .orderBy(asc(leadStages.sortOrder), asc(leadStages.createdAt))
      .limit(1));
    if (rows[0]) return formatStage(rows[0]);
    // Fall back to any non-closed stage if the firm has no firm-wide defaults.
    const anyOpen = await tenantQuery(leadStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(leadStages)
      .where(and(scope, eq(leadStages.isClosed, false)))
      .orderBy(asc(leadStages.sortOrder), asc(leadStages.createdAt))
      .limit(1));
    return anyOpen[0] ? formatStage(anyOpen[0]) : null;
  }
}

export = Object.assign(new LeadStagesRepository(), { formatStage });
