/**
 * Server-side tasks pagination - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 *
 * The suite seeds its own tasks under a run-unique prefix so every assertion is
 * independent of whatever the database already contains.
 */

const { api } = require('../setup');
const { bootstrapFirm } = require('../helpers');

let token: any;
let lawFirmId: any;

// Run-unique and free of LIKE wildcards, so `search=${U}` isolates exactly the
// tasks this suite seeded.
const U = `TESTTPAG${Date.now()}`;
const SEEDED_TITLES = [`${U}AAA`, `${U}BBB`, `${U}CCC`, `${U}DDD`, `${U}EEE`];

const createdTaskIds: any = [];

beforeAll(async () => {
  ({ token, lawFirmId } = await bootstrapFirm());

  for (const title of SEEDED_TITLES) {
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: { title, description: 'Created by automated test - safe to delete', status: 'open' },
    });
    if (res.status !== 201) {
      throw new Error(`seed create failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    createdTaskIds.push(res.body.taskId || res.body.task?.id);
  }
}, 60000);

afterAll(async () => {
  for (const id of createdTaskIds) {
    // eslint-disable-next-line no-await-in-loop
    await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${id}`, { token });
  }
}, 60000);

describe('GET /tasks pagination', () => {
  test('limit windows the result and reports the full count', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks?limit=2&search=${U}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBeLessThanOrEqual(2);
    expect(res.body.totalTasks).toBe(SEEDED_TITLES.length);
  });

  test('page 2 returns a different window than page 1', async () => {
    const p1 = await api.get(`/api/lawfirms/${lawFirmId}/tasks?limit=1&page=1&search=${U}`, { token });
    const p2 = await api.get(`/api/lawfirms/${lawFirmId}/tasks?limit=1&page=2&search=${U}`, { token });

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.tasks).toHaveLength(1);
    expect(p2.body.tasks).toHaveLength(1);
    expect(p1.body.tasks[0].id).not.toBe(p2.body.tasks[0].id);
  });

  // The window count rides on the returned rows, so an out-of-range page has no
  // row to read it from. Reporting 0 there is indistinguishable from "no matches",
  // and a UI holding a page number from a wider filter renders "no results" instead
  // of clamping back into range. The empty page must still carry the true total.
  test('an out-of-range page reports the true total, not 0', async () => {
    const first = await api.get(`/api/lawfirms/${lawFirmId}/tasks?limit=5&page=1`, { token });
    expect(first.status).toBe(200);
    const total = first.body.totalTasks;
    expect(total).toBeGreaterThan(0);

    const beyond = await api.get(`/api/lawfirms/${lawFirmId}/tasks?limit=5&page=1000`, { token });

    expect(beyond.status).toBe(200);
    expect(beyond.body.tasks).toEqual([]);
    expect(beyond.body.totalTasks).toBe(total);
  });

  test('an out-of-range page keeps the filter total, not the unfiltered one', async () => {
    const beyond = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks?limit=2&page=50&search=${U}`,
      { token },
    );

    expect(beyond.status).toBe(200);
    expect(beyond.body.tasks).toEqual([]);
    // The seeded-prefix total, not the firm-wide one.
    expect(beyond.body.totalTasks).toBe(SEEDED_TITLES.length);
  });

  // The counterpart: a filter that genuinely matches nothing must still report 0,
  // so the fallback count cannot be masking a real empty result.
  test('a genuinely empty first page still reports 0', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks?limit=5&page=1&search=${U}NOSUCHTASK`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.totalTasks).toBe(0);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
