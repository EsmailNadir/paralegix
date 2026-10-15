/**
 * Who a client event may be assigned to, and what the client tab passes on when
 * the event it writes is really a matter event.
 *
 * Assignees are `event_assignees` rows whose only foreign key is `users(id)`,
 * so nothing in the schema stops a write naming another firm's member or a
 * portal client. The read joins `users` for the display name, so an unchecked
 * assignee would also hand that outsider's name back to this firm.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  createFirmMember,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const eventsPath = (suffix = '') => `/api/lawfirms/${firm.id}/clients/${client.id}/events${suffix}`;

const createEvent = (body: Record<string, unknown> = {}) =>
  owner.api.post(eventsPath()).send({
    type: 'meeting',
    title: 'Intake Call',
    date: '2026-05-10T15:00:00',
    ...body,
  });

const eventCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from events where law_firm_id = $1', [firm.id],
  );
  return rows[0].n as number;
};

const assigneesOf = async (eventId: string) => {
  const { rows } = await testPool.query(
    'select user_id from event_assignees where event_id = $1 order by user_id', [eventId],
  );
  return rows.map((row) => row.user_id as string);
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });
});

describe('standalone client event assignees must be members of this firm', () => {
  const outsiders: [string, () => Promise<{ uid: string; name: string }>][] = [
    ['a member of another firm', async () => {
      const otherFirm = await createFirm();
      const name = `Other Firm Lawyer ${randomUUID().slice(0, 6)}`;
      const { uid } = await createFirmMember(otherFirm.id, { isOwner: false, name });
      return { uid, name };
    }],
    ['a portal client', async () => {
      const name = `Portal Person ${randomUUID().slice(0, 6)}`;
      const { uid } = await createPortalUser({ name });
      return { uid, name };
    }],
  ];

  it.each(outsiders)('refuses creating an event assigned to %s, writing nothing', async (_label, build) => {
    const outsider = await build();

    const res = await createEvent({ assignedTo: [outsider.uid] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(outsider.name);
    expect(JSON.stringify(res.body)).not.toContain(`${outsider.uid}@example.test`);
    expect(await eventCount()).toBe(0);
  });

  it.each(outsiders)('refuses reassigning an event to %s, keeping the old assignees', async (_label, build) => {
    const colleague = await memberWith(firm.id, ['clients.view']);
    const created = await createEvent({ assignedTo: [colleague.uid] });
    expect(created.status).toBe(201);
    expect(await assigneesOf(created.body.eventId)).toEqual([colleague.uid]);
    const outsider = await build();

    const res = await owner.api.put(eventsPath(`/${created.body.eventId}`))
      .send({ source: 'client', assignedTo: [outsider.uid] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(outsider.name);
    expect(await assigneesOf(created.body.eventId)).toEqual([colleague.uid]);
  });

  it('accepts a member of this firm and reads their name back', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, name: 'Casey Colleague' });

    const res = await createEvent({ assignedTo: [colleague.uid] });

    expect(res.status).toBe(201);
    expect(res.body.event.assignedTo).toEqual([colleague.uid]);
    expect(res.body.event.assignedToName).toEqual(['Casey Colleague']);
  });
});

describe('a client-tab event on a matter carries every field the client route accepts', () => {
  let matterId: string;
  let matterMember: string;

  beforeEach(async () => {
    matterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id)
       values ($1, $2, 'Client tab matter', $3)`,
      [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
    );
    matterMember = (await memberWith(firm.id, ['matters.view'])).uid;
    for (const uid of [owner.uid, matterMember]) {
      await testPool.query(
        'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
        [firm.id, matterId, uid],
      );
    }
  });

  const storedEvent = async (eventId: string) => {
    const { rows } = await testPool.query(
      'select matter_id, client_id, date, ends_at from events where id = $1', [eventId],
    );
    return rows[0];
  };

  it('stores endsAt and assignedTo on create', async () => {
    const res = await createEvent({
      matterId,
      endsAt: '2026-05-10T16:30:00',
      assignedTo: [matterMember],
    });

    expect(res.status).toBe(201);
    const row = await storedEvent(res.body.eventId);
    expect(row.matter_id).toBe(matterId);
    // Both instants resolve in the same zone, so the span is what was sent.
    expect(row.ends_at).not.toBeNull();
    expect(new Date(row.ends_at).getTime() - new Date(row.date).getTime()).toBe(90 * 60 * 1000);
    expect(await assigneesOf(res.body.eventId)).toEqual([matterMember]);
  });

  it('changes endsAt and assignedTo on update', async () => {
    const created = await createEvent({ matterId, endsAt: '2026-05-10T16:00:00' });
    expect(created.status).toBe(201);
    expect(await assigneesOf(created.body.eventId)).toEqual([]);

    const res = await owner.api.put(eventsPath(`/${created.body.eventId}`)).send({
      source: 'matter',
      matterId,
      endsAt: '2026-05-10T17:45:00',
      assignedTo: [matterMember],
    });

    expect(res.status).toBe(200);
    const row = await storedEvent(created.body.eventId);
    expect(row.ends_at).not.toBeNull();
    expect(new Date(row.ends_at).getTime() - new Date(row.date).getTime()).toBe(165 * 60 * 1000);
    expect(await assigneesOf(created.body.eventId)).toEqual([matterMember]);
  });

  it('applies the matter service assignee check: a firm member off the matter is refused', async () => {
    const offMatter = await memberWith(firm.id, ['matters.view']);

    const res = await createEvent({ matterId, assignedTo: [offMatter.uid] });

    expect(res.status).toBe(403);
    expect(await eventCount()).toBe(0);
  });
});
