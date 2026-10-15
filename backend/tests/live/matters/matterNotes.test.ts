/**
 * Matter Notes API - real integration tests.
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
let createdNoteId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  // Create a test matter for notes tests
  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Notes Matter',
      matterNumber: 'TEST-NT-001',
      description: 'Created by notes test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  createdMatterId = matterRes.body.matterId;
});

afterAll(async () => {
  // Clean up: delete note if still exists
  if (createdNoteId && createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/notes/${createdNoteId}`, { token, body: {} });
  }
  // Clean up: delete the test matter
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/matters/:matterId/notes', () => {
  test('adds a note to the matter', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/notes`, {
      token,
      body: {
        content: '__TEST__ This is a test note for integration testing.',
        subject: '__TEST__ Note Subject',
        noteType: 'general',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.note?.id).toBeDefined();
    createdNoteId = res.body.note.id;
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId', () => {
  test('updates the note content', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/notes/${createdNoteId}`, {
      token,
      body: {
        content: '__TEST__ Updated note content.',
        subject: '__TEST__ Updated Subject',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId', () => {
  test('deletes the note', async () => {
    // Retract carries an optional reason, so the route validates a JSON body.
    // The real client always sends one; a body-less DELETE is a 400.
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}/notes/${createdNoteId}`, { token, body: {} });
    expect(res.status).toBe(200);
    createdNoteId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
