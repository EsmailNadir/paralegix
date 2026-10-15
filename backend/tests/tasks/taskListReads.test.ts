/**
 * The JOIN-heavy read paths of `tasks.repository.ts`: the paged grid, the
 * ids-only "select all" read, the status counts and the picker typeahead.
 *
 * `tasks.repository.ts` was at 48.43%, and the uncovered half is read code
 * sitting under the second-busiest screen in the product. What makes it worth a
 * suite of its own is stated in the module's own header, and in the table
 * inventory: A TASK STORES ALMOST NOTHING ABOUT ITSELF.
 *
 *   assignedTo / assignedToName   <- task_assignees JOIN users
 *   dependencies / dependents     <- task_dependencies, read in both directions
 *   clientIds / clientNames       <- matter_clients for a matter task,
 *                                    task_clients for a firm-wide one
 *   visibleToUserIds              <- matter_members, or every firm member
 *   matterName / courtName / …    <- plain joins
 *
 * Ten lateral joins reassemble that on every read, and every one of them can
 * come back empty without anything raising. A task whose assignee lateral
 * returns nothing is not an error on screen; it is a task that looks unassigned.
 * Worse, the client and visibility fields are a `case when t.matter_id is null`
 * pair: swapping the two branches gives a matter task the clients somebody once
 * attached to it directly instead of the matter's real clients, and the screen
 * still renders a plausible name.
 *
 * The junctions are written with replace-set semantics (delete-then-insert
 * inside a transaction), so a replace that half-applies leaves a task assigned
 * to the wrong person, again with nothing looking broken. The derived-field
 * cases below assert the exact set, never just "not empty".
 *
 * SEARCH IS `ILIKE '%term%'`, not full-text search. The `tsvector` column this
 * table used to carry was dropped in migration 0140. The search cases match from
 * the MIDDLE of a word and pin `%` and `_` as literal characters, so a return to
 * full-text search or to prefix matching turns them red.
 *
 * FILTERS ARE APPLIED BEFORE THE PAGE IS CUT. `findVisibleToUserPaged` filters,
 * sorts and windows inside a CTE over the bare `tasks` table, then joins the
 * enrichment onto the surviving ids. A filter that moved after the LIMIT would
 * return a short page and a wrong total, and a user would just see fewer tasks
 * than they have. Every filter case asserts the page contents AND `totalTasks`.
 *
 * ORDERING FIXTURES ARE DELIBERATELY REVERSE-ALPHABETICAL to the expected
 * result. A sort case whose fixtures already sit in the expected order passes
 * against any ordering at all, including none.
 *
 * A second firm is seeded with colliding names before the reads that could leak,
 * so an exact-set assertion doubles as a tenancy assertion.
 *
 * Fixtures are plain SQL through the test pool. A task seeded through the
 * repository under test could not expose a bug in it, because the same broken
 * code would produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
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

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A, so `seeAll` is on
let bob: Actor;     // owner at firm B, owns the decoys

const LIST = () => `/api/lawfirms/${firmA.id}/tasks`;
const IDS = () => `/api/lawfirms/${firmA.id}/tasks/ids`;
const LOOKUP = () => `/api/lawfirms/${firmA.id}/tasks/lookup`;
const COUNTS = () => `/api/lawfirms/${firmA.id}/tasks/status-counts`;

interface TaskSeed {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  matterId?: string | null;
  practiceAreaId?: string | null;
  courtId?: string | null;
  createdBy?: string | null;
  createdAt?: string;
}

/**
 * A task row, straight into the table.
 *
 * The row-count assertion catches a seed rejected by the composite
 * `(law_firm_id, matter_id)` foreign key, which is otherwise invisible until a
 * list assertion comes back one row short and blames the read.
 */
async function seedTask(lawFirmId: string, seed: TaskSeed = {}): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks
       (id, law_firm_id, title, description, status, priority, due_date,
        matter_id, practice_area_id, court_id, created_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
     returning id`,
    [
      id, lawFirmId,
      seed.title ?? `Task ${id.slice(0, 8)}`,
      seed.description ?? null,
      seed.status ?? 'open',
      seed.priority ?? 'medium',
      seed.dueDate ?? null,
      seed.matterId ?? null,
      seed.practiceAreaId ?? null,
      seed.courtId ?? null,
      seed.createdBy ?? null,
      seed.createdAt ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedAssignee(taskId: string, userId: string): Promise<void> {
  const res = await testPool.query(
    `insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`, [taskId, userId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedTaskClient(taskId: string, clientId: string): Promise<void> {
  const res = await testPool.query(
    `insert into task_clients (law_firm_id, task_id, client_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`, [taskId, clientId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  const res = await testPool.query(
    `insert into task_dependencies (law_firm_id, task_id, depends_on_task_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
    [taskId, dependsOnTaskId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedSubtask(
  lawFirmId: string, taskId: string, title: string, isCompleted: boolean,
): Promise<void> {
  const res = await testPool.query(
    `insert into task_subtasks (id, law_firm_id, task_id, title, is_completed)
     values ($1,$2,$3,$4,$5)`,
    [randomUUID(), lawFirmId, taskId, title, isCompleted],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * A matter, optionally with a caller-chosen id.
 *
 * The id is settable because the matter-name sort case has to pin the ids in the
 * OPPOSITE order to the names. With random uuids that comparison is a coin flip,
 * and a sort keyed on the raw `matter_id` column passes roughly half the time.
 */
async function seedMatter(
  lawFirmId: string, name: string, memberUids: string[] = [], fixedId?: string,
): Promise<string> {
  const id = fixedId ?? randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1,$2,$3,$4,'active') returning id`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  for (const uid of memberUids) {
    const member = await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1,$2,$3,'member', now())`,
      [lawFirmId, id, uid],
    );
    expect(member.rowCount).toBe(1);
  }
  return id;
}

async function seedMatterClient(lawFirmId: string, matterId: string, clientId: string): Promise<void> {
  const res = await testPool.query(
    `insert into matter_clients (law_firm_id, matter_id, client_id) values ($1,$2,$3)`,
    [lawFirmId, matterId, clientId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedCourt(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into courts (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

/**
 * Plant a task at the OTHER firm carrying the title, description or client name
 * the test is about to search for.
 *
 * The list, the four search UNION arms, the ids read and the typeahead are
 * separate SQL statements, each responsible for its own `law_firm_id` predicate.
 * A decoy turns the exact-set assertion that follows into a tenancy assertion.
 */
async function decoyTask(seed: TaskSeed & { clientName?: string } = {}): Promise<string> {
  const id = await seedTask(firmB.id, seed);
  if (seed.clientName) {
    const client = await createPersonClient(firmB.id, { name: seed.clientName });
    await seedTaskClient(id, client.id);
  }
  return id;
}

const titlesOf = (body: any): string[] => body.tasks.map((t: any) => t.title);

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  bob = await ownerOf(firmB.id);
});

describe('derived fields', () => {
  it('derives several assignees and keeps their names aligned with their ids', async () => {
    // The uids are in the OPPOSITE order to the names, and both arrays are
    // aggregated `order by ta.user_id`. Reading a name against the wrong id is
    // the failure that puts somebody else's name on your task, and it is
    // invisible on screen because both values are real.
    await createFirmMember(firmA.id, { uid: 'uid-a', name: 'Zoe Abbott' });
    await createFirmMember(firmA.id, { uid: 'uid-b', name: 'Nina Marsh' });
    await createFirmMember(firmA.id, { uid: 'uid-c', name: 'Adam Wren' });
    const taskId = await seedTask(firmA.id, { title: 'Three Assignee Task' });
    for (const uid of ['uid-c', 'uid-a', 'uid-b']) await seedAssignee(taskId, uid);

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toEqual(['uid-a', 'uid-b', 'uid-c']);
    expect(res.body.assignedToName).toEqual(['Zoe Abbott', 'Nina Marsh', 'Adam Wren']);
  });

  it('takes a FIRM-scoped task clients from task_clients', async () => {
    const taskId = await seedTask(firmA.id, { title: 'Firm Wide Task', matterId: null });
    const zephyr = await createPersonClient(firmA.id, { name: 'Zephyr Holdings' });
    const ainsley = await createPersonClient(firmA.id, { name: 'Ainsley Group' });
    await seedTaskClient(taskId, zephyr.id);
    await seedTaskClient(taskId, ainsley.id);

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.clientIds.sort()).toEqual([ainsley.id, zephyr.id].sort());
    expect(res.body.clientNames.sort()).toEqual(['Ainsley Group', 'Zephyr Holdings']);
  });

  it('takes a MATTER-scoped task clients from the MATTER, ignoring any task_clients rows', async () => {
    // Both junctions are populated, with different clients, so this pins the
    // `case when t.matter_id is null` branch rather than merely proving one
    // lateral works. Flipping the branch shows the matter's task carrying a
    // client the matter has nothing to do with, and the name still renders.
    const matterClient = await createPersonClient(firmA.id, { name: 'Matter Side Client' });
    const strayClient = await createPersonClient(firmA.id, { name: 'Stray Task Client' });
    const matterId = await seedMatter(firmA.id, 'Client Bearing Matter', [alice.uid]);
    await seedMatterClient(firmA.id, matterId, matterClient.id);
    const taskId = await seedTask(firmA.id, { title: 'Matter Task', matterId });
    await seedTaskClient(taskId, strayClient.id);

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.clientIds).toEqual([matterClient.id]);
    expect(res.body.clientNames).toEqual(['Matter Side Client']);
  });

  it('makes a matter task visible to the matter members and a firm task visible to the firm', async () => {
    // The same `case when t.matter_id is null` split, on the visibility array
    // this time. A matter task that reported the whole firm as its audience
    // would put confidential work in front of people outside the matter.
    const insider = await createFirmMember(firmA.id, { uid: 'inside-uid', name: 'Inside Member' });
    await createFirmMember(firmA.id, { uid: 'outside-uid', name: 'Outside Member' });
    const matterId = await seedMatter(firmA.id, 'Walled Matter', [insider.uid]);
    const matterTask = await seedTask(firmA.id, { title: 'Walled Task', matterId });
    const firmTask = await seedTask(firmA.id, { title: 'Open Task', matterId: null });

    const walled = await alice.api.get(`${LIST()}/${matterTask}`);
    expect(walled.status).toBe(200);
    expect(walled.body.visibleToUserIds).toEqual(['inside-uid']);

    const open = await alice.api.get(`${LIST()}/${firmTask}`);
    expect(open.status).toBe(200);
    expect(open.body.visibleToUserIds.sort())
      .toEqual([alice.uid, 'inside-uid', 'outside-uid'].sort());
  });

  it('reads the dependency edge in BOTH directions from one junction row', async () => {
    // `dependencies` and `dependents` come from the same table read the two ways
    // round. Swapping the two laterals produces a graph that looks populated and
    // points the wrong way, so the UI shows a task blocked by the thing it is
    // actually blocking.
    const blocking = await seedTask(firmA.id, { title: 'Blocking Task' });
    const blocked = await seedTask(firmA.id, { title: 'Blocked Task' });
    await seedDependency(blocked, blocking);

    const downstream = await alice.api.get(`${LIST()}/${blocked}`);
    expect(downstream.status).toBe(200);
    expect(downstream.body.dependencies).toEqual([blocking]);
    expect(downstream.body.dependents).toEqual([]);

    const upstream = await alice.api.get(`${LIST()}/${blocking}`);
    expect(upstream.status).toBe(200);
    expect(upstream.body.dependents).toEqual([blocked]);
    expect(upstream.body.dependencies).toEqual([]);
  });

  it('flags a task whose dependency is still open, and clears the flag once it completes', async () => {
    // `hasIncompleteDependencies` is what greys out "start this task". Reported
    // as false while a blocker is open, the UI invites work that cannot proceed.
    const blockingOpen = await seedTask(firmA.id, { title: 'Open Blocker', status: 'open' });
    const blockingDone = await seedTask(firmA.id, { title: 'Done Blocker', status: 'completed' });
    const waitingOnOpen = await seedTask(firmA.id, { title: 'Waiting On Open' });
    const waitingOnDone = await seedTask(firmA.id, { title: 'Waiting On Done' });
    await seedDependency(waitingOnOpen, blockingOpen);
    await seedDependency(waitingOnDone, blockingDone);

    const blockedRes = await alice.api.get(`${LIST()}/${waitingOnOpen}`);
    expect(blockedRes.status).toBe(200);
    expect(blockedRes.body.hasIncompleteDependencies).toBe(true);

    const clearRes = await alice.api.get(`${LIST()}/${waitingOnDone}`);
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.hasIncompleteDependencies).toBe(false);
  });

  it('counts subtasks and incomplete subtasks separately', async () => {
    const taskId = await seedTask(firmA.id, { title: 'Subtasked Task' });
    await seedSubtask(firmA.id, taskId, 'Done One', true);
    await seedSubtask(firmA.id, taskId, 'Done Two', true);
    await seedSubtask(firmA.id, taskId, 'Still Open', false);
    // A second task's subtasks must not be counted into the first.
    const otherId = await seedTask(firmA.id, { title: 'Other Subtasked Task' });
    await seedSubtask(firmA.id, otherId, 'Unrelated', false);

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.subtaskCount).toBe(3);
    expect(res.body.incompleteSubtaskCount).toBe(1);
  });

  it('resolves matter, practice area, court and creator NAMES through joins', async () => {
    // Four separate LEFT JOINs, none of them stored on the task. Losing one
    // leaves a blank column rather than an error.
    const creator = await createFirmMember(firmA.id, { uid: 'creator-uid', name: 'Wendell Frost' });
    const practiceAreaId = await seedPracticeArea(firmA.id, 'Appellate Practice');
    const courtId = await seedCourt(firmA.id, 'Ninth Circuit');
    const matterId = await seedMatter(firmA.id, 'Host Matter', [alice.uid]);
    const taskId = await seedTask(firmA.id, {
      title: 'Fully Joined Task', matterId, practiceAreaId, courtId, createdBy: creator.uid,
    });

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.matterName).toBe('Host Matter');
    expect(res.body.practiceAreaName).toBe('Appellate Practice');
    expect(res.body.courtName).toBe('Ninth Circuit');
    expect(res.body.createdByName).toBe('Wendell Frost');
  });

  it('gives empty arrays, not nulls, to a task with no assignees, clients or dependencies', async () => {
    // The `coalesce(..., '{}')` wrappers are what stop a bare task arriving with
    // null arrays and breaking every `.map()` downstream.
    const taskId = await seedTask(firmA.id, { title: 'Bare Task' });

    const res = await alice.api.get(`${LIST()}/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toEqual([]);
    expect(res.body.assignedToName).toEqual([]);
    expect(res.body.clientIds).toEqual([]);
    expect(res.body.dependencies).toEqual([]);
    expect(res.body.dependents).toEqual([]);
    expect(res.body.hasIncompleteDependencies).toBe(false);
    expect(res.body.subtaskCount).toBe(0);
  });

  it('carries the derived fields through the PAGED list, not only the detail read', async () => {
    // The list uses a different SELECT from the detail read: the paging CTE picks
    // the ids and the enrichment joins onto them. The enrichment can be lost on
    // that path alone, and the grid then shows every task unassigned.
    const assignee = await createFirmMember(firmA.id, { uid: 'grid-uid', name: 'Grid Person' });
    const client = await createPersonClient(firmA.id, { name: 'Grid Client' });
    const taskId = await seedTask(firmA.id, { title: 'Grid Task' });
    await seedAssignee(taskId, assignee.uid);
    await seedTaskClient(taskId, client.id);

    const res = await alice.api.get(`${LIST()}?limit=10`);
    expect(res.status).toBe(200);
    const task = res.body.tasks.find((t: any) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task.assignedTo).toEqual([assignee.uid]);
    expect(task.assignedToName).toEqual(['Grid Person']);
    expect(task.clientNames).toEqual(['Grid Client']);
  });
});

describe('filtering combined with paging', () => {
  it('applies the assignee filter BEFORE cutting the page', async () => {
    // Three assigned and three not, page size two. A filter applied after the
    // LIMIT hands back one row while reporting six matches.
    const target = await createFirmMember(firmA.id, { uid: 'target-uid', name: 'Target Person' });
    const other = await createFirmMember(firmA.id, { uid: 'other-uid', name: 'Other Person' });
    for (const n of [1, 2, 3]) {
      const mine = await seedTask(firmA.id, { title: `Mine ${n}` });
      await seedAssignee(mine, target.uid);
      const theirs = await seedTask(firmA.id, { title: `Theirs ${n}` });
      await seedAssignee(theirs, other.uid);
    }

    const first = await alice.api.get(`${LIST()}?assignee=${target.uid}&limit=2&page=1`);
    expect(first.status).toBe(200);
    expect(first.body.tasks).toHaveLength(2);
    expect(first.body.totalTasks).toBe(3);
    expect(first.body.tasks.every((t: any) => t.assignedTo.includes(target.uid))).toBe(true);

    const second = await alice.api.get(`${LIST()}?assignee=${target.uid}&limit=2&page=2`);
    expect(second.body.tasks).toHaveLength(1);
    expect(second.body.totalTasks).toBe(3);
    expect(second.body.tasks[0].assignedTo).toEqual([target.uid]);
  });

  it('treats status=active as "not completed", spanning open, in_progress and blocked', async () => {
    // `active` is a filter-only sentinel. Resolving it to a single real status
    // would silently hide in-progress and blocked work that is still due, which
    // is the whole point of the outstanding-work view.
    await seedTask(firmA.id, { title: 'Open One', status: 'open' });
    await seedTask(firmA.id, { title: 'In Progress One', status: 'in_progress' });
    await seedTask(firmA.id, { title: 'Blocked One', status: 'blocked' });
    await seedTask(firmA.id, { title: 'Completed One', status: 'completed' });

    const res = await alice.api.get(`${LIST()}?status=active&limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.totalTasks).toBe(3);
    expect(titlesOf(res.body).sort()).toEqual(['Blocked One', 'In Progress One', 'Open One']);
  });

  it('filters by priority across a page boundary and counts the filtered set', async () => {
    for (const n of [1, 2, 3]) {
      await seedTask(firmA.id, { title: `Urgent ${n}`, priority: 'urgent' });
      await seedTask(firmA.id, { title: `Low ${n}`, priority: 'low' });
    }

    const res = await alice.api.get(`${LIST()}?priority=urgent&limit=2&page=1`);
    expect(res.status).toBe(200);
    expect(res.body.totalTasks).toBe(3);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks.every((t: any) => t.priority === 'urgent')).toBe(true);
  });

  it('reports the true total for a page PAST the last match', async () => {
    // An empty page carries no `count(*) over()` row, so the total comes from the
    // fallback count. Without it the caller is told zero and renders "no tasks"
    // instead of clamping its page number.
    for (const n of [1, 2, 3]) await seedTask(firmA.id, { title: `Ranged ${n}` });

    const res = await alice.api.get(`${LIST()}?limit=2&page=9`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.totalTasks).toBe(3);
  });

  it('narrows to one matter, and to the matter-less tasks with matterId=none', async () => {
    const matterId = await seedMatter(firmA.id, 'Scoping Matter', [alice.uid]);
    await seedTask(firmA.id, { title: 'On The Matter', matterId });
    await seedTask(firmA.id, { title: 'Firm Wide One', matterId: null });
    await seedTask(firmA.id, { title: 'Firm Wide Two', matterId: null });

    const scoped = await alice.api.get(`${LIST()}?matterId=${matterId}&limit=10`);
    expect(scoped.status).toBe(200);
    expect(titlesOf(scoped.body)).toEqual(['On The Matter']);
    expect(scoped.body.totalTasks).toBe(1);

    const unscoped = await alice.api.get(`${LIST()}?matterId=none&limit=10`);
    expect(unscoped.status).toBe(200);
    expect(titlesOf(unscoped.body).sort()).toEqual(['Firm Wide One', 'Firm Wide Two']);
    expect(unscoped.body.totalTasks).toBe(2);
  });

  it('finds a client tasks through BOTH junctions: its own and its matters', async () => {
    // The clientId predicate has two arms, `task_clients` and `matter_clients`.
    // A client-detail Tasks tab that lost the matter arm would show the client's
    // ad-hoc tasks and none of the work actually done on their matter.
    const client = await createPersonClient(firmA.id, { name: 'Dual Path Client' });
    const otherClient = await createPersonClient(firmA.id, { name: 'Unrelated Client' });
    const matterId = await seedMatter(firmA.id, 'Their Matter', [alice.uid]);
    await seedMatterClient(firmA.id, matterId, client.id);
    const direct = await seedTask(firmA.id, { title: 'Direct Task' });
    await seedTaskClient(direct, client.id);
    await seedTask(firmA.id, { title: 'Via Matter Task', matterId });
    const unrelated = await seedTask(firmA.id, { title: 'Unrelated Task' });
    await seedTaskClient(unrelated, otherClient.id);

    const res = await alice.api.get(`${LIST()}?clientId=${client.id}&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body).sort()).toEqual(['Direct Task', 'Via Matter Task']);
    expect(res.body.totalTasks).toBe(2);
  });

  it('keeps the membership wall in front of the filter, and counts only what the member sees', async () => {
    // A member is not an owner, so `seeAll` is off and the read carries the
    // matter-membership EXISTS. Firm-wide tasks stay visible to everyone; a
    // matter task does not.
    const member = await memberWith(firmA.id, ['tasks.view']);
    const mine = await seedMatter(firmA.id, 'Mine Matter', [member.uid]);
    const theirs = await seedMatter(firmA.id, 'Theirs Matter', [alice.uid]);
    await seedTask(firmA.id, { title: 'On My Matter', matterId: mine, status: 'open' });
    await seedTask(firmA.id, { title: 'On Their Matter', matterId: theirs, status: 'open' });
    await seedTask(firmA.id, { title: 'Firm Wide', matterId: null, status: 'open' });

    const res = await member.api.get(`${LIST()}?status=open&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body).sort()).toEqual(['Firm Wide', 'On My Matter']);
    expect(res.body.totalTasks).toBe(2);
  });
});

describe('sorting', () => {
  it('sorts by title ascending, against both insertion and creation order', async () => {
    // Created oldest-first in alphabetical order, so title asc differs from
    // creation order, and the tiebreaker (created_at desc) cannot produce this
    // sequence on its own.
    await seedTask(firmA.id, { title: 'Ainsley Filing', createdAt: '2026-01-01T00:00:00Z' });
    await seedTask(firmA.id, { title: 'Marlow Filing', createdAt: '2026-02-01T00:00:00Z' });
    await seedTask(firmA.id, { title: 'Zephyr Filing', createdAt: '2026-03-01T00:00:00Z' });

    const asc = await alice.api.get(`${LIST()}?sortBy=title&order=asc&limit=10`);
    expect(asc.status).toBe(200);
    expect(titlesOf(asc.body)).toEqual(['Ainsley Filing', 'Marlow Filing', 'Zephyr Filing']);

    const desc = await alice.api.get(`${LIST()}?sortBy=title&order=desc&limit=10`);
    expect(titlesOf(desc.body)).toEqual(['Zephyr Filing', 'Marlow Filing', 'Ainsley Filing']);
  });

  it('puts a task with NO due date last when sorting due date descending', async () => {
    // Postgres defaults DESC to NULLS FIRST, so the explicit `nulls last` is the
    // only thing keeping undated tasks off the top of the grid. Dropping it puts
    // the task nobody scheduled above the deadline that is closest.
    await seedTask(firmA.id, { title: 'Due Later', dueDate: '2026-09-01' });
    await seedTask(firmA.id, { title: 'Due Sooner', dueDate: '2026-08-01' });
    await seedTask(firmA.id, { title: 'Undated', dueDate: null });

    const res = await alice.api.get(`${LIST()}?sortBy=dueDate&order=desc&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Due Later', 'Due Sooner', 'Undated']);
  });

  it('sorts by assignee NAME rather than by assignee id', async () => {
    // The uids run in the OPPOSITE order to the names. Sorting the raw
    // `task_assignees.user_id` instead of the joined `users.name` reverses this,
    // and on screen it merely looks like an unfamiliar order.
    const zena = await createFirmMember(firmA.id, { uid: 'aaa-assignee', name: 'Zena Abel' });
    const abel = await createFirmMember(firmA.id, { uid: 'zzz-assignee', name: 'Abel Quinn' });
    const zenaTask = await seedTask(firmA.id, { title: 'Assigned To Zena' });
    const abelTask = await seedTask(firmA.id, { title: 'Assigned To Abel' });
    await seedAssignee(zenaTask, zena.uid);
    await seedAssignee(abelTask, abel.uid);

    const res = await alice.api.get(`${LIST()}?sortBy=assignedTo&order=asc&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Assigned To Abel', 'Assigned To Zena']);
  });

  it('sorts by matter NAME rather than by matter id', async () => {
    // The ids run in the OPPOSITE order to the names, and they are fixed rather
    // than random for exactly that reason: against random uuids a sort keyed on
    // the raw `matter_id` column agrees with the name order half the time, so the
    // case would pass against the wrong implementation on a coin flip.
    const zephyr = await seedMatter(
      firmA.id, 'Zephyr Matter', [alice.uid], '00000000-0000-4000-8000-000000000001',
    );
    const ainsley = await seedMatter(
      firmA.id, 'Ainsley Matter', [alice.uid], 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
    await seedTask(firmA.id, { title: 'On Zephyr', matterId: zephyr });
    await seedTask(firmA.id, { title: 'On Ainsley', matterId: ainsley });

    const res = await alice.api.get(`${LIST()}?sortBy=matterId&order=asc&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['On Ainsley', 'On Zephyr']);
  });

  it('applies a multi-column sort model in the order given', async () => {
    // `priority asc` groups, `title desc` orders within the group. Neither column
    // alone produces this sequence, so a model that honours only one entry fails.
    await seedTask(firmA.id, { title: 'Alpha', priority: 'low' });
    await seedTask(firmA.id, { title: 'Bravo', priority: 'high' });
    await seedTask(firmA.id, { title: 'Charlie', priority: 'low' });
    await seedTask(firmA.id, { title: 'Delta', priority: 'high' });

    const res = await alice.api.get(`${LIST()}?sort=${encodeURIComponent('priority:asc,title:desc')}&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Delta', 'Bravo', 'Charlie', 'Alpha']);
  });

  it('holds the sort across a page boundary rather than sorting each page alone', async () => {
    // The ORDER BY is applied inside the paging CTE (to choose the page) and
    // again outside it, because the join onto the CTE does not preserve its
    // order. Losing the outer one leaves each page internally shuffled while the
    // page contents still look plausible.
    for (const title of ['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']) {
      await seedTask(firmA.id, { title });
    }

    const p1 = await alice.api.get(`${LIST()}?sortBy=title&order=asc&limit=3&page=1`);
    const p2 = await alice.api.get(`${LIST()}?sortBy=title&order=asc&limit=3&page=2`);
    expect(titlesOf(p1.body)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(titlesOf(p2.body)).toEqual(['Delta', 'Echo']);
  });
});

describe('search', () => {
  it('matches a fragment from the MIDDLE of a title', async () => {
    // `epositio` is neither a prefix of the title nor of any word in it, so a
    // prefix match or a return to `to_tsvector` returns nothing.
    await decoyTask({ title: 'Prepare Deposition Outline' });
    await seedTask(firmA.id, { title: 'Prepare Deposition Outline' });
    await seedTask(firmA.id, { title: 'File Answer' });

    const res = await alice.api.get(`${LIST()}?search=epositio&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Prepare Deposition Outline']);
    expect(res.body.totalTasks).toBe(1);
  });

  it('matches text in the description as well as the title', async () => {
    await seedTask(firmA.id, { title: 'Plain Title', description: 'Chase the Wetherby subpoena' });
    await seedTask(firmA.id, { title: 'Other Title', description: 'Unrelated note' });

    const res = await alice.api.get(`${LIST()}?search=ubpoen&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Plain Title']);
  });

  it('matches a FIRM-scoped task by its linked client name, never another firm client of that name', async () => {
    // Both halves are needed. Without the positive this passes against a client
    // arm that matches nothing; without the decoy it passes against one that has
    // lost its `law_firm_id` pin. `task_clients` carries no law_firm_id of its
    // own, so that pin rides entirely on the joined client row.
    await decoyTask({ title: 'Decoy Task', clientName: 'Ravenscroft Industries' });
    const taskId = await seedTask(firmA.id, { title: 'Titled Nothing Like The Client' });
    const client = await createPersonClient(firmA.id, { name: 'Ravenscroft Industries' });
    await seedTaskClient(taskId, client.id);

    const res = await alice.api.get(`${LIST()}?search=avenscrof&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Titled Nothing Like The Client']);
    expect(res.body.totalTasks).toBe(1);
  });

  it('matches a MATTER-scoped task by the name of a client on its matter', async () => {
    // A separate UNION arm from the one above, joining through `matter_clients`.
    // Losing it makes every matter task unfindable by whose matter it is, which
    // is how a firm most often looks for work.
    const client = await createPersonClient(firmA.id, { name: 'Bartholomew Reyes' });
    const matterId = await seedMatter(firmA.id, 'Matter With A Client', [alice.uid]);
    await seedMatterClient(firmA.id, matterId, client.id);
    await seedTask(firmA.id, { title: 'Draft Motion', matterId });
    await seedTask(firmA.id, { title: 'Unrelated Errand' });

    const res = await alice.api.get(`${LIST()}?search=artholome&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Draft Motion']);
    expect(res.body.totalTasks).toBe(1);
  });

  it('treats % in a search term as a literal percent sign', async () => {
    // "Serve 500 Notices" contains `50` but not `50%`. An unescaped term becomes
    // `%50%%` and matches it too, so this distinguishes an escaped term from an
    // unescaped one rather than merely proving search works.
    await seedTask(firmA.id, { title: 'Negotiate 50% Contingency' });
    await seedTask(firmA.id, { title: 'Serve 500 Notices' });

    const res = await alice.api.get(`${LIST()}?search=${encodeURIComponent('50%')}&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Negotiate 50% Contingency']);
    expect(res.body.totalTasks).toBe(1);
  });

  it('treats _ in a search term as a literal underscore', async () => {
    // `_` is LIKE's single-character wildcard. Unescaped, `t_F` also matches the
    // `tXF` in "ClientXFile", so the second fixture is what fails an unescaped
    // term.
    await seedTask(firmA.id, { title: 'Client_File Review' });
    await seedTask(firmA.id, { title: 'ClientXFile Review' });

    const res = await alice.api.get(`${LIST()}?search=${encodeURIComponent('t_F')}&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Client_File Review']);
    expect(res.body.totalTasks).toBe(1);
  });

  it('is case-insensitive, as ILIKE and not LIKE', async () => {
    await seedTask(firmA.id, { title: 'Deposition Outline' });

    const res = await alice.api.get(`${LIST()}?search=DEPOSITION&limit=10`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['Deposition Outline']);
  });

  it('intersects search with a status filter and pages the intersection', async () => {
    // Six tasks contain "Deposition"; three are completed. The intersection must
    // be counted before the window, not after.
    for (const n of [1, 2, 3]) {
      await seedTask(firmA.id, { title: `Deposition Done ${n}`, status: 'completed' });
      await seedTask(firmA.id, { title: `Deposition Open ${n}`, status: 'open' });
    }
    await seedTask(firmA.id, { title: 'Unrelated Done', status: 'completed' });

    const res = await alice.api.get(`${LIST()}?search=epositio&status=completed&limit=2&page=1`);
    expect(res.status).toBe(200);
    expect(res.body.totalTasks).toBe(3);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks.every((t: any) => t.status === 'completed')).toBe(true);
    expect(res.body.tasks.every((t: any) => t.title.includes('Deposition'))).toBe(true);
  });
});

describe('the ids-only read behind "select all"', () => {
  it('returns every id the SAME filters would list, ignoring the page size', async () => {
    // If this read and the list read disagreed, a bulk complete or delete would
    // act on a different set from the one the user was looking at.
    await decoyTask({ title: 'Decoy Blocked', status: 'blocked' });
    for (const n of [1, 2, 3, 4]) {
      await seedTask(firmA.id, { title: `Blocked ${n}`, status: 'blocked' });
    }
    await seedTask(firmA.id, { title: 'Open One', status: 'open' });

    const ids = await alice.api.get(`${IDS()}?status=blocked`);
    expect(ids.status).toBe(200);
    expect(ids.body.ids).toHaveLength(4);
    expect(ids.body.totalItems).toBe(4);
    expect(ids.body.truncated).toBe(false);

    const list = await alice.api.get(`${LIST()}?status=blocked&limit=50`);
    expect(new Set(ids.body.ids)).toEqual(new Set(list.body.tasks.map((t: any) => t.id)));
  });

  it('honours the search term, and does not reach the other firm', async () => {
    await decoyTask({ title: 'Deposition Decoy' });
    const wanted = await seedTask(firmA.id, { title: 'Deposition Outline' });
    await seedTask(firmA.id, { title: 'Unrelated' });

    const res = await alice.api.get(`${IDS()}?search=epositio`);
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([wanted]);
  });

  it('stops at the tasks a member may see', async () => {
    const member = await memberWith(firmA.id, ['tasks.view']);
    const mine = await seedMatter(firmA.id, 'Mine', [member.uid]);
    const theirs = await seedMatter(firmA.id, 'Theirs', [alice.uid]);
    const visible = await seedTask(firmA.id, { title: 'Visible', matterId: mine });
    await seedTask(firmA.id, { title: 'Hidden', matterId: theirs });

    const res = await member.api.get(IDS());
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([visible]);
  });
});

describe('the tasks of one matter', () => {
  // `GET /tasks/matter/:matterId` admitted owners and admins through the matter
  // read check and then queried through a `matter_members` join, so an admin
  // who was not on the matter got an empty list for a matter whose tasks the
  // firm list and the task detail both showed them. Red if the repository goes
  // back to the membership join for everyone.
  it('shows an owner and an admin every task of a matter they are not a member of', async () => {
    const admin = await memberWith(firmA.id, ['tasks.view', 'members.changeRole']);
    const matter = await seedMatter(firmA.id, 'Walled', []);
    const one = await seedTask(firmA.id, { title: 'One', matterId: matter });
    const two = await seedTask(firmA.id, { title: 'Two', matterId: matter });
    const other = await seedMatter(firmA.id, 'Elsewhere', []);
    await seedTask(firmA.id, { title: 'Other matter', matterId: other });

    for (const who of [alice, admin]) {
      const res = await who.api.get(`${LIST()}/matter/${matter}`);
      expect(res.status).toBe(200);
      expect(res.body.tasks.map((t: any) => t.id).sort()).toEqual([one, two].sort());
      expect(res.body.totalTasks).toBe(2);
    }
  });

  it('still refuses a plain member who is not on the matter, and lists a member their own matter', async () => {
    const member = await memberWith(firmA.id, ['tasks.view']);
    const walled = await seedMatter(firmA.id, 'Walled', []);
    await seedTask(firmA.id, { title: 'Hidden', matterId: walled });
    const mine = await seedMatter(firmA.id, 'Mine', [member.uid]);
    const visible = await seedTask(firmA.id, { title: 'Visible', matterId: mine });

    expect((await member.api.get(`${LIST()}/matter/${walled}`)).status).toBe(403);
    const ok = await member.api.get(`${LIST()}/matter/${mine}`);
    expect(ok.status).toBe(200);
    expect(ok.body.tasks.map((t: any) => t.id)).toEqual([visible]);
  });
});

describe('task analytics visibility', () => {
  // Status counts, the list and the ids read all give firm owners and admins the
  // whole firm. Analytics kept the member scope for everyone, so an owner's
  // analytics page counted fewer tasks than their own list and status counts.
  // Red if analytics drops the see-all branch.
  it('counts every firm task for an owner and only the matters a member is on for a member', async () => {
    const member = await memberWith(firmA.id, ['tasks.view']);
    const mine = await seedMatter(firmA.id, 'Mine', [member.uid]);
    const theirs = await seedMatter(firmA.id, 'Theirs', []);
    await seedTask(firmA.id, { title: 'Firm wide' });
    await seedTask(firmA.id, { title: 'On mine', matterId: mine });
    await seedTask(firmA.id, { title: 'On theirs', matterId: theirs, status: 'completed' });
    await decoyTask({ title: 'Decoy' });

    const analytics = (who: Actor) => who.api.get(`/api/lawfirms/${firmA.id}/tasks/analytics`);
    const asOwner = await analytics(alice);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.summary.total).toBe(3);
    expect(asOwner.body.summary.completed).toBe(1);
    // The same population the status counts report for the owner.
    const counts = await alice.api.get(COUNTS());
    expect(counts.body.total).toBe(3);

    const scoped = await analytics(member);
    expect(scoped.status).toBe(200);
    expect(scoped.body.summary.total).toBe(2);
    expect(scoped.body.summary.completed).toBe(0);
  });
});

describe('status counts', () => {
  it('counts the whole visible set, not the page in front of the user', async () => {
    // The grid shows a windowed page; the tab badges must still say how much work
    // there is. Deriving the badges from the page would understate every one.
    await decoyTask({ title: 'Decoy Open', status: 'open' });
    for (const n of [1, 2, 3, 4, 5]) await seedTask(firmA.id, { title: `Open ${n}`, status: 'open' });
    await seedTask(firmA.id, { title: 'Progressing', status: 'in_progress' });
    await seedTask(firmA.id, { title: 'Blocked', status: 'blocked' });
    await seedTask(firmA.id, { title: 'Done', status: 'completed' });

    const res = await alice.api.get(COUNTS());
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ open: 5, in_progress: 1, blocked: 1, completed: 1 });
    expect(res.body.total).toBe(8);
  });

  it('counts only the tasks a member may see', async () => {
    const member = await memberWith(firmA.id, ['tasks.view']);
    const mine = await seedMatter(firmA.id, 'Mine', [member.uid]);
    const theirs = await seedMatter(firmA.id, 'Theirs', [alice.uid]);
    await seedTask(firmA.id, { title: 'Mine Open', matterId: mine, status: 'open' });
    await seedTask(firmA.id, { title: 'Theirs Open', matterId: theirs, status: 'open' });
    await seedTask(firmA.id, { title: 'Theirs Blocked', matterId: theirs, status: 'blocked' });

    const res = await member.api.get(COUNTS());
    expect(res.status).toBe(200);
    expect(res.body.counts.open).toBe(1);
    expect(res.body.counts.blocked).toBe(0);
    expect(res.body.total).toBe(1);
  });
});

describe('the task picker typeahead', () => {
  it('orders items by title, against creation order', async () => {
    await seedTask(firmA.id, { title: 'Ainsley Pick', createdAt: '2026-01-01T00:00:00Z' });
    await seedTask(firmA.id, { title: 'Marlow Pick', createdAt: '2026-02-01T00:00:00Z' });
    await seedTask(firmA.id, { title: 'Zephyr Pick', createdAt: '2026-03-01T00:00:00Z' });

    const res = await alice.api.get(`${LOOKUP()}?search=Pick`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Ainsley Pick', 'Marlow Pick', 'Zephyr Pick']);
  });

  it('puts the matter name in the sublabel', async () => {
    const matterId = await seedMatter(firmA.id, 'Sublabel Matter', [alice.uid]);
    await seedTask(firmA.id, { title: 'Sublabelled Task', matterId });

    const res = await alice.api.get(`${LOOKUP()}?search=Sublabelled`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].sublabel).toBe('Sublabel Matter');
  });

  it('narrows to one client tasks when scoped by clientId', async () => {
    const wanted = await createPersonClient(firmA.id, { name: 'Scoped Client' });
    const other = await createPersonClient(firmA.id, { name: 'Other Client' });
    const wantedTask = await seedTask(firmA.id, { title: 'Scoped Task' });
    const otherTask = await seedTask(firmA.id, { title: 'Unscoped Task' });
    await seedTaskClient(wantedTask, wanted.id);
    await seedTaskClient(otherTask, other.id);

    const res = await alice.api.get(`${LOOKUP()}?clientId=${wanted.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Scoped Task']);
  });

  it('narrows to one matter tasks when scoped by matterId', async () => {
    // The create/edit task modal's duplicate-title advisory scopes by matterId
    // for exactly this reason: task titles are commonly reused across matters
    // (e.g. "Draft the complaint"), so an unscoped match reads as a false alarm.
    const wanted = await seedMatter(firmA.id, 'Scoped Matter', [alice.uid]);
    const other = await seedMatter(firmA.id, 'Other Matter', [alice.uid]);
    await seedTask(firmA.id, { title: 'Reused Title', matterId: wanted });
    await seedTask(firmA.id, { title: 'Reused Title', matterId: other });

    const res = await alice.api.get(`${LOOKUP()}?exactName=${encodeURIComponent('Reused Title')}&matterId=${wanted}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].sublabel).toBe('Scoped Matter');
  });

  it('returns NOTHING for an unusable matterId rather than every task', async () => {
    // Same "unresolvable scope answers nothing" rule as clientId: falling
    // through to the firm-wide branch would defeat the point of scoping.
    await seedTask(firmA.id, { title: 'First Task' });
    await seedTask(firmA.id, { title: 'Second Task' });

    const res = await alice.api.get(`${LOOKUP()}?matterId=not-a-uuid`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns NOTHING for an unusable clientId rather than every task', async () => {
    // The dangerous failure is the opposite of an error: answering "this client's
    // tasks" with the whole firm. Two tasks exist, so an unscoped fallback shows.
    await seedTask(firmA.id, { title: 'First Task' });
    await seedTask(firmA.id, { title: 'Second Task' });

    const res = await alice.api.get(`${LOOKUP()}?clientId=not-a-uuid`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('resolves ids exactly, and resolves NOTHING for another firm id', async () => {
    // Falling through to the search branch on a stale or foreign id would label
    // a saved selection with an arbitrary task, so the picker would show the
    // wrong one as chosen.
    const mine = await seedTask(firmA.id, { title: 'My Saved Task' });
    await seedTask(firmA.id, { title: 'Some Other Task' });
    const theirs = await decoyTask({ title: 'Their Saved Task' });

    const ok = await alice.api.get(`${LOOKUP()}?ids=${mine}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i: any) => i.label)).toEqual(['My Saved Task']);

    const crossFirm = await alice.api.get(`${LOOKUP()}?ids=${theirs}`);
    expect(crossFirm.status).toBe(200);
    expect(crossFirm.body.items).toEqual([]);

    // A malformed id leaves the filter with nothing to match on. Falling through
    // to the unfiltered branch here would answer with an arbitrary page of tasks,
    // which the picker would then render as the saved selection.
    const malformed = await alice.api.get(`${LOOKUP()}?ids=not-a-uuid`);
    expect(malformed.status).toBe(200);
    expect(malformed.body.items).toEqual([]);
  });

  it('reports hasMore instead of a total, and caps the page', async () => {
    for (const n of [1, 2, 3, 4, 5]) await seedTask(firmA.id, { title: `Capped ${n}` });

    const res = await alice.api.get(`${LOOKUP()}?search=Capped&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.totalTasks).toBeUndefined();
  });

  it('keeps a member inside the ethical wall', async () => {
    const member = await memberWith(firmA.id, ['tasks.view']);
    const mine = await seedMatter(firmA.id, 'Mine', [member.uid]);
    const theirs = await seedMatter(firmA.id, 'Theirs', [alice.uid]);
    await seedTask(firmA.id, { title: 'Walled Mine', matterId: mine });
    await seedTask(firmA.id, { title: 'Walled Theirs', matterId: theirs });

    const res = await member.api.get(`${LOOKUP()}?search=Walled`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label)).toEqual(['Walled Mine']);
  });
});

describe('tenancy on the enriched reads', () => {
  it('does not count another firm tasks in the paged total', async () => {
    // The total comes from a `count(*) over()` inside the paging CTE, a separate
    // predicate from the one the enriched select uses. A leak there shows only as
    // a page count that is too high.
    for (const n of [1, 2, 3, 4, 5]) await decoyTask({ title: `Firm B ${n}` });
    await seedTask(firmA.id, { title: 'Only Firm A Task' });

    const res = await alice.api.get(`${LIST()}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.totalTasks).toBe(1);
    expect(titlesOf(res.body)).toEqual(['Only Firm A Task']);
  });

  it('does not lend another firm client to a task through the junction', async () => {
    // `task_clients` has no `law_firm_id` column, so the only thing keeping a
    // foreign client off a task at read time is the join back through the task's
    // own firm. A row inserted directly into the junction is the exact shape a
    // lost scope would surface.
    const foreignClient = await createPersonClient(firmB.id, { name: 'Firm B Client' });
    const ownClient = await createPersonClient(firmA.id, { name: 'Firm A Client' });
    const taskId = await seedTask(firmA.id, { title: 'Mixed Junction Task' });
    await seedTaskClient(taskId, ownClient.id);
    await seedTaskClient(taskId, foreignClient.id);

    const res = await alice.api.get(`${LIST()}?clientId=${foreignClient.id}&limit=10`);
    // The filter is a uuid the schema accepts, so the refusal has to show as
    // content: no task comes back for another firm's client id.
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.totalTasks).toBe(0);
  });

  it('answers not-found for another firm task, and lists none of them', async () => {
    const foreign = await decoyTask({ title: 'Firm B Task' });

    const detail = await alice.api.get(`${LIST()}/${foreign}`);
    expect(detail.status).toBe(404);

    const list = await alice.api.get(`${LIST()}?limit=50`);
    expect(list.body.tasks).toEqual([]);
  });

  it('refuses a caller who belongs to neither firm', async () => {
    await seedTask(firmA.id, { title: 'Private Task' });
    const outsider = as(tokenFor({ uid: 'outsider-uid' }));

    const res = await outsider.get(`${LIST()}?limit=10`);
    expect(res.status).toBe(403);
  });
});

describe('query validation', () => {
  it('refuses a sortBy outside the whitelist rather than silently ignoring it', async () => {
    // `sortBy` is a `z.enum` over SORT_COLUMNS. A caller-supplied column that
    // slipped through unvalidated would either be dropped from the ORDER BY
    // (a sort that quietly does nothing) or, if the repository built a query
    // off it directly, an arbitrary column name reaching SQL.
    const res = await alice.api.get(`${LIST()}?sortBy=updatedByHacker&limit=10`);

    expect(res.status).toBe(400);
  });

  it('refuses a limit past the page-size ceiling', async () => {
    const res = await alice.api.get(`${LIST()}?limit=201`);

    // 200 is the documented ceiling (`paging({ max: 200 })`). Accepting more
    // turns one request into an unbounded scan of the firm's tasks.
    expect(res.status).toBe(400);
  });

  it('refuses page zero', async () => {
    const res = await alice.api.get(`${LIST()}?page=0&limit=10`);

    // `pageParam` is `min(1)`. Page zero has no defined meaning and the
    // repository multiplies it into an offset, so silently accepting it would
    // hand back an arbitrary window instead of a clean rejection.
    expect(res.status).toBe(400);
  });

  it('refuses a bulk taskIds array holding a non-string element', async () => {
    const mine = await seedTask(firmA.id, { title: 'Mine' });

    const res = await alice.api.post(`/api/lawfirms/${firmA.id}/tasks/bulk-delete`)
      .send({ taskIds: [mine, 12345] });

    // A mixed-type id list is the shape a client-side bug or a tampered
    // request produces. Rejecting the whole batch is what stops a numeric
    // stray from reaching `= any($1)` against a uuid column.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select id from tasks where id = $1', [mine]);
    expect(rows).toHaveLength(1);
  });
});
