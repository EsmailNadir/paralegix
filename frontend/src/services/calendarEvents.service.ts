import { getUserTimeZone } from '@/lib/utils/timezone';
import BaseApiService from './base.service';
import type { Event, PaymentDate, Task } from '@/types';
import type { MatterEvent } from '@/types/matterEvent';
import type { ClientEvent } from '@/types/clientEvent';

export interface ExternalEventsResponse {
  events: Event[];
  totalEvents: number;
}

export interface ExternalEventUpdate {
  title?: string;
  notes?: string | null;
  location?: string | null;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  confirmNotifyAttendees?: boolean;
}

/**
 * Every dataset the firm calendar draws for one window, in one response.
 *
 * Each section is byte-identical to the body of the endpoint it replaces for the
 * same window (`/matters/events`, `/clients/events`, `/calendar-events`,
 * `/tasks?dueFrom&dueTo`, `/billing/invoices/calendar-payment-dates`), or null
 * when the member lacks that section's view permission.
 */
export interface CalendarFeedResponse {
  matterEvents: { events: MatterEvent[]; totalEvents: number } | null;
  clientEvents: { events: ClientEvent[]; totalEvents: number } | null;
  calendarEvents: { events: Event[]; totalEvents: number } | null;
  tasks: { tasks: Task[]; totalTasks: number } | null;
  paymentDates: { paymentDates: PaymentDate[] } | null;
}

class CalendarEventsService extends BaseApiService {
  constructor() {
    super('lawfirms');
  }

  async listExternalEvents(lawFirmId: string, window?: { from: string; to: string }): Promise<ExternalEventsResponse> {
    const url = new URL(this.url(lawFirmId, 'calendar-events'));
    url.searchParams.set('tz', getUserTimeZone());
    if (window) {
      url.searchParams.set('from', window.from);
      url.searchParams.set('to', window.to);
    }
    return this.dedupedGet(url.toString(), { errorMessage: 'Failed to load calendar events' });
  }

  getCalendarFeed(lawFirmId: string, window: { from: string; to: string }): Promise<CalendarFeedResponse> {
    const url = new URL(this.url(lawFirmId, 'calendar-feed'));
    url.searchParams.set('from', window.from);
    url.searchParams.set('to', window.to);
    url.searchParams.set('tz', getUserTimeZone());
    return this.dedupedGet(url.toString(), { errorMessage: 'Failed to load the calendar' });
  }

  updateExternalEvent(lawFirmId: string, eventId: string, updates: ExternalEventUpdate): Promise<{ event: Event }> {
    return this.request(this.url(lawFirmId, 'calendar-events', eventId), {
      method: 'PUT', body: updates, errorMessage: 'Failed to update external event',
    });
  }

  deleteExternalEvent(lawFirmId: string, eventId: string): Promise<{ message: string }> {
    return this.request(this.url(lawFirmId, 'calendar-events', eventId), {
      method: 'DELETE', errorMessage: 'Failed to delete external event',
    });
  }
}

const calendarEventsService = new CalendarEventsService();
export default calendarEventsService;
