jest.mock('../../src/shared/database/queryContext', () => ({
  withDrizzleTransaction: (work: (transaction: object) => Promise<unknown>) => work({}),
}));
jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  forEachFirm: jest.fn(),
}));
jest.mock('../../src/modules/tasks/tasks.repository', () => ({
  findRecurringCompleted: jest.fn(),
  disableRecurrence: jest.fn(),
  createTask: jest.fn(),
}));
jest.mock('../../src/shared/events/eventBus', () => ({ emit: jest.fn() }));

import { forEachFirm } from '../../src/shared/utils/reminderHelpers';
import tasksRepo from '../../src/modules/tasks/tasks.repository';
import eventBus from '../../src/shared/events/eventBus';
import { TASK_CREATED } from '../../src/shared/events/eventTypes';
import { processRecurringTasks } from '../../src/modules/tasks/taskRecurrence.service';

const firmLoop = forEachFirm as jest.Mock;
const repo = tasksRepo as any;
const emit = eventBus.emit as jest.Mock;

const firm = { id: 'firm-1', name: 'Test Firm' };

function recurringTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    lawFirmId: firm.id,
    title: 'Follow up',
    description: 'Call client',
    dueDate: '2026-01-31',
    dueAt: null,
    allDay: true,
    assignedTo: ['member-1'],
    assignedToName: ['Member One'],
    createdBy: 'member-1',
    createdByName: 'Member One',
    recurrence: { enabled: true, pattern: 'monthly', interval: 1, occurrenceCount: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  firmLoop.mockImplementation(async (_name, callback) => {
    await callback(firm);
    return { firmsProcessed: 1, truncated: false };
  });
  repo.findRecurringCompleted.mockResolvedValue([]);
  repo.disableRecurrence.mockResolvedValue(true);
  repo.createTask.mockImplementation(async (_firmId: string, task: any) => ({ id: 'next-task', ...task }));
});

describe('recurring task scheduling', () => {
  it('creates the next monthly occurrence and clamps January 31 to February 28', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask()]);

    const result = await processRecurringTasks(firm.id);

    expect(result).toMatchObject({ created: 1, skipped: 0, errors: 0, firmsProcessed: 1 });
    expect(repo.disableRecurrence).toHaveBeenCalledWith(firm.id, 'task-1', expect.any(Object), undefined);
    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      status: 'open',
      dueDate: new Date('2026-02-28T12:00:00.000Z'),
      source: 'recurrence',
      recurrence: expect.objectContaining({ occurrenceCount: 1, sourceTaskId: 'task-1' }),
    }), undefined, expect.any(Object));
    expect(emit).toHaveBeenCalledWith(TASK_CREATED, expect.objectContaining({
      lawFirmId: firm.id,
      taskId: 'next-task',
    }));
  });

  it('carries a timed end onto the next occurrence, keeping the same length', async () => {
    // Goes red if the next occurrence drops the end (a two-hour block becomes
    // the one-hour default) or keeps the old instant, which would put the end
    // a month before its own start and fail tasks_ends_after_start.
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-01-15',
      dueAt: '2026-01-15T14:00:00.000Z',
      endsAt: '2026-01-15T16:00:00.000Z',
      allDay: false,
      dueDateTimeZone: 'UTC',
    })]);

    await processRecurringTasks(firm.id);

    const next = repo.createTask.mock.calls[0][1];
    expect(new Date(next.endsAt).getTime() - new Date(next.dueAt).getTime()).toBe(2 * 60 * 60 * 1000);
    expect(new Date(next.endsAt).toISOString()).toBe('2026-02-15T16:00:00.000Z');
  });

  it('carries an all-day span onto the next occurrence', async () => {
    // The 15th through the 16th: the exclusive end is the 17th.
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-01-15', endsAt: '2026-01-17T12:00:00.000Z',
    })]);

    await processRecurringTasks(firm.id);

    expect(new Date(repo.createTask.mock.calls[0][1].endsAt).toISOString()).toBe('2026-02-17T12:00:00.000Z');
  });

  it('clamps day 31 to day 30 rolling from a 31-day month into a 30-day one', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate: '2026-03-31' })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2026-04-30T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('lands on February 29 in a leap year instead of clamping day 29', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate: '2028-01-29' })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2028-02-29T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('clamps day 29 to February 28 in a non-leap year', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate: '2026-01-29' })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2026-02-28T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('keeps a leap-day occurrence on day 29 the following month, when the month is long enough', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate: '2028-02-29' })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2028-03-29T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it("honors an explicit recurrence.dayOfMonth over the source occurrence's own day, still clamped", async () => {
    // The due date's own day (10) would need no clamping; only the explicit
    // dayOfMonth (31) does. This is the only test that exercises the
    // `recurrence.dayOfMonth || next.getUTCDate()` override branch at all -
    // every other case here relies on the fallback to the current day.
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-05-10',
      recurrence: { enabled: true, pattern: 'monthly', interval: 1, occurrenceCount: 0, dayOfMonth: 31 },
    })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2026-06-30T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('rolls day 31 across a year boundary with no clamp needed (control)', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate: '2026-12-31' })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2027-01-31T12:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('preserves the clock time for timed occurrences', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-08-10',
      dueAt: '2026-08-10T17:45:30.000Z',
      allDay: false,
      recurrence: { enabled: true, pattern: 'daily', interval: 2, occurrenceCount: 3 },
    })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueDate: new Date('2026-08-12T12:00:00.000Z'),
      dueAt: new Date('2026-08-12T17:45:30.000Z'),
      allDay: false,
    }), undefined, expect.any(Object));
  });

  /**
   * `dueDate` is the task's LOCAL day and `dueAt` its instant. Goes red if the
   * next occurrence pairs the next local day with the old instant's UTC clock:
   * a task due 7pm Pacific (03:00 the next day in UTC) repeats at the same
   * moment instead of a day later.
   */
  it('keeps an evening task at the same local time on the next local day', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-03-01',
      dueAt: '2026-03-02T03:00:00.000Z',
      dueDateTimeZone: 'America/Los_Angeles',
      allDay: false,
      recurrence: { enabled: true, pattern: 'daily', interval: 1, occurrenceCount: 0 },
    })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueAt: new Date('2026-03-03T03:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  /** Goes red if the clock time is kept in UTC: across the spring change 7pm would become 8pm. */
  it('keeps the local time across a daylight-saving change', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({
      dueDate: '2026-03-07',
      dueAt: '2026-03-08T03:00:00.000Z',
      dueDateTimeZone: 'America/Los_Angeles',
      allDay: false,
      recurrence: { enabled: true, pattern: 'daily', interval: 1, occurrenceCount: 0 },
    })]);

    await processRecurringTasks(firm.id);

    // March 8, 2026 is the US spring change: 7pm PDT is 02:00 UTC on March 9.
    expect(repo.createTask).toHaveBeenCalledWith(firm.id, expect.objectContaining({
      dueAt: new Date('2026-03-09T02:00:00.000Z'),
    }), undefined, expect.any(Object));
  });

  it('chooses the next configured weekly day and wraps to the next interval week', async () => {
    repo.findRecurringCompleted.mockResolvedValue([
      recurringTask({
        dueDate: '2026-08-10', // Monday
        recurrence: { enabled: true, pattern: 'weekly', interval: 1, daysOfWeek: [3, 5] },
      }),
      recurringTask({
        id: 'task-2',
        dueDate: '2026-08-14', // Friday
        recurrence: { enabled: true, pattern: 'weekly', interval: 2, daysOfWeek: [1, 3] },
      }),
    ]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask.mock.calls[0][1].dueDate).toEqual(new Date('2026-08-12T12:00:00.000Z'));
    expect(repo.createTask.mock.calls[1][1].dueDate).toEqual(new Date('2026-08-24T12:00:00.000Z'));
  });

  it.each([
    ['custom', '2026-02-03', { pattern: 'custom', interval: 3 }, '2026-02-06'],
    ['default pattern', '2026-02-03', { pattern: 'unknown' }, '2026-02-04'],
  ])('handles the %s recurrence', async (_label, dueDate, recurrence, expected) => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask({ dueDate, recurrence: { enabled: true, ...recurrence } })]);

    await processRecurringTasks(firm.id);

    expect(repo.createTask.mock.calls[0][1].dueDate).toEqual(new Date(`${expected}T12:00:00.000Z`));
  });

  it('skips disabled, missing-date, maxed-out, and past-end recurring tasks', async () => {
    repo.findRecurringCompleted.mockResolvedValue([
      recurringTask({ id: 'disabled', recurrence: { enabled: false, pattern: 'daily' } }),
      recurringTask({ id: 'missing-date', dueDate: null }),
      recurringTask({ id: 'maxed', recurrence: { enabled: true, pattern: 'daily', maxOccurrences: 2, occurrenceCount: 2 } }),
      recurringTask({ id: 'past-end', recurrence: { enabled: true, pattern: 'daily', endDate: '2026-01-31' } }),
    ]);

    const result = await processRecurringTasks(firm.id);

    expect(result.skipped).toBe(4);
    expect(result.created).toBe(0);
    expect(repo.createTask).not.toHaveBeenCalled();
    expect(repo.disableRecurrence).toHaveBeenCalledWith(firm.id, 'maxed', undefined, undefined);
    expect(repo.disableRecurrence).toHaveBeenCalledWith(firm.id, 'past-end', undefined, undefined);
  });

  it('does not clone when another worker wins the conditional claim', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask()]);
    repo.disableRecurrence.mockResolvedValue(false);

    const result = await processRecurringTasks(firm.id);

    expect(result).toMatchObject({ created: 0, skipped: 1, errors: 0 });
    expect(repo.createTask).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('records a create failure after claiming and continues without emitting', async () => {
    repo.findRecurringCompleted.mockResolvedValue([recurringTask()]);
    repo.createTask.mockRejectedValue(new Error('write failed'));

    const result = await processRecurringTasks(firm.id);

    expect(result).toMatchObject({ created: 0, skipped: 0, errors: 1 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports a repository failure for the firm without crashing the sweep', async () => {
    repo.findRecurringCompleted.mockRejectedValue(new Error('database unavailable'));

    const result = await processRecurringTasks(firm.id);

    expect(result).toMatchObject({ created: 0, skipped: 0, errors: 1, firmsProcessed: 1 });
  });
});
