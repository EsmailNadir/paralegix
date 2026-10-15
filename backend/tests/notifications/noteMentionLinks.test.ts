/**
 * The deep link a note notification carries, for each of the three parents.
 *
 * Every parent page opens its Notes tab from `?tab=notes` and scrolls to the
 * note named by `?note=`. A link without both drops the reader on the parent's
 * Overview (tasks) or at the top of the notes list, so they have to hunt for the
 * note they were told about.
 *
 * Red if a note or reply notification for any parent links anywhere other than
 * that parent's Notes tab with the note's id.
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

const PARENTS = [
  { name: 'matter', base: 'matters', perms: ['matters.view', 'matters.update'] },
  { name: 'task', base: 'tasks', perms: ['tasks.view', 'tasks.update'] },
  { name: 'client', base: 'clients', perms: ['clients.view', 'clients.manage'] },
] as const;

async function actionUrlsFor(lawFirmId: string, userId: string, noteId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select action_url from notifications
      where law_firm_id = $1 and user_id = $2 and entity_type = 'note' and entity_id = $3`,
    [lawFirmId, userId, noteId],
  );
  return rows.map((r: any) => r.action_url);
}

describe.each(PARENTS)('a $name note notification', (parent) => {
  let firm: Firm;
  let owner: Actor;
  let insider: Actor;
  let parentId: string;

  const notesPath = (suffix = '') => `/api/lawfirms/${firm.id}/${parent.base}/${parentId}/notes${suffix}`;
  const expectedLink = (noteId: string) => `/lawfirm/${firm.id}/${parent.base}/${parentId}?tab=notes&note=${noteId}`;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    insider = await memberWith(firm.id, [...parent.perms]);
    const client = await createPersonClient(firm.id, { name: 'Link Client' });
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Link Matter', clients: [{ clientId: client.id, name: 'Link Client' }],
    });
    expect(matter.status).toBe(201);
    const matterId = matter.body.matterId;
    await seedMatterMember(firm.id, matterId, insider.uid);

    if (parent.name === 'matter') parentId = matterId;
    else if (parent.name === 'client') parentId = client.id;
    else {
      const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Link task', matterId });
      expect(task.status).toBe(201);
      parentId = task.body.taskId;
    }
    await drainEvents();
  });

  it('links a mention to the note on the Notes tab', async () => {
    const res = await owner.api.post(notesPath()).send({ content: 'See this', mentions: [insider.uid] });
    await drainEvents();
    expect(res.status).toBe(201);

    const urls = await actionUrlsFor(firm.id, insider.uid, res.body.note.id);
    expect(urls).toHaveLength(1);
    expect(urls[0].endsWith(expectedLink(res.body.note.id))).toBe(true);
  });

  it('links a reply to the note on the Notes tab', async () => {
    const note = await owner.api.post(notesPath()).send({ content: 'Thread start' });
    expect(note.status).toBe(201);
    await drainEvents();
    const res = await owner.api.post(notesPath(`/${note.body.note.id}/replies`)).send({ content: 'Reply', mentions: [insider.uid] });
    await drainEvents();
    expect(res.status).toBe(201);

    const urls = await actionUrlsFor(firm.id, insider.uid, note.body.note.id);
    expect(urls).toHaveLength(1);
    expect(urls[0].endsWith(expectedLink(note.body.note.id))).toBe(true);
  });
});
