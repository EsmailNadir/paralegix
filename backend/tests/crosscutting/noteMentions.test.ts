/**
 * Who an @mention on a note or a reply may reach, for each of the three parents.
 *
 * A mention fans out a bell notification carrying a 100-character preview of the
 * note and a deep link to it. So a mention is a disclosure: the ids in it must be
 * people who could open the note anyway. Two kinds of id fail that test:
 *
 *   - a user who is not a member of this firm at all (here, the owner of a
 *     second firm, so the id is a real `users` row and only the firm check can
 *     stop it);
 *   - a member of this firm who is walled off from the parent: not on the
 *     matter the matter note, the task or the client hangs off, and not an owner
 *     or admin.
 *
 * Neither may be notified, and neither is stored on the note or reply, so the
 * mention list a reader sees is the list that was actually honoured. A member
 * staffed on the matter is mentioned alongside them and IS notified, which proves
 * the notification path ran at all and the absences are not vacuous.
 *
 * Red if the shared engine or reply service stops filtering mentions, or if a
 * parent's adapter answers the read question differently from its own read gate.
 */
import {
  createFirm,
  createPersonClient,
  drainEvents,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterMember } from '../support/matters';
import { seedNote, type NoteParent } from '../support/notesWorld';

interface Parent {
  name: 'matter' | 'task' | 'client';
  param: string;
  base: string;
  perms: string[];
}

const PARENTS: Parent[] = [
  { name: 'matter', param: 'matterId', base: 'matters', perms: ['matters.view', 'matters.update'] },
  { name: 'task', param: 'taskId', base: 'tasks', perms: ['tasks.view', 'tasks.update'] },
  { name: 'client', param: 'clientId', base: 'clients', perms: ['clients.view', 'clients.manage'] },
];

/** Every user a mention notification on this note went to, sorted. */
async function mentionRecipients(lawFirmId: string, noteId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select user_id from notifications
      where law_firm_id = $1 and entity_type = 'note' and entity_id = $2 and type = 'mention'
      order by user_id`,
    [lawFirmId, noteId],
  );
  return rows.map((r: any) => r.user_id);
}

describe.each(PARENTS)('@mentions on a $name note', (parent) => {
  let firm: Firm;
  let owner: Actor;
  let insider: Actor;   // staffed on the matter: may read the parent
  let walled: Actor;    // a firm member off the matter: may not
  let outsider: Actor;  // a real user, but of another firm
  let matterId: string;
  let parentId: string;

  const notesPath = (suffix = '') => `/api/lawfirms/${firm.id}/${parent.base}/${parentId}/notes${suffix}`;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    insider = await memberWith(firm.id, parent.perms);
    walled = await memberWith(firm.id, parent.perms);
    outsider = await ownerOf((await createFirm()).id);

    const client = await createPersonClient(firm.id, { name: 'Mention Client' });
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Mention Matter', clients: [{ clientId: client.id, name: 'Mention Client' }],
    });
    expect(matter.status).toBe(201);
    matterId = matter.body.matterId;
    await seedMatterMember(firm.id, matterId, insider.uid);

    if (parent.name === 'matter') parentId = matterId;
    else if (parent.name === 'client') parentId = client.id;
    else {
      const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Mention task', matterId });
      expect(task.status).toBe(201);
      parentId = task.body.taskId;
    }

    // The wall is real: the walled member is refused the parent's notes outright.
    expect((await walled.api.get(notesPath())).status).toBe(403);
    await drainEvents();
  });

  it('notifies and stores only the mentioned users who can read the note', async () => {
    const res = await owner.api.post(notesPath()).send({
      content: 'Privileged strategy for the hearing',
      mentions: [insider.uid, walled.uid, outsider.uid],
    });
    await drainEvents();

    expect(res.status).toBe(201);
    const noteId = res.body.note.id;
    expect(await mentionRecipients(firm.id, noteId)).toEqual([insider.uid]);
    const stored = await testPool.query('select mentions from notes where id = $1', [noteId]);
    expect(stored.rows[0].mentions).toEqual([insider.uid]);
  });

  it('notifies and stores only the mentioned users who can read the note on a reply', async () => {
    const note = await seedNote(firm.id, { [parent.param]: parentId } as NoteParent, {
      content: 'Seeded', createdBy: owner.uid,
    });

    const res = await owner.api.post(notesPath(`/${note.id}/replies`)).send({
      content: 'Replying with privileged detail',
      mentions: [insider.uid, walled.uid, outsider.uid],
    });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(await mentionRecipients(firm.id, note.id)).toEqual([insider.uid]);
    const stored = await testPool.query('select mentions from note_replies where id = $1', [res.body.reply.id]);
    expect(stored.rows[0].mentions).toEqual([insider.uid]);
  });

  it('does not disclose replies to historic authors who can no longer read the parent', async () => {
    const note = await seedNote(firm.id, { [parent.param]: parentId } as NoteParent, {
      content: 'Earlier discussion', createdBy: walled.uid,
    });
    await seedMatterMember(firm.id, matterId, walled.uid);
    const previousReply = await walled.api.post(notesPath(`/${note.id}/replies`)).send({ content: 'Earlier reply' });
    expect(previousReply.status).toBe(201);
    await drainEvents();
    await testPool.query('delete from notifications where law_firm_id = $1', [firm.id]);
    await testPool.query('delete from matter_members where law_firm_id = $1 and matter_id = $2 and user_id = $3',
      [firm.id, matterId, walled.uid]);
    expect((await walled.api.get(notesPath())).status).toBe(403);

    const res = await owner.api.post(notesPath(`/${note.id}/replies`)).send({
      content: 'New privileged strategy', parentReplyId: previousReply.body.reply.id, mentions: [insider.uid],
    });
    expect(res.status).toBe(201);
    await drainEvents();
    expect(await mentionRecipients(firm.id, note.id)).toEqual([insider.uid]);
  });
});

describe('a task note mention notification', () => {
  let firm: Firm;
  let owner: Actor;
  let insider: Actor;
  let matterId: string;
  let taskId: string;

  const notesPath = (suffix = '') => `/api/lawfirms/${firm.id}/tasks/${taskId}/notes${suffix}`;
  const mentionMatterIds = async (noteId: string) => (await testPool.query(
    `select matter_id from notifications where law_firm_id = $1 and entity_id = $2 and user_id = $3`,
    [firm.id, noteId, insider.uid],
  )).rows.map((r: any) => r.matter_id);

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    insider = await memberWith(firm.id, ['tasks.view', 'tasks.update']);
    const client = await createPersonClient(firm.id, { name: 'Tagged Client' });
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Tagged Matter', clients: [{ clientId: client.id, name: 'Tagged Client' }],
    });
    expect(matter.status).toBe(201);
    matterId = matter.body.matterId;
    await seedMatterMember(firm.id, matterId, insider.uid);
    const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Tagged task', matterId });
    expect(task.status).toBe(201);
    taskId = task.body.taskId;
    await drainEvents();
  });

  it("carries the task's matter, so deleting the matter clears it", async () => {
    const res = await owner.api.post(notesPath()).send({ content: 'See this', mentions: [insider.uid] });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(await mentionMatterIds(res.body.note.id)).toEqual([matterId]);
  });

  it("carries the task's matter on a reply too", async () => {
    const note = await seedNote(firm.id, { taskId }, { content: 'Seeded', createdBy: owner.uid });

    const res = await owner.api.post(notesPath(`/${note.id}/replies`)).send({ content: 'And this', mentions: [insider.uid] });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(await mentionMatterIds(note.id)).toEqual([matterId]);
  });
});
