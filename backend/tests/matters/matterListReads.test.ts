/**
 * The JOIN-heavy read paths of `matters.repository.ts`: the paged list, the
 * ids-only "select all" read, and the picker typeahead.
 *
 * `matters.repository.ts` was at 50.29%, and the uncovered half is almost
 * entirely read code. That half sits under the busiest screen in the product,
 * and its failures are quiet ones:
 *
 *   NOTHING ABOUT A MATTER IS STORED ON THE MATTER. Members, clients, practice
 *   area, court and lead user are junction rows and foreign keys, reassembled on
 *   every read by ten lateral joins. A lateral that returns nothing produces a
 *   matter with no clients and no members, which renders as an empty column
 *   rather than as an error. The derived-field cases below exist to make an
 *   empty derivation fail loudly.
 *
 *   THE PAGE IS CUT AFTER THE FILTER, NOT BEFORE. `listMattersPaged` puts the
 *   filter, the sort and the window in one CTE over the bare `matters` table and
 *   joins the enrichment onto the ids that survived. If a filter ever moved
 *   after the LIMIT, a page would come back short and the total would come back
 *   wrong, and a user would simply see fewer matters than they have. Every
 *   filter case here therefore asserts the page contents AND `totalItems`.
 *
 *   SEARCH IS `ILIKE '%term%'`. The `tsvector` column this table used to carry
 *   was dropped in migration 0140 because `to_tsvector` mangles matter-number
 *   fragments and treats "will" as a stop word. The search cases are written so
 *   that a return to full-text search, or a switch to prefix matching, turns
 *   them red: they match from the MIDDLE of a word, and they pin `%` and `_` as
 *   literal characters.
 *
 * ORDERING CASES USE REVERSE-ALPHABETICAL FIXTURES ON PURPOSE. A sort test whose
 * fixtures are already in the expected order passes against any ordering at all,
 * including none. Every name below is chosen so the expected result differs from
 * insertion order, from creation order, and from the endpoint's default sort.
 *
 * A second firm is seeded before every read, with names chosen to collide with
 * whatever the test is about to ask for. An exact-set assertion is then also a
 * tenancy assertion: a read that lost its `law_firm_id` scope returns the decoy.
 *
 * Fixtures are plain SQL through the test pool. A matter seeded through the
 * repository under test could not expose a bug in it, because the same broken
 * code would produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterClient, seedMatterMember, type MatterSeed } from '../support/matters';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A, sees every matter
let bob: Actor;     // owner at firm B, exists only to own the decoys

const LIST = () => `/api/lawfirms/${firmA.id}/matters`;
const IDS = () => `/api/lawfirms/${firmA.id}/matters/ids`;
const LOOKUP = () => `/api/lawfirms/${firmA.id}/matters/lookup`;

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedCourt(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into courts (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

/** A matter-context invoice, the only source of `outstandingBalanceCents`. */
async function seedMatterInvoice(
  lawFirmId: string, matterId: string, clientId: string, totalCents: number,
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices
       (id, law_firm_id, client_id, matter_id, context_type, invoice_number,
        status, total_cents, invoice_date, due_date)
     values ($1,$2,$3,$4,'matter',$5,'outstanding',$6, current_date, current_date + 30)
     returning id`,
    [id, lawFirmId, clientId, matterId, `INV-${id.slice(0, 8)}`, totalCents],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

/**
 * Plant a matter at the OTHER firm carrying the exact name, number, description
 * or client the test is about to ask for.
 *
 * Every read in this repository is separately responsible for its own
 * `law_firm_id` predicate: the list, the search UNION arms, the ids read and the
 * typeahead are four different SQL statements and each can lose its scope
 * without the others noticing. A decoy makes the exact-set assertion that
 * follows into a tenancy assertion as well.
 */
async function decoyMatter(seed: MatterSeed & { clientName?: string } = {}): Promise<string> {
  const id = await seedMatter(firmB.id, seed);
  await seedMatterMember(firmB.id, id, bob.uid, 'lead');
  if (seed.clientName) {
    const client = await createPersonClient(firmB.id, { name: seed.clientName });
    await seedMatterClient(firmB.id, id, client.id);
  }
  return id;
}

const namesOf = (body: any): string[] => body.matters.map((m: any) => m.name);

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  bob = await ownerOf(firmB.id);
});

describe('derived fields on a matter read', () => {
  it('returns every client of a multi-client matter, ordered by name', async () => {
    // Reverse-alphabetical creation order, so a read that returns the clients in
    // insertion order fails. The repository's `order by cli.name` inside the
    // client lateral is what makes clientNames[0] stable, and the whole app
    // treats clientNames[0] as "the client" of the matter.
    await decoyMatter({ name: 'Decoy', clientName: 'Aaaa Decoy Client' });
    const matterId = await seedMatter(firmA.id, { name: 'Three Client Matter' });
    for (const name of ['Zephyr Holdings', 'Marlow Trust', 'Ainsley Group']) {
      const client = await createPersonClient(firmA.id, { name });
      await seedMatterClient(firmA.id, matterId, client.id);
    }

    const res = await alice.api.get(LIST());
    expect(res.status).toBe(200);
    const matter = res.body.matters.find((m: any) => m.id === matterId);
    expect(matter).toBeDefined();
    expect(matter.clientNames).toEqual(['Ainsley Group', 'Marlow Trust', 'Zephyr Holdings']);
    expect(matter.clientCount).toBe(3);
  });

  it('carries each client id alongside the names, so billing can tell them apart', async () => {
    // `clientNames` is a bare string array; only `clients[]` says WHICH client
    // record each name is. An invoice cannot be attributed from a name.
    const matterId = await seedMatter(firmA.id, { name: 'Identified Clients' });
    const zoe = await createPersonClient(firmA.id, { name: 'Zoe Vance', email: 'zoe@example.test' });
    const abe = await createPersonClient(firmA.id, { name: 'Abe Quinn', email: 'abe@example.test' });
    await seedMatterClient(firmA.id, matterId, zoe.id);
    await seedMatterClient(firmA.id, matterId, abe.id);

    const res = await alice.api.get(`${LIST()}/${matterId}`);
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([
      { id: abe.id, name: 'Abe Quinn', email: 'abe@example.test' },
      { id: zoe.id, name: 'Zoe Vance', email: 'zoe@example.test' },
    ]);
  });

  it('reports every member of a matter with their role, not just the lead', async () => {
    const matterId = await seedMatter(firmA.id, { name: 'Two Member Matter' });
    const second = await createFirmMember(firmA.id, { uid: 'second-member', name: 'Nina Marsh' });
    await seedMatterMember(firmA.id, matterId, alice.uid, 'lead', '2026-01-01T00:00:00Z');
    await seedMatterMember(firmA.id, matterId, second.uid, 'member', '2026-02-01T00:00:00Z');

    const res = await alice.api.get(`${LIST()}/${matterId}`);
    expect(res.status).toBe(200);
    expect(res.body.memberUserIds.sort()).toEqual([alice.uid, second.uid].sort());
    // Ordered by joined_at, which is what makes the member list stable on screen.
    expect(res.body.members.map((m: any) => [m.userId, m.role])).toEqual([
      [alice.uid, 'lead'],
      [second.uid, 'member'],
    ]);
    expect(res.body.members[1].name).toBe('Nina Marsh');
    expect(res.body.leadUserIds).toEqual([alice.uid]);
  });

  it('resolves practice area, court and lead user NAMES through joins', async () => {
    // None of these three names is stored on `matters`; each is a separate LEFT
    // JOIN. Losing one shows as a blank column, never as an error.
    const practiceAreaId = await seedPracticeArea(firmA.id, 'Appellate Practice');
    const courtId = await seedCourt(firmA.id, 'Ninth Circuit');
    const lead = await createFirmMember(firmA.id, { uid: 'lead-user', name: 'Wendell Frost' });
    const matterId = await seedMatter(firmA.id, {
      name: 'Fully Joined Matter', practiceAreaId, courtId, leadUserId: lead.uid,
    });

    const res = await alice.api.get(`${LIST()}/${matterId}`);
    expect(res.status).toBe(200);
    expect(res.body.practiceAreaName).toBe('Appellate Practice');
    expect(res.body.courtName).toBe('Ninth Circuit');
    expect(res.body.leadUserName).toBe('Wendell Frost');
  });

  it('sums the matter own unpaid invoices into outstandingBalanceCents', async () => {
    // The balance lateral is pinned to `inv.law_firm_id = c.law_firm_id` as well
    // as to the matter. Another firm's invoice carrying the same matter id could
    // not exist, but an unpinned sum would still be a cross-tenant read; the
    // figure below is the only place that shows.
    const client = await createPersonClient(firmA.id, { name: 'Billed Client' });
    const matterId = await seedMatter(firmA.id, { name: 'Billed Matter' });
    await seedMatterClient(firmA.id, matterId, client.id);
    await seedMatterInvoice(firmA.id, matterId, client.id, 120_00);
    await seedMatterInvoice(firmA.id, matterId, client.id, 30_50);
    // A second matter's invoice must not leak into this matter's balance.
    const otherMatterId = await seedMatter(firmA.id, { name: 'Other Billed Matter' });
    await seedMatterClient(firmA.id, otherMatterId, client.id);
    await seedMatterInvoice(firmA.id, otherMatterId, client.id, 999_00);

    const res = await alice.api.get(`${LIST()}/${matterId}`);
    expect(res.status).toBe(200);
    expect(res.body.outstandingBalanceCents).toBe(150_50);
  });

  it('gives an empty client list, not a null one, to a matter with no clients', async () => {
    // `coalesce(cl.client_names, '{}')` is what stops a client-less matter
    // arriving as null and breaking every `.map()` on the frontend.
    const matterId = await seedMatter(firmA.id, { name: 'Client Free Matter' });

    const res = await alice.api.get(`${LIST()}/${matterId}`);
    expect(res.status).toBe(200);
    expect(res.body.clientNames).toEqual([]);
    expect(res.body.clients).toEqual([]);
    expect(res.body.clientCount).toBe(0);
    expect(res.body.memberUserIds).toEqual([]);
  });
});

describe('filtering combined with paging', () => {
  it('applies the status filter BEFORE cutting the page', async () => {
    // Three matches and three non-matches, interleaved, with a page size of two.
    // A filter applied after the LIMIT would hand back a page of one (or zero)
    // while reporting six matches.
    await decoyMatter({ name: 'Decoy Archived', status: 'archived' });
    for (const n of [1, 2, 3]) {
      await seedMatter(firmA.id, { name: `Archived ${n}`, status: 'archived' });
      await seedMatter(firmA.id, { name: `Active ${n}`, status: 'active' });
    }

    const first = await alice.api.get(`${LIST()}?status=archived&limit=2&page=1`);
    expect(first.status).toBe(200);
    expect(first.body.matters).toHaveLength(2);
    expect(first.body.totalItems).toBe(3);
    expect(first.body.matters.every((m: any) => m.status === 'archived')).toBe(true);

    const second = await alice.api.get(`${LIST()}?status=archived&limit=2&page=2`);
    expect(second.body.matters).toHaveLength(1);
    expect(second.body.totalItems).toBe(3);
    expect(second.body.matters[0].status).toBe('archived');
  });

  it('pages through the filtered set without repeating or dropping a matter', async () => {
    // The ORDER BY carries `c.id asc` as a tiebreaker precisely so a page
    // boundary is deterministic. Without it, two matters sharing a sort key can
    // both appear on page one and neither on page two.
    for (const n of [1, 2, 3, 4, 5]) {
      await seedMatter(firmA.id, { name: `Paged ${n}`, status: 'active', createdAt: '2026-01-01T00:00:00Z' });
    }

    const p1 = await alice.api.get(`${LIST()}?limit=2&page=1&sortBy=createdAt&order=desc`);
    const p2 = await alice.api.get(`${LIST()}?limit=2&page=2&sortBy=createdAt&order=desc`);
    const p3 = await alice.api.get(`${LIST()}?limit=2&page=3&sortBy=createdAt&order=desc`);
    const seen = [...p1.body.matters, ...p2.body.matters, ...p3.body.matters].map((m: any) => m.id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(p1.body.totalItems).toBe(5);
  });

  it('reports the true total for a page PAST the last match', async () => {
    // An empty page carries no `count(*) over()` row, so the total comes from the
    // fallback count query. Without it the caller is told there are zero matches
    // and renders "no results" instead of clamping back into range.
    for (const n of [1, 2, 3]) {
      await seedMatter(firmA.id, { name: `Ranged ${n}`, status: 'active' });
    }

    const res = await alice.api.get(`${LIST()}?limit=2&page=9`);
    expect(res.status).toBe(200);
    expect(res.body.matters).toEqual([]);
    expect(res.body.totalItems).toBe(3);
  });

  it('filters by practice area across a page boundary', async () => {
    const wanted = await seedPracticeArea(firmA.id, 'Wanted Area');
    const unwanted = await seedPracticeArea(firmA.id, 'Unwanted Area');
    for (const n of [1, 2, 3]) {
      await seedMatter(firmA.id, { name: `In Area ${n}`, practiceAreaId: wanted });
      await seedMatter(firmA.id, { name: `Out Of Area ${n}`, practiceAreaId: unwanted });
    }

    const res = await alice.api.get(`${LIST()}?practiceAreaId=${wanted}&limit=2&page=1`);
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(3);
    expect(res.body.matters).toHaveLength(2);
    expect(res.body.matters.every((m: any) => m.practiceAreaName === 'Wanted Area')).toBe(true);
  });

  it('matches a category node AND everything beneath it', async () => {
    // `matters.category` stores the full ' > '-joined path, not an id, so an
    // equality match would hide every child of the selected node.
    await seedMatter(firmA.id, { name: 'Parent Node', category: 'Litigation' });
    await seedMatter(firmA.id, { name: 'Child Node', category: 'Litigation > Appeals' });
    await seedMatter(firmA.id, { name: 'Grandchild Node', category: 'Litigation > Appeals > Federal' });
    await seedMatter(firmA.id, { name: 'Sibling Node', category: 'Transactional' });

    const res = await alice.api.get(`${LIST()}?category=${encodeURIComponent('Litigation')}&limit=50`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body).sort()).toEqual(['Child Node', 'Grandchild Node', 'Parent Node']);
    expect(res.body.totalItems).toBe(3);
  });

  it('keeps the membership wall in front of the filter, and counts only what the member sees', async () => {
    // A member is not an owner, so `seeAll` is false and the read carries a
    // membership EXISTS. The total must reflect the walled set, not the firm.
    const member = await memberWith(firmA.id, ['matters.view']);
    const mine = await seedMatter(firmA.id, { name: 'Mine Active', status: 'active' });
    await seedMatterMember(firmA.id, mine, member.uid, 'member');
    await seedMatter(firmA.id, { name: 'Theirs Active One', status: 'active' });
    await seedMatter(firmA.id, { name: 'Theirs Active Two', status: 'active' });

    const res = await member.api.get(`${LIST()}?status=active&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Mine Active']);
    expect(res.body.totalItems).toBe(1);
  });
});

describe('sorting', () => {
  it('sorts by name ascending, against both insertion and creation order', async () => {
    // Created oldest-first in ALPHABETICAL order, so the endpoint's default sort
    // (createdAt desc) produces the exact reverse of the expected answer. A
    // response that ignores `sortBy` therefore fails rather than passing by luck.
    await seedMatter(firmA.id, { name: 'Ainsley Matter', createdAt: '2026-01-01T00:00:00Z' });
    await seedMatter(firmA.id, { name: 'Marlow Matter', createdAt: '2026-02-01T00:00:00Z' });
    await seedMatter(firmA.id, { name: 'Zephyr Matter', createdAt: '2026-03-01T00:00:00Z' });

    const sorted = await alice.api.get(`${LIST()}?sortBy=name&order=asc&limit=10`);
    expect(sorted.status).toBe(200);
    expect(namesOf(sorted.body)).toEqual(['Ainsley Matter', 'Marlow Matter', 'Zephyr Matter']);

    const byDefault = await alice.api.get(`${LIST()}?limit=10`);
    expect(namesOf(byDefault.body)).toEqual(['Zephyr Matter', 'Marlow Matter', 'Ainsley Matter']);
  });

  it('puts a matter with NO matter number last when sorting descending', async () => {
    // Postgres defaults DESC to NULLS FIRST, so the explicit `nulls last` in
    // `buildOrderBy` is the only thing keeping the unnumbered matter off the top
    // of the page. Dropping it flips this assertion.
    await seedMatter(firmA.id, { name: 'Numbered High', matterNumber: 'B-002' });
    await seedMatter(firmA.id, { name: 'Numbered Low', matterNumber: 'A-001' });
    await seedMatter(firmA.id, { name: 'Unnumbered', matterNumber: null });

    const res = await alice.api.get(`${LIST()}?sortBy=matterNumber&order=desc&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Numbered High', 'Numbered Low', 'Unnumbered']);
  });

  it('sorts by lead user NAME rather than by lead user id', async () => {
    // The uids are deliberately in the OPPOSITE order to the names. Sorting the
    // raw `lead_user_id` column instead of the joined `users.name` reverses this
    // result, and on screen it looks merely like an unfamiliar order.
    const zAbel = await createFirmMember(firmA.id, { uid: 'aaa-uid', name: 'Zena Abel' });
    const aQuinn = await createFirmMember(firmA.id, { uid: 'zzz-uid', name: 'Abel Quinn' });
    await seedMatter(firmA.id, { name: 'Led By Zena', leadUserId: zAbel.uid });
    await seedMatter(firmA.id, { name: 'Led By Abel', leadUserId: aQuinn.uid });

    const res = await alice.api.get(`${LIST()}?sortBy=leadUser&order=asc&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Led By Abel', 'Led By Zena']);
  });

  it('applies a multi-column sort model in the order given', async () => {
    // `status asc` groups first, `name desc` orders within the group. Neither
    // column alone produces this sequence, so a model that honours only its
    // first (or only its last) entry fails.
    await seedMatter(firmA.id, { name: 'Alpha', status: 'closed' });
    await seedMatter(firmA.id, { name: 'Bravo', status: 'active' });
    await seedMatter(firmA.id, { name: 'Charlie', status: 'closed' });
    await seedMatter(firmA.id, { name: 'Delta', status: 'active' });

    const res = await alice.api.get(`${LIST()}?sort=${encodeURIComponent('status:asc,name:desc')}&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Delta', 'Bravo', 'Charlie', 'Alpha']);
  });

  it('holds the sort across a page boundary rather than sorting each page alone', async () => {
    // The ORDER BY is applied inside the paging CTE (to choose the page) and
    // again outside it (the join does not preserve CTE order). Losing the outer
    // one leaves each page internally shuffled while the page contents look
    // plausible.
    for (const name of ['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']) {
      await seedMatter(firmA.id, { name });
    }

    const p1 = await alice.api.get(`${LIST()}?sortBy=name&order=asc&limit=3&page=1`);
    const p2 = await alice.api.get(`${LIST()}?sortBy=name&order=asc&limit=3&page=2`);
    expect(namesOf(p1.body)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(namesOf(p2.body)).toEqual(['Delta', 'Echo']);
  });
});

describe('search', () => {
  it('matches a fragment from the MIDDLE of a matter name', async () => {
    // `etherb` is neither a prefix of the name nor of any word in it. A prefix
    // match, or a return to `to_tsvector`, returns nothing here.
    await decoyMatter({ name: 'Consolidated Wetherby Appeal' });
    await seedMatter(firmA.id, { name: 'Consolidated Wetherby Appeal' });
    await seedMatter(firmA.id, { name: 'Unrelated Filing' });

    const res = await alice.api.get(`${LIST()}?search=etherb&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Consolidated Wetherby Appeal']);
    expect(res.body.totalItems).toBe(1);
  });

  it('matches a fragment of the matter NUMBER', async () => {
    // The tsvector this table used to carry kept a leading hyphen on a
    // matter-number fragment, so `2024-01` never matched. ILIKE has no such
    // tokenisation.
    await seedMatter(firmA.id, { name: 'Numbered Matter', matterNumber: 'LIT-2024-0198' });
    await seedMatter(firmA.id, { name: 'Other Matter', matterNumber: 'LIT-2019-0044' });

    const res = await alice.api.get(`${LIST()}?search=2024-01&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Numbered Matter']);
  });

  it('matches text in the description', async () => {
    await seedMatter(firmA.id, { name: 'Plain Name', description: 'Slip and fall at the Wetherby depot' });
    await seedMatter(firmA.id, { name: 'Another Name', description: 'Contract dispute' });

    const res = await alice.api.get(`${LIST()}?search=depot&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Plain Name']);
  });

  it('matches a LINKED CLIENT name, and never another firm client of that name', async () => {
    // Both halves are needed. Without the positive the case would pass against a
    // client arm that matches nothing at all; without the decoy it would pass
    // against one that has lost its `law_firm_id` pin.
    await decoyMatter({ name: 'Decoy Ravenscroft Matter', clientName: 'Ravenscroft Industries' });
    const matterId = await seedMatter(firmA.id, { name: 'Named Nothing Like The Client' });
    const client = await createPersonClient(firmA.id, { name: 'Ravenscroft Industries' });
    await seedMatterClient(firmA.id, matterId, client.id);

    const res = await alice.api.get(`${LIST()}?search=avenscrof&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Named Nothing Like The Client']);
    expect(res.body.totalItems).toBe(1);
  });

  it('treats % in a search term as a literal percent sign', async () => {
    // "Case 500 Filing" contains `50` but not `50%`. An unescaped term becomes
    // `%50%%`, which matches it too, so this case distinguishes an escaped term
    // from an unescaped one rather than merely proving search works.
    await seedMatter(firmA.id, { name: 'Discount 50% Recovery' });
    await seedMatter(firmA.id, { name: 'Case 500 Filing' });

    const res = await alice.api.get(`${LIST()}?search=${encodeURIComponent('50%')}&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Discount 50% Recovery']);
    expect(res.body.totalItems).toBe(1);
  });

  it('treats _ in a search term as a literal underscore', async () => {
    // `_` is LIKE's single-character wildcard. Unescaped, `t_F` also matches the
    // `tXF` in "ClientXFile", so the second fixture is what makes this fail on an
    // unescaped term.
    await seedMatter(firmA.id, { name: 'Client_File Review' });
    await seedMatter(firmA.id, { name: 'ClientXFile Review' });

    const res = await alice.api.get(`${LIST()}?search=${encodeURIComponent('t_F')}&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Client_File Review']);
    expect(res.body.totalItems).toBe(1);
  });

  it('is case-insensitive, as ILIKE and not LIKE', async () => {
    await seedMatter(firmA.id, { name: 'Wetherby Appeal' });

    const res = await alice.api.get(`${LIST()}?search=WETHERBY&limit=10`);
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Wetherby Appeal']);
  });

  it('combines search with a status filter and a page, reporting the searched total', async () => {
    // Search and filter must intersect, and the intersection must be counted
    // before the window. Six matters contain "Wetherby"; three are archived.
    for (const n of [1, 2, 3]) {
      await seedMatter(firmA.id, { name: `Wetherby Archived ${n}`, status: 'archived' });
      await seedMatter(firmA.id, { name: `Wetherby Active ${n}`, status: 'active' });
    }
    await seedMatter(firmA.id, { name: 'Unrelated Archived', status: 'archived' });

    const res = await alice.api.get(`${LIST()}?search=etherby&status=archived&limit=2&page=1`);
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(3);
    expect(res.body.matters).toHaveLength(2);
    expect(res.body.matters.every((m: any) => m.status === 'archived')).toBe(true);
    expect(res.body.matters.every((m: any) => m.name.includes('Wetherby'))).toBe(true);
  });
});

describe('the ids-only read behind "select all"', () => {
  it('returns every id the SAME filters would list, ignoring the page size', async () => {
    // The grid's "select all" means the whole filtered set, not the page. If this
    // read and the list read ever disagreed, a bulk action would silently act on
    // a different set than the one the user was looking at.
    await decoyMatter({ name: 'Decoy Archived', status: 'archived' });
    for (const n of [1, 2, 3, 4] as const) {
      await seedMatter(firmA.id, { name: `Archived ${n}`, status: 'archived' });
    }
    await seedMatter(firmA.id, { name: 'Active One', status: 'active' });

    const ids = await alice.api.get(`${IDS()}?status=archived`);
    expect(ids.status).toBe(200);
    expect(ids.body.ids).toHaveLength(4);
    expect(ids.body.totalItems).toBe(4);
    expect(ids.body.truncated).toBe(false);

    const list = await alice.api.get(`${LIST()}?status=archived&limit=2`);
    expect(list.body.totalItems).toBe(4);
    expect(new Set(ids.body.ids)).toEqual(
      new Set((await alice.api.get(`${LIST()}?status=archived&limit=50`)).body.matters.map((m: any) => m.id)),
    );
  });

  it('honours the search term, and does not reach the other firm', async () => {
    await decoyMatter({ name: 'Wetherby Decoy' });
    const wanted = await seedMatter(firmA.id, { name: 'Wetherby Appeal' });
    await seedMatter(firmA.id, { name: 'Unrelated' });

    const res = await alice.api.get(`${IDS()}?search=etherby`);
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([wanted]);
  });

  it('widens a person client to the organizations they belong to, as the list does', async () => {
    // The list widens `clientId` across client_company_links; the ids read used
    // the bare id, so a person's "select all" missed every matter that belongs to
    // their organization and a bulk action acted on a smaller set than the grid
    // showed. Red if the ids path stops resolving the effective client ids.
    const person = await createPersonClient(firmA.id, { name: 'Pat Person' });
    const org = await createOrgClient(firmA.id, { name: 'Acme Org' });
    await linkPersonToOrg(firmA.id, person.id, org.id, { canViewBilling: false });
    const direct = await seedMatter(firmA.id, { name: 'Direct', clientIds: [person.id] });
    const viaOrg = await seedMatter(firmA.id, { name: 'Via Org', clientIds: [org.id] });
    await seedMatter(firmA.id, { name: 'Unrelated' });

    const ids = await alice.api.get(`${IDS()}?clientId=${person.id}`);
    expect(ids.status).toBe(200);
    expect([...ids.body.ids].sort()).toEqual([direct, viaOrg].sort());

    const list = await alice.api.get(`${LIST()}?clientId=${person.id}&limit=50`);
    expect([...list.body.matters.map((m: any) => m.id)].sort()).toEqual([...ids.body.ids].sort());
  });

  it('stops at the matters a member may see', async () => {
    const member = await memberWith(firmA.id, ['matters.view']);
    const mine = await seedMatter(firmA.id, { name: 'Mine' });
    await seedMatterMember(firmA.id, mine, member.uid, 'member');
    await seedMatter(firmA.id, { name: 'Not Mine' });

    const res = await member.api.get(IDS());
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([mine]);
  });
});

describe('the matter picker typeahead', () => {
  it('orders items by name, against creation order', async () => {
    await seedMatter(firmA.id, { name: 'Ainsley Pick', createdAt: '2026-01-01T00:00:00Z' });
    await seedMatter(firmA.id, { name: 'Marlow Pick', createdAt: '2026-02-01T00:00:00Z' });
    await seedMatter(firmA.id, { name: 'Zephyr Pick', createdAt: '2026-03-01T00:00:00Z' });

    const res = await alice.api.get(`${LOOKUP()}?search=Pick`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Ainsley Pick', 'Marlow Pick', 'Zephyr Pick']);
  });

  it('puts the matter clients in the sublabel, joined and name-ordered', async () => {
    const matterId = await seedMatter(firmA.id, { name: 'Sublabel Matter' });
    for (const name of ['Zephyr Co', 'Ainsley Co']) {
      const client = await createPersonClient(firmA.id, { name });
      await seedMatterClient(firmA.id, matterId, client.id);
    }

    const res = await alice.api.get(`${LOOKUP()}?search=Sublabel`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].sublabel).toBe('Ainsley Co, Zephyr Co');
  });

  it('narrows to one client matters when scoped by clientId', async () => {
    // A trust-transaction or invoice picker scoped to a client must not offer
    // another client's matter: money moved on the wrong matter is a trust
    // accounting error, not a cosmetic one.
    const wanted = await createPersonClient(firmA.id, { name: 'Scoped Client' });
    const other = await createPersonClient(firmA.id, { name: 'Other Client' });
    const wantedMatter = await seedMatter(firmA.id, { name: 'Scoped Matter' });
    const otherMatter = await seedMatter(firmA.id, { name: 'Unscoped Matter' });
    await seedMatterClient(firmA.id, wantedMatter, wanted.id);
    await seedMatterClient(firmA.id, otherMatter, other.id);

    const res = await alice.api.get(`${LOOKUP()}?clientId=${wanted.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Scoped Matter']);
  });

  it('returns NOTHING for an unusable clientId rather than every matter', async () => {
    // The dangerous failure is the opposite of an error: answering "this client's
    // matters" with the whole firm. Two matters exist, so an unscoped fallback
    // would be visible here.
    await seedMatter(firmA.id, { name: 'First Matter' });
    await seedMatter(firmA.id, { name: 'Second Matter' });

    const res = await alice.api.get(`${LOOKUP()}?clientId=not-a-uuid`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('resolves ids exactly, and resolves NOTHING for another firm id', async () => {
    // Id resolution labels an already-saved selection. Falling through to the
    // search branch on a stale id would label the selection with an arbitrary
    // matter, so the picker would display the wrong one as chosen.
    const mine = await seedMatter(firmA.id, { name: 'My Saved Matter' });
    await seedMatter(firmA.id, { name: 'Some Other Matter' });
    const theirs = await decoyMatter({ name: 'Their Saved Matter' });

    const ok = await alice.api.get(`${LOOKUP()}?ids=${mine}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i: any) => i.label)).toEqual(['My Saved Matter']);

    const crossFirm = await alice.api.get(`${LOOKUP()}?ids=${theirs}`);
    expect(crossFirm.status).toBe(200);
    expect(crossFirm.body.items).toEqual([]);

    // A malformed id leaves the filter with nothing to match on. Falling through
    // to the unfiltered branch here would answer with an arbitrary page of
    // matters, which the picker would then render as the saved selection.
    const malformed = await alice.api.get(`${LOOKUP()}?ids=not-a-uuid`);
    expect(malformed.status).toBe(200);
    expect(malformed.body.items).toEqual([]);
  });

  it('reports hasMore instead of a total, and caps the page', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await seedMatter(firmA.id, { name: `Capped ${n}` });
    }

    const res = await alice.api.get(`${LOOKUP()}?search=Capped&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.totalItems).toBeUndefined();
  });

  it('keeps a member inside the ethical wall', async () => {
    const member = await memberWith(firmA.id, ['matters.view']);
    const mine = await seedMatter(firmA.id, { name: 'Walled Mine' });
    await seedMatterMember(firmA.id, mine, member.uid, 'member');
    await seedMatter(firmA.id, { name: 'Walled Theirs' });

    const res = await member.api.get(`${LOOKUP()}?search=Walled`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Walled Mine']);
  });
});

describe('tenancy on the enriched reads', () => {
  it('does not lend one firm practice area or court name to another firm matter', async () => {
    // The practice-area and court joins are on id alone (`pa.id = c.practice_area_id`),
    // with no firm predicate of their own. They are safe only because the matter
    // itself is firm-scoped, so this pins that the enriched read cannot be
    // reached with a foreign matter in the first place.
    const foreignArea = await seedPracticeArea(firmB.id, 'Firm B Area');
    const foreignMatter = await seedMatter(firmB.id, { name: 'Firm B Matter', practiceAreaId: foreignArea });
    await seedMatterMember(firmB.id, foreignMatter, bob.uid, 'lead');

    const res = await alice.api.get(`${LIST()}/${foreignMatter}`);
    expect(res.status).toBe(404);

    const list = await alice.api.get(`${LIST()}?limit=50`);
    expect(list.body.matters).toEqual([]);
  });

  it('does not count another firm matters in the paged total', async () => {
    // The total comes from a `count(*) over()` inside the paging CTE, which is a
    // separate predicate from the one the enriched select uses. A leak there
    // shows only as a page count that is too high.
    for (const n of [1, 2, 3, 4, 5]) {
      await decoyMatter({ name: `Firm B ${n}` });
    }
    await seedMatter(firmA.id, { name: 'Only Firm A Matter' });

    const res = await alice.api.get(`${LIST()}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(1);
    expect(namesOf(res.body)).toEqual(['Only Firm A Matter']);
  });

  it('refuses a caller who belongs to neither firm', async () => {
    await seedMatter(firmA.id, { name: 'Private Matter' });
    const outsider = as(tokenFor({ uid: 'outsider-uid' }));

    const res = await outsider.get(`${LIST()}?limit=10`);
    expect(res.status).toBe(403);
  });
});

describe('query validation', () => {
  it('refuses a sortBy outside the whitelist rather than silently ignoring it', async () => {
    // `sortBy` is a `z.enum` over MATTER_SORT_FIELDS. Letting an unrecognised
    // column through would either produce a sort that quietly does nothing or,
    // if it ever reached the repository unguarded, an arbitrary column name in
    // the ORDER BY.
    const res = await alice.api.get(`${LIST()}?sortBy=secretColumn&limit=10`);

    expect(res.status).toBe(400);
  });

  it('refuses a limit past the page-size ceiling', async () => {
    const res = await alice.api.get(`${LIST()}?limit=501`);

    // 500 is the documented ceiling (`paging({ max: 500 })`). Accepting more
    // turns one request into an unbounded scan of the firm's matters.
    expect(res.status).toBe(400);
  });

  it('refuses page zero', async () => {
    const res = await alice.api.get(`${LIST()}?page=0&limit=10`);

    expect(res.status).toBe(400);
  });

  it('refuses a bulk matterIds array holding a non-string element', async () => {
    const mine = await seedMatter(firmA.id, { name: 'Mine' });

    const res = await alice.api.post(`/api/lawfirms/${firmA.id}/matters/bulk-delete`)
      .send({ matterIds: [mine, 12345] });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select id from matters where id = $1', [mine]);
    expect(rows).toHaveLength(1);
  });
});
