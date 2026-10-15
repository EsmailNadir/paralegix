/**
 * Calendar (Google) API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 *
 * Google Calendar endpoints require OAuth tokens which the test user may not have.
 * Tests verify the endpoints respond correctly even without Google auth.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;
let lawFirmId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;

  const res = await api.get('/api/users/my-lawfirms', { token });
  expect(res.status).toBe(200);
  lawFirmId = res.body.lawFirmIds[0];
});

describe('GET /api/google-calendar-sync/silent-sync-status', () => {
  test('returns sync status', async () => {
    const res = await api.get('/api/google-calendar-sync/silent-sync-status', { token });
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
  });
});

describe('GET /api/lawfirms/:lawFirmId/clients/events', () => {
  test('returns all client events for the firm', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/events`, { token });
    expect(res.status).toBe(200);
    expect(res.body.events).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/calendar-events (calendar window)', () => {
  const dayString = (offsetDays: any) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  test('accepts a window and answers with the standard envelope', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/calendar-events?from=${dayString(0)}&to=${dayString(30)}`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.totalEvents).toBe(res.body.events.length);
  });

  test('every returned event overlaps the window', async () => {
    const from = dayString(0);
    const to = dayString(30);
    const res = await api.get(`/api/lawfirms/${lawFirmId}/calendar-events?from=${from}&to=${to}`, { token });
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      if (!event.start) continue;
      const startDay = String(event.start).slice(0, 10);
      const endDay = event.end ? String(event.end).slice(0, 10) : startDay;
      expect(startDay <= to).toBe(true);
      expect(endDay >= from).toBe(true);
    }
  });

  test('the window only ever removes events from the unwindowed read', async () => {
    const windowed = await api.get(
      `/api/lawfirms/${lawFirmId}/calendar-events?from=${dayString(0)}&to=${dayString(30)}`,
      { token },
    );
    const all = await api.get(`/api/lawfirms/${lawFirmId}/calendar-events`, { token });
    expect(windowed.status).toBe(200);
    expect(all.status).toBe(200);
    const allIds = all.body.events.map((e: any) => e.id);
    for (const event of windowed.body.events) {
      expect(allIds).toContain(event.id);
    }
    expect(windowed.body.events.length).toBeLessThanOrEqual(allIds.length);
  });

  test('rejects a malformed window', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/calendar-events?from=1st-march&to=${dayString(30)}`, { token });
    expect(res.status).toBe(400);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
