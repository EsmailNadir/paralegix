const eventBus = require('../../../shared/events/eventBus');
const { MATTER_UPDATED, TIME_ENTRY_CHANGED } = require('../../../shared/events/eventTypes');
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');

/**
 * When a matter is marked as closed, end any active/paused retainer plans linked
 * to that matter whose endCondition is 'matter_closed'.
 */
eventBus.on(MATTER_UPDATED, async ({ lawFirmId, matterId, matterData }: any) => {
  try {
    if (matterData?.status !== 'closed' || !isUuid(matterId)) return;
    await financialRootSql(
      `update billing_plans set status = 'ended', updated_at = now()
        where law_firm_id = $1 and matter_id = $2
          and status in ('active','paused') and end_condition = 'matter_closed'`,
      [lawFirmId, matterId]
    );
  } catch (err: any) {
    console.error('[plans.events] MATTER_UPDATED matter_closed handler error:', err.message);
  }
});

/**
 * A time entry in a plan's context changed: recompute the usage of that plan's
 * open periods. Idempotent, so a replayed event only repeats a no-op read.
 */
eventBus.on(TIME_ENTRY_CHANGED, async ({ lawFirmId, type, entityId }: any) => {
  try {
    if (!lawFirmId || !isUuid(entityId) || (type !== 'matter' && type !== 'client')) return;
    await require('./plans.service').refreshContextPlans({ lawFirmId, contextType: type, entityId });
  } catch (err: any) {
    console.error('[plans.events] TIME_ENTRY_CHANGED period refresh error:', err.message);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
