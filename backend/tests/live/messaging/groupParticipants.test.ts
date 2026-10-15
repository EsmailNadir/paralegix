/**
 * Group conversation participant management - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * Covers POST /messaging/groups/:id/participants (add firm members and/or
 * clients) and DELETE /messaging/groups/:id/participants/:userId (soft-remove),
 * confirming the change via GET /messaging/groups/:id participants.
 *
 * Seed note: the primary firm currently has a single portal client and (often)
 * a single firm member, so the add-a-second-member path self-skips. The
 * add/remove round-trip is exercised against the one portal client instead
 * (removed participants are soft-deleted and can be re-added).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

let token: any;
let userId: any;
let lawFirmId: any;
let clientId: any;
let secondMemberId: any;
let convId: any;

const participantIds = async (id: any) => {
  const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${id}`, { token });
  return (get.body.participants || []).map((p: any) => p.userId);
};

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  const clientsRes = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
  const withUser = (clientsRes.body.clients || []).find(
    (c: any) => typeof c?.userId === 'string' && c.userId.length > 0
  );
  clientId = withUser ? withUser.userId : null;

  const membersRes = await api.get(`/api/lawfirms/${lawFirmId}/members`, { token });
  const other = (membersRes.body?.members || []).find((m: any) => m.userId && m.userId !== userId);
  secondMemberId = other ? other.userId : null;

  if (clientId) {
    const create = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups`, {
      token, body: { title: '__TEST__ participants group', clientIds: [clientId] },
    });
    if (create.status === 201) convId = create.body.conversationId;
  }
});

describe('participant add/remove round-trip', () => {
  test('the created group starts with the creator and the client as participants', async () => {
    if (!convId) return console.warn('SKIP: no group (no portal client)');
    const ids = await participantIds(convId);
    expect(ids).toContain(userId);
    expect(ids).toContain(clientId);
  });

  test('removes the client participant and it disappears from the roster', async () => {
    if (!convId) return console.warn('SKIP: no group (no portal client)');
    const del = await api.delete(
      `/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/participants/${clientId}`,
      { token }
    );
    expect(del.status).toBe(200);
    const ids = await participantIds(convId);
    expect(ids).not.toContain(clientId);
    expect(ids).toContain(userId); // creator stays
  });

  test('re-adds the client participant and it reappears on the roster', async () => {
    if (!convId) return console.warn('SKIP: no group (no portal client)');
    const add = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/participants`, {
      token, body: { clientIds: [clientId] },
    });
    expect(add.status).toBe(200);
    const ids = await participantIds(convId);
    expect(ids).toContain(clientId);
  });

  test('adds a second firm member when the firm has one', async () => {
    if (!convId) return console.warn('SKIP: no group (no portal client)');
    if (!secondMemberId) return console.warn('SKIP: firm has no second member to add');
    const add = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/participants`, {
      token, body: { memberIds: [secondMemberId] },
    });
    expect(add.status).toBe(200);
    const ids = await participantIds(convId);
    expect(ids).toContain(secondMemberId);

    // Clean the added member back out.
    await api.delete(
      `/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/participants/${secondMemberId}`,
      { token }
    );
  });
});

describe('participant management - negative cases', () => {
  test('adding a client that does not belong to the firm returns 403', async () => {
    if (!convId) return console.warn('SKIP: no group (no portal client)');
    const add = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups/${convId}/participants`, {
      token, body: { clientIds: ['__TEST__not-a-firm-client'] },
    });
    expect(add.status).toBe(403);
  });

  test('adding participants to a non-existent group returns 404', async () => {
    const add = await api.post(`/api/lawfirms/${lawFirmId}/messaging/groups/${RANDOM_UUID}/participants`, {
      token, body: { memberIds: [userId] },
    });
    expect(add.status).toBe(404);
  });

  test('a non-participant cannot read a group (403)', async () => {
    // A random valid-uuid conversation the caller is not a participant of is
    // participant-gated before existence is revealed.
    const get = await api.get(`/api/lawfirms/${lawFirmId}/messaging/groups/${RANDOM_UUID}`, { token });
    expect(get.status).toBe(403);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
