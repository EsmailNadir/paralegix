/**
 * Validation matrix: flat fees, expenses, charge codes and the two reorder
 * routes. Every row is a malformed input that used to answer 500 or be stored
 * as something the caller did not send (0.001 dollars as zero cents). Each
 * must answer 400 and leave the firm's rows exactly as they were.
 *
 * Pattern follows `timeEntryValidationMatrix.test.ts`: snapshot, send, compare.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let feeId: string;
let expenseId: string;
let codeId: string;
let categoryId: string;

const B = () => `/api/lawfirms/${firm.id}/billing`;

const snapshot = async () => ({
  activities: (await testPool.query(
    `select id, kind, charge_cents::text as cents, activity_date::text as day, billing_code_id
       from activities where law_firm_id = $1 order by id`, [firm.id],
  )).rows,
  codes: (await testPool.query(
    `select id, kind, code, default_rate_cents::text as rate, member_rates, sort_order
       from billing_codes where law_firm_id = $1 order by id`, [firm.id],
  )).rows,
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Matrix Client' });
  await drainEvents();

  // One valid record of each kind, created through the same routes, so every
  // row below is known to fail on its input and not on a broken route.
  const fee = await owner.api.post(`${B()}/flat-fees`).send({
    clientId: client.id, description: 'Fee', amount: 100, date: '2026-05-19',
  });
  expect(fee.status).toBe(201);
  feeId = fee.body.flatFee.id;
  const expense = await owner.api.post(`${B()}/expenses`).send({
    clientId: client.id, description: 'Cost', amount: 40, date: '2026-05-19',
  });
  expect(expense.status).toBe(201);
  expenseId = expense.body.expenseId;
  const code = await owner.api.post(`${B()}/charge-codes`).send({ code: 'MTX01', name: 'Matrix', defaultRate: 250 });
  expect(code.status).toBe(201);
  codeId = code.body.chargeCodeId;
  const category = await owner.api.post(`${B()}/expense-categories`).send({ code: 'MTX_CAT', name: 'Matrix' });
  expect(category.status).toBe(201);
  categoryId = category.body.expenseCategoryId;
});

type Row = [label: string, send: () => Promise<{ status: number }>];

const fee = (body: object) => () => owner.api.post(`${B()}/flat-fees`).send({ clientId: client.id, description: 'Fee', amount: 100, ...body });
const feeEdit = (body: object) => () => owner.api.put(`${B()}/flat-fees/client/${client.id}/${feeId}`).send(body);
const expense = (body: object) => () => owner.api.post(`${B()}/expenses`).send({ clientId: client.id, description: 'Cost', amount: 40, ...body });
const expenseEdit = (body: object) => () => owner.api.put(`${B()}/expenses/client/${client.id}/${expenseId}`).send(body);
// One code per row, fixed when the row is declared, so no two rows can collide and a rerun sends the same bytes.
let nextCodeIndex = 0;
const code = (body: object) => {
  const chargeCode = `NEW${String(++nextCodeIndex).padStart(3, '0')}`;
  return () => owner.api.post(`${B()}/charge-codes`).send({ code: chargeCode, name: 'New', ...body });
};
const codeEdit = (body: object) => () => owner.api.put(`${B()}/charge-codes/${codeId}`).send(body);

const ROWS: Row[] = [
  ['flat fee: date that is not a date', fee({ date: 'not-a-date' })],
  ['flat fee: impossible calendar day', fee({ date: '2026-02-30' })],
  ['flat fee: date as a number', fee({ date: 20260519 })],
  ['flat fee: date as a timestamp', fee({ date: '2026-05-19T00:00:00Z' })],
  ['flat fee: sub-cent amount 0.001', fee({ amount: 0.001 })],
  ['flat fee: half-cent amount 0.005', fee({ amount: 0.005 })],
  ['flat fee: three decimals 12.345', fee({ amount: 12.345 })],
  ['flat fee edit: bad date', feeEdit({ date: 'yesterday' })],
  ['flat fee edit: sub-cent amount', feeEdit({ amount: 0.001 })],
  ['expense: date that is not a date', expense({ date: 'garbage' })],
  ['expense: date as a number', expense({ date: 20260414 })],
  ['expense: month 13', expense({ date: '2026-13-01' })],
  ['expense: sub-cent amount 0.001', expense({ amount: 0.001 })],
  ['expense: three decimals 12.345', expense({ amount: 12.345 })],
  ['expense edit: bad date', expenseEdit({ date: 'garbage' })],
  ['expense edit: sub-cent amount', expenseEdit({ amount: 0.009 })],
  ['charge code: defaultRate 1e17', code({ defaultRate: 1e17 })],
  ['charge code: defaultRate one past the cap', code({ defaultRate: 1_000_001 })],
  ['charge code: defaultRate with three decimals', code({ defaultRate: 10.005 })],
  ['charge code: member rate 1e17', code({ memberRates: { 'user-1': 1e17 } })],
  ['charge code: member rate one past the cap', code({ memberRates: { 'user-1': 1_000_001 } })],
  ['charge code edit: defaultRate 1e17', codeEdit({ defaultRate: 1e17 })],
  ['charge code edit: member rate 1e17', codeEdit({ memberRates: { 'user-1': 1e17 } })],
  ['charge code reorder: non-uuid id', () => owner.api.put(`${B()}/charge-codes/reorder`).send({ chargeCodeIds: ['not-a-uuid'] })],
  ['charge code reorder: one bad id among good', () => owner.api.put(`${B()}/charge-codes/reorder`).send({ chargeCodeIds: [codeId, 'nope'] })],
  ['expense category reorder: non-uuid id', () => owner.api.put(`${B()}/expense-categories/reorder`).send({ expenseCategoryIds: ['not-a-uuid'] })],
];

describe('malformed billing inputs', () => {
  it.each(ROWS)('%s: 400 and nothing written', async (_label, send) => {
    const before = await snapshot();

    const res = await send();

    expect(res.status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
});

describe('the boundaries that must still be accepted', () => {
  it('stores a one-cent flat fee and a one-cent expense as 1 cent', async () => {
    const f = await fee({ amount: 0.01, date: '2026-05-19' })();
    const e = await expense({ amount: 0.01, date: '2026-05-19' })();

    expect(f.status).toBe(201);
    expect(e.status).toBe(201);
    const { rows } = await testPool.query(
      'select charge_cents::text as cents from activities where id = any($1::uuid[]) order by id',
      [[(f as any).body.flatFee.id, (e as any).body.expenseId]],
    );
    expect(rows.map((r: any) => r.cents)).toEqual(['1', '1']);
  });

  it('accepts a dateless flat fee and expense', async () => {
    expect((await fee({ date: null })()).status).toBe(201);
    expect((await expense({ date: null })()).status).toBe(201);
  });

  it('accepts a charge-code rate exactly at the cap, and zero', async () => {
    const atCap = await code({ defaultRate: 1_000_000, memberRates: { 'user-1': 0 } })();

    expect(atCap.status).toBe(201);
    const { rows } = await testPool.query(
      'select default_rate_cents::text as rate from billing_codes where id = $1', [(atCap as any).body.chargeCodeId],
    );
    expect(rows[0].rate).toBe('100000000');
  });

  it('reorders by real ids', async () => {
    const res = await owner.api.put(`${B()}/expense-categories/reorder`).send({ expenseCategoryIds: [categoryId] });

    expect(res.status).toBe(200);
  });
});
