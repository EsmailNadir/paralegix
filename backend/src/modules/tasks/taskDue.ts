/**
 * When a task is due, as an instant: the one rule every reader applies.
 *
 * A task stores its day (`due_date`, day-only) and, when it has a time of
 * day, the exact moment (`due_at`). The moment wins when there is one;
 * otherwise the day is read at its noon-UTC anchor, so no viewer's zone rolls
 * it back a day.
 *
 * Also takes the calendar engine's task state, which carries the instant
 * already resolved in `dueDate` and no `dueAt`: that passes straight through.
 */

const { toInstant } = require('../../shared/utils/time');

export function taskDueInstant(task: { dueAt?: unknown; dueDate?: unknown } | null | undefined): Date | null {
  return toInstant(task?.dueAt) || toInstant(task?.dueDate);
}
