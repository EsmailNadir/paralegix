import type { ComponentProps, ReactNode } from "react";
import Dropdown from "@/components/ui/Dropdown";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import EntityPicker from "@/components/ui/EntityPicker";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import Textarea from "@/components/ui/Textarea";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import DateTimeRangeFields from "@/components/eventComp/DateTimeRangeFields";
import { endAcrossAllDayToggle } from "@/components/calendarComp/calendarTiming";
import { TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS } from "@/constants/statusMeta";
import type { TaskStatus, TaskRecurrence } from "@/types";
import TaskAssigneePicker from "./TaskAssigneePicker";
import TaskClientPicker from "./TaskClientPicker";
import TaskCourtField from "./TaskCourtField";
import TaskLocationField from "./TaskLocationField";
import TaskRecurrenceField from "./TaskRecurrenceField";
import TaskDependencyPicker from "./TaskDependencyPicker";

export const TASK_FORM_STEPS = [
  { label: "Task Details" },
  { label: "People & Matter" },
  { label: "Workflow" },
];

export type TaskFieldState = {
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  location: string;
  setLocation: (v: string) => void;
  dueDate?: string | null;
  setDueDate: (v: string) => void;
  endsAt: string;
  setEndsAt: (v: string) => void;
  allDay: boolean;
  setAllDay: (v: boolean) => void;
  assignedTo: string[];
  setAssignedTo: (v: string[]) => void;
  matterId: string;
  setMatterId: (v: string) => void;
  courtId: string;
  setCourtId: (v: string) => void;
  clientIds: string[];
  setClientIds: (v: string[]) => void;
  status: TaskStatus;
  setStatus: (v: TaskStatus) => void;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  setPriority: (v: 'low' | 'medium' | 'high' | 'urgent') => void;
  recurrenceEnabled: boolean;
  setRecurrenceEnabled: (v: boolean) => void;
  recurrencePattern: TaskRecurrence['pattern'];
  setRecurrencePattern: (v: TaskRecurrence['pattern']) => void;
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
  dependencies: string[];
  setDependencies: (v: string[]) => void;
};

type Props = {
  state: TaskFieldState;
  currentStep: number;
  fieldIds: string;
  duplicateTask?: { label: string } | null;
  lawFirmId: string;
  clientId?: string;
  dueDate: string;
  changeDueDate: (value: string) => void;
  handleDueDateFocus: () => void;
  toggleAssignee: (id: string) => void;
  handleMatterChange: (id: string) => void;
  onMatterSelected?: ComponentProps<typeof EntityPicker>["onSelectItem"];
  users: ComponentProps<typeof TaskAssigneePicker>["users"];
  courts: ComponentProps<typeof TaskCourtField>["courts"];
  courtsLoading: boolean;
  createCourt?: ComponentProps<typeof TaskCourtField>["createCourt"];
  canLinkCourtAddress: boolean;
  updateCourtAddress?: ComponentProps<typeof TaskLocationField>["updateCourtAddress"];
  showSourceNote?: boolean;
  excludeTaskId?: string;
  summary?: ReactNode;
};

export default function TaskFormBody({ state, currentStep, fieldIds, duplicateTask, lawFirmId, clientId,
  dueDate, changeDueDate, handleDueDateFocus, toggleAssignee, handleMatterChange, onMatterSelected,
  users, courts, courtsLoading, createCourt, canLinkCourtAddress, updateCourtAddress,
  showSourceNote, excludeTaskId, summary }: Props) {
  return (
    <div className="flex-1 px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar">
      {summary}
      {currentStep === 1 && <>
        {/* title */}
        <div>
          <FieldLabel htmlFor={`${fieldIds}-title`}>Title *</FieldLabel>
          <TextInput
            id={`${fieldIds}-title`}
            value={state.title}
            onChange={(e) => state.setTitle(e.target.value)}
            placeholder="Enter task title"
          />
          <DuplicateNameWarning duplicateName={duplicateTask?.label} entityLabel="task" />
        </div>

        {/* description */}
        <div>
          <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
          <Textarea
            id={`${fieldIds}-description`}
            rows={3}
            value={state.description}
            onChange={(e) => state.setDescription(e.target.value)}
            placeholder="Enter task description"
          />
        </div>

        {/* due date */}
        <label className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5 cursor-pointer">
          <span className="text-sm font-medium text-on-surface">All day</span>
          <ToggleSwitch
            checked={state.allDay}
            onChange={() => {
              const next = !state.allDay;
              const due = dueDate;
              const nextDue = !next && due.endsWith("T00:00") ? `${due.slice(0, 10)}T12:00` : due;
              state.setAllDay(next);
              // The end keeps the day it was given, in the other shape.
              state.setEndsAt(endAcrossAllDayToggle(state.endsAt, next, nextDue));
              if (nextDue !== due) state.setDueDate(nextDue);
            }}
            ariaLabel="All day"
          />
        </label>
        <DateTimeRangeFields
          idPrefix={fieldIds}
          allDay={state.allDay}
          startLabel="Due"
          start={dueDate}
          onStartChange={changeDueDate}
          onStartOpen={handleDueDateFocus}
          end={state.endsAt}
          onEndChange={state.setEndsAt}
          showEnd={Boolean(dueDate)}
        />

        {/* priority */}
        <Dropdown
          label="Priority"
          value={state.priority}
          onChange={(v) => state.setPriority(v as 'low' | 'medium' | 'high' | 'urgent')}
          options={TASK_PRIORITY_OPTIONS}
          portal
        />
      </>}

      {currentStep === 2 && <>
        {/* assigned to */}
        <TaskAssigneePicker users={users} selectedIds={state.assignedTo} onToggle={toggleAssignee} />

        {/* matter */}
        <EntityPicker
          entity="matters"
          lawFirmId={lawFirmId}
          clientId={clientId}
          label="Select Matter"
          value={state.matterId}
          onChange={handleMatterChange}
          onSelectItem={onMatterSelected}
          emptyOption={{ label: "No matter", value: "" }}
          portal
        />

        {/* court */}
        <TaskCourtField courtId={state.courtId} setCourtId={state.setCourtId} courts={courts} loading={courtsLoading} createCourt={createCourt} />

        {/* location */}
        <TaskLocationField
          location={state.location}
          setLocation={state.setLocation}
          courtId={state.courtId}
          courts={courts}
          canLinkToCourt={canLinkCourtAddress}
          updateCourtAddress={updateCourtAddress}
        />

        {/* clients */}
        <TaskClientPicker
          lawFirmId={lawFirmId}
          matterId={state.matterId}
          selectedIds={state.clientIds}
          onChange={state.setClientIds}
        />

      </>}

      {currentStep === 3 && <>
        {/* status */}
        <Dropdown
          label="Status"
          value={state.status}
          onChange={(v) => state.setStatus(v as TaskStatus)}
          options={TASK_STATUS_OPTIONS}
          portal
        />

        {/* recurrence */}
        <TaskRecurrenceField state={state} showSourceNote={showSourceNote} />

        {/* dependencies */}
        <TaskDependencyPicker
          lawFirmId={lawFirmId}
          dependencies={state.dependencies}
          setDependencies={state.setDependencies}
          excludeTaskId={excludeTaskId}
        />
      </>}
    </div>
  );
}
