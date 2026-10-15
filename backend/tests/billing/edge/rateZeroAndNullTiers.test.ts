/**
 * Zero is a configured rate (pro bono); null and a missing key are not.
 *
 * RED IF: a zero in a higher tier falls through to a lower tier's rate, a null
 * stops falling through, a charge-code rate stops reaching the entry, or an
 * entry priced at zero is stored as "no rate".
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const CC = () => `/api/lawfirms/${firm.id}/billing/charge-codes`;

const setMemberRate = (dollars: number | null) => testPool.query(
  'update members set default_hourly_rate_cents = $3 where law_firm_id = $1 and user_id = $2',
  [firm.id, owner.uid, dollars == null ? null : dollars * 100]);
const setClientRates = (rates: Record<string, unknown>) => testPool.query(
  'update clients set billing_rates = $2 where id = $1', [client.id, JSON.stringify(rates)]);

async function chargeCode(code: string, defaultRate: number | null, memberRates?: Record<string, number>) {
  const res = await owner.api.post(CC()).send({ code, name: `Code ${code}`, defaultRate, memberRates });
  expect(res.status).toBe(201);
  return res.body.chargeCodeId as string;
}

async function logTime(extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 2, date: '2026-03-10', description: 'Work', ...extra,
  });
  expect(res.status).toBe(201);
  const { rows } = await testPool.query(
    `select resolved_rate_cents::int as rate, rate_source, amount_cents::int as amount
       from activities where kind = 'time' and id = $1`, [res.body.timeEntry.id]);
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Zero Client' });
  await setMemberRate(200);
  await drainEvents();
});

it('a zero client default rate beats the member default and prices the entry at $0', async () => {
  await setClientRates({ defaultRate: 0 });
  expect(await logTime()).toEqual({ rate: 0, rate_source: 'client default rate', amount: 0 });
});

it('a zero charge-code default beats the member default', async () => {
  const code = await chargeCode('PROBONO', 0);
  expect(await logTime({ chargeCodeId: code })).toEqual({ rate: 0, rate_source: 'charge code default', amount: 0 });
});

it('a zero explicit override beats every configured rate', async () => {
  await setClientRates({ defaultRate: 300 });
  expect(await logTime({ hourlyRate: 0 })).toEqual({ rate: 0, rate_source: 'time entry override', amount: 0 });
});

it('a null client default and a null member rate fall through to the charge-code rate', async () => {
  await setClientRates({ defaultRate: null, memberRates: { [owner.uid]: null } });
  const code = await chargeCode('HOURLY', 125.5);
  expect(await logTime({ chargeCodeId: code })).toEqual({ rate: 12_550, rate_source: 'charge code default', amount: 25_100 });
});

it('a charge-code member rate beats that code default, and the client default beats both', async () => {
  const code = await chargeCode('MEMBER', 100, { [owner.uid]: 175.25 });
  expect(await logTime({ chargeCodeId: code })).toEqual({ rate: 17_525, rate_source: 'charge code member rate', amount: 35_050 });

  await setClientRates({ defaultRate: 90 });
  expect(await logTime({ chargeCodeId: code })).toEqual({ rate: 9_000, rate_source: 'client default rate', amount: 18_000 });
});

it('stores a missing rate as source none with no cents, and the summary bills it at $0', async () => {
  await setMemberRate(null);
  const row = await logTime();
  expect(row).toEqual({ rate: null, rate_source: 'none', amount: 0 });

  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}/unbilled-summary`);
  expect(res.body.unbilledTimeEntries).toHaveLength(1);
  expect(res.body.unbilledTimeEntries[0]).toMatchObject({ rate: 0, amount: 0, hours: 2 });
});
