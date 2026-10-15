/**
 * The calendar external events service, tested OFFLINE against a fake transport.
 *
 * Unmocks calendarEvents.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, timezone parameter, date window construction,
 * tenant scoping, and ApiError translation without a running backend.
 */
jest.unmock('@/services/calendarEvents.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import calendarEventsService from '@/services/calendarEvents.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const EVENT_ID = 'evt-99';

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('calendarEventsService.listExternalEvents', () => {
  it('requests calendar events with user timezone query parameter', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events`, {
      events: [{ id: EVENT_ID, title: 'Deposition of Expert' }],
      totalEvents: 1,
    });

    const res = await calendarEventsService.listExternalEvents(LAW_FIRM_ID);

    expect(res.events).toHaveLength(1);
    expect(res.events[0].id).toBe(EVENT_ID);

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('tz')).toBe(getUserTimeZone());
  });

  it('attaches from and to parameters when window is provided', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events`, {
      events: [],
      totalEvents: 0,
    });

    await calendarEventsService.listExternalEvents(LAW_FIRM_ID, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('from')).toBe('2026-09-01T00:00:00Z');
    expect(params.get('to')).toBe('2026-09-30T23:59:59Z');
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/calendar-events`, {
      events: [],
      totalEvents: 0,
    });

    await calendarEventsService.listExternalEvents(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/calendar-events`);
  });
});

describe('calendarEventsService.updateExternalEvent', () => {
  it('sends PUT with updates payload and returns event', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`, {
      event: { id: EVENT_ID, title: 'Rescheduled Deposition', allDay: false },
    });

    const res = await calendarEventsService.updateExternalEvent(LAW_FIRM_ID, EVENT_ID, {
      title: 'Rescheduled Deposition',
      allDay: false,
    });

    expect(res.event.title).toBe('Rescheduled Deposition');
    const call = api.calls('PUT')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`);
    expect(bodyOf(call)).toEqual({ title: 'Rescheduled Deposition', allDay: false });
  });

  it('surfaces ApiError when update fails', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`, {
      status: 404,
      body: { error: 'Event not found' },
    });

    await expect(
      calendarEventsService.updateExternalEvent(LAW_FIRM_ID, EVENT_ID, { title: 'Ghost' })
    ).rejects.toThrow(ApiError);
  });
});

describe('calendarEventsService.deleteExternalEvent', () => {
  it('sends DELETE to event url and returns message', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`, {
      message: 'Event deleted successfully',
    });

    const res = await calendarEventsService.deleteExternalEvent(LAW_FIRM_ID, EVENT_ID);

    expect(res.message).toBe('Event deleted successfully');
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`);
  });

  it('surfaces ApiError when delete is rejected', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/calendar-events/${EVENT_ID}`, {
      status: 403,
      body: { error: 'Unauthorized to delete sync event' },
    });

    await expect(
      calendarEventsService.deleteExternalEvent(LAW_FIRM_ID, EVENT_ID)
    ).rejects.toThrow(ApiError);
  });
});
