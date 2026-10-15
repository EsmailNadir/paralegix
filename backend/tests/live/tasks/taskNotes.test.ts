/**
 * Task Notes API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 *
 * Task notes are served by the shared notes router (`shared/notes/notesRouter`),
 * so they are RESTful and nested under the task: the parent id is a path segment
 * and the note id is another, never a body field or a query parameter.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;
let userId;
let lawFirmId: any;
let createdTaskId: any;
let createdNoteId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;

  const res = await api.get('/api/users/my-lawfirms', { token });
  expect(res.status).toBe(200);
  lawFirmId = res.body.lawFirmIds[0];

  // Create a test task for notes tests
  const taskRes = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
    token,
    body: {
      title: '__TEST__ Task Notes Task',
      description: 'Created by task notes test - safe to delete',
    },
  });
  expect(taskRes.status).toBe(201);
  createdTaskId = taskRes.body.taskId || taskRes.body.task?.id;
});

afterAll(async () => {
  // Clean up: delete note if still exists
  if (createdNoteId && createdTaskId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}/notes/${createdNoteId}`, { token, body: {} });
  }
  // Clean up: delete the test task
  if (createdTaskId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/tasks/:taskId/notes', () => {
  test('adds a note to the task', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}/notes`, {
      token,
      body: {
        content: '__TEST__ This is a task note for integration testing.',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.noteId || res.body.note?.id).toBeDefined();
    createdNoteId = res.body.noteId || res.body.note?.id;
  });
});

describe('PUT /api/lawfirms/:lawFirmId/tasks/:taskId/notes/:noteId', () => {
  test('updates the note content', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}/notes/${createdNoteId}`, {
      token,
      body: {
        content: '__TEST__ Updated task note content.',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/tasks/:taskId/notes/:noteId', () => {
  test('deletes the note', async () => {
    // Retract carries an optional reason, so the route validates a JSON body.
    // The real client always sends one; a body-less DELETE is a 400.
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}/notes/${createdNoteId}`, { token, body: {} });
    expect(res.status).toBe(200);
    createdNoteId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
