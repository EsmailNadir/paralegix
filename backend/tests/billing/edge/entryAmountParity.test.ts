/**
 * A time entry's amount is `round(hours * rate_cents)`, half up, in exact decimal
 * arithmetic (the generated `activities.amount_cents`). These cases are the exact
 * half-cent products, where a float product lands a hair under the boundary.
 *
 * RED IF: the generated column stops rounding half up, or the entry read shows a
 * different cent amount than the stored row.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

async function logTime(hours: number, rateDollars: number, date = '2026-03-10') {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, hourlyRate: rateDollars, description: 'Work',
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

const storedCents = async (id: string) => Number((await testPool.query(
  `select amount_cents from activities where kind = 'time' and id = $1`, [id])).rows[0].amount_cents);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Parity Client' });
  await drainEvents();
});

// hours (hundredths) x rate (cents) that land on an exact half cent.
const HALF_CENT_CASES: Array<[number, number, number]> = [
  [0.06, 175.25, 1052],
  [0.3, 123.45, 3704],
  [0.15, 250.5, 3758],
  [0.1, 0.35, 4],
];

describe.each(HALF_CENT_CASES)('%s h at $%s is %s cents', (hours, rate, expectedCents) => {
  it('is stored at the exact half-up cent amount (control)', async () => {
    const id = await logTime(hours, rate);
    expect(await storedCents(id)).toBe(expectedCents);
  });

  it('shows the same cents on the entry read as the stored row', async () => {
    const id = await logTime(hours, rate);
    const res = await owner.api.get(`${T()}/client/${client.id}`);
    const entry = res.body.timeEntries.find((e: any) => e.id === id);
    expect(Math.round(entry.amount * 100)).toBe(expectedCents);
  });
});
