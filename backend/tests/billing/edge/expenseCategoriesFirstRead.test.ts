/**
 * The first read of a firm's expense categories seeds the defaults. Several first
 * reads at once (a page and the composer opening together) must all succeed and
 * leave exactly one set of defaults.
 *
 * RED IF: any concurrent first read fails, or the defaults are stored twice.
 */
import { testPool, createFirm, ownerOf, drainEvents, type Actor, type Firm } from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

it('serves four simultaneous first reads and seeds the defaults once', async () => {
  const before = await testPool.query(
    `select count(*)::int as n from billing_codes where law_firm_id = $1 and kind = 'expense'`, [firm.id]);
  expect(before.rows[0].n).toBe(0);

  const results = await Promise.all([1, 2, 3, 4].map(() =>
    owner.api.get(`/api/lawfirms/${firm.id}/billing/expense-categories`)));

  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  const lengths = new Set(results.map((r) => r.body.expenseCategories.length));
  expect(lengths.size).toBe(1);
  expect([...lengths][0]).toBeGreaterThan(0);
  const after = await testPool.query(
    `select code, count(*)::int as n from billing_codes where law_firm_id = $1 and kind = 'expense' group by code`, [firm.id]);
  expect(after.rows.every((r: any) => r.n === 1)).toBe(true);
});
