/**
 * `deriveDueDateInput` had no dedicated coverage before this file, despite
 * being the shared fallback both `useTaskForm.taskToFormState` and
 * `EditTaskModal`'s `computedEditDue` rely on to pre-fill a task's due date
 * when the backend has not (yet) sent `dueDateLocalInput`.
 *
 * It deliberately reads `task.dueDate` with UTC getters, not local ones: the
 * backend anchors a day-only due date at UTC noon specifically so that
 * reading is safe from any viewer's zone (see this function's own doc
 * comment). `EditTaskModal.tsx` used to duplicate this logic with LOCAL
 * getters instead, which is the classic one-day-off bug for a viewer behind
 * UTC; it now delegates here instead.
 */
import { deriveDueDateInput } from '@/hooks/taskHooks/useTaskForm';
import type { Task } from '@/types';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: 'A task',
    status: 'open',
    ...overrides,
  } as Task;
}

describe('deriveDueDateInput', () => {
  it('returns empty for a missing task', () => {
    expect(deriveDueDateInput(null)).toBe('');
    expect(deriveDueDateInput(undefined)).toBe('');
  });

  it('prefers the backend-provided local input over deriving one', () => {
    expect(deriveDueDateInput(task({
      dueDateLocalInput: '2026-03-15T09:00',
      dueDate: '2026-03-15T16:00:00.000Z',
    } as Partial<Task>))).toBe('2026-03-15T09:00');
  });

  it('returns empty when the task has no due date at all', () => {
    expect(deriveDueDateInput(task({ dueDate: undefined }))).toBe('');
  });

  it('derives the correct local input from a UTC-noon-anchored day-only due date', () => {
    // The backend anchors a day-only due date at 12:00 UTC. Reading it with
    // UTC getters recovers the same calendar day and noon time regardless of
    // the viewer's own zone - the bug this guards against is reading it with
    // LOCAL getters instead, which shifts the day for any zone behind UTC.
    expect(deriveDueDateInput(task({
      dueDateLocalInput: '',
      dueDate: '2026-03-15T12:00:00.000Z',
    } as Partial<Task>))).toBe('2026-03-15T12:00');
  });

  it('derives the correct local input from a full instant with a real time-of-day', () => {
    expect(deriveDueDateInput(task({
      dueDateLocalInput: '',
      dueDate: '2026-03-15T16:30:00.000Z',
    } as Partial<Task>))).toBe('2026-03-15T16:30');
  });
});
