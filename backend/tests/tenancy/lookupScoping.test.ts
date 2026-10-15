/**
 * The typeahead endpoints, which return NAMES.
 *
 * Every picker in the app is backed by a `/lookup` route: attach a matter to a
 * task, pick a contact for an invoice, resolve the label for an id a form
 * already holds. They are the smallest-looking routes in the app and the most
 * disclosure-shaped: the whole point of the response is a human-readable name.
 *
 * Only ONE of the five is covered offline. `tenancy.test.ts` includes the client
 * lookup in its sweep; the matter, task, contact and admin lookups are covered
 * only by `tests/live/`, which needs a running server, real Firebase and a
 * seeded account, and which `npm run test:unit` excludes. So CI has never run
 * them.
 *
 * The test that matters here is not "does firm B get a 403". It is: with the
 * SAME search term matching a row in both firms, does firm B's caller see only
 * their own? A lookup that scoped its permission check but not its query would
 * answer 200 and leak a name, and a test that only asserted the status would
 * agree with it.
 *
 * Two `ids` cases go with it. `ids` resolves labels for values a form already
 * holds, and the documented contract is that an id it cannot resolve comes back
 * EMPTY rather than falling back to an arbitrary page, so a stale id never
 * renders as some unrelated record. A foreign id is exactly that case, and it is
 * also the one an attacker would try.
 */
import { ownerOf, createFirm } from '../support/setupInProcess';
import { createPersonClient } from '../support/factories';

/** The same distinctive term in both firms, so a leak has something to leak. */
const TERM = 'Peregrine';

type World = {
  firmId: string;
  owner: Awaited<ReturnType<typeof ownerOf>>;
  matterId: string;
  taskId: string;
  clientId: string;
  contactId: string;
};

async function seedWorld(label: string): Promise<World> {
  const { id: firmId } = await createFirm();
  const owner = await ownerOf(firmId);
  const client = await createPersonClient(firmId, { name: `${TERM} ${label}` });

  // Created through the real routes rather than by INSERT. These tables carry
  // generated and NOT NULL columns the routes fill in (a matter needs its
  // reference id), so a hand-written insert both breaks and, worse, could seed a
  // row the application would never produce.
  const matter = await owner.api
    .post(`/api/lawfirms/${firmId}/matters`)
    .send({ name: `${TERM} matter ${label}` });
  expect(matter.status).toBe(201);

  const task = await owner.api
    .post(`/api/lawfirms/${firmId}/tasks`)
    .send({ title: `${TERM} task ${label}` });
  expect(task.status).toBe(201);

  const contact = await owner.api
    .post(`/api/lawfirms/${firmId}/contacts`)
    .send({ name: `${TERM} contact ${label}` });
  expect(contact.status).toBe(201);

  // Each create route answers with its own envelope. Spelled out per entity
  // rather than behind a `??` chain across field names: a chain would keep
  // finding SOMETHING after a response shape changed, and the test would go on
  // passing against an id it never meant to use.
  const matterId = matter.body.matterId;
  const taskId = task.body.taskId;
  const contactId = contact.body.contactId;
  for (const [name, value] of [['matterId', matterId], ['taskId', taskId], ['contactId', contactId]]) {
    if (!value) throw new Error(`seedWorld: no ${name} in the create response`);
  }

  return { firmId, owner, matterId, taskId, clientId: client.id, contactId };
}

let a: World;
let b: World;

beforeEach(async () => {
  a = await seedWorld('A');
  b = await seedWorld('B');
});

const names = (body: any) =>
  (body.items || []).map((item: any) => item.name ?? item.title ?? item.label ?? JSON.stringify(item));

describe.each([
  { what: 'matters', path: (w: World) => `/api/lawfirms/${w.firmId}/matters/lookup`, idOf: (w: World) => w.matterId },
  { what: 'tasks', path: (w: World) => `/api/lawfirms/${w.firmId}/tasks/lookup`, idOf: (w: World) => w.taskId },
  { what: 'contacts', path: (w: World) => `/api/lawfirms/${w.firmId}/contacts/lookup`, idOf: (w: World) => w.contactId },
])('$what lookup', ({ path, idOf }) => {
  it('finds the caller own record for a term both firms match, and never the other firm record', async () => {
    const res = await a.owner.api.get(`${path(a)}?search=${TERM}`);

    // The positive control. Without it the leak assertion below would also pass
    // against a lookup that returned nothing to anybody.
    expect(res.status).toBe(200);
    expect(names(res.body).join(' ')).toMatch(/ A$/m);
    // The leak this file exists for. A lookup that scoped its permission check
    // but not its query answers 200 and hands over a name.
    expect(JSON.stringify(res.body)).not.toMatch(/ B\b/);
  });

  it('resolves an id the caller owns', async () => {
    const res = await a.owner.api.get(`${path(a)}?ids=${idOf(a)}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('returns EMPTY for another firm id rather than falling back to a page', async () => {
    // The documented contract, and the one an attacker would test: an id that
    // cannot be resolved must come back empty, so a stale or stolen id never
    // renders as some unrelated record.
    const res = await a.owner.api.get(`${path(a)}?ids=${idOf(b)}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/ B\b/);
  });

  it('refuses a caller from the other firm outright', async () => {
    const res = await b.owner.api.get(`${path(a)}?search=${TERM}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('discloses nothing through a malformed id', async () => {
    // A malformed value is documented as yielding an empty result rather than a
    // 400, matching how `ids` handles anything unusable. Pinned so the two
    // behaviours cannot drift apart into a 500 that names a column.
    const res = await a.owner.api.get(`${path(a)}?ids=not-a-uuid`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
