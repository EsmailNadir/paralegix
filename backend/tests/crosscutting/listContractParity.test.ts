/**
 * The three parent lists answer a request with no paging in three different ways.
 * This file PINS those answers so a change is deliberate, because the callers
 * (grids, pickers, the calendar feed, the client portal) each depend on the one
 * they use. It is a characterization, not a statement that the three should
 * differ: unifying them is separate work (decision D-6), and the day it happens
 * the assertions below are the list of callers to migrate.
 *
 *   matters   no `limit` returns every visible matter as `{ matters }`, no total.
 *             `limit` adds `totalItems` (the size of the whole filtered set).
 *   clients   always `{ clients, totalItems }`; an omitted `limit` is the largest
 *             page the endpoint accepts (the 500 cap itself is pinned in
 *             `unpagedListCap.test.ts` and `clients/unpagedReadCeiling.test.ts`).
 *   tasks     no query at all returns every task as `{ tasks, totalTasks }` (the
 *             calendar feed and the portal rely on it). Any paging, filter or
 *             sort param switches to the paged branch, whose default page is 50,
 *             and `dueFrom`/`dueTo` deliberately do NOT switch it.
 *
 * Red if any of those envelopes, totals or defaults changes.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;

const root = (path: string) => `/api/lawfirms/${firm.id}/${path}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('the matters list', () => {
  beforeEach(async () => {
    for (const n of [1, 2, 3]) await seedMatter(firm.id, { name: `Matter ${n}` });
  });

  it('returns every matter under the key `matters` and no total when no limit is given', async () => {
    const res = await owner.api.get(root('matters'));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['matters']);
    expect(res.body.matters).toHaveLength(3);
  });

  it('adds totalItems, the size of the whole set, once a limit is given', async () => {
    const res = await owner.api.get(`${root('matters')}?limit=2`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['matters', 'totalItems']);
    expect(res.body.matters).toHaveLength(2);
    expect(res.body.totalItems).toBe(3);
  });
});

describe('the clients list', () => {
  beforeEach(async () => {
    for (const n of [1, 2, 3]) await createPersonClient(firm.id, { name: `Client ${n}` });
  });

  it('always answers `{ clients, totalItems }`, with or without a limit', async () => {
    const unpaged = await owner.api.get(root('clients'));
    const paged = await owner.api.get(`${root('clients')}?limit=2`);

    expect(unpaged.status).toBe(200);
    expect(Object.keys(unpaged.body).sort()).toEqual(['clients', 'totalItems']);
    expect(unpaged.body.clients).toHaveLength(3);
    expect(unpaged.body.totalItems).toBe(3);
    expect(Object.keys(paged.body).sort()).toEqual(['clients', 'totalItems']);
    expect(paged.body.clients).toHaveLength(2);
    expect(paged.body.totalItems).toBe(3);
  });

  it('refuses a limit above the largest page', async () => {
    expect((await owner.api.get(`${root('clients')}?limit=501`)).status).toBe(400);
  });
});

describe('the tasks list', () => {
  beforeEach(async () => {
    // One more than the default page, so the paged branch is visibly a page.
    await testPool.query(
      `insert into tasks (law_firm_id, title, status, due_date)
       select $1, 'Task ' || g, 'open', '2026-10-05'::date from generate_series(1, 51) g`,
      [firm.id],
    );
  });

  it('returns every task as `{ tasks, totalTasks }` when the query is empty', async () => {
    const res = await owner.api.get(root('tasks'));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['tasks', 'totalTasks']);
    expect(res.body.tasks).toHaveLength(51);
    expect(res.body.totalTasks).toBe(51);
  });

  it('switches to a 50-row page the moment any paging, filter or sort param is present', async () => {
    for (const query of ['status=open', 'page=1', 'sortBy=title', 'priority=medium']) {
      const res = await owner.api.get(`${root('tasks')}?${query}`);

      expect(res.status).toBe(200);
      expect({ query, rows: res.body.tasks.length, total: res.body.totalTasks })
        .toEqual({ query, rows: 50, total: 51 });
    }
  });

  it('does not switch to the paged branch for a due-date window, which bounds the read and nothing else', async () => {
    const res = await owner.api.get(`${root('tasks')}?dueFrom=2026-10-01&dueTo=2026-10-31`);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(51);
    expect(res.body.totalTasks).toBe(51);
  });
});
