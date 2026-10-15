/**
 * `taskDueInstant`: the one rule for when a task is due, shared by the task
 * responses, the calendar engine's task state and the calendar push.
 */
const { taskDueInstant } = require('../../src/modules/tasks/taskDue');

describe('taskDueInstant', () => {
  /** Goes red if the day wins over the time: a timed task would land at the day anchor. */
  test('a saved timed task is due at its time, not its day', () => {
    expect(taskDueInstant({ dueDate: '2026-09-28', dueAt: '2026-09-28T19:00:00.000Z' }).toISOString())
      .toBe('2026-09-28T19:00:00.000Z');
  });

  /** Goes red if a bare day is read as midnight UTC, the day before in every zone behind UTC. */
  test('a saved all-day task is due at its day anchor', () => {
    expect(taskDueInstant({ dueDate: '2026-09-28', dueAt: null }).toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });

  test('the engine\'s state, with the instant already in dueDate, passes through', () => {
    const at = new Date('2026-09-28T19:00:00Z');
    expect(taskDueInstant({ dueDate: at })).toBe(at);
  });

  test('a task with no due date is due at no time', () => {
    expect(taskDueInstant({ dueDate: null, dueAt: null })).toBeNull();
    expect(taskDueInstant(null)).toBeNull();
  });
});

export {};
