/**
 * Messaging API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let testClientId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Prefer an existing client user id from the firm; fallback to authenticated user id.
  // Messaging service currently resolves recipient via users/{clientId}.
  const clientsRes = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
  if (clientsRes.status === 200 && Array.isArray(clientsRes.body.clients)) {
    const withUserId = clientsRes.body.clients.find((c: any) => typeof c?.userId === 'string' && c.userId.length > 0);
    if (withUserId) testClientId = withUserId.userId;
  }
  if (!testClientId) {
    testClientId = auth.userId;
  }
});

describe('POST /api/lawfirms/:lawFirmId/messaging/send', () => {
  test('sends a message to a client', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/send`, {
      token,
      body: {
        clientId: testClientId,
        content: '__TEST__ Hello from integration test',
      },
    });

    expect(res.status).toBe(201);
  });
});

describe('GET /api/lawfirms/:lawFirmId/messaging/conversations', () => {
  test('the message just sent appears in the firm conversation list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/messaging/conversations`, { token });
    expect(res.status).toBe(200);

    expect(Array.isArray(res.body.conversations)).toBe(true);
    // The send above created or reused a conversation with this recipient, so
    // the list cannot be empty. Asserting only the 200 would pass on a list that
    // silently dropped every row.
    expect(res.body.conversations.length).toBeGreaterThan(0);
    expect(res.body.totalItems).toBeGreaterThanOrEqual(res.body.conversations.length);
  });
});

describe('GET /api/lawfirms/:lawFirmId/messaging/unread-count', () => {
  test('returns a numeric unread count', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/messaging/unread-count`, { token });
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe('number');
    expect(res.body.count).toBeGreaterThanOrEqual(0);
  });
});

describe('Messaging auth', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/messaging/conversations`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
