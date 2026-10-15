/**
 * B02.2 A13: the firm client list and lookup typeahead search never cross a
 * firm boundary.
 *
 * `clients.repository.ts`'s `listClientsPaged` builds its `search` predicate as
 * a UNION of index-friendly arms (name / email / organization / linked portal
 * user's name / linked portal user's email / roster contact name), each one
 * hand-written as `c.law_firm_id = $1 and <column> ilike $N` (see the comment
 * above the query in that file). `lookupClients` repeats the same shape for the
 * typeahead. Every existing tenancy test for this module (clients.inprocess and
 * tests/tenancy/tenancy.test.ts) seeds the two firms with DIFFERENT names, which
 * proves a lost `law_firm_id` clause would surface a foreign row by name, but
 * never proves it stays scoped when the SAME search term genuinely matches a
 * row in both firms.
 *
 * Mutation testing this file found the search path is deliberately
 * belt-and-suspenders: the LIST query carries the tenant scope on the base
 * `where`, on each UNION arm, AND again on the outer `join clients c on c.id =
 * p.id and c.law_firm_id = $1` that resolves the CTE's matched ids back to full
 * rows, so removing any ONE of those three copies alone does not leak (ids are
 * globally unique, so a foreign id can never satisfy `c.id = p.id and
 * c.law_firm_id = <this firm>`). Only stripping all three at once reproduces a
 * leak, and even then the audited query context (`tenantParameterizedQuery`)
 * throws before the query runs rather than returning it — see the mutation
 * note on the paged-count case below for what that means for these
 * assertions. `totalItems` is present only when `limit` is supplied
 * (`clientsService.listClients`), so every list case below passes one.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;

async function seedClient(
  lawFirmId: string,
  overrides: { name?: string; email?: string | null; organization?: string | null } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type, email, organization)
     values ($1, $2, $3, 'person', $4, $5)`,
    [
      id,
      lawFirmId,
      overrides.name ?? `Client ${id.slice(0, 8)}`,
      overrides.email ?? null,
      overrides.organization ?? null,
    ],
  );
  return id;
}

const LIST = (firmId: string) => `/api/lawfirms/${firmId}/clients`;
const LOOKUP = (firmId: string) => `/api/lawfirms/${firmId}/clients/lookup`;

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm Alpha' });
  firmB = await createFirm({ name: 'Firm Beta' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
});

describe('the client list search', () => {
  it('matches a NAME fragment only within the caller firm, though both firms have one', async () => {
    await seedClient(firmA.id, { name: 'Meridian Holdings Contact' });
    await seedClient(firmB.id, { name: 'Meridian Rival Contact' });

    const res = await alice.api.get(LIST(firmA.id)).query({ search: 'meridian', limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: any) => c.name)).toEqual(['Meridian Holdings Contact']);
    expect(res.body.totalItems).toBe(1);
  });

  it('matches an EMAIL fragment only within the caller firm', async () => {
    await seedClient(firmA.id, { name: 'Alice Local', email: 'contact@sharedmail.test' });
    await seedClient(firmB.id, { name: 'Bob Foreign', email: 'contact@sharedmail.test' });

    const res = await alice.api.get(LIST(firmA.id)).query({ search: 'sharedmail', limit: 10 });

    expect(res.body.clients.map((c: any) => c.name)).toEqual(['Alice Local']);
    expect(res.body.totalItems).toBe(1);
  });

  it('matches an ORGANIZATION fragment only within the caller firm', async () => {
    await seedClient(firmA.id, { name: 'Org Match Local', organization: 'Meridian Group' });
    await seedClient(firmB.id, { name: 'Org Match Foreign', organization: 'Meridian Group' });

    const res = await alice.api.get(LIST(firmA.id)).query({ search: 'meridian', limit: 10 });

    expect(res.body.clients.map((c: any) => c.name)).toEqual(['Org Match Local']);
    expect(res.body.totalItems).toBe(1);
  });

  it('keeps the paged count scoped to the caller firm with a colliding term and a narrow page', async () => {
    await seedClient(firmA.id, { name: 'Meridian One' });
    await seedClient(firmA.id, { name: 'Meridian Two' });
    await seedClient(firmB.id, { name: 'Meridian Rival One' });
    await seedClient(firmB.id, { name: 'Meridian Rival Two' });
    await seedClient(firmB.id, { name: 'Meridian Rival Three' });

    // `totalItems` comes from `count(*) over()`, a window function computed
    // INSIDE the `page` CTE (`listClientsPaged` in clients.repository.ts) over
    // whatever `whereSql` matched, before the outer `join clients c on c.id =
    // p.id and c.law_firm_id = $1` re-applies the tenant scope to the returned
    // rows. Mutation-tested directly: with the base `c.law_firm_id = $1`
    // predicate, every search-arm's own copy of it, AND the outer join's copy
    // all removed at once, `clients` and `totalItems` both leaked the other
    // firm's rows into this response — but the audited query context caught it
    // first and threw rather than letting any single ONE of those three
    // redundant predicates go missing silently, which is why this suite
    // couldn't reproduce a leak with a single-line mutation. `limit=1` here
    // keeps the assertion meaningful either way: it fails on a real leak (5,
    // not 2) and on the query-context's refusal (a 500 instead of 200).
    const res = await alice.api.get(LIST(firmA.id)).query({ search: 'meridian', limit: 1 });

    expect(res.body.clients.length).toBe(1);
    expect(res.body.totalItems).toBe(2);
  });

  it('never states the other firm client in its own (non-colliding) response either', async () => {
    // The blunt check alongside the shaped ones above: search the caller's OWN
    // firm and assert the foreign firm's distinctly-named client is nowhere in
    // the body, matching the discipline in tests/tenancy/tenancy.test.ts.
    await seedClient(firmA.id, { name: 'Our Own Contact' });
    await seedClient(firmB.id, { name: 'Confidential Beta Contact' });

    const res = await alice.api.get(LIST(firmA.id)).query({ limit: 10 });

    expect(JSON.stringify(res.body)).not.toContain('Confidential Beta Contact');
  });
});

describe('the client lookup typeahead', () => {
  it('resolves a colliding search term to only the caller firm client', async () => {
    await seedClient(firmA.id, { name: 'Meridian Holdings' });
    await seedClient(firmB.id, { name: 'Meridian Rival Holdings' });

    const res = await alice.api.get(LOOKUP(firmA.id)).query({ search: 'meridian' });

    expect(res.status).toBe(200);
    // Positive proof of a match, not just an absence: a lookup that dropped
    // its OWN firm's row too (an over-scoped bug, or a broken join) would pass
    // an assertion that only checked the foreign name was absent. The slim
    // (non-`full`) picker row carries `label`, not `name` (see `labelsFor` in
    // `clients.repository.ts`).
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Meridian Holdings']);
  });

  it('resolves a colliding term through the linked portal user name only within the caller firm', async () => {
    // Distinct arm of the same UNION: matching through `users.name` via the
    // client's `user_id`, not through the client's own `name` column.
    const uidA = `portal-${randomUUID().slice(0, 8)}`;
    const uidB = `portal-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'client')`,
      [uidA, `${uidA}@example.test`, 'Meridian Portal Person'],
    );
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'client')`,
      [uidB, `${uidB}@example.test`, 'Meridian Rival Portal Person'],
    );
    const clientIdA = randomUUID();
    const clientIdB = randomUUID();
    await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type, user_id)
       values ($1, $2, 'Portal Client A', 'person', $3)`,
      [clientIdA, firmA.id, uidA],
    );
    await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type, user_id)
       values ($1, $2, 'Portal Client B', 'person', $3)`,
      [clientIdB, firmB.id, uidB],
    );

    const res = await alice.api.get(LOOKUP(firmA.id)).query({ search: 'meridian' });

    expect(res.body.items.map((i: any) => i.id)).toEqual([clientIdA]);
  });
});
