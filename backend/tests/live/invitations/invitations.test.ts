/**
 * Invitations API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

describe('GET /api/lawfirms/:lawFirmId/invitations/pending-client-invites', () => {
  test('returns pending client invites list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/invitations/pending-client-invites`, { token });
    expect(res.status).toBe(200);
    const invites = res.body.invites || res.body.pendingInvites || res.body;
    expect(Array.isArray(invites)).toBe(true);
  });
});

describe('POST /api/lawfirms/:lawFirmId/invitations/send-client-invite', () => {
  test('rejects with 400 when required fields missing', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/invitations/send-client-invite`, {
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('Auth required', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/invitations/pending-client-invites`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
