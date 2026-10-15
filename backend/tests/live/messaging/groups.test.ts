/**
 * Group conversations (Option B) - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * Uses whatever clients/matters the primary (comped, fully permissioned) firm
 * already has, resolved via getPrimaryLawFirmId. Tests that need a second
 * distinct portal client self-skip when the firm lacks one.
 *
 * Confidentiality note: matter scope on a group is an ORGANIZATIONAL TAG, not a
 * confidentiality gate (see createGroupConversation in messaging.service.js).
 * A multi-client group with no matter is allowed, and a client need not be on
 * the scoped matter. The enforced rules are: at least one client participant,
 * every client must belong to the firm, and every scoped matter must belong to
 * the firm. The assertions below reflect that current behavior.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

let token: any;
let lawFirmId: any;
let clientIds: any = [];
let matterId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  const clientsRes = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
  if (clientsRes.status === 200 && Array.isArray(clientsRes.body.clients)) {
    clientIds = clientsRes.body.clients
      .map((c: any) => c?.userId)
      .filter((id: any) => typeof id === 'string' && id.length > 0);
  }

  const mattersRes = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
  const matters = (mattersRes.body && (mattersRes.body.matters || mattersRes.body.items)) || [];
  if (matters.length) matterId = matters[0].id;
});

describe('POST /api/lawfirms/:lawFirmId/messaging/groups', () => {
  test('creates a single-client group and can send + read', async () => {
    if (!clientIds.length) return console.warn('SKIP: no clients with portal ids');
    const create = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ group', clientIds: [clientIds[0]] },
    });
    expect(create.status).toBe(201);
    const convId = create.body.conversationId;
    expect(convId).toBeTruthy();

    const send = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/messages`, {
      token, body: { content: '__TEST__ hello team' },
    });
    expect(send.status).toBe(201);

    const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}`, { token });
    expect(get.status).toBe(200);
    expect(get.body.conversation.conversationType).toBe('group');
    expect(get.body.messages[get.body.messages.length - 1].content).toBe('__TEST__ hello team');
    expect(get.body.participants.length).toBeGreaterThanOrEqual(2); // creator + client
  });

  test('allows a multi-client group with no matter (matter is not a confidentiality gate)', async () => {
    if (clientIds.length < 2) return console.warn('SKIP: need 2 distinct portal clients');
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ multi', clientIds: [clientIds[0], clientIds[1]] },
    });
    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBeTruthy();
  });

  test('allows a client that is not on the scoped matter (matter is organizational)', async () => {
    if (!clientIds.length || !matterId) return console.warn('SKIP: need a client and a matter');
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ scoped', matterId, clientIds: [clientIds[0]] },
    });
    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBeTruthy();
  });

  test('rejects an empty client list with 400 (schema requires >= 1 client)', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ noclients', clientIds: [] },
    });
    expect(res.status).toBe(400);
  });

  test('rejects a client that does not belong to the firm with 403', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ outsider', clientIds: ['__TEST__not-a-firm-client'] },
    });
    expect(res.status).toBe(403);
  });

  test('rejects a scoped matter that does not belong to the firm with 403', async () => {
    if (!clientIds.length) return console.warn('SKIP: no clients with portal ids');
    const res = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ foreign-matter', matterId: RANDOM_UUID, clientIds: [clientIds[0]] },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/lawfirms/:lawFirmId/messaging/groups', () => {
  test('lists the caller group threads for the firm', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.conversations)).toBe(true);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
