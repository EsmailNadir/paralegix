/**
 * Charge Codes API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdChargeCodeId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  // Clean up: delete charge code if still exists
  if (createdChargeCodeId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/billing/charge-codes/${createdChargeCodeId}`, { token });
  }
});

describe('GET /api/lawfirms/:lawFirmId/billing/charge-codes', () => {
  test('returns list of charge codes', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/charge-codes`, { token });
    expect(res.status).toBe(200);
    expect(res.body.chargeCodes || res.body.items).toBeDefined();
  });
});

describe('POST /api/lawfirms/:lawFirmId/billing/charge-codes', () => {
  test('creates a new charge code', async () => {
    // Use a unique code to avoid conflicts
    const code = `TST${Date.now().toString().slice(-4)}`;

    const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/charge-codes`, {
      token,
      body: {
        code: code,
        name: '__TEST__ Charge Code',
        defaultRate: 150,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.chargeCodeId || res.body.chargeCode?.id).toBeDefined();
    createdChargeCodeId = res.body.chargeCodeId || res.body.chargeCode?.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId', () => {
  test('returns a single charge code', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/charge-codes/${createdChargeCodeId}`, { token });
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId', () => {
  test('updates the charge code', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/billing/charge-codes/${createdChargeCodeId}`, {
      token,
      body: {
        name: '__TEST__ Updated Charge Code',
        defaultRate: 200,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId', () => {
  test('deletes the charge code', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/billing/charge-codes/${createdChargeCodeId}`, { token });
    expect(res.status).toBe(200);
    createdChargeCodeId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
