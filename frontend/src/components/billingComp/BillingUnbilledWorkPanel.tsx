"use client";

import dayjs from "dayjs";
import { CalendarDays, CheckSquare, Clock3, Play } from "lucide-react";
import Button from "@/components/ui/Button";
import ListPager from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import type { UnbilledWorkItem } from "@/types";

interface BillingUnbilledWorkPanelProps {
  /** One server page of the backlog. */
  items: UnbilledWorkItem[];
  /** The whole backlog's size, so the badge and pager describe all of it. */
  total: number;
  page: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
  isLoading: boolean;
  /**
   * True while a page is in flight. The pager carries the wait on the button
   * that was clicked, since the previous page stays on screen meanwhile.
   */
  isFetching?: boolean;
  onLogTime: (item: UnbilledWorkItem) => void;
  onStartTimer: (item: UnbilledWorkItem) => void;
  /**
   * `billing.manageTimeEntries` - both actions above end in creating a time
   * entry, which the backend requires it for. Without it, neither control may
   * be offered.
   */
  canManage: boolean;
}

/** Rows shown at once. The page asks the server for exactly this many. */
export const UNBILLED_WORK_PAGE_SIZE = 5;

export default function BillingUnbilledWorkPanel({
  items,
  total,
  page,
  rowsPerPage,
  onPageChange,
  isLoading,
  isFetching = false,
  onLogTime,
  onStartTimer,
  canManage,
}: BillingUnbilledWorkPanelProps) {
  // Outline the rows that are coming, at the size they will occupy, the way
  // every other list in the app waits. A single grey block stood in for up to
  // five rows, so the panel resized when they landed.
  if (isLoading && items.length === 0) {
    return (
      <div className="bg-surface border border-outline rounded-xl p-3">
        <ListSkeleton
          rows={Math.min(rowsPerPage, UNBILLED_WORK_PAGE_SIZE)}
          bordered={false}
          label="Loading unbilled work"
        />
      </div>
    );
  }

  return (
    <div className="bg-surface border border-outline rounded-xl p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold text-on-surface">
          Unbilled work
          <span className="ml-1.5 font-normal text-on-surface-muted">
            · Completed work with no time logged
          </span>
        </h3>
        <span className="shrink-0 rounded-md bg-surface-alt px-2 py-0.5 text-xs text-on-surface-secondary">
          {total} open
        </span>
      </div>

      {total === 0 ? (
        <p className="px-1 py-2 text-xs text-on-surface-muted">
          Everything is logged: no completed tasks or past events waiting on time capture.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const isTask = item.workType === "task";
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg border border-outline px-3 py-2"
              >
                <span className="shrink-0 text-on-surface-muted">
                  {isTask ? <CheckSquare size={14} /> : <CalendarDays size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium text-on-surface truncate">{item.title}</p>
                  <p className="text-sm text-on-surface-muted truncate">
                    {[
                      item.matterName,
                      item.clientName,
                      item.date ? dayjs(item.date).format("MMM D, YYYY") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No matter or client linked"}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button type="secondary" size="small" onClick={() => onStartTimer(item)}>
                      <Play size={12} className="mr-1" />
                      Timer
                    </Button>
                    <Button type="primary" size="small" onClick={() => onLogTime(item)}>
                      <Clock3 size={12} className="mr-1" />
                      Log
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Every item is reachable: the panel used to render the first four and
              drop the rest, so a firm with a real backlog could not get to them. */}
          <div className="pt-1">
            <ListPager
              page={page}
              totalPages={Math.max(1, Math.ceil(total / rowsPerPage))}
              total={total}
              rowsPerPage={rowsPerPage}
              onPageChange={onPageChange}
              busy={isFetching}
              serverPaged
            />
          </div>
        </div>
      )}
    </div>
  );
}
