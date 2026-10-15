/**
 * Matter Categories API - real integration tests.
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
let createdCategoryId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  if (createdCategoryId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/categories/${createdCategoryId}`, { token });
  }
});

describe('GET /api/lawfirms/:lawFirmId/matters/categories', () => {
  test('returns list of categories', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/categories`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
  });
});

describe('POST /api/lawfirms/:lawFirmId/matters/categories', () => {
  test('creates a new category', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/categories`, {
      token,
      body: {
        name: '__TEST__ Category',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.category?.id).toBeDefined();
    createdCategoryId = res.body.category.id;
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/categories/:categoryId', () => {
  test('updates the category name', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/categories/${createdCategoryId}`, {
      token,
      body: {
        name: '__TEST__ Updated Category',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.category?.name).toBe('__TEST__ Updated Category');
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/categories/tree', () => {
  test('returns category tree', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/categories/tree`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/matters/categories/:categoryId', () => {
  test('deletes the category', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/matters/categories/${createdCategoryId}`, { token });
    expect(res.status).toBe(200);
    createdCategoryId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
