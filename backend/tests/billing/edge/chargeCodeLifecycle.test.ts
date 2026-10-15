/**
 * A charge code's life against the time entries that name it.
 *
 * RED IF: a code an entry uses can be deleted through the route, deleting a code
 * at the database clears anything beyond the entry's code, a rename or a rate
 * change moves an entry's stamped rate, or a UTBMS code stops reaching the
 * unbilled summary the invoice is composed from.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const CC = () => `/api/lawfirms/${firm.id}/billing/charge-codes`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

async function chargeCode(code: string, defaultRate: number | null = 120) {
  const res = await owner.api.post(CC()).send({ code, name: `Code ${code}`, defaultRate });
  expect(res.status).toBe(201);
  return res.body.chargeCodeId as string;
}
async function logTime(chargeCodeId: string | null, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', description: 'Work', chargeCodeId, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}
const row = async (id: string) => (await testPool.query(
  `select billing_code_id, law_firm_id, client_id, hours::text as hours, resolved_rate_cents::int as rate, rate_source
     from activities where id = $1`, [id])).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Code Client' });
  await drainEvents();
});

it('refuses to delete a code an entry uses and leaves the entry on it', async () => {
  const code = await chargeCode('LITIG');
  const entry = await logTime(code);

  const res = await owner.api.delete(`${CC()}/${code}`);

  expect(res.status).toBe(400);
  expect((await row(entry)).billing_code_id).toBe(code);
  const still = await testPool.query('select 1 from billing_codes where id = $1', [code]);
  expect(still.rows).toHaveLength(1);
});

it('deletes an unused code and refuses to once an entry names it', async () => {
  const unused = await chargeCode('UNUSED1');
  const used = await chargeCode('USED001');
  await logTime(used);

  expect((await owner.api.delete(`${CC()}/${unused}`)).status).toBe(200);
  expect((await owner.api.delete(`${CC()}/${used}`)).status).toBe(400);
});

it('at the database, deleting a code clears only the entry code and keeps its firm, client, hours and rate', async () => {
  const code = await chargeCode('GONE001', 120);
  const entry = await logTime(code);
  const before = await row(entry);
  expect(before).toMatchObject({ billing_code_id: code, rate: 12_000, rate_source: 'charge code default' });

  await testPool.query('delete from billing_codes where id = $1', [code]);

  const after = await row(entry);
  expect(after).toEqual({ ...before, billing_code_id: null });
});

it('keeps an entry at its stamped rate when the code is renamed, re-rated or deactivated', async () => {
  const code = await chargeCode('RATED01', 120);
  const entry = await logTime(code);

  const res = await owner.api.put(`${CC()}/${code}`).send({ name: 'Renamed', defaultRate: 300, isActive: false });
  expect(res.status).toBe(200);

  expect(await row(entry)).toMatchObject({ billing_code_id: code, rate: 12_000, rate_source: 'charge code default' });
  const summary = await owner.api.get(`${INV()}/unbilled-summary`);
  expect(summary.body.unbilledTimeEntries.find((e: any) => e.id === entry)).toMatchObject({ rate: 120, amount: 120 });
});

it('prices a later entry on the re-rated code at the new rate', async () => {
  const code = await chargeCode('RATED02', 120);
  await owner.api.put(`${CC()}/${code}`).send({ defaultRate: 300 });

  const entry = await logTime(code);

  expect(await row(entry)).toMatchObject({ rate: 30_000, rate_source: 'charge code default' });
});

it('refuses a charge code id that belongs to another firm or to an expense category', async () => {
  const other = await createFirm();
  const foreignOwner = await ownerOf(other.id);
  const foreign = await foreignOwner.api.post(`/api/lawfirms/${other.id}/billing/charge-codes`)
    .send({ code: 'FOREIGN', name: 'Foreign', defaultRate: 999 });
  expect(foreign.status).toBe(201);

  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', chargeCodeId: foreign.body.chargeCodeId,
  });

  expect(res.status).toBe(400);
  const rows = await testPool.query(`select 1 from activities where law_firm_id = $1`, [firm.id]);
  expect(rows.rows).toHaveLength(0);
});

it('carries the UTBMS task and activity codes into the unbilled summary', async () => {
  const entry = await logTime(null, { hourlyRate: 100, utbmsTaskCode: 'L110', utbmsActivityCode: 'A103' });

  const summary = await owner.api.get(`${INV()}/unbilled-summary`);

  expect(summary.body.unbilledTimeEntries.find((e: any) => e.id === entry))
    .toMatchObject({ utbmsTaskCode: 'L110', utbmsActivityCode: 'A103' });
});
