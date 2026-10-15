/**
 * An end sent as a minutes-only wall clock with an explicit offset.
 *
 * On the night a zone falls back, one wall-clock hour happens twice: in Los
 * Angeles on 2026-11-01, 01:00 to 01:59 runs once at -07:00 and again at
 * -08:00. A bare '2026-11-01T01:30' cannot say which, so the edit form sends
 * the offset it read the stored instant at, in the shape 'YYYY-MM-DDTHH:mmZ'
 * (minutes, no seconds). That shape is a valid ISO 8601 instant; the shared
 * end field refused it, so saving an end inside the repeated hour was a 400.
 *
 * The offset is what picks the instant, so each case below puts the end in
 * the SECOND 01:xx (-08:00) and the start in the first (-07:00). Read as a
 * wall clock without its offset, the end would land before the start.
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

const ZONE = 'America/Los_Angeles';
// 01:30 PDT, the first pass through 01:30: 08:30 UTC.
const FIRST_PASS_START = '2026-11-01T01:30-07:00';
// 01:15 PST, the second pass through 01:15: 09:15 UTC, 45 minutes after the start.
const SECOND_PASS_END = '2026-11-01T01:15-08:00';

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
  update: (id: string, body: Record<string, unknown>) => any;
  idOf: (body: any) => string;
  stored: (id: string) => Promise<{ start: Date; end: Date | null }>;
};

const eventRow = async (id: string) => {
  const { rows } = await testPool.query('select date, ends_at from events where id = $1', [id]);
  return { start: rows[0].date as Date, end: rows[0].ends_at as Date | null };
};

const parents: Parent[] = [
  {
    name: 'task',
    create: (body) => owner.api.post(`/api/lawfirms/${firm.id}/tasks`).set('x-timezone', ZONE)
      .send({ title: 'Prep session', allDay: false, dueDate: body.date, endsAt: body.endsAt }),
    update: (id, body) => owner.api.put(`/api/lawfirms/${firm.id}/tasks/${id}`).set('x-timezone', ZONE).send(body),
    idOf: (body) => body.taskId,
    stored: async (id) => {
      const { rows } = await testPool.query('select due_at, ends_at from tasks where id = $1', [id]);
      return { start: rows[0].due_at as Date, end: rows[0].ends_at as Date | null };
    },
  },
  {
    name: 'matter event',
    create: (body) => owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/events`).set('x-timezone', ZONE)
      .send({ type: 'hearing', title: 'Motion Hearing', allDay: false, ...body }),
    update: (id, body) => owner.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}/events/${id}`)
      .set('x-timezone', ZONE).send(body),
    idOf: (body) => body.eventId,
    stored: eventRow,
  },
  {
    name: 'client event',
    create: (body) => owner.api.post(`/api/lawfirms/${firm.id}/clients/${client.id}/events`).set('x-timezone', ZONE)
      .send({ type: 'meeting', title: 'Intake Call', allDay: false, ...body }),
    update: (id, body) => owner.api.put(`/api/lawfirms/${firm.id}/clients/${client.id}/events/${id}`)
      .set('x-timezone', ZONE).send({ source: 'client', ...body }),
    idOf: (body) => body.eventId,
    stored: eventRow,
  },
];

describe.each(parents)('a $name end inside the repeated fall-back hour', ({ create, update, idOf, stored }) => {
  it('saves a minutes-only offset end on create at the instant the offset names', async () => {
    const res = await create({ date: FIRST_PASS_START, endsAt: SECOND_PASS_END });

    expect(res.status).toBe(201);
    const row = await stored(idOf(res.body));
    expect(row.start.toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(row.end!.toISOString()).toBe('2026-11-01T09:15:00.000Z');
  });

  it('saves a minutes-only offset end on edit at the instant the offset names', async () => {
    const created = await create({ date: FIRST_PASS_START, endsAt: '2026-11-01T01:45-07:00' });
    expect(created.status).toBe(201);
    const id = idOf(created.body);
    expect((await stored(id)).end!.toISOString()).toBe('2026-11-01T08:45:00.000Z');

    const res = await update(id, { endsAt: SECOND_PASS_END });

    expect(res.status).toBe(200);
    expect((await stored(id)).end!.toISOString()).toBe('2026-11-01T09:15:00.000Z');
  });

  it('still refuses a minutes-only offset end with an impossible clock', async () => {
    const res = await create({ date: FIRST_PASS_START, endsAt: '2026-11-01T25:15-08:00' });

    expect(res.status).toBe(400);
  });
});
