/**
 * Matter Clients API - real integration tests.
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
let createdClientId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for clients tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Clients Matter',
      matterNumber: 'TEST-CC-001',
      description: 'Created by clients test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: remove client if still linked
  if (createdClientId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients/${createdClientId}`, { token });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/matters/:matterId/clients', () => {
  test('adds a client to the matter', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients`, {
      token,
      body: {
        client: {
          name: '__TEST__ Client Person',
          email: 'test-client@example.com',
          phone: '555-0100',
          organization: '__TEST__ Org',
        },
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.clientId).toBeDefined();
    createdClientId = res.body.clientId;
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/:matterId/clients', () => {
  test('returns list of matter clients', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/:matterId/clients/:clientId', () => {
  // Regression: a partial update (e.g. renaming) must not blank the contact
  // fields it leaves out. Previously the update coerced every omitted field to
  // null, so editing the name silently wiped the client's phone.
  test('preserves fields omitted from the update payload', async () => {
    const putRes = await api.put(
      `/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients/${createdClientId}`,
      { token, body: { client: { name: '__TEST__ Client Person (renamed)' } } }
    );
    expect(putRes.status).toBe(200);

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients`, { token });
    const client = res.body.clients.find((c: any) => c.id === createdClientId);
    expect(client).toBeDefined();
    expect(client.name).toBe('__TEST__ Client Person (renamed)');
    // The fields NOT sent in the payload survive untouched.
    expect(client.phone).toBe('555-0100');
    expect(client.organization).toBe('__TEST__ Org');
  });

  // The other half of the contract: an explicitly-sent empty string still
  // clears the field, so users can intentionally remove a value.
  test('clears a field when an empty value is explicitly sent', async () => {
    const putRes = await api.put(
      `/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients/${createdClientId}`,
      { token, body: { client: { phone: '' } } }
    );
    expect(putRes.status).toBe(200);

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients`, { token });
    const client = res.body.clients.find((c: any) => c.id === createdClientId);
    expect(client).toBeDefined();
    expect(client.phone == null || client.phone === '').toBe(true);
    // Unsent fields still preserved alongside the intentional clear.
    expect(client.organization).toBe('__TEST__ Org');
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/matters/:matterId/clients/:clientId', () => {
  test('removes the client from the matter', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/clients/${createdClientId}`, { token });
    expect(res.status).toBe(200);
    createdClientId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
