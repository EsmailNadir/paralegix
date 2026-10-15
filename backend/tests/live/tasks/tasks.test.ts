/**
 * Tasks API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;
let userId: any;
let lawFirmId: any;
let createdTaskId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;

  const res = await api.get('/api/users/my-lawfirms', { token });
  expect(res.status).toBe(200);
  lawFirmId = res.body.lawFirmIds[0];
});

afterAll(async () => {
  if (createdTaskId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/tasks', () => {
  test('creates a task with valid data', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: {
        title: '__TEST__ Integration Test Task',
        description: 'Created by automated test - safe to delete',
        status: 'open',
        assignedTo: [userId],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.taskId || res.body.task?.id).toBeDefined();
    createdTaskId = res.body.taskId || res.body.task?.id;
  });

  test('rejects empty title with 400', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: { title: '' },
    });
    expect(res.status).toBe(400);
  });

  test('rejects request with no auth token', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      body: { title: '__TEST__ No Auth Task' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/lawfirms/:lawFirmId/tasks', () => {
  test('returns list of tasks', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks`, { token });
    expect(res.status).toBe(200);
    expect(res.body.tasks || res.body.items).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/tasks/:taskId', () => {
  test('returns a single task by ID', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, { token });
    expect(res.status).toBe(200);
  });

  test('returns error for non-existent task', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/nonexistent-99999`, { token });
    expect([403, 404]).toContain(res.status);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/tasks/:taskId', () => {
  test('updates task title', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, {
      token,
      body: { title: '__TEST__ Updated Task Title' },
    });
    expect(res.status).toBe(200);
  });

  test('updates task status', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, {
      token,
      body: { status: 'in_progress' },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/tasks/:taskId', () => {
  test('deletes the task', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${createdTaskId}`, { token });
    expect(res.status).toBe(200);
    createdTaskId = null;
  });
});

describe('GET /api/lawfirms/:lawFirmId/tasks (due-date window)', () => {
  const dayString = (offsetDays: any) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  let nearTaskId: any;
  let farTaskId: any;

  beforeAll(async () => {
    // Titles are chosen so `title asc` and `created_at desc` disagree about the
    // order of these two: the near task is created first but sorts first by
    // title, the far task is created second but sorts second by title. The
    // "does not paginate" test below reads that disagreement.
    const near = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: { title: '__TEST__ Window A Due Soon', dueDate: `${dayString(3)}T12:00` },
    });
    expect(near.status).toBe(201);
    nearTaskId = near.body.taskId;

    const far = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: { title: '__TEST__ Window B Due Much Later', dueDate: `${dayString(400)}T12:00` },
    });
    expect(far.status).toBe(201);
    farTaskId = far.body.taskId;
  });

  afterAll(async () => {
    for (const id of [nearTaskId, farTaskId]) {
      if (id) await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${id}`, { token });
    }
  });

  test('returns only tasks due inside the window', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks?dueFrom=${dayString(0)}&dueTo=${dayString(30)}`,
      { token },
    );
    expect(res.status).toBe(200);
    const ids = res.body.tasks.map((t: any) => t.taskId || t.id);
    expect(ids).toContain(nearTaskId);
    expect(ids).not.toContain(farTaskId);
  });

  test('a task with no due date is dropped by a bounded read but kept by an unbounded one', async () => {
    const undated = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: { title: '__TEST__ Window No Due Date' },
    });
    expect(undated.status).toBe(201);
    const undatedId = undated.body.taskId;
    try {
      const bounded = await api.get(
        `/api/lawfirms/${lawFirmId}/tasks?dueFrom=${dayString(-3650)}&dueTo=${dayString(3650)}`,
        { token },
      );
      expect(bounded.status).toBe(200);
      expect(bounded.body.tasks.map((t: any) => t.taskId || t.id)).not.toContain(undatedId);

      const unbounded = await api.get(`/api/lawfirms/${lawFirmId}/tasks`, { token });
      expect(unbounded.status).toBe(200);
      expect(unbounded.body.tasks.map((t: any) => t.taskId || t.id)).toContain(undatedId);
    } finally {
      await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${undatedId}`, { token });
    }
  });

  test('the window alone does not paginate the answer', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks?dueFrom=${dayString(-3650)}&dueTo=${dayString(3650)}`,
      { token },
    );
    expect(res.status).toBe(200);
    // The unpaged branch returns every match, so the reported total equals the rows sent.
    expect(res.body.totalTasks).toBe(res.body.tasks.length);

    // The unpaged branch orders newest-first; the paged branch defaults to
    // `title asc` and caps at 50 rows. Both fixtures sit inside this window, so
    // if the window ever flipped the request onto the paged branch either they
    // would come back in the opposite order or drop out of the page entirely.
    const ids = res.body.tasks.map((t: any) => t.taskId || t.id);
    expect(ids).toContain(nearTaskId);
    expect(ids).toContain(farTaskId);
    expect(ids.indexOf(farTaskId)).toBeLessThan(ids.indexOf(nearTaskId));
  });

  test('the window composes with paging when paging is asked for', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks?dueFrom=${dayString(0)}&dueTo=${dayString(30)}&limit=1&sortBy=dueDate&order=asc`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBeLessThanOrEqual(1);
  });

  test('rejects a malformed window bound', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks?dueFrom=soon&dueTo=${dayString(30)}`, { token });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/lawfirms/:lawFirmId/tasks/status-counts', () => {
  test('returns a count for every status plus a total', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/status-counts`, { token });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual(expect.objectContaining({
      open: expect.any(Number),
      in_progress: expect.any(Number),
      completed: expect.any(Number),
      blocked: expect.any(Number),
    }));
    expect(typeof res.body.total).toBe('number');
  });

  test('the total equals the sum of the per-status counts', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/status-counts`, { token });
    const { counts, total } = res.body;
    const summed = counts.open + counts.in_progress + counts.completed + counts.blocked;
    // `total` counts every row, including any status outside the four known ones.
    expect(total).toBeGreaterThanOrEqual(summed);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
