/**
 * Practice Areas API - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.ts).
 *
 * Every mutation is confirmed by reading the row back; a 200 on its own only
 * says the handler returned, not that the write landed.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdPracticeAreaId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  if (createdPracticeAreaId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/practice-areas/${createdPracticeAreaId}`, { token });
  }
});

describe('practice areas CRUD', () => {
  test('creates a practice area and reads it back', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/practice-areas`, {
      token,
      body: { name: '__TEST__ Criminal Law' },
    });
    expect(res.status).toBe(201);
    expect(res.body.practiceAreaId).toBeDefined();
    createdPracticeAreaId = res.body.practiceAreaId;

    const read = await api.get(
      `/api/lawfirms/${lawFirmId}/practice-areas/${createdPracticeAreaId}`,
      { token },
    );
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('__TEST__ Criminal Law');
  });

  test('the new practice area appears in the firm list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/practice-areas`, { token });
    expect(res.status).toBe(200);
    expect(res.body.practiceAreas.some((p: any) => p.id === createdPracticeAreaId)).toBe(true);
  });

  test('an update is visible on the next read', async () => {
    const res = await api.put(
      `/api/lawfirms/${lawFirmId}/practice-areas/${createdPracticeAreaId}`,
      { token, body: { name: '__TEST__ Updated Practice Area' } },
    );
    expect(res.status).toBe(200);

    const read = await api.get(
      `/api/lawfirms/${lawFirmId}/practice-areas/${createdPracticeAreaId}`,
      { token },
    );
    expect(read.body.name).toBe('__TEST__ Updated Practice Area');
  });

  test('a delete actually removes the row', async () => {
    const res = await api.delete(
      `/api/lawfirms/${lawFirmId}/practice-areas/${createdPracticeAreaId}`,
      { token },
    );
    expect(res.status).toBe(200);

    const list = await api.get(`/api/lawfirms/${lawFirmId}/practice-areas`, { token });
    expect(list.body.practiceAreas.some((p: any) => p.id === createdPracticeAreaId)).toBe(false);

    createdPracticeAreaId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
