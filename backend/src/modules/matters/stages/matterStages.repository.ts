/**
 * Matter stages (Postgres). An ordered pipeline a matter progresses through
 * (Intake -> Discovery -> Trial -> Closed), distinct from the coarse status
 * enum. Each stage belongs to exactly one matter_stage_pipelines row, which
 * carries the pipeline's name and (optional) practice-area scope.
 */

const { isUuid } = require('../../../shared/utils/isUuid');
const { and, asc, eq } = require('drizzle-orm');
const { matterStages } = require('../../../shared/database/drizzle/schema');
import { tenantQuery, withDrizzleTransaction } from '../../../shared/database/queryContext';
const { scopedInsert, scopedUpdate, scopedDelete } = require('../../../shared/database/scopedWrite');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatStage(row: any) {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    color: row.color || null,
    sortOrder: row.sortOrder ?? 0,
    isClosed: row.isClosed === true,
    parentStageId: row.parentStageId || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

class MatterStagesRepository {
  async listForFirm(lawFirmId: string) {
    const rows = await tenantQuery(matterStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStages).where(scope)
      .orderBy(asc(matterStages.pipelineId), asc(matterStages.sortOrder), asc(matterStages.createdAt)));
    return rows.map(formatStage);
  }

  async listForPipeline(lawFirmId: string, pipelineId: any) {
    if (!isUuid(pipelineId)) return [];
    const rows = await tenantQuery(matterStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStages)
      .where(and(scope, eq(matterStages.pipelineId, pipelineId)))
      .orderBy(asc(matterStages.sortOrder), asc(matterStages.createdAt)));
    return rows.map(formatStage);
  }

  async getById(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return null;
    const rows = await tenantQuery(matterStages, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStages).where(and(scope, eq(matterStages.id, stageId))).limit(1));
    return rows[0] ? formatStage(rows[0]) : null;
  }

  async create(lawFirmId: string, stage: any) {
    const rows = await scopedInsert(matterStages, lawFirmId, {
      pipelineId: stage.pipelineId,
      name: stage.name,
      color: stage.color || null,
      sortOrder: stage.sortOrder ?? 0,
      isClosed: stage.isClosed === true,
      parentStageId: isUuid(stage.parentStageId) ? stage.parentStageId : null,
    });
    return formatStage(rows[0]);
  }

  async update(lawFirmId: string, stageId: string, updates: any) {
    if (!isUuid(stageId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['name', 'color', 'sortOrder', 'isClosed', 'parentStageId']) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (!Object.keys(values).length) return this.getById(lawFirmId, stageId);
    const rows = await scopedUpdate(matterStages, lawFirmId, eq(matterStages.id, stageId), values);
    return rows[0] ? formatStage(rows[0]) : null;
  }

  /** True if any stage in this firm has `stageId` as its parent. */
  async hasChildren(lawFirmId: string, stageId: string) {
    if (!isUuid(stageId)) return false;
    const rows = await tenantQuery(matterStages, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matterStages.id }).from(matterStages)
      .where(and(scope, eq(matterStages.parentStageId, stageId))).limit(1));
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
        matterStages,
        lawFirmId,
        ({ executor, scope }) => executor
          .select({ parentStageId: matterStages.parentStageId })
          .from(matterStages)
          .where(and(scope, eq(matterStages.id, stageId)))
          .for('update'),
        transaction,
      );
      // Returning here commits an empty transaction, which releases the row lock
      // exactly as the previous explicit rollback did.
      if (!rows.length) return false;

      const parentId = rows[0].parentStageId;
      await scopedUpdate(
        matterStages,
        lawFirmId,
        eq(matterStages.parentStageId, stageId),
        { parentStageId: parentId },
        transaction,
      );
      const deleted = await scopedDelete(
        matterStages,
        lawFirmId,
        eq(matterStages.id, stageId),
        transaction,
      );
      return deleted.length > 0;
    });
  }

}

export = Object.assign(new MatterStagesRepository(), { formatStage });
