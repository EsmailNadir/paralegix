/**
 * A task's optional end (migration 0039).
 *
 * A task's start is its due day, or its due time when it has one. The end
 * follows the rules an event's end does: a timed end is an instant after the
 * start, an all-day end is the exclusive day after the last day at noon UTC,
 * an edit that moves the start carries the end along, flipping all-day drops
 * it, and null removes it. Reads return `endsAtLocalInput` beside
 * `dueDateLocalInput` so the edit form can prefill it.
 */

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const T = (suffix = '') => `/api/lawfirms/${firm.id}/tasks${suffix}`;
const create = (body: Record<string, unknown>) =>
  owner.api.post(T()).set('x-timezone', 'America/New_York').send({ title: 'Prep session', ...body });
const update = (id: string, body: Record<string, unknown>) =>
  owner.api.put(T(`/${id}`)).set('x-timezone', 'America/New_York').send(body);

const endOf = async (id: string) => {
  const { rows } = await testPool.query('select ends_at from tasks where id = $1', [id]);
  return rows[0].ends_at as Date | null;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('creating a task with an end', () => {
  it('stores a timed end as the instant picked in the caller zone', async () => {
    const res = await create({ dueDate: '2026-05-10T13:00', allDay: false, endsAt: '2026-05-10T15:30' });

    expect(res.status).toBe(201);
    expect((await endOf(res.body.taskId))!.toISOString()).toBe('2026-05-10T19:30:00.000Z');
  });

  it('stores an all-day end at the noon anchor of the exclusive day', async () => {
    // The 10th through the 12th.
    const res = await create({ dueDate: '2026-05-10T00:00', allDay: true, endsAt: '2026-05-13' });

    expect(res.status).toBe(201);
    expect((await endOf(res.body.taskId))!.toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('leaves the end null when none is sent', async () => {
    const res = await create({ dueDate: '2026-05-10T13:00', allDay: false });

    expect(res.status).toBe(201);
    expect(await endOf(res.body.taskId)).toBeNull();
  });

  it('refuses an end before the start with a 400 that says so', async () => {
    const res = await create({ dueDate: '2026-05-10T13:00', allDay: false, endsAt: '2026-05-10T12:00' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('after its start');
  });

  it('refuses an end on a task with no due date', async () => {
    const res = await create({ endsAt: '2026-05-10T12:00' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('due date');
  });

  it('returns the end as a local form value beside the due date', async () => {
    const res = await create({ dueDate: '2026-05-10T13:00', allDay: false, endsAt: '2026-05-10T15:30' });

    expect(res.body.task.endsAtLocalInput).toBe('2026-05-10T15:30');
    expect(res.body.task.endsAt).toBe('2026-05-10T19:30:00.000Z');
  });
});

describe('editing a task with an end', () => {
  const timed = () => create({ dueDate: '2026-05-10T13:00', allDay: false, endsAt: '2026-05-10T15:30' });

  it.each(['not-a-date', '2026-05-10T25:99', '2026-05-10junk', ''])('rejects invalid end %j without changing the saved end', async (endsAt) => {
    const created = await timed();
    expect(created.status).toBe(201);
    const id = created.body.taskId;
    const res = await update(id, { endsAt });
    expect(res.status).toBe(400);
    expect((await endOf(id))!.toISOString()).toBe('2026-05-10T19:30:00.000Z');
  });

  it('carries the end along when only the due time moves past it', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { dueDate: '2026-05-12T13:00', allDay: false });

    expect(res.status).toBe(200);
    expect((await endOf(id))!.toISOString()).toBe('2026-05-12T19:30:00.000Z');
  });

  it('uses the end the caller sends', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { dueDate: '2026-05-12T13:00', allDay: false, endsAt: '2026-05-12T14:00' });

    expect(res.status).toBe(200);
    expect((await endOf(id))!.toISOString()).toBe('2026-05-12T18:00:00.000Z');
  });

  it('removes the end when the caller sends null', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { endsAt: null });

    expect(res.status).toBe(200);
    expect(await endOf(id)).toBeNull();
  });

  it('drops a timed end when the task becomes all-day without an end of its own', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { dueDate: '2026-05-10T00:00', allDay: true });

    expect(res.status).toBe(200);
    expect(await endOf(id)).toBeNull();
  });

  it('accepts an all-day-only edit and drops the timed end', async () => {
    const created = await timed();
    expect(created.status).toBe(201);
    const res = await update(created.body.taskId, { allDay: true });
    expect(res.status).toBe(200);
    expect(res.body.task.allDay).toBe(true);
    expect(res.body.task.dueAt).toBeNull();
    expect(await endOf(created.body.taskId)).toBeNull();
  });

  it('resolves an explicit end using an all-day-only edit', async () => {
    const created = await timed();
    expect(created.status).toBe(201);
    const res = await update(created.body.taskId, { allDay: true, endsAt: '2026-05-13' });
    expect(res.status).toBe(200);
    expect(res.body.task.allDay).toBe(true);
    expect((await endOf(created.body.taskId))!.toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('turns an all-day span into a timed task when only the flag changes', async () => {
    const created = await create({ dueDate: '2026-05-10', allDay: true, endsAt: '2026-05-13' });
    expect(created.status).toBe(201);
    const res = await update(created.body.taskId, { allDay: false });
    expect(res.status).toBe(200);
    expect(res.body.task.allDay).toBe(false);
    expect(res.body.task.dueDateLocalInput).toBe('2026-05-10T12:00');
    expect(await endOf(created.body.taskId)).toBeNull();
  });

  it('drops the end when the due date is cleared', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { dueDate: null });

    expect(res.status).toBe(200);
    expect(await endOf(id)).toBeNull();
  });

  it('leaves the end alone on an edit that does not touch the dates', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { title: 'Prep session (moved rooms)' });

    expect(res.status).toBe(200);
    expect((await endOf(id))!.toISOString()).toBe('2026-05-10T19:30:00.000Z');
  });

  it('carries an all-day span along when only its first day moves', async () => {
    // The 10th through the 12th, moved to start on the 20th.
    const id = (await create({ dueDate: '2026-05-10T00:00', allDay: true, endsAt: '2026-05-13' })).body.taskId;

    const res = await update(id, { dueDate: '2026-05-20T00:00', allDay: true });

    expect(res.status).toBe(200);
    expect((await endOf(id))!.toISOString()).toBe('2026-05-23T12:00:00.000Z');
  });

  it('refuses an edit that puts the end before the stored start, and keeps the old end', async () => {
    const id = (await timed()).body.taskId;

    const res = await update(id, { endsAt: '2026-05-10T12:00' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('after its start');
    expect((await endOf(id))!.toISOString()).toBe('2026-05-10T19:30:00.000Z');
  });

  it('refuses an end on a task that has no due date', async () => {
    const id = (await create({})).body.taskId;

    const res = await update(id, { endsAt: '2026-05-10T12:00' });

    expect(res.status).toBe(400);
    expect(await endOf(id)).toBeNull();
  });
});

describe('reading a task end', () => {
  it('returns an all-day end as the exclusive day, which the form shows one day earlier', async () => {
    const res = await create({ dueDate: '2026-05-10T00:00', allDay: true, endsAt: '2026-05-13' });

    expect(res.body.task.endsAt).toBe('2026-05-13T12:00:00.000Z');
    expect(res.body.task.endsAtLocalInput.slice(0, 10)).toBe('2026-05-13');
  });
});
