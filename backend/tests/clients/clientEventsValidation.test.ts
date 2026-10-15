/**
 * Client event creation: calendar-date validity.
 *
 * `createClientEventSchema`'s `date` field had no format or calendar-validity
 * check at all before this - `date: z.string().min(1, 'Date is required')`.
 * An impossible date like "2026-02-30" reached `toTimestampOrNull` unchecked,
 * which used to silently roll it into March. No route-level test anywhere in
 * the suite exercised client-event creation at all.
 */

import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const eventsPath = () => `/api/lawfirms/${firm.id}/clients/${client.id}/events`;

const createEvent = (body: Record<string, unknown> = {}) =>
  owner.api.post(eventsPath()).send({
    type: 'meeting',
    title: 'Intake Call',
    date: '2026-05-10',
    allDay: true,
    ...body,
  });

const eventCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from events where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
};

const eventRow = async (id: string) => {
  const { rows } = await testPool.query('select date from events where id = $1', [id]);
  return rows[0];
};

const linkedFileCount = async (eventId: string) => {
  const { rows } = await testPool.query(
    `select jsonb_array_length(coalesce(linked_files, '[]'::jsonb)) as n
       from events where id = $1`,
    [eventId],
  );
  return Number(rows[0].n);
};

const assignedMemberCount = async (eventId: string) => {
  const { rows } = await testPool.query(
    `select (select count(*)::int from event_assignees ea where ea.event_id = events.id) as n
       from events where id = $1`,
    [eventId],
  );
  return Number(rows[0].n);
};

const seedContacts = async (count: number) => {
  const { rows } = await testPool.query(
    `insert into contacts (id, law_firm_id, name, category, contact_type)
     select gen_random_uuid(), $1, 'Event contact ' || value, 'other', 'person'
       from generate_series(1, $2) as value
     returning id`,
    [firm.id, count],
  );
  return rows.map((row) => row.id as string);
};

const eventContactCount = async (eventId: string) => {
  const { rows } = await testPool.query(
    `select count(*)::int n from event_contacts
      where law_firm_id = $1 and event_id = $2`,
    [firm.id, eventId],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });
});

describe('creating a client event', () => {
  it('creates one with a real date', async () => {
    const res = await createEvent();
    expect(res.status).toBe(201);
    expect(await eventCount()).toBe(1);
  });

  const overFiles = (label: string) => Array.from({ length: 21 }, (_, index) => ({
    fileId: randomUUID(),
    name: `${label} ${index + 1}.pdf`,
    size: 100,
    contentType: 'application/pdf',
    scope: 'client',
    scopeId: client.id,
  }));
  const overMembers = () => Array.from({ length: 51 }, (_, index) => `member-${index + 1}`);

  /**
   * One array cap per row: the body that holds one item too many, the body a
   * valid event starts with, and how many of that item the event stores.
   */
  const CAPS: [string, () => Promise<{ over: Record<string, unknown>; initial: Record<string, unknown> }>,
    (eventId: string) => Promise<number>, number][] = [
    ['twenty linked files', async () => ({ over: { linkedFiles: overFiles('Attachment') }, initial: {} }),
      linkedFileCount, 0],
    ['fifty assigned members', async () => ({ over: { assignedTo: overMembers() }, initial: {} }),
      assignedMemberCount, 0],
    ['fifty directory contacts', async () => {
      const contactIds = await seedContacts(51);
      return { over: { contactIds }, initial: { contactIds: [contactIds[0]] } };
    }, eventContactCount, 1],
  ];

  it.each(CAPS)('refuses more than %s before creating a client event', async (_label, build) => {
    const { over } = await build();

    const res = await createEvent(over);

    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it.each(CAPS)('refuses more than %s before replacing that set on a client event', async (_label, build, countOf, initialCount) => {
    const { over, initial } = await build();
    const created = await createEvent(initial);
    expect(created.status).toBe(201);
    expect(await countOf(created.body.eventId)).toBe(initialCount);

    const res = await owner.api.put(`${eventsPath()}/${created.body.eventId}`).send({
      source: 'client',
      ...over,
    });

    expect(res.status).toBe(400);
    expect(await countOf(created.body.eventId)).toBe(initialCount);
  });

  it('refuses an impossible calendar date instead of silently rolling it into the next month', async () => {
    const res = await createEvent({ date: '2026-02-30' });

    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('refuses a day past the end of a 30-day month', async () => {
    const res = await createEvent({ date: '2026-04-31' });

    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('still accepts the real last day of a 30-day month and a leap day', async () => {
    const a = await createEvent({ date: '2026-04-30' });
    const b = await createEvent({ date: '2028-02-29' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await eventCount()).toBe(2);
  });

  it('anchors an all-day event at noon UTC even when the client sends local midnight, not a bare date', async () => {
    // Same bug and same fix as matterEvents.test.ts's identical case: the
    // all-day toggle sends 'YYYY-MM-DDTHH:mm' (local midnight), not a bare
    // date, and that shape used to resolve through the full zoned-datetime
    // path instead of the noon-UTC day-only anchor - landing on the PREVIOUS
    // calendar day for any caller ahead of UTC. Paris is UTC+2 in September.
    const parisOwner = { uid: owner.uid, api: as(tokenFor({ uid: owner.uid }), 'Europe/Paris') };

    const res = await parisOwner.api.post(eventsPath()).send({
      type: 'meeting', title: 'Rentrée Meeting', date: '2026-09-01T00:00', allDay: true,
    });

    expect(res.status).toBe(201);
    const stored = await eventRow(res.body.eventId);
    expect(stored.date.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });
});

export {};
