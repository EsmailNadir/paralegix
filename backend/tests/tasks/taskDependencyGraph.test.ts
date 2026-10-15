/**
 * B10.2: the task dependency graph's write boundary (`task_dependencies`).
 *
 * `tests/tasks/taskListReads.test.ts` covers reading an edge that already
 * exists (seeded straight into the table) in both directions. Nothing before
 * this file drove the actual WRITE path (`createTask`/`updateTask` ->
 * `syncDependencies` in `src/modules/tasks/tasks.repository.ts`) through the
 * real routes, so the acyclicity guard, the self-link filter, and the
 * cross-firm scoping it relies on had no coverage proving they hold under a
 * real request rather than a hand-seeded row.
 *
 * `syncDependencies` runs a recursive CTE that walks the EXISTING graph from
 * each proposed dependency, ignoring edges that start at the task being
 * written (since those are about to be replaced), and refuses the write if
 * the task itself becomes reachable, since that would close a cycle. It also
 * silently drops any proposed id that is not a real task in this firm,
 * rather than raising an FK error that would leak whether a foreign id
 * exists.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';

// One existing graph test deletes a task, which emits the real files cleanup
// listener. Give that listener its owned bucket boundary rather than letting
// the default fail-loud storage mock print an unrelated GCS error.
installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function createTask(title: string, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(T()).send({ title, ...extra });
  expect(res.status).toBe(201);
  return (res.body.taskId ?? res.body.task?.id) as string;
}

async function updateDependencies(taskId: string, dependencies: string[]) {
  return owner.api.put(`${T()}/${taskId}`).send({ dependencies });
}

async function dependencyEdges(taskId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    'select depends_on_task_id from task_dependencies where task_id = $1 order by depends_on_task_id',
    [taskId],
  );
  return rows.map((r: any) => r.depends_on_task_id);
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('creating/updating a task dependency edge', () => {
  it('drops a self-link instead of storing or erroring on it', async () => {
    const a = await createTask('A');

    const res = await updateDependencies(a, [a]);

    expect(res.status).toBe(200);
    expect(await dependencyEdges(a)).toEqual([]);
  });

  it('refuses a two-task cycle and leaves the existing edge untouched', async () => {
    const a = await createTask('A');
    const b = await createTask('B', { dependencies: [a] });
    expect(await dependencyEdges(b)).toEqual([a]);

    // A already depends on nothing; B depends on A. Making A depend on B
    // would close the loop A -> B -> A.
    const res = await updateDependencies(a, [b]);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cycle/i);
    expect(await dependencyEdges(a)).toEqual([]);
    expect(await dependencyEdges(b)).toEqual([a]);
  });

  it('refuses a three-task cycle and leaves the chain untouched', async () => {
    const a = await createTask('A');
    const b = await createTask('B');
    const c = await createTask('C');

    // Build the chain A depends on B depends on C via updates, since a task
    // can only name a dependency that already exists.
    expect((await updateDependencies(a, [b])).status).toBe(200);
    expect((await updateDependencies(b, [c])).status).toBe(200);
    expect(await dependencyEdges(a)).toEqual([b]);
    expect(await dependencyEdges(b)).toEqual([c]);

    // A -> B -> C already exists (A depends on B depends on C). Making C
    // depend on A would close A -> B -> C -> A.
    const res = await updateDependencies(c, [a]);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cycle/i);
    expect(await dependencyEdges(a)).toEqual([b]);
    expect(await dependencyEdges(b)).toEqual([c]);
    expect(await dependencyEdges(c)).toEqual([]);
  });

  it('collapses a duplicated id in the payload to one edge', async () => {
    const a = await createTask('A');
    const b = await createTask('B');

    const res = await updateDependencies(b, [a, a]);

    expect(res.status).toBe(200);
    expect(await dependencyEdges(b)).toEqual([a]);
  });

  it('refuses more than twenty dependency ids before replacing the existing graph', async () => {
    const target = await createTask('Target');
    const existing = await createTask('Existing blocker');
    expect((await updateDependencies(target, [existing])).status).toBe(200);
    expect(await dependencyEdges(target)).toEqual([existing]);

    const proposed = await Promise.all(
      Array.from({ length: 21 }, (_, index) => createTask(`Proposed blocker ${index + 1}`)),
    );
    const res = await updateDependencies(target, proposed);

    // The graph editor has a declared 20-edge request limit. Refusing before
    // the replace-set write matters: silently accepting a huge graph makes the
    // dependency view expensive, while clearing the old edge on a 400 loses a
    // legitimate blocker the user did not ask to remove.
    expect(res.status).toBe(400);
    expect(await dependencyEdges(target)).toEqual([existing]);
  });

  it('refuses creating a task with more than twenty dependency ids without creating a partial task', async () => {
    const proposed = await Promise.all(
      Array.from({ length: 21 }, (_, index) => createTask(`Create blocker ${index + 1}`)),
    );
    const before = await testPool.query(
      'select count(*)::int as n from tasks where law_firm_id = $1',
      [firm.id],
    );

    const res = await owner.api.post(T()).send({ title: 'Oversized dependency graph', dependencies: proposed });

    expect(res.status).toBe(400);
    const after = await testPool.query(
      'select count(*)::int as n from tasks where law_firm_id = $1',
      [firm.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('silently drops a dependency id that names no task, rather than erroring', async () => {
    const a = await createTask('A');
    const ghost = randomUUID();

    const res = await updateDependencies(a, [ghost]);

    expect(res.status).toBe(200);
    expect(await dependencyEdges(a)).toEqual([]);
  });

  it('silently drops a dependency id belonging to another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const foreignRes = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/tasks`)
      .send({ title: 'Foreign task' });
    expect(foreignRes.status).toBe(201);
    const foreignTaskId = (foreignRes.body.taskId ?? foreignRes.body.task?.id) as string;

    const a = await createTask('A');

    const res = await updateDependencies(a, [foreignTaskId]);

    // A cross-tenant edge must never be persisted, even silently succeeding
    // with an empty result, never a leak of whether the id exists elsewhere.
    expect(res.status).toBe(200);
    expect(await dependencyEdges(a)).toEqual([]);
  });

  it('accepts a valid acyclic chain', async () => {
    const a = await createTask('A');
    const b = await createTask('B', { dependencies: [a] });
    const c = await createTask('C', { dependencies: [b] });

    // Read the graph from B, which has both an upstream (A) and downstream (C) edge.
    const bGraph = await owner.api.get(`${T()}/${b}/dependencies`);

    expect(bGraph.status).toBe(200);
    expect(bGraph.body.dependencies.map((t: any) => t.id)).toEqual([a]);
    expect(bGraph.body.dependents.map((t: any) => t.id)).toEqual([c]);
  });

  it('removes an existing edge when the dependency set is explicitly cleared', async () => {
    const blocker = await createTask('Blocker');
    const dependent = await createTask('Dependent', { dependencies: [blocker] });
    expect(await dependencyEdges(dependent)).toEqual([blocker]);

    // An omitted dependencies field preserves the current graph; an explicit
    // empty set is the replace-set operation that must remove the edge.
    const res = await updateDependencies(dependent, []);

    expect(res.status).toBe(200);
    expect(res.body.task.dependencies).toEqual([]);
    expect(await dependencyEdges(dependent)).toEqual([]);

    const blockerGraph = await owner.api.get(`${T()}/${blocker}/dependencies`);
    expect(blockerGraph.status).toBe(200);
    expect(blockerGraph.body.dependents).toEqual([]);
  });

  it('drops the dangling edge when an intermediate node in the chain is deleted', async () => {
    const a = await createTask('A');
    const b = await createTask('B', { dependencies: [a] });
    const c = await createTask('C', { dependencies: [b] });
    expect(await dependencyEdges(b)).toEqual([a]);
    expect(await dependencyEdges(c)).toEqual([b]);

    const del = await owner.api.delete(`${T()}/${b}`);
    expect(del.status).toBe(200);

    // The FK is ON DELETE CASCADE, so the edge into and out of the deleted
    // node is gone rather than left dangling at either end of the chain.
    expect(await dependencyEdges(c)).toEqual([]);

    const aGraph = await owner.api.get(`${T()}/${a}/dependencies`);
    expect(aGraph.status).toBe(200);
    expect(aGraph.body.dependents).toEqual([]);
  });
});
