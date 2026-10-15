/**
 * Trust Accounts API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdAccountId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  if (createdAccountId && lawFirmId) {
    // Try to deactivate first (may fail if balance > 0), then clean up is best-effort
    await api.patch(`/api/lawfirms/${lawFirmId}/trust/accounts/${createdAccountId}/status`, {
      token,
      body: { status: 'inactive' },
    });
  }
});

describe('POST /api/lawfirms/:lawFirmId/trust/accounts', () => {
  test('creates a trust account', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/trust/accounts`, {
      token,
      body: {
        name: '__TEST__ Trust Account',
        bankName: '__TEST__ First National',
        accountNumberLast4: '9999',
        routingNumberLast4: '8888',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.account).toBeDefined();
    createdAccountId = res.body.account.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/trust/accounts', () => {
  test('lists trust accounts', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/accounts`, { token });
    expect(res.status).toBe(200);
    expect(res.body.accounts).toBeDefined();
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe('GET /api/lawfirms/:lawFirmId/trust/accounts/:accountId', () => {
  test('returns a single account', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/accounts/${createdAccountId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.account).toBeDefined();
  });
});

describe('PUT /api/lawfirms/:lawFirmId/trust/accounts/:accountId', () => {
  test('updates account name', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/trust/accounts/${createdAccountId}`, {
      token,
      body: { name: '__TEST__ Updated Trust Account' },
    });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/lawfirms/:lawFirmId/trust/accounts/:accountId/status', () => {
  test('closes (deactivates) account with zero balance', async () => {
    const res = await api.patch(`/api/lawfirms/${lawFirmId}/trust/accounts/${createdAccountId}/status`, {
      token,
      body: { status: 'inactive' },
    });
    expect(res.status).toBe(200);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
