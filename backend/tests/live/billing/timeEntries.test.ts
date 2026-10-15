/**
 * Time Entries API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let userId: any;
let lawFirmId: any;
let createdMatterId: any;
let createdTimeEntryId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for time entry tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Time Entry Matter',
      description: 'Created by time entries test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: delete time entry if still exists
  if (createdTimeEntryId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/billing/time-entries/matter/${createdMatterId}/${createdTimeEntryId}`, { token });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/billing/time-entries', () => {
  test('creates a time entry with valid data', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/time-entries`, {
      token,
      body: {
        matterId: createdMatterId,
        userId: userId,
        hours: 1.5,
        date: new Date().toISOString(),
        name: '__TEST__ Time Entry',
        description: 'Integration test time entry - safe to delete',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.timeEntryId || res.body.timeEntry?.id).toBeDefined();
    createdTimeEntryId = res.body.timeEntryId || res.body.timeEntry?.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId', () => {
  test('returns time entries for a matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/time-entries/matter/${createdMatterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.timeEntries || res.body.items).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/time-entries/firm', () => {
  test('returns all firm time entries', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/time-entries/firm`, { token });
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId/:timeEntryId', () => {
  test('updates the time entry hours', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/time-entries/matter/${createdMatterId}/${createdTimeEntryId}`, {
      token,
      body: {
        hours: 2.0,
        description: '__TEST__ Updated time entry description',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId/:timeEntryId', () => {
  test('deletes the time entry', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/billing/time-entries/matter/${createdMatterId}/${createdTimeEntryId}`, { token });
    expect(res.status).toBe(200);
    createdTimeEntryId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
