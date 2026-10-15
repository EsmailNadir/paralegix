/**
 * B02 A05: the correct firm, but the WRONG parent id for a child resource that
 * only actually belongs to a sibling parent in the same firm.
 *
 * Every prior tenancy spec asks "can firm B reach firm A's record" (a firm-id
 * mismatch). This is a narrower, easily-missed sibling of that question: two
 * REAL matters (or two real tasks) in the SAME firm, and whether a note or a
 * subtask that belongs to one of them can be read, edited or deleted by
 * naming the OTHER one in the URL. No membership gate can catch this, because
 * the caller is a genuine member (here, the owner) of both parents. The only
 * thing standing between the child row and the wrong parent is whether the
 * repository query actually ANDs the parent id into its WHERE clause instead
 * of trusting the child's own id to be enough.
 *
 * Both cases below deliberately use the FIRM OWNER as the caller, not a
 * narrow member. `assertMatterReadAccess`/`assertMatterFirmWideAccess`
 * (src/shared/utils/membership.ts) let an owner or admin read ANY matter in
 * the firm without a `matter_members` row at all, and `assertTaskInFirm`
 * (src/modules/tasks/subtasks/taskSubtasks.service.ts) only escalates to a
 * matter check when the task actually has a matterId. Using the owner
 * against firm-level (matterless) tasks means the access-control layer
 * grants the wrong-parent request with NO membership objection whatsoever,
 * which isolates the assertion to the repository's parent-id scoping alone —
 * exactly the mechanism this scenario exists to pin.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  testPool,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

describe('B02 A05: a matter note reached through a different, real matter', () => {
  let firm: Firm;
  let owner: Actor;
  let matterA: string;
  let matterB: string;
  let noteId: string;

  beforeEach(async () => {
    firm = await createFirm({ name: 'A05 Notes Firm' });
    owner = await ownerOf(firm.id);

    const a = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Matter A' });
    expect(a.status).toBe(201);
    matterA = a.body.matterId;

    const b = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Matter B' });
    expect(b.status).toBe(201);
    matterB = b.body.matterId;

    const note = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterA}/notes`)
      .send({ content: 'Confidential to Matter A only' });
    expect(note.status).toBe(201);
    noteId = note.body.note.id;
    await drainEvents();
  });

  it('is not found and does not disclose the note content through the sibling matter, even for the firm owner', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters/${matterB}/notes/${noteId}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential to Matter A only');
  });

  it('cannot be retracted through the sibling matter', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${matterB}/notes/${noteId}`).send({});

    expect(res.status).toBe(404);
    const { rows } = await testPool.query(
      'select retracted_at from notes where id = $1', [noteId],
    );
    expect(rows[0].retracted_at).toBeNull();
  });

  it('the genuine parent control: the SAME note is readable through its real matter', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters/${matterA}/notes/${noteId}`);

    expect(res.status).toBe(200);
    expect(res.body.note.content).toBe('Confidential to Matter A only');
  });
});

describe('B02 A05: a task subtask reached through a different, real task', () => {
  let firm: Firm;
  let owner: Actor;
  let taskA: string;
  let taskB: string;
  let subtaskId: string;

  beforeEach(async () => {
    firm = await createFirm({ name: 'A05 Subtasks Firm' });
    owner = await ownerOf(firm.id);

    // Firm-level tasks (no matterId): assertTaskInFirm only requires firm
    // membership for these, so the owner's access here rests on nothing but
    // plain membership -- the matter ethical wall never enters the picture.
    const a = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Task A' });
    expect(a.status).toBe(201);
    taskA = a.body.taskId;

    const b = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Task B' });
    expect(b.status).toBe(201);
    taskB = b.body.taskId;

    const subtask = await owner.api.post(`/api/lawfirms/${firm.id}/tasks/${taskA}/subtasks`)
      .send({ title: 'Only belongs to Task A' });
    expect(subtask.status).toBe(201);
    subtaskId = subtask.body.subtask.id;
    await drainEvents();
  });

  it('cannot be updated through the sibling task', async () => {
    const res = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskB}/subtasks/${subtaskId}`)
      .send({ title: 'Hijacked from Task B' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select title from task_subtasks where id = $1', [subtaskId]);
    expect(rows[0].title).toBe('Only belongs to Task A');
  });

  it('cannot be deleted through the sibling task', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/tasks/${taskB}/subtasks/${subtaskId}`);

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select id from task_subtasks where id = $1', [subtaskId]);
    expect(rows).toHaveLength(1);
  });

  it('does not appear in the sibling task subtask list', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/tasks/${taskB}/subtasks`);

    expect(res.status).toBe(200);
    expect(res.body.subtasks.map((s: any) => s.id)).not.toContain(subtaskId);
  });

  it('a wholly nonexistent sibling task id also 404s, not 500 (no uuid cast error)', async () => {
    const res = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${randomUUID()}/subtasks/${subtaskId}`)
      .send({ title: 'Should not land anywhere' });

    expect(res.status).toBe(404);
  });

  it('the genuine parent control: the subtask updates cleanly through its real task', async () => {
    const res = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskA}/subtasks/${subtaskId}`)
      .send({ title: 'Renamed through the real parent' });

    expect(res.status).toBe(200);
    expect(res.body.subtask.title).toBe('Renamed through the real parent');
  });
});

describe('B02 A05: a client note reached through a different, real client in the same firm', () => {
  let firm: Firm;
  let owner: Actor;
  let clientA: ClientRecord;
  let clientB: ClientRecord;
  let noteId: string;

  beforeEach(async () => {
    firm = await createFirm({ name: 'A05 Client Notes Firm' });
    owner = await ownerOf(firm.id);
    clientA = await createPersonClient(firm.id, { name: 'Client A' });
    clientB = await createPersonClient(firm.id, { name: 'Client B' });

    const note = await owner.api
      .post(`/api/lawfirms/${firm.id}/clients/${clientA.id}/notes`)
      .send({ content: 'Confidential to Client A only' });
    expect(note.status).toBe(201);
    noteId = note.body.note.id;
    await drainEvents();
  });

  it('is not found and does not disclose the note content through the sibling client, even for the firm owner', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${clientB.id}/notes/${noteId}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential to Client A only');
  });

  it('cannot be retracted through the sibling client', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${clientB.id}/notes/${noteId}`).send({});
    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select retracted_at from notes where id = $1', [noteId]);
    expect(rows[0].retracted_at).toBeNull();
  });

  it('the genuine parent control: the note is readable through its real client', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${clientA.id}/notes/${noteId}`);
    expect(res.status).toBe(200);
    expect(res.body.note.content).toBe('Confidential to Client A only');
  });
});

describe('B02 A05: a client event reached through a different, real client in the same firm', () => {
  let firm: Firm;
  let owner: Actor;
  let clientA: ClientRecord;
  let clientB: ClientRecord;
  let eventId: string;

  beforeEach(async () => {
    firm = await createFirm({ name: 'A05 Client Events Firm' });
    owner = await ownerOf(firm.id);
    clientA = await createPersonClient(firm.id, { name: 'Client A' });
    clientB = await createPersonClient(firm.id, { name: 'Client B' });

    const ev = await owner.api
      .post(`/api/lawfirms/${firm.id}/clients/${clientA.id}/events`)
      .send({ type: 'meeting', title: 'Client A Meeting', date: '2026-07-01', allDay: true });
    expect(ev.status).toBe(201);
    eventId = ev.body.eventId;
    await drainEvents();
  });

  it('cannot be updated through the sibling client', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientB.id}/events/${eventId}`)
      .send({ source: 'client', title: 'Hijacked Event Title' });
    expect(res.status).toBe(404);

    const { rows } = await testPool.query('select title from events where id = $1', [eventId]);
    expect(rows[0].title).toBe('Client A Meeting');
  });

  it('cannot be deleted through the sibling client', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${clientB.id}/events/${eventId}`);
    expect(res.status).toBe(404);

    const { rows } = await testPool.query('select id from events where id = $1', [eventId]);
    expect(rows).toHaveLength(1);
  });

  it('does not appear in the sibling client event list', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${clientB.id}/events`);
    expect(res.status).toBe(200);
    const eventIds = (res.body.events || []).map((e: any) => e.id);
    expect(eventIds).not.toContain(eventId);
  });

  it('the genuine parent control: the event updates cleanly through its real client', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientA.id}/events/${eventId}`)
      .send({ source: 'client', title: 'Updated through real client' });
    expect(res.status).toBe(200);

    const { rows } = await testPool.query('select title from events where id = $1', [eventId]);
    expect(rows[0].title).toBe('Updated through real client');
  });
});

