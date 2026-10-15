/**
 * Group conversation matter scope - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * Covers PUT /messaging/groups/:id/matters (set/replace the organizational
 * matter tag) and reading it back via GET /messaging/groups/:id. Matter scope
 * is a set (zero, one, or many); the first of the set mirrors into the
 * conversation's primary matterId. Each scoped matter must belong to the firm.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

let token: any;
let lawFirmId: any;
let clientId;
let matterIds: any = [];
let convId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  const clientsRes = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
  const withUser = (clientsRes.body.clients || []).find(
    (c: any) => typeof c?.userId === 'string' && c.userId.length > 0
  );
  clientId = withUser ? withUser.userId : null;

  const mattersRes = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
  const matters = (mattersRes.body && (mattersRes.body.matters || mattersRes.body.items)) || [];
  matterIds = matters.map((m: any) => m.id).slice(0, 2);

  if (clientId) {
    const create = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ matters group', clientIds: [clientId] },
    });
    if (create.status === 201) convId = create.body.conversationId;
  }
});

afterAll(async () => {
  // No group-delete route exists; clear the matter scope we set so the lingering
  // test conversation is left untagged.
  if (convId) {
    await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds: [] },
    });
  }
});

describe('PUT /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/matters', () => {
  test('sets a single matter and reads it back on the conversation', async () => {
    if (!convId || !matterIds.length) return console.warn('SKIP: need a group and a matter');
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds: [matterIds[0]] },
    });
    expect(put.status).toBe(200);
    expect(put.body.matterIds).toEqual([matterIds[0]]);

    const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}`, { token });
    expect(get.status).toBe(200);
    expect(get.body.conversation.matterIds).toEqual([matterIds[0]]);
    // The primary matterId mirrors the first of the set.
    expect(get.body.conversation.matterId).toBe(matterIds[0]);
  });

  test('replaces the scope with multiple matters (primary = first of the set)', async () => {
    if (!convId || matterIds.length < 2) return console.warn('SKIP: need a group and 2 matters');
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds },
    });
    expect(put.status).toBe(200);
    expect(put.body.matterIds).toEqual(matterIds);

    const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}`, { token });
    expect(get.body.conversation.matterIds).toEqual(matterIds);
    expect(get.body.conversation.matterId).toBe(matterIds[0]);
  });

  test('clears the scope with an empty array', async () => {
    if (!convId) return console.warn('SKIP: need a group');
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds: [] },
    });
    expect(put.status).toBe(200);
    expect(put.body.matterIds).toEqual([]);

    const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}`, { token });
    expect(get.body.conversation.matterIds).toEqual([]);
    expect(get.body.conversation.matterId).toBeNull();
  });

  test('rejects a matter that does not belong to the firm with 403', async () => {
    if (!convId) return console.warn('SKIP: need a group');
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds: [RANDOM_UUID] },
    });
    expect(put.status).toBe(403);
  });

  test('returns 404 when the group conversation does not exist', async () => {
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${RANDOM_UUID}/matters`, {
      token, body: { matterIds: [] },
    });
    expect(put.status).toBe(404);
  });

  test('rejects a non-uuid matter id with 400 (schema validation)', async () => {
    if (!convId) return console.warn('SKIP: need a group');
    const put = await api.put(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/matters`, {
      token, body: { matterIds: ['not-a-uuid'] },
    });
    expect(put.status).toBe(400);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
