/**
 * Matter stage pipelines (Postgres). A named, optionally practice-area-scoped
 * pipeline a matter can be assigned to. Multiple pipelines may share a scope
 * (including several unscoped firm-wide pipelines); at most one per scope is
 * flagged is_default, used to auto-assign a pipeline to a matter that doesn't
 * pick one explicitly.
 */

const { isUuid } = require('../../../shared/utils/isUuid');
const { and, asc, eq, isNull } = require('drizzle-orm');
const { matterStagePipelines, matterStages, lawFirms } = require('../../../shared/database/drizzle/schema');
import { tenantQuery, firmQuery, withDrizzleTransaction } from '../../../shared/database/queryContext';
const { scopedInsert, scopedUpdate, scopedDelete } = require('../../../shared/database/scopedWrite');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatPipeline(row: any) {
  return {
    id: row.id,
    practiceAreaId: row.practiceAreaId || null,
    name: row.name,
    isDefault: row.isDefault === true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

class MatterStagePipelinesRepository {
  async listForFirm(lawFirmId: string) {
    const rows = await tenantQuery(matterStagePipelines, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStagePipelines).where(scope)
      .orderBy(asc(matterStagePipelines.name)));
    return rows.map(formatPipeline);
  }

  async getById(lawFirmId: string, pipelineId: any) {
    if (!isUuid(pipelineId)) return null;
    const rows = await tenantQuery(matterStagePipelines, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStagePipelines).where(and(scope, eq(matterStagePipelines.id, pipelineId))).limit(1));
    return rows[0] ? formatPipeline(rows[0]) : null;
  }

  /** The default pipeline for a scope: the practice area's default if it has one, else the firm-wide default. */
  async resolveDefault(lawFirmId: string, practiceAreaId: any) {
    const pa = isUuid(practiceAreaId) ? practiceAreaId : null;
    if (pa) {
      const rows = await tenantQuery(matterStagePipelines, lawFirmId, ({ executor, scope }) => executor
        .select().from(matterStagePipelines)
        .where(and(scope, eq(matterStagePipelines.practiceAreaId, pa), eq(matterStagePipelines.isDefault, true)))
        .limit(1));
      if (rows[0]) return formatPipeline(rows[0]);
    }
    const rows = await tenantQuery(matterStagePipelines, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterStagePipelines)
      .where(and(scope, isNull(matterStagePipelines.practiceAreaId), eq(matterStagePipelines.isDefault, true)))
      .limit(1));
    return rows[0] ? formatPipeline(rows[0]) : null;
  }

  /**
   * Serialize any concurrent "which pipeline is the default for this scope"
   * decision on the firm's own row, the same lock used for the `maxMatters`/
   * `maxMembers` seat races (`matters.repository.ts#lockFirmForMatterCountCheck`,
   * `invitations.repository.ts#lockFirmForSeatCheck`).
   *
   * `createWithStages` and `update()` both do a check-then-clear-then-write:
   * read whether a default already exists for the (firm, practiceAreaId)
   * scope, and only clear/insert accordingly. That is safe within one
   * transaction but not across two: two concurrent transactions can both read
   * "no default yet" before either commits, both decide they should be the
   * default, and both attempt to write `is_default = true`. The partial unique
   * index (`matter_stage_pipelines_one_default_idx`) then blocks the SECOND
   * writer's insert/update until the first commits and throws a raw
   * `23505 unique_violation` once it does, an unhandled 500 for what is
   * otherwise two entirely legitimate requests. Taking this lock first makes
   * the second transaction's read of "does a default exist" wait until the
   * first transaction's write has actually committed, so it sees the true
   * current state instead of a stale "empty" read.
   */
  async lockFirmForPipelineDefaultCheck(lawFirmId: string, executor: any) {
    await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select({ id: lawFirms.id }).from(lawFirms).where(scope).for('update'),
      executor,
    );
  }

  /** Clear is_default on every other pipeline sharing this (firm, scope). */
  async _clearOtherDefaults(executor: any, lawFirmId: string, practiceAreaId: any, exceptId: any) {
    const scopeMatch = practiceAreaId
      ? eq(matterStagePipelines.practiceAreaId, practiceAreaId)
      : isNull(matterStagePipelines.practiceAreaId);
    const rows = await tenantQuery(
      matterStagePipelines,
      lawFirmId,
      ({ executor: qe, scope }) => qe.select({ id: matterStagePipelines.id }).from(matterStagePipelines)
        .where(and(scope, scopeMatch, eq(matterStagePipelines.isDefault, true))),
      executor,
    );
    const others = rows.filter((r: any) => r.id !== exceptId);
    for (const row of others) {
      // eslint-disable-next-line no-await-in-loop
      await scopedUpdate(matterStagePipelines, lawFirmId, eq(matterStagePipelines.id, row.id), { isDefault: false }, executor);
    }
  }

  /** Create a pipeline and its parent-before-child stage tree atomically. */
  async createWithStages(lawFirmId: string, pipeline: any, stages: any[]) {
    const practiceAreaId = isUuid(pipeline.practiceAreaId) ? pipeline.practiceAreaId : null;
    return withDrizzleTransaction(async (transaction: any) => {
      await this.lockFirmForPipelineDefaultCheck(lawFirmId, transaction);
      const scopeMatch = practiceAreaId
        ? eq(matterStagePipelines.practiceAreaId, practiceAreaId)
        : isNull(matterStagePipelines.practiceAreaId);
      const defaults = await tenantQuery(
        matterStagePipelines,
        lawFirmId,
        ({ executor, scope }) => executor.select({ id: matterStagePipelines.id })
          .from(matterStagePipelines)
          .where(and(scope, scopeMatch, eq(matterStagePipelines.isDefault, true)))
          .limit(1),
        transaction,
      );
      const isDefault = pipeline.isDefault === true || defaults.length === 0;
      if (isDefault) await this._clearOtherDefaults(transaction, lawFirmId, practiceAreaId, null);

      const pipelineRows = await scopedInsert(matterStagePipelines, lawFirmId, {
        practiceAreaId,
        name: pipeline.name,
        isDefault,
      }, transaction);
      const createdPipeline = formatPipeline(pipelineRows[0]);
      const idByClientId = new Map<string, string>();
      const createdStages = [];

      for (const stage of stages) {
        // Sequential on purpose: each child needs the parent id created earlier in the transaction.
        // eslint-disable-next-line no-await-in-loop
        const rows = await scopedInsert(matterStages, lawFirmId, {
          pipelineId: createdPipeline.id,
          name: stage.name,
          color: stage.color || null,
          sortOrder: stage.sortOrder,
          isClosed: stage.isClosed === true,
          parentStageId: stage.parentClientId ? idByClientId.get(stage.parentClientId) : null,
        }, transaction);
        const row = rows[0];
        idByClientId.set(stage.clientId, row.id);
        createdStages.push({
          id: row.id,
          pipelineId: row.pipelineId,
          name: row.name,
          color: row.color || null,
          sortOrder: row.sortOrder ?? 0,
          isClosed: row.isClosed === true,
          parentStageId: row.parentStageId || null,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        });
      }

      return { pipeline: createdPipeline, stages: createdStages };
    });
  }

  async update(lawFirmId: string, pipelineId: any, updates: any) {
    if (!isUuid(pipelineId)) return null;
    const existing = await this.getById(lawFirmId, pipelineId);
    if (!existing) return null;

    const values: Record<string, unknown> = {};
    if (updates.name !== undefined) values.name = updates.name;
    if (updates.practiceAreaId !== undefined) {
      values.practiceAreaId = isUuid(updates.practiceAreaId) ? updates.practiceAreaId : null;
    }
    if (updates.isDefault !== undefined) values.isDefault = updates.isDefault === true;
    if (!Object.keys(values).length) return existing;

    if (values.isDefault === true) {
      const targetScope = 'practiceAreaId' in values ? (values.practiceAreaId as string | null) : existing.practiceAreaId;
      return withDrizzleTransaction(async (transaction: any) => {
        await this.lockFirmForPipelineDefaultCheck(lawFirmId, transaction);
        await this._clearOtherDefaults(transaction, lawFirmId, targetScope, pipelineId);
        const rows = await scopedUpdate(matterStagePipelines, lawFirmId, eq(matterStagePipelines.id, pipelineId), values, transaction);
        return rows[0] ? formatPipeline(rows[0]) : null;
      });
    }
    const rows = await scopedUpdate(matterStagePipelines, lawFirmId, eq(matterStagePipelines.id, pipelineId), values);
    return rows[0] ? formatPipeline(rows[0]) : null;
  }

  async delete(lawFirmId: string, pipelineId: any) {
    if (!isUuid(pipelineId)) return false;
    const rows = await scopedDelete(matterStagePipelines, lawFirmId, eq(matterStagePipelines.id, pipelineId));
    return rows.length > 0;
  }

}

export = Object.assign(new MatterStagePipelinesRepository(), { formatPipeline });
