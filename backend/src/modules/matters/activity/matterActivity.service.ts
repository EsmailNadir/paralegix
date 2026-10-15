const matterActivityRepo = require('./matterActivity.repository');
const mattersRepo = require('../matters.repository');
const { assertMatterReadAccess } = require('../../../shared/utils/membership');

/**
 * Record a matter activity entry. Best-effort by design: a failure to log
 * activity must NEVER break the mutation that triggered it, so all errors are
 * swallowed (logged). Resolves the actor's display name when not supplied.
 */
export async function recordActivity({ lawFirmId, matterId, activityType, actorUserId = null, actorName = null, summary, metadata = {} }: any) {
  try {
    let name = actorName;
    if (!name && actorUserId) {
      name = await mattersRepo.getUserName(actorUserId);
    }
    await matterActivityRepo.record(lawFirmId, {
      matterId,
      activityType,
      actorUserId,
      actorName: name || null,
      summary,
      metadata,
    });
  } catch (err: any) {
    console.error('matterActivity.service: recordActivity failed:', err?.message || err);
  }
}

/**
 * List a page of a matter's activity feed (readable by anyone who may read the matter).
 * Answers `{ activity, totalItems }` so the caller can page through the whole
 * history rather than only ever seeing the newest page.
 */
export async function listActivity({ lawFirmId, matterId, userId, limit = 100, offset = 0, activityTypes }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  return matterActivityRepo.listForMatter(lawFirmId, matterId, { limit, offset, activityTypes });
}
