/**
 * The reference catalog: what a firm can read out of the shared directories, and
 * what "adopting" an entry actually writes.
 *
 * `catalog.service.ts` had no in-process coverage. Adoption is the one place in
 * the app where a GLOBAL, cross-tenant table is read and then copied into a
 * firm-scoped one, so it is the one place where a missing `law_firm_id` on the
 * write side would land another firm's rows in this firm's court list, or this
 * firm's charge codes in everybody's. The copies also carry a provenance link
 * (`catalog_court_id` / `utbms_code_id`) that the double-import guard reads, so
 * a broken link silently turns adoption from idempotent into duplicating.
 *
 * Every case seeds the catalog with SQL first. The catalog tables are truncated
 * between specs like everything else, so a case that did not seed them would
 * assert "nothing was adopted" against a directory that was empty to begin with,
 * and would pass whether the route worked or not.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const C = (lawFirmId: string, suffix: string) => `/api/lawfirms/${lawFirmId}/catalog${suffix}`;

interface CatalogCourtOptions {
  fullName?: string;
  shortName?: string | null;
  citationAbbrev?: string | null;
  jurisdiction?: string | null;
  courtType?: string | null;
  state?: string | null;
}

/** One row in the global court directory. Not owned by any firm. */
async function seedCatalogCourt(options: CatalogCourtOptions = {}) {
  const id = randomUUID();
  await testPool.query(
    `insert into court_catalog
       (id, source, source_id, full_name, short_name, citation_abbrev,
        jurisdiction, court_type, state)
     values ($1, 'courtlistener', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      id,
      options.fullName ?? `Catalog Court ${id.slice(0, 8)}`,
      options.shortName ?? null,
      options.citationAbbrev ?? null,
      options.jurisdiction ?? 'state',
      options.courtType ?? 'trial',
      options.state ?? 'NY',
    ],
  );
  return { id };
}

interface UtbmsOptions {
  code?: string;
  name?: string;
  codeType?: 'task' | 'activity' | 'expense';
  practiceSet?: string | null;
  isActive?: boolean;
}

/** One row in the global UTBMS directory. Also unowned. */
async function seedUtbmsCode(options: UtbmsOptions = {}) {
  const id = randomUUID();
  const code = options.code ?? `L${id.slice(0, 4)}`;
  await testPool.query(
    `insert into utbms_codes (id, code, name, code_type, practice_set, is_active)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      code,
      options.name ?? `UTBMS ${code}`,
      options.codeType ?? 'task',
      options.practiceSet ?? 'litigation',
      options.isActive ?? true,
    ],
  );
  return { id, code };
}

const courtRows = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select name, abbreviation, state, court_type, catalog_court_id, sort_order
       from courts where law_firm_id = $1 order by name`,
    [lawFirmId],
  );
  return rows;
};

const chargeCodeRows = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select code, name, utbms_code_id, is_active, sort_order
       from billing_codes where law_firm_id = $1 and kind = 'charge' order by code`,
    [lawFirmId],
  );
  return rows;
};

const expenseCategoryRows = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select code, name, utbms_code_id, is_default, sort_order
       from billing_codes where law_firm_id = $1 and kind = 'expense' order by code`,
    [lawFirmId],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('searching the court directory', () => {
  it('lists the whole directory with a total, and carries the adoption flag', async () => {
    await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    await seedCatalogCourt({ fullName: 'Queens County Civil Court' });

    const res = await owner.api.get(C(firm.id, '/courts'));

    expect(res.status).toBe(200);
    expect(res.body.items.map((row: any) => row.fullName)).toEqual([
      'Kings County Supreme Court',
      'Queens County Civil Court',
    ]);
    expect(res.body.totalItems).toBe(2);
    // The picker renders an "Added" badge off this key, so it has to be present
    // on every row rather than only on the adopted ones.
    expect(res.body.items.every((row: any) => 'alreadyAdded' in row)).toBe(true);
  });

  it('marks a court the firm adopted as already added, and only that one', async () => {
    const adoptedCourt = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    const untouched = await seedCatalogCourt({ fullName: 'Queens County Civil Court' });
    const adopted = await owner.api.post(C(firm.id, '/courts/adopt'))
      .send({ catalogCourtIds: [adoptedCourt.id] });
    // Proven adopted first, so a false flag below is the flag being wrong and
    // not a court that was never written.
    expect(adopted.body).toMatchObject({ adopted: 1 });
    expect((await courtRows(firm.id))[0].catalog_court_id).toBe(adoptedCourt.id);

    const res = await owner.api.get(C(firm.id, '/courts'));

    // Both rows, not just the adopted one. `searchCourts` builds this flag with
    // a correlated EXISTS, and Drizzle renders a bare column reference WITHOUT a
    // table prefix when the outer query has a single FROM table. `courts` has its
    // own `id`, so the unqualified form bound the correlation target to
    // `courts.id`: Postgres read the filter as
    // `courts.catalog_court_id = courts.id`, the subquery stopped being
    // correlated at all, and the flag was false for every row at every firm.
    // Asserting the untouched row too is what stops the opposite mistake, a
    // subquery that always returns true, from passing.
    const byName = Object.fromEntries(
      res.body.items.map((row: any) => [row.fullName, row.alreadyAdded]),
    );
    expect(byName['Kings County Supreme Court']).toBe(true);
    expect(byName['Queens County Civil Court']).toBe(false);
    expect(untouched.id).toBeDefined();
  });

  it('scopes already-added to the asking firm', async () => {
    // The tenancy half of the same flag. A subquery that lost its `law_firm_id`
    // predicate would still pass the case above.
    const court = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    const adopted = await owner.api.post(C(firm.id, '/courts/adopt'))
      .send({ catalogCourtIds: [court.id] });
    expect(adopted.body).toMatchObject({ adopted: 1 });

    const mine = await owner.api.get(C(firm.id, '/courts'));
    const theirs = await otherOwner.api.get(C(otherFirm.id, '/courts'));

    expect(mine.body.items[0].alreadyAdded).toBe(true);
    expect(theirs.body.items[0].alreadyAdded).toBe(false);
  });

  it('filters by the search term rather than returning everything', async () => {
    await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    await seedCatalogCourt({ fullName: 'Second Circuit Court of Appeals' });

    const res = await owner.api.get(C(firm.id, '/courts')).query({ search: 'Kings' });

    expect(res.status).toBe(200);
    expect(res.body.items.map((row: any) => row.fullName)).toEqual(['Kings County Supreme Court']);
    expect(res.body.totalItems).toBe(1);
  });

  it('reports a total of zero, not a missing total, when nothing matches', async () => {
    // A count over an empty match set comes back 0, which is falsy, so the
    // total is the repository's fallback rather than the count itself. The
    // picker prints "0 results" off this number and pages off it.
    await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });

    const res = await owner.api.get(C(firm.id, '/courts')).query({ state: 'WY' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], totalItems: 0 });
  });

  it('filters by state', async () => {
    await seedCatalogCourt({ fullName: 'New York Court', state: 'NY' });
    await seedCatalogCourt({ fullName: 'California Court', state: 'CA' });

    const res = await owner.api.get(C(firm.id, '/courts')).query({ state: 'CA' });

    expect(res.body.items.map((row: any) => row.fullName)).toEqual(['California Court']);
    expect(res.body.totalItems).toBe(1);
  });

  it('pages with limit and offset while reporting the unpaged total', async () => {
    await seedCatalogCourt({ fullName: 'AAA Court' });
    await seedCatalogCourt({ fullName: 'BBB Court' });
    await seedCatalogCourt({ fullName: 'CCC Court' });

    const page = await owner.api.get(C(firm.id, '/courts')).query({ limit: 1, offset: 1 });

    // Ordered by full_name, so the second row is deterministic. `totalItems`
    // must describe the whole match set: report the page length instead and the
    // picker shows "1 result" on a directory of thousands.
    expect(page.body.items.map((row: any) => row.fullName)).toEqual(['BBB Court']);
    expect(page.body.totalItems).toBe(3);
  });

  it('refuses a member without courts.manage', async () => {
    await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(C(firm.id, '/courts'));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Kings County Supreme Court');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });

    const res = await otherOwner.api.get(C(firm.id, '/courts'));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Kings County Supreme Court');
  });
});

describe('adopting a court', () => {
  const adopt = (actor: Actor, lawFirmId: string, catalogCourtIds: unknown) =>
    actor.api.post(C(lawFirmId, '/courts/adopt')).send({ catalogCourtIds });

  it('copies the catalog row into the caller firm and nowhere else', async () => {
    const court = await seedCatalogCourt({
      fullName: 'Kings County Supreme Court',
      citationAbbrev: 'N.Y. Sup. Ct.',
      state: 'NY',
      courtType: 'trial',
    });

    const res = await adopt(owner, firm.id, [court.id]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 1, skipped: 0 });
    expect(await courtRows(firm.id)).toEqual([
      expect.objectContaining({
        name: 'Kings County Supreme Court',
        abbreviation: 'N.Y. Sup. Ct.',
        state: 'NY',
        court_type: 'trial',
        catalog_court_id: court.id,
      }),
    ]);
    // The other firm is seeded with an owner and asked for explicitly, so this
    // is an empty list where a leak would show a row, not an empty database.
    expect(await courtRows(otherFirm.id)).toEqual([]);
  });

  it('falls back to the short name when the catalog row has no citation abbreviation', async () => {
    const court = await seedCatalogCourt({
      fullName: 'Second Circuit Court of Appeals',
      citationAbbrev: null,
      shortName: '2d Cir.',
    });

    await adopt(owner, firm.id, [court.id]);

    // The abbreviation is what the matter header and the calendar chip display.
    // Collapse the fallback and every court adopted from a row without a
    // citation abbreviation loses its short form across the app.
    expect((await courtRows(firm.id))[0].abbreviation).toBe('2d Cir.');
  });

  it('skips a court the firm already adopted instead of duplicating it', async () => {
    const court = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    await adopt(owner, firm.id, [court.id]);

    const res = await adopt(owner, firm.id, [court.id]);

    // The provenance link is the only thing that makes this idempotent: the
    // copy is freely editable, so a renamed court cannot be matched by name.
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 0, skipped: 1 });
    expect(await courtRows(firm.id)).toHaveLength(1);
  });

  it('adopts nothing for an id that is not in the catalog', async () => {
    const missing = randomUUID();

    const res = await adopt(owner, firm.id, [missing]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 0 });
    expect(await courtRows(firm.id)).toEqual([]);
  });

  it('adopts the real ids in a batch that also names a missing one', async () => {
    const court = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });

    const res = await adopt(owner, firm.id, [court.id, randomUUID()]);

    // Partial batches are ordinary: the picker sends whatever ids the page was
    // rendered with, and the catalog is re-imported. One stale id must not cost
    // the user the rest of the selection.
    expect(res.body).toMatchObject({ requested: 2, adopted: 1 });
    expect(await courtRows(firm.id)).toHaveLength(1);
  });

  it('numbers each adopted court after the firm existing ones', async () => {
    await testPool.query(
      `insert into courts (law_firm_id, name, sort_order) values ($1, 'Existing Court', 7)`,
      [firm.id],
    );
    const first = await seedCatalogCourt({ fullName: 'AAA Court' });
    const second = await seedCatalogCourt({ fullName: 'BBB Court' });

    await adopt(owner, firm.id, [first.id, second.id]);

    // sort_order drives the order of the court dropdown. Restarting from zero
    // would interleave adopted courts with the firm's hand-entered ones.
    const orders = (await courtRows(firm.id))
      .filter((row: any) => row.name !== 'Existing Court')
      .map((row: any) => row.sort_order);
    expect(orders.sort()).toEqual([8, 9]);
  });

  it('refuses an empty selection', async () => {
    const res = await adopt(owner, firm.id, []);

    expect(res.status).toBe(400);
  });

  it('refuses an id that is not a uuid', async () => {
    const res = await adopt(owner, firm.id, ['not-a-uuid']);

    // `catalog_court_id` is a uuid column and the lookup runs `in (...)` against
    // one. Without the schema check this reaches Postgres as a cast error and
    // answers 500 on a mistyped or probed request.
    expect(res.status).toBe(400);
  });

  it('refuses a member without courts.manage and writes nothing', async () => {
    const court = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });
    const narrow = await memberWith(firm.id, ['practiceAreas.manage']);

    const res = await adopt(narrow, firm.id, [court.id]);

    // The catalog row exists, so a granted request here would have written a
    // court. The empty table below is the gate refusing, not an empty world.
    expect(res.status).toBe(403);
    expect(await courtRows(firm.id)).toEqual([]);
  });

  it('refuses a member of another firm adopting under this firm', async () => {
    const court = await seedCatalogCourt({ fullName: 'Kings County Supreme Court' });

    const res = await adopt(otherOwner, firm.id, [court.id]);

    expect(res.status).toBe(403);
    expect(await courtRows(firm.id)).toEqual([]);
  });
});

describe('listing UTBMS codes', () => {
  it('lists the active codes and leaves the retired ones out', async () => {
    await seedUtbmsCode({ code: 'L100', name: 'Case Assessment', isActive: true });
    await seedUtbmsCode({ code: 'L999', name: 'Retired Code', isActive: false });

    const res = await owner.api.get(C(firm.id, '/utbms'));

    expect(res.status).toBe(200);
    expect(res.body.utbmsCodes.map((row: any) => row.code)).toEqual(['L100']);
    expect(res.body.totalItems).toBe(1);
  });

  it('filters by code type', async () => {
    await seedUtbmsCode({ code: 'L100', codeType: 'task' });
    await seedUtbmsCode({ code: 'E101', codeType: 'expense' });

    const res = await owner.api.get(C(firm.id, '/utbms')).query({ codeType: 'expense' });

    expect(res.body.utbmsCodes.map((row: any) => row.code)).toEqual(['E101']);
  });

  it('filters by practice set', async () => {
    await seedUtbmsCode({ code: 'L100', practiceSet: 'litigation' });
    await seedUtbmsCode({ code: 'B100', practiceSet: 'bankruptcy' });

    const res = await owner.api.get(C(firm.id, '/utbms')).query({ practiceSet: 'bankruptcy' });

    expect(res.body.utbmsCodes.map((row: any) => row.code)).toEqual(['B100']);
  });

  it('refuses a code type the enum does not name', async () => {
    const res = await owner.api.get(C(firm.id, '/utbms')).query({ codeType: 'nonsense' });

    expect(res.status).toBe(400);
  });

  it('refuses a member with an empty role the UTBMS list', async () => {
    await seedUtbmsCode({ code: 'L100', name: 'Case Assessment' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(C(firm.id, '/utbms'));

    // The route asks for `billing.viewRates`, which is not in DEFAULT_PERMISSIONS,
    // so the list needs an explicit grant even though UTBMS is a published code
    // list. Seeded first, so the refusal is not an empty catalog.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Case Assessment');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedUtbmsCode({ code: 'L100', name: 'Case Assessment' });

    const res = await otherOwner.api.get(C(firm.id, '/utbms'));

    expect(res.status).toBe(403);
  });
});

describe('adopting charge codes', () => {
  const adopt = (actor: Actor, lawFirmId: string, utbmsCodeIds: unknown) =>
    actor.api.post(C(lawFirmId, '/charge-codes/adopt')).send({ utbmsCodeIds });

  it('copies a task code into the caller firm charge codes and nowhere else', async () => {
    const code = await seedUtbmsCode({ code: 'l100', name: 'Case Assessment', codeType: 'task' });

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 1, skipped: 0 });
    expect(await chargeCodeRows(firm.id)).toEqual([
      expect.objectContaining({
        // Upper-cased on the way in. `charge_codes` is unique on
        // (law_firm_id, code) as stored, so a lower-case copy would sit beside
        // an existing 'L100' as a second, indistinguishable row.
        code: 'L100',
        name: 'Case Assessment',
        utbms_code_id: code.id,
        is_active: true,
      }),
    ]);
    expect(await chargeCodeRows(otherFirm.id)).toEqual([]);
  });

  it('adopts nothing when the code is an expense code', async () => {
    const code = await seedUtbmsCode({ code: 'E101', codeType: 'expense' });

    const res = await adopt(owner, firm.id, [code.id]);

    // The two adopt routes share one routine and separate on `code_type`. Drop
    // the filter and E-codes land in the charge-code dropdown, where they would
    // be billed as time.
    expect(res.body).toMatchObject({ requested: 1, adopted: 0 });
    expect(await chargeCodeRows(firm.id)).toEqual([]);
  });

  it('skips a code the firm already adopted', async () => {
    const code = await seedUtbmsCode({ code: 'L100', codeType: 'task' });
    await adopt(owner, firm.id, [code.id]);

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.body).toMatchObject({ adopted: 0, skipped: 1 });
    expect(await chargeCodeRows(firm.id)).toHaveLength(1);
  });

  it('skips a code whose text the firm already uses under its own row', async () => {
    // A hand-entered code with no provenance link: the adoption guard cannot see
    // it, so only the code-text check stops the insert. Without that check this
    // violates unique (law_firm_id, code) and answers 500.
    await testPool.query(
      `insert into billing_codes (law_firm_id, kind, code, name) values ($1, 'charge', 'L100', 'Our Own Assessment')`,
      [firm.id],
    );
    const code = await seedUtbmsCode({ code: 'L100', name: 'Case Assessment', codeType: 'task' });

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ adopted: 0, skipped: 1 });
    const rows = await chargeCodeRows(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Our Own Assessment');
  });

  it('adopts one row when two catalog codes normalise to the same code text', async () => {
    // `utbms_codes` is unique on the raw text, so 'L100' and 'l100' are two
    // legitimate catalog rows. They collapse to one code once upper-cased, and
    // only the in-batch bookkeeping stops the second insert: the already-adopted
    // guard was computed before either landed. Without it the second insert
    // violates unique (law_firm_id, code) and the whole batch answers 500.
    const first = await seedUtbmsCode({ code: 'L100', name: 'Case Assessment', codeType: 'task' });
    const second = await seedUtbmsCode({ code: 'l100', name: 'Duplicate Assessment', codeType: 'task' });

    const res = await adopt(owner, firm.id, [first.id, second.id]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 2, adopted: 1, skipped: 1 });
    expect(await chargeCodeRows(firm.id)).toHaveLength(1);
  });

  it('adopts nothing for an id that is not in the catalog', async () => {
    const res = await adopt(owner, firm.id, [randomUUID()]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 0 });
    expect(await chargeCodeRows(firm.id)).toEqual([]);
  });

  it('refuses a member without billing.manageRates and writes nothing', async () => {
    const code = await seedUtbmsCode({ code: 'L100', codeType: 'task' });
    // Holding the read code alone must not be enough, so this proves the write
    // route asks for the manage code rather than for the view one.
    const narrow = await memberWith(firm.id, ['billing.viewRates']);

    const res = await adopt(narrow, firm.id, [code.id]);

    expect(res.status).toBe(403);
    expect(await chargeCodeRows(firm.id)).toEqual([]);
  });

  it('refuses a member of another firm adopting under this firm', async () => {
    const code = await seedUtbmsCode({ code: 'L100', codeType: 'task' });

    const res = await adopt(otherOwner, firm.id, [code.id]);

    expect(res.status).toBe(403);
    expect(await chargeCodeRows(firm.id)).toEqual([]);
  });

  it('refuses an empty selection', async () => {
    expect((await adopt(owner, firm.id, [])).status).toBe(400);
  });
});

describe('adopting expense categories', () => {
  const adopt = (actor: Actor, lawFirmId: string, utbmsCodeIds: unknown) =>
    actor.api.post(C(lawFirmId, '/expense-categories/adopt')).send({ utbmsCodeIds });

  it('copies an expense code into the caller firm categories and nowhere else', async () => {
    const code = await seedUtbmsCode({ code: 'e101', name: 'Copying', codeType: 'expense' });

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requested: 1, adopted: 1, skipped: 0 });
    expect(await expenseCategoryRows(firm.id)).toEqual([
      expect.objectContaining({
        code: 'E101',
        name: 'Copying',
        utbms_code_id: code.id,
        // An adopted category must never arrive as the firm's default: the
        // default is what an expense with no category picked falls back to, and
        // an import would silently reassign every such expense.
        is_default: false,
      }),
    ]);
    expect(await expenseCategoryRows(otherFirm.id)).toEqual([]);
  });

  it('adopts nothing when the code is a task code', async () => {
    const code = await seedUtbmsCode({ code: 'L100', codeType: 'task' });

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.body).toMatchObject({ requested: 1, adopted: 0 });
    expect(await expenseCategoryRows(firm.id)).toEqual([]);
  });

  it('skips a category the firm already adopted', async () => {
    const code = await seedUtbmsCode({ code: 'E101', codeType: 'expense' });
    await adopt(owner, firm.id, [code.id]);

    const res = await adopt(owner, firm.id, [code.id]);

    expect(res.body).toMatchObject({ adopted: 0, skipped: 1 });
    expect(await expenseCategoryRows(firm.id)).toHaveLength(1);
  });

  it('adopts nothing for an id that is not in the catalog', async () => {
    const res = await adopt(owner, firm.id, [randomUUID()]);

    expect(res.body).toMatchObject({ requested: 1, adopted: 0 });
    expect(await expenseCategoryRows(firm.id)).toEqual([]);
  });

  it('refuses a member of another firm adopting under this firm', async () => {
    const code = await seedUtbmsCode({ code: 'E101', codeType: 'expense' });

    const res = await adopt(otherOwner, firm.id, [code.id]);

    expect(res.status).toBe(403);
    expect(await expenseCategoryRows(firm.id)).toEqual([]);
  });
});
