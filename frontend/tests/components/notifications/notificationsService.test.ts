/**
 * The notifications service, tested OFFLINE against a fake transport.
 *
 * Unmocks notifications.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, query-parameter construction, tenant segmentation,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/notifications.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import notificationsService from '@/services/notifications.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const NOTIFICATION_ID = 'notif-99';

const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('notificationsService.list', () => {
  it('requests the firm notification list with no extra query params when opts omitted', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notifications`, {
      notifications: [{ id: NOTIFICATION_ID, title: 'Task assigned', read: false }],
      total: 1,
    });

    const res = await notificationsService.list(LAW_FIRM_ID);

    expect(res.notifications).toHaveLength(1);
    expect(res.notifications[0].id).toBe(NOTIFICATION_ID);
    expect(res.total).toBe(1);

    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications`);
  });

  it('assembles filters and pagination cursor into query parameters', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notifications`, {
      notifications: [],
      total: 0,
      nextBefore: null,
      nextBeforeId: null,
    });

    await notificationsService.list(LAW_FIRM_ID, {
      unreadOnly: true,
      types: ['task', 'matter'],
      limit: 25,
      before: '2026-09-01T12:00:00Z',
      beforeId: 'notif-10',
    });

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);

    expect(params.get('unreadOnly')).toBe('true');
    expect(params.get('types')).toBe('task,matter');
    expect(params.get('limit')).toBe('25');
    expect(params.get('before')).toBe('2026-09-01T12:00:00Z');
    expect(params.get('beforeId')).toBe('notif-10');
  });

  it('scopes the request to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/notifications`, {
      notifications: [],
      total: 0,
    });

    await notificationsService.list(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/notifications`);
  });
});

describe('notificationsService.getUnreadCount', () => {
  it('calls the count endpoint and unwraps the unread count', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notifications/count`, {
      unreadCount: 7,
    });

    const res = await notificationsService.getUnreadCount(LAW_FIRM_ID);

    expect(res.unreadCount).toBe(7);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications/count`);
  });
});

describe('notificationsService.getFeed', () => {
  it('requests the feed endpoint with unreadOnly and limit', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notifications/feed`, {
      notifications: [{ id: NOTIFICATION_ID, title: 'Invoice paid', read: false }],
      total: 1,
      unreadCount: 1,
    });

    const res = await notificationsService.getFeed(LAW_FIRM_ID, {
      unreadOnly: true,
      limit: 10,
    });

    expect(res.notifications).toHaveLength(1);
    expect(res.unreadCount).toBe(1);

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('unreadOnly')).toBe('true');
    expect(params.get('limit')).toBe('10');
  });
});

describe('notificationsService.markRead', () => {
  it('sends POST to /read and returns success message', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}/read`, {
      message: 'Notification marked as read',
    });

    const res = await notificationsService.markRead(LAW_FIRM_ID, NOTIFICATION_ID);

    expect(res.message).toBe('Notification marked as read');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}/read`);
  });

  it('surfaces ApiError when the read mutation fails', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}/read`, {
      status: 404,
      body: { error: 'Notification not found' },
    });

    await expect(notificationsService.markRead(LAW_FIRM_ID, NOTIFICATION_ID))
      .rejects
      .toThrow(ApiError);
  });
});

describe('notificationsService.markUnread', () => {
  it('sends POST to /unread and returns success message', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}/unread`, {
      message: 'Notification marked as unread',
    });

    const res = await notificationsService.markUnread(LAW_FIRM_ID, NOTIFICATION_ID);

    expect(res.message).toBe('Notification marked as unread');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}/unread`);
  });
});

describe('notificationsService.markAllRead', () => {
  it('sends POST to /mark-all-read and returns updated row count', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/notifications/mark-all-read`, {
      message: 'All notifications marked as read',
      updated: 14,
    });

    const res = await notificationsService.markAllRead(LAW_FIRM_ID);

    expect(res.updated).toBe(14);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications/mark-all-read`);
  });
});

describe('notificationsService.remove', () => {
  it('sends DELETE to notification URL and returns success message', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}`, {
      message: 'Notification removed',
    });

    const res = await notificationsService.remove(LAW_FIRM_ID, NOTIFICATION_ID);

    expect(res.message).toBe('Notification removed');
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}`);
  });

  it('surfaces ApiError when DELETE is rejected', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/notifications/${NOTIFICATION_ID}`, {
      status: 403,
      body: { error: 'Not allowed to delete this notification' },
    });

    await expect(notificationsService.remove(LAW_FIRM_ID, NOTIFICATION_ID))
      .rejects
      .toThrow(ApiError);
  });
});
