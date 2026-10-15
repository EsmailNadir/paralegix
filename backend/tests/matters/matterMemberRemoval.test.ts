/**
 * Taking a member off a matter takes their work off it too.
 *
 * `matter_members` is the ethical wall, and a task's assignees, a task's
 * reminder recipients and an event's assignees are all required to be members
 * of the matter they sit on. The firm-level removal handler already prunes all
 * three; the per-matter removal route deleted only the membership row. The
 * leftovers kept emailing the ex-member task reminders for a matter they were
 * walled off from, and tripped a 400 naming them on every later edit of the
 * task, because the update re-validates every assignee and recipient.
 *
 * The route now takes an optional `reassignTo`, and a preview endpoint reports
 * what the removal would touch so the UI can offer the choice. Each case goes
 * red if the matter path stops calling the shared prune, if the prune loses its
 * matter scope (the same user's work on ANOTHER matter must survive), or if the
 * reassignment target is not validated before anything is removed.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  createFirmMember,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let leaving: string;   // the member being removed
let staying: string;   // another member of the matter
let target: string;    // a third member, the reassignment candidate
let outsider: string;  // a firm member who is not on the matter
let matter: string;
let otherMatter: string;

const URL = (m: string, tail: string) => `/api/lawfirms/${firm.id}/matters/${m}/members/${tail}`;

async function seedTask(matterId: string, title: string, opts: {
  status?: string; assignees?: string[]; reminders?: string[];
}): Promise<string> {
  const { rows } = await testPool.query(
    `insert into tasks (law_firm_id, matter_id, title, status, reminder_recipient_ids)
     values ($1, $2, $3, $4, $5) returning id`,
    [firm.id, matterId, title, opts.status ?? 'open', opts.reminders ?? []],
  );
  for (const uid of opts.assignees ?? []) {
    await testPool.query(
      'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
      [firm.id, rows[0].id, uid],
    );
  }
  return rows[0].id;
}

async function seedEvent(matterId: string, title: string, when: 'future' | 'past', assignees: string[]) {
  const { rows } = await testPool.query(
    `insert into events (law_firm_id, matter_id, title, status, date)
     values ($1, $2, $3, 'upcoming', now() + ($4 || ' days')::interval) returning id`,
    [firm.id, matterId, title, when === 'future' ? '10' : '-10'],
  );
  for (const uid of assignees) {
    await testPool.query(
      'insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)',
      [firm.id, rows[0].id, uid],
    );
  }
  return rows[0].id as string;
}

const assigneesOf = async (taskId: string) => (await testPool.query(
  'select user_id from task_assignees where task_id = $1 order by user_id', [taskId],
)).rows.map((r: any) => r.user_id);
const recipientsOf = async (taskId: string) => (await testPool.query(
  'select reminder_recipient_ids r from tasks where id = $1', [taskId],
)).rows[0].r as string[];
const eventAssigneesOf = async (eventId: string) => (await testPool.query(
  'select user_id from event_assignees where event_id = $1 order by user_id', [eventId],
)).rows.map((r: any) => r.user_id);
const isMember = async (m: string, uid: string) => (await testPool.query(
  'select 1 from matter_members where matter_id = $1 and user_id = $2', [m, uid],
)).rowCount === 1;

let t1: string; let t2: string; let t3: string; let t4: string;
let e1: string; let e2: string; let e3: string; let e4: string;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  leaving = (await createFirmMember(firm.id, { isOwner: false, permissions: ['tasks.view', 'tasks.update'] })).uid;
  staying = (await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid;
  target = (await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid;
  outsider = (await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid;
  matter = await seedMatter(firm.id, { name: 'Wall', memberUids: [owner.uid, leaving, staying, target] });
  otherMatter = await seedMatter(firm.id, { name: 'Elsewhere', memberUids: [owner.uid, leaving, staying] });

  t1 = await seedTask(matter, 'open, assigned and reminded', { assignees: [leaving], reminders: [leaving, staying] });
  t2 = await seedTask(matter, 'open, shared with target', { assignees: [leaving, target] });
  t3 = await seedTask(matter, 'completed', { status: 'completed', assignees: [leaving] });
  t4 = await seedTask(otherMatter, 'other matter', { assignees: [leaving], reminders: [leaving] });
  e1 = await seedEvent(matter, 'future hearing', 'future', [leaving]);
  e2 = await seedEvent(matter, 'past hearing', 'past', [leaving]);
  e3 = await seedEvent(matter, 'not theirs', 'future', [staying]);
  e4 = await seedEvent(otherMatter, 'other matter hearing', 'future', [leaving]);
});

describe('previewing a removal', () => {
  it('counts exactly the open work on THIS matter that is assigned to each user', async () => {
    const res = await owner.api.post(URL(matter, 'remove/preview'))
      .send({ targetUserIds: [leaving, staying] });

    expect(res.status).toBe(200);
    expect(res.body.members).toEqual(expect.arrayContaining([
      // t1 and t2 are open and assigned; t3 is completed; t4 is on another matter.
      // e1 is upcoming; e2 is in the past; e4 is on another matter.
      { userId: leaving, openTasks: 2, upcomingEvents: 1, reminderSlots: 1 },
      // `staying` is only a reminder recipient on t1 and an assignee of e3.
      { userId: staying, openTasks: 0, upcomingEvents: 1, reminderSlots: 1 },
    ]));
    expect(res.body.members).toHaveLength(2);
  });

  it('writes nothing', async () => {
    const res = await owner.api.post(URL(matter, 'remove/preview')).send({ targetUserIds: [leaving] });

    expect(res.status).toBe(200);
    expect(await isMember(matter, leaving)).toBe(true);
    expect(await assigneesOf(t1)).toEqual([leaving]);
  });

  it('is refused for a caller without the member-management permission and for a non-member of the matter', async () => {
    const noPermission = await memberWith(firm.id, ['matters.view']);
    expect((await noPermission.api.post(URL(matter, 'remove/preview'))
      .send({ targetUserIds: [leaving] })).status).toBe(403);

    const manager = await memberWith(firm.id, ['matters.manageMembers']);
    expect((await manager.api.post(URL(matter, 'remove/preview'))
      .send({ targetUserIds: [leaving] })).status).toBe(403);
  });

  it('does not answer for a matter of another firm', async () => {
    const other = await createFirm();
    const stranger = await ownerOf(other.id);

    const res = await stranger.api.post(`/api/lawfirms/${other.id}/matters/${matter}/members/remove/preview`)
      .send({ targetUserIds: [leaving] });

    expect(res.status).toBe(404);
  });
});

describe('removing a member without reassigning', () => {
  it('unassigns them from this matter work and keeps their work on other matters', async () => {
    const res = await owner.api.post(URL(matter, 'remove')).send({ targetUserIds: [leaving] });

    expect(res.status).toBe(200);
    expect(await isMember(matter, leaving)).toBe(false);
    expect(await assigneesOf(t1)).toEqual([]);
    expect(await assigneesOf(t2)).toEqual([target]);
    expect(await assigneesOf(t3)).toEqual([]);
    expect(await recipientsOf(t1)).toEqual([staying]);
    expect(await eventAssigneesOf(e1)).toEqual([]);
    expect(await eventAssigneesOf(e2)).toEqual([]);
    expect(await eventAssigneesOf(e3)).toEqual([staying]);
    // The same person still works on the other matter, so nothing there changes.
    expect(await isMember(otherMatter, leaving)).toBe(true);
    expect(await assigneesOf(t4)).toEqual([leaving]);
    expect(await recipientsOf(t4)).toEqual([leaving]);
    expect(await eventAssigneesOf(e4)).toEqual([leaving]);
  });

  it('leaves the task editable by someone else afterwards', async () => {
    await owner.api.post(URL(matter, 'remove')).send({ targetUserIds: [leaving] });

    // Every task edit re-validates the assignees and reminder recipients against
    // the matter's members, so a leftover ex-member made this a 400 naming them.
    const res = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${t1}`).send({ status: 'in_progress' });

    expect(res.status).toBe(200);
  });
});

describe('removing a member with reassignTo', () => {
  it('moves their assignments to the target without duplicating one the target already holds', async () => {
    const res = await owner.api.post(URL(matter, 'remove'))
      .send({ targetUserIds: [leaving], reassignTo: target });

    expect(res.status).toBe(200);
    expect(await isMember(matter, leaving)).toBe(false);
    expect(await assigneesOf(t1)).toEqual([target]);
    // The target was already on t2: still exactly one row for them.
    expect(await assigneesOf(t2)).toEqual([target]);
    expect(await assigneesOf(t3)).toEqual([target]);
    expect(await eventAssigneesOf(e1)).toEqual([target]);
    expect(await eventAssigneesOf(e2)).toEqual([target]);
    // Reminder slots are never moved, only pruned.
    expect(await recipientsOf(t1)).toEqual([staying]);
    // Other matter untouched.
    expect(await assigneesOf(t4)).toEqual([leaving]);
    expect(await eventAssigneesOf(e4)).toEqual([leaving]);
  });

  it.each([
    ['a firm member who is not on the matter', () => outsider],
    ['one of the users being removed', () => leaving],
    ['a user id that is not a member of the firm', () => 'nobody-at-all'],
  ])('refuses a target that is %s, and removes nobody', async (_label, targetOf) => {
    const res = await owner.api.post(URL(matter, 'remove'))
      .send({ targetUserIds: [leaving], reassignTo: targetOf() });

    expect(res.status).toBe(400);
    expect(await isMember(matter, leaving)).toBe(true);
    expect(await assigneesOf(t1)).toEqual([leaving]);
    expect(await eventAssigneesOf(e1)).toEqual([leaving]);
  });
});

describe('validating reassignTo against the whole request', () => {
  const memberIds = async (m: string) => (await testPool.query(
    'select user_id from matter_members where matter_id = $1 order by user_id', [m],
  )).rows.map((r: any) => r.user_id as string);
  const everyAssignment = async () => ({
    members: await memberIds(matter),
    tasks: await Promise.all([t1, t2, t3, t4].map(assigneesOf)),
    reminders: await Promise.all([t1, t4].map(recipientsOf)),
    events: await Promise.all([e1, e2, e3, e4].map(eventAssigneesOf)),
  });

  it('refuses a target that is removed in the same request and changes nothing', async () => {
    const before = await everyAssignment();

    const res = await owner.api.post(URL(matter, 'remove'))
      .send({ targetUserIds: [leaving, target], reassignTo: target });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reassignTo must be a member who stays on this matter/);
    expect(await everyAssignment()).toEqual(before);
  });

  it('refuses a firm member who is not on the matter and changes nothing', async () => {
    const before = await everyAssignment();

    const res = await owner.api.post(URL(matter, 'remove'))
      .send({ targetUserIds: [leaving, staying], reassignTo: outsider });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reassignTo must be a member who stays on this matter/);
    expect(await everyAssignment()).toEqual(before);
  });

  it('accepts a target who stays when several members are removed together', async () => {
    const res = await owner.api.post(URL(matter, 'remove'))
      .send({ targetUserIds: [leaving, staying], reassignTo: target });

    expect(res.status).toBe(200);
    expect(await memberIds(matter)).toEqual([owner.uid, target].sort());
    expect(await assigneesOf(t1)).toEqual([target]);
    expect(await eventAssigneesOf(e3)).toEqual([target]);
  });
});
