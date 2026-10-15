/**
 * Client Events API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdClientId: any;
let createdEventId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test client to attach events to
  const clientRes = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
    token,
    body: { name: '__TEST__ Event Client' },
  });
  expect(clientRes.status).toBe(201);
  createdClientId = clientRes.body.clientId;
});

afterAll(async () => {
  if (createdEventId && createdClientId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}/events/${createdEventId}`, { token });
  }
  if (createdClientId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/clients/:clientId/events', () => {
  test('creates a client event', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}/events`, {
      token,
      body: {
        type: 'hearing',
        title: '__TEST__ Client Event',
        date: '2026-06-15',
        notes: 'Test event created by integration test',
      },
    });

    expect(res.status).toBe(201);
    createdEventId = res.body.eventId;
    expect(createdEventId).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/clients/:clientId/events', () => {
  test('lists client events', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}/events`, { token });
    expect(res.status).toBe(200);
    expect(res.body.events).toBeDefined();
  });
});

describe('PUT /api/lawfirms/:lawFirmId/clients/:clientId/events/:eventId', () => {
  test('updates an event title', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}/events/${createdEventId}`, {
      token,
      body: { source: 'client', title: '__TEST__ Updated Event Title' },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/clients/:clientId/events/:eventId', () => {
  test('deletes the event', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/clients/${createdClientId}/events/${createdEventId}`, { token });
    expect(res.status).toBe(200);
    createdEventId = null;
  });
});

describe('GET /api/lawfirms/:lawFirmId/clients/events (calendar window)', () => {
  const dayString = (offsetDays: any) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  const isoIn = (offsetDays: any) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString();
  };

  let windowClientId: any;
  let inWindowEventId: any;
  let outOfWindowEventId: any;

  beforeAll(async () => {
    const clientRes = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
      token,
      body: { name: '__TEST__ Client Events Window Client', email: `test-client-events-${Date.now()}@example.com` },
    });
    expect(clientRes.status).toBe(201);
    windowClientId = clientRes.body.clientId;

    const a = await api.post(`/api/lawfirms/${lawFirmId}/clients/${windowClientId}/events`, {
      token,
      body: { type: 'meeting', title: '__TEST__ Client In Window', date: isoIn(3) },
    });
    expect(a.status).toBe(201);
    inWindowEventId = a.body.eventId;

    const b = await api.post(`/api/lawfirms/${lawFirmId}/clients/${windowClientId}/events`, {
      token,
      body: { type: 'meeting', title: '__TEST__ Client Out Of Window', date: isoIn(400) },
    });
    expect(b.status).toBe(201);
    outOfWindowEventId = b.body.eventId;
  });

  afterAll(async () => {
    for (const id of [inWindowEventId, outOfWindowEventId]) {
      if (id) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${windowClientId}/events/${id}`, { token });
    }
    if (windowClientId) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${windowClientId}`, { token });
  });

  test('returns only events inside the requested window', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/events?from=${dayString(0)}&to=${dayString(30)}`,
      { token },
    );
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(inWindowEventId);
    expect(ids).not.toContain(outOfWindowEventId);
  });

  test('returns everything when no window is supplied', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/events`, { token });
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(inWindowEventId);
    expect(ids).toContain(outOfWindowEventId);
  });

  test('rejects a malformed window', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/events?from=not-a-date&to=${dayString(30)}`, { token });
    expect(res.status).toBe(400);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
