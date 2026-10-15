/**
 * Invoices API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let userId;
let lawFirmId: any;
let createdMatterId: any;
let createdInvoiceId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for invoice tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Invoice Matter',
      description: 'Created by invoices test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: delete invoice if still exists
  if (createdInvoiceId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${createdMatterId}/${createdInvoiceId}`, { token });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/billing/invoices', () => {
  test('creates an invoice with valid data', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/invoices`, {
      token,
      body: {
        matterId: createdMatterId,
        invoiceName: '__TEST__ Invoice',
        invoiceDate: new Date().toISOString(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        timeEntries: [],
        flatFees: [],
        totalHours: 0,
        totalAmount: 0,
        flatFeesAmount: 0,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.invoiceId || res.body.invoice?.id).toBeDefined();
    createdInvoiceId = res.body.invoiceId || res.body.invoice?.id;
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId', () => {
  test('returns invoices for a matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${createdMatterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.invoices || res.body.items).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/invoices/firm', () => {
  test('returns all firm invoices', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/invoices/firm`, { token });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/details', () => {
  test('updates invoice details', async () => {
    const res = await api.patch(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${createdMatterId}/${createdInvoiceId}/details`, {
      token,
      body: {
        invoiceName: '__TEST__ Updated Invoice',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/unbilled-summary', () => {
  test('returns unbilled summary for a matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${createdMatterId}/unbilled-summary`, { token });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId', () => {
  test('deletes the invoice', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${createdMatterId}/${createdInvoiceId}`, { token });
    expect(res.status).toBe(200);
    createdInvoiceId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
