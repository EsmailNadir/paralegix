import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { processRecurringTasks } from '../../src/modules/tasks/taskRecurrence.service';

const tasksRepo = require('../../src/modules/tasks/tasks.repository');

let firm: Firm;
let owner: Actor;

async function seedCompletedRecurringTask(
  lawFirmId: string,
  recurrence: Record<string, any>,
  overrides: Record<string, any> = {},
) {
  const id = randomUUID();
  const doc = {
    id,
    lawFirmId,
    title: 'Weekly Team Sync',
    description: 'Recurring agenda items',
    status: 'completed',
    priority: 'medium',
    dueDate: '2026-08-10',
    allDay: true,
    createdBy: owner.uid,
    recurrence: {
      enabled: true,
      pattern: 'weekly',
      interval: 1,
      occurrenceCount: 1,
      ...recurrence,
    },
    ...overrides,
  };

  const created = await tasksRepo.createTask(lawFirmId, doc);
  // Mark completed
  await testPool.query(`update tasks set status = 'completed' where id = $1`, [created.id]);
  return created;
}

describe('Task Recurrence Processing & Calculations', () => {
  beforeEach(async () => {
    firm = await createFirm({ name: 'Task Recurrence Firm' });
    owner = await ownerOf(firm.id);
  });

  it('spawns next occurrence for a weekly completed recurring task', async () => {
    const task = await seedCompletedRecurringTask(firm.id, {
      pattern: 'weekly',
      interval: 1,
      occurrenceCount: 1,
    });

    const stats = await processRecurringTasks(firm.id);
    expect(stats.created).toBe(1);

    // Verify previous task had recurrence disabled to prevent duplicates
    const { rows: oldRows } = await testPool.query('select recurrence from tasks where id = $1', [task.id]);
    expect(oldRows[0].recurrence?.enabled).toBe(false);

    // Verify new task created with status = 'open' and updated occurrence count
    const { rows: newRows } = await testPool.query(
      `select * from tasks where law_firm_id = $1 and id != $2 and source = 'recurrence'`,
      [firm.id, task.id],
    );
    expect(newRows).toHaveLength(1);
    expect(newRows[0].status).toBe('open');
    expect(newRows[0].title).toBe('Weekly Team Sync');
    expect(newRows[0].recurrence.occurrenceCount).toBe(2);
  });

});
