"use client";

import LinkifiedText from "@/components/ui/LinkifiedText";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useId, useState, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDateOnly, getDefaultDateTimeLocalValue } from "@/lib/utils/dateUtils";
import { Pencil, Trash2, CheckCircle, Clock, X, Ban, CalendarClock, FileText, Link2, Repeat, AlertTriangle, Play } from 'lucide-react';
import matterEventsService, { CreateMatterEventRequest, UpdateMatterEventRequest } from "@/services/matterEvents.service";
import type { MatterEvent, MatterEventType, MatterEventStatus } from "@/types/matterEvent";
import { matterEventTypeMeta, MATTER_EVENT_TYPE_OPTIONS } from "@/constants/statusMeta";
import { useLawFirmUsers } from "@/hooks/useUsers";
import filesService from "@/services/files.service";
import FilePreviewModal from "@/components/filesComp/FilePreviewModal";
import type { PreviewableFile } from "@/components/filesComp/FilePreviewModal";
import ApplyDeadlineSetModal from "@/components/matterComp/ApplyDeadlineSetModal";
import ActionIconButton from "@/components/ui/ActionIconButton";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Modal from "@/components/ui/Modal";
import Dropdown from "@/components/ui/Dropdown";
import ContactCategoryBadge from "@/components/ui/ContactCategoryBadge";
import DatePicker from "@/components/ui/DatePicker";
import DateTimeRangeFields from "@/components/eventComp/DateTimeRangeFields";
import TimeEntryModal, { TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useMatterById } from "@/hooks/matterHooks/useMatters";
import useMatterEventsList from "@/hooks/matterHooks/useMatterEventsList";
import useMatterEventGraph from "@/hooks/matterHooks/useMatterEventGraph";
import useMatterEventsPage from "@/hooks/matterHooks/useMatterEventsPage";
import type { EventGraphNode } from "@/types/matterEvent";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import useCourts from "@/hooks/courtHooks/useCourts";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import StatusBadge from "@/components/ui/StatusBadge";
import { type RowAction } from "@/components/ui/RowActionMenu";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";
import EntityEventsTab, { useEventStatusFilter, type EntityEventsAdapter } from "@/components/eventComp/EntityEventsTab";
import EntityEventForm, { useEventFormFields } from "@/components/eventComp/EntityEventForm";
import { endsAtPayloadFor, eventListWhen, eventScheduleFormValues, eventZoneSuffix, scheduleEdits } from "@/components/calendarComp/calendarTiming";
import ZonedEventTime from "@/components/calendarComp/ZonedEventTime";
import { eventCourtName } from "@/components/eventComp/eventCourt";

const INPUT_CLASS = FULL_INPUT_CLS;

/** Mirrors the `dependsOn` array cap enforced by matterEvents.validation.js. */
const MAX_EVENT_DEPENDENCIES = 10;

function formatDependencyDate(date: string | null | undefined, dateLocalDisplay?: string | null) {
  if (dateLocalDisplay) return dateLocalDisplay;
  if (!date) return "No date";

  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "No date" : parsed.toLocaleString();
}

// Takes only what it reads, so it works on both a full event and a graph node.
function isDependencyResolved(event: Pick<MatterEvent, "status">) {
  return event.status === "completed";
}

interface DependencyReviewModalProps {
  open: boolean;
  title: string;
  description: string;
  /**
   * Only the fields the rows below render. Stated structurally so this accepts
   * both a full event and a dependency-graph node, which is what lets blocking
   * resolve against the whole matter instead of the page on screen.
   */
  dependencies: Array<Pick<MatterEvent, "id" | "type" | "title" | "status" | "date" | "dateLocalDisplay">>;
  confirmText: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}

function DependencyReviewModal({
  open,
  title: titleProp,
  description: descriptionProp,
  dependencies: dependenciesProp,
  confirmText: confirmTextProp,
  onConfirm,
  onClose,
  loading = false,
}: DependencyReviewModalProps) {
  // The caller clears the event under review as it closes this, which empties
  // the dependency list. Keep what was shown while the dialog animates out.
  const title = useLastOpenValue(open, titleProp);
  const description = useLastOpenValue(open, descriptionProp);
  const dependencies = useLastOpenValue(open, dependenciesProp);
  const confirmText = useLastOpenValue(open, confirmTextProp);
  const titleId = useId();
  // Every way out is refused while the confirm is in flight.
  const handleClose = useCallback(() => {
    if (loading) return;
    onClose();
  }, [loading, onClose]);

  // Opened from inside the event form as well as from the list, so it stacks.
  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      stacked
      size="lg"
      height="none"
      dismissible={!loading}
      labelledBy={titleId}
      showClose={false}
      className="border border-outline"
      bodyClassName={null}
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-outline">
        <div className="flex items-center gap-2">
          <AlertTriangle size={18} className="text-amber-500" />
          <h2 id={titleId} className="text-lg font-semibold text-on-surface">{title}</h2>
        </div>
        <button
          type="button"
          onClick={handleClose}
          disabled={loading}
          className="text-on-surface-muted hover:text-on-surface-secondary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-4">
        <p className="text-sm text-on-surface-secondary">{description}</p>

        <div className="rounded-md border border-outline overflow-hidden">
          {dependencies.map((dependency) => (
            <div
              key={dependency.id}
              className="px-4 py-3 border-b border-outline-subtle last:border-b-0 bg-surface-alt/40"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge variant={matterEventTypeMeta(dependency.type).variant}>
                  {matterEventTypeMeta(dependency.type).label}
                </StatusBadge>
                <StatusBadge variant={isDependencyResolved(dependency) ? "success" : "warning"}>
                  {isDependencyResolved(dependency) ? "Completed" : dependency.status === "cancelled" ? "Cancelled" : "Unresolved"}
                </StatusBadge>
              </div>
              <p className="text-sm font-medium text-on-surface mt-1">{dependency.title}</p>
              <p className="text-xs text-on-surface-muted mt-0.5">
                {formatDependencyDate(dependency.date, dependency.dateLocalDisplay)}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg max-sm:rounded-b-none border-t border-outline">
        <Button type="secondary" onClick={handleClose} disabled={loading}>Cancel</Button>
        <Button type="primary" onClick={onConfirm} loading={loading}>{confirmText}</Button>
      </div>
    </Modal>
  );
}

interface EventFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lawFirmId: string;
  matterId: string;
  editing?: MatterEvent | null;
  allEvents?: MatterEvent[];
  defaultLocationName?: string;
  defaultLocation?: string;
}

function EventFormModal({ open, onClose, onSaved, lawFirmId, matterId, editing, allEvents = [], defaultLocationName = "", defaultLocation = "" }: EventFormModalProps) {
  const fieldIds = useId();
  const fields = useEventFormFields();
  const {
    type, setType,
    title, date, endsAt, notes, locationName, location,
    status, setStatus,
    assignedTo, assignedToName, contactIds, linkedFiles, clientVisible, clientDescription, allDay,
    submitting, setSubmitting,
    setError,
    resetFields,
  } = fields;
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [dependencySearch, setDependencySearch] = useState("");
  const [showCompletedDependencies, setShowCompletedDependencies] = useState(false);
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrencePattern, setRecurrencePattern] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly' | 'custom'>('weekly');
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceEndType, setRecurrenceEndType] = useState<'count' | 'date'>('date');
  const [recurrenceEndCount, setRecurrenceEndCount] = useState(4);
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('');
  const [recurrenceDaysOfWeek, setRecurrenceDaysOfWeek] = useState<number[]>([]);
  const [dateWarningOpen, setDateWarningOpen] = useState(false);
  const [completionWarningOpen, setCompletionWarningOpen] = useState(false);
  // The parent clears `editing` in the same handler that closes this. Keep the
  // record's visual state stable until Modal finishes its exit animation.
  const displayedEditing = useLastOpenValue(open, editing);
  const isEditing = !!displayedEditing;

  const dependencyEvents = (dependsOn || [])
    .map((dependencyId) => allEvents.find((event) => event.id === dependencyId))
    .filter((event): event is MatterEvent => !!event);
  const unresolvedDependencies = dependencyEvents.filter((event) => !isDependencyResolved(event));
  const parsedEventDate = date ? new Date(date) : null;
  const dateOrderWarnings = parsedEventDate && !Number.isNaN(parsedEventDate.getTime())
    ? dependencyEvents.filter((event) => {
        if (!event.date) return false;
        const dependencyDate = new Date(event.date);
        return !Number.isNaN(dependencyDate.getTime()) && parsedEventDate.getTime() < dependencyDate.getTime();
      })
    : [];

  const selectableDependencies = allEvents.filter(
    (event) => event.id !== displayedEditing?.id && event.status !== "cancelled"
  );
  const hiddenCompletedCount = selectableDependencies.filter(
    (event) => event.status === "completed" && !dependsOn.includes(event.id)
  ).length;
  const dependencyQuery = dependencySearch.trim().toLowerCase();
  const filteredDependencies = selectableDependencies
    .filter((event) => {
      // Completed events are still valid dependencies, but on a long-running matter
      // they outnumber the live ones, so keep them out of the way until asked for.
      if (event.status === "completed" && !showCompletedDependencies && !dependsOn.includes(event.id)) return false;
      if (!dependencyQuery) return true;
      return (
        event.title.toLowerCase().includes(dependencyQuery) ||
        matterEventTypeMeta(event.type).label.toLowerCase().includes(dependencyQuery)
      );
    })
    // Selected first so a choice can't scroll out of reach. The list arrives ordered
    // by date, and sort is stable, so each group stays in date order.
    .sort((a, b) => Number(dependsOn.includes(b.id)) - Number(dependsOn.includes(a.id)));
  const dependencyLimitReached = dependsOn.length >= MAX_EVENT_DEPENDENCIES;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      resetFields({
        type: editing.type,
        title: editing.title,
        ...eventScheduleFormValues(editing),
        notes: editing.notes || "",
        locationName: editing.locationName || "",
        location: editing.location || "",
        status: editing.status,
        assignedTo: editing.assignedTo || [],
        assignedToName: editing.assignedToName || [],
        contactIds: (editing.contacts || []).map((c) => c.contactId),
        linkedFiles: (editing.linkedFiles || []).map(f => ({
          fileId: f.fileId,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          scope: f.scope,
          scopeId: f.scopeId,
        })),
        clientVisible: editing.clientVisible ?? false,
        clientDescription: editing.clientDescription || "",
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the event being edited
      setDependsOn(editing.dependsOn || []);
      setRecurrenceEnabled(false); // Don't allow editing recurrence
    } else {
      resetFields({
        type: "court_date",
        title: "",
        date: "",
        endsAt: "",
        notes: "",
        locationName: defaultLocationName,
        location: defaultLocation,
        status: "upcoming",
        assignedTo: [],
        assignedToName: [],
        contactIds: [],
        linkedFiles: [],
        clientVisible: false,
        allDay: false,
      });
      setDependsOn([]);
      setRecurrenceEnabled(false);
      setRecurrencePattern('weekly');
      setRecurrenceInterval(1);
      setRecurrenceEndType('date');
      setRecurrenceEndCount(4);
      setRecurrenceEndDate('');
      setRecurrenceDaysOfWeek([]);
    }
    setDependencySearch("");
    setShowCompletedDependencies(false);
    setDateWarningOpen(false);
    setCompletionWarningOpen(false);
  }, [editing, open, defaultLocation, defaultLocationName, resetFields]);

  const handleTypeChange = (newType: MatterEventType) => {
    setType(newType);
  };

  const handleSubmit = async ({ skipCompletionWarning = false, skipDateWarning = false }: { skipCompletionWarning?: boolean; skipDateWarning?: boolean } = {}) => {
    if (!title.trim()) { setError("Title is required"); return; }
    if (!date) { setError("Date is required"); return; }
    if (!editing && recurrenceEnabled && recurrenceEndType === 'date' && !recurrenceEndDate) { setError("Select a recurrence end date"); return; }
    if (!skipCompletionWarning && status === "completed" && unresolvedDependencies.length > 0) {
      setCompletionWarningOpen(true);
      return;
    }
    if (!skipDateWarning && dateOrderWarnings.length > 0) {
      setDateWarningOpen(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        // Only the parts of the schedule the user changed: one left alone keeps
        // the value the server stores, which may be newer than this form's copy.
        const schedule = scheduleEdits(eventScheduleFormValues(editing), { date, endsAt, allDay });
        const payload: UpdateMatterEventRequest = {
          type, title,
          ...(schedule.date !== undefined ? { date } : {}),
          ...(schedule.endsAt !== undefined ? { endsAt: endsAtPayloadFor(allDay, endsAt) } : {}),
          ...(schedule.allDay !== undefined ? { allDay } : {}),
          notes: notes || null, locationName: locationName || null, location: location || null, status, assignedTo, assignedToName, contactIds, linkedFiles, dependsOn, clientVisible, clientDescription: clientDescription || null,
        };
        await matterEventsService.updateEvent(lawFirmId, matterId, editing.id, payload);
      } else {
        const payload: CreateMatterEventRequest = { type, title, date, endsAt: endsAtPayloadFor(allDay, endsAt) ?? undefined, notes: notes || undefined, locationName: locationName || undefined, location: location || undefined, status, assignedTo, assignedToName, contactIds, linkedFiles, dependsOn, clientVisible, clientDescription: clientDescription || undefined, allDay };
        if (recurrenceEnabled) {
          payload.recurrence = {
            pattern: recurrencePattern,
            interval: recurrenceInterval,
            endType: recurrenceEndType,
            ...(recurrenceEndType === 'count' ? { endCount: recurrenceEndCount } : { endDate: recurrenceEndDate }),
            ...(recurrencePattern === 'custom' && recurrenceDaysOfWeek.length > 0 ? { daysOfWeek: recurrenceDaysOfWeek } : {}),
          };
        }
        await matterEventsService.createEvent(lawFirmId, matterId, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save event"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <EntityEventForm
      open={open}
      onClose={onClose}
      onSubmit={() => handleSubmit()}
      lawFirmId={lawFirmId}
      fieldIds={fieldIds}
      fields={fields}
      isEditing={isEditing}
      editingId={editing?.id}
      addTitle="Add Matter Event"
      filePickerMatterId={matterId}
      typeField={
            <div>
              <FieldLabel id={`${fieldIds}-event-type-label`}>Event Type</FieldLabel>
              <Dropdown
                ariaLabelledBy={`${fieldIds}-event-type-label`}
                value={type}
                onChange={(value) => handleTypeChange(value as MatterEventType)}
                options={MATTER_EVENT_TYPE_OPTIONS}
                buttonClassName="border-input-border bg-input-bg"
                portal
              />
            </div>
      }
      afterDateFields={
            !isEditing && (
              <div>
                <Checkbox
                  checked={recurrenceEnabled}
                  onChange={setRecurrenceEnabled}
                  label="Repeat"
                />
                {recurrenceEnabled && (
                  <div className="mt-3 space-y-4 pl-6 border-l-2 border-blue-200 dark:border-accent-control-ring/30">
                    <div className="flex gap-3 items-center">
                      <Dropdown
                        value={recurrencePattern}
                        onChange={(value) => setRecurrencePattern(value as any)}
                        options={[
                          { value: "daily", label: "Daily" },
                          { value: "weekly", label: "Weekly" },
                          { value: "biweekly", label: "Biweekly" },
                          { value: "monthly", label: "Monthly" },
                          { value: "custom", label: "Custom" },
                        ]}
                        className="min-w-[160px]"
                        buttonClassName="border-input-border bg-input-bg"
                        portal
                      />
                      {(recurrencePattern === 'daily' || recurrencePattern === 'monthly') && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-on-surface-muted">every</span>
                          <input type="number" value={recurrenceInterval} onChange={(e) => setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))} min={1} max={365} className={INPUT_CLASS + " w-16 text-center"} />
                          <span className="text-xs text-on-surface-muted">{recurrencePattern === 'daily' ? 'day(s)' : 'month(s)'}</span>
                        </div>
                      )}
                    </div>
                    {recurrencePattern === 'custom' && (
                      <div>
                        <p className="text-xs text-on-surface-muted mb-1.5">Days of week:</p>
                        <div className="flex gap-1.5">
                          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setRecurrenceDaysOfWeek(recurrenceDaysOfWeek.includes(i) ? recurrenceDaysOfWeek.filter(x => x !== i) : [...recurrenceDaysOfWeek, i])}
                              className={`px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                                recurrenceDaysOfWeek.includes(i)
                                  ? "bg-accent-solid text-accent-foreground"
                                  : "bg-surface-alt text-on-surface-muted border border-outline"
                              }`}
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-3 items-center">
                      <span className="text-xs text-on-surface-muted">End:</span>
                      <Dropdown
                        value={recurrenceEndType}
                        onChange={(value) => setRecurrenceEndType(value as any)}
                        options={[
                          { value: "count", label: "After" },
                          { value: "date", label: "On date" },
                        ]}
                        className="min-w-[140px]"
                        buttonClassName="border-input-border bg-input-bg"
                        portal
                      />
                      {recurrenceEndType === 'count' ? (
                        <div className="flex items-center gap-2">
                          <input type="number" value={recurrenceEndCount} onChange={(e) => setRecurrenceEndCount(Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)))} min={1} max={1000} className={INPUT_CLASS + " w-16 text-center"} />
                          <span className="text-xs text-on-surface-muted">times</span>
                        </div>
                      ) : (
                        <DatePicker value={recurrenceEndDate} onChange={setRecurrenceEndDate} className="max-w-[160px]" />
                      )}
                    </div>
                    <p className="text-xs text-on-surface-muted italic">
                      {recurrenceEndType === 'count'
                        ? `Will create ${recurrenceEndCount} events total (including the first)`
                        : recurrenceEndDate ? `Repeats until ${formatDateOnly(recurrenceEndDate)}` : 'Select an end date'}
                    </p>
                  </div>
                )}
              </div>
            )
      }
      statusField={
            <div>
              <FieldLabel id={`${fieldIds}-status-label`}>Status</FieldLabel>
              <Dropdown
                ariaLabelledBy={`${fieldIds}-status-label`}
                value={status}
                onChange={(value) => setStatus(value as MatterEventStatus)}
                options={[
                  { value: "upcoming", label: "Upcoming" },
                  { value: "completed", label: "Completed" },
                  { value: "cancelled", label: "Cancelled" },
                ]}
                buttonClassName="border-input-border bg-input-bg"
                portal
              />
            </div>
      }
      afterVisibilityFields={
            selectableDependencies.length > 0 && (
              <div>
                <FieldLabel>Depends On</FieldLabel>
                <div className="space-y-2">
                  <input
                    className={INPUT_CLASS}
                    value={dependencySearch}
                    onChange={(e) => setDependencySearch(e.target.value)}
                    placeholder="Search events..."
                  />
                  <div className="max-h-56 overflow-y-auto overflow-x-hidden rounded-md border border-outline styled-scrollbar">
                    {filteredDependencies.length > 0 ? (
                      filteredDependencies.map((e) => {
                        const selected = dependsOn.includes(e.id);
                        return (
                          <label
                            key={e.id}
                            className={`flex items-center gap-2.5 px-3 py-2 transition-colors border-b border-outline-subtle last:border-b-0 ${
                              !selected && dependencyLimitReached
                                ? "opacity-50 cursor-not-allowed"
                                : "hover:bg-surface-hover cursor-pointer"
                            }`}
                          >
                            <Checkbox
                              checked={selected}
                              disabled={!selected && dependencyLimitReached}
                              onChange={() => {
                                setDependsOn(
                                  selected
                                    ? dependsOn.filter(id => id !== e.id)
                                    : [...dependsOn, e.id]
                                );
                              }}
                            />
                            <div className="min-w-0">
                              <p className="text-sm text-on-surface truncate">{e.title}</p>
                              <p className="text-xs text-on-surface-muted">
                                {matterEventTypeMeta(e.type).label} {e.dateLocalDisplay ? `· ${e.dateLocalDisplay}` : ""}
                              </p>
                            </div>
                          </label>
                        );
                      })
                    ) : (
                      <p className="px-3 py-2 text-sm text-on-surface-muted">No events found</p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    {hiddenCompletedCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => setShowCompletedDependencies(!showCompletedDependencies)}
                        className="text-xs text-on-surface-secondary hover:text-on-surface transition-colors cursor-pointer"
                      >
                        {showCompletedDependencies
                          ? "Hide completed events"
                          : `Show ${hiddenCompletedCount} completed event${hiddenCompletedCount === 1 ? "" : "s"}`}
                      </button>
                    ) : <span />}
                    {dependencyLimitReached && (
                      <p className="text-xs text-on-surface-muted">Maximum of {MAX_EVENT_DEPENDENCIES} dependencies.</p>
                    )}
                  </div>
                  {dependsOn.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {dependsOn.map((id) => {
                        const dep = allEvents.find(e => e.id === id);
                        if (!dep) return null;
                        return (
                          <StatusBadge key={id} variant="purple">
                            {dep.title}
                            <button type="button" onClick={() => setDependsOn(dependsOn.filter(d => d !== id))} className="ml-0.5 text-purple-600 dark:text-purple-300 hover:text-purple-800 cursor-pointer">&times;</button>
                          </StatusBadge>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
      }
      dialogs={
        <>
      <DependencyReviewModal
        open={completionWarningOpen}
        title="Complete With Unresolved Dependencies?"
        description="This event still depends on unfinished events. You can mark it completed anyway if that is intentional."
        dependencies={unresolvedDependencies}
        confirmText="Complete Anyway"
        onClose={() => setCompletionWarningOpen(false)}
        onConfirm={() => {
          setCompletionWarningOpen(false);
          handleSubmit({ skipCompletionWarning: true });
        }}
        loading={submitting}
      />

      <DependencyReviewModal
        open={dateWarningOpen}
        title="Save Event Out Of Order?"
        description="This event is scheduled before one or more dependencies. You can still save it if that ordering is intentional."
        dependencies={dateOrderWarnings}
        confirmText="Save Anyway"
        onClose={() => setDateWarningOpen(false)}
        onConfirm={() => {
          setDateWarningOpen(false);
          handleSubmit({ skipCompletionWarning: true, skipDateWarning: true });
        }}
        loading={submitting}
      />
        </>
      }
    />
  );
}

interface CancelEventModalProps {
  open: boolean;
  event: MatterEvent | null;
  onClose: () => void;
  onCancelled: () => void;
  lawFirmId: string;
  matterId: string;
}

function CancelEventModal({ open, event, onClose, onCancelled, lawFirmId, matterId }: CancelEventModalProps) {
  const fieldIds = useId();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets modal form fields when the modal opens
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (!event) return;
    if (!reason.trim()) { setError("Cancellation reason is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await matterEventsService.cancelEvent(lawFirmId, matterId, event.id, { reason: reason.trim() });
      onCancelled();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to cancel event"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Cancel Event"
      closeIcon={<X size={18} />}
      size="md"
      dismissible={!submitting}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Keep Event</Button>
          <Button type="danger" onClick={handleSubmit} loading={submitting} disabled={submitting || !reason.trim()}>Cancel Event</Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      <p className="text-sm text-on-surface-secondary">Cancel &quot;{event?.title}&quot;? This will remove it from your calendar.</p>
      <div>
        <FieldLabel htmlFor={`${fieldIds}-reason`}>Reason *</FieldLabel>
        <textarea
          id={`${fieldIds}-reason`}
          value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this event being cancelled?" rows={3} className={INPUT_CLASS} maxLength={1000} />
      </div>
    </Modal>
  );
}

interface PostponeModalProps {
  open: boolean;
  event: MatterEvent | null;
  onClose: () => void;
  onPostponed: () => void;
  lawFirmId: string;
  matterId: string;
}

function PostponeModal({ open, event, onClose, onPostponed, lawFirmId, matterId }: PostponeModalProps) {
  const fieldIds = useId();
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs modal form fields to the target event when the modal opens
  useEffect(() => { if (open) { setNewDate(event?.dateLocalInput || ""); setReason(""); setError(null); } }, [open, event]);

  const handleSubmit = async () => {
    if (!event) return;
    if (!newDate) { setError("New date is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await matterEventsService.postponeEvent(lawFirmId, matterId, event.id, { newDate, reason: reason.trim() || undefined });
      onPostponed();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to postpone event"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Postpone Event"
      closeIcon={<X size={18} />}
      size="md"
      dismissible={!submitting}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting} disabled={submitting || !newDate}>Postpone</Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      <p className="text-sm text-on-surface-secondary">
        Reschedule &quot;{event?.title}&quot; from {event?.dateLocalDisplay || "current date"}.
      </p>
      <div className="space-y-1">
        <DateTimeRangeFields
          idPrefix={`${fieldIds}-postpone`}
          allDay={event?.allDay === true}
          startLabel="New start"
          startRequired
          start={newDate}
          onStartChange={setNewDate}
          onStartOpen={() => setNewDate(getDefaultDateTimeLocalValue())}
          end=""
          onEndChange={() => {}}
          showEnd={false}
        />
        {event?.endsAt && (
          <p className="text-xs text-on-surface-muted">The end moves with it, so the event keeps its length.</p>
        )}
      </div>
      <div>
        <FieldLabel htmlFor={`${fieldIds}-reason`}>Reason</FieldLabel>
        <textarea
          id={`${fieldIds}-reason`}
          value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this event being postponed?" rows={3} className={INPUT_CLASS} maxLength={1000} />
      </div>
    </Modal>
  );
}

interface MatterEventsTabProps {
  lawFirmId: string;
  matterId: string;
  canManage: boolean;
  courtId?: string;
  courtName?: string;
  onEventsChange?: (events: MatterEvent[]) => void;
}

export default function MatterEventsTab({ lawFirmId, matterId, canManage, courtId, courtName, onEventsChange }: MatterEventsTabProps) {
  const { user: currentUser } = useAuth();
  const { hasPermission } = usePermissions();
  const { settings } = useFirmSettings();
  const billingTimer = useBillingTimer();
  const queryClient = useQueryClient();
  // Matter-scoped events come from the shared React Query hook so the list is
  // fetched once for both this tab and the matter detail overview panel.
  const { events, error: eventsError } = useMatterEventsList(lawFirmId, matterId);
  // The whole matter's dependency links, unpaged. Blocking and the dependency
  // chips read this, never `events` - see useMatterEventGraph for why.
  const { nodes: eventGraph } = useMatterEventGraph(lawFirmId, matterId);
  const graphById = useMemo(
    () => new Map(eventGraph.map((node) => [node.id, node])),
    [eventGraph],
  );

  const filter = useEventStatusFilter();

  // Preview for a linked-file chip on an event card, shown in the same modal
  // every other file-view affordance uses rather than opening a new tab.
  const [previewFileInfo, setPreviewFileInfo] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const handlePreviewDownload = async () => {
    if (!previewFileInfo) return;
    try {
      const signedUrl = previewFileInfo.id
        ? await filesService.refreshSignedUrl(lawFirmId, previewFileInfo.id)
        : previewFileInfo.signedUrl;
      if (signedUrl) await filesService.downloadFile(signedUrl, previewFileInfo.name);
    } catch { /* ignore */ }
  };

  // Each section is its own server page. Completed and cancelled events accumulate
  // for the life of the matter and are never pruned, so the browser never holds
  // the whole history.
  const upcomingPager = useMatterEventsPage(lawFirmId, matterId, "upcoming", filter.showUpcoming);
  const completedPager = useMatterEventsPage(lawFirmId, matterId, "completed", filter.showCompleted);
  const cancelledPager = useMatterEventsPage(lawFirmId, matterId, "cancelled", filter.showCancelled);

  // Every mutation refreshes the graph AND all three sections. A new or resolved
  // dependency link is invisible to blocking until the graph is re-read, and a
  // completed event leaves one section for another, so refreshing just the one
  // that was acted on would leave the event showing in both places or neither.
  //
  // One invalidation on the shared key prefix rather than a fan of `refetch()`
  // calls. `refetch()` ignores a query's `enabled` flag, so the fan re-read the
  // two sections the status chips had filtered OUT of view as eagerly as the one
  // on screen: five simultaneous requests from a single click, against an API
  // instance holding twelve Postgres pool connections. Invalidating refetches
  // what is mounted and marks the rest stale, so a hidden section is re-read
  // when (and only when) it comes back.
  const refreshEvents = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["matterEvents", lawFirmId, matterId] });
  }, [queryClient, lawFirmId, matterId]);
  // Local error is reserved for mutation failures (delete/complete); the fetch
  // error is surfaced from the hook alongside it.
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<MatterEvent | null>(null);
  const [deletingEvent, setDeletingEvent] = useState<MatterEvent | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteRecurringOpen, setDeleteRecurringOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const closeDeleteRecurring = useCallback(() => {
    if (deleting) return;
    setDeleteRecurringOpen(false);
  }, [deleting]);
  const [cancellingEvent, setCancellingEvent] = useState<MatterEvent | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [postponingEvent, setPostponingEvent] = useState<MatterEvent | null>(null);
  const [postponeOpen, setPostponeOpen] = useState(false);
  const [completionOverrideEvent, setCompletionOverrideEvent] = useState<MatterEvent | null>(null);
  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [timeEntryPrefill, setTimeEntryPrefill] = useState<TimerPrefill | null>(null);
  const closeTimeEntryModal = useCallback(() => {
    setAddTimeEntryOpen(false);
    setTimeEntryPrefill(null);
  }, []);
  // Closes the modal, then opens the composer when the save chose "bill now".
  const billNowRedirect = useBillNowRedirect(lawFirmId, closeTimeEntryModal);
  const [applySetOpen, setApplySetOpen] = useState(false);
  // The roster and charge codes feed only the time-entry modal, so they load
  // when it first opens. Courts are read only to prefill a new event with the
  // matter's court address, so a matter with no court never loads them. They
  // are not deferred to the event modal: it resets its form when that default
  // changes, which would wipe what the user had started typing.
  const { users } = useLawFirmUsers(lawFirmId, addTimeEntryOpen);
  const { matter } = useMatterById(lawFirmId, matterId);
  const { chargeCodes } = useChargeCodes(lawFirmId, false, addTimeEntryOpen);
  const { courts } = useCourts(lawFirmId, !!courtId);
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");

  const defaultCourtLocationName = courtName?.trim() || "";
  const defaultCourtLocation = courtId
    ? courts.find((court) => court.id === courtId)?.address?.trim() || ""
    : "";
  const matterLabel = matter?.name || "Matter Work";

  // Report the fetched events up to the parent (overview panel counts/badges).
  // The parent's overview panel needs fields the graph does not carry (type,
  // display date), and it already re-derives its own counts from its unpaged
  // fetch of the same list, so this keeps publishing the full events.
  useEffect(() => { onEventsChange?.(events); }, [events, onEventsChange]);

  const handleLogTime = useCallback((event: MatterEvent) => {
    if (!canManageTimeEntries) return;
    const defaultChargeCodeId = settings.billing.eventTypeChargeCodeDefaults?.[event.type] || null;
    setTimeEntryPrefill({
      matterId,
      userId: currentUser?.uid || null,
      date: event.date || null,
      name: `${matterEventTypeMeta(event.type).label}: ${event.title}`,
      description: event.notes || undefined,
      chargeCodeId: defaultChargeCodeId,
      sourceEventId: event.id,
      sourceEventTitle: event.title,
    });
    setAddTimeEntryOpen(true);
  }, [canManageTimeEntries, matterId, currentUser?.uid, settings.billing.eventTypeChargeCodeDefaults]);
  const handleStartTimer = useCallback((event: MatterEvent) => {
    if (!canManageTimeEntries) return;
    billingTimer.startTimer({
      matterId,
      targetLabel: matterLabel,
      name: `${matterEventTypeMeta(event.type).label}: ${event.title}`,
      description: event.notes || "",
      chargeCodeId: settings.billing.eventTypeChargeCodeDefaults?.[event.type] || null,
      sourceEventId: event.id,
      sourceEventTitle: event.title,
    });
  }, [billingTimer, canManageTimeEntries, matterId, matterLabel, settings.billing.eventTypeChargeCodeDefaults]);

  const handleDelete = async (deleteSeries = false) => {
    if (!deletingEvent) return;
    setDeleting(true);
    try {
      if (deleteSeries && deletingEvent.recurrenceGroupId) {
        await matterEventsService.deleteRecurrenceGroup(lawFirmId, matterId, deletingEvent.recurrenceGroupId);
      } else {
        await matterEventsService.deleteEvent(lawFirmId, matterId, deletingEvent.id);
      }
      // Close via the open flags (keep deletingEvent so its title stays
      // visible during the close animation; it's overwritten on next open).
      setDeleteConfirmOpen(false);
      setDeleteRecurringOpen(false);
      await refreshEvents();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete event"));
    } finally {
      setDeleting(false);
    }
  };

  const [completingEventId, setCompletingEventId] = useState<string | null>(null);

  // Resolved against the whole matter's graph, never the rows on screen. A
  // dependency that merely was not loaded would be dropped by the filter below
  // and read as "no dependency", which is how a blocked deadline looks unblocked.
  const getDependencyEvents = useCallback((event: Pick<MatterEvent, "dependsOn">) => (
    (event.dependsOn || [])
      .map((dependencyId) => graphById.get(dependencyId))
      .filter((candidate): candidate is EventGraphNode => !!candidate)
  ), [graphById]);

  const getUnresolvedDependencies = useCallback((event: MatterEvent) => (
    getDependencyEvents(event).filter((dependency) => !isDependencyResolved(dependency))
  ), [getDependencyEvents]);

  const handleMarkComplete = useCallback(async (event: MatterEvent, skipWarning = false) => {
    const unresolvedDependencies = getUnresolvedDependencies(event);
    if (!skipWarning && unresolvedDependencies.length > 0) {
      setCompletionOverrideEvent(event);
      return;
    }
    setCompletingEventId(event.id);
    try {
      await matterEventsService.updateEvent(lawFirmId, matterId, event.id, {
        status: "completed",
      });
      await refreshEvents();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update event"));
    } finally {
      setCompletingEventId(null);
    }
  }, [matterId, getUnresolvedDependencies, lawFirmId, refreshEvents]);

  const getRequiredBy = (event: MatterEvent) => eventGraph.filter((node) => node.dependsOn?.includes(event.id));

  // A row has details when anything in its disclosure panel (dependencies,
  // contacts, notes, linked files, postponement history, etc.) would render.
  // Blocking is read from the graph, so a row can have details that the loaded
  // page alone would not reveal.
  const eventHasDetails = (event: MatterEvent, unresolvedDependencies: EventGraphNode[], requiredBy: EventGraphNode[]) =>
    unresolvedDependencies.length > 0
    || !!(event.status === "cancelled" && event.cancellationReason)
    || !!(event.contacts && event.contacts.length > 0)
    || !!event.notes
    || !!(eventCourtName("matter", event) || event.locationName || event.location)
    || !!(event.linkedFiles && event.linkedFiles.length > 0)
    || !!(event.dependsOn && event.dependsOn.length > 0)
    || requiredBy.length > 0
    || !!(event.postponementHistory && event.postponementHistory.length > 0);

  const adapter: EntityEventsAdapter<MatterEvent> = {
    detailsIdPrefix: "event-details-",
    hasDetails: (event) => eventHasDetails(event, getUnresolvedDependencies(event), getRequiredBy(event)),
    renderBadges: (event, { isOverdue }) => {
      const isBlocked = event.status === "upcoming" && getUnresolvedDependencies(event).length > 0;
      return (
        <>
          {isBlocked && <StatusBadge variant="warning">Blocked</StatusBadge>}
          {isOverdue && <StatusBadge variant="danger">Overdue</StatusBadge>}
          {(event.postponementCount ?? 0) > 0 && (
            <StatusBadge variant="warning">Postponed &times;{event.postponementCount}</StatusBadge>
          )}
          {event.recurrenceGroupId && (
            <StatusBadge variant="indigo"><Repeat size={10} /> Recurring</StatusBadge>
          )}
        </>
      );
    },
    renderMeta: (event) => (
      <>
        <ZonedEventTime
          when={eventListWhen(event)}
          zone={eventZoneSuffix({ start: event.date, end: event.endsAt, timeZone: event.timeZone, allDay: event.allDay })}
          inheritTone
        />
        {event.assignedToName && event.assignedToName.length > 0 && `  ·  ${event.assignedToName.join(", ")}`}
      </>
    ),
    renderDetails: (event) => {
      const unresolvedDependencies = getUnresolvedDependencies(event);
      const courtName = eventCourtName("matter", event);
      const isBlocked = event.status === "upcoming" && unresolvedDependencies.length > 0;
      const requiredBy = getRequiredBy(event);
      return (
        <>
          {isBlocked && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <Ban size={12} className="shrink-0" />
              <span className="font-medium">
                Blocked by {unresolvedDependencies.length} unresolved {unresolvedDependencies.length === 1 ? "dependency" : "dependencies"}:
              </span>
              {unresolvedDependencies.map((dependency) => (
                <StatusBadge key={dependency.id} variant="warning">{dependency.title}</StatusBadge>
              ))}
            </div>
          )}
          {event.status === "cancelled" && event.cancellationReason && (
            <p className="text-xs italic text-red-600 dark:text-red-400">Reason: {event.cancellationReason}</p>
          )}
          {/* Non-member attendees, in the directory's own colours so an opposing
              counsel on a deposition is not mistaken for a colleague assigned to it. */}
          {event.contacts && event.contacts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-on-surface-secondary">Attendees:</span>
              {event.contacts.map((contact) => (
                <ContactCategoryBadge key={contact.contactId} category={contact.category}>
                  {contact.name}
                </ContactCategoryBadge>
              ))}
            </div>
          )}
          {event.notes && (
            <p className="text-xs leading-relaxed text-on-surface-muted"><LinkifiedText text={event.notes} /></p>
          )}
          {(courtName || event.locationName || event.location) && (
            <div className="space-y-0.5">
              {courtName && (
                <p className="text-xs font-medium text-on-surface-secondary">{courtName}</p>
              )}
              {event.locationName && (
                <p className="text-xs font-medium text-on-surface-secondary"><LinkifiedText text={event.locationName} /></p>
              )}
              {event.location && (
                <p className="text-xs leading-relaxed text-on-surface-muted"><LinkifiedText text={event.location} /></p>
              )}
            </div>
          )}
          {event.linkedFiles && event.linkedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {event.linkedFiles.map((f) => (
                <button
                  key={f.fileId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewFileInfo({
                      id: f.fileId,
                      name: f.name,
                      size: f.size,
                      contentType: f.contentType,
                    });
                    setIsPreviewOpen(true);
                  }}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium bg-surface text-on-surface-secondary hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <FileText size={10} />
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {event.dependsOn && event.dependsOn.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-on-surface-muted">
              <Link2 size={11} />
              <span>Depends on:</span>
              {event.dependsOn.map((depId) => {
                const dep = graphById.get(depId);
                return dep ? (
                  <span key={depId} className="font-medium text-purple-600 dark:text-purple-400">{dep.title}</span>
                ) : null;
              })}
            </div>
          )}
          {requiredBy.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-on-surface-muted">
              <Link2 size={11} />
              <span>Required by:</span>
              {requiredBy.map((dep) => (
                <span key={dep.id} className="font-medium text-purple-600 dark:text-purple-400">{dep.title}</span>
              ))}
            </div>
          )}
          {event.postponementHistory && event.postponementHistory.length > 0 && (
            <div className="space-y-1 border-l-2 border-amber-200 pl-3 dark:border-amber-500/30">
              <p className="text-[11px] font-medium text-on-surface-secondary">Postponement history</p>
              {event.postponementHistory.map((entry, i) => (
                <div key={i} className="text-xs text-on-surface-muted">
                  <span className="font-medium">{entry.previousDate ? new Date(entry.previousDate).toLocaleDateString() : "?"}</span>
                  {" → "}
                  <span className="font-medium">{entry.newDate ? new Date(entry.newDate).toLocaleDateString() : "?"}</span>
                  {entry.reason && <span className="italic ml-1">, {entry.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      );
    },
    // Same conditions the inline buttons carried, so an action a user could not
    // reach before is not suddenly offered. Falsy entries are dropped because
    // RowActionMenu renders whatever it is given.
    rowActions: (event) => {
      if (!canManage && !canManageTimeEntries) return null;
      const isBlocked = event.status === "upcoming" && getUnresolvedDependencies(event).length > 0;

      const rowMenuActions: RowAction[] = [
        canManageTimeEntries && event.status !== "cancelled" && {
          label: "Start timer",
          icon: <Play className="w-4 h-4" />,
          onClick: () => handleStartTimer(event),
        },
        canManageTimeEntries && event.status !== "cancelled" && {
          label: "Log time",
          icon: <Clock className="w-4 h-4" />,
          onClick: () => handleLogTime(event),
        },
        canManage && event.status === "upcoming" && {
          label: "Postpone event",
          icon: <CalendarClock className="w-4 h-4" />,
          onClick: () => { setPostponingEvent(event); setPostponeOpen(true); },
        },
        canManage && event.status === "upcoming" && {
          label: "Cancel event",
          icon: <Ban className="w-4 h-4" />,
          onClick: () => { setCancellingEvent(event); setCancelOpen(true); },
        },
        canManage && {
          label: "Edit event",
          icon: <Pencil className="w-4 h-4" />,
          onClick: () => setEditingEvent(event),
        },
        canManage && {
          label: "Delete event",
          icon: <Trash2 className="w-4 h-4" />,
          danger: true,
          onClick: () => {
            setDeletingEvent(event);
            if (event.recurrenceGroupId) setDeleteRecurringOpen(true);
            else setDeleteConfirmOpen(true);
          },
        },
      ].filter(Boolean) as RowAction[];

      return {
        // Completing an event is the one action taken from the list often
        // enough to earn a permanent button; the rest are occasional, so they
        // live behind the kebab rather than crowding every row.
        primary: canManage && event.status !== "cancelled" && event.status !== "completed" && (
          <ActionIconButton
            label={isBlocked ? "Mark as completed with unresolved dependencies" : "Mark as completed"}
            onClick={() => handleMarkComplete(event)}
            disabled={completingEventId === event.id}
            tone={isBlocked ? "warning" : "success"}
            emphasis={isBlocked}
          >
            {completingEventId === event.id ? (
              <Spinner size={15} />
            ) : (
              <CheckCircle size={15} />
            )}
          </ActionIconButton>
        ),
        menu: rowMenuActions,
      };
    },
    // Every menu entry is permission-gated, so a viewer who can only log time
    // on a cancelled event gets an empty menu, which is dropped.
    hideEmptyRowMenu: true,
    emptyMessage: {
      canManage: "Add court dates, deadlines, and hearings to track important dates for this matter.",
      readOnly: "No events have been added for this matter.",
    },
  };

  return (
    <EntityEventsTab<MatterEvent>
      canManage={canManage}
      filter={filter}
      sections={{ upcoming: upcomingPager, completed: completedPager, cancelled: cancelledPager }}
      error={error || eventsError}
      onDismissError={() => setError(null)}
      onAdd={() => setAddOpen(true)}
      headerActions={
        <Button
          type="secondary"
          size="compact"
          onClick={() => setApplySetOpen(true)}
          icon={<CalendarClock size={14} />}
        >
          Apply Deadline Set
        </Button>
      }
      adapter={adapter}
    >
      <TimeEntryModal
        open={addTimeEntryOpen}
        onClose={() => {
          setAddTimeEntryOpen(false);
          setTimeEntryPrefill(null);
        }}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        defaultUserId={currentUser?.uid}
        defaultTarget={`matter:${matterId}`}
        scopeMatterId={matterId}
        prefill={timeEntryPrefill}
        onSuccess={billNowRedirect}
      />

      <EventFormModal
        open={addOpen || !!editingEvent}
        onClose={() => { setAddOpen(false); setEditingEvent(null); }}
        onSaved={refreshEvents}
        lawFirmId={lawFirmId}
        matterId={matterId}
        editing={editingEvent}
        allEvents={events}
        defaultLocationName={defaultCourtLocationName}
        defaultLocation={defaultCourtLocation}
      />

      <ApplyDeadlineSetModal
        open={applySetOpen}
        lawFirmId={lawFirmId}
        matterId={matterId}
        onClose={() => setApplySetOpen(false)}
        onApplied={async () => {
          setApplySetOpen(false);
          await refreshEvents();
        }}
      />

      <FilePreviewModal
        file={previewFileInfo}
        isOpen={isPreviewOpen}
        onClose={() => { setIsPreviewOpen(false); setPreviewFileInfo(null); }}
        onDownload={handlePreviewDownload}
        lawFirmId={lawFirmId}
      />

      <ConfirmModal
        isOpen={deleteConfirmOpen}
        title="Delete Event"
        message={`Are you sure you want to delete "${deletingEvent?.title}"? This will also remove it from your calendar.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
        onConfirm={() => handleDelete(false)}
        onClose={() => setDeleteConfirmOpen(false)}
      />
      <Modal
        isOpen={deleteRecurringOpen}
        onClose={closeDeleteRecurring}
        title="Delete Recurring Event"
        showClose={false}
        size="sm"
        dismissible={!deleting}
        bodyClassName="px-6 py-5 space-y-3"
        footer={<Button type="secondary" onClick={closeDeleteRecurring} className="w-full">Cancel</Button>}
      >
        <p className="text-sm text-on-surface-secondary">
          &quot;{deletingEvent?.title}&quot; is part of a recurring series.
        </p>
        <div className="space-y-2">
          <Button type="danger" onClick={() => handleDelete(false)} loading={deleting} className="w-full">
            Delete This Event Only
          </Button>
          <Button type="danger" onClick={() => handleDelete(true)} loading={deleting} className="w-full">
            Delete All Events in Series
          </Button>
        </div>
      </Modal>

      <CancelEventModal
        open={cancelOpen}
        event={cancellingEvent}
        onClose={() => setCancelOpen(false)}
        onCancelled={refreshEvents}
        lawFirmId={lawFirmId}
        matterId={matterId}
      />

      <PostponeModal
        open={postponeOpen}
        event={postponingEvent}
        onClose={() => setPostponeOpen(false)}
        onPostponed={refreshEvents}
        lawFirmId={lawFirmId}
        matterId={matterId}
      />

      <DependencyReviewModal
        open={!!completionOverrideEvent}
        title="Complete Blocked Event?"
        description="This event still depends on unfinished events. You can mark it completed anyway if that is intentional."
        dependencies={completionOverrideEvent ? getUnresolvedDependencies(completionOverrideEvent) : []}
        confirmText="Complete Anyway"
        onClose={() => setCompletionOverrideEvent(null)}
        onConfirm={() => {
          if (!completionOverrideEvent) return;
          const eventToComplete = completionOverrideEvent;
          setCompletionOverrideEvent(null);
          handleMarkComplete(eventToComplete, true);
        }}
        loading={completionOverrideEvent ? completingEventId === completionOverrideEvent.id : false}
      />
    </EntityEventsTab>
  );
}
