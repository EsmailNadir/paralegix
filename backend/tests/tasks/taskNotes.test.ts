/**
 * Task notes, driven through the real routes.
 *
 * Matter notes (`tests/matters/firmNotes.test.ts`) and client notes
 * (`tests/clients/clientNotes.test.ts`) both have in-process coverage of the
 * shared notes engine (`src/shared/notes/notesEngine.ts`) through their own
 * adapter. Task notes had NONE: `tests/live/tasks/taskNotes.test.ts` exists,
 * but it's in the opt-in `live` project (needs a running server and real
 * Firebase credentials) and never runs in CI. `taskNotes.service.ts` and
 * `noteReplies.service.ts` were exercised by nothing in the suite that
 * actually runs.
 *
 * The engine behaviour every parent shares (versions, pinning, retraction,
 * reply CRUD and nesting, empty-content validation) is pinned once, in
 * `tests/matters/matterNotes.test.ts` and `tests/clients/clientNotes.test.ts`.
 * This file keeps what the task adapter decides for itself.
 *
 * Task notes are also the one adapter with a REAL per-note access rule
 * instead of a simple existence check: `assertTaskAccess` gates on the
 * task's own `visibleToUserIds` (derived from matter membership for a
 * matter-scoped task, or every firm member for a task with none — see
 * `tasks.repository.ts`'s `TASK_COLUMNS`), not on note-specific permission
 * codes alone. A colleague holding `tasks.view`/`tasks.update` but off the
 * task's matter must still be refused, which is the property most worth
 * pinning here and the one the shared engine's own tests cannot cover.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterMember } from '../support/matters';
import { noteContents, noteCount, noteRow, walkNoteEngine } from '../support/notesWorld';

let firm: Firm;
let owner: Actor;
let matterId: string;
let taskId: string;

const notesPath = (tid: string, suffix = '') => `/api/lawfirms/${firm.id}/tasks/${tid}/notes${suffix}`;

/** A task, straight through the real route so `visibleToUserIds` derives correctly. */
async function createTask(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'A task', ...extra });
  expect(res.status).toBe(201);
  return res.body.taskId as string;
}

const addMatterMember = (mId: string, uid: string) => seedMatterMember(firm.id, mId, uid);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Task Notes Client' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter',
    clients: [{ clientId: client.id, name: 'Task Notes Client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  taskId = await createTask({ matterId });
  await drainEvents();
});

describe('writing and reading a note', () => {
  it('adds one and lists it back', async () => {
    const res = await owner.api.post(notesPath(taskId)).send({ content: 'Called the client re: filing' });
    await drainEvents();

    expect(res.status).toBe(201);

    const list = await owner.api.get(notesPath(taskId));
    expect(list.status).toBe(200);
    expect(noteContents(list.body)).toContain('Called the client re: filing');
    expect(list.body.totalNotes).toBe(1);
  });

  it('reads one back by id', async () => {
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Detail note', subject: 'Subject line' });
    const noteId = created.body.note.id;

    const res = await owner.api.get(notesPath(taskId, `/${noteId}`));

    expect(res.status).toBe(200);
    expect(res.body.note.content).toBe('Detail note');
    expect(res.body.note.subject).toBe('Subject line');
  });

  it('answers 404 for a task that does not exist', async () => {
    const res = await owner.api.get(notesPath(randomUUID()));
    expect(res.status).toBe(404);
  });
});

describe('the shared engine behind the task adapter', () => {
  it('reaches every note route with the task as the parent', async () => {
    await walkNoteEngine({
      actor: owner, lawFirmId: firm.id, parent: { taskId }, notesPath: (suffix = '') => notesPath(taskId, suffix),
    });
  });
});

describe('replies', () => {
  it('refuses to reply to a note that belongs to a DIFFERENT task in this same firm', async () => {
    const otherTaskId = await createTask({ matterId });
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Belongs to the first task' });
    const noteId = created.body.note.id;

    const res = await owner.api.post(notesPath(otherTaskId, `/${noteId}/replies`)).send({ content: 'Wrong task' });

    expect(res.status).toBe(404);
  });
});

describe('cross-task scoping within the same firm', () => {
  it('never shows a note through a different task, even one the same caller can see', async () => {
    const otherTaskId = await createTask({ matterId });
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Task A only' });
    const noteId = created.body.note.id;

    const list = await owner.api.get(notesPath(otherTaskId));
    expect(noteContents(list.body)).not.toContain('Task A only');

    const detail = await owner.api.get(notesPath(otherTaskId, `/${noteId}`));
    expect(detail.status).toBe(404);
  });

  it('refuses to edit a note through a different task, and leaves it untouched', async () => {
    const otherTaskId = await createTask({ matterId });
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Original' });
    const noteId = created.body.note.id;

    const res = await owner.api.put(notesPath(otherTaskId, `/${noteId}`)).send({ content: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await noteRow(noteId)).content).toBe('Original');
  });
});

describe('tenancy', () => {
  it("refuses to list notes on another firm's task", async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherTask = await as(tokenFor({ uid: otherOwner.uid }))
      .post(`/api/lawfirms/${otherFirm.id}/tasks`).send({ title: 'Foreign task' });
    expect(otherTask.status).toBe(201);
    const foreignTaskId = otherTask.body.taskId as string;

    // Same caller (this firm's owner), foreign firm's id in the URL and the task id.
    const res = await owner.api.get(`/api/lawfirms/${otherFirm.id}/tasks/${foreignTaskId}/notes`);
    expect(res.status).toBe(403);
  });

  it("refuses to open another firm's note under this firm's own task id in the URL", async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherTask = await as(tokenFor({ uid: otherOwner.uid }))
      .post(`/api/lawfirms/${otherFirm.id}/tasks`).send({ title: 'Foreign task' });
    const foreignTaskId = otherTask.body.taskId as string;
    const foreignNote = await as(tokenFor({ uid: otherOwner.uid }))
      .post(`/api/lawfirms/${otherFirm.id}/tasks/${foreignTaskId}/notes`).send({ content: 'Foreign content' });
    const foreignNoteId = foreignNote.body.note.id;

    const res = await owner.api.get(notesPath(taskId, `/${foreignNoteId}`));
    expect(res.status).toBe(404);
  });

  it("refuses to retract another firm's note and leaves it in place", async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherTask = await as(tokenFor({ uid: otherOwner.uid }))
      .post(`/api/lawfirms/${otherFirm.id}/tasks`).send({ title: 'Foreign task' });
    const foreignTaskId = otherTask.body.taskId as string;
    const foreignNote = await as(tokenFor({ uid: otherOwner.uid }))
      .post(`/api/lawfirms/${otherFirm.id}/tasks/${foreignTaskId}/notes`).send({ content: 'Foreign content' });
    const foreignNoteId = foreignNote.body.note.id;

    const res = await owner.api.delete(`/api/lawfirms/${otherFirm.id}/tasks/${foreignTaskId}/notes/${foreignNoteId}`).send({});

    expect(res.status).toBe(403);
    expect((await noteRow(foreignNoteId)).retracted_at).toBeNull();
  });
});

describe('reply routes check the task exists before widening for an owner', () => {
  // The owner and admin read widening once returned before the task lookup, so
  // the reply read ran against whatever task id the URL carried. The answer has
  // to be the task's own 404, from the gate, whatever the task id is.
  it.each([
    ['another firm\'s task', async () => {
      const otherFirm = await createFirm();
      const otherOwner = await ownerOf(otherFirm.id);
      const otherTask = await as(tokenFor({ uid: otherOwner.uid }))
        .post(`/api/lawfirms/${otherFirm.id}/tasks`).send({ title: 'Foreign task' });
      expect(otherTask.status).toBe(201);
      return otherTask.body.taskId as string;
    }],
    ['a task that does not exist', async () => randomUUID()],
    // Reached `task_id = $2` as a uuid cast error, a 500, before the lookup ran.
    ['a malformed task id', async () => 'not-a-uuid'],
  ])('answers 404 Task for %s', async (_label, taskIdFor) => {
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Own note' });
    expect(created.status).toBe(201);
    const noteId = created.body.note.id;
    const control = await owner.api.get(notesPath(taskId, `/${noteId}/replies`));
    expect(control.status).toBe(200);

    const res = await owner.api.get(notesPath(await taskIdFor(), `/${noteId}/replies`));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });
});

describe('task visibility as the access gate', () => {
  it('refuses a colleague who holds tasks.view/tasks.update but is not on the matter', async () => {
    const outsider = await createFirmMember(firm.id, { isOwner: false, permissions: ['tasks.update'] });

    const read = await as(tokenFor({ uid: outsider.uid })).get(notesPath(taskId));
    expect(read.status).toBe(403);

    const write = await as(tokenFor({ uid: outsider.uid })).post(notesPath(taskId)).send({ content: 'Should not land' });
    expect(write.status).toBe(403);
    expect(await noteCount(firm.id)).toBe(0);
  });

  it('lets a colleague who IS a member of the matter read and write', async () => {
    const insider = await createFirmMember(firm.id, { isOwner: false, permissions: ['tasks.update'] });
    await addMatterMember(matterId, insider.uid);

    const write = await as(tokenFor({ uid: insider.uid })).post(notesPath(taskId)).send({ content: 'On the matter' });
    expect(write.status).toBe(201);

    const read = await as(tokenFor({ uid: insider.uid })).get(notesPath(taskId));
    expect(read.status).toBe(200);
    expect(noteContents(read.body)).toContain('On the matter');
  });

  it('lets the firm owner read regardless of matter membership', async () => {
    // `owner` was never added to `matterId`'s `matter_members` in `beforeEach`.
    const res = await owner.api.get(notesPath(taskId));
    expect(res.status).toBe(200);
  });

  it('is visible to any firm member when the task has no matter at all', async () => {
    const firmWideTask = await createTask();
    const anyMember = await createFirmMember(firm.id, { isOwner: false, permissions: ['tasks.update'] });

    const write = await as(tokenFor({ uid: anyMember.uid }))
      .post(notesPath(firmWideTask)).send({ content: 'Firm-wide task note' });
    expect(write.status).toBe(201);
  });
});

describe('time entries linked to a note', () => {
  it('adds a time entry against the task\'s own matter and links it to the note', async () => {
    const created = await owner.api.post(notesPath(taskId)).send({ content: 'Drafted the motion' });
    const noteId = created.body.note.id;

    const res = await owner.api.post(notesPath(taskId, `/${noteId}/time`)).send({
      timeSpent: 1.5, timeEntryDate: '2026-05-10', activityName: 'Drafting',
    });
    expect(res.status).toBe(201);

    const { rows } = await testPool.query(
      `select matter_id, hours, linked_note_id from activities where kind = 'time' and linked_note_id = $1`, [noteId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].matter_id).toBe(matterId);
    expect(Number(rows[0].hours)).toBe(1.5);
  });

  it('refuses to add time to a note on a task with no matter and no client', async () => {
    const bareTask = await createTask();
    const created = await owner.api.post(notesPath(bareTask)).send({ content: 'No billing context' });
    const noteId = created.body.note.id;

    const res = await owner.api.post(notesPath(bareTask, `/${noteId}/time`)).send({ timeSpent: 1 });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(`select 1 from activities where kind = 'time' and linked_note_id = $1`, [noteId]);
    expect(rows).toHaveLength(0);
  });
});

describe('permissions', () => {
  // A firm-wide task (no matter), so these cases isolate the PERMISSION gate
  // from the task-visibility gate exercised above.
  let firmWideTask: string;
  beforeEach(async () => {
    firmWideTask = await createTask();
  });

  it('lets a baseline member (tasks.view only) read the notes', async () => {
    await owner.api.post(notesPath(firmWideTask)).send({ content: 'Readable' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(notesPath(firmWideTask));

    expect(res.status).toBe(200);
    expect(noteContents(res.body)).toContain('Readable');
  });

  it('refuses a member without tasks.update a write', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(notesPath(firmWideTask)).send({ content: 'Nope' });

    expect(res.status).toBe(403);
    expect(await noteCount(firm.id)).toBe(0);
  });

  it('refuses a member without tasks.delete a retraction', async () => {
    const created = await owner.api.post(notesPath(firmWideTask)).send({ content: 'Protected' });
    const noteId = created.body.note.id;
    const writer = await memberWith(firm.id, ['tasks.update']);

    const res = await writer.api.delete(notesPath(firmWideTask, `/${noteId}`)).send({});

    expect(res.status).toBe(403);
    expect((await noteRow(noteId)).retracted_at).toBeNull();
  });

  it('lets a member holding tasks.update write and reply', async () => {
    const writer = await memberWith(firm.id, ['tasks.update']);

    const note = await writer.api.post(notesPath(firmWideTask)).send({ content: 'Allowed' });
    expect(note.status).toBe(201);

    const reply = await writer.api.post(notesPath(firmWideTask, `/${note.body.note.id}/replies`)).send({ content: 'Also allowed' });
    expect(reply.status).toBe(201);
  });

  it('A05: does not let a reply update or retract escape its note or task parent', async () => {
    const secondTask = await createTask({ title: 'Second Task for Replies' });

    // Task 1 has note 1 with reply 1
    const note1Res = await owner.api.post(notesPath(firmWideTask)).send({ content: 'Task 1 Note' });
    const note1Id = note1Res.body.note.id;
    const reply1Res = await owner.api.post(notesPath(firmWideTask, `/${note1Id}/replies`)).send({ content: 'Original reply' });
    const reply1Id = reply1Res.body.reply.id;

    // Task 1 also has note 2 (sibling note)
    const note2Res = await owner.api.post(notesPath(firmWideTask)).send({ content: 'Task 1 Sibling Note' });
    const note2Id = note2Res.body.note.id;

    // 1. Escaping across tasks: attempt to update/retract reply1 using secondTask
    const crossTaskUpdate = await owner.api
      .put(notesPath(secondTask, `/${note1Id}/replies/${reply1Id}`))
      .send({ content: 'Hijacked cross-task' });
    expect(crossTaskUpdate.status).toBe(404);

    const crossTaskDelete = await owner.api
      .delete(notesPath(secondTask, `/${note1Id}/replies/${reply1Id}`))
      .send({});
    expect(crossTaskDelete.status).toBe(404);

    // 2. Escaping across notes on the same task: attempt to update/retract reply1 under note2
    const crossNoteUpdate = await owner.api
      .put(notesPath(firmWideTask, `/${note2Id}/replies/${reply1Id}`))
      .send({ content: 'Hijacked cross-note' });
    expect(crossNoteUpdate.status).toBe(404);

    const crossNoteDelete = await owner.api
      .delete(notesPath(firmWideTask, `/${note2Id}/replies/${reply1Id}`))
      .send({});
    expect(crossNoteDelete.status).toBe(404);

    // 3. Control: genuine parent update succeeds
    const legitimateUpdate = await owner.api
      .put(notesPath(firmWideTask, `/${note1Id}/replies/${reply1Id}`))
      .send({ content: 'Legitimate update' });
    expect(legitimateUpdate.status).toBe(200);

    const { rows } = await testPool.query('select content, retracted_at from note_replies where id = $1', [reply1Id]);
    expect(rows[0].content).toBe('Legitimate update');
    expect(rows[0].retracted_at).toBeNull();
  });
});

