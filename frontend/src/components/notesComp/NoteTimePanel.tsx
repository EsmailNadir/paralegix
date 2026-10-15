"use client";

import { Pencil, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { STATUS_VARIANTS, type StatusVariant } from "@/constants/statusMeta";
import { formatHoursMinutes } from "@/lib/utils/format";
import dayjs from "dayjs";
import type { NoteTimeEntry, NoteTimeStatus, NoteTimeSummary } from "@/types/note";

/**
 * Status pill tone per billing state. There is no entity-type map for this
 * (it isn't a stored enum on its own row, it's derived), so the variant is
 * picked directly the same way the note's existing billable/non-billable pill
 * already does.
 */
const TIME_STATUS_META: Record<Exclude<NoteTimeStatus, 'none'>, { label: string; variant: StatusVariant }> = {
  unbilled: { label: "Unbilled", variant: "neutral" },
  pending: { label: "On draft invoice", variant: "warning" },
  billed: { label: "Billed", variant: "success" },
};

interface NoteTimePanelProps {
  time: NoteTimeSummary | undefined;
  canEditTime: boolean;
  canRemoveTime: boolean;
  onEditTime: (entry: NoteTimeEntry) => void;
  onRemoveTime: (entry: NoteTimeEntry) => void;
}

/**
 * The time recorded against one note: totals, a billing-state pill, and one
 * row per entry with an invoice link where the entry is no longer editable.
 *
 * A note can carry several entries (a call, a memo and a filing are each their
 * own billable line even though one note records all three), so this is a
 * list rather than the single inline badge notes used to show. Renders
 * nothing when there are no entries yet - "Add time" already lives in the
 * note's overflow menu, so an empty note doesn't need a second entry point
 * competing for space in the content flow.
 */
export default function NoteTimePanel({
  time,
  canEditTime,
  canRemoveTime,
  onEditTime,
  onRemoveTime,
}: NoteTimePanelProps) {
  const hasEntries = !!time && time.entryCount > 0;

  if (!hasEntries) {
    return null;
  }

  const statusMeta = TIME_STATUS_META[time.status as Exclude<NoteTimeStatus, 'none'>];

  return (
    <div className="mt-3 rounded-lg border border-outline bg-surface-alt p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-on-surface">
          {formatHoursMinutes(time.totalHours)} total
        </span>
        {time.billableHours > 0 && (
          <span className="text-xs text-on-surface-secondary">
            {formatHoursMinutes(time.billableHours)} billable
          </span>
        )}
        {time.nonBillableHours > 0 && (
          <span className="text-xs text-on-surface-secondary">
            {formatHoursMinutes(time.nonBillableHours)} non-billable
          </span>
        )}
        {statusMeta && (
          <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${statusMeta.variant === 'neutral' ? 'bg-surface text-on-surface-secondary' : `${STATUS_VARIANTS[statusMeta.variant].tint} ${STATUS_VARIANTS[statusMeta.variant].text}`}`}>
            {statusMeta.label}
          </span>
        )}
      </div>

      <ul className="mt-2 space-y-1.5">
        {time.entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-on-surface-secondary">
              {entry.entryDate ? dayjs(entry.entryDate).format('MMM D') : 'Undated'}
            </span>
            <span className="font-medium text-on-surface">{formatHoursMinutes(entry.hours)}</span>
            {entry.name && <span className="text-on-surface-secondary">{entry.name}</span>}
            {!entry.billable && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-surface text-on-surface-secondary">
                Non-billable
              </span>
            )}
            {entry.invoiceNumber ? (
              <span className="text-xs text-on-surface-muted">Invoice {entry.invoiceNumber}</span>
            ) : (
              <span className="ml-auto flex items-center gap-1">
                {canEditTime && entry.editable && (
                  <Tooltip title="Edit time entry" enterDelay={300}>
                    <button
                      aria-label="Edit time entry"
                      onClick={() => onEditTime(entry)}
                      className="p-1 text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-hover rounded transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                )}
                {canRemoveTime && entry.editable && (
                  <Tooltip title="Remove time entry" enterDelay={300}>
                    <button
                      aria-label="Remove time entry"
                      onClick={() => onRemoveTime(entry)}
                      className="p-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
