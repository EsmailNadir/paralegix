/**
 * `task_clients` carries no law_firm_id. A create/update payload can therefore
 * name a globally valid client UUID from another firm; the write boundary must
 * resolve it through the task's firm before inserting the junction row.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let ownClientId: string;
let foreignClientId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function linkedClientIds(taskId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    'select client_id from task_clients where task_id = $1 order by client_id',
    [taskId],
  );
  return rows.map((row: any) => row.client_id);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const otherFirm = await createFirm();
  ownClientId = (await createPersonClient(firm.id, { name: 'Local task client' })).id;
  foreignClientId = (await createPersonClient(otherFirm.id, { name: 'Foreign task client' })).id;
});

describe('standalone task client tenancy', () => {
  it('keeps a foreign client out of task-client writes while preserving an own-firm selection', async () => {
    const created = await owner.api.post(T()).send({
      title: 'Client-scoped administrative task',
      clientIds: [ownClientId, foreignClientId],
    });

    expect(created.status).toBe(201);
    expect(await linkedClientIds(created.body.taskId)).toEqual([ownClientId]);

    // Update is a replace-set write too. A foreign-only replacement must not
    // retain or create an edge to the other firm.
    const updated = await owner.api.put(`${T()}/${created.body.taskId}`).send({
      clientIds: [foreignClientId],
    });

    expect(updated.status).toBe(200);
    expect(await linkedClientIds(created.body.taskId)).toEqual([]);
  });
});

export {};
