/**
 * GET /api/lawfirms/:lawFirmId/files/list-client-tasks?clientId=...
 *
 * The standalone tasks attached to a client that hold files, each with its file
 * count. The client detail page lists them as folders beside the client's
 * matters, since a task with no matter keeps its documents in its own tree and
 * nothing else on that page reaches them.
 *
 * WHAT THESE TESTS PIN, and what has to break for each to go red:
 *
 *   - which tasks are listed: attached to THIS client, WITHOUT a matter, and
 *     holding at least one live item. Drop any of the three filters and the
 *     listing test gains a task it must not show.
 *   - the count: every live document in the task's tree, however deep, and
 *     nothing deleted or abandoned mid-upload. Count one level, or count dead
 *     rows, and the number is wrong.
 *   - tenancy: another firm's owner is refused through this firm and gets
 *     nothing through their own. Drop the firm scope from the query and the
 *     second assertion sees this firm's task.
 *   - the gate: firm membership, as for any standalone task's files. Narrow it
 *     to owners and the plain-member test is refused.
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
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { rootOf, seedFile, seedFolder, seedMatter, seedTask } from './fileWorld';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let clientId: string;

const url = (id: string, lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/files/list-client-tasks?clientId=${id}`;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Task Files & Co' });
  owner = await ownerOf(firm.id);
  ({ id: clientId } = await createPersonClient(firm.id, { name: 'Jane Smith' }));
  await drainEvents();
});

async function attachClient(lawFirmId: string, taskId: string, id: string) {
  const { rowCount } = await testPool.query(
    'insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)',
    [lawFirmId, taskId, id],
  );
  expect(rowCount).toBe(1);
}

/** A standalone task attached to the client, holding one file per name given. */
async function clientTaskWithFiles(title: string, fileNames: string[]): Promise<string> {
  const taskId = await seedTask(firm.id, { title, matterId: null });
  await attachClient(firm.id, taskId, clientId);
  const parentId = await rootOf(firm.id, { taskId });
  for (const name of fileNames) {
    // eslint-disable-next-line no-await-in-loop -- fixture, one row at a time
    await seedFile(firm.id, { parentId, name });
  }
  return taskId;
}

describe('GET /files/list-client-tasks: what is listed', () => {
  it("lists the client's standalone tasks that hold files, by title, with a deep count of live documents", async () => {
    const intake = await clientTaskWithFiles('Intake paperwork', ['ID.pdf', 'Engagement.pdf']);
    const folder = await seedFolder(firm.id, { parentId: await rootOf(firm.id, { taskId: intake }), name: 'Scans' });
    await seedFile(firm.id, { parentId: folder.id, name: 'Passport.pdf' });
    // Neither of these is a document: one abandoned mid-upload, one deleted.
    await seedFile(firm.id, { parentId: folder.id, name: 'Half.pdf', finalized: false });
    const gone = await seedFile(firm.id, { parentId: folder.id, name: 'Gone.pdf' });
    await testPool.query('update files set deleted_at = now() where id = $1', [gone.id]);

    const alpha = await clientTaskWithFiles('Alpha review', ['Notes.pdf']);

    // Each of these fails exactly one of the three filters.
    await clientTaskWithFiles('Nothing filed', []);
    const otherClient = await createPersonClient(firm.id, { name: 'Someone Else' });
    const notTheirs = await seedTask(firm.id, { title: 'Not their task', matterId: null });
    await attachClient(firm.id, notTheirs, otherClient.id);
    await seedFile(firm.id, { parentId: await rootOf(firm.id, { taskId: notTheirs }), name: 'Other.pdf' });
    const matterId = await seedMatter(firm.id, owner.uid, 'Some Matter');
    const matterTask = await seedTask(firm.id, { title: 'Matter task', matterId });
    await attachClient(firm.id, matterTask, clientId);
    await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId }), name: 'Matter task doc.pdf', taskId: matterTask,
    });

    // Filed while standalone, then moved onto a matter: its documents stay in
    // its own tree, but the task now belongs to that matter.
    const movedOnto = await clientTaskWithFiles('Moved onto a matter', ['Early.pdf']);
    await testPool.query('update tasks set matter_id = $2 where id = $1', [movedOnto, matterId]);

    const res = await owner.api.get(url(clientId));

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([
      { id: alpha, title: 'Alpha review', fileCount: 1 },
      { id: intake, title: 'Intake paperwork', fileCount: 3 },
    ]);
  });

  it('lists a task holding only an empty folder, with no documents counted', async () => {
    const taskId = await clientTaskWithFiles('Folders only', []);
    await seedFolder(firm.id, { parentId: await rootOf(firm.id, { taskId }), name: 'To sort' });

    const res = await owner.api.get(url(clientId));

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([{ id: taskId, title: 'Folders only', fileCount: 0 }]);
  });
});

describe('GET /files/list-client-tasks: tenancy and access', () => {
  it("gives another firm's owner nothing for this firm's client", async () => {
    await clientTaskWithFiles('Private matter prep', ['Secret.pdf']);
    const otherFirm = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(otherFirm.id);

    const throughThisFirm = await otherOwner.api.get(url(clientId));
    expect(throughThisFirm.status).toBe(403);
    expect(JSON.stringify(throughThisFirm.body)).not.toContain('Private matter prep');

    const throughOwnFirm = await otherOwner.api.get(url(clientId, otherFirm.id));
    expect(throughOwnFirm.status).toBe(200);
    expect(throughOwnFirm.body.tasks).toEqual([]);
  });

  it('answers any member of the firm, as a standalone task is visible firm-wide', async () => {
    await clientTaskWithFiles('Firm-wide', ['Doc.pdf']);
    // `files.view` sits in the baseline every role carries, so a plain member
    // is the narrowest caller there is. An owner-only gate would refuse them.
    const member = await memberWith(firm.id, []);

    const res = await member.api.get(url(clientId));
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: any) => t.title)).toEqual(['Firm-wide']);
  });

  it('refuses a clientId that is not an id', async () => {
    const res = await owner.api.get(url('not-a-uuid'));
    expect(res.status).toBe(400);
  });
});
