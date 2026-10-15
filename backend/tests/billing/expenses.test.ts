/**
 * Expenses: the firm's out-of-pocket costs, rebilled to the client.
 *
 * The whole module had no test. An expense is a court fee, an expert's bill, a
 * filing charge. It becomes an invoice line item exactly the way a time entry
 * does, so every rule that protects a time entry has to protect an expense too,
 * and none of them were pinned.
 *
 * Three properties are worth a suite of their own.
 *
 *   FROZEN ONCE BILLED. An invoice that has issued is a document the client
 *   already holds. Editing the amount behind it changes what the firm's records
 *   say it charged without changing the invoice, and the two disagree from then
 *   on with nothing flagging it. `updateExpense` freezes amount/date/billable
 *   and `deleteExpense` refuses outright. Neither had a test.
 *
 *   MONEY IS INTEGER CENTS. The route speaks dollars and the column is
 *   `amount_cents bigint`. The conversion happens in the repository, and a
 *   float that survives to the column is a wrong bill. The cases below read the
 *   COLUMN, not the response, because a response echoing back what was sent
 *   passes whether the conversion happened or not.
 *
 *   ONE CONTEXT, NOT TWO. An expense belongs to a matter or a client, never
 *   both. Two contexts means two possible payers, and a schema CHECK constraint
 *   is the last line rather than the first.
 *
 * The freeze is driven by an invoice LINE ITEM. `expenses.is_billed` used to
 * look like the flag for this and was not: nothing ever set it, and the service
 * asks `isSourceBilled`, which joins `invoice_line_items` to `invoices`.
 * Migration 0228 dropped the column. A fixture that only set `is_billed = true`
 * produced an expense the service considered unbilled, so every freeze
 * assertion passed against an expense that was never frozen. See
 * `billOntoInvoice`.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/expenses`;
const clientPath = () => `${base()}/client/${client.id}`;

/** Create a client-context expense. Returns the raw response. */
async function createExpense(body: Record<string, unknown> = {}) {
  return owner.api.post(base()).send({
    clientId: client.id,
    description: 'Filing fee, superior court',
    amount: 425.5,
    date: '2026-04-14',
    category: 'FILING_FEES',
    vendor: 'County Clerk',
    ...body,
  });
}

const expenseId = (res: any) => res.body?.expenseId;

/**
 * A matter with `uid` on it. Every matter-context write goes through
 * `assertMatterMembership`, which refuses a firm owner who is not on the matter.
 */
async function seedMatter(uid: string): Promise<string> {
  const id = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Expense Matter', $3, 'active') returning id`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  const member = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firm.id, id, uid],
  );
  expect(member.rowCount).toBe(1);
  return id;
}

/**
 * Put the expense onto an invoice as a LINE ITEM, which is what actually
 * freezes it. See the file header for why setting `is_billed` would not.
 */
async function billOntoInvoice(id: string, amountCents = 42_550) {
  const invoice = await createInvoice(firm.id, client.id, { totalCents: amountCents });
  const res = await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'expense', $3, 1, $4, $4)`,
    [invoice.id, firm.id, id, amountCents],
  );
  expect(res.rowCount).toBe(1);
  return invoice;
}

/** The stored row, which is the only place the cents conversion is observable. */
const rowFor = async (id: string) => {
  const { rows } = await testPool.query(
    `select amount_cents, activity_date as expense_date, billable, description, category, vendor,
            client_id, matter_id, user_id, created_by, billing_code_id as expense_category_id
       from activities where kind = 'expense' and id = $1`,
    [id],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Expense Client' });
  await drainEvents();
});

describe('an expense belongs to exactly one billing context', () => {
  it('accepts an expense against a client', async () => {
    const res = await createExpense();

    expect(res.status).toBe(201);
    expect(await rowFor(expenseId(res))).toMatchObject({
      client_id: client.id,
      matter_id: null,
    });
  });

  it('accepts an expense against a matter', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await createExpense({ clientId: undefined, matterId });

    expect(res.status).toBe(201);
    expect(await rowFor(expenseId(res))).toMatchObject({
      matter_id: matterId,
      client_id: null,
    });
  });

  it('refuses an expense against BOTH a matter and a client', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await createExpense({ matterId });

    // Two contexts means two possible payers. The expense would land on
    // whichever invoice was built first, and the other party would never be
    // billed for the cost the firm actually paid out.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from activities where kind = 'expense' and law_firm_id = $1`,
      [firm.id],
    );
    // Asserting the 400 alone would pass against a route that returned 400 and
    // wrote the row anyway.
    expect(rows[0].n).toBe(0);
  });

  it('refuses an expense against NEITHER', async () => {
    const res = await createExpense({ clientId: undefined });

    expect(res.status).toBe(400);
  });
});

describe('money is stored as integer cents', () => {
  it('converts a dollar amount to cents in the column', async () => {
    const res = await createExpense({ amount: 425.5 });

    expect(res.status).toBe(201);
    // The COLUMN, not the response. A response that echoes the request passes
    // whether the conversion happened or not.
    expect((await rowFor(expenseId(res))).amount_cents).toBe('42550');
  });

  it('refuses a sub-cent amount rather than rounding it', async () => {
    // The caller's 12.345 is not a whole number of cents, so it is refused
    // instead of being silently stored as an amount nobody entered.
    const res = await createExpense({ amount: 12.345 });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select count(*)::int n from activities where kind = 'expense' and law_firm_id = $1`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a zero amount', async () => {
    const res = await createExpense({ amount: 0 });

    // An expense of nothing is a data-entry slip, and it reaches the client's
    // invoice as a line worth nothing.
    expect(res.status).toBe(400);
  });

  it('refuses a negative amount', async () => {
    const res = await createExpense({ amount: -50 });

    // A negative expense is a credit by another name, and it would reduce the
    // invoice total without any of the checks a credit goes through.
    expect(res.status).toBe(400);
  });

  it('refuses an amount sent as a string', async () => {
    const res = await createExpense({ amount: '425.50' });

    // `parseFloat` in the service would accept this. The schema is what stops
    // it, and a widened schema must turn this case red.
    expect(res.status).toBe(400);
  });

  it('accepts an amount right at the documented maximum', async () => {
    const res = await createExpense({ amount: 1_000_000_000 });

    expect(res.status).toBe(201);
    expect((await rowFor(expenseId(res))).amount_cents).toBe('100000000000');
  });

  it('rejects an amount one dollar past the documented maximum', async () => {
    const res = await createExpense({ amount: 1_000_000_001 });

    // Rejecting max+1 on this field also rejects anything larger, such as 1e17,
    // whose cents overflow a bigint and used to answer 500 from the insert.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from activities where kind = 'expense' and law_firm_id = $1`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects the same huge finite value on UPDATE, not just create', async () => {
    const id = expenseId(await createExpense({ amount: 425.5 }));

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 1e17 });

    expect(res.status).toBe(400);
    // Unchanged from the control amount, not corrupted and not silently accepted.
    expect((await rowFor(id)).amount_cents).toBe('42550');
  });
});

describe('the expense date is the day the cost was incurred', () => {
  it('stores the day it was given, not the day before', async () => {
    const res = await createExpense({ date: '2026-04-14' });

    // `new Date('2026-04-14')` is UTC midnight, which is 13 April everywhere
    // west of UTC. The service anchors day-only strings at noon for exactly
    // this reason, and a regression moves every expense back one day.
    expect((await rowFor(expenseId(res))).expense_date).toBe('2026-04-14');
  });

  it('accepts an expense with no date', async () => {
    const res = await createExpense({ date: null });

    expect(res.status).toBe(201);
    expect((await rowFor(expenseId(res))).expense_date).toBeNull();
  });
});

describe('an expense is frozen once it is billed', () => {
  it('refuses to change the amount of a billed expense', async () => {
    const created = await createExpense();
    const id = expenseId(created);
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 999 });

    expect(res.status).toBe(403);
    // The row, not the status. A route that returned 403 after writing would
    // have already diverged the firm's records from the client's invoice.
    expect((await rowFor(id)).amount_cents).toBe('42550');
  });

  it('refuses to change the date of a billed expense', async () => {
    const created = await createExpense();
    const id = expenseId(created);
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ date: '2026-01-01' });

    expect(res.status).toBe(403);
    expect((await rowFor(id)).expense_date).toBe('2026-04-14');
  });

  it('refuses to flip the billable flag of a billed expense', async () => {
    const created = await createExpense();
    const id = expenseId(created);
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ billable: false });

    expect(res.status).toBe(403);
    expect((await rowFor(id)).billable).toBe(true);
  });

  it('still allows the description of a billed expense to be corrected', async () => {
    const created = await createExpense();
    const id = expenseId(created);
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`)
      .send({ description: 'Filing fee, superior court (corrected)' });

    // Descriptive fields do not change what was charged, so freezing them would
    // block a legitimate correction for no gain. This case is the reason the
    // freeze names three fields rather than refusing every edit.
    expect(res.status).toBe(200);
    expect((await rowFor(id)).description).toBe('Filing fee, superior court (corrected)');
  });

  it('refuses to delete a billed expense', async () => {
    const created = await createExpense();
    const id = expenseId(created);
    await billOntoInvoice(id);

    const res = await owner.api.delete(`${clientPath()}/${id}`);

    expect(res.status).toBe(403);
    expect(await rowFor(id)).toBeDefined();
  });

  it('lets an UNBILLED expense be edited and deleted', async () => {
    const created = await createExpense();
    const id = expenseId(created);

    const edit = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 500 });
    expect(edit.status).toBe(200);
    expect((await rowFor(id)).amount_cents).toBe('50000');

    const removed = await owner.api.delete(`${clientPath()}/${id}`);
    expect(removed.status).toBe(200);
    expect(await rowFor(id)).toBeUndefined();
  });

});

describe('listing reports what is on an invoice', () => {
  it('marks a billed expense as billed and an unbilled one as not', async () => {
    const billed = expenseId(await createExpense({ description: 'Billed cost' }));
    const open = expenseId(await createExpense({ description: 'Open cost' }));
    await billOntoInvoice(billed);

    const res = await owner.api.get(`${base()}/client/${client.id}`);

    expect(res.status).toBe(200);
    const byId = new Map(res.body.expenses.map((e: any) => [e.id, e.isBilled]));
    // Both halves. Asserting only that the billed one is flagged would pass
    // against a list that flagged everything.
    expect(byId.get(billed)).toBe(true);
    expect(byId.get(open)).toBe(false);
  });

  it('returns dollars, not cents, to the caller', async () => {
    const id = expenseId(await createExpense({ amount: 425.5 }));

    const res = await owner.api.get(`${base()}/client/${client.id}`);

    // The column is cents and the API is dollars. A missed conversion here
    // shows the client a bill 100x too large.
    expect(res.body.expenses.find((e: any) => e.id === id).amount).toBe(425.5);
  });
});

describe('tenant and context isolation', () => {
  it('does not list another firm\'s expenses', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    const otherClient = await createPersonClient(other.id, { name: 'Other Client' });
    await otherOwner.api.post(`/api/lawfirms/${other.id}/billing/expenses`)
      .send({ clientId: otherClient.id, description: 'Their cost', amount: 100 });
    await createExpense({ description: 'Our cost' });

    const res = await owner.api.get(`${base()}/client/${client.id}`);

    // Both halves: the presence proves the read ran at all.
    const descriptions = res.body.expenses.map((e: any) => e.description);
    expect(descriptions).toContain('Our cost');
    expect(descriptions).not.toContain('Their cost');
  });

  it('refuses an expense naming a client of another firm', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const foreign = await createPersonClient(other.id, { name: 'Foreign Client' });

    const res = await createExpense({ clientId: foreign.id });

    // Written through, the row carries this firm's law_firm_id and the other
    // firm's client_id, so no list endpoint in either firm ever shows it. The
    // cost is unbillable and invisible, and deleting that client cascades it
    // away entirely.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from activities where kind = 'expense' and client_id = $1`,
      [foreign.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses to edit an expense through the wrong context', async () => {
    const id = expenseId(await createExpense());
    const otherClient = await createPersonClient(firm.id, { name: 'Second Client' });

    const res = await owner.api.put(`${base()}/client/${otherClient.id}/${id}`)
      .send({ amount: 999 });

    // The lookup is scoped by context, so addressing the expense through a
    // client that does not own it must not find it. Without that scope one
    // client's costs could be edited from another client's billing page.
    expect(res.status).toBe(404);
    expect((await rowFor(id)).amount_cents).toBe('42550');
  });

  it('refuses a matter-context write from a non-member of the matter', async () => {
    const outsider = await memberWith(firm.id, [
      'billing.manageExpenses', 'billing.viewExpenses',
    ]);
    const matterId = await seedMatter(owner.uid);

    const res = await outsider.api.post(base())
      .send({ matterId, description: 'Cost', amount: 100 });

    // The firm permission is not enough on a matter context: matter membership
    // is a second, narrower gate, and it is what keeps a member off matters
    // they were never staffed on.
    expect(res.status).toBe(403);
  });
});

describe('permissions', () => {
  it('refuses a member whose role grants nothing the expense list', async () => {
    await createExpense({ description: 'Baseline visible cost' });
    const plain = await memberWith(firm.id, ['matters.view']);

    const res = await plain.api.get(`${base()}/client/${client.id}`);

    // `billing.viewExpenses` is not in DEFAULT_PERMISSIONS, so a role that never
    // names it cannot read the list.
    //
    // Seeded first on purpose: a firm with no expenses answers an empty list
    // whether the costs were withheld or never existed, so the body is checked.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Baseline visible cost');
  });

  it('does NOT give that baseline member the right to write', async () => {
    const plain = await memberWith(firm.id, ['matters.view']);

    const res = await plain.api.post(base())
      .send({ clientId: client.id, description: 'Cost', amount: 100 });

    // `billing.manageExpenses` is not in the baseline, and this is the pair
    // that makes the read case above safe: read-only degradation, not an open
    // door.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select count(*)::int as n from activities where kind = 'expense' and law_firm_id = $1`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('input bounds', () => {
  it('refuses an empty description', async () => {
    const res = await createExpense({ description: '' });

    expect(res.status).toBe(400);
  });

  it('refuses a description past the 1000 character bound', async () => {
    const res = await createExpense({ description: 'x'.repeat(1001) });

    expect(res.status).toBe(400);
  });

  it('refuses a receipt url that is not a url', async () => {
    const res = await createExpense({ receiptUrl: 'not a url' });

    expect(res.status).toBe(400);
  });

  it('answers 404 for an expense id that is not a uuid', async () => {
    const res = await owner.api.put(`${clientPath()}/not-a-uuid`).send({ amount: 5 });

    // The repository refuses a non-uuid before it reaches Postgres. Without
    // that guard the query raises 22P02 and the route answers 500, which reads
    // as a server fault rather than a bad id.
    expect(res.status).toBe(404);
  });

  it('answers 404 for an expense that does not exist', async () => {
    const res = await owner.api.delete(`${clientPath()}/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});
