import { createFirm, ownerOf, testPool } from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const repo = require('../../src/modules/tasks/tasks.repository');
const { processRecurringTasks } = require('../../src/modules/tasks/taskRecurrence.service');

async function completedRecurringTask() {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({
    title: 'Recurring follow-up', status: 'completed', dueDate: '2026-10-01', allDay: true,
    recurrence: { enabled: true, pattern: 'daily', interval: 1 },
  });
  expect(task.status).toBe(201);
  return { firm, owner, taskId: task.body.taskId };
}

it.each(['reopened', 'rescheduled'])('does not clone a stale task that was %s during the sweep', async (change) => {
  const { firm, owner, taskId } = await completedRecurringTask();
  const gate = gateMethod(repo, 'disableRecurrence');
  const sweep = processRecurringTasks(firm.id);
  try {
    await gate.arrived(1);
    expect(gate.waiting()).toBe(1);
    const response = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).send(
      change === 'reopened' ? { status: 'open' } : { dueDate: '2026-11-01' },
    );
    expect(response.status).toBe(200);
    gate.open();
    const result = await sweep;
    expect(result.created).toBe(0);
    expect(result.errors).toBe(0);
    const { rows } = await testPool.query('select id, recurrence from tasks where law_firm_id = $1', [firm.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(taskId);
    expect(rows[0].recurrence.enabled).toBe(true);
  } finally {
    gate.restore();
    await sweep;
  }
  if (change === 'rescheduled') {
    const result = await processRecurringTasks(firm.id);
    expect(result.created).toBe(1);
    const { rows } = await testPool.query('select due_date from tasks where law_firm_id = $1 and id <> $2', [firm.id, taskId]);
    expect(rows).toEqual([{ due_date: '2026-11-02' }]);
  }
});

it('restores the recurrence claim and removes the new occurrence when its creation fails', async () => {
  const { firm, taskId } = await completedRecurringTask();
  const original = repo.createTask;
  let created = false;
  const fault = jest.spyOn(repo, 'createTask').mockImplementation(async (...args: any[]) => {
    await original.apply(repo, args);
    created = true;
    throw new Error('Injected failure after recurrence insert');
  });
  try {
    const result = await processRecurringTasks(firm.id);
    expect(result.errors).toBe(1);
    expect(created).toBe(true);
    const { rows } = await testPool.query('select id, recurrence from tasks where law_firm_id = $1', [firm.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(taskId);
    expect(rows[0].recurrence.enabled).toBe(true);
  } finally {
    fault.mockRestore();
  }
  const retried = await processRecurringTasks(firm.id);
  expect(retried.created).toBe(1);
  expect(retried.errors).toBe(0);
});

it('creates one occurrence when two sweeps overlap at the claim', async () => {
  const { firm } = await completedRecurringTask();
  const gate = gateMethod(repo, 'disableRecurrence');
  const first = processRecurringTasks(firm.id);
  const second = processRecurringTasks(firm.id);
  try {
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    gate.open();
    const results = await Promise.all([first, second]);
    expect(results.map((result: any) => result.created).sort()).toEqual([0, 1]);
    const { rows } = await testPool.query('select id from tasks where law_firm_id = $1', [firm.id]);
    expect(rows).toHaveLength(2);
  } finally {
    gate.restore();
    await Promise.all([first, second]);
  }
});
