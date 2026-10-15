"use client";

import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import TasksService from "@/services/tasks.service";
import { isBeforeToday } from "@/lib/utils/dateUtils";
import type { Task } from "@/types";

/**
 * How many candidates to pull before picking the next one still ahead of now.
 *
 * `due_date` is a day-only column, so the server can only narrow to "due today or
 * later". Several of today's tasks may already have passed their time, so a few
 * rows are fetched and the first genuinely-future one wins. Five covers a heavily
 * booked day without turning a sidebar card into a real query.
 */
const CANDIDATE_COUNT = 5;

/**
 * The single next task due after right now.
 *
 * The calendar's own task list only covers the days on screen, so it cannot answer
 * "what is next" when the next item falls outside the window.
 *
 * The server filters on `due_date`, a day-only column, so it can only bound the
 * read to today onward. Timed tasks carry a precise instant in `dueDateLocalInput`,
 * so the final comparison happens here: a task due at 9am is no longer "next up" at
 * 3pm. Without this the card would present an already-overdue task as upcoming.
 *
 * Keyed under ["tasks", lawFirmId] so task mutations refresh it by prefix match.
 */
export default function useNextUpTask(lawFirmId?: string) {
  const today = dayjs().format("YYYY-MM-DD");

  const { data, isLoading } = useQuery<Task[]>({
    queryKey: ["tasks", lawFirmId, "nextUp", today],
    queryFn: async () => {
      const res = await TasksService.listLawFirmTasksPaged(lawFirmId!, {
        dueFrom: today,
        limit: CANDIDATE_COUNT,
        sortBy: "dueDate",
        order: "asc",
      });
      return res.tasks;
    },
    enabled: !!lawFirmId,
    staleTime: 60_000,
  });

  // Resolved on read rather than inside the query so the answer keeps up with the
  // clock. The calendar re-renders on a one-minute tick, so a task stops being
  // "next up" as its time passes, without refetching.
  const now = dayjs();
  const nextUpTask = (data ?? []).find((task) => {
    const due = task.dueDateLocalInput || task.dueDate;
    if (!due) return false;
    // An all-day task is due for its whole day, so it stays next up until the
    // day is over. Its input carries a placeholder time, which is not a
    // deadline to compare with now.
    if (task.allDay) return !isBeforeToday(due.slice(0, 10));
    return dayjs(due).isAfter(now);
  }) ?? null;

  return { nextUpTask, loading: isLoading };
}
