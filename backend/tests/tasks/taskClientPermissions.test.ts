import {
  createFirm, createPersonClient, ownerOf, memberWith, testPool,
} from '../support/setupInProcess';

it('requires clients.manage to attach clients when creating a standalone task', async () => {
  const firm = await createFirm();
  const client = await createPersonClient(firm.id);
  const creator = await memberWith(firm.id, ['tasks.create']);
  const path = `/api/lawfirms/${firm.id}/tasks`;
  expect((await creator.api.post(path).send({ title: 'Unlinked work' })).status).toBe(201);
  const linked = await creator.api.post(path).send({ title: 'Linked work', clientIds: [client.id] });
  expect(linked.status).toBe(403);
  const rows = await testPool.query('select title from tasks where law_firm_id = $1', [firm.id]);
  expect(rows.rows).toEqual([{ title: 'Unlinked work' }]);
});

it('refuses client replacement without clients.manage while allowing ordinary task edits', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const editor = await memberWith(firm.id, ['tasks.update']);
  const path = `/api/lawfirms/${firm.id}/tasks`;
  const created = await owner.api.post(path).send({ title: 'Prepare documents', clientIds: [client.id] });
  expect(created.status).toBe(201);
  const url = `${path}/${created.body.taskId}`;

  const edit = await editor.api.put(url).send({ title: 'Prepare signed documents', clientIds: [client.id] });
  expect(edit.status).toBe(200);
  expect(edit.body.task.title).toBe('Prepare signed documents');

  const removal = await editor.api.put(url).send({ clientIds: [] });
  expect(removal.status).toBe(403);
  const linked = await testPool.query('select client_id from task_clients where task_id = $1', [created.body.taskId]);
  expect(linked.rows).toEqual([{ client_id: client.id }]);

  const manager = await memberWith(firm.id, ['tasks.update', 'clients.manage']);
  expect((await manager.api.put(url).send({ clientIds: [] })).status).toBe(200);
  const cleared = await testPool.query('select client_id from task_clients where task_id = $1', [created.body.taskId]);
  expect(cleared.rows).toEqual([]);
});
