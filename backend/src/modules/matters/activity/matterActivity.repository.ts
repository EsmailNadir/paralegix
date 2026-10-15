/**
 * Matter activity feed (Postgres, append-only).
 *
 * A chronological record of what happened on a matter — created, status/stage
 * changes, members and clients added/removed, notes/events/contacts added, legal
 * hold placed, conflict checks run. Rows are never edited or deleted (except by
 * the matter's own cascade), so this doubles as a lightweight audit trail.
 */

import { and, count as countRows, desc, eq, inArray } from 'drizzle-orm';
import { activityLog } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
import { scopedInsert } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatActivity(row: any) {
  return {
    id: row.id,
    matterId: row.matterId,
    activityType: row.activityType,
    actorUserId: row.actorUserId || null,
    actorName: row.actorName || null,
    summary: row.summary,
    metadata: row.metadata || {},
    createdAt: iso(row.createdAt),
  };
}

class MatterActivityRepository {
  /** Append one activity row. Best-effort caller: never throws to the caller's txn. */
  async record(lawFirmId: string, { matterId, activityType, actorUserId = null, actorName = null, summary, metadata = {} }: any) {
    if (!isUuid(matterId) || !summary) return;
    await scopedInsert(activityLog, lawFirmId, {
      matterId, activityType, actorUserId, actorName, summary, metadata: metadata || {},
    });
  }

  /**
   * Newest-first activity for a matter, one page at a time.
   *
   * Returns the total alongside the page so the caller can tell "that's all of
   * it" from "there is more". The feed is append-only and never pruned, so a
   * long-running matter's history outgrows any single-page cap.
   *
   * `activityTypes`, when non-empty, narrows to those types (the timeline's
   * "Notes only" style filters).
   */
  async listForMatter(lawFirmId: string, matterId: string, { limit = 100, offset = 0, activityTypes }: any = {}) {
    if (!isUuid(matterId)) return { activity: [], totalItems: 0 };
    const typeFilter = Array.isArray(activityTypes) && activityTypes.length
      ? inArray(activityLog.activityType, activityTypes)
      : undefined;
    const [page, count] = await Promise.all([
      tenantQuery(activityLog, lawFirmId, ({ executor, scope }) => executor.select().from(activityLog)
        .where(and(scope, eq(activityLog.matterId, matterId), typeFilter))
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(limit).offset(offset)),
      tenantQuery(activityLog, lawFirmId, ({ executor, scope }) => executor
        .select({ total: countRows() }).from(activityLog)
        .where(and(scope, eq(activityLog.matterId, matterId), typeFilter))),
    ]);
    return {
      activity: page.map(formatActivity),
      totalItems: count[0]?.total ?? 0,
    };
  }
}

export = Object.assign(new MatterActivityRepository(), { formatActivity });
