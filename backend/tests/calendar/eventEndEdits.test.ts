/**
 * What an edit does to an event's end when the caller does not send one.
 *
 * Matter and client events both carry an optional `ends_at`, and both update
 * routes accept a partial body. A caller that moves only the start (the
 * calendar's quick edit sends no end at all) used to leave the stored end where
 * it was. Moved later than the old end, the edit failed with "The event end
 * must be after its start"; moved earlier, the event silently grew. Postpone
 * already shifted the end by the same amount, so a plain edit now does too.
 *
 * Flipping all-day changes what the stored end means: an all-day end is the
 * exclusive day after the last day, anchored at noon UTC, and a timed end is
 * an instant. Neither reads correctly as the other, so a flip that sends no end
 * of its own drops the old one.
 *
 * Reads return `endsAtLocalInput` beside `dateLocalInput`, in the caller's
 * zone, so an edit form can prefill the end the same way it prefills the start.
 */

import {
  testPool,
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
let matterId: string;

const matterEvents = (suffix = '') => `/api/lawfirms/${firm.id}/matters/${matterId}/events${suffix}`;
const clientEvents = (suffix = '') => `/api/lawfirms/${firm.id}/clients/${client.id}/events${suffix}`;

const endsAtOf = async (id: string) => {
  const { rows } = await testPool.query('select date, ends_at from events where id = $1', [id]);
  return rows[0] as { date: Date; ends_at: Date | null };
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter', clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
});

type Parent = {
  name: string;
  create: (body: Record<string, unknown>) => any;
  update: (id: string, body: Record<string, unknown>, timezone?: string) => any;
};

const parents: Parent[] = [
  {
    name: 'matter event',
    create: (body) => owner.api.post(matterEvents()).set('x-timezone', 'America/New_York')
      .send({ type: 'hearing', title: 'Motion Hearing', ...body }),
    update: (id, body, timezone = 'America/New_York') => owner.api.put(matterEvents(`/${id}`)).set('x-timezone', timezone).send(body),
  },
  {
    name: 'client event',
    create: (body) => owner.api.post(clientEvents()).set('x-timezone', 'America/New_York')
      .send({ type: 'meeting', title: 'Intake Call', ...body }),
    update: (id, body, timezone = 'America/New_York') => owner.api.put(clientEvents(`/${id}`)).set('x-timezone', timezone)
      .send({ source: 'client', ...body }),
  },
];

describe.each(parents)('editing a $name with an end', ({ create, update }) => {
  it('keeps the visible day of a legacy all-day event when becoming timed', async () => {
    const created = await create({ allDay: true, date: '2026-05-10', endsAt: '2026-05-13' });
    expect(created.status).toBe(201);
    const id = created.body.eventId;
    const legacy = await testPool.query("update events set date = '2026-05-09T22:00:00Z' where id = $1", [id]);
    expect(legacy.rowCount).toBe(1);
    const res = await update(id, { allDay: false }, 'Europe/Paris');
    expect(res.status).toBe(200);
    expect((await endsAtOf(id)).date.toISOString()).toBe('2026-05-10T10:00:00.000Z');
  });
  it('keeps the caller calendar day when only all-day is toggled on', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T23:30', endsAt: '2026-05-11T01:30' });
    expect(created.status).toBe(201);
    const id = created.body.eventId;
    const res = await update(id, { allDay: true });
    expect(res.status).toBe(200);
    const row = await endsAtOf(id);
    expect(row.date.toISOString()).toBe('2026-05-10T12:00:00.000Z');
    expect(row.ends_at).toBeNull();
  });
  it.each(['not-a-date', '2026-05-10T25:99', '2026-05-10junk', ''])('rejects invalid end %j without changing its span', async (endsAt) => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    expect(created.status).toBe(201);
    const id = created.body.eventId;
    const res = await update(id, { endsAt });
    expect(res.status).toBe(400);
    expect((await endsAtOf(id)).ends_at!.toISOString()).toBe('2026-05-10T19:30:00.000Z');
  });
  it('keeps its length when the start moves past the old end', async () => {
    // 1:00 to 3:30 PM on the 10th, moved to 1:00 PM on the 12th.
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    expect(created.status).toBe(201);
    const id = created.body.eventId;

    const res = await update(id, { date: '2026-05-12T13:00' });

    expect(res.status).toBe(200);
    const row = await endsAtOf(id);
    // 3:30 PM EDT on the 12th: the end moved with the start, two days on.
    expect(new Date(row.ends_at!).toISOString()).toBe('2026-05-12T19:30:00.000Z');
  });

  it('keeps its length when the start moves earlier', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    const id = created.body.eventId;

    const res = await update(id, { date: '2026-05-10T09:00' });

    expect(res.status).toBe(200);
    const row = await endsAtOf(id);
    // Two and a half hours from 9:00 AM, not stretched to the old 3:30 PM.
    expect(new Date(row.ends_at!).getTime() - new Date(row.date).getTime()).toBe(2.5 * 60 * 60 * 1000);
  });

  it('uses the end the caller sends over the shifted one', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    const id = created.body.eventId;

    const res = await update(id, { date: '2026-05-12T13:00', endsAt: '2026-05-12T14:00' });

    expect(res.status).toBe(200);
    expect(new Date((await endsAtOf(id)).ends_at!).toISOString()).toBe('2026-05-12T18:00:00.000Z');
  });

  it('clears the end when the caller sends null', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    const id = created.body.eventId;

    const res = await update(id, { date: '2026-05-12T13:00', endsAt: null });

    expect(res.status).toBe(200);
    expect((await endsAtOf(id)).ends_at).toBeNull();
  });

  it('drops a timed end when the event becomes all-day without an end of its own', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });
    const id = created.body.eventId;
    expect((await endsAtOf(id)).ends_at).not.toBeNull();

    const res = await update(id, { allDay: true, date: '2026-05-10' });

    expect(res.status).toBe(200);
    expect((await endsAtOf(id)).ends_at).toBeNull();
  });

  it('keeps a multi-day all-day span when only its first day moves', async () => {
    // The 10th through the 12th: the stored end is the exclusive 13th.
    const created = await create({ allDay: true, date: '2026-05-10', endsAt: '2026-05-13' });
    expect(created.status).toBe(201);
    const id = created.body.eventId;

    const res = await update(id, { date: '2026-05-20' });

    expect(res.status).toBe(200);
    expect(new Date((await endsAtOf(id)).ends_at!).toISOString()).toBe('2026-05-23T12:00:00.000Z');
  });

  it('returns the end as a local form value beside the start', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00', endsAt: '2026-05-10T15:30' });

    expect(created.body.event.endsAtLocalInput).toBe('2026-05-10T15:30');
  });

  it('returns no end form value for an event without an end', async () => {
    const created = await create({ allDay: false, date: '2026-05-10T13:00' });

    expect(created.status).toBe(201);
    expect(created.body.event.endsAtLocalInput).toBeNull();
  });
});
