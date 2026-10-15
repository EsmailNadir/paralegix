"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FilePlus, ArrowRightLeft, Milestone, Lock, ShieldCheck, UserPlus, Circle, History,
  StickyNote, PencilLine, Undo2, MessageSquare, Timer, CheckSquare, Paperclip, Send,
} from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { STATUS_VARIANTS } from "@/constants/statusMeta";
import mattersService from "@/services/matters.service";
import type { MatterActivity } from "@/types";
import ErrorNotification from "@/components/ErrorNotification";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { formatTimeAgo } from "@/components/notificationComp/notificationUtils";
import ListPager from "@/components/ui/ListPager";
import { useNavigation } from "@/contexts/NavigationContext";
import { isForbiddenError } from "@/lib/utils/apiErrors";

const ACTIVITY_PAGE_SIZE = 5;

// Maps each activity type to its timeline icon. Unknown types fall back to a
// neutral dot.
const ACTIVITY_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  "matter.created": FilePlus,
  "status.changed": ArrowRightLeft,
  "stage.changed": Milestone,
  "legal_hold.changed": Lock,
  "conflict_check.run": ShieldCheck,
  "contact.added": UserPlus,
  "note.created": StickyNote,
  "note.updated": PencilLine,
  "note.retracted": Undo2,
  "note.reply.added": MessageSquare,
  "note.time.recorded": Timer,
  "note.task.linked": CheckSquare,
  "note.document.linked": Paperclip,
  "note.shared": Send,
};

// Reuses the shared token wherever the hue has an exact STATUS_VARIANTS match
// (so e.g. a warning-colored icon here is the same shade as a warning badge
// anywhere else). The remaining hues (sky/rose/violet) have no shared
// equivalent - each activity type is a distinct action in one timeline, not a
// stored status rendered elsewhere, so they stay bespoke but still carry an
// explicit light/dark pair like every other token in this palette does.
const ACTIVITY_ICON_COLOR: Record<string, string> = {
  "matter.created": STATUS_VARIANTS.success.text,
  "status.changed": STATUS_VARIANTS.info.text,
  "stage.changed": "text-accent-emphasis",
  "legal_hold.changed": STATUS_VARIANTS.warning.text,
  "conflict_check.run": STATUS_VARIANTS.purple.text,
  "contact.added": STATUS_VARIANTS.teal.text,
  "note.created": "text-sky-600 dark:text-sky-400",
  "note.updated": "text-sky-600 dark:text-sky-400",
  "note.retracted": "text-rose-600 dark:text-rose-400",
  "note.reply.added": "text-violet-600 dark:text-violet-400",
  "note.time.recorded": STATUS_VARIANTS.warning.text,
  "note.task.linked": STATUS_VARIANTS.info.text,
  "note.document.linked": STATUS_VARIANTS.teal.text,
  "note.shared": STATUS_VARIANTS.success.text,
};

/**
 * Which activity types each filter selects. Grouped by what the reader is
 * looking for rather than by which module wrote the row, so "Notes" covers
 * the whole life of a note including its replies and shares.
 */
const ACTIVITY_FILTERS: { value: string; label: string; types: string[] }[] = [
  { value: "all", label: "All", types: [] },
  {
    value: "notes",
    label: "Notes",
    types: ["note.created", "note.updated", "note.retracted", "note.reply.added", "note.shared"],
  },
  { value: "tasks", label: "Tasks", types: ["note.task.linked"] },
  { value: "documents", label: "Documents", types: ["note.document.linked"] },
  { value: "time", label: "Time", types: ["note.time.recorded"] },
];

/**
 * One page of the activity feed. Exported so the matter page can start the
 * first page (page 1, "All") while the matter itself is still loading, under
 * the exact key and request this feed then reads from cache.
 */
export function matterActivityQueryOptions(lawFirmId: string, matterId: string, page = 1, filter = "all") {
  const types = (ACTIVITY_FILTERS.find((f) => f.value === filter) ?? ACTIVITY_FILTERS[0]).types;
  return {
    queryKey: ["matter-activity", lawFirmId, matterId, page, filter] as const,
    queryFn: (): Promise<{ activity: MatterActivity[]; totalItems: number }> =>
      mattersService.listActivity(lawFirmId, matterId, {
        limit: ACTIVITY_PAGE_SIZE,
        offset: (page - 1) * ACTIVITY_PAGE_SIZE,
        activityTypes: types.length ? types : undefined,
      }),
  };
}

function absoluteTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

interface MatterActivityFeedProps {
  lawFirmId: string;
  matterId: string;
}

export default function MatterActivityFeed({ lawFirmId, matterId }: MatterActivityFeedProps) {
  const { navigate } = useNavigation();
  // Server-paged: the feed is append-only, so a long-running matter's history
  // outgrows any single request. `placeholderData` keeps the previous page on
  // screen while the next one loads, so paging doesn't blank the list.
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("all");

  const activeFilter = ACTIVITY_FILTERS.find((f) => f.value === filter) ?? ACTIVITY_FILTERS[0];

  const { data, isLoading, isFetching, error } = useQuery({
    ...matterActivityQueryOptions(lawFirmId, matterId, page, activeFilter.value),
    enabled: !!lawFirmId && !!matterId,
    // Guards against a firm switch briefly showing the previous firm's
    // activity under the new firm's chrome: only carries the previous page
    // over when it belongs to the SAME firm's query key.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  const activity = data?.activity ?? [];
  const totalItems = data?.totalItems ?? 0;
  // A refusal is not a fault the reader can act on, so the feed says it is not
  // theirs to see instead of showing a red banner over an empty timeline.
  const accessDenied = isForbiddenError(error);
  const totalPages = Math.max(1, Math.ceil(totalItems / ACTIVITY_PAGE_SIZE));

  const handleFilterChange = (value: string) => {
    setFilter(value);
    setPage(1);
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h3 className="text-base font-semibold text-on-surface">Activity</h3>
        <p className="text-xs text-on-surface-secondary mt-0.5">
          A running history of changes on this matter.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-surface-alt rounded-lg w-fit">
        {ACTIVITY_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleFilterChange(value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              filter === value
                ? 'bg-surface text-on-surface shadow-sm'
                : 'text-on-surface-secondary hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && !accessDenied && <ErrorNotification error={error as Error} />}

      {isLoading ? (
        <ListSkeleton rows={4} label="Loading activity" />
      ) : accessDenied ? (
        <ListEmptyState
          compact
          icon={<Lock size={32} />}
          title="Activity is not shown for this matter"
          message="Only people on the matter can see its history."
        />
      ) : activity.length === 0 ? (
        <ListEmptyState
          compact
          icon={<History size={32} />}
          title="No activity yet"
          message="Changes to this matter will show up here."
        />
      ) : (
        <ol className="relative">
          {activity.map((item, index) => {
            const Icon = ACTIVITY_ICON[item.activityType] ?? Circle;
            const iconColor = ACTIVITY_ICON_COLOR[item.activityType] ?? "text-on-surface-muted";
            const isLast = index === activity.length - 1;
            const noteId = typeof item.metadata?.noteId === 'string' ? item.metadata.noteId : null;
            return (
              <li key={item.id} className="flex gap-3">
                <div className="flex flex-col items-center shrink-0">
                  <div className="flex items-center justify-center size-8 rounded-full bg-surface-alt border border-outline">
                    <Icon size={15} className={iconColor} />
                  </div>
                  {!isLast && <div className="w-px flex-1 bg-outline-subtle my-1" />}
                </div>
                <div className={`min-w-0 flex-1 ${isLast ? "pb-1" : "pb-5"}`}>
                  {noteId ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}?tab=notes&note=${noteId}`)}
                      className="text-sm text-on-surface leading-snug break-words text-left hover:underline cursor-pointer"
                    >
                      {item.summary}
                    </button>
                  ) : (
                    <p className="text-sm text-on-surface leading-snug break-words">{item.summary}</p>
                  )}
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-on-surface-muted">
                    <span className="font-medium text-on-surface-secondary">{item.actorName || "System"}</span>
                    <span aria-hidden>·</span>
                    <Tooltip title={absoluteTimestamp(item.createdAt)} enterDelay={300}>
                      <span>{formatTimeAgo(item.createdAt)}</span>
                    </Tooltip>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* No page-size props, so the footer is Prev/Next and the range only. Draws
          nothing while the whole feed fits on one page, so it needs no guard.
          `w-fit`: ListPager's own row spans whatever width its parent gives it
          and spaces its two halves to the far edges, which reads as detached
          from this narrow timeline. Shrinking the wrapper to the footer's own
          content keeps it sitting directly under the list instead of drifting
          off to the right of the wider card. */}
      <div className="w-fit">
        <ListPager
          page={page}
          totalPages={totalPages}
          total={totalItems}
          rowsPerPage={ACTIVITY_PAGE_SIZE}
          onPageChange={setPage}
          busy={isFetching}
          serverPaged
        />
      </div>
    </div>
  );
}
