/**
 * Templates API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;
let lawFirmId: any;
let createdTemplateId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;

  const res = await api.get('/api/users/my-lawfirms', { token });
  expect(res.status).toBe(200);
  lawFirmId = res.body.lawFirmIds[0];
});

afterAll(async () => {
  if (createdTemplateId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/templates/${createdTemplateId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/templates', () => {
  test('creates a template', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/templates`, {
      token,
      body: {
        name: '__TEST__ Integration Template',
        html: '<p>Hello {{clientName}}</p>',
        fields: ['clientName'],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.templateId).toBeDefined();
    createdTemplateId = res.body.templateId;
  });
});

describe('GET /api/lawfirms/:lawFirmId/templates', () => {
  test('lists templates', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/templates`, { token });
    expect(res.status).toBe(200);
    expect(res.body.templates).toBeDefined();
    expect(Array.isArray(res.body.templates)).toBe(true);
  });
});

describe('GET /api/lawfirms/:lawFirmId/templates/:templateId', () => {
  test('returns a single template with html', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/templates/${createdTemplateId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.template).toBeDefined();
    expect(res.body.template.html).toBeDefined();
  });
});

describe('PUT /api/lawfirms/:lawFirmId/templates/:templateId', () => {
  test('updates template name', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/templates/${createdTemplateId}`, {
      token,
      body: { name: '__TEST__ Updated Template' },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/templates/:templateId', () => {
  test('deletes the template', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/templates/${createdTemplateId}`, { token });
    expect(res.status).toBe(200);
    createdTemplateId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
