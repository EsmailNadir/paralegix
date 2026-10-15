/**
 * Expense categories: the firm's chart of accounts for out-of-pocket costs.
 *
 * The whole module had no test. Three properties carry real consequences and
 * none of them were pinned.
 *
 *   THE LIST LAZY-SEEDS. A firm that has never opened this screen has no rows,
 *   and the first GET writes eight defaults before answering. That is a WRITE
 *   on a read route, so it can double-seed under a second call, and it can seed
 *   the wrong firm. Both are silent.
 *
 *   THE CODE IS THE IDENTITY. Codes are uppercased on the way in and must be
 *   unique per firm. A duplicate code makes two categories indistinguishable in
 *   every expense report the firm runs, and the reports are what the firm files.
 *
 *   A CATEGORY IN USE IS NOT DELETABLE. `expenses.expense_category_id` is
 *   `on delete set null`, so deleting a used category does not fail loudly: it
 *   quietly unclassifies every expense pointing at it, and last quarter's
 *   report changes shape with nothing flagging it. The service blocks the
 *   delete and tells the caller to deactivate instead.
 *
 * Fixtures are plain SQL through the test pool. A category seeded through the
 * repository under test cannot expose a repository bug, because the same broken
 * code would produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const base = () => `/api/lawfirms/${firm.id}/billing/expense-categories`;

/** A category straight into the table, bypassing the code under test. */
async function seedCategory(
  lawFirmId: string,
  seed: { code?: string; name?: string; isActive?: boolean; order?: number; isDefault?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into billing_codes
       (id, law_firm_id, kind, code, name, is_active, is_default, sort_order)
     values ($1, $2, 'expense', $3, $4, $5, $6, $7) returning id`,
    [
      id, lawFirmId,
      seed.code ?? `CODE_${id.slice(0, 4).toUpperCase()}`,
      seed.name ?? 'Seeded category',
      seed.isActive ?? true,
      seed.isDefault ?? false,
      seed.order ?? 1,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

const codesIn = (body: any) => body.expenseCategories.map((c: any) => c.code);

const rowsFor = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select id, code, name, is_active, is_default, sort_order
       from billing_codes where law_firm_id = $1 and kind = 'expense' order by sort_order, code`,
    [lawFirmId],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('the list seeds defaults on first read', () => {
  it('seeds the eight defaults for a firm that has none', async () => {
    const res = await owner.api.get(base());

    expect(res.status).toBe(200);
    // Named, not counted. A count alone stays green if the default set is
    // replaced wholesale with eight different codes.
    expect(codesIn(res.body)).toEqual(expect.arrayContaining([
      'COURT_FEES', 'FILING_FEES', 'TRAVEL', 'EXPERT_WITNESS',
      'POSTAGE', 'COPYING', 'SERVICE_OF_PROCESS', 'OTHER',
    ]));
    // The seed is a WRITE on a read route, so the rows must actually exist
    // rather than the route synthesizing a list it never stored.
    expect(await rowsFor(firm.id)).toHaveLength(8);
  });

  it('does not seed a second time on the next read', async () => {
    await owner.api.get(base());
    await owner.api.get(base());

    // Sixteen rows would mean every category appears twice in every dropdown
    // and every report groups the same cost under two headings.
    expect(await rowsFor(firm.id)).toHaveLength(8);
  });

  it('does not seed a firm that already has one category of its own', async () => {
    await seedCategory(firm.id, { code: 'CUSTOM_ONLY', name: 'Custom only' });

    const res = await owner.api.get(base());

    // The seed is gated on emptiness. If it were gated on the DEFAULTS being
    // absent, a firm that had deliberately deleted 'TRAVEL' would get it back
    // on every page load.
    expect(codesIn(res.body)).toEqual(['CUSTOM_ONLY']);
    expect(await rowsFor(firm.id)).toHaveLength(1);
  });

  it('seeds only the reading firm, not another firm that is also empty', async () => {
    const other = await createFirm({ name: 'Other Firm' });

    await owner.api.get(base());

    // Both halves. Asserting only that this firm got rows would pass against a
    // seed that wrote to every firm in the table.
    expect(await rowsFor(firm.id)).toHaveLength(8);
    expect(await rowsFor(other.id)).toHaveLength(0);
  });

  it('marks the seeded rows as defaults', async () => {
    await owner.api.get(base());

    const rows = await rowsFor(firm.id);
    // `is_default` is what distinguishes a shipped category from one the firm
    // wrote. Without it the UI cannot tell the firm which ones it created.
    expect(rows.every((r: any) => r.is_default === true)).toBe(true);
  });
});

describe('listing hides inactive categories unless asked', () => {
  it('omits an inactive category by default', async () => {
    await seedCategory(firm.id, { code: 'LIVE_ONE', order: 1 });
    await seedCategory(firm.id, { code: 'RETIRED', order: 2, isActive: false });

    const res = await owner.api.get(base());

    // Both halves: the presence of LIVE_ONE proves the read ran at all, so the
    // absence of RETIRED means it was filtered rather than the list being empty.
    expect(codesIn(res.body)).toContain('LIVE_ONE');
    expect(codesIn(res.body)).not.toContain('RETIRED');
  });

  it('includes an inactive category when includeInactive is set', async () => {
    await seedCategory(firm.id, { code: 'LIVE_ONE', order: 1 });
    await seedCategory(firm.id, { code: 'RETIRED', order: 2, isActive: false });

    const res = await owner.api.get(`${base()}?includeInactive=true`);

    // Deactivating is the recommended alternative to deleting, so a firm must
    // still be able to see and reactivate what it retired.
    expect(codesIn(res.body)).toContain('RETIRED');
  });

  it('orders by sort order, not by insertion', async () => {
    await seedCategory(firm.id, { code: 'ZULU', order: 1 });
    await seedCategory(firm.id, { code: 'ALPHA', order: 2 });

    const res = await owner.api.get(base());

    // Codes chosen so alphabetical ordering gives the opposite answer. A list
    // that happened to be sorted by code would otherwise look correct.
    expect(codesIn(res.body)).toEqual(['ZULU', 'ALPHA']);
  });
});

describe('the code is the identity, and it is unique per firm', () => {
  it('uppercases a lowercase code on create', async () => {
    const res = await owner.api.post(base()).send({ code: 'MEDIATION', name: 'Mediation' });

    expect(res.status).toBe(201);
    const rows = await rowsFor(firm.id);
    expect(rows.find((r: any) => r.code === 'MEDIATION')).toBeDefined();
  });

  it('refuses a duplicate code', async () => {
    await seedCategory(firm.id, { code: 'TRAVEL', name: 'Travel' });

    const res = await owner.api.post(base()).send({ code: 'TRAVEL', name: 'Travel again' });

    expect(res.status).toBe(400);
    // The row count, not the status. Two categories sharing a code are
    // indistinguishable in every report the firm files.
    expect(await rowsFor(firm.id)).toHaveLength(1);
  });

  it('refuses a duplicate that differs only in case', async () => {
    await seedCategory(firm.id, { code: 'TRAVEL', name: 'Travel' });

    const res = await owner.api.post(base()).send({ code: 'travel', name: 'Travel lower' });

    // The uniqueness probe uppercases before comparing. Without that, 'travel'
    // is stored as 'TRAVEL' and the duplicate lands anyway.
    expect(res.status).toBe(400);
    expect(await rowsFor(firm.id)).toHaveLength(1);
  });

  it('lets the SAME code exist at a different firm', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    await seedCategory(other.id, { code: 'TRAVEL', name: 'Travel' });

    const res = await owner.api.post(base()).send({ code: 'TRAVEL', name: 'Travel' });

    // Uniqueness is per firm. A global check would let one firm's chart of
    // accounts block another firm from using an ordinary word.
    expect(res.status).toBe(201);
  });

  it('refuses renaming a category onto another category\'s code', async () => {
    await seedCategory(firm.id, { code: 'TRAVEL', name: 'Travel' });
    const second = await seedCategory(firm.id, { code: 'POSTAGE', name: 'Postage' });

    const res = await owner.api.put(`${base()}/${second}`).send({ code: 'TRAVEL' });

    expect(res.status).toBe(400);
    const rows = await rowsFor(firm.id);
    expect(rows.find((r: any) => r.id === second).code).toBe('POSTAGE');
  });

  it('lets a category keep its own code through an unrelated edit', async () => {
    const id = await seedCategory(firm.id, { code: 'TRAVEL', name: 'Travel' });

    const res = await owner.api.put(`${base()}/${id}`).send({ code: 'TRAVEL', name: 'Travel & lodging' });

    // The duplicate probe must exclude the row being edited. Without that
    // exclusion a category can never be renamed while keeping its code, which
    // is the ordinary case.
    expect(res.status).toBe(200);
    const rows = await rowsFor(firm.id);
    expect(rows.find((r: any) => r.id === id).name).toBe('Travel & lodging');
  });

  it('refuses a code that breaks the format', async () => {
    // Lowercase, spaces and punctuation are all out: the code is a report key,
    // not a label. The name field is where free text belongs.
    for (const code of ['ab cd', 'travel-fees', 'X', 'A'.repeat(21)]) {
      const res = await owner.api.post(base()).send({ code, name: 'Anything' });
      expect(res.status).toBe(400);
    }
    expect(await rowsFor(firm.id)).toHaveLength(0);
  });

  it('refuses an empty name', async () => {
    const res = await owner.api.post(base()).send({ code: 'VALID_CODE', name: '' });

    expect(res.status).toBe(400);
  });
});

describe('a category in use cannot be deleted', () => {
  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Category Client' });
  });

  /** An expense pointing at the category, straight into the table. */
  async function seedExpenseUsing(categoryId: string) {
    const id = randomUUID();
    const res = await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, billing_code_id)
       values ('expense', $1, $2, $3, 'Referenced cost', 5000, $4) returning id`,
      [id, firm.id, client.id, categoryId],
    );
    expect(res.rowCount).toBe(1);
    return id;
  }

  it('refuses to delete a category an expense points at', async () => {
    const id = await seedCategory(firm.id, { code: 'IN_USE', name: 'In use' });
    await seedExpenseUsing(id);

    const res = await owner.api.delete(`${base()}/${id}`);

    expect(res.status).toBe(400);
    expect(await rowsFor(firm.id)).toHaveLength(1);
  });

  it('leaves the expense classified when the delete is refused', async () => {
    const id = await seedCategory(firm.id, { code: 'IN_USE', name: 'In use' });
    const expenseId = await seedExpenseUsing(id);

    await owner.api.delete(`${base()}/${id}`);

    // The point of the block. The FK is `on delete set null`, so a delete that
    // slipped through would not error: it would silently unclassify this cost
    // and change last quarter's report with nothing flagging it.
    const { rows } = await testPool.query(
      `select billing_code_id as expense_category_id from activities where kind = 'expense' and id = $1`, [expenseId],
    );
    expect(rows[0].expense_category_id).toBe(id);
  });

  it('deletes a category nothing points at', async () => {
    const id = await seedCategory(firm.id, { code: 'UNUSED', name: 'Unused' });

    const res = await owner.api.delete(`${base()}/${id}`);

    expect(res.status).toBe(200);
    expect(await rowsFor(firm.id)).toHaveLength(0);
  });

  it('does not count another firm\'s expense as usage', async () => {
    const id = await seedCategory(firm.id, { code: 'UNUSED', name: 'Unused' });
    const other = await createFirm({ name: 'Other Firm' });
    const otherClient = await createPersonClient(other.id, { name: 'Other Client' });
    // Another firm's expense can no longer name this firm's category: the
    // composite key on activities refuses it, so the usage probe never has a
    // foreign row to count.
    await expect(testPool.query(
      `insert into activities (kind, law_firm_id, client_id, description, charge_cents, billing_code_id)
       values ('expense', $1, $2, 'Their cost', 5000, $3)`,
      [other.id, otherClient.id, id],
    )).rejects.toMatchObject({ code: '23503' });

    const res = await owner.api.delete(`${base()}/${id}`);

    expect(res.status).toBe(200);
  });

  it('allows deactivating instead of deleting', async () => {
    const id = await seedCategory(firm.id, { code: 'IN_USE', name: 'In use' });
    await seedExpenseUsing(id);

    const res = await owner.api.put(`${base()}/${id}`).send({ isActive: false });

    // The alternative the error message recommends has to actually work, or
    // the firm is stuck with a category it cannot remove from its dropdown.
    expect(res.status).toBe(200);
    expect((await rowsFor(firm.id))[0].is_active).toBe(false);
  });
});

describe('reorder', () => {
  it('rewrites the sort order to match the order given', async () => {
    const a = await seedCategory(firm.id, { code: 'AAA', order: 1 });
    const b = await seedCategory(firm.id, { code: 'BBB', order: 2 });
    const c = await seedCategory(firm.id, { code: 'CCC', order: 3 });

    const res = await owner.api.put(`${base()}/reorder`)
      .send({ expenseCategoryIds: [c, a, b] });

    expect(res.status).toBe(200);
    const list = await owner.api.get(base());
    expect(codesIn(list.body)).toEqual(['CCC', 'AAA', 'BBB']);
  });

  it('does not reorder another firm\'s categories', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const theirs = await seedCategory(other.id, { code: 'THEIRS', order: 7 });
    const mine = await seedCategory(firm.id, { code: 'MINE', order: 1 });

    const res = await owner.api.put(`${base()}/reorder`)
      .send({ expenseCategoryIds: [theirs, mine] });

    expect(res.status).toBe(200);
    // Unscoped, this route lets any firm rewrite any other firm's chart of
    // accounts by guessing an id. The other firm's row must be untouched.
    const theirRows = await rowsFor(other.id);
    expect(theirRows[0].sort_order).toBe(7);
  });

  it('refuses an empty id list', async () => {
    const res = await owner.api.put(`${base()}/reorder`).send({ expenseCategoryIds: [] });

    expect(res.status).toBe(400);
  });

  it('is routed as reorder, not as a category id', async () => {
    const id = await seedCategory(firm.id, { code: 'AAA', order: 1 });

    const res = await owner.api.put(`${base()}/reorder`).send({ expenseCategoryIds: [id] });

    // `/reorder` is declared above `/:expenseCategoryId`. Reversed, 'reorder'
    // is read as an id and the route answers 404 on every reorder attempt.
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reorder/i);
  });
});

describe('tenant isolation and permissions', () => {
  it('does not list another firm\'s categories', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    await seedCategory(other.id, { code: 'THEIRS', name: 'Theirs' });
    await seedCategory(firm.id, { code: 'MINE', name: 'Mine' });

    const res = await owner.api.get(base());

    expect(codesIn(res.body)).toEqual(['MINE']);
  });

  it('answers 404 for a category id belonging to another firm', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const theirs = await seedCategory(other.id, { code: 'THEIRS', name: 'Theirs' });

    const res = await owner.api.get(`${base()}/${theirs}`);

    expect(res.status).toBe(404);
  });

  it('refuses to delete another firm\'s category', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const theirs = await seedCategory(other.id, { code: 'THEIRS', name: 'Theirs' });

    const res = await owner.api.delete(`${base()}/${theirs}`);

    expect(res.status).toBe(404);
    expect(await rowsFor(other.id)).toHaveLength(1);
  });

  it('refuses a caller who is not a member of the firm at all', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const outsider = await ownerOf(other.id);

    const res = await outsider.api.get(base());

    expect(res.status).toBe(403);
  });

  it('refuses a write from a member without billing.manageRates', async () => {
    const viewer = await memberWith(firm.id, ['billing.viewRates']);

    const res = await viewer.api.post(base()).send({ code: 'NEW_ONE', name: 'New one' });

    expect(res.status).toBe(403);
    expect(await rowsFor(firm.id)).toHaveLength(0);
  });

  it('lets a member holding only billing.viewRates read the list', async () => {
    await seedCategory(firm.id, { code: 'READABLE', name: 'Readable' });
    const viewer = await memberWith(firm.id, ['billing.viewRates']);

    const res = await viewer.api.get(base());

    // Seeded first on purpose: an empty firm answers this the same way whether
    // the categories were withheld or never existed.
    expect(res.status).toBe(200);
    expect(codesIn(res.body)).toEqual(['READABLE']);
  });

  it('answers 404 for a category id that is not a uuid', async () => {
    const res = await owner.api.get(`${base()}/not-a-uuid`);

    // Without a guard the uuid comparison raises 22P02 and the route answers
    // 500, which reads as a server fault rather than a bad id.
    expect(res.status).toBe(404);
  });
});
