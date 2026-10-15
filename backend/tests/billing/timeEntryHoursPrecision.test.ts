/**
 * What a time entry stores for hours, end to end through the route.
 *
 * `activities.hours` is numeric(6,2) and `amount_cents` is generated from the
 * stored value, so the hours the service hands Postgres must already be what
 * the client is billed. A 5-minute increment used to arrive as 0.083333 and be
 * stored as 0.08; an entry of 0.004 hours was stored as zero.
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
import * as timeEntriesService from '../../src/modules/billing/timeEntries/timeEntries.service';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

async function setRounding(incrementMinutes: number) {
  const res = await testPool.query(
    `update law_firms set settings = jsonb_build_object('billing',
       jsonb_build_object('timeRounding', jsonb_build_object('enabled', true, 'incrementMinutes', $2::int)))
     where id = $1`,
    [firm.id, incrementMinutes],
  );
  expect(res.rowCount).toBe(1);
}

const logTime = (hours: number) => owner.api.post(T()).send({
  clientId: client.id, userId: owner.uid, hours, date: '2026-03-10', hourlyRate: 300,
});

const stored = async (id: string) => (await testPool.query(
  'select hours::text as hours, amount_cents::text as amount_cents from activities where id = $1', [id],
)).rows[0];

const timeCount = async () => Number((await testPool.query(
  `select count(*)::int n from activities where kind = 'time' and law_firm_id = $1`, [firm.id],
)).rows[0].n);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Precision Client' });
  await drainEvents();
});

describe('rounded hours are stored at or above the increment', () => {
  /** Red before the fix: stores 0.08 and 2400 cents. */
  it('stores three minutes on a five-minute increment as 0.09h, billed $27', async () => {
    await setRounding(5);
    const res = await logTime(3 / 60);

    expect(res.status).toBe(201);
    expect(await stored(res.body.timeEntry.id)).toEqual({ hours: '0.09', amount_cents: '2700' });
  });

  /** Red before the fix: stores 0.33 and 9900 cents. */
  it('stores twenty minutes on a ten-minute increment as 0.34h', async () => {
    await setRounding(10);
    const res = await logTime(20 / 60);

    expect(res.status).toBe(201);
    expect(await stored(res.body.timeEntry.id)).toEqual({ hours: '0.34', amount_cents: '10200' });
  });

  /** Regression: an exact increment is unchanged. Red if the ceiling over-rounds 0.1. */
  it('stores five minutes on a six-minute increment as 0.10h', async () => {
    await setRounding(6);
    const res = await logTime(5 / 60);

    expect(res.status).toBe(201);
    expect(await stored(res.body.timeEntry.id)).toEqual({ hours: '0.10', amount_cents: '3000' });
  });

  /** The update path rounds the same way. Red if only create is fixed. */
  it('rounds an hours edit the same way', async () => {
    await setRounding(5);
    const created = await logTime(1);
    const id = created.body.timeEntry.id;

    const res = await owner.api.put(`${T()}/client/${client.id}/${id}`).send({ hours: 3 / 60 });

    expect(res.status).toBe(200);
    expect((await stored(id)).hours).toBe('0.09');
  });
});

describe('re-saving a rounded entry without touching its hours', () => {
  /**
   * The edit form reseeds from the stored hours as whole hours plus
   * round(stored * 60) minutes, and resends hours = h + m / 60 (see
   * `hoursToHm` and TimeEntryModal). Red if rounding up a second time ratchets
   * the stored value: an unrelated description edit would then raise the bill.
   */
  it.each([10, 20, 50, 70, 110])(
    'keeps %i minutes on a ten-minute increment unchanged when only the description is edited',
    async (minutes) => {
      await setRounding(10);
      const created = await logTime(minutes / 60);
      expect(created.status).toBe(201);
      const id = created.body.timeEntry.id;
      const first = await stored(id);

      const totalMinutes = Math.round(Number(first.hours) * 60);
      const resent = Math.floor(totalMinutes / 60) + (totalMinutes % 60) / 60;
      const res = await owner.api.put(`${T()}/client/${client.id}/${id}`)
        .send({ hours: resent, description: 'Only the description changed' });

      expect(res.status).toBe(200);
      expect(await stored(id)).toEqual(first);
      expect((await testPool.query('select description from activities where id = $1', [id])).rows[0].description)
        .toBe('Only the description changed');
    },
  );

  it('stores a 50-minute entry as 0.84h', async () => {
    await setRounding(10);
    const res = await logTime(50 / 60);

    expect(res.status).toBe(201);
    expect((await stored(res.body.timeEntry.id)).hours).toBe('0.84');
  });
});

describe('an entry too small to store', () => {
  /** Red before the fix: 201 with hours 0.00. */
  it('refuses 0.004 hours and writes nothing', async () => {
    const res = await logTime(0.004);

    expect(res.status).toBe(400);
    expect(await timeCount()).toBe(0);
  });

  /** Boundary: the smallest storable value is accepted as given. */
  it('accepts 0.01 hours', async () => {
    const res = await logTime(0.01);

    expect(res.status).toBe(201);
    expect((await stored(res.body.timeEntry.id)).hours).toBe('0.01');
  });

  /**
   * The note's "Add time" calls the service directly and never sees the route
   * schema. Red if the floor lives only in Zod.
   */
  it('refuses 0.004 hours on the service path the notes use', async () => {
    await expect(timeEntriesService.createTimeEntry({
      lawFirmId: firm.id,
      clientId: client.id,
      actingUserId: owner.uid,
      body: { userId: owner.uid, hours: 0.004, date: '2026-03-10', name: 'Note', description: '' },
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(await timeCount()).toBe(0);
  });
});

describe('the firm rounding increment setting', () => {
  const S = () => `/api/lawfirms/${firm.id}/settings/firm`;
  const rounding = async () => (await owner.api.get(`/api/lawfirms/${firm.id}/billing/settings`)).body.settings.timeRounding;

  /** Red before the fix: any integer 1-60 is accepted. */
  it.each([7, 45, 0])('refuses an increment of %s minutes and keeps the old setting', async (minutes) => {
    const res = await owner.api.put(S()).send({
      settings: { billing: { timeRounding: { enabled: true, incrementMinutes: minutes } } },
    });

    expect(res.status).toBe(400);
    expect(await rounding()).toEqual({ enabled: false, incrementMinutes: 6 });
  });

  /** The UI's ten-minute option stays valid. */
  it('accepts a ten-minute increment', async () => {
    const res = await owner.api.put(S()).send({
      settings: { billing: { timeRounding: { enabled: true, incrementMinutes: 10 } } },
    });

    expect(res.status).toBe(200);
    expect(await rounding()).toEqual({ enabled: true, incrementMinutes: 10 });
  });
});
