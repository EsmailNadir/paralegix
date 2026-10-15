/**
 * Event DEPENDENCIES, and the cancel / postpone lifecycle.
 *
 * `matterEvents.test.ts` covers creating and reading an event, all-day
 * anchoring, and firm-wide versus per-matter scope. It does not touch the two
 * things here, and both are the kind of failure that ends in a missed court
 * date rather than a visibly broken screen:
 *
 *   A DEPENDENCY GRAPH THAT CANNOT CYCLE. Events depend on other events ("file
 *   the brief after the hearing is set"). `validateDependsOn` refuses a
 *   self-reference, a dependency on an event that does not exist, and any edge
 *   that would close a cycle. A cycle makes the graph unrenderable and any
 *   ordering derived from it meaningless.
 *
 *   CANCEL AND POSTPONE ARE NOT DELETES. A cancelled hearing has to stay in the
 *   record with a reason, and a postponed one has to keep its identity while its
 *   date moves, so the matter history still shows what happened.
 *
 * Driven through the routes. `assertMatterReadAccess` is what stands between a
 * firm member and a matter they are not on, and a service-level call skips it.
 */
import { randomUUID } from 'crypto';
import { gateMethod } from '../support/gate';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;
let otherFirm: Firm;
let otherOwner: Actor;

const E = (lawFirmId = firm.id, matter = matterId, suffix = '') =>
  `/api/lawfirms/${lawFirmId}/matters/${matter}/events${suffix}`;

async function seedMatter(lawFirmId: string, memberUid: string, name = 'Hollis v. Denton') {
  const id = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [lawFirmId, id, memberUid],
  );
  return id;
}

/** Create an event through the API and return its id. */
async function createEvent(actor: Actor, body: Record<string, unknown> = {}, matter = matterId) {
  const res = await actor.api.post(E(firm.id, matter)).send({
    type: 'hearing',
    title: 'Motion Hearing',
    date: '2026-05-10',
    allDay: true,
    ...body,
  });
  expect(res.status).toBe(201);
  return (res.body.event?.id ?? res.body.eventId) as string;
}

async function eventRow(id: string) {
  const { rows } = await testPool.query(
    'select id, title, status, date, depends_on from events where id = $1', [id],
  );
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Matter Events Firm' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid);

  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

it.each(['cancel', 'postpone'])('serializes overlapping %s requests after both read the original event', async (action) => {
  const eventId = await createEvent(owner);
  const repo = require('../../src/modules/matters/matterEvents.repository');
  const original = repo.findById;
  const boundary = { wait: async () => {} };
  const gate = gateMethod(boundary, 'wait');
  const snapshot = jest.spyOn(repo, 'findById').mockImplementation(async (...args: any[]) => {
    const row = await original.apply(repo, args);
    if (!args[3]) await boundary.wait();
    return row;
  });
  async function fire(newDate: string) {
    return owner.api.post(E(firm.id, matterId, `/${eventId}/${action}`)).send({ newDate, reason: 'Schedule changed' });
  }
  const first = fire('2026-06-01');
  const second = fire('2026-06-02');
  try {
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    gate.open();
    const responses = await Promise.all([first, second]);
    if (action === 'cancel') {
      expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
      expect((await eventRow(eventId)).status).toBe('cancelled');
    } else {
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const { rows } = await testPool.query('select date, postponement_count, postponement_history from events where id = $1', [eventId]);
      expect(rows[0].postponement_count).toBe(2);
      const history = rows[0].postponement_history;
      expect(history).toHaveLength(2);
      expect(history[0].previousDate).toBe('2026-05-10T12:00:00.000Z');
      expect(history[1].previousDate).toBe(history[0].newDate);
      expect(rows[0].date.toISOString()).toBe(history[1].newDate);
      expect(history.map((entry: any) => entry.newDate.slice(0, 10)).sort()).toEqual(['2026-06-01', '2026-06-02']);
    }
  } finally {
    gate.restore();
    await Promise.all([first, second]);
    snapshot.mockRestore();
  }
});

describe('depending on another event', () => {
  it.each(['create', 'update'])('rolls back event fields and assignees when attendee sync fails during %s', async (action) => {
    const contact = await owner.api.post(`/api/lawfirms/${firm.id}/contacts`).send({ name: 'Attendee' });
    expect(contact.status).toBe(201);
    const eventId = action === 'update' ? await createEvent(owner, { title: 'Original' }) : null;
    const repo = require('../../src/modules/matters/matterEvents.repository');
    const original = repo.syncContacts;
    let synced = false;
    const fault = jest.spyOn(repo, 'syncContacts').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      synced = true;
      throw new Error('Injected failure after attendee sync');
    });
    try {
      const body = { type: 'hearing', title: 'Changed', date: '2026-05-10', allDay: true, assignedTo: [owner.uid], contactIds: [contact.body.contactId] };
      const response = action === 'create'
        ? await owner.api.post(E()).send(body)
        : await owner.api.put(E(firm.id, matterId, `/${eventId}`)).send(body);
      expect(response.status).toBe(500);
      expect(synced).toBe(true);
      const { rows } = await testPool.query('select id, title from events where matter_id = $1', [matterId]);
      expect(rows).toEqual(action === 'create' ? [] : [{ id: eventId, title: 'Original' }]);
      for (const table of ['event_assignees', 'event_contacts']) {
        const { rows: junctions } = await testPool.query(`select event_id from ${table} where law_firm_id = $1`, [firm.id]);
        expect({ table, junctions }).toEqual({ table, junctions: [] });
      }
    } finally {
      fault.mockRestore();
    }
  });

  it('restores dependency references when deleting the target fails', async () => {
    const target = await createEvent(owner, { title: 'Target' });
    const dependent = await createEvent(owner, { title: 'Dependent', dependsOn: [target] });
    const repo = require('../../src/modules/matters/matterEvents.repository');
    const original = repo.delete;
    let deleted = false;
    const fault = jest.spyOn(repo, 'delete').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      deleted = true;
      throw new Error('Injected failure after event deletion');
    });
    try {
      const response = await owner.api.delete(E(firm.id, matterId, `/${target}`));
      expect(response.status).toBe(500);
      expect(deleted).toBe(true);
      expect(await eventRow(target)).not.toBeNull();
      expect((await eventRow(dependent)).depends_on).toEqual([target]);
    } finally {
      fault.mockRestore();
    }
  });

  it('stores the dependency and reports it on the graph', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });
    const brief = await createEvent(owner, {
      title: 'File the brief', date: '2026-05-20', dependsOn: [hearing],
    });

    const res = await owner.api.get(E(firm.id, matterId, '/graph'));

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.events.map((e: any) => [e.id, e]));
    // The graph read is a separate query from the event read, so an edge that
    // was stored correctly can still be missing from the picture the UI draws.
    expect(byId[brief].dependsOn).toEqual([hearing]);
    expect(byId[hearing].dependsOn).toEqual([]);
    expect(res.body.totalEvents).toBe(2);
  });

  it('refuses an event that depends on itself', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });

    const res = await owner.api.put(E(firm.id, matterId, `/${hearing}`))
      .send({ dependsOn: [hearing] });

    // The shortest possible cycle, and the one a click on the wrong row in a
    // picker produces.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot depend on itself/i);
    expect((await eventRow(hearing)).depends_on).toEqual([]);
  });

  it('refuses a two-event cycle', async () => {
    const first = await createEvent(owner, { title: 'First' });
    const second = await createEvent(owner, { title: 'Second', dependsOn: [first] });

    const res = await owner.api.put(E(firm.id, matterId, `/${first}`))
      .send({ dependsOn: [second] });

    // A self-reference check alone would let this through, and the resulting
    // graph has no valid ordering at all.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/circular/i);
    expect((await eventRow(first)).depends_on).toEqual([]);
  });

  it('refuses a three-event cycle', async () => {
    const a = await createEvent(owner, { title: 'A' });
    const b = await createEvent(owner, { title: 'B', dependsOn: [a] });
    const c = await createEvent(owner, { title: 'C', dependsOn: [b] });

    const res = await owner.api.put(E(firm.id, matterId, `/${a}`)).send({ dependsOn: [c] });

    // The guard walks the whole chain rather than checking one hop. A one-hop
    // check passes both cases above and fails only here.
    expect(res.status).toBe(400);
    expect((await eventRow(a)).depends_on).toEqual([]);
  });

  it('allows a diamond, which is not a cycle', async () => {
    const start = await createEvent(owner, { title: 'Start' });
    const left = await createEvent(owner, { title: 'Left', dependsOn: [start] });
    const right = await createEvent(owner, { title: 'Right', dependsOn: [start] });

    const res = await owner.api.post(E()).send({
      type: 'hearing', title: 'Join', date: '2026-06-01', allDay: true,
      dependsOn: [left, right],
    });

    // Two paths back to the same ancestor. A cycle check that marked a node
    // visited and refused to see it twice would reject this legitimate shape.
    expect(res.status).toBe(201);
  });

  it('refuses a dependency on an event that does not exist', async () => {
    const res = await owner.api.post(E()).send({
      type: 'hearing', title: 'Orphan', date: '2026-06-01', allDay: true,
      dependsOn: [randomUUID()],
    });

    // A dangling edge renders as a dependency on nothing, and the event silently
    // never becomes ready.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no longer exist/i);
  });

  it('refuses a dependency on an event belonging to another matter', async () => {
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Unrelated Matter');
    const foreign = await createEvent(owner, { title: 'Elsewhere' }, otherMatter);

    const res = await owner.api.post(E()).send({
      type: 'hearing', title: 'Cross-matter', date: '2026-06-01', allDay: true,
      dependsOn: [foreign],
    });

    // The dependency list is validated against THIS matter's events. A graph
    // spanning matters would show one matter's schedule blocked by another's,
    // which nobody looking at either matter could explain.
    expect(res.status).toBe(400);
  });
});

describe('server-owned fields cannot be widened from the body', () => {
  it('ignores an eventId in the update body and only touches the URL event', async () => {
    const keep = await createEvent(owner, { title: 'Keep Me' });
    const target = await createEvent(owner, { title: 'Original Title' });

    // The URL names the event being edited. An `eventId` surviving in the body
    // (the schema does not declare it, but `validate()`'s write-back merges
    // the parsed body over the raw one, so an undeclared key from the raw
    // body is still present afterwards) must not redirect the write to a
    // DIFFERENT event, even one on the same matter.
    const res = await owner.api.put(E(firm.id, matterId, `/${target}`))
      .send({ title: 'Hijacked', eventId: keep });

    expect(res.status).toBe(200);
    expect((await eventRow(target)).title).toBe('Hijacked');
    expect((await eventRow(keep)).title).toBe('Keep Me');
  });

  it('ignores a matterId/lawFirmId in the update body, even for a matter the caller can also see', async () => {
    // The A04 shape: the SAME person is a bystander member of a matter in a
    // completely different firm (no elevated role there), while holding
    // `matters.update` back in their own firm via the URL. If the body could
    // redirect the write, that firm-scoped permission grant would reach
    // across the tenant boundary into a firm where this person holds no
    // update permission at all.
    const victimMatter = await seedMatter(otherFirm.id, otherOwner.uid, 'Neighbour Matter');
    // Owner is ALSO a firm member of the other firm, but with NO permissions
    // there, and a bystander member of this one matter - exactly the access
    // assertMatterMembership grants, and nothing more.
    await memberWith(otherFirm.id, [], { uid: owner.uid });
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [otherFirm.id, victimMatter, owner.uid],
    );
    const victimEventRes = await otherOwner.api.post(E(otherFirm.id, victimMatter)).send({
      type: 'hearing', title: 'Neighbour Hearing', date: '2026-05-10', allDay: true,
    });
    expect(victimEventRes.status).toBe(201);
    const victimEvent = (victimEventRes.body.event?.id ?? victimEventRes.body.eventId) as string;
    const mine = await createEvent(owner, { title: 'My Hearing' });

    const res = await owner.api.put(E(firm.id, matterId, `/${mine}`))
      .send({ title: 'Hijacked', matterId: victimMatter, lawFirmId: otherFirm.id, eventId: victimEvent });

    expect(res.status).toBe(200);
    expect((await eventRow(mine)).title).toBe('Hijacked');
    expect((await eventRow(victimEvent)).title).toBe('Neighbour Hearing');
  });
});

describe('cancelling an event', () => {
  it('marks it cancelled and keeps it in the record', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });

    const res = await owner.api.post(E(firm.id, matterId, `/${hearing}/cancel`))
      .send({ reason: 'Judge unavailable' });

    expect(res.status).toBe(200);
    // Still there, with a status. A cancel implemented as a delete loses the
    // fact that a date existed at all, which is exactly what a matter history
    // needs to show.
    const row = await eventRow(hearing);
    expect(row).not.toBeNull();
    expect(row.status).toBe('cancelled');
  });

  it('still lists a cancelled event', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });
    await owner.api.post(E(firm.id, matterId, `/${hearing}/cancel`)).send({ reason: 'Adjourned' });

    const res = await owner.api.get(E());

    expect(res.body.events.map((e: any) => e.id)).toContain(hearing);
  });
});

describe('postponing an event', () => {
  it('moves the date and keeps the same event', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing', date: '2026-05-10' });

    const res = await owner.api.post(E(firm.id, matterId, `/${hearing}/postpone`))
      .send({ newDate: '2026-06-15', reason: 'Counsel unavailable' });

    expect(res.status).toBe(200);
    // The id is the assertion. A postpone that created a replacement event would
    // break every dependency pointing at the original.
    const row = await eventRow(hearing);
    expect(row.id).toBe(hearing);
    expect(new Date(row.date).toISOString()).toContain('2026-06-15');
  });

  /**
   * An event with an end keeps its length when it moves. Goes red if postpone
   * moves only the start: past the old end, the `events_ends_after_start`
   * check refuses the write and the request fails with a 500.
   */
  it('moves the end with the start, keeping the event\'s length', async () => {
    const hearing = await createEvent(owner, {
      title: 'Hearing', allDay: false, date: '2026-05-10T09:00', endsAt: '2026-05-10T11:30',
    });

    const res = await owner.api.post(E(firm.id, matterId, `/${hearing}/postpone`))
      .send({ newDate: '2026-06-15T09:00', reason: 'Counsel unavailable' });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select date, ends_at from events where id = $1', [hearing]);
    const length = rows[0].ends_at.getTime() - rows[0].date.getTime();
    expect(length).toBe(2.5 * 60 * 60 * 1000);
    expect(rows[0].date.toISOString()).toBe('2026-06-15T13:00:00.000Z');
  });

  it('keeps a dependency pointing at the postponed event', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });
    const brief = await createEvent(owner, {
      title: 'File the brief', date: '2026-05-20', dependsOn: [hearing],
    });

    await owner.api.post(E(firm.id, matterId, `/${hearing}/postpone`))
      .send({ newDate: '2026-06-15', reason: 'Counsel unavailable' });

    expect((await eventRow(brief)).depends_on).toEqual([hearing]);
  });
});

describe('a repeating event', () => {
  it('keeps selected assignees and attendees on every occurrence', async () => {
    const contact = await owner.api.post(`/api/lawfirms/${firm.id}/contacts`).send({ name: 'Series attendee' });
    expect(contact.status).toBe(201);
    const first = await createEvent(owner, {
      assignedTo: [owner.uid], contactIds: [contact.body.contactId],
      recurrence: { pattern: 'daily', interval: 1, endType: 'count', endCount: 3 },
    });
    const { rows } = await testPool.query(
      `select e.id, a.user_id, c.contact_id from events e
       left join event_assignees a on a.event_id = e.id
       left join event_contacts c on c.event_id = e.id
       where e.recurrence_group_id = (select recurrence_group_id from events where id = $1)`, [first],
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.user_id).toBe(owner.uid);
      expect(row.contact_id).toBe(contact.body.contactId);
    }
    const response = await owner.api.get(E());
    expect(response.status).toBe(200);
    const parent = response.body.events.find((event: any) => event.id === first);
    expect(parent.assignedTo).toEqual([owner.uid]);
    expect(parent.contacts.map((c: any) => c.contactId)).toEqual([contact.body.contactId]);
  });

  it('rolls back the entire series if a later occurrence attendee write fails', async () => {
    const contact = await owner.api.post(`/api/lawfirms/${firm.id}/contacts`).send({ name: 'Series attendee' });
    expect(contact.status).toBe(201);
    const repo = require('../../src/modules/matters/matterEvents.repository');
    const original = repo.syncContacts;
    let writes = 0;
    const fault = jest.spyOn(repo, 'syncContacts').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      if (++writes === 2) throw new Error('Injected failure after second occurrence attendee write');
    });
    try {
      const response = await owner.api.post(E()).send({
        type: 'hearing', title: 'Series', date: '2026-05-10', allDay: true,
        assignedTo: [owner.uid], contactIds: [contact.body.contactId],
        recurrence: { pattern: 'daily', interval: 1, endType: 'count', endCount: 3 },
      });
      expect(response.status).toBe(500);
      expect(writes).toBe(2);
      for (const table of ['events', 'event_assignees', 'event_contacts']) {
        const { rows } = await testPool.query(`select law_firm_id from ${table} where law_firm_id = $1`, [firm.id]);
        expect({ table, rows }).toEqual({ table, rows: [] });
      }
    } finally {
      fault.mockRestore();
    }
  });

  it('removes dependencies on a deleted recurrence group while keeping other dependencies', async () => {
    const first = await createEvent(owner, { recurrence: { pattern: 'daily', interval: 1, endType: 'count', endCount: 3 } });
    const { rows: group } = await testPool.query('select recurrence_group_id from events where id = $1', [first]);
    const retained = await createEvent(owner, { title: 'Retained' });
    const dependent = await createEvent(owner, { title: 'Dependent', dependsOn: [first, retained] });
    const response = await owner.api.delete(E(firm.id, matterId, `/recurrence/${group[0].recurrence_group_id}`));
    expect(response.status).toBe(200);
    const { rows } = await testPool.query('select id from events where recurrence_group_id = $1', [group[0].recurrence_group_id]);
    expect(rows).toEqual([]);
    expect((await eventRow(dependent)).depends_on).toEqual([retained]);
  });

  it('restores a recurrence group and its dependents if deleting the group fails', async () => {
    const first = await createEvent(owner, { recurrence: { pattern: 'daily', interval: 1, endType: 'count', endCount: 3 } });
    const { rows: group } = await testPool.query('select id, recurrence_group_id from events where matter_id = $1 order by id', [matterId]);
    const dependent = await createEvent(owner, { title: 'Dependent', dependsOn: [first] });
    const repo = require('../../src/modules/matters/matterEvents.repository');
    const original = repo.deleteByRecurrenceGroup;
    let deleted = false;
    const fault = jest.spyOn(repo, 'deleteByRecurrenceGroup').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      deleted = true;
      throw new Error('Injected failure after recurrence group deletion');
    });
    try {
      const response = await owner.api.delete(E(firm.id, matterId, `/recurrence/${group[0].recurrence_group_id}`));
      expect(response.status).toBe(500);
      expect(deleted).toBe(true);
      const { rows } = await testPool.query('select id, recurrence_group_id from events where recurrence_group_id = $1 order by id', [group[0].recurrence_group_id]);
      expect(rows).toEqual(group);
      expect((await eventRow(dependent)).depends_on).toEqual([first]);
    } finally {
      fault.mockRestore();
    }
  });

  const occurrences = async (groupOf: string) => (await testPool.query(
    `select date, ends_at from events
      where recurrence_group_id = (select recurrence_group_id from events where id = $1)
      order by recurrence_index`, [groupOf],
  )).rows;

  /**
   * Goes red if only the first occurrence keeps the event's end: every later
   * one had none, and went to Google and Outlook as the one-hour default.
   */
  it('gives every occurrence the same length as the first', async () => {
    const first = await createEvent(owner, {
      title: 'Standup', allDay: false, date: '2026-06-08T09:00', endsAt: '2026-06-08T09:30',
      recurrence: { pattern: 'daily', interval: 1, endType: 'count', endCount: 3 },
    });

    const rows = await occurrences(first);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.ends_at).not.toBeNull();
      expect(row.ends_at.getTime() - row.date.getTime()).toBe(30 * 60 * 1000);
    }
  });

  /**
   * The last day is a day in the event's zone. Goes red if it ends at 23:59
   * UTC: an evening occurrence in the Americas on the last day falls after
   * that and is dropped. (The agent's zone is New York; 8:30pm there is 00:30
   * UTC the next day, so each occurrence below lands on the next UTC day.)
   */
  it('keeps an evening occurrence on the last day', async () => {
    const first = await createEvent(owner, {
      title: 'Evening call', allDay: false, date: '2026-06-08T20:30',
      recurrence: { pattern: 'daily', interval: 1, endType: 'date', endDate: '2026-06-10' },
    });

    const rows = await occurrences(first);
    expect(rows.map((r) => r.date.toISOString())).toEqual([
      '2026-06-09T00:30:00.000Z',
      '2026-06-10T00:30:00.000Z',
      '2026-06-11T00:30:00.000Z',
    ]);
  });
});

describe('who may reach a matter events', () => {
  it('refuses a firm member who is not on the matter', async () => {
    await createEvent(owner, { title: 'Hearing' });
    const outsider = await memberWith(firm.id, ['matters.view']);

    const res = await outsider.api.get(E());

    // Matter membership, not a firm permission. `matters.view` is baseline, so
    // without the matter check every member would read every matter's calendar.
    expect(res.status).toBe(403);
  });

  it('refuses a member of another firm, and writes nothing', async () => {
    const res = await otherOwner.api.post(E()).send({
      type: 'hearing', title: 'Intruder', date: '2026-06-01', allDay: true,
    });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select 1 from events where matter_id = $1', [matterId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does not delete an event through another firm path', async () => {
    const hearing = await createEvent(owner, { title: 'Hearing' });
    const theirMatter = await seedMatter(otherFirm.id, otherOwner.uid, 'Their Matter');

    const res = await otherOwner.api.delete(
      `/api/lawfirms/${otherFirm.id}/matters/${theirMatter}/events/${hearing}`,
    );

    // The event id is real; only the firm and matter in the path are wrong. A
    // delete keyed on the event id alone would destroy another firm's court date.
    expect(res.status).toBe(404);
    expect(await eventRow(hearing)).not.toBeNull();
  });
});
