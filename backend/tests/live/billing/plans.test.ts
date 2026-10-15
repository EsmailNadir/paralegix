/**
 * Billing Plans API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdMatterId: any;
let createdPlanId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for plan tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Plans Matter',
      description: 'Created by plans test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: end the plan if still exists
  if (createdPlanId && lawFirmId) {
    await api.put(`/api/lawfirms/${lawFirmId}/billing/plans/${createdPlanId}`, {
      token,
      body: { status: 'ended' },
    });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('GET /api/lawfirms/:lawFirmId/billing/plans', () => {
  test('returns list of billing plans', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/plans`, { token });
    expect(res.status).toBe(200);
    expect(res.body.plans || res.body.items).toBeDefined();
  });
});

describe('POST /api/lawfirms/:lawFirmId/billing/plans', () => {
  test('creates a billing plan (retainer)', async () => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);

    const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/plans`, {
      token,
      body: {
        contextType: 'matter',
        entityId: createdMatterId,
        planType: 'retainer',
        name: '__TEST__ Retainer Plan',
        intervalUnit: 'month',
        intervalCount: 1,
        startDate: startDate.toISOString(),
        amount: 5000,
        includedHours: 10,
        billingEmail: null,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.planId || res.body.plan?.id).toBeDefined();
    createdPlanId = res.body.planId || res.body.plan?.id;
  });
});

describe('PUT /api/lawfirms/:lawFirmId/billing/plans/:planId', () => {
  test('updates the plan name', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/plans/${createdPlanId}`, {
      token,
      body: {
        name: '__TEST__ Updated Retainer Plan',
        amount: 6000,
      },
    });
    expect(res.status).toBe(200);
  });

  test('pauses the plan', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/plans/${createdPlanId}`, {
      token,
      body: { status: 'paused' },
    });
    expect(res.status).toBe(200);
  });

  test('ends the plan (cleanup)', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/plans/${createdPlanId}`, {
      token,
      body: { status: 'ended' },
    });
    expect(res.status).toBe(200);
    createdPlanId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
