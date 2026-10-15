/**
 * Trust Transactions API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let testAccountId: any;
let testClientId: any;
let depositTxnId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a trust account for transactions
  const acctRes = await api.post(`/api/lawfirms/${lawFirmId}/trust/accounts`, {
    token,
    body: {
      name: '__TEST__ Txn Trust Account',
      bankName: '__TEST__ Bank',
      accountNumberLast4: '1111',
    },
  });
  expect(acctRes.status).toBe(201);
  testAccountId = acctRes.body.account.id;

  // Create a test client
  const clientRes = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
    token,
    body: { name: '__TEST__ Trust Txn Client' },
  });
  expect(clientRes.status).toBe(201);
  testClientId = clientRes.body.clientId;
});

afterAll(async () => {
  // Void the deposit if created
  if (depositTxnId && lawFirmId) {
    await api.patch(`/api/lawfirms/${lawFirmId}/trust/transactions/${depositTxnId}/void`, {
      token,
      body: { voidReason: '__TEST__ cleanup' },
    });
  }
  // Deactivate the trust account
  if (testAccountId && lawFirmId) {
    await api.patch(`/api/lawfirms/${lawFirmId}/trust/accounts/${testAccountId}/status`, {
      token,
      body: { status: 'inactive' },
    });
  }
  // Delete test client
  if (testClientId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/clients/${testClientId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/trust/transactions', () => {
  test('creates a deposit transaction', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/trust/transactions`, {
      token,
      body: {
        trustAccountId: testAccountId,
        type: 'deposit',
        amountCents: 50000,
        clientId: testClientId,
        clientName: '__TEST__ Trust Txn Client',
        date: '2026-04-01',
        description: '__TEST__ retainer deposit',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.transaction).toBeDefined();
    depositTxnId = res.body.transaction.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/trust/transactions', () => {
  test('lists transactions', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/transactions`, { token });
    expect(res.status).toBe(200);
    expect(res.body.transactions).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/trust/transactions/:transactionId', () => {
  test('returns a single transaction', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/transactions/${depositTxnId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.transaction).toBeDefined();
  });
});

describe('PATCH /api/lawfirms/:lawFirmId/trust/transactions/:transactionId/void', () => {
  test('voids the deposit transaction', async () => {
    const res = await api.patch(`/api/lawfirms/${lawFirmId}/trust/transactions/${depositTxnId}/void`, {
      token,
      body: { voidReason: '__TEST__ Entered in error' },
    });
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe('void');
    depositTxnId = null; // prevent afterAll double-void
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
