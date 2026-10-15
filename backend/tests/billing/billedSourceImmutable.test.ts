/**
 * The database refuses to change or delete a time entry, flat fee or expense
 * that is on an invoice (migration 0229), independently of the services.
 *
 * The three services already refuse these edits with a sentence
 * (`FROZEN_ONCE_BILLED` in each). What they cannot do is stop a repository
 * call, a script or a future route that never asks. This spec goes straight to
 * SQL for exactly that reason: it is the path the services do not see.
 *
 * RED IF: the trigger is dropped or loosened (the update succeeds), it freezes a
 * field the services leave editable (the description update fails), or it
 * fires on an unbilled row.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, createFirmMember, createPersonClient, createInvoice } from '../support/setupInProcess';

let firmId: string;
let clientId: string;
let userId: string;

async function placeOnInvoice(kind: 'time_entry' | 'flat_fee' | 'expense', sourceId: string) {
  const invoice = await createInvoice(firmId, clientId, { totalCents: 1000 });
  await testPool.query(
    `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, $3, $4, 1, 1000, 1000)`,
    [invoice.id, firmId, kind, sourceId],
  );
  return invoice.id;
}

async function seedTimeEntry() {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, rate_cents, description)
     values ('time', $1, $2, $3, $4, '2026-03-01', 1.5, 25000, 'Drafting')`,
    [id, firmId, clientId, userId],
  );
  return id;
}

async function seedFlatFee() {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date)
     values ('flat_fee', $1, $2, $3, 'Filing', 50000, '2026-03-01')`,
    [id, firmId, clientId],
  );
  return id;
}

async function seedExpense() {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date, billable)
     values ('expense', $1, $2, $3, 'Courier', 4200, '2026-03-01', true)`,
    [id, firmId, clientId],
  );
  return id;
}

const FROZEN = /on an invoice/;

beforeEach(async () => {
  firmId = (await createFirm()).id;
  userId = (await createFirmMember(firmId)).uid;
  clientId = (await createPersonClient(firmId, { name: 'Billed Client' })).id;
});

describe('time entries', () => {
  it('lets an unbilled entry change and be deleted', async () => {
    const id = await seedTimeEntry();
    await testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id]);
    await testPool.query(`delete from activities where kind = 'time' and id = $1`, [id]);
    const { rows } = await testPool.query(`select 1 from activities where kind = 'time' and id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('freezes the figures the invoice was built from once a line item names it', async () => {
    const id = await seedTimeEntry();
    await placeOnInvoice('time_entry', id);

    await expect(testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`update activities set rate_cents = 1 where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query("update activities set activity_date = '2026-01-01' where kind = 'time' and id = $1", [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`update activities set billable = false where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`delete from activities where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);

    const { rows } = await testPool.query(`select hours, rate_cents from activities where kind = 'time' and id = $1`, [id]);
    expect(rows[0]).toEqual({ hours: '1.50', rate_cents: '25000' });
  });

  it('still lets the description of a billed entry be corrected', async () => {
    const id = await seedTimeEntry();
    await placeOnInvoice('time_entry', id);

    await testPool.query("update activities set description = 'Drafting the motion' where kind = 'time' and id = $1", [id]);
    const { rows } = await testPool.query(`select description from activities where kind = 'time' and id = $1`, [id]);
    expect(rows[0].description).toBe('Drafting the motion');
  });

  it('releases the entry when the invoice that held it is deleted', async () => {
    const id = await seedTimeEntry();
    const invoiceId = await placeOnInvoice('time_entry', id);
    await testPool.query('delete from invoices where id = $1', [invoiceId]);

    await testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id]);
    const { rows } = await testPool.query(`select hours from activities where kind = 'time' and id = $1`, [id]);
    expect(rows[0].hours).toBe('9.00');
  });

  it('releases the entry when the invoice that held it is voided', async () => {
    const id = await seedTimeEntry();
    const invoiceId = await placeOnInvoice('time_entry', id);
    await testPool.query(`update invoices set status = 'voided' where id = $1`, [invoiceId]);

    await testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id]);
    const { rows } = await testPool.query(`select hours from activities where kind = 'time' and id = $1`, [id]);
    expect(rows[0].hours).toBe('9.00');
  });

  it('keeps it frozen while ANY live invoice still names it, even beside a voided one', async () => {
    const id = await seedTimeEntry();
    const voidedId = await placeOnInvoice('time_entry', id);
    await placeOnInvoice('time_entry', id);
    await testPool.query(`update invoices set status = 'voided' where id = $1`, [voidedId]);

    await expect(testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`delete from activities where kind = 'time' and id = $1`, [id])).rejects.toThrow(FROZEN);
  });
});

describe('flat fees', () => {
  it('freezes the amount and date of a billed fee and refuses its delete', async () => {
    const id = await seedFlatFee();
    await placeOnInvoice('flat_fee', id);

    await expect(testPool.query(`update activities set charge_cents = 1 where kind = 'flat_fee' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query("update activities set activity_date = '2026-01-01' where kind = 'flat_fee' and id = $1", [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`delete from activities where kind = 'flat_fee' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await testPool.query("update activities set description = 'Filing fee' where kind = 'flat_fee' and id = $1", [id]);
  });
});

describe('expenses', () => {
  it('freezes the amount, date and billable flag of a billed expense and refuses its delete', async () => {
    const id = await seedExpense();
    await placeOnInvoice('expense', id);

    await expect(testPool.query(`update activities set charge_cents = 1 where kind = 'expense' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query("update activities set activity_date = '2026-01-01' where kind = 'expense' and id = $1", [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`update activities set billable = false where kind = 'expense' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await expect(testPool.query(`delete from activities where kind = 'expense' and id = $1`, [id])).rejects.toThrow(FROZEN);
    await testPool.query("update activities set vendor = 'FedEx' where kind = 'expense' and id = $1", [id]);
  });

  it('releases a billed expense when its invoice is voided', async () => {
    const id = await seedExpense();
    const invoiceId = await placeOnInvoice('expense', id);
    await testPool.query(`update invoices set status = 'voided' where id = $1`, [invoiceId]);

    await testPool.query(`update activities set charge_cents = 1 where kind = 'expense' and id = $1`, [id]);
    await testPool.query(`delete from activities where kind = 'expense' and id = $1`, [id]);
    const { rows } = await testPool.query(`select 1 from activities where kind = 'expense' and id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });
});
