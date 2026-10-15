import { withCalendarSyncLock } from './calendarSyncLock';
import { isAssignedEntityType, isCalendarRecipient } from './calendarRecipients';
const repo = require('./calendarSync.repository');
const tokens = require('./calendarTokens');
const { getAdapter } = require('./calendarAdapters');
const resolver = require('./calendarEntityResolver');
// Loaded with this module rather than inside the dispatch: dispatch runs from a
// coalescing timer, which can fire after a shutdown or test teardown has begun.
// Namespace imports, read at call time, keep the cycle through the services safe.
const membersRepo = require('../../lawfirms/members/members.repository');
const rolesService = require('../../lawfirms/roles/roles.service');
const membership = require('../../../shared/utils/membership');
const googleService = require('../google/google.service');
const outlookService = require('../outlook/outlook.service');
const calendarEventsRepo = require('../calendarEvents.repository');

/** The row survives crashes and lock contention. Its version fences completion. */
export async function dispatchOutboundWork(dedupeKey: string, { refreshEntity = false } = {}) {
  let work = await repo.getOutboundWork(dedupeKey);
  if (!work) return;
  try {
    await withCalendarSyncLock(work.payload.entityType, work.payload.entityData.id, work.userId, async () => {
      work = await repo.getOutboundWork(dedupeKey);
      if (!work) return;
      const { entityType, timeZone } = work.payload;
      let { entityData, action } = work.payload;
      const assignedEntity = isAssignedEntityType(entityType);
      if ((refreshEntity || assignedEntity) && action !== 'deleteEventsFromEntity') {
        const fresh = await resolver.resolveEntity(entityType, entityData).getState();
        if (fresh) entityData = { ...entityData, ...fresh };
        else action = 'deleteEventsFromEntity';
      }
      // The work was queued for this member by the fan-out, which counts the
      // member who saved a creatorless row as its creator.
      if (assignedEntity && action !== 'deleteEventsFromEntity' && !isCalendarRecipient(entityType, entityData, work.userId, work.userId)) {
        action = 'deleteEventsFromEntity';
      }
      if (action !== 'deleteEventsFromEntity') {
        const member = await membersRepo.findByUserId(work.lawFirmId, work.userId);
        const permissions = await rolesService.resolvePermissions(work.lawFirmId, member);
        const viewPermission = entityType === 'externalEvent' ? 'calendar.view' : entityType === 'invoiceBilling' ? 'billing.viewInvoices'
          : entityType === 'clientEvent' ? 'clients.view' : entityType === 'task' ? 'tasks.view' : 'matters.view';
        const matterAccess = !entityData.matterId || await membership.isFirmOwnerOrAdmin(work.lawFirmId, work.userId)
          || (await membership.getAccessibleMatterIds(work.lawFirmId, [entityData.matterId], work.userId)).has(entityData.matterId);
        if (!permissions.includes('calendar.sync') || !permissions.includes(viewPermission) || !matterAccess) action = 'deleteEventsFromEntity';
      }
      const { userData, settings } = await tokens.getUserDataAndSettings(work.userId);
      const google = work.provider === 'google';
      const deleting = action === 'deleteEventsFromEntity';
      const syncOn = google ? settings?.allowParalegixToGoogleSync : settings?.allowParalegixToOutlookSync;
      // A grant waiting on a reconnect still owes its calendar this write. No
      // retry can succeed until the person reconnects, so the row is parked
      // without spending an attempt, and the reconnect callback releases it
      // (`releaseOutboundWorkForUser`). Only outbound sync being switched off
      // drops the work instead.
      if ((deleting || syncOn) && (google ? userData?.googleGrantLost : userData?.microsoftGrantLost)) {
        throw new OutboundGrantLostError(work.provider);
      }
      const enabled = google ? userData?.googleAccessToken && (deleting || syncOn)
        : userData?.microsoftAccessToken && (deleting || syncOn);
      if (enabled) {
        const service = google ? googleService : outlookService;
        const adapter = getAdapter(entityType);
        const mappings = await repo.listMappingsForEntityUser({ provider: work.provider, userId: work.userId, entityType, entityId: entityData.id });
        if (entityData.relocateCalendar && !deleting && entityType !== 'externalEvent') {
          if (mappings.length) {
            const removed = await service.deleteEventsFromEntity(adapter, entityData, work.userId, timeZone, { strictFailures: true });
            if (!removed) throw new Error('Could not remove the copy from the previous calendar');
          }
          const current = await resolver.resolveEntity(entityType, entityData).getState();
          if (current) entityData = { ...entityData, ...current };
        }
        const items = await adapter.toCalendarItems(entityData);
        if (items.length || mappings.length) {
          const result = await service[action](adapter, entityData, work.userId, timeZone, { strictFailures: true });
          if (!result) throw new Error(`${work.provider} did not finish the calendar write`);
        }
      }
      if (refreshEntity && entityType === 'externalEvent' && action === 'deleteEventsFromEntity') {
        const current = await resolver.resolveEntity(entityType, entityData).getState();
        if (current && !current.googleEventId && !current.outlookId) {
          await calendarEventsRepo.delete(work.lawFirmId, entityData.id);
        }
      }
      await repo.resolveOutboundWork(dedupeKey, work.leaseToken);
    });
  } catch (error) {
    if (error instanceof OutboundGrantLostError) await repo.parkOutboundWork(dedupeKey, error, work.leaseToken);
    else await repo.rescheduleOutboundWork(dedupeKey, error, work.leaseToken);
    throw error;
  }
}

/** The work needs a provider grant that is waiting on a reconnect. */
export class OutboundGrantLostError extends Error {
  constructor(provider: string) {
    super(`${provider} grant needs a reconnect; the calendar write is parked until then`);
    this.name = 'OutboundGrantLostError';
  }
}

/**
 * A connection just started working again (a connect or reconnect callback):
 * release every outbound row the person owes that provider and dispatch it. The
 * release is what matters; a dispatch that fails here is rescheduled like any
 * other and the sweep picks it up.
 */
export async function releaseOutboundWorkAfterReconnect(userId: string, provider: 'google' | 'outlook') {
  const released: string[] = await repo.releaseOutboundWorkForUser(userId, provider);
  for (const dedupeKey of released) {
    try { await dispatchOutboundWork(dedupeKey, { refreshEntity: true }); }
    catch (error: any) { console.error('Calendar outbound work released on reconnect failed:', dedupeKey, error.message); }
  }
  return released.length;
}

export async function retryFailedOutbound({ limit = 50, deadline = null }: any = {}) {
  const due = await repo.listDueOutboundWork(limit);
  let attempted = 0;
  let failed = 0;
  let parked = 0;
  for (const work of due) {
    if (deadline && Date.now() >= deadline) break;
    attempted++;
    try { await dispatchOutboundWork(work.dedupeKey, { refreshEntity: true }); }
    catch (error: any) {
      if (error instanceof OutboundGrantLostError) { parked++; continue; }
      failed++;
      console.error('Calendar outbound retry failed:', work.dedupeKey, error.message);
    }
  }

  // Rows that spent their budget are no longer selected above, so without this
  // they would sit unseen. A reconnect revives them; anything else needs a
  // person, so every sweep reports the count and a small sample.
  let deadLettered = 0;
  try {
    deadLettered = await repo.countDeadLetteredOutboundWork();
    if (deadLettered > 0) {
      const sample = await repo.listDeadLetteredOutboundWork(5);
      console.warn(
        `calendarOutboundRetry: ${deadLettered} dead-lettered outbound calendar write(s). Sample:`,
        sample.map((row: any) => ({ provider: row.provider, userId: row.userId, lastError: (row.lastError || '').slice(0, 120) })),
      );
    }
  } catch (error: any) {
    console.error('calendarOutboundRetry: failed to inspect dead-letter rows:', error.message || error);
  }

  return { attempted, succeeded: attempted - failed - parked, failed, parked, deadLettered, truncated: attempted < due.length };
}
