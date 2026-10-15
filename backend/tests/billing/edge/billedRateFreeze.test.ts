/**
 * A billed time entry's stamped rate is frozen with its hours.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

const setMemberRate = (dollars: number) => testPool.query(
  'update members set default_hourly_rate_cents = $3 where law_firm_id = $1 and user_id = $2',
  [firm.id, owner.uid, dollars * 100]);

async function logTime(hours = 1, date = '2026-03-10') {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, description: 'Work',
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

const stored = async (id: string) => {
  const { rows } = await testPool.query(
    `select resolved_rate_cents::int as rate, rate_source, amount_cents::int as amount
       from activities where kind = 'time' and id = $1`, [id]);
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Rate Client', email: 'rate@example.test' });
  await setMemberRate(100);
  await drainEvents();
});

describe('the freeze on a billed time entry', () => {
  it('refuses a direct change of the stamped rate that prices the billed hours', async () => {
    const id = await logTime();
    await owner.api.post(INV()).send({
      invoiceName: 'Frozen', invoiceDate: '2026-03-15',
      timeEntries: [{ id, hours: 1, rate: 100, amount: 100 }], totalAmount: 100,
    });

    await expect(testPool.query(
      `update activities set resolved_rate_cents = 1 where kind = 'time' and id = $1`, [id],
    )).rejects.toThrow(/on an invoice/);
    expect((await stored(id)).amount).toBe(10_000);
  });
});
