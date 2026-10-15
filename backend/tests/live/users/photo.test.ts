/**
 * User profile photo - real integration tests (JSON paths only).
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * NOTE: the actual image UPLOAD (POST /api/users/me/photo) is multipart/form-data
 * and requires GCS credentials, so it is verified manually / in the browser E2E
 * rather than here (the JSON `api` helper cannot attach a file). These tests
 * cover the read shape and the delete path.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
});

describe('user profile photo', () => {
  test('profile response includes a photoUrl field (null when unset)', async () => {
    const res = await api.get('/api/users/profile', { token });
    expect(res.status).toBe(200);
    expect('photoUrl' in res.body).toBe(true); // present even if null
  });

  test('firm roster members carry a photoUrl field and never leak photoObjectPath', async () => {
    const lf = await api.get('/api/users/my-lawfirms', { token });
    const lawFirmId = lf.body.lawFirmIds[0];
    const res = await api.get(`/api/users/lawfirm/${lawFirmId}/users`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const m of res.body) {
      expect('photoUrl' in m).toBe(true);
      expect('photoObjectPath' in m).toBe(false); // raw GCS path must not be exposed
    }
  });

  test('delete photo returns 200 and profile has no photoUrl afterward', async () => {
    const del = await api.delete('/api/users/me/photo', { token });
    expect(del.status).toBe(200);
    const profile = await api.get('/api/users/profile', { token });
    expect(profile.body.photoUrl == null).toBe(true);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
