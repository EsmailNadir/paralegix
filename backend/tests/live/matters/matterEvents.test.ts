/**
 * Matter Events API - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdMatterId: any;
let createdEventId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for events tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Events Matter',
      matterNumber: 'TEST-EV-001',
      description: 'Created by events test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: delete event if still exists
  if (createdEventId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events/${createdEventId}`, { token });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/matters/:matterId/events', () => {
  test('creates a matter event', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events`, {
      token,
      body: {
        type: 'hearing',
        title: '__TEST__ Integration Test Hearing',
        date: futureDate.toISOString(),
        notes: 'Created by automated test - safe to delete',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.eventId).toBeDefined();
    createdEventId = res.body.eventId;
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/:matterId/events', () => {
  test('returns list of matter events', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/events', () => {
  test('returns all events across matters (calendar view)', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/events`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId', () => {
  test('updates the event title', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events/${createdEventId}`, {
      token,
      body: {
        title: '__TEST__ Updated Hearing Title',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.event?.title).toBe('__TEST__ Updated Hearing Title');
  });

  test('updates event notes', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events/${createdEventId}`, {
      token,
      body: {
        notes: '__TEST__ Updated notes for the hearing.',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId', () => {
  test('deletes the event', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events/${createdEventId}`, { token });
    expect(res.status).toBe(200);
    createdEventId = null;
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/events (calendar window)', () => {
  const dayString = (offsetDays: any) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  let inWindowEventId: any;
  let outOfWindowEventId: any;

  beforeAll(async () => {
    const inWindow = new Date();
    inWindow.setDate(inWindow.getDate() + 3);
    const outOfWindow = new Date();
    outOfWindow.setDate(outOfWindow.getDate() + 400);

    const a = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events`, {
      token,
      body: { type: 'hearing', title: '__TEST__ In Window', date: inWindow.toISOString() },
    });
    expect(a.status).toBe(201);
    inWindowEventId = a.body.eventId;

    const b = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events`, {
      token,
      body: { type: 'hearing', title: '__TEST__ Out Of Window', date: outOfWindow.toISOString() },
    });
    expect(b.status).toBe(201);
    outOfWindowEventId = b.body.eventId;
  });

  afterAll(async () => {
    for (const id of [inWindowEventId, outOfWindowEventId]) {
      if (id) {
        await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/events/${id}`, { token });
      }
    }
  });

  test('returns only events inside the requested window', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/events?from=${dayString(0)}&to=${dayString(30)}`,
      { token },
    );
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(inWindowEventId);
    expect(ids).not.toContain(outOfWindowEventId);
  });

  test('returns everything when no window is supplied', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/events`, { token });
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(inWindowEventId);
    expect(ids).toContain(outOfWindowEventId);
  });

  test('rejects a malformed window', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/events?from=03-01-2026&to=${dayString(30)}`, { token });
    expect(res.status).toBe(400);
  });

  test('carries the matter name on each event', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/events?from=${dayString(0)}&to=${dayString(30)}`,
      { token },
    );
    const found = res.body.events.find((e: any) => e.id === inWindowEventId);
    expect(found).toBeDefined();
    expect(found.matterName).toBe('__TEST__ Events Matter');
    expect(Array.isArray(found.clientNames)).toBe(true);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
