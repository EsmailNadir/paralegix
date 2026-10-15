/**
 * Deleting a task or a matter through the route: what goes with it, what must
 * stay, and what must never be touched.
 *
 * A parent owns the rows that hang off it (notes, replies, subtasks, assignees,
 * links) and none of the rows it merely points at (the client, a sibling parent,
 * a file in the matter's tree). Money against it is the sharp edge: a task's
 * time entry must outlive the task with `source_task_id` cleared, because the
 * foreign key is `set null`. If it ever flips to `cascade`, deleting a task
 * silently deletes billable time; if it flips to `restrict`, the delete fails
 * with a 500.
 *
 * The cases are `describe.each` over adapters so every parent is held to the
 * same six assertions, and so a client adapter can be appended without
 * restating them. The client half lives in `clientDeletionGraph.test.ts`; the
 * matter's listener-driven half (files, share links, notifications, storage)
 * stays in `tests/events/deleteCascades.test.ts` and `matterDeletionCascade`
 * covers its document requests, contacts and conversations. A matter carrying
 * billing or trust records is refused by the service, so the matter graph here
 * has none.
 *
 * What has to break for a case to go red:
 *   - children gone: drop a delete or flip a cascade FK to restrict.
 *   - survivors: widen a delete past its own parent id, so a sibling or a
 *     client is lost.
 *   - the second firm: lose the `law_firm_id` scope on any delete (fingerprint).
 *   - the time entry: flip `activities.source_task_id` to cascade or restrict.
 *   - the repeat delete: stop answering 404 for a row that is already gone.
 */
import { randomUUID } from 'crypto';
import { installInMemoryBucket } from '../support/inMemoryBucket';
import { firmFingerprint } from '../support/idSweep';
import { rootOf, seedFile } from '../files/fileWorld';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

interface Ref { table: string; col: string; id: string }

interface Graph {
  /** The id the route deletes. */
  id: string;
  /** Rows that must be gone once the parent is. */
  children: Ref[];
  /** Rows that must still exist: what the parent points at, plus a sibling parent. */
  survivors: Ref[];
  /** A time entry that must survive with its task link cleared (tasks only). */
  timeEntryId?: string;
}

interface Adapter {
  name: string;
  /** One complete graph in `firm`, labelled so two graphs in one firm never collide. */
  seed: (firm: Firm, owner: Actor, label: string, sibling?: Graph) => Promise<Graph>;
  url: (firm: Firm, id: string) => string;
  tables: string[];
}

const TASK_TABLES = [
  'tasks', 'task_assignees', 'task_subtasks', 'task_dependencies', 'task_clients', 'notes', 'note_replies',
  'attachments', 'activities', 'matters', 'matter_members', 'matter_clients', 'clients', 'files',
];
const MATTER_TABLES = [
  'matters', 'matter_members', 'matter_clients', 'clients', 'tasks', 'task_assignees', 'task_subtasks',
  'notes', 'note_replies', 'events', 'event_assignees',
];

async function insert(sql: string, params: unknown[]): Promise<string> {
  const res = await testPool.query(`${sql} returning id`, params);
  expect(res.rowCount).toBe(1);
  return res.rows[0].id as string;
}

async function seedMatterRow(firm: Firm, owner: Actor, label: string, clientId: string) {
  const id = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [id, firm.id, `${label} matter`, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [firm.id, id, owner.uid],
  );
  await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)',
    [firm.id, id, clientId],
  );
  return id;
}

/** A task with one row in every table that hangs off a task. */
function taskAdapter(onMatter: boolean): Adapter {
  return {
    name: onMatter ? 'a task on a matter' : 'a firm-wide task',
    tables: TASK_TABLES,
    url: (firm, id) => `/api/lawfirms/${firm.id}/tasks/${id}`,
    async seed(firm, owner, label, sibling) {
      const client = await createPersonClient(firm.id, { name: `${label} client` });
      const matterId = onMatter ? await seedMatterRow(firm, owner, label, client.id) : null;
      const taskId = await insert(
        'insert into tasks (law_firm_id, matter_id, title) values ($1, $2, $3)',
        [firm.id, matterId, `${label} task`],
      );
      // A second task in the same scope: it survives, and it is what `taskId` depends on.
      const otherTaskId = await insert(
        'insert into tasks (law_firm_id, matter_id, title) values ($1, $2, $3)',
        [firm.id, matterId, `${label} other task`],
      );
      await testPool.query(
        'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
        [firm.id, taskId, owner.uid],
      );
      await testPool.query(
        'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
        [firm.id, otherTaskId, owner.uid],
      );
      const subtaskId = await insert(
        'insert into task_subtasks (law_firm_id, task_id, title) values ($1, $2, $3)',
        [firm.id, taskId, `${label} subtask`],
      );
      await testPool.query(
        'insert into task_dependencies (law_firm_id, task_id, depends_on_task_id) values ($1, $2, $3)',
        [firm.id, taskId, otherTaskId],
      );
      // A matter task derives its clients from the matter; a firm-wide one holds them itself.
      if (!onMatter) {
        await testPool.query(
          'insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)',
          [firm.id, taskId, client.id],
        );
      }
      const noteId = await insert(
        'insert into notes (law_firm_id, task_id, content, created_by) values ($1, $2, $3, $4)',
        [firm.id, taskId, `${label} note`, owner.uid],
      );
      const replyId = await insert(
        'insert into note_replies (law_firm_id, note_id, content, created_by) values ($1, $2, $3, $4)',
        [firm.id, noteId, `${label} reply`, owner.uid],
      );
      const children: Ref[] = [
        { table: 'tasks', col: 'id', id: taskId },
        { table: 'task_assignees', col: 'task_id', id: taskId },
        { table: 'task_subtasks', col: 'id', id: subtaskId },
        { table: 'task_dependencies', col: 'task_id', id: taskId },
        { table: 'notes', col: 'id', id: noteId },
        { table: 'note_replies', col: 'id', id: replyId },
      ];
      if (!onMatter) children.push({ table: 'task_clients', col: 'task_id', id: taskId });

      const survivors: Ref[] = [
        { table: 'tasks', col: 'id', id: otherTaskId },
        { table: 'task_assignees', col: 'task_id', id: otherTaskId },
        { table: 'clients', col: 'id', id: client.id },
      ];
      if (matterId) survivors.push({ table: 'matters', col: 'id', id: matterId });
      if (sibling) survivors.push(...sibling.children, ...sibling.survivors);

      if (matterId) {
        // A file in the matter's tree attached to the task: the link goes, the file stays.
        const file = await seedFile(firm.id, {
          parentId: await rootOf(firm.id, { matterId }), name: `${label}.pdf`,
        });
        const linkId = await insert(
          'insert into attachments (law_firm_id, file_id, task_id, created_by) values ($1, $2, $3, $4)',
          [firm.id, file.id, taskId, owner.uid],
        );
        children.push({ table: 'attachments', col: 'id', id: linkId });
        survivors.push({ table: 'files', col: 'id', id: file.id });
      }

      const timeEntryId = await insert(
        `insert into activities (kind, law_firm_id, matter_id, client_id, user_id, activity_date, hours,
                                 rate_cents, description, source_task_id)
         values ('time', $1, $2, $3, $4, '2026-05-10', 1, 10000, 'Task work', $5)`,
        [firm.id, matterId, matterId ? null : client.id, owner.uid, taskId],
      );
      return { id: taskId, children, survivors, timeEntryId };
    },
  };
}

/** A matter with notes, a task, an event and its roster links. */
const matterAdapter: Adapter = {
  name: 'a matter',
  tables: MATTER_TABLES,
  url: (firm, id) => `/api/lawfirms/${firm.id}/matters/${id}`,
  async seed(firm, owner, label, sibling) {
    const client = await createPersonClient(firm.id, { name: `${label} client` });
    const matterId = await seedMatterRow(firm, owner, label, client.id);
    const noteId = await insert(
      'insert into notes (law_firm_id, matter_id, content, created_by) values ($1, $2, $3, $4)',
      [firm.id, matterId, `${label} note`, owner.uid],
    );
    const replyId = await insert(
      'insert into note_replies (law_firm_id, note_id, content, created_by) values ($1, $2, $3, $4)',
      [firm.id, noteId, `${label} reply`, owner.uid],
    );
    const taskId = await insert(
      'insert into tasks (law_firm_id, matter_id, title) values ($1, $2, $3)',
      [firm.id, matterId, `${label} task`],
    );
    await testPool.query(
      'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
      [firm.id, taskId, owner.uid],
    );
    const subtaskId = await insert(
      'insert into task_subtasks (law_firm_id, task_id, title) values ($1, $2, $3)',
      [firm.id, taskId, `${label} subtask`],
    );
    const eventId = await insert(
      `insert into events (law_firm_id, matter_id, title, date) values ($1, $2, $3, now())`,
      [firm.id, matterId, `${label} hearing`],
    );
    await testPool.query(
      'insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)',
      [firm.id, eventId, owner.uid],
    );
    const children: Ref[] = [
      { table: 'matters', col: 'id', id: matterId },
      { table: 'matter_members', col: 'matter_id', id: matterId },
      { table: 'matter_clients', col: 'matter_id', id: matterId },
      { table: 'notes', col: 'id', id: noteId },
      { table: 'note_replies', col: 'id', id: replyId },
      { table: 'tasks', col: 'id', id: taskId },
      { table: 'task_assignees', col: 'task_id', id: taskId },
      { table: 'task_subtasks', col: 'id', id: subtaskId },
      { table: 'events', col: 'id', id: eventId },
      { table: 'event_assignees', col: 'event_id', id: eventId },
    ];
    // The client is linked to the matter, not owned by it.
    const survivors: Ref[] = [{ table: 'clients', col: 'id', id: client.id }];
    if (sibling) survivors.push(...sibling.children, ...sibling.survivors);
    return { id: matterId, children, survivors };
  },
};

const ADAPTERS: Adapter[] = [taskAdapter(false), taskAdapter(true), matterAdapter];

const exists = async ({ table, col, id }: Ref) =>
  ((await testPool.query(`select 1 from ${table} where ${col} = $1`, [id])).rowCount ?? 0) > 0;

describe.each(ADAPTERS)('deleting $name through the route', (adapter) => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let rivalOwner: Actor;
  let doomed: Graph;
  let keeper: Graph;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    rivalOwner = await ownerOf(rival.id);
    // The sibling is seeded first so the doomed graph can depend on it.
    keeper = await adapter.seed(firm, owner, 'Keeper');
    doomed = await adapter.seed(firm, owner, 'Doomed', keeper);
    await adapter.seed(rival, rivalOwner, 'Rival');
    await drainEvents();
  });

  it('removes the parent and every row that hangs off it', async () => {
    // First, so the absences below are only meaningful once the rows are proven to exist.
    for (const ref of doomed.children) expect(await exists(ref)).toBe(true);

    const res = await owner.api.delete(adapter.url(firm, doomed.id));
    await drainEvents();

    expect(res.status).toBe(200);
    for (const ref of doomed.children) expect({ ...ref, present: await exists(ref) }).toEqual({ ...ref, present: false });
  });

  it('leaves what it points at, and a sibling parent with its whole graph, untouched', async () => {
    const before = await Promise.all(doomed.survivors.map(exists));
    expect(before.every(Boolean)).toBe(true);

    const res = await owner.api.delete(adapter.url(firm, doomed.id));
    await drainEvents();

    expect(res.status).toBe(200);
    for (const ref of doomed.survivors) expect({ ...ref, present: await exists(ref) }).toEqual({ ...ref, present: true });
    for (const ref of keeper.children) expect({ ...ref, present: await exists(ref) }).toEqual({ ...ref, present: true });
  });

  it("changes nothing in another firm's data", async () => {
    const before = await firmFingerprint(adapter.tables, rival.id);

    const res = await owner.api.delete(adapter.url(firm, doomed.id));
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await firmFingerprint(adapter.tables, rival.id)).toEqual(before);
  });

  it('answers 404 the second time, and removes nothing more', async () => {
    expect((await owner.api.delete(adapter.url(firm, doomed.id))).status).toBe(200);
    await drainEvents();
    const afterFirst = await firmFingerprint(adapter.tables, firm.id);

    const again = await owner.api.delete(adapter.url(firm, doomed.id));

    expect(again.status).toBe(404);
    expect(await firmFingerprint(adapter.tables, firm.id)).toEqual(afterFirst);
  });

  it('refuses a caller from another firm and deletes nothing', async () => {
    const before = await firmFingerprint(adapter.tables, firm.id);

    const res = await rivalOwner.api.delete(`/api/lawfirms/${rival.id}${adapter.url(firm, doomed.id).replace(`/api/lawfirms/${firm.id}`, '')}`);

    expect(res.status).toBe(404);
    expect(await firmFingerprint(adapter.tables, firm.id)).toEqual(before);
  });

  // Only a task has a time entry pointing at it; a matter carrying billing is
  // refused by the service, so the matter adapter seeds none.
  if (adapter !== matterAdapter) {
    it('keeps a task time entry and clears its link to the task, rather than losing the time', async () => {
      const before = await testPool.query('select hours, source_task_id from activities where id = $1', [doomed.timeEntryId]);
      expect(before.rows[0].source_task_id).toBe(doomed.id);

      const res = await owner.api.delete(adapter.url(firm, doomed.id));
      await drainEvents();

      expect(res.status).toBe(200);
      const after = await testPool.query('select hours, source_task_id from activities where id = $1', [doomed.timeEntryId]);
      expect(after.rows).toEqual([{ hours: before.rows[0].hours, source_task_id: null }]);
    });
  }
});
