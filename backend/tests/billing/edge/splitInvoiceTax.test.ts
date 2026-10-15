/**
 * Split invoices levy the firm's default tax like a single-payer invoice does.
 */
import { randomUUID } from 'crypto';
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm,
} from '../../support/setupInProcess';

let firm: Firm; let owner: Actor;
beforeEach(async () => { firm = await createFirm(); owner = await ownerOf(firm.id); await drainEvents(); });

async function matterWith(bps: Array<number | null>) {
  const id = randomUUID();
  await testPool.query(`insert into matters (id, law_firm_id, name, matter_reference_id, status) values ($1,$2,'M',$3,'active')`, [id, firm.id, `REF-${id.slice(0, 8)}`]);
  await testPool.query(`insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at) values ($1,$2,$3,'lead',now())`, [id, owner.uid, firm.id]);
  for (const bp of bps) {
    const c = await createPersonClient(firm.id, { name: `P${Math.random()}` });
    await testPool.query(`insert into matter_clients (matter_id, client_id, law_firm_id, billing_portion_bp) values ($1,$2,$3,$4)`, [id, c.id, firm.id, bp]);
  }
  await testPool.query(`insert into activities (kind, id, law_firm_id, matter_id, description, charge_cents, activity_date) values ('flat_fee',$1,$2,$3,'Fee',10000,date '2026-03-10')`, [randomUUID(), firm.id, id]);
  return id;
}

it('taxes a split matter like a single-payer matter (10% of 100.00 is 10.00 in total)', async () => {
  await testPool.query(
    `update law_firms set settings = jsonb_build_object('billing', jsonb_build_object('tax', jsonb_build_object('enabled', true, 'defaultRate', 10)))
      where id = $1`, [firm.id]);
  const single = await matterWith([null]);
  const split = await matterWith([5000, 5000]);
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/bulk`).send({
    invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: single }, { type: 'matter', entityId: split }],
  });
  expect(res.status).toBe(201);
  const taxOf = async (m: string) => Number((await testPool.query('select coalesce(sum(tax_cents),0) t from invoices where matter_id = $1', [m])).rows[0].t);
  expect(await taxOf(single)).toBe(1000);
  expect(await taxOf(split)).toBe(1000);
});

it('levies tax on each share\'s own lines when the shares carry odd cents (7.25% of 33.33 / 33.33 / 33.34)', async () => {
  await testPool.query(
    `update law_firms set settings = jsonb_build_object('billing', jsonb_build_object('tax', jsonb_build_object('enabled', true, 'defaultRate', 7.25)))
      where id = $1`, [firm.id]);
  const split = await matterWith([3333, 3333, 3334]);
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/bulk`).send({
    invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: split }],
  });
  expect(res.status).toBe(201);
  const rows = (await testPool.query(
    'select total_cents::int total, tax_cents::int tax from invoices where matter_id = $1 order by total_cents', [split])).rows;
  // 7.25% of 3333 is 241.64 and of 3334 is 241.72: each share rounds to 242.
  expect(rows).toEqual([{ total: 3575, tax: 242 }, { total: 3575, tax: 242 }, { total: 3576, tax: 242 }]);
});
