import type { MatterEvent } from '@/types/matterEvent';
import type { ClientEvent } from '@/types/clientEvent';

/**
 * One item of the batch "sync existing events" request. A matter event is named
 * by `matterId`, a client event by `clientId`; the backend reads the row itself
 * and takes the schedule from it.
 */
export interface ExistingEventSyncItem {
  eventId: string;
  matterId?: string;
  clientId?: string;
  lawFirmId: string;
  title: string;
  notes: string | null;
  location: string | null;
  date: string;
  type: string;
}

/**
 * Every dated matter and client event, shaped for the batch sync routes.
 *
 * A matter event already carrying this provider's id is left out. Client events
 * carry no such id, so the backend's own "already on this calendar" check is
 * what stops a second copy of one. A row from the client list that is really a
 * matter event is left out too, since the matter list already holds it.
 */
export function buildExistingEventsPayload(
  lawFirmId: string,
  matterEvents: MatterEvent[],
  clientEvents: ClientEvent[],
  providerIdKey: 'googleEventId' | 'outlookId',
): ExistingEventSyncItem[] {
  const fromMatters = matterEvents
    .filter((e) => e.date && !e[providerIdKey])
    .map((e) => ({
      eventId: e.id,
      matterId: e.matterId,
      lawFirmId: e.lawFirmId ?? lawFirmId,
      title: e.title,
      notes: e.notes ?? null,
      location: e.location ?? null,
      date: e.date as string,
      type: e.type,
    }));
  const fromClients = clientEvents
    .filter((e) => e.date && e.clientId && e.source !== 'matter')
    .map((e) => ({
      eventId: e.id,
      clientId: e.clientId as string,
      lawFirmId: e.lawFirmId ?? lawFirmId,
      title: e.title,
      notes: e.notes ?? null,
      location: e.location ?? null,
      date: e.date as string,
      type: e.type,
    }));
  return [...fromMatters, ...fromClients];
}
