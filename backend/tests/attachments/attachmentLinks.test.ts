/**
 * What a note, a note reply and a task have attached, through the real routes.
 *
 * These three used to carry an `attachments jsonb` column holding a COPY of the
 * file: its name, size, type and object path beside its id. Nothing in the
 * suite read that copy back after a change to the file it copied, so the two
 * were free to disagree and no test noticed. Migration 0260 replaced the column
 * with `attachments` rows and joins the display fields from `files`.
 *
 * Each case here fails if the wiring for one parent is dropped, and the rename
 * cases fail on the OLD design specifically: a copy cannot follow a rename.
 */
import {
  createFirm, createPersonClient, memberWith, ownerOf, testPool, type Actor, type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { installRichBucket, resetRichBucket } from '../files/richBucket';
import { joinMatter, rootOf, seedFile, seedMatter, seedTask } from '../files/fileWorld';

const scopedWrite = require('../../src/shared/database/scopedWrite');

installRichBucket();

const filesRepo = require('../../src/modules/files/files.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

const notesPath = (suffix = '') => `/api/lawfirms/${firm.id}/matters/${matterId}/notes${suffix}`;
const tasksPath = (suffix = '') => `/api/lawfirms/${firm.id}/tasks${suffix}`;

/** A file in the matter's tree, as an attachment entry the editor would send. */
async function attachable(name: string, bytes = 2048) {
  const file = await seedFile(firm.id, {
    parentId: matterRoot, name, bytes, contentType: 'application/pdf',
  });
  return { id: file.id, name, size: bytes, type: 'application/pdf', objectPath: file.objectPath };
}

/** Drop everything but the fields the record actually owns. */
const shape = (list: any[]) => (list || []).map((a: any) => ({
  id: a.id, name: a.name, size: a.size, type: a.type,
}));

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Okonjo & Reyes' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Vance v. Redmond');
  matterRoot = await rootOf(firm.id, { matterId });
});

describe('a note', () => {
  it('returns what is attached on detail and in the list', async () => {
    const exhibit = await attachable('Exhibit A.pdf', 1024);
    const created = await owner.api.post(notesPath())
      .send({ content: 'Filed the exhibit.', attachments: [exhibit] });
    expect(created.status).toBe(201);
    expect(shape(created.body.note.attachments))
      .toEqual([{ id: exhibit.id, name: 'Exhibit A.pdf', size: 1024, type: 'application/pdf' }]);

    const noteId = created.body.note.id;
    const detail = await owner.api.get(notesPath(`/${noteId}`));
    expect(shape(detail.body.note.attachments)).toEqual(shape(created.body.note.attachments));

    const list = await owner.api.get(notesPath());
    const listed = list.body.notes.find((n: any) => n.id === noteId);
    expect(shape(listed.attachments)).toEqual(shape(created.body.note.attachments));
  });

  it('shows the file renamed in the browser, not the name it was attached under', async () => {
    const exhibit = await attachable('Exhibit A.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Filed the exhibit.', attachments: [exhibit] });

    await filesRepo.rename(firm.id, exhibit.id, 'Exhibit A (executed).pdf');

    const detail = await owner.api.get(notesPath(`/${created.body.note.id}`));
    // The whole reason the copy is gone. A jsonb array still says "Exhibit A".
    expect(detail.body.note.attachments.map((a: any) => a.name))
      .toEqual(['Exhibit A (executed).pdf']);
  });

  it('drops an attachment whose file was deleted', async () => {
    const exhibit = await attachable('Gone.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Filed it.', attachments: [exhibit] });

    await filesRepo.softDeleteSubtree(firm.id, exhibit.id, owner.uid);

    const detail = await owner.api.get(notesPath(`/${created.body.note.id}`));
    expect(detail.body.note.attachments).toEqual([]);
  });

  it('keeps what is attached through an edit that does not mention attachments', async () => {
    const exhibit = await attachable('Exhibit A.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'First pass.', attachments: [exhibit] });

    const edited = await owner.api.put(notesPath(`/${created.body.note.id}`))
      .send({ content: 'Second pass.' });

    expect(edited.status).toBe(200);
    expect(edited.body.note.content).toBe('Second pass.');
    expect(shape(edited.body.note.attachments)).toEqual([
      { id: exhibit.id, name: 'Exhibit A.pdf', size: 2048, type: 'application/pdf' },
    ]);
  });

  it('replaces the set when the edit sends one, and clears it on an empty array', async () => {
    const first = await attachable('First.pdf');
    const second = await attachable('Second.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Draft.', attachments: [first] });
    const noteId = created.body.note.id;

    const swapped = await owner.api.put(notesPath(`/${noteId}`))
      .send({ content: 'Draft.', attachments: [second] });
    expect(swapped.body.note.attachments.map((a: any) => a.id)).toEqual([second.id]);

    const cleared = await owner.api.put(notesPath(`/${noteId}`))
      .send({ content: 'Draft.', attachments: [] });
    expect(cleared.body.note.attachments).toEqual([]);
  });

  it('ignores a file id belonging to another firm', async () => {
    const stranger = await createFirm({ name: 'Ellery LLP' });
    const strangerOwner = await ownerOf(stranger.id);
    const strangerMatter = await seedMatter(stranger.id, strangerOwner.uid, 'Not Yours');
    const strangerFile = await seedFile(stranger.id, {
      parentId: await rootOf(stranger.id, { matterId: strangerMatter }),
      name: 'Privileged.pdf',
    });

    const created = await owner.api.post(notesPath()).send({
      content: 'Trying it on.',
      attachments: [{ id: strangerFile.id, name: 'Privileged.pdf', size: 1024 }],
    });

    // Not a 500 from the composite foreign key, and not a link either. An id
    // this firm has no file for names nothing, so nothing is attached.
    expect(created.status).toBe(201);
    expect(created.body.note.attachments).toEqual([]);
    const { rows } = await testPool.query(
      'select count(*) as n from attachments where file_id = $1', [strangerFile.id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

/**
 * Order and atomicity, which the row model has to supply for itself.
 *
 * A jsonb array had both for free. Rows have neither: `created_at` defaults to
 * `now()`, the TRANSACTION timestamp, so every row one save writes carries the
 * same value and cannot order anything; and a replace-set that is not one
 * transaction can delete what a record had and then fail to write what replaces
 * it. Migration 0262 added `sort_order` for the first. `setAttachments` opens
 * its own transaction for the second.
 */
describe('the links a record keeps', () => {
  const linkRows = async (noteId: string) => (await testPool.query(
    `select f.name, a.sort_order
       from attachments a join files f on f.id = a.file_id
      where a.note_id = $1 order by a.sort_order`,
    [noteId],
  )).rows;

  it('numbers the links by the position the editor showed them in', async () => {
    const first = await attachable('First.pdf');
    const second = await attachable('Second.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Two exhibits.', attachments: [second, first] });

    // The stored positions, not the order a SELECT happened to return. Without
    // `sort_order` every row here carries the same `created_at` and the read
    // order is whatever the plan produces.
    expect(await linkRows(created.body.note.id))
      .toEqual([{ name: 'Second.pdf', sort_order: 0 }, { name: 'First.pdf', sort_order: 1 }]);
    expect(created.body.note.attachments.map((a: any) => a.name))
      .toEqual(['Second.pdf', 'First.pdf']);
  });

  it('renumbers when the editor reorders them', async () => {
    const first = await attachable('First.pdf');
    const second = await attachable('Second.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Two exhibits.', attachments: [first, second] });
    const noteId = created.body.note.id;

    const reordered = await owner.api.put(notesPath(`/${noteId}`))
      .send({ content: 'Two exhibits.', attachments: [second, first] });

    expect(reordered.body.note.attachments.map((a: any) => a.name))
      .toEqual(['Second.pdf', 'First.pdf']);
    expect(await linkRows(noteId))
      .toEqual([{ name: 'Second.pdf', sort_order: 0 }, { name: 'First.pdf', sort_order: 1 }]);
  });

  it('keeps what a record had when the write that replaces it fails', async () => {
    const original = await attachable('Original.pdf');
    const replacement = await attachable('Replacement.pdf');
    const created = await owner.api.post(notesPath())
      .send({ content: 'Filed.', attachments: [original] });
    const noteId = created.body.note.id;

    // Replace-set deletes first. The failure lands between the delete and the
    // insert, which is the whole window this covers.
    const gate = gateMethod(scopedWrite, 'scopedInsertMany');
    gate.failNext(new Error('insert failed'));
    try {
      await owner.api.put(notesPath(`/${noteId}`))
        .send({ content: 'Filed.', attachments: [replacement] });
    } finally {
      gate.restore();
    }

    // Not empty. Without a transaction around the pair, the delete has
    // committed on its own and the note has lost the document it had.
    const after = await owner.api.get(notesPath(`/${noteId}`));
    expect(after.body.note.attachments.map((a: any) => a.name)).toEqual(['Original.pdf']);
  });

  it('writes no note at all when the links it was created with fail', async () => {
    const exhibit = await attachable('Exhibit A.pdf');
    const before = (await owner.api.get(notesPath())).body.notes.length;

    const gate = gateMethod(scopedWrite, 'scopedInsertMany');
    gate.failNext(new Error('insert failed'));
    try {
      await owner.api.post(notesPath())
        .send({ content: 'Never landed.', attachments: [exhibit] });
    } finally {
      gate.restore();
    }

    // The note and its links are one transaction. Two statements without one
    // leave a note the caller was told failed, holding nothing.
    const after = await owner.api.get(notesPath());
    expect(after.body.notes).toHaveLength(before);
    expect(after.body.notes.some((n: any) => n.content === 'Never landed.')).toBe(false);
  });
});

describe('a note reply', () => {
  it('carries its own attachments, separate from the note it answers', async () => {
    const onNote = await attachable('Note.pdf');
    const onReply = await attachable('Reply.pdf');
    const note = await owner.api.post(notesPath())
      .send({ content: 'Question.', attachments: [onNote] });
    const noteId = note.body.note.id;

    const reply = await owner.api.post(notesPath(`/${noteId}/replies`))
      .send({ content: 'Answer.', attachments: [onReply] });
    expect(reply.status).toBe(201);

    const listed = await owner.api.get(notesPath(`/${noteId}/replies`));
    expect(listed.status).toBe(200);
    const replies = listed.body.replies || listed.body.items || listed.body;
    expect(replies.map((r: any) => r.attachments.map((a: any) => a.name)))
      .toEqual([['Reply.pdf']]);

    // The note kept its own, which a shared parent key would have merged.
    const detail = await owner.api.get(notesPath(`/${noteId}`));
    expect(detail.body.note.attachments.map((a: any) => a.name)).toEqual(['Note.pdf']);
  });
});

describe('a task', () => {
  /**
   * A task is created and THEN given its attachments, which is how the editor
   * works: `createTaskSchema` does not accept the field at all, so the upload
   * lands after the task exists and the save that follows carries it.
   */
  async function taskWith(attached: any[], title = 'File the brief') {
    const created = await owner.api.post(tasksPath()).send({ title, matterId });
    expect(created.status).toBe(201);
    const taskId = created.body.task?.id || created.body.taskId;
    const saved = await owner.api.put(tasksPath(`/${taskId}`)).send({ attachments: attached });
    expect(saved.status).toBe(200);
    return { taskId, saved };
  }

  it('returns what is attached on save, detail and list', async () => {
    const brief = await attachable('Brief.pdf', 4096);
    const { taskId, saved } = await taskWith([brief]);
    expect(shape(saved.body.task.attachments))
      .toEqual([{ id: brief.id, name: 'Brief.pdf', size: 4096, type: 'application/pdf' }]);

    // `GET /tasks/:id` answers with the task itself, not wrapped in a key.
    const detail = await owner.api.get(tasksPath(`/${taskId}`));
    expect(shape(detail.body.attachments)).toEqual(shape(saved.body.task.attachments));

    const list = await owner.api.get(tasksPath());
    const listed = list.body.tasks.find((t: any) => t.id === taskId);
    expect(shape(listed.attachments)).toEqual(shape(saved.body.task.attachments));
  });

  it('shows the file renamed in the browser', async () => {
    const brief = await attachable('Brief.pdf');
    const { taskId } = await taskWith([brief]);

    await filesRepo.rename(firm.id, brief.id, 'Brief (final).pdf');

    const detail = await owner.api.get(tasksPath(`/${taskId}`));
    expect(detail.body.attachments.map((a: any) => a.name)).toEqual(['Brief (final).pdf']);
  });

  it('replaces the set on update and keeps it when the update is silent', async () => {
    const first = await attachable('First.pdf');
    const second = await attachable('Second.pdf');
    const { taskId } = await taskWith([first], 'Assemble the bundle');

    const renamed = await owner.api.put(tasksPath(`/${taskId}`)).send({ title: 'Bundle' });
    expect(renamed.body.task.attachments.map((a: any) => a.id)).toEqual([first.id]);

    const swapped = await owner.api.put(tasksPath(`/${taskId}`))
      .send({ attachments: [second, first] });
    expect(swapped.body.task.attachments.map((a: any) => a.id)).toEqual([second.id, first.id]);
  });
});

/**
 * A file can be attached to a note, a reply or a task by id. The link check
 * resolved the id against the firm only, so a member walled off from a matter
 * could name one of that matter's files on their own client note or task and be
 * handed its name (and, for a task, a signed URL) back. The matter wall now
 * applies to the file's own matter. Red if the matter check is removed.
 */
describe('a file from a matter the author is walled off from', () => {
  let member: Actor;
  let clientId: string;
  let walledFile: { id: string; name: string; objectPath: string };

  const linkCount = async (fileId: string) => Number((await testPool.query(
    'select count(*) as n from attachments where file_id = $1', [fileId],
  )).rows[0].n);
  const count = async (table: string) => Number((await testPool.query(
    `select count(*) as n from ${table} where law_firm_id = $1`, [firm.id],
  )).rows[0].n);
  const asEntry = (f: { id: string; name: string; objectPath: string }) => ({
    id: f.id, name: f.name, size: 1024, type: 'application/pdf', objectPath: f.objectPath,
  });

  beforeEach(async () => {
    member = await memberWith(firm.id, [
      'clients.view', 'clients.manage', 'tasks.view', 'tasks.create', 'tasks.update',
    ]);
    clientId = (await createPersonClient(firm.id, { name: 'Walled Client' })).id;
    const walled = await seedMatter(firm.id, owner.uid, 'Walled Matter');
    walledFile = await seedFile(firm.id, { parentId: await rootOf(firm.id, { matterId: walled }), name: 'Walled.pdf' });
  });

  it('is refused on a client note, with no note and no link written', async () => {
    const res = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes`)
      .send({ content: 'Sneaky', attachments: [asEntry(walledFile)] });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Walled.pdf');
    expect(await linkCount(walledFile.id)).toBe(0);
    expect(await count('notes')).toBe(0);
  });

  it('is refused on a reply, with no reply and no link written', async () => {
    const note = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes`).send({ content: 'Plain' });
    expect(note.status).toBe(201);

    const res = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes/${note.body.note.id}/replies`)
      .send({ content: 'Sneaky reply', attachments: [asEntry(walledFile)] });

    expect(res.status).toBe(403);
    expect(await linkCount(walledFile.id)).toBe(0);
    expect(await count('note_replies')).toBe(0);
  });

  it('is refused when added to an existing note, which keeps the attachments it had', async () => {
    const note = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes`).send({ content: 'Plain' });
    expect(note.status).toBe(201);

    const res = await member.api.put(`/api/lawfirms/${firm.id}/clients/${clientId}/notes/${note.body.note.id}`)
      .send({ content: 'Plain, edited', attachments: [asEntry(walledFile)] });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Walled.pdf');
    expect(await linkCount(walledFile.id)).toBe(0);
  });

  it('is refused when added to an existing reply, with the reply left as it was', async () => {
    const note = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes`).send({ content: 'Plain' });
    const reply = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes/${note.body.note.id}/replies`)
      .send({ content: 'First words' });
    expect(reply.status).toBe(201);

    const res = await member.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientId}/notes/${note.body.note.id}/replies/${reply.body.reply.id}`)
      .send({ content: 'Edited words', attachments: [asEntry(walledFile)] });

    expect(res.status).toBe(403);
    expect(await linkCount(walledFile.id)).toBe(0);
    const stored = await testPool.query('select content from note_replies where id = $1', [reply.body.reply.id]);
    expect(stored.rows[0].content).toBe('First words');
  });

  it('is refused when added to an existing task, which keeps the attachments it had', async () => {
    const created = await member.api.post(tasksPath()).send({ title: 'Mine' });
    expect(created.status).toBe(201);

    const res = await member.api.put(tasksPath(`/${created.body.taskId}`))
      .send({ attachments: [asEntry(walledFile)] });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/Walled\.pdf|https?:/);
    expect(await linkCount(walledFile.id)).toBe(0);
  });

  it('is accepted once the author is on that matter, so the refusal is the wall and nothing else', async () => {
    const own = await seedMatter(firm.id, owner.uid, 'Own Matter');
    await joinMatter(firm.id, own, member.uid);
    const ownFile = await seedFile(firm.id, { parentId: await rootOf(firm.id, { matterId: own }), name: 'Own.pdf' });

    const res = await member.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/notes`)
      .send({ content: 'Fine', attachments: [asEntry(ownFile)] });

    expect(res.status).toBe(201);
    expect(await linkCount(ownFile.id)).toBe(1);
  });
});

/**
 * A file that belongs to a task rather than to a matter carries the TASK's
 * wall. A task that was moved into a matter after the file was uploaded keeps
 * `files.matter_id` empty and `files.task_id` set, and who may read it is who
 * may open the task: the matter's staff. The link check applies the same
 * decision the file read gate does, so naming such a file by id does not hand
 * its name (and a task's signed URL) to someone the task is not shared with.
 */
describe('a file on a task the author cannot see', () => {
  let member: Actor;
  let clientId: string;
  let taskFile: { id: string; name: string; objectPath: string };
  let walledTaskMatter: string;
  let walledTaskId: string;

  const linkCount = async (fileId: string) => Number((await testPool.query(
    'select count(*) as n from attachments where file_id = $1', [fileId],
  )).rows[0].n);
  const asEntry = (f: { id: string; name: string; objectPath: string }) => ({
    id: f.id, name: f.name, size: 1024, type: 'application/pdf', objectPath: f.objectPath,
  });
  const clientNotes = (suffix = '') => `/api/lawfirms/${firm.id}/clients/${clientId}/notes${suffix}`;

  beforeEach(async () => {
    member = await memberWith(firm.id, [
      'clients.view', 'clients.manage', 'tasks.view', 'tasks.create', 'tasks.update',
    ]);
    clientId = (await createPersonClient(firm.id, { name: 'Task Wall Client' })).id;
    walledTaskMatter = await seedMatter(firm.id, owner.uid, 'Task Wall Matter');
    walledTaskId = await seedTask(firm.id, { matterId: walledTaskMatter, title: 'Restricted task' });
    taskFile = await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { taskId: walledTaskId }),
      name: 'TaskOnly.pdf',
      taskId: walledTaskId,
    });
  });

  it('is refused on a client note, with no note and no link written', async () => {
    const res = await member.api.post(clientNotes()).send({ content: 'Sneaky', attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('TaskOnly.pdf');
    expect(await linkCount(taskFile.id)).toBe(0);
  });

  it('is refused when added to an existing note', async () => {
    const note = await member.api.post(clientNotes()).send({ content: 'Plain' });
    expect(note.status).toBe(201);

    const res = await member.api.put(clientNotes(`/${note.body.note.id}`))
      .send({ content: 'Plain, edited', attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(403);
    expect(await linkCount(taskFile.id)).toBe(0);
  });

  it('is refused on a reply, with no link written', async () => {
    const note = await member.api.post(clientNotes()).send({ content: 'Plain' });
    const res = await member.api.post(clientNotes(`/${note.body.note.id}/replies`))
      .send({ content: 'Sneaky reply', attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(403);
    expect(await linkCount(taskFile.id)).toBe(0);
  });

  it('is refused when added to an existing reply', async () => {
    const note = await member.api.post(clientNotes()).send({ content: 'Plain' });
    const reply = await member.api.post(clientNotes(`/${note.body.note.id}/replies`)).send({ content: 'First' });
    expect(reply.status).toBe(201);

    const res = await member.api.put(clientNotes(`/${note.body.note.id}/replies/${reply.body.reply.id}`))
      .send({ content: 'Edited', attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(403);
    expect(await linkCount(taskFile.id)).toBe(0);
  });

  it('is refused on the author\'s own task update, with no URL handed back', async () => {
    const created = await member.api.post(tasksPath()).send({ title: 'Mine' });
    expect(created.status).toBe(201);

    const res = await member.api.put(tasksPath(`/${created.body.taskId}`))
      .send({ attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/TaskOnly\.pdf|https?:/);
    expect(await linkCount(taskFile.id)).toBe(0);
  });

  it('is accepted once the author is on the matter the task belongs to', async () => {
    await joinMatter(firm.id, walledTaskMatter, member.uid);

    const res = await member.api.post(clientNotes()).send({ content: 'Fine', attachments: [asEntry(taskFile)] });

    expect(res.status).toBe(201);
    expect(await linkCount(taskFile.id)).toBe(1);
  });

  it('checks each distinct task once however many files name it', async () => {
    const second = await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { taskId: walledTaskId }), name: 'TaskTwo.pdf', taskId: walledTaskId,
    });
    const tasksRepo = require('../../src/modules/tasks/tasks.repository');
    const spy = jest.spyOn(tasksRepo, 'findByIdRaw');
    try {
      const res = await member.api.post(clientNotes())
        .send({ content: 'Two', attachments: [asEntry(taskFile), asEntry(second)] });
      expect(res.status).toBe(403);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('how many attachments one request may carry', () => {
  const many = (entry: any, n: number) => Array.from({ length: n }, () => entry);

  it('accepts 50 on a note and refuses 51 with a 400 before anything is written', async () => {
    const exhibit = await attachable('Exhibit A.pdf');
    const ok = await owner.api.post(notesPath()).send({ content: 'Fifty.', attachments: many(exhibit, 50) });
    expect(ok.status).toBe(201);

    const before = (await owner.api.get(notesPath())).body.notes.length;
    const over = await owner.api.post(notesPath()).send({ content: 'Fifty-one.', attachments: many(exhibit, 51) });
    expect(over.status).toBe(400);
    expect((await owner.api.get(notesPath())).body.notes).toHaveLength(before);
  });

  it('applies the same ceiling to a note edit, a reply and a reply edit', async () => {
    const exhibit = await attachable('Exhibit A.pdf');
    const note = await owner.api.post(notesPath()).send({ content: 'Base.' });
    const noteId = note.body.note.id;
    const reply = await owner.api.post(notesPath(`/${noteId}/replies`)).send({ content: 'Base reply.' });
    const replyId = reply.body.reply.id;

    expect((await owner.api.put(notesPath(`/${noteId}`))
      .send({ content: 'Edit', attachments: many(exhibit, 51) })).status).toBe(400);
    expect((await owner.api.post(notesPath(`/${noteId}/replies`))
      .send({ content: 'Reply', attachments: many(exhibit, 51) })).status).toBe(400);
    expect((await owner.api.put(notesPath(`/${noteId}/replies/${replyId}`))
      .send({ content: 'Edit', attachments: many(exhibit, 51) })).status).toBe(400);

    expect((await owner.api.put(notesPath(`/${noteId}`))
      .send({ content: 'Edit', attachments: many(exhibit, 50) })).status).toBe(200);
    expect((await owner.api.put(notesPath(`/${noteId}/replies/${replyId}`))
      .send({ content: 'Edit', attachments: many(exhibit, 50) })).status).toBe(200);
  });

  it('refuses an attachment entry that is not an object', async () => {
    const res = await owner.api.post(notesPath()).send({ content: 'Odd.', attachments: ['not-an-entry'] });
    expect(res.status).toBe(400);
  });
});
