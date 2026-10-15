import { useId } from "react";
import Dropdown from "@/components/ui/Dropdown";
import StatusBadge from "@/components/ui/StatusBadge";
import DatePicker from "@/components/ui/DatePicker";
import { Repeat } from "lucide-react";
import type { TaskRecurrence } from "@/types";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

/**
 * Recurrence subset of the create/edit task form state. Both modal hooks expose
 * exactly these fields, so either can be passed directly (structural typing).
 */
export type RecurrenceState = {
  recurrenceEnabled: boolean;
  setRecurrenceEnabled: (v: boolean) => void;
  recurrencePattern: TaskRecurrence["pattern"];
  setRecurrencePattern: (v: TaskRecurrence["pattern"]) => void;
  recurrenceInterval: number;
  setRecurrenceInterval: (v: number) => void;
  recurrenceDaysOfWeek: number[] | null;
  setRecurrenceDaysOfWeek: (v: number[] | null) => void;
  recurrenceDayOfMonth: number | null;
  setRecurrenceDayOfMonth: (v: number | null) => void;
  recurrenceEndDate: string | null;
  setRecurrenceEndDate: (v: string | null) => void;
  recurrenceMaxOccurrences: number | null;
  setRecurrenceMaxOccurrences: (v: number | null) => void;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Collapsible "Repeat" recurrence editor shared by the task modals: pattern +
 * interval, weekly day-of-week toggles, monthly day-of-month, and end
 * date/max-occurrences limits. `showSourceNote` renders the "auto-created from a
 * recurring task" hint (edit modal only).
 */
export default function TaskRecurrenceField({
  state,
  showSourceNote = false,
}: {
  state: RecurrenceState;
  showSourceNote?: boolean;
}) {
  const fieldIds = useId();
  return (
    <div className="rounded-md border border-input-border">
      <button
        type="button"
        onClick={() => state.setRecurrenceEnabled(!state.recurrenceEnabled)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-on-surface hover:bg-surface-hover transition-colors rounded-lg cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <Repeat size={15} />
          Repeat
        </span>
        <StatusBadge variant={state.recurrenceEnabled ? "success" : "neutral"}>
          {state.recurrenceEnabled ? "On" : "Off"}
        </StatusBadge>
      </button>
      {state.recurrenceEnabled && (
        <div className="px-4 pb-4 space-y-3 border-t border-outline-subtle">
          <div className="pt-3 flex items-center gap-3">
            <div className="flex-1">
              <Dropdown
                label="Pattern"
                value={state.recurrencePattern}
                onChange={(v) => state.setRecurrencePattern(v as TaskRecurrence["pattern"])}
                options={[
                  { label: "Daily", value: "daily" },
                  { label: "Weekly", value: "weekly" },
                  { label: "Monthly", value: "monthly" },
                  { label: "Custom (days)", value: "custom" },
                ]}
                portal
              />
            </div>
            <div className="w-24">
              <FieldLabel htmlFor={`${fieldIds}-recurrenceinterval`}>Every</FieldLabel>
              <input
                id={`${fieldIds}-recurrenceinterval`}
                type="number"
                min={1}
                max={365}
                value={state.recurrenceInterval}
                onChange={(e) => state.setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          </div>

          {state.recurrencePattern === "weekly" && (
            <div>
              <FieldLabel>Days of Week</FieldLabel>
              <div className="flex gap-1.5">
                {DAYS.map((day, i) => {
                  const selected = state.recurrenceDaysOfWeek?.includes(i) || false;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        const current = state.recurrenceDaysOfWeek || [];
                        state.setRecurrenceDaysOfWeek(
                          selected ? current.filter((d) => d !== i) : [...current, i].sort()
                        );
                      }}
                      className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors cursor-pointer ${selected ? "bg-accent-solid text-accent-foreground border-accent-solid" : "border-outline text-on-surface-secondary hover:bg-surface-hover"}`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {state.recurrencePattern === "monthly" && (
            <div>
              <FieldLabel htmlFor={`${fieldIds}-day-of-month`}>Day of Month</FieldLabel>
              <input
                id={`${fieldIds}-day-of-month`}
                type="number"
                min={1}
                max={31}
                value={state.recurrenceDayOfMonth || ""}
                onChange={(e) => state.setRecurrenceDayOfMonth(e.target.value ? parseInt(e.target.value) : null)}
                placeholder="e.g. 15"
                className="w-24 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          )}

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <FieldLabel id={`${fieldIds}-end-date-optional-label`}>End Date (optional)</FieldLabel>
              <DatePicker
                ariaLabelledBy={`${fieldIds}-end-date-optional-label`}
                value={state.recurrenceEndDate || undefined}
                onChange={(v) => state.setRecurrenceEndDate(v || null)}
                className="w-full"
              />
            </div>
            <div className="w-32">
              <FieldLabel htmlFor={`${fieldIds}-no-limit`}>Max Repeats</FieldLabel>
              <TextInput
                id={`${fieldIds}-no-limit`}
                type="number"
                min={1}
                max={1000}
                value={state.recurrenceMaxOccurrences || ""}
                onChange={(e) => state.setRecurrenceMaxOccurrences(e.target.value ? parseInt(e.target.value) : null)}
                placeholder="No limit"
              />
            </div>
          </div>

          {showSourceNote && (
            <p className="text-xs text-on-surface-muted">
              This task was auto-created from a recurring task.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
