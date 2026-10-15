/**
 * Every surface that answers "what is still unbilled" gives the same answer:
 * exactly the work on no live invoice, which includes work whose invoice was
 * voided. Checked per context (matter and client) and per timekeeper.
 *
 * RED IF: any list drops work that is free (never billed, or held only by a voided
 * invoice), or offers work a live invoice holds, or two surfaces disagree.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, memberWith, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { seedMatter, seedMatterMember } from '../../support/matters';

let firm: Firm;
let owner: Actor;
let colleague: Actor;
let client: ClientRecord;
let matterId: string;

const B = () => `/api/lawfirms/${firm.id}/billing`;

type Ctx = 'matter' | 'client';
const contextId = (ctx: Ctx) => (ctx === 'matter' ? matterId : client.id);
const ownKey = (ctx: Ctx) => (ctx === 'matter' ? { matterId } : { clientId: client.id });

interface Work { liveTime: string; voidedTime: string; openTime: string; colleagueOpenTime: string;
  liveFee: string; voidedFee: string; openFee: string; liveExp: string; voidedExp: string; openExp: string }

async function seedWork(ctx: Ctx): Promise<Work> {
  const own = ownKey(ctx);
  const time = async (user: Actor, hours: number, description: string) => {
    const res = await owner.api.post(`${B()}/time-entries`).send({
      ...own, userId: user.uid, hours, date: '2026-03-10', hourlyRate: 100, description,
    });
    expect(res.status).toBe(201);
    return res.body.timeEntry.id as string;
  };
  const fee = async (description: string, amount: number) => {
    const res = await owner.api.post(`${B()}/flat-fees`).send({ ...own, description, amount, date: '2026-03-10' });
    expect(res.status).toBe(201);
    return res.body.flatFee.id as string;
  };
  const exp = async (description: string, amount: number) => {
    const res = await owner.api.post(`${B()}/expenses`).send({ ...own, description, amount, date: '2026-03-10' });
    expect(res.status).toBe(201);
    return res.body.expenseId as string;
  };
  const work: Work = {
    liveTime: await time(owner, 1, 'live'), voidedTime: await time(owner, 2, 'voided'),
    openTime: await time(owner, 3, 'open'), colleagueOpenTime: await time(colleague, 4, 'colleague open'),
    liveFee: await fee('live fee', 10), voidedFee: await fee('voided fee', 20), openFee: await fee('open fee', 30),
    liveExp: await exp('live exp', 1), voidedExp: await exp('voided exp', 2), openExp: await exp('open exp', 3),
  };
  const invoiceUrl = ctx === 'matter' ? `${B()}/invoices` : `${B()}/invoices/client/${client.id}`;
  const ctxBody = ctx === 'matter' ? { matterId } : {};
  const live = await owner.api.post(invoiceUrl).send({
    ...ctxBody, invoiceName: `live ${ctx}`, invoiceDate: '2026-03-15',
    timeEntries: [{ id: work.liveTime, hours: 1, rate: 100, amount: 100 }],
    flatFees: [{ id: work.liveFee, description: 'live fee', amount: 10 }],
    expenses: [{ id: work.liveExp, description: 'live exp', amount: 1 }],
    totalAmount: 111, flatFeesAmount: 10,
  });
  expect(live.status).toBe(201);
  const second = await owner.api.post(invoiceUrl).send({
    ...ctxBody, invoiceName: `voided ${ctx}`, invoiceDate: '2026-03-15',
    timeEntries: [{ id: work.voidedTime, hours: 2, rate: 100, amount: 200 }],
    flatFees: [{ id: work.voidedFee, description: 'voided fee', amount: 20 }],
    expenses: [{ id: work.voidedExp, description: 'voided exp', amount: 2 }],
    totalAmount: 222, flatFeesAmount: 20,
  });
  expect(second.status).toBe(201);
  const voidUrl = ctx === 'matter'
    ? `${B()}/invoices/matter/${matterId}/${second.body.invoice.id}/void`
    : `${B()}/invoices/client/${client.id}/${second.body.invoice.id}/void`;
  expect((await owner.api.post(voidUrl)).status).toBe(200);
  await drainEvents();
  return work;
}

const sorted = (ids: string[]) => [...ids].sort();

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  colleague = await memberWith(firm.id, ['billing.manageTimeEntries', 'billing.viewTimeEntries']);
  client = await createPersonClient(firm.id, { name: 'Sets Client', email: 'sets@example.test' });
  matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
  await seedMatterMember(firm.id, matterId, colleague.uid);
  await drainEvents();
});

describe.each<Ctx>(['matter', 'client'])('%s context', (ctx) => {
  it('offers the open and voided-invoice work in the unbilled summary and nothing a live invoice holds', async () => {
    const w = await seedWork(ctx);

    const res = await owner.api.get(`${B()}/invoices/${ctx}/${contextId(ctx)}/unbilled-summary`);

    expect(res.status).toBe(200);
    expect(sorted(res.body.unbilledTimeEntries.map((e: any) => e.id)))
      .toEqual(sorted([w.voidedTime, w.openTime, w.colleagueOpenTime]));
    expect(sorted(res.body.unbilledFlatFees.map((e: any) => e.id))).toEqual(sorted([w.voidedFee, w.openFee]));
    expect(sorted(res.body.unbilledExpenses.map((e: any) => e.id))).toEqual(sorted([w.voidedExp, w.openExp]));
    expect(res.body.totalUnbilledHours).toBe(9);
    expect(res.body.totalUnbilledTimeAmount).toBe(900);
    expect(res.body.totalUnbilledFlatFees).toBe(50);
    expect(res.body.totalUnbilledExpenses).toBe(5);
  });

  it('flags billed work on the time, flat-fee and expense lists and filters unbilledOnly per timekeeper', async () => {
    const w = await seedWork(ctx);
    const id = contextId(ctx);

    const all = await owner.api.get(`${B()}/time-entries/${ctx}/${id}`);
    const flags = Object.fromEntries(all.body.timeEntries.map((e: any) => [e.id, e.isBilled]));
    expect(flags).toEqual({
      [w.liveTime]: true, [w.voidedTime]: false, [w.openTime]: false, [w.colleagueOpenTime]: false,
    });
    const mine = await owner.api.get(`${B()}/time-entries/${ctx}/${id}`).query({ unbilledOnly: 'true', userId: owner.uid });
    expect(sorted(mine.body.timeEntries.map((e: any) => e.id))).toEqual(sorted([w.voidedTime, w.openTime]));
    const theirs = await owner.api.get(`${B()}/time-entries/${ctx}/${id}`).query({ unbilledOnly: 'true', userId: colleague.uid });
    expect(theirs.body.timeEntries.map((e: any) => e.id)).toEqual([w.colleagueOpenTime]);

    const fees = await owner.api.get(`${B()}/flat-fees/${ctx}/${id}`).query({ unbilledOnly: 'true' });
    expect(sorted(fees.body.flatFees.map((e: any) => e.id))).toEqual(sorted([w.voidedFee, w.openFee]));
    const exps = await owner.api.get(`${B()}/expenses/${ctx}/${id}`);
    expect(Object.fromEntries(exps.body.expenses.map((e: any) => [e.id, e.isBilled])))
      .toEqual({ [w.liveExp]: true, [w.voidedExp]: false, [w.openExp]: false });
  });

  it('reports the same free work on the firm lists and the bulk picker', async () => {
    const w = await seedWork(ctx);
    const own = ownKey(ctx);

    const firmTime = await owner.api.get(`${B()}/time-entries/firm`).query({ ...own });
    const status = Object.fromEntries(firmTime.body.timeEntries.map((e: any) => [e.id, e.billingStatus]));
    expect(status).toEqual({
      [w.liveTime]: 'billed', [w.voidedTime]: 'unbilled', [w.openTime]: 'unbilled', [w.colleagueOpenTime]: 'unbilled',
    });
    const mineOnly = await owner.api.get(`${B()}/time-entries/firm`)
      .query({ ...own, billingStatus: 'unbilled', userId: colleague.uid });
    expect(mineOnly.body.timeEntries.map((e: any) => e.id)).toEqual([w.colleagueOpenTime]);

    const firmFees = await owner.api.get(`${B()}/flat-fees/firm`).query({ ...own, billingStatus: 'unbilled' });
    expect(sorted(firmFees.body.flatFees.map((e: any) => e.id))).toEqual(sorted([w.voidedFee, w.openFee]));

    const picker = await owner.api.get(`${B()}/invoices/firm/unbilled-summaries`);
    const row = picker.body.summaries.find((s: any) => s.type === ctx && s.entityId === contextId(ctx));
    expect(row).toMatchObject({ unbilledHours: 9, unbilledTimeAmount: 900, unbilledFlatFees: 50 });
    const { rows } = await testPool.query(
      `select count(*)::int as n from invoices where law_firm_id = $1 and status = 'voided'`, [firm.id]);
    expect(rows[0].n).toBe(1);
  });
});
