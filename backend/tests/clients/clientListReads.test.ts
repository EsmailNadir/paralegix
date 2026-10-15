/**
 * GET /api/lawfirms/:lawFirmId/clients: the filters, the sort and the page.
 *
 * Mirrors `matterListReads.test.ts` and `taskListReads.test.ts`, so the three
 * parent lists are held to the same standard.
 *
 *   THE PAGE IS CUT AFTER THE FILTER. `listClientsPaged` filters, sorts and
 *   windows in one CTE, so every filter case asserts the page contents AND
 *   `totalItems`. A filter that ran after the LIMIT would return a short page
 *   with a wrong total, and a user would simply see fewer clients than they
 *   have.
 *
 *   ORDERING FIXTURES ARE REVERSE-ALPHABETICAL ON PURPOSE. A sort test whose
 *   fixtures are already in the expected order passes against any ordering,
 *   including none. Names below are created in the reverse of the order the
 *   sort is expected to return, so the expectation differs from insertion order
 *   and from creation order.
 *
 *   A SECOND FIRM IS SEEDED FIRST, with clients that collide with every
 *   filter asked for, so an exact-set assertion is also a tenancy assertion.
 *
 * Fixtures are plain SQL, so a broken repository cannot produce both the row
 * and the expectation.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterClient } from '../support/matters';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;

const LIST = (query = '') => `/api/lawfirms/${firmA.id}/clients${query}`;

async function setClient(id: string, fields: { status?: string; createdAt?: string }) {
  if (fields.status) await testPool.query('update clients set status = $2 where id = $1', [id, fields.status]);
  if (fields.createdAt) await testPool.query('update clients set created_at = $2 where id = $1', [id, fields.createdAt]);
}

const names = (res: any) => res.body.clients.map((c: any) => c.name);

beforeEach(async () => {
  firmA = await createFirm();
  firmB = await createFirm();
  alice = await ownerOf(firmA.id);
});

/** Clients at firm B named and typed to collide with whatever firm A is asked for. */
async function seedDecoys(): Promise<void> {
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    const person = await createPersonClient(firmB.id, { name });
    await setClient(person.id, { status: 'active' });
    const org = await createOrgClient(firmB.id, { name: `${name} Org` });
    await setClient(org.id, { status: 'inactive' });
  }
}

describe('the clientType and status filters', () => {
  beforeEach(async () => {
    await seedDecoys();
    const p1 = await createPersonClient(firmA.id, { name: 'Person One' });
    const p2 = await createPersonClient(firmA.id, { name: 'Person Two' });
    const p3 = await createPersonClient(firmA.id, { name: 'Person Three' });
    const o1 = await createOrgClient(firmA.id, { name: 'Org One' });
    const o2 = await createOrgClient(firmA.id, { name: 'Org Two' });
    await setClient(p1.id, { status: 'active' });
    await setClient(p2.id, { status: 'inactive' });
    await setClient(p3.id, { status: 'archived' });
    await setClient(o1.id, { status: 'active' });
    await setClient(o2.id, { status: 'archived' });
  });

  it('returns only person clients, and totals them', async () => {
    const res = await alice.api.get(LIST('?clientType=person&limit=10&sortBy=name&order=asc'));

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Person One', 'Person Three', 'Person Two']);
    expect(res.body.totalItems).toBe(3);
  });

  it('returns only organization clients, and totals them', async () => {
    const res = await alice.api.get(LIST('?clientType=company&limit=10&sortBy=name&order=asc'));

    expect(names(res)).toEqual(['Org One', 'Org Two']);
    expect(res.body.totalItems).toBe(2);
  });

  it.each([
    ['active', ['Org One', 'Person One']],
    ['inactive', ['Person Two']],
    ['archived', ['Org Two', 'Person Three']],
  ])('returns only %s clients, and totals them', async (status, expected) => {
    const res = await alice.api.get(LIST(`?status=${status}&limit=10&sortBy=name&order=asc`));

    expect(names(res)).toEqual(expected);
    expect(res.body.totalItems).toBe(expected.length);
  });

  it('combines the filters, and the total counts the filtered set, not the page', async () => {
    const res = await alice.api.get(LIST('?clientType=person&status=archived&limit=1'));

    expect(names(res)).toEqual(['Person Three']);
    expect(res.body.totalItems).toBe(1);

    const twoStatusesOneType = await alice.api.get(LIST('?clientType=company&limit=1&sortBy=name&order=asc'));
    expect(names(twoStatusesOneType)).toEqual(['Org One']);
    expect(twoStatusesOneType.body.totalItems).toBe(2);
  });

  it('refuses a status or type outside the vocabulary', async () => {
    expect((await alice.api.get(LIST('?status=deleted'))).status).toBe(400);
    expect((await alice.api.get(LIST('?clientType=robot'))).status).toBe(400);
  });
});

describe('the matterId filter', () => {
  it('returns only the clients linked to that matter, and totals them', async () => {
    await seedDecoys();
    const linkedA = await createPersonClient(firmA.id, { name: 'On Matter A' });
    const linkedB = await createOrgClient(firmA.id, { name: 'On Matter B' });
    await createPersonClient(firmA.id, { name: 'Not On Any Matter' });
    const matterId = await seedMatter(firmA.id, { name: 'The matter', memberUids: [alice.uid] });
    await seedMatterClient(firmA.id, matterId, linkedA.id);
    await seedMatterClient(firmA.id, matterId, linkedB.id);
    const otherMatter = await seedMatter(firmA.id, { name: 'Other matter', memberUids: [alice.uid] });
    await seedMatterClient(firmA.id, otherMatter, linkedA.id);

    const res = await alice.api.get(LIST(`?matterId=${matterId}&limit=10&sortBy=name&order=asc`));

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['On Matter A', 'On Matter B']);
    expect(res.body.totalItems).toBe(2);
  });

  it('answers empty, not the whole firm, for a malformed matter id', async () => {
    await createPersonClient(firmA.id, { name: 'Somebody' });

    const res = await alice.api.get(LIST('?matterId=not-a-uuid&limit=10'));

    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });

  it('gives another firm\'s matter id no clients of either firm', async () => {
    const foreignClient = await createPersonClient(firmB.id, { name: 'Foreign Client' });
    await createPersonClient(firmA.id, { name: 'Home Client' });
    const foreignMatter = await seedMatter(firmB.id, { name: 'Foreign matter' });
    await seedMatterClient(firmB.id, foreignMatter, foreignClient.id);

    const res = await alice.api.get(LIST(`?matterId=${foreignMatter}&limit=10`));

    expect(JSON.stringify(res.body)).not.toContain('Foreign Client');
    expect(JSON.stringify(res.body)).not.toContain('Home Client');
    expect(res.body.clients ?? []).toEqual([]);
  });
});

describe('the portalOnly filter', () => {
  it('returns only clients with a linked portal account', async () => {
    await seedDecoys();
    const portal = await createPortalUser({ name: 'Portal Pat' });
    await createPersonClient(firmA.id, { name: 'Has Portal', userId: portal.uid });
    await createPersonClient(firmA.id, { name: 'No Portal' });
    await createOrgClient(firmA.id, { name: 'Org Has No Portal' });

    const only = await alice.api.get(LIST('?portalOnly=true&limit=10'));
    const all = await alice.api.get(LIST('?portalOnly=false&limit=10&sortBy=name&order=asc'));

    expect(names(only)).toEqual(['Has Portal']);
    expect(only.body.totalItems).toBe(1);
    expect(names(all)).toEqual(['Has Portal', 'No Portal', 'Org Has No Portal']);
    expect(all.body.totalItems).toBe(3);
  });
});

describe('sorting and paging', () => {
  beforeEach(async () => {
    await seedDecoys();
    // Created in reverse of the ascending name order, with created_at ascending
    // in that same reverse order, so name order, creation order and insertion
    // order all disagree.
    for (const [i, name] of ['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha'].entries()) {
      const client = await createPersonClient(firmA.id, { name });
      await setClient(client.id, { createdAt: `2026-01-0${i + 1}T00:00:00Z` });
    }
  });

  const walk = async (query: string, pages: number, limit: number) => {
    const collected: string[] = [];
    const totals: number[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const res = await alice.api.get(LIST(`?${query}&limit=${limit}&page=${page}`));
      expect(res.status).toBe(200);
      collected.push(...names(res));
      totals.push(res.body.totalItems);
    }
    return { collected, totals };
  };

  it('sorts by name ascending across every page, with a constant total', async () => {
    const { collected, totals } = await walk('sortBy=name&order=asc', 3, 2);

    expect(collected).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    expect(totals).toEqual([5, 5, 5]);
  });

  it('sorts by name descending across every page', async () => {
    const { collected } = await walk('sortBy=name&order=desc', 3, 2);

    expect(collected).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('defaults to newest first, which is not name order', async () => {
    const { collected } = await walk('x=1', 3, 2);

    // created_at runs Echo (oldest) to Alpha (newest), so newest first is Alpha.
    expect(collected).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    const ascending = await walk('sortBy=createdAt&order=asc', 3, 2);
    expect(ascending.collected).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('honours the multi-column sort model over sortBy', async () => {
    const { collected } = await walk('sort=name:desc', 3, 2);

    expect(collected).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('answers an empty page past the end, still stating the total', async () => {
    const res = await alice.api.get(LIST('?limit=2&page=9&sortBy=name&order=asc'));

    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
    expect(res.body.totalItems).toBe(5);
  });

  it('honours offset in place of page', async () => {
    const res = await alice.api.get(LIST('?limit=2&offset=3&sortBy=name&order=asc'));

    expect(names(res)).toEqual(['Delta', 'Echo']);
  });

  it.each([
    ['an unsupported sort field', 'sortBy=phone'],
    ['an unsupported sort model', 'sort=phone:asc'],
    ['a zero limit', 'limit=0'],
    ['a limit over the ceiling', 'limit=501'],
    ['a page of zero', 'page=0'],
  ])('refuses %s', async (_label, query) => {
    expect((await alice.api.get(LIST(`?${query}`))).status).toBe(400);
  });
});

describe('the ids batch resolve', () => {
  it('returns exactly the clients asked for in this firm, and never another firm\'s', async () => {
    const mine1 = await createPersonClient(firmA.id, { name: 'Mine One' });
    const mine2 = await createPersonClient(firmA.id, { name: 'Mine Two' });
    await createPersonClient(firmA.id, { name: 'Not Asked For' });
    const foreign = await createPersonClient(firmB.id, { name: 'Foreign Client' });

    const res = await alice.api.get(LIST(`?ids=${mine1.id},${mine2.id},${foreign.id},${randomUUID()}`));

    expect(res.status).toBe(200);
    expect(names(res).sort()).toEqual(['Mine One', 'Mine Two']);
    expect(JSON.stringify(res.body)).not.toContain('Foreign Client');
  });

  it('refuses more than 200 ids rather than truncating them', async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID()).join(',');

    const res = await alice.api.get(LIST(`?ids=${ids}`));

    expect(res.status).toBe(400);
  });
});

describe('search, with paging', () => {
  it('totals the matches, not the firm, and keeps the page inside them', async () => {
    await seedDecoys();
    for (const name of ['Smith Alpha', 'Smith Bravo', 'Smith Charlie', 'Jones Delta']) {
      await createPersonClient(firmA.id, { name });
    }

    const res = await alice.api.get(LIST('?search=smith&limit=2&page=2&sortBy=name&order=asc'));

    expect(names(res)).toEqual(['Smith Charlie']);
    expect(res.body.totalItems).toBe(3);
  });
});
