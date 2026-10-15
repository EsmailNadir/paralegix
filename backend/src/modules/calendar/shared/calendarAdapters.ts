const {
  buildTaskCalendarDescription,
  buildMatterEventCalendarDescription,
  buildClientEventCalendarDescription,
  buildExternalEventCalendarDescription,
  buildBillingCalendarDescription,
} = require('./calendarDescriptionBuilder');
const {
  ensureInvoicePaymentPlanIds,
  getBillingCalendarItems,
  getInvoiceRemainingBalance,
  getBillingProviderEventId,
  getBillingOutlookChangeKey,
  listBillingProviderSyncKeys,
} = require('../../billing/shared/billingCalendar');
const { taskDueInstant } = require('../../tasks/taskDue');

/**
 * Calendar adapter registry.
 *
 * Each adapter normalizes a domain entity (task, matter, …) into an array of
 * "calendar items" that the Google / Outlook services can create, update, or
 * delete without knowing anything about the source entity.
 *
 * The `build*Writeback()` methods return NORMALIZED DESCRIPTORS (plain objects,
 * not dotted-path write sentinels). The sync engines resolve a typed entity
 * ref and hand the descriptor to that repo's `applyCalendarSync(...)`, which
 * mutates the relational `calendar_sync` jsonb map / columns via real SQL.
 *
 *   { op:'setKey',    provider, userId, key, eventId, changeKey? }
 *   { op:'deleteKey',  provider, userId, key }
 *   { op:'touch',      provider }
 *   { op:'setField',   field, value }     (scalar provider-id column)
 *   { op:'deleteField', field }
 *
 * Adding a new entity type is a two-step process:
 *   1. Add an adapter here.
 *   2. Listen for the entity's events in calendar.events.ts.
 */

// Per-user-map adapters (task / matterEvent / clientEvent) share identical
// calendar_sync read + writeback descriptor logic.
function perUserSyncMethods() {
  return {
    getGoogleEventId(data: any, key: any, userId: string) {
      return data?.calendarSync?.google?.[userId]?.[key]?.eventId || null;
    },
    getOutlookEventId(data: any, key: any, userId: string) {
      return data?.calendarSync?.outlook?.[userId]?.[key]?.eventId || null;
    },
    getOutlookChangeKey(data: any, key: any, userId: string) {
      return data?.calendarSync?.outlook?.[userId]?.[key]?.changeKey || null;
    },
    listGoogleSyncKeys(data: any, userId: string) {
      return Object.keys(data?.calendarSync?.google?.[userId] || {});
    },
    listOutlookSyncKeys(data: any, userId: string) {
      return Object.keys(data?.calendarSync?.outlook?.[userId] || {});
    },

    buildGoogleWriteback(key: any, eventId: string, userId: string) {
      return { op: 'setKey', provider: 'google', userId, key, eventId };
    },
    buildGoogleUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'google' };
    },
    buildGoogleDeleteWriteback(key: any, userId: string) {
      return { op: 'deleteKey', provider: 'google', userId, key };
    },
    buildOutlookWriteback(key: any, eventId: string, changeKey: any, userId: string) {
      return { op: 'setKey', provider: 'outlook', userId, key, eventId, changeKey: changeKey || null };
    },
    buildOutlookUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'outlook' };
    },
    buildOutlookDeleteWriteback(key: any, userId: string) {
      return { op: 'deleteKey', provider: 'outlook', userId, key };
    },
  };
}

export const ADAPTERS = {
  // ── Task adapter ────────────────────────────────────────────
  task: {
    entityType: 'task',
    sourceMarker: 'Task from Paralegix',

    async toCalendarItems(entityData: any) {
      if (!entityData.dueDate || entityData.status === 'completed') return [];
      return [{
        key: 'dueDate',
        summary: entityData.title,
        description: await buildTaskCalendarDescription(entityData, '(Task from Paralegix)'),
        // A saved task carries its day in `dueDate` and its time in `dueAt`;
        // built from the day alone, a timed task landed at midnight UTC.
        dateTime: taskDueInstant(entityData),
        // The task's own end when it has one, else the engine's one-hour block.
        end: entityData.endsAt || null,
        timeZone: entityData.dueDateTimeZone || null,
        location: entityData.location || null,
        // Inbound sync never reads a task's location back, so a location the
        // member added in the provider is theirs. An update leaves it in place
        // unless this save cleared a location Paralegix had set.
        keepProviderLocation: entityData.locationCleared !== true,
        allDay: Boolean(entityData.allDay),
      }];
    },

    ...perUserSyncMethods(),
  },

  // ── Matter Event adapter ──────────────────────────────────────
  matterEvent: {
    entityType: 'matterEvent',
    sourceMarker: 'Matter event from Paralegix',

    async toCalendarItems(entityData: any) {
      if (!entityData.date || entityData.status === 'cancelled' || entityData.status === 'completed') return [];
      return [{
        key: 'event',
        summary: entityData.title,
        description: await buildMatterEventCalendarDescription(entityData, '(Matter event from Paralegix)'),
        dateTime: entityData.date,
        // The event's real end when it has one. Without it the engine falls
        // back to a one-hour block, which is why an all-afternoon hearing used
        // to reach Google and Outlook as an hour (migration 0220).
        end: entityData.endsAt || null,
        timeZone: entityData.timeZone || null,
        location: entityData.location || entityData.locationName || null,
        allDay: Boolean(entityData.allDay),
      }];
    },

    ...perUserSyncMethods(),
  },

  // ── Client Event adapter ────────────────────────────────────
  clientEvent: {
    entityType: 'clientEvent',
    sourceMarker: 'Client event from Paralegix',

    async toCalendarItems(entityData: any) {
      if (!entityData.date || entityData.status === 'cancelled' || entityData.status === 'completed') return [];
      return [{
        key: 'event',
        summary: entityData.title,
        description: await buildClientEventCalendarDescription(entityData, '(Client event from Paralegix)'),
        dateTime: entityData.date,
        // The event's real end when it has one. Without it the engine falls
        // back to a one-hour block, which is why an all-afternoon hearing used
        // to reach Google and Outlook as an hour (migration 0220).
        end: entityData.endsAt || null,
        timeZone: entityData.timeZone || null,
        location: entityData.location || entityData.courtName || entityData.locationName || null,
        allDay: Boolean(entityData.allDay),
      }];
    },

    ...perUserSyncMethods(),
  },

  // ── External Calendar Event adapter ───────────────────────
  // External events store provider ids in simple columns (no per-user map).
  externalEvent: {
    entityType: 'externalEvent',
    sourceMarker: 'External event from Paralegix',

    async toCalendarItems(entityData: any) {
      if (!entityData.start) return [];
      return [{
        key: 'external',
        summary: entityData.title,
        description: await buildExternalEventCalendarDescription(entityData, '(External event from Paralegix)'),
        dateTime: entityData.start,
        // Carry the event's end so cross-provider sync preserves its real
        // duration (timed) / span (all-day) instead of defaulting to +1h / +1day.
        end: entityData.end || null,
        timeZone: entityData.startTimeZone || null,
        location: entityData.location || null,
        allDay: Boolean(entityData.allDay),
        // A private meeting's copy in the other provider stays private. The
        // source provider is carried so its own event is never rewritten.
        isPrivate: entityData.meeting?.isPrivate === true,
        sourceProvider: entityData.provider || null,
      }];
    },

    getGoogleEventId(data: any, _key: any) { return data.googleEventId || null; },
    getOutlookEventId(data: any, _key: any) { return data.outlookId || null; },
    getOutlookChangeKey(data: any, _key: any) { return data.outlookChangeKey || null; },

    buildGoogleWriteback(_key: any, eventId: string) {
      return { op: 'setField', field: 'googleEventId', value: eventId, provider: 'google', touch: true };
    },
    buildGoogleDeleteWriteback(_key: any) {
      return { op: 'deleteField', field: 'googleEventId' };
    },
    buildGoogleUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'google' };
    },
    buildOutlookWriteback(_key: any, eventId: string, changeKey: any) {
      return {
        op: 'setFields',
        provider: 'outlook',
        fields: { outlookId: eventId, outlookChangeKey: changeKey },
        touch: true,
      };
    },
    buildOutlookDeleteWriteback(_key: any) {
      return { op: 'setFields', fields: { outlookId: null, outlookChangeKey: null } };
    },
    buildOutlookUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'outlook' };
    },
  },

  // ── Invoice billing adapter ─────────────────────────────────
  invoiceBilling: {
    entityType: 'invoiceBilling',
    sourceMarker: 'Billing item from Paralegix',

    async toCalendarItems(entityData: any) {
      const { invoice } = ensureInvoicePaymentPlanIds(entityData);
      const billingItems = getBillingCalendarItems(invoice);
      const remainingBalance = getInvoiceRemainingBalance(invoice);

      return Promise.all(
        billingItems.map(async (item: any) => ({
          key: item.key,
          summary: item.billingItemType === 'installment'
            ? `Billing: ${invoice.invoiceName || invoice.invoiceNumber || 'Invoice'} installment`
            : `Billing: ${invoice.invoiceName || invoice.invoiceNumber || 'Invoice'} due`,
          description: await buildBillingCalendarDescription(
            {
              ...invoice,
              remainingBalance,
            },
            item,
            '(Billing item from Paralegix)',
          ),
          dateTime: item.scheduledDate,
          allDay: true,
        })),
      );
    },

    getGoogleEventId(data: any, key: any, userId: string) {
      return getBillingProviderEventId(data, 'google', userId, key);
    },
    getOutlookEventId(data: any, key: any, userId: string) {
      return getBillingProviderEventId(data, 'outlook', userId, key);
    },
    getOutlookChangeKey(data: any, key: any, userId: string) {
      return getBillingOutlookChangeKey(data, userId, key);
    },
    listGoogleSyncKeys(data: any, userId: string) {
      return listBillingProviderSyncKeys(data, 'google', userId);
    },
    listOutlookSyncKeys(data: any, userId: string) {
      return listBillingProviderSyncKeys(data, 'outlook', userId);
    },
    buildGoogleWriteback(key: any, eventId: string, userId: string) {
      return { op: 'setKey', provider: 'google', userId, key, eventId };
    },
    buildGoogleUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'google' };
    },
    buildGoogleDeleteWriteback(key: any, userId: string) {
      return { op: 'deleteKey', provider: 'google', userId, key };
    },
    buildOutlookWriteback(key: any, eventId: string, changeKey: any, userId: string) {
      return { op: 'setKey', provider: 'outlook', userId, key, eventId, changeKey: changeKey || null };
    },
    buildOutlookUpdateWriteback(_key: any) {
      return { op: 'touch', provider: 'outlook' };
    },
    buildOutlookDeleteWriteback(key: any, userId: string) {
      return { op: 'deleteKey', provider: 'outlook', userId, key };
    },
  },
};

/**
 * Look up an adapter by entity type.
 * @param {'task'|'matterEvent'|'clientEvent'|'externalEvent'|'invoiceBilling'} entityType
 */
export function getAdapter(entityType: any) {
  const adapter = (ADAPTERS as Record<string, any>)[entityType];
  if (!adapter) throw new Error(`No calendar adapter for entity type: ${entityType}`);
  return adapter;
}
