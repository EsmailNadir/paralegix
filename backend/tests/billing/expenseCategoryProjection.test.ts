import { randomUUID } from 'crypto';
import { createFirm, createPersonClient, ownerOf, stranger, testPool } from '../support/setupInProcess';

it('refuses another firm before reading expense category projections', async () => {
  const firm = await createFirm();
  const client = await createPersonClient(firm.id);
  const outsider = await stranger();
  const response = await outsider.api.get(`/api/lawfirms/${firm.id}/billing/expenses/client/${client.id}`);
  expect(response.status).toBe(403);
});

it('reads the current category from its catalog reference after a rename', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const categoryId = randomUUID();
  await testPool.query(`insert into billing_codes (id, law_firm_id, kind, code, name)
    values ($1, $2, 'expense', 'ORIGINAL', 'Original category')`, [categoryId, firm.id]);
  const listUrl = `/api/lawfirms/${firm.id}/billing/expenses/client/${client.id}`;
  const created = await owner.api.post(`/api/lawfirms/${firm.id}/billing/expenses`).send({
    clientId: client.id, description: 'Court fee', amount: 12.34, expenseCategoryId: categoryId,
  });
  expect(created.status).toBe(201);
  expect(created.body.expense.expenseCategoryId).toBe(categoryId);
  expect(created.body.expense.category).toBe('ORIGINAL');
  await testPool.query(`update billing_codes set code = 'RENAMED', name = 'Renamed category' where id = $1`, [categoryId]);
  const listed = await owner.api.get(listUrl);
  expect(listed.status).toBe(200);
  expect(listed.body.expenses).toHaveLength(1);
  expect(listed.body.expenses[0]).toMatchObject({ id: created.body.expenseId, expenseCategoryId: categoryId, category: 'RENAMED' });
  const stored = await testPool.query('select billing_code_id, category from activities where id = $1', [created.body.expenseId]);
  expect(stored.rows[0]).toEqual({ billing_code_id: categoryId, category: null });
});

it('refuses an expense referencing an expense category belonging to another firm', async () => {
  const firmA = await createFirm();
  const firmB = await createFirm();
  const ownerA = await ownerOf(firmA.id);
  const clientA = await createPersonClient(firmA.id);
  const categoryBId = randomUUID();
  await testPool.query(`insert into billing_codes (id, law_firm_id, kind, code, name)
    values ($1, $2, 'expense', 'OTHERFIRM', 'Other firm cat')`, [categoryBId, firmB.id]);

  const res = await ownerA.api.post(`/api/lawfirms/${firmA.id}/billing/expenses`).send({
    clientId: clientA.id, description: 'Travel', amount: 50, expenseCategoryId: categoryBId,
  });
  expect(res.status).toBe(400);
});
