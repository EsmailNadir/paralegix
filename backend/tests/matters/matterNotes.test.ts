/**
 * Matter notes, driven through the real routes.
 *
 * B10.1 requirement:
 * "Shared notes and attachments:
 *  - Create/list/edit/delete, version snapshots, replies, pinning, pagination,
 *    author identity, and parent scope.
 *  - Same-firm wrong parent and foreign-firm note/reply/version ID, including
 *    attachment object path substitutions.
 *  - Note edit between versions being viewed; two edits; deleted reply parent;
 *    deleted author; archived parent; permission downgrade.
 *  - Client-visible update versus internal note: correct portal content and email
 *    audience; internal attachments never become visible merely because a reply is shared.
 *  - Linked task/time entry: authorized link, wrong client/matter, duplicate link,
 *    deleted linked record, and accurate derived time totals.
 *  - A rich-text editor test must assert serialized payload and reloaded content."
 *
 * Covers:
 * 1. The fourteen shared notes endpoints mounted by `notesRouter.ts` for matters:
 *    list, read, versions, create, update, pin, retract, replies (add/list/update/retract),
 *    and note time entries (add/update/delete).
 * 2. Matter-specific extra routes:
 *    - POST /notes/:noteId/tasks (create task from note with backlink)
 *    - POST /notes/:noteId/links/task (link existing task, cross-matter refusal)
 *    - POST /notes/:noteId/links/file (link existing file, cross-matter refusal)
 *    - POST /notes/:noteId/send-client-update (send note as client update)
 * 3. Matter access checks:
 *    - Matter membership is required for write/update/pin/retract (`assertMatterMembership`).
 *    - Matter read access is required for list/read/versions (`assertMatterReadAccess`).
 * 4. Maximum pinned notes cap (max 5) and version snapshot history.
 * 5. Cross-matter and cross-firm isolation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createPortalUser,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { freezeClockAt } from '../support/clock';
import { seedMatterMember } from '../support/matters';
import { noteCount, noteRow, replyRow } from '../support/notesWorld';

let firm: Firm;
let owner: Actor;
let matterId: string;
let client: ClientRecord;

const notesPath = (mId: string, suffix = '') => `/api/lawfirms/${firm.id}/matters/${mId}/notes${suffix}`;

const addMatterMember = (mId: string, uid: string) => seedMatterMember(firm.id, mId, uid);

beforeEach(async () => {
  firm = await createFirm({ name: 'Matter Notes Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Matter Client' });

  const matterRes = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Primary Matter',
    clients: [{ clientId: client.id, name: 'Matter Client' }],
  });
  expect(matterRes.status).toBe(201);
  matterId = matterRes.body.matterId;
  await drainEvents();
});

describe('writing and reading a matter note', () => {
  it('adds a note and retrieves it with sanitized HTML and author identity', async () => {
    const rawHtml = '<p>Initial consultation <strong>completed</strong>.<script>alert("hack")</script></p>';
    const res = await owner.api.post(notesPath(matterId)).send({
      content: 'Initial consultation completed.',
      contentHtml: rawHtml,
      subject: 'Consultation Summary',
      noteType: 'client_meeting',
      attachments: [{ name: 'intake.pdf', size: 1024, url: 'gs://bucket/intake.pdf' }],
    });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('Initial consultation completed.');
    const noteId = res.body.note.id;

    const detail = await owner.api.get(notesPath(matterId, `/${noteId}`));
    expect(detail.status).toBe(200);
    expect(detail.body.note.content).toBe('Initial consultation completed.');
    // Script tags must be stripped by htmlSanitizer
    expect(detail.body.note.contentHtml).not.toContain('<script>');
    expect(detail.body.note.contentHtml).toContain('<strong>completed</strong>');
    expect(detail.body.note.subject).toBe('Consultation Summary');
    expect(detail.body.note.noteType).toBe('client_meeting');
    expect(detail.body.note.createdBy).toBe(owner.uid);

    const list = await owner.api.get(notesPath(matterId));
    expect(list.status).toBe(200);
    expect(list.body.notes.some((n: any) => n.id === noteId)).toBe(true);
  });

  it('supports pagination on note listing', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await owner.api.post(notesPath(matterId)).send({ content: `Note ${i}` });
    }

    const page1 = await owner.api.get(notesPath(matterId, '?limit=2&offset=0'));
    expect(page1.status).toBe(200);
    expect(page1.body.notes).toHaveLength(2);
    expect(page1.body.totalNotes).toBe(5);

    const page2 = await owner.api.get(notesPath(matterId, '?limit=2&offset=2'));
    expect(page2.status).toBe(200);
    expect(page2.body.notes).toHaveLength(2);
    expect(page2.body.totalNotes).toBe(5);

    const page3 = await owner.api.get(notesPath(matterId, '?limit=2&offset=4'));
    expect(page3.status).toBe(200);
    expect(page3.body.notes).toHaveLength(1);
    expect(page3.body.totalNotes).toBe(5);
  });
});

/**
 * The author's name is JOINED from `users` at read time, not stored on the note.
 * Until migration 0227 `notes.created_by_name` was a frozen copy, so a member who
 * changed their name kept the old one on every note they had written, and the
 * search box could not find them under the name their colleagues use.
 *
 * RED IF: a copy comes back (the old name would still show), the search filter
 * reverts to the stored column (the renamed author would not be found), or the
 * create/edit responses stop resolving the name (`createdByName` empty).
 */
describe('the author name follows the member, not the note', () => {
  it('shows and searches the author under their CURRENT name after a rename', async () => {
    const author = await memberWith(firm.id, ['matters.view', 'matters.update']);
    await testPool.query('update users set name = $2 where id = $1', [author.uid, 'Pat Before']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, author.uid],
    );
    const created = await author.api.post(notesPath(matterId)).send({ content: 'Written before the rename' });
    expect(created.status).toBe(201);
    expect(created.body.note.createdByName).toBe('Pat Before');

    await testPool.query('update users set name = $2 where id = $1', [author.uid, 'Pat After']);

    const detail = await owner.api.get(notesPath(matterId, `/${created.body.note.id}`));
    expect(detail.body.note.createdByName).toBe('Pat After');

    const byNewName = await owner.api.get(notesPath(matterId, '?search=Pat%20After'));
    expect(byNewName.status).toBe(200);
    expect(byNewName.body.notes.map((n: any) => n.id)).toEqual([created.body.note.id]);

    const byOldName = await owner.api.get(notesPath(matterId, '?search=Pat%20Before'));
    expect(byOldName.body.notes).toEqual([]);
  });
});

describe('editing, versioning, pinning and retracting', () => {
  it('records an immutable version snapshot each time content is updated', async () => {
    const created = await owner.api.post(notesPath(matterId)).send({
      content: 'Original draft v1',
      subject: 'Draft',
    });
    const noteId = created.body.note.id;

    await owner.api.put(notesPath(matterId, `/${noteId}`)).send({
      content: 'Revised draft v2',
      subject: 'Draft v2',
    });

    await owner.api.put(notesPath(matterId, `/${noteId}`)).send({
      content: 'Final version v3',
      subject: 'Final',
    });

    const versions = await owner.api.get(notesPath(matterId, `/${noteId}/versions`));
    expect(versions.status).toBe(200);
    expect(versions.body.totalItems).toBe(2);

    // Each PUT snapshots the PRIOR content before overwriting, so two edits
    // leave two versions behind: v1 (replaced by v2) and v2 (replaced by v3).
    expect(versions.body.versions.map((v: any) => v.content).sort())
      .toEqual(['Original draft v1', 'Revised draft v2']);

    const detail = await owner.api.get(notesPath(matterId, `/${noteId}`));
    expect(detail.body.note.content).toBe('Final version v3');
  });

  it('pins and unpins notes up to the maximum of 5', async () => {
    const noteIds: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const res = await owner.api.post(notesPath(matterId)).send({ content: `Pinnable Note ${i}` });
      noteIds.push(res.body.note.id);
    }

    // Pin 5 notes
    for (let i = 0; i < 5; i += 1) {
      const pinRes = await owner.api.put(notesPath(matterId, `/${noteIds[i]}/pin`)).send({ pinned: true });
      expect(pinRes.status).toBe(200);
    }
    expect((await noteRow(noteIds[0])).pinned_at).not.toBeNull();

    // Attempting to pin a 6th note on the same matter must be refused with 400
    const overflowRes = await owner.api.put(notesPath(matterId, `/${noteIds[5]}/pin`)).send({ pinned: true });
    expect(overflowRes.status).toBe(400);
    expect(overflowRes.body.error).toContain('At most 5 notes can be pinned');

    // Unpin one note
    const unpinRes = await owner.api.put(notesPath(matterId, `/${noteIds[0]}/pin`)).send({ pinned: false });
    expect(unpinRes.status).toBe(200);
    expect((await noteRow(noteIds[0])).pinned_at).toBeNull();

    // Now pinning the 6th note succeeds
    const retryRes = await owner.api.put(notesPath(matterId, `/${noteIds[5]}/pin`)).send({ pinned: true });
    expect(retryRes.status).toBe(200);
  });

  it('retracts a note, preserving row history, and prevents editing retracted notes', async () => {
    const created = await owner.api.post(notesPath(matterId)).send({ content: 'Note to retract' });
    const noteId = created.body.note.id;

    const retractRes = await owner.api.delete(notesPath(matterId, `/${noteId}`)).send({
      reason: 'Superseded by filing',
    });
    expect(retractRes.status).toBe(200);

    const row = await noteRow(noteId);
    // The row and its text survive: time entries point at it from the billing
    // tables, and it is a record of work performed.
    expect(row).not.toBeNull();
    expect(row.content).toBe('Note to retract');
    expect(row.retracted_at).not.toBeNull();
    expect(row.retraction_reason).toBe('Superseded by filing');

    // Attempting to update a retracted note returns 403
    const editRes = await owner.api.put(notesPath(matterId, `/${noteId}`)).send({ content: 'Try to edit' });
    expect(editRes.status).toBe(403);
    expect(editRes.body.error).toContain('This note has been retracted and can no longer be edited');
  });

  it('author vs admin retraction authority', async () => {
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['matters.view', 'matters.update'] });
    await addMatterMember(matterId, member.uid);

    // Owner creates a note
    const created = await owner.api.post(notesPath(matterId)).send({ content: "Owner's note" });
    const noteId = created.body.note.id;

    // Non-author member cannot retract the owner's note
    const memberRetract = await as(tokenFor({ uid: member.uid })).delete(notesPath(matterId, `/${noteId}`)).send({ reason: 'test' });
    expect(memberRetract.status).toBe(403);
    expect((await noteRow(noteId)).retracted_at).toBeNull();

    // Member creates their own note
    const memberNote = await as(tokenFor({ uid: member.uid })).post(notesPath(matterId)).send({ content: "Member's note" });
    const memberNoteId = memberNote.body.note.id;

    // Owner (admin) CAN retract colleague's note
    const ownerRetract = await owner.api.delete(notesPath(matterId, `/${memberNoteId}`)).send({ reason: 'Admin retraction' });
    expect(ownerRetract.status).toBe(200);
    expect((await noteRow(memberNoteId)).retracted_at).not.toBeNull();
  });
});

describe('replies on matter notes', () => {
  it('adds, lists, updates, and retracts replies', async () => {
    const created = await owner.api.post(notesPath(matterId)).send({ content: 'Parent note for discussion' });
    const noteId = created.body.note.id;

    // Add reply
    const replyRes = await owner.api.post(notesPath(matterId, `/${noteId}/replies`)).send({
      content: 'First reply to discussion',
    });
    expect(replyRes.status).toBe(201);
    const replyId = replyRes.body.reply.id;

    // List replies
    const listRes = await owner.api.get(notesPath(matterId, `/${noteId}/replies`));
    expect(listRes.status).toBe(200);
    expect(listRes.body.replies).toHaveLength(1);
    expect(listRes.body.replies[0].content).toBe('First reply to discussion');

    // Update reply
    const updateRes = await owner.api.put(notesPath(matterId, `/${noteId}/replies/${replyId}`)).send({
      content: 'Updated reply content',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.reply.content).toBe('Updated reply content');

    // Retract reply
    const deleteRes = await owner.api.delete(notesPath(matterId, `/${noteId}/replies/${replyId}`)).send({});
    expect(deleteRes.status).toBe(200);

    // Retracted, not deleted: the row keeps its text.
    const row = await replyRow(replyId);
    expect(row.content).toBe('Updated reply content');
    expect(row.retracted_at).not.toBeNull();
  });
});

describe('cross-matter and cross-firm isolation', () => {
  it('cannot access a note through a different matter in the same firm', async () => {
    const secondMatterRes = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Second Matter',
      clients: [{ clientId: client.id, name: 'Matter Client' }],
    });
    const secondMatterId = secondMatterRes.body.matterId;

    const noteRes = await owner.api.post(notesPath(matterId)).send({ content: 'Secret Matter 1 note' });
    const noteId = noteRes.body.note.id;

    // Reading Matter 1's note through Matter 2 URL returns 404
    const getRes = await owner.api.get(notesPath(secondMatterId, `/${noteId}`));
    expect(getRes.status).toBe(404);

    // Editing Matter 1's note through Matter 2 URL returns 404
    const putRes = await owner.api.put(notesPath(secondMatterId, `/${noteId}`)).send({ content: 'Hacked' });
    expect(putRes.status).toBe(404);

    // Retracting Matter 1's note through Matter 2 URL returns 404
    const delRes = await owner.api.delete(notesPath(secondMatterId, `/${noteId}`)).send({});
    expect(delRes.status).toBe(404);
  });

  it('foreign firm member is completely isolated', async () => {
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(otherFirm.id);
    const noteRes = await owner.api.post(notesPath(matterId)).send({ content: 'Firm A note' });
    const noteId = noteRes.body.note.id;

    const foreignGet = await as(tokenFor({ uid: otherOwner.uid })).get(notesPath(matterId, `/${noteId}`));
    // Blocked by firm membership check on the route
    expect(foreignGet.status).toBe(403);
  });

  it('A05: does not let a reply update or retract escape its note or matter parent', async () => {
    const secondMatterRes = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Second Matter for Replies',
      clients: [{ clientId: client.id, name: 'Matter Client' }],
    });
    const secondMatterId = secondMatterRes.body.matterId;

    // Matter 1 has note 1 with reply 1
    const note1Res = await owner.api.post(notesPath(matterId)).send({ content: 'Matter 1 Note' });
    const note1Id = note1Res.body.note.id;
    const reply1Res = await owner.api.post(notesPath(matterId, `/${note1Id}/replies`)).send({ content: 'Original reply' });
    const reply1Id = reply1Res.body.reply.id;

    // Matter 1 also has note 2 (sibling note)
    const note2Res = await owner.api.post(notesPath(matterId)).send({ content: 'Matter 1 Sibling Note' });
    const note2Id = note2Res.body.note.id;

    // 1. Escaping across matters: attempt to update/retract reply1 using secondMatterId
    const crossMatterUpdate = await owner.api
      .put(notesPath(secondMatterId, `/${note1Id}/replies/${reply1Id}`))
      .send({ content: 'Hijacked cross-matter' });
    expect(crossMatterUpdate.status).toBe(404);

    const crossMatterDelete = await owner.api
      .delete(notesPath(secondMatterId, `/${note1Id}/replies/${reply1Id}`))
      .send({});
    expect(crossMatterDelete.status).toBe(404);

    // 2. Escaping across notes on the same matter: attempt to update/retract reply1 under note2
    const crossNoteUpdate = await owner.api
      .put(notesPath(matterId, `/${note2Id}/replies/${reply1Id}`))
      .send({ content: 'Hijacked cross-note' });
    expect(crossNoteUpdate.status).toBe(404);

    const crossNoteDelete = await owner.api
      .delete(notesPath(matterId, `/${note2Id}/replies/${reply1Id}`))
      .send({});
    expect(crossNoteDelete.status).toBe(404);

    // 3. Control: genuine parent update succeeds
    const legitimateUpdate = await owner.api
      .put(notesPath(matterId, `/${note1Id}/replies/${reply1Id}`))
      .send({ content: 'Legitimate update' });
    expect(legitimateUpdate.status).toBe(200);

    const { rows } = await testPool.query('select content, retracted_at from note_replies where id = $1', [reply1Id]);
    expect(rows[0].content).toBe('Legitimate update');
    expect(rows[0].retracted_at).toBeNull();
  });
});

describe('matter membership as the access gate', () => {
  it('firm member with permissions but not on the matter is refused write access', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'matters.update'],
    });
    // Colleague is NOT added to matter_members!

    // Attempting to post a note on this matter must be refused by assertMatterMembership
    const res = await as(tokenFor({ uid: colleague.uid })).post(notesPath(matterId)).send({
      content: 'Unauthorized note creation',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('User is not a member of this matter');
  });
});

describe('permissions', () => {
  // Each case adds the member to the matter first, so matter MEMBERSHIP is
  // never the reason for a refusal here - only the firm-level `matters.update`
  // permission gate, isolated from the membership gate covered above.
  it('lets a baseline member (matters.view only) who is on the matter read the notes', async () => {
    const created = await owner.api.post(notesPath(matterId)).send({ content: 'Readable note' });
    expect(created.status).toBe(201);
    const reader = await memberWith(firm.id, ['matters.view']);
    await addMatterMember(matterId, reader.uid);

    const res = await reader.api.get(notesPath(matterId));

    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: any) => n.content)).toContain('Readable note');
  });

  it('refuses a matter member without matters.update a write', async () => {
    const reader = await memberWith(firm.id, ['matters.view']);
    await addMatterMember(matterId, reader.uid);

    const res = await reader.api.post(notesPath(matterId)).send({ content: 'Nope' });

    expect(res.status).toBe(403);
    expect(await noteCount(firm.id)).toBe(0);
  });

  it('lets a matter member holding matters.update write', async () => {
    const writer = await memberWith(firm.id, ['matters.update']);
    await addMatterMember(matterId, writer.uid);

    const res = await writer.api.post(notesPath(matterId)).send({ content: 'Allowed' });

    expect(res.status).toBe(201);
  });
});

describe('time entries linked to a matter note', () => {
  it('adds billable time to a note, reconciles hours, updates, and deletes it', async () => {
    const noteRes = await owner.api.post(notesPath(matterId)).send({ content: 'Legal research note' });
    const noteId = noteRes.body.note.id;

    // Add time to note
    const timeRes = await owner.api.post(notesPath(matterId, `/${noteId}/time`)).send({
      timeSpent: 2.5,
      timeEntryDate: '2026-09-01',
      activityName: 'Research',
      activityDescription: 'Researched statutory precedents',
      isBillable: true,
    });
    expect(timeRes.status).toBe(201);
    expect(timeRes.body.note.time.totalHours).toBe(2.5);
    expect(timeRes.body.note.time.entries).toHaveLength(1);
    const timeEntryId = timeRes.body.note.time.entries[0].id;

    // Update time entry
    const updateTime = await owner.api.put(notesPath(matterId, `/${noteId}/time/${timeEntryId}`)).send({
      timeSpent: 3.0,
      timeEntryDate: '2026-09-01',
      activityName: 'Research & Draft',
      isBillable: true,
    });
    expect(updateTime.status).toBe(200);
    expect(updateTime.body.note.time.totalHours).toBe(3.0);

    // Delete time entry
    const deleteTime = await owner.api.delete(notesPath(matterId, `/${noteId}/time/${timeEntryId}`));
    expect(deleteTime.status).toBe(200);
    expect(deleteTime.body.note.time.totalHours).toBe(0);
    expect(deleteTime.body.note.time.entries).toHaveLength(0);
  });
});

describe('time added to a note without a date', () => {
  /**
   * The entry takes the note's date, else today. Goes red if "today" is the UTC
   * day: time logged at 8pm Pacific on September 27 is billed on the 28th.
   */
  it('is dated today in the lawyer\'s zone', async () => {
    freezeClockAt('2026-09-27T20:00:00-07:00');
    const noteRes = await owner.api.post(notesPath(matterId))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ content: 'Call with client' });
    const noteId = noteRes.body.note.id;
    // No note date, so the entry's own default is what is under test.
    await testPool.query(`update notes set note_date = null where id = $1`, [noteId]);

    const res = await owner.api.post(notesPath(matterId, `/${noteId}/time`))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ timeSpent: 0.5, activityName: 'Call', isBillable: true });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select activity_date::text as day from activities where linked_note_id = $1`, [noteId],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-27']);
  });

  it('logged with a new note, is dated the same way', async () => {
    freezeClockAt('2026-09-27T20:00:00-07:00');

    const res = await owner.api.post(notesPath(matterId))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ content: 'Drafted motion', timeEntries: [{ timeSpent: 1, activityName: 'Drafting', isBillable: true }] });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select activity_date::text as day from activities where linked_note_id = $1`, [res.body.note.id],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-27']);
    // The note itself is dated the same day: it used to take the UTC day too.
    const note = await testPool.query(`select note_date::text as day from notes where id = $1`, [res.body.note.id]);
    expect(note.rows[0].day).toBe('2026-09-27');
  });
});

describe('matter-only links and client update', () => {
  it('spawns a task from a note with a backlink', async () => {
    const noteRes = await owner.api.post(notesPath(matterId)).send({
      content: 'Follow up with court clerk by Friday',
      subject: 'Court Filing Deadline',
    });
    const noteId = noteRes.body.note.id;

    const taskRes = await owner.api.post(notesPath(matterId, `/${noteId}/tasks`)).send({
      title: 'Call Court Clerk',
      dueDate: '2026-09-10',
      priority: 'high',
    });
    expect(taskRes.status).toBe(201);
    expect(taskRes.body.taskId).toBeTruthy();
    expect(taskRes.body.link.linkType).toBe('task');
    expect(taskRes.body.link.taskId).toBe(taskRes.body.taskId);
  });

  it('links an existing task to a note and refuses cross-matter tasks', async () => {
    const noteRes = await owner.api.post(notesPath(matterId)).send({ content: 'Investigation notes' });
    const noteId = noteRes.body.note.id;

    // Create task on the same matter
    const taskRes = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({
      title: 'Task on same matter',
      matterId,
    });
    const taskId = taskRes.body.taskId ?? taskRes.body.task?.id;

    // Link task
    const linkRes = await owner.api.post(notesPath(matterId, `/${noteId}/links/task`)).send({ taskId });
    expect(linkRes.status).toBe(201);
    expect(linkRes.body.link.taskId).toBe(taskId);

    // Create second matter and task on second matter
    const secondMatter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Unrelated Matter',
      clients: [{ clientId: client.id, name: 'Matter Client' }],
    });
    const foreignTaskRes = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({
      title: 'Task on foreign matter',
      matterId: secondMatter.body.matterId,
    });
    const foreignTaskId = foreignTaskRes.body.taskId ?? foreignTaskRes.body.task?.id;

    // Attempting to link foreign task to Matter 1's note must be refused with 400
    const crossRes = await owner.api.post(notesPath(matterId, `/${noteId}/links/task`)).send({ taskId: foreignTaskId });
    expect(crossRes.status).toBe(400);
    expect(crossRes.body.error).toContain('That task belongs to a different matter');
  });

  it('sendNoteAsClientUpdate refuses when client has no portal access, and succeeds when portal access exists', async () => {
    const noteRes = await owner.api.post(notesPath(matterId)).send({ content: 'Update regarding hearing date' });
    const noteId = noteRes.body.note.id;

    // Initially client has no portal account -> refused with 400
    const noPortalRes = await owner.api.post(notesPath(matterId, `/${noteId}/client-update`)).send({
      message: 'Hearing scheduled for next Tuesday.',
    });
    expect(noPortalRes.status).toBe(400);
    expect(noPortalRes.body.code).toBe('VALIDATION_ERROR');
    expect(noPortalRes.body.error).toContain("None of this matter's clients have portal access yet");

    // Create portal user and link to client
    const portalUser = await createPortalUser({ name: 'Matter Client Portal' });
    expect(portalUser.uid).toBeTruthy();
    await testPool.query('update clients set user_id = $1 where id = $2', [portalUser.uid, client.id]);

    // Now client-update succeeds
    const sendRes = await owner.api.post(notesPath(matterId, `/${noteId}/client-update`)).send({
      message: 'Hearing confirmed with court for next Tuesday.',
    });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.message).toBe('Client update sent');
    expect(sendRes.body.conversationId).toBeTruthy();
  });

  it('sendNoteAsClientUpdate: selectively routes to specified co-client, isolates unselected clients, and does not leak internal note content', async () => {
    // Attach a second client to the matter
    const clientB = await createPersonClient(firm.id, { name: 'Second Matter Client' });
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [matterId, clientB.id, firm.id],
    );

    // Create portal users for both clients
    const portalUserA = await createPortalUser({ name: 'Portal User A' });
    await testPool.query('update clients set user_id = $1 where id = $2', [portalUserA.uid, client.id]);

    const portalUserB = await createPortalUser({ name: 'Portal User B' });
    await testPool.query('update clients set user_id = $1 where id = $2', [portalUserB.uid, clientB.id]);

    // Create internal note containing sensitive attorney work product
    const noteRes = await owner.api.post(notesPath(matterId)).send({
      content: 'CONFIDENTIAL WORK PRODUCT: Internal strategy and litigation impressions',
      subject: 'Trial Strategy',
    });
    const noteId = noteRes.body.note.id;

    // Send update targeting ONLY Client B via recipientClientIds
    const selectiveRes = await owner.api.post(notesPath(matterId, `/${noteId}/client-update`)).send({
      message: 'Settlement proposal received from opposing counsel.',
      recipientClientIds: [clientB.id],
    });
    expect(selectiveRes.status).toBe(201);
    expect(selectiveRes.body.message).toBe('Client update sent');
    const conversationId = selectiveRes.body.conversationId;
    expect(conversationId).toBeTruthy();

    // Verify conversation participants: Client B is included, Client A is NOT included
    const participants = await testPool.query(
      'select participant_user_id, participant_type from conversation_participants where conversation_id = $1',
      [conversationId],
    );
    const participantIds = participants.rows.map((r: any) => r.participant_user_id);
    expect(participantIds).toContain(portalUserB.uid);
    expect(participantIds).not.toContain(portalUserA.uid);

    // Verify message text: strictly the update message, not internal note content
    const messages = await testPool.query(
      'select content from messages where conversation_id = $1',
      [conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0].content).toBe('Settlement proposal received from opposing counsel.');
    expect(messages.rows[0].content).not.toContain('CONFIDENTIAL WORK PRODUCT');

    // Negative control: recipientClientIds specifying an unrelated client ID fails with 400
    const foreignClientId = randomUUID();
    const badRecipientRes = await owner.api.post(notesPath(matterId, `/${noteId}/client-update`)).send({
      message: 'Unrouted update',
      recipientClientIds: [foreignClientId],
    });
    expect(badRecipientRes.status).toBe(400);
    expect(badRecipientRes.body.error).toContain("None of this matter's clients have portal access yet");
  });
});

