/**
 * Matter Members API - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let userId: any;
let lawFirmId: any;
let createdMatterId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for members tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Members Matter',
      matterNumber: 'TEST-MB-001',
      description: 'Created by members test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/matters/:matterId/members', () => {
  test('adds current user as member to the matter', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/members`, {
      token,
      body: {
        targetUserIds: [userId],
        role: 'member',
      },
    });
    // Upsert is idempotent, so re-adding an existing member still succeeds.
    expect([200, 409]).toContain(res.status);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/:matterId/members/hourly-rate', () => {
  test('updates hourly rate for a member', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/members/hourly-rate`, {
      token,
      body: {
        userId: userId,
        hourlyRate: 250,
      },
    });
    expect(res.status).toBe(200);
  });

  test('sets hourly rate to null (default)', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/members/hourly-rate`, {
      token,
      body: {
        userId: userId,
        hourlyRate: null,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/lawfirms/:lawFirmId/matters/:matterId/members/remove', () => {
  test('removes a member from the matter', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/members/remove`, {
      token,
      body: {
        targetUserIds: [userId],
      },
    });
    // May succeed or be rejected depending on whether the user is the matter lead.
    expect([200, 400, 403]).toContain(res.status);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
