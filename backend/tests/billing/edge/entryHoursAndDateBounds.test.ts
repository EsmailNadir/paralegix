/**
 * The bounds on a time entry's hours and date, on create and on update.
 *
 * RED IF: an entry outside 0.01..24 hours is stored, an in-range one is refused,
 * a date beyond tomorrow (UTC) is accepted, or a day-only date moves a day in a
 * firm timezone behind or ahead of UTC.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, as, tokenFor,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const body = (extra: Record<string, unknown> = {}) => ({
  clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 100, ...extra,
});
const rows = async () => (await testPool.query(
  `select hours::text as hours, activity_date::text as day from activities where kind = 'time' and law_firm_id = $1`,
  [firm.id])).rows;
const dayFrom = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Bounds Client' });
  await drainEvents();
});

describe('hours', () => {
  it.each([0.01, 1.25, 24])('stores %s hours exactly', async (hours) => {
    const res = await owner.api.post(T()).send(body({ hours }));
    expect(res.status).toBe(201);
    expect(Number((await rows())[0].hours)).toBe(hours);
  });

  it.each([24.01, 25, 0, -1, 0.004])('refuses %s hours and stores nothing', async (hours) => {
    const res = await owner.api.post(T()).send(body({ hours }));
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses an update past 24 hours and keeps the stored hours', async () => {
    const created = await owner.api.post(T()).send(body({ hours: 2 }));
    const id = created.body.timeEntry.id;

    const res = await owner.api.put(`${T()}/client/${client.id}/${id}`).send({ hours: 24.01 });

    expect(res.status).toBe(400);
    expect(Number((await rows())[0].hours)).toBe(2);
  });

  it('prices 24 hours at a rate with odd cents to the exact cent', async () => {
    const res = await owner.api.post(T()).send(body({ hours: 24, hourlyRate: 333.33 }));
    expect(res.status).toBe(201);
    const { rows: amount } = await testPool.query(
      `select amount_cents::int as cents from activities where kind = 'time' and law_firm_id = $1`, [firm.id]);
    expect(amount[0].cents).toBe(799_992);
  });
});

describe('date', () => {
  it('accepts tomorrow (UTC) and refuses the day after', async () => {
    const ok = await owner.api.post(T()).send(body({ date: dayFrom(1) }));
    const late = await owner.api.post(T()).send(body({ date: dayFrom(2) }));

    expect(ok.status).toBe(201);
    expect(late.status).toBe(400);
    expect((await rows()).map((r: any) => r.day)).toEqual([dayFrom(1)]);
  });

  it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata'])(
    'keeps a day-only date on the same day under x-timezone %s',
    async (zone) => {
      const agent = as(tokenFor({ uid: owner.uid }), zone);
      const res = await agent.post(T()).send(body({ date: '2026-03-08' }));
      expect(res.status).toBe(201);
      expect(res.body.timeEntry.date).toBe('2026-03-08');
      expect((await rows())[0].day).toBe('2026-03-08');
    },
  );
});
