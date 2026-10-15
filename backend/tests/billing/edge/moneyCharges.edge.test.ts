/**
 * Flat fee and expense amounts: validation, exact storage, and the unbilled
 * totals that sum them. Cents are integers throughout; dollars appear only as
 * the JSON numbers a client would send and read back.
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
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const FEES = () => `/api/lawfirms/${firm.id}/billing/flat-fees`;
const EXPENSES = () => `/api/lawfirms/${firm.id}/billing/expenses`;
const SUMMARY = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}/unbilled-summary`;

const feeBody = (amount: number) => ({ clientId: client.id, description: 'Fee', amount, date: '2026-03-10' });
const expenseBody = (amount: number) => ({ clientId: client.id, description: 'Expense', amount, date: '2026-03-10' });

const storedCents = async (id: string) =>
  Number((await testPool.query('select amount_cents from activities where id = $1', [id])).rows[0].amount_cents);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Charges Client' });
  await drainEvents();
});

const ACCEPTED: Array<[number, number]> = [
  [0.01, 1], [0.1, 10], [0.29, 29], [0.57, 57], [1.15, 115], [19.99, 1_999], [33.33, 3_333],
  [1234567.89, 123_456_789], [999_999_999.99, 99_999_999_999], [1_000_000_000, 100_000_000_000],
];
const REFUSED = [0, -0.01, -5, 0.001, 0.005, 10.999, 1.005, 1_000_000_000.01, 4503599627370.49, 1e17, 1e21];

describe.each([
  ['flat fee', FEES, feeBody, 'flatFee'],
  ['expense', EXPENSES, expenseBody, 'expense'],
] as const)('a %s amount', (_label, url, body, key) => {
  it.each(ACCEPTED)('stores %p dollars as exactly %p cents and reads the same dollars back', async (dollars, cents) => {
    const res = await owner.api.post(url()).send(body(dollars));
    expect(res.status).toBe(201);
    const row = res.body[key];
    expect(await storedCents(row.id)).toBe(cents);
    expect(row.amount).toBe(dollars);
  });

  it.each(REFUSED)('refuses %p with a validation error rather than a rounded charge or a server error', async (amount) => {
    const res = await owner.api.post(url()).send(body(amount));
    expect({ amount, status: res.status }).toEqual({ amount, status: 400 });
  });

  it('applies the same rules when the amount is edited and leaves the stored cents alone on a refusal', async () => {
    const created = await owner.api.post(url()).send(body(12.34));
    const id = created.body[key].id as string;
    const path = `${url()}/client/${client.id}/${id}`;
    expect((await owner.api.put(path).send({ amount: 10.999 })).status).toBe(400);
    expect(await storedCents(id)).toBe(1_234);
    const ok = await owner.api.put(path).send({ amount: 0.07 });
    expect(ok.status).toBe(200);
    expect(await storedCents(id)).toBe(7);
  });
});

describe('unbilled totals over many small charges', () => {
  it('sums 0.1 + 0.2 + 0.3 style amounts to the exact cent', async () => {
    const cents = [10, 20, 30, 29, 57, 115, 1_999, 3_333];
    for (const c of cents) {
      expect((await owner.api.post(FEES()).send(feeBody(c / 100))).status).toBe(201);
      expect((await owner.api.post(EXPENSES()).send(expenseBody(c / 100))).status).toBe(201);
    }
    const total = cents.reduce((a, b) => a + b, 0);
    const res = await owner.api.get(SUMMARY());
    expect(res.status).toBe(200);
    expect(Math.round(res.body.totalUnbilledFlatFees * 100)).toBe(total);
    expect(Math.round(res.body.totalUnbilledExpenses * 100)).toBe(total);
    // The JSON number is the shortest decimal for the exact cents, no float dust.
    expect(res.body.totalUnbilledFlatFees).toBe(Number(`${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`));
  });
});
