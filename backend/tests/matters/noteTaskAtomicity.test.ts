import { randomUUID } from 'crypto';
import { createFirm, ownerOf, testPool, drainEvents } from '../support/setupInProcess';

const links = require('../../src/modules/matters/notes/matterNoteLinks.repository');
const eventBus = require('../../src/shared/events/eventBus');
const { TASK_CREATED, MATTER_NOTE_LINKED } = require('../../src/shared/events/eventTypes');

it('rolls back a note task and its assignees when writing the backlink fails', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matterId = randomUUID();
  const noteId = randomUUID();
  await testPool.query('insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [matterId, firm.id, 'Matter', `REF-${matterId}`]);
  await testPool.query('insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [firm.id, matterId, owner.uid]);
  await testPool.query('insert into notes (id, law_firm_id, matter_id, content, created_by) values ($1, $2, $3, $4, $5)',
    [noteId, firm.id, matterId, 'Follow up', owner.uid]);
  const original = links.createLink;
  let taskId: string | undefined;
  let linked = false;
  const taskCreated = jest.fn();
  const noteLinked = jest.fn();
  eventBus.on(TASK_CREATED, taskCreated);
  eventBus.on(MATTER_NOTE_LINKED, noteLinked);
  const fault = jest.spyOn(links, 'createLink').mockImplementation(async (...args: any[]) => {
    taskId = args[1].taskId;
    await original.apply(links, args);
    linked = true;
    throw new Error('Injected failure after backlink');
  });
  try {
    const response = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/notes/${noteId}/tasks`)
      .send({ title: 'Follow up', assigneeIds: [owner.uid] });
    expect(response.status).toBe(500);
    expect(linked).toBe(true);
    expect(taskId).toBeDefined();
    await drainEvents();
    for (const [table, column] of [['tasks', 'id'], ['task_assignees', 'task_id'], ['note_links', 'task_id']]) {
      const { rows } = await testPool.query(`select 1 from ${table} where ${column} = $1`, [taskId]);
      expect({ table, rows }).toEqual({ table, rows: [] });
    }
    expect(taskCreated).not.toHaveBeenCalled();
    expect(noteLinked).not.toHaveBeenCalled();
  } finally {
    fault.mockRestore();
    eventBus.off(TASK_CREATED, taskCreated);
    eventBus.off(MATTER_NOTE_LINKED, noteLinked);
  }
});
