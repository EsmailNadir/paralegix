/**
 * "Select all" in the tasks grid must mean exactly the tasks the grid shows.
 *
 * `GET /tasks/ids` backs the select-all checkbox, and its answer goes straight to
 * the bulk delete / status / matter routes. If it applies a different filter set
 * than the paged list, the user selects "everything under Due today" and a bulk
 * delete removes tasks that were never on screen. Two filters had drifted:
 *
 *   - `dueFrom` / `dueTo`: the grid sends them, the schema accepts them, but the
 *     route never passed them on, so they were silently ignored.
 *   - `clientId`: the list widens a person to the organizations they are linked
 *     to; the ids read used the bare id, so a person's select-all missed every
 *     task attached to their organization.
 *
 * Each case compares the ids answer with the paged list walked to its end AND
 * with an explicit expected title set, so two reads that agree on a wrong answer
 * do not pass. Red if either endpoint drops a filter the other applies.
 */
import {
  createFirm,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const LIST = () => `/api/lawfirms/${firm.id}/tasks`;
const IDS = () => `/api/lawfirms/${firm.id}/tasks/ids`;

let personId: string;
let orgId: string;
const idByTitle = new Map<string, string>();

async function seedTask(title: string, dueDate: string | null, status: string, clientId?: string) {
  const { rows } = await testPool.query(
    `insert into tasks (law_firm_id, title, status, due_date) values ($1, $2, $3, $4::date) returning id`,
    [firm.id, title, status, dueDate],
  );
  idByTitle.set(title, rows[0].id);
  if (clientId) {
    await testPool.query(
      `insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)`,
      [firm.id, rows[0].id, clientId],
    );
  }
}

/** The paged list walked page by page to its last page, two rows at a time. */
async function walkList(query: string): Promise<{ ids: string[]; total: number }> {
  const ids: string[] = [];
  let total = 0;
  for (let page = 1; page < 20; page += 1) {
    const res = await owner.api.get(`${LIST()}?${query}&limit=2&page=${page}`);
    expect(res.status).toBe(200);
    total = res.body.totalTasks;
    ids.push(...res.body.tasks.map((t: { id: string }) => t.id));
    if (res.body.tasks.length < 2) break;
  }
  return { ids, total };
}

beforeEach(async () => {
  idByTitle.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  personId = (await createPersonClient(firm.id, { name: 'Pat Person' })).id;
  orgId = (await createOrgClient(firm.id, { name: 'Acme Org' })).id;
  await linkPersonToOrg(firm.id, personId, orgId, { canViewBilling: false });

  await seedTask('person early', '2026-10-01', 'open', personId);
  await seedTask('org mid', '2026-10-05', 'open', orgId);
  await seedTask('loose mid', '2026-10-05', 'open');
  await seedTask('loose late', '2026-10-10', 'blocked');
  await seedTask('no date', null, 'open');
  // Another firm's task with the same shape must never appear in either answer.
  const other = await createFirm();
  await testPool.query(
    `insert into tasks (law_firm_id, title, status, due_date) values ($1, 'foreign', 'open', '2026-10-05')`,
    [other.id],
  );
});

const cases: Array<{ name: string; query: () => string; titles: string[] }> = [
  {
    name: 'a one-day due window',
    query: () => 'dueFrom=2026-10-05&dueTo=2026-10-05',
    titles: ['org mid', 'loose mid'],
  },
  {
    name: 'a person client, widened to the organizations they are linked to',
    query: () => `clientId=${personId}`,
    titles: ['person early', 'org mid'],
  },
  {
    name: 'a person client inside a due window',
    query: () => `clientId=${personId}&dueFrom=2026-10-05`,
    titles: ['org mid'],
  },
  {
    name: 'a status plus an open-ended due window',
    query: () => 'status=open&dueTo=2026-10-05',
    titles: ['person early', 'org mid', 'loose mid'],
  },
];

describe.each(cases)('select all under $name', ({ query, titles }) => {
  it('returns exactly the tasks the paged list walked to its end returns', async () => {
    const q = query();
    const ids = await owner.api.get(`${IDS()}?${q}`);
    expect(ids.status).toBe(200);
    const list = await walkList(q);

    const expected = titles.map((t) => idByTitle.get(t)).sort();
    expect([...list.ids].sort()).toEqual(expected);
    expect([...ids.body.ids].sort()).toEqual(expected);
    expect(ids.body.totalItems).toBe(titles.length);
    expect(list.total).toBe(titles.length);
  });
});
