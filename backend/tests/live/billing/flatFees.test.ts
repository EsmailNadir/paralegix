/**
 * Flat Fees API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdMatterId: any;
let createdFlatFeeId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for flat fee tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Flat Fee Matter',
      description: 'Created by flat fees test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: delete flat fee if still exists
  if (createdFlatFeeId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/billing/flat-fees/matter/${createdMatterId}/${createdFlatFeeId}`, { token });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/billing/flat-fees', () => {
  test('creates a flat fee with valid data', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/flat-fees`, {
      token,
      body: {
        matterId: createdMatterId,
        description: '__TEST__ Flat Fee',
        amount: 500.00,
        date: new Date().toISOString(),
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.flatFeeId || res.body.flatFee?.id).toBeDefined();
    createdFlatFeeId = res.body.flatFeeId || res.body.flatFee?.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId', () => {
  test('returns flat fees for a matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/flat-fees/matter/${createdMatterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.flatFees || res.body.items).toBeDefined();
  });
});

describe('PUT /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId/:flatFeeId', () => {
  test('updates the flat fee', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/flat-fees/matter/${createdMatterId}/${createdFlatFeeId}`, {
      token,
      body: {
        description: '__TEST__ Updated Flat Fee',
        amount: 750.00,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId/:flatFeeId', () => {
  test('deletes the flat fee', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/billing/flat-fees/matter/${createdMatterId}/${createdFlatFeeId}`, { token });
    expect(res.status).toBe(200);
    createdFlatFeeId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
