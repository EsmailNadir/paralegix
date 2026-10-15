/**
 * Migration 0030 turns an invoice line whose source id names no activity into a
 * manual line (source_id null), so a phantom link stops pretending to protect
 * work that does not exist.
 *
 * The migration's SQL is read from the file and run against seeded rows, the
 * way the operator's runner applies it.
 *
 * WHAT BREAKS EACH TEST:
 *  - drop the firm scope on the activity lookup and a line pointing at another
 *    firm's real activity keeps a link it does not own;
 *  - drop the kind match and a time line naming an expense id keeps a link the
 *    freeze trigger would never honour;
 *  - widen the update to null sources and a manual line is rewritten (updated
 *    rows change) or a real link is lost, and the activity un-freezes;
 *  - drop the plan-fee exemption and a recurring plan invoice loses the id its
 *    plan-fee lookup reads.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { testPool, createFirm, createPersonClient, createInvoice, createFirmMember } from '../support/setupInProcess';

const SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '0030_clear_orphan_line_sources.sql'),
  'utf8',
);

async function seedActivity(firmId: string, clientId: string, userId: string, kind: 'time' | 'flat_fee' | 'expense') {
  const id = randomUUID();
  if (kind === 'time') {
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, rate_cents, description)
       values ('time', $1, $2, $3, $4, date '2026-03-01', 1, 10000, 'Work')`, [id, firmId, clientId, userId]);
  } else if (kind === 'flat_fee') {
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date)
       values ('flat_fee', $1, $2, $3, 'Fee', 5000, date '2026-03-01')`, [id, firmId, clientId]);
  } else {
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date, billable)
       values ('expense', $1, $2, $3, 'Cab', 2000, date '2026-03-01', true)`, [id, firmId, clientId]);
  }
  return id;
}

async function seedLine(firmId: string, clientId: string, kind: string, sourceId: string | null) {
  const invoice = await createInvoice(firmId, clientId, { totalCents: 1000 });
  const { rows } = await testPool.query(
    `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, amount_cents)
     values ($1, $2, $3, $4, 1000) returning id`, [invoice.id, firmId, kind, sourceId]);
  return rows[0].id as string;
}

const sourceOf = async (lineId: string) =>
  (await testPool.query('select source_id from invoice_line_items where id = $1', [lineId])).rows[0].source_id;

async function world() {
  const firm = await createFirm();
  const member = await createFirmMember(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Migrated Client' });
  return { firmId: firm.id, clientId: client.id, userId: member.uid };
}

it('keeps a link to a real activity of its own firm and kind, for all three kinds', async () => {
  const w = await world();
  const lines = [];
  for (const [kind, activity] of [['time_entry', 'time'], ['flat_fee', 'flat_fee'], ['expense', 'expense']] as const) {
    const id = await seedActivity(w.firmId, w.clientId, w.userId, activity);
    lines.push({ line: await seedLine(w.firmId, w.clientId, kind, id), id });
  }

  await testPool.query(SQL);

  for (const { line, id } of lines) expect(await sourceOf(line)).toBe(id);
});

it('nulls a link that names no activity, for all three kinds, and a placeholder string', async () => {
  const w = await world();
  const phantoms = [
    await seedLine(w.firmId, w.clientId, 'time_entry', randomUUID()),
    await seedLine(w.firmId, w.clientId, 'flat_fee', randomUUID()),
    await seedLine(w.firmId, w.clientId, 'expense', randomUUID()),
    await seedLine(w.firmId, w.clientId, 'flat_fee', 'flat-fee-1700000000000'),
  ];

  await testPool.query(SQL);

  for (const line of phantoms) expect(await sourceOf(line)).toBeNull();
});

it('leaves a manual line untouched and does not rewrite it', async () => {
  const w = await world();
  const manual = await seedLine(w.firmId, w.clientId, 'time_entry', null);
  const { rows: [{ xmin }] } = await testPool.query('select xmin::text from invoice_line_items where id = $1', [manual]);

  await testPool.query(SQL);

  expect(await sourceOf(manual)).toBeNull();
  const { rows: [after] } = await testPool.query('select xmin::text from invoice_line_items where id = $1', [manual]);
  expect(after.xmin).toBe(xmin);
});

it('does not count another firm\'s activity as real, nor one of a different kind', async () => {
  const a = await world();
  const b = await world();
  const foreign = await seedActivity(b.firmId, b.clientId, b.userId, 'time');
  const wrongKind = await seedActivity(a.firmId, a.clientId, a.userId, 'expense');
  const crossFirm = await seedLine(a.firmId, a.clientId, 'time_entry', foreign);
  const mismatched = await seedLine(a.firmId, a.clientId, 'time_entry', wrongKind);
  const owned = await seedLine(b.firmId, b.clientId, 'time_entry', foreign);

  await testPool.query(SQL);

  expect(await sourceOf(crossFirm)).toBeNull();
  expect(await sourceOf(mismatched)).toBeNull();
  expect(await sourceOf(owned)).toBe(foreign);
});

it('keeps a recurring plan fee id, which names a plan period rather than an activity', async () => {
  const w = await world();
  const planFee = `plan-${randomUUID()}-2026-03-01`;
  const line = await seedLine(w.firmId, w.clientId, 'flat_fee', planFee);

  await testPool.query(SQL);

  expect(await sourceOf(line)).toBe(planFee);
});

it('is idempotent: a second run changes no row', async () => {
  const w = await world();
  const real = await seedActivity(w.firmId, w.clientId, w.userId, 'expense');
  const kept = await seedLine(w.firmId, w.clientId, 'expense', real);
  const phantom = await seedLine(w.firmId, w.clientId, 'expense', randomUUID());

  await testPool.query(SQL);
  const snapshot = (await testPool.query(
    'select id, source_id, xmin::text from invoice_line_items where law_firm_id = $1 order by id', [w.firmId])).rows;
  await testPool.query(SQL);
  const again = (await testPool.query(
    'select id, source_id, xmin::text from invoice_line_items where law_firm_id = $1 order by id', [w.firmId])).rows;

  expect(again).toEqual(snapshot);
  expect(await sourceOf(kept)).toBe(real);
  expect(await sourceOf(phantom)).toBeNull();
});
