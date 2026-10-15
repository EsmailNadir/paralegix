'use client';

import { useId } from "react";
import React, { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import { Plus, User as UserIcon, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Task, Event, User, SyncFlags, PaymentDate, TaskStatus, BillingContext } from '../../types';
import { useNavigation } from '@/contexts/NavigationContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import ToggleSwitch from '../ui/ToggleSwitch';
import EntityPicker from '../ui/EntityPicker';
import ConfirmModal from '../ui/ConfirmModal';
import Checkbox from '../ui/Checkbox';
import Modal from '../ui/Modal';
import ErrorNotification from '../ErrorNotification';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { getDefaultDateTimeLocalValue } from '@/lib/utils/dateUtils';
import billingService from '@/services/billing.service';
import { paymentDatePayableAmount, paymentDateRemaining } from '@/lib/billing/paymentDateBalance';
import TaskStatusBadge from '@/components/ui/TaskStatusBadge';
import Tooltip from "@/components/ui/Tooltip";
import { getTaskColor } from './calendarColors';
import { eventStartValue, taskMinuteOfDay, eventMinuteOfDay, timedInputFromAllDay, formatEventWhen, eventZoneSuffix, endFormValueFor, endsAtPayloadFor, endFitsStart, endFollowingStart, taskEndSuffix, endAcrossAllDayToggle, timedFormValueFor, defaultEndFor, scheduleEdits, eventTimeLabel, type ScheduleFields } from './calendarTiming';
import ZonedEventTime from './ZonedEventTime';
import LinkifiedText from '@/components/ui/LinkifiedText';
import Spinner from '@/components/ui/Spinner';
import { MATTER_EVENT_TYPE_OPTIONS as EVENT_TYPE_OPTIONS, matterEventTypeMeta } from '@/constants/statusMeta';
import StatusBadge from '@/components/ui/StatusBadge';
import CreateTaskModal from '@/components/taskComp/CreateTaskModal';
import EditTaskModal from '@/components/taskComp/EditTaskModal';
import { useCreateTask, useEditTask } from '@/hooks/taskHooks/useTasks';
import useCourts from '@/hooks/courtHooks/useCourts';
import EventFormWizard from '@/components/eventComp/EventFormWizard';
import DateTimeRangeFields from '@/components/eventComp/DateTimeRangeFields';
import FieldLabel from '@/components/ui/FieldLabel';
import TextInput from '@/components/ui/TextInput';
import SectionLabel from '@/components/ui/SectionLabel';

const EVENT_STATUS_OPTIONS = [
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Completed', value: 'completed' },
] as const;

const GOOGLE_TASK_READONLY_NOTICE_PATTERN = /\s*Changes made to the title, description, or attachments will not be saved\.\s*To make edits,\s*please go to:\s*https:\/\/tasks\.google\.com\/task\/[^\s\n]+/gi;

const EVENT_NOTES_TEXTAREA_ROWS = 4;

/** View-mode card body: scroll long content only (no resize grip; edit forms keep textarea resize-y). */
const SIDE_PANEL_VIEW_BODY_CLASS =
  'mt-1 w-full max-w-full max-h-[min(70vh,26rem)] overflow-y-auto overflow-x-hidden styled-scrollbar';

/**
 * The one location field an event's edit form changes and saves as `location`.
 * An imported event has a single location. A firm event's `location` is its
 * location name and address joined for display, so the form edits the address
 * alone and the location name is left as it is.
 */
function editableLocation(event: Event): string {
  return (event.source === 'external' ? event.location : event.locationAddress) || '';
}

function sanitizeCalendarText(value?: string | null): string {
  if (!value) return '';
  const cleaned = value.replace(GOOGLE_TASK_READONLY_NOTICE_PATTERN, '').trim();
  // Older syncs left an empty source-marker wrapper in otherwise blank notes.
  return /^\(\s*\)$/.test(cleaned) ? '' : cleaned;
}

// Which scheduled item the detail popup is showing. Clicking a card in the panel
// opens a read-only popup of the item rather than navigating straight to it.
export type CalendarDetailItem =
  | { kind: 'task'; task: Task }
  | { kind: 'event'; event: Event }
  | { kind: 'payment'; payment: PaymentDate };

export type CalendarDetailRequest = {
  id: number;
  item: CalendarDetailItem;
};

/** A labelled value row inside the detail popup. Renders nothing when empty. */
function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === false || children === '') return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-muted">{label}</span>
      <span className="text-sm text-on-surface break-words">{children}</span>
    </div>
  );
}

interface CalendarSidePanelProps {
  panelOpen: boolean;
  selectedDate: dayjs.Dayjs | null;
  selectedDayTasks: Task[];
  selectedDayEvents: Event[];
  selectedDayPaymentDates?: PaymentDate[];
  lawFirmId: string | null;
  lawFirmUsers: User[];
  syncFlags: SyncFlags | null;
  onClose: () => void;
  onTasksRefresh?: () => void;
  onTaskUpdate: (task: Task) => void;
  onTaskDelete: (taskId: string) => void;
  /**
   * Saves an event. `date`, `endsAt` and `allDay` are present only when they
   * changed; an absent one leaves the stored value alone.
   */
  onEventUpdate: (event: Event, updates: { title: string; date?: string; endsAt?: string; eventType: string; notes: string | null; location: string | null; eventStatus: string; allDay?: boolean; confirmNotifyAttendees?: boolean }) => Promise<void>;
  onEventDelete: (event: Event, wholeSeries?: boolean) => Promise<void>;
  onEventCreate?: (eventData: { title: string; date: string; endsAt?: string | null; eventType: string; notes?: string | null; location?: string | null; linkType: 'matter' | 'client'; matterId?: string; clientId?: string; allDay: boolean }) => Promise<void>;
  initialDueDate?: string;
  currentUserId?: string;
  /** Passed straight through to the shared CreateTaskModal, matching the Tasks page. */
  updateCourtAddress?: (courtId: string, address: string) => Promise<unknown>;
  /** Key of the grid block the user clicked (`task-<id>` / `event-<id>`), to highlight & scroll into view. */
  selectedItemKey?: string | null;
  /** Keys of multiple items to highlight at once (e.g. every all-day item when the week "+N" chip is clicked). */
  highlightedItemKeys?: string[];
  /** Hide the header close button when the panel is permanently docked (desktop). */
  showClose?: boolean;
  detailRequest?: CalendarDetailRequest | null;
  onDetailOpen?: () => void;
  onDetailClose?: () => void;
}

const CalendarSidePanel: React.FC<CalendarSidePanelProps> = ({
  panelOpen,
  selectedDate,
  selectedDayTasks,
  selectedDayEvents,
  selectedDayPaymentDates = [],
  lawFirmId,
  lawFirmUsers,
  onClose,
  onTasksRefresh,
  onTaskUpdate,
  onTaskDelete,
  onEventUpdate,
  onEventDelete,
  onEventCreate,
  initialDueDate = '',
  selectedItemKey = null,
  highlightedItemKeys = [],
  showClose = true,
  detailRequest = null,
  onDetailOpen,
  onDetailClose,
  updateCourtAddress,
}) => {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageCourts = hasPermission('courts.manage');
  // Each write below is refused by the backend without its own code, so a
  // control the viewer lacks is hidden rather than offered and then refused.
  const canCreateTask = hasPermission('tasks.create');
  const canUpdateTask = hasPermission('tasks.update');
  const canDeleteTask = hasPermission('tasks.delete');
  const canCreateMatterEvent = hasPermission('matters.update');
  const canCreateClientEvent = hasPermission('clients.manage');
  const canRecordPayments = hasPermission('billing.recordPayments');
  const canCreateAnyEvent = canCreateMatterEvent || canCreateClientEvent;
  // A matter event is written through the matter (matters.update), a client
  // event through the client (clients.manage), and an imported event through
  // the calendar connection (calendar.sync).
  const canManageEvent = (event: Event) =>
    event.source === 'matter' ? canCreateMatterEvent
      : event.source === 'client' ? canCreateClientEvent
        : event.source === 'external' ? hasPermission('calendar.sync') && (!event.meeting?.attendees.length || event.meeting.isOrganizer === true)
          : false;
  const queryClient = useQueryClient();
  const selectedItemRef = React.useRef<HTMLDivElement | null>(null);

  // A block is highlighted if it's the single clicked item or part of a
  // multi-item highlight (the week "+N" all-day chip). The first such key also
  // gets scrolled into view.
  const isHighlighted = (key: string) => selectedItemKey === key || highlightedItemKeys.includes(key);
  const scrollKey = selectedItemKey || highlightedItemKeys[0] || null;

  // Scroll the highlighted task/event card into view when the selection changes.
  useEffect(() => {
    if (!scrollKey || !panelOpen) return;
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [scrollKey, panelOpen, selectedDayTasks, selectedDayEvents]);
  const create = useCreateTask(lawFirmId ?? undefined, onTasksRefresh);
  const edit = useEditTask(lawFirmId ?? undefined, onTasksRefresh);
  // The court picker lives only in the task modals below, so the firm's courts
  // load when one of them first opens. The cache key is shared with every other
  // court picker, so reopening does not refetch.
  const { courts, loading: courtsLoading, createCourt } = useCourts(lawFirmId ?? undefined, create.open || edit.open);
  const [deletingTask, setDeletingTask] = useState<string | null>(null);
  // Id of the task pending a delete confirmation (drives the confirm modal).
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [deleteTaskError, setDeleteTaskError] = useState<string | null>(null);

  // Event editing state
  const [editingEvent, setEditingEvent] = useState<{ event: Event; opened: ScheduleFields; title: string; date: string; endsAt: string; eventType: string; notes: string; location: string; eventStatus: string; allDay: boolean } | null>(null);
  const [notifyConfirmationOpen, setNotifyConfirmationOpen] = useState(false);
  // Drives the edit-event modal's open/close animation. `editingEvent` holds the
  // form data and is left populated through the exit so the modal doesn't blank.
  const [editEventOpen, setEditEventOpen] = useState(false);
  const [eventSubmitting, setEventSubmitting] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);
  const [deletingEventId, setDeletingEventId] = useState<string | null>(null);
  // Event pending a delete confirmation (drives the confirm modal).
  const [eventToDelete, setEventToDelete] = useState<Event | null>(null);
  const [deleteWholeSeries, setDeleteWholeSeries] = useState(false);
  const [deleteEventError, setDeleteEventError] = useState<string | null>(null);

  // Event creation state
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventDate, setNewEventDate] = useState('');
  const [newEventEndsAt, setNewEventEndsAt] = useState('');
  const [newEventType, setNewEventType] = useState('other');
  const [newEventNotes, setNewEventNotes] = useState('');
  const [newEventLocation, setNewEventLocation] = useState('');
  const [newEventLinkTypeChoice, setNewEventLinkType] = useState<'matter' | 'client'>('matter');
  // Only the link targets the viewer may write to are offered, so a viewer who
  // can write to one kind only is always linking to that kind.
  const newEventLinkType: 'matter' | 'client' = !canCreateClientEvent ? 'matter'
    : !canCreateMatterEvent ? 'client'
      : newEventLinkTypeChoice;
  const [newEventAllDay, setNewEventAllDay] = useState(false);
  const [newEventMatterId, setNewEventMatterId] = useState('');
  const [newEventClientId, setNewEventClientId] = useState('');
  const [eventCreateSubmitting, setEventCreateSubmitting] = useState(false);
  const [eventCreateError, setEventCreateError] = useState<string | null>(null);

  // The form state above lives on this always-mounted panel, so a draft
  // survives closing and reopening a modal (`Modal` itself drives the
  // enter/exit animation).

  // Read-only detail popup shown when a card in the panel is clicked. `detailItem`
  // holds the data; `detailOpen` drives the open/close animation so the data
  // stays rendered through the exit transition.
  const [detailItem, setDetailItem] = useState<CalendarDetailItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [paymentToMarkPaid, setPaymentToMarkPaid] = useState<PaymentDate | null>(null);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);
  // Quick status actions (mark a task complete, an event completed) run straight
  // from the detail popup so items can be ticked off without the full editor.
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [detailActionError, setDetailActionError] = useState<string | null>(null);
  const openDetail = React.useCallback((item: CalendarDetailItem) => {
    onDetailOpen?.();
    setDetailItem(item);
    setDetailOpen(true);
    setPaymentToMarkPaid(null);
    setMarkPaidError(null);
    setDetailActionError(null);
  }, [onDetailOpen]);
  const handledDetailRequestId = React.useRef<number | null>(null);
  useEffect(() => {
    if (!detailRequest || handledDetailRequestId.current === detailRequest.id) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || handledDetailRequestId.current === detailRequest.id) return;
      handledDetailRequestId.current = detailRequest.id;
      openDetail(detailRequest.item);
    });
    return () => { cancelled = true; };
  }, [detailRequest, openDetail]);
  const closeDetail = () => {
    setDetailOpen(false);
    setPaymentToMarkPaid(null);
    onDetailClose?.();
  };

  // Marks a payment item paid: a single payment-plan installment (pays its
  // scheduled amount against that installment) or a whole invoice without a
  // payment plan (pays the full remaining balance). Both route through the same
  // payment endpoint; the installment case additionally carries installmentIndex.
  const handleMarkPaid = async (p: PaymentDate) => {
    if (!lawFirmId) return;
    const isInstallment = p.billingItemType === 'installment' && p.installmentIndex !== undefined;
    const amount = paymentDatePayableAmount(p);
    // Say so rather than leave the confirm open with nothing happening.
    if (amount <= 0) {
      setMarkPaidError('Invoice has no remaining balance');
      return;
    }
    const context: BillingContext = {
      lawFirmId,
      type: p.contextType ?? 'matter',
      entityId: (p.contextType === 'client' ? p.clientId : p.matterId) ?? '',
    };
    setMarkingPaid(true);
    setMarkPaidError(null);
    try {
      await billingService.updateInvoicePayment(context, p.invoiceId, {
        paymentAmount: amount,
        paidDate: dayjs().format('YYYY-MM-DD'),
        ...(isInstallment ? { installmentIndex: p.installmentIndex } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['billing'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setPaymentToMarkPaid(null);
      closeDetail();
    } catch (err: unknown) {
      setMarkPaidError(getErrorMessage(err, 'Failed to mark as paid'));
    } finally {
      setMarkingPaid(false);
    }
  };

  // Toggle a task between complete and open from the detail popup, so items can
  // be ticked off (or reopened) without going through the full task editor.
  const handleToggleTaskComplete = async (task: Task) => {
    setStatusUpdating(true);
    setDetailActionError(null);
    try {
      const nextStatus: TaskStatus = task.status === 'completed' ? 'open' : 'completed';
      await onTaskUpdate({ ...task, status: nextStatus });
      closeDetail();
    } catch (err) {
      setDetailActionError(getErrorMessage(err, 'Failed to update task'));
    } finally {
      setStatusUpdating(false);
    }
  };

  // Toggle a firm event between completed and upcoming from the detail popup.
  // Reuses the same update path as the edit form, carrying the event's existing
  // fields so only the status changes. External (synced) events have no editable
  // status, so the popup hides this action for them.
  const handleToggleEventComplete = async (event: Event) => {
    setStatusUpdating(true);
    setDetailActionError(null);
    try {
      const nextStatus = event.eventStatus === 'completed' ? 'upcoming' : 'completed';
      // No start, end or all-day flag: the status is all that changed, and
      // resending the cached schedule could undo a newer one on the server.
      await onEventUpdate(event, {
        title: event.title || '',
        eventType: event.eventType || 'other',
        notes: event.notes ?? null,
        location: editableLocation(event) || null,
        eventStatus: nextStatus,
      });
      closeDetail();
    } catch (err) {
      setDetailActionError(getErrorMessage(err, 'Failed to update event'));
    } finally {
      setStatusUpdating(false);
    }
  };

  // Both create forms open fresh, on the calendar's current selection (a day
  // click, an hour slot in week/day view, or a selected item's time). Closing
  // only hides a form, so a draft abandoned there must not reappear on the
  // next open, and neither may the date it had: the selection may have moved.
  // An empty selection leaves the date empty for the picker's own default.
  const openNewTask = () => create.openNew({ dueDate: initialDueDate });
  const openNewEvent = () => {
    clearEventForm();
    setNewEventDate(initialDueDate);
    setEventFormOpen(true);
  };

  // Helper functions
  const getTaskKey = (task: Task) => `${task.taskId || task.id}-${task.title}`;
  const getEventKey = (event: Event, index: number) => `${event.id}-${index}`;

  const confirmDeleteTask = async () => {
    if (!taskToDelete) return;
    setDeletingTask(taskToDelete);
    setDeleteTaskError(null);
    try {
      await onTaskDelete(taskToDelete);
      setTaskToDelete(null);
    } catch (error) {
      console.error('Failed to delete task:', error);
      setDeleteTaskError(getErrorMessage(error, 'Failed to delete task'));
    } finally {
      setDeletingTask(null);
    }
  };

  const startEditingEvent = (event: Event) => {
    const date = event.start ? (event.allDay ? dayjs(eventStartValue(event)).format('YYYY-MM-DDTHH:mm')
      : timedFormValueFor(event.start, dayjs(event.start).format('YYYY-MM-DDTHH:mm'))) : '';
    // Read in the browser's zone, like the start above.
    const endsAt = endFormValueFor({
      allDay: event.allDay === true,
      endsAt: event.end ?? null,
      endsAtLocalInput: event.end ? dayjs(event.end).format('YYYY-MM-DDTHH:mm') : null,
    });
    // A Google or Outlook event cannot be saved without an end, so one stored
    // without it opens on the end its update would give it: one day when
    // all-day, one default block after the start when timed.
    const openedEnd = endsAt || !date || event.source !== 'external'
      ? endsAt
      : (event.allDay ? date.slice(0, 10) : defaultEndFor(date));
    const allDay = event.allDay === true;
    setEditingEvent({
      event,
      opened: { date, endsAt: openedEnd, allDay },
      title: event.title || '',
      date,
      endsAt: openedEnd,
      eventType: event.eventType || 'other',
      notes: sanitizeCalendarText(event.notes),
      location: editableLocation(event),
      eventStatus: event.eventStatus || 'upcoming',
      allDay,
    });
    setEventError(null);
    setEditEventOpen(true);
  };

  // Moving a start carries its end along, so the event keeps its length.
  const changeNewEventDate = (next: string) => {
    setNewEventEndsAt(endFollowingStart(newEventDate, next, newEventEndsAt, newEventAllDay));
    setNewEventDate(next);
  };
  const changeEditingEventDate = (next: string) => {
    setEditingEvent(prev => prev
      ? { ...prev, date: next, endsAt: endFollowingStart(prev.date, next, prev.endsAt, prev.allDay) }
      : prev);
  };

  // Google and Outlook require an end, so an event of theirs saved with "no
  // end" would not lose it: the update would silently give it a 1-hour block.
  const editingEventValid = !!editingEvent && !!editingEvent.title.trim() && !!editingEvent.date && (editingEvent.event.source !== 'external' || !!editingEvent.endsAt) && endFitsStart(editingEvent.date, editingEvent.endsAt, editingEvent.allDay);

  const cancelEditingEvent = () => {
    setEditEventOpen(false);
    setEventError(null);
  };

  const getEventNavUrl = (event: Event): string | null => {
    if (!lawFirmId) return null;
    if (event.source === 'matter' && event.matterId)
      return `/lawfirm/${lawFirmId}/matters/${event.matterId}?tab=events`;
    if (event.source === 'client' && event.clientId)
      return `/lawfirm/${lawFirmId}/clients/${event.clientId}?tab=events`;
    return null;
  };

  const getPaymentNavUrl = (payment: PaymentDate): string | null => {
    if (!lawFirmId) return null;
    if (payment.contextType === 'client' && payment.clientId) {
      return `/lawfirm/${lawFirmId}/clients/${payment.clientId}/invoices/${payment.invoiceId}`;
    }
    if (payment.matterId) return `/lawfirm/${lawFirmId}/matters/${payment.matterId}/invoices/${payment.invoiceId}`;
    if (payment.clientId) return `/lawfirm/${lawFirmId}/clients/${payment.clientId}/invoices/${payment.invoiceId}`;
    return null;
  };

  const getTaskNavUrl = (task: Task): string => {
    if (!lawFirmId) return '#';
    const id = task.taskId || task.id;
    return `/lawfirm/${lawFirmId}/tasks/${id}`;
  };

  const handleEditEvent = async (confirmed = false) => {
    if (!editingEvent) return;
    if (editingEvent.event.meeting?.attendees.length && !confirmed) {
      setNotifyConfirmationOpen(true);
      return;
    }
    setEventSubmitting(true);
    setEventError(null);
    try {
      await onEventUpdate(editingEvent.event, {
        title: editingEvent.title.trim(),
        // Only the parts of the schedule the user changed.
        ...scheduleEdits(editingEvent.opened, editingEvent),
        eventType: editingEvent.eventType,
        notes: editingEvent.notes.trim() || null,
        location: editingEvent.location.trim() || null,
        eventStatus: editingEvent.eventStatus,
        confirmNotifyAttendees: confirmed,
      });
      setEditEventOpen(false);
      setNotifyConfirmationOpen(false);
    } catch (err) {
      setEventError(getErrorMessage(err, 'Failed to update event'));
    } finally {
      setEventSubmitting(false);
    }
  };

  const confirmDeleteEvent = async () => {
    if (!eventToDelete) return;
    setDeletingEventId(eventToDelete.id);
    setDeleteEventError(null);
    try {
      await onEventDelete(eventToDelete, deleteWholeSeries);
      setDeleteWholeSeries(false);
      setEventToDelete(null);
    } catch (err) {
      console.error('Failed to delete event:', err);
      setDeleteEventError(getErrorMessage(err, 'Failed to delete event'));
    } finally {
      setDeletingEventId(null);
    }
  };

  // Reset every field in the create-event form back to its default. Used by the
  // modal's "Clear all" button and after a successful create.
  const clearEventForm = () => {
    setNewEventTitle('');
    setNewEventDate('');
    setNewEventEndsAt('');
    setNewEventType('other');
    setNewEventNotes('');
    setNewEventLocation('');
    setNewEventLinkType('matter');
    setNewEventMatterId('');
    setNewEventClientId('');
    setNewEventAllDay(false);
    setEventCreateError(null);
  };

  const handleCreateEvent = async () => {
    if (!onEventCreate || !newEventTitle.trim() || !newEventDate) return;
    if (newEventLinkType === 'matter' && !newEventMatterId) return;
    if (newEventLinkType === 'client' && !newEventClientId) return;

    setEventCreateSubmitting(true);
    setEventCreateError(null);

    try {
      await onEventCreate({
        title: newEventTitle.trim(),
        date: newEventDate,
        endsAt: endsAtPayloadFor(newEventAllDay, newEventEndsAt),
        eventType: newEventType,
        notes: newEventNotes.trim() || null,
        location: newEventLocation.trim() || null,
        linkType: newEventLinkType,
        matterId: newEventLinkType === 'matter' ? newEventMatterId : undefined,
        clientId: newEventLinkType === 'client' ? newEventClientId : undefined,
        allDay: newEventAllDay,
      });

      clearEventForm();
      setEventFormOpen(false);
    } catch (error) {
      setEventCreateError(error instanceof Error ? error.message : 'Failed to create event');
    } finally {
      setEventCreateSubmitting(false);
    }
  };

  // The day the agenda lists, which a timed event that began the day before
  // labels by its end.
  const agendaDay = selectedDate ? selectedDate.format('YYYY-MM-DD') : '';
  const totalItems = selectedDayTasks.length + selectedDayEvents.length + selectedDayPaymentDates.length;
  const getDefaultDueDate = () => getDefaultDateTimeLocalValue(selectedDate?.toDate());


  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-outline bg-surface shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 id="tasks-panel-title" className="text-lg font-bold text-on-surface">
              {selectedDate ? selectedDate.format("ddd, MMM D") : "Schedule"}
            </h3>
            <p className="text-xs text-on-surface-secondary mt-0.5">
              {totalItems} item{totalItems !== 1 ? "s" : ""} scheduled
            </p>
          </div>
          {showClose && (
            <button
              className="p-1.5 rounded-lg text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              onClick={onClose}
              aria-label="Close panel"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Scrollable content below header */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar min-h-0">

      {/* Create Task / Event Actions */}
      {(canCreateTask || (onEventCreate && canCreateAnyEvent)) && (
      <div className="px-5 py-3 border-b border-outline flex gap-2">
        {canCreateTask && (
        <button
          type="button"
          onClick={openNewTask}
          className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 py-2 bg-accent-solid text-accent-foreground text-xs font-medium rounded-xl hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 shadow-sm dark:shadow-none cursor-pointer"
        >
          <Plus size={14} strokeWidth={2.2} />
          Create New Task
        </button>
        )}
        {onEventCreate && canCreateAnyEvent && (
          <button
            type="button"
            onClick={openNewEvent}
            className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 py-2 bg-accent-solid text-accent-foreground text-xs font-medium rounded-xl hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 shadow-sm dark:shadow-none cursor-pointer"
          >
            <Plus size={14} strokeWidth={2.2} />
            Create New Event
          </button>
        )}
      </div>
      )}

      {/* Create Event Modal */}
      {onEventCreate && (
        <EventFormWizard
          isOpen={eventFormOpen}
          onClose={() => setEventFormOpen(false)}
          onSubmit={handleCreateEvent}
          title="New Event"
          canContinue={!!newEventTitle.trim() && !!newEventDate && endFitsStart(newEventDate, newEventEndsAt, newEventAllDay)}
          canSubmit={!!newEventTitle.trim() && !!newEventDate && endFitsStart(newEventDate, newEventEndsAt, newEventAllDay) && (newEventLinkType === 'matter' ? !!newEventMatterId : !!newEventClientId)}
          submitting={eventCreateSubmitting}
          submitLabel="Create Event"
        >
          {(currentStep) => <>
          {currentStep === 1 && <>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-neweventtitle`}>Title *</FieldLabel>
            <TextInput
              id={`${fieldIds}-neweventtitle`}
              type="text"
              value={newEventTitle}
              onChange={(e) => setNewEventTitle(e.target.value)}
              placeholder="Event title"
              required
            />
          </div>

          <label className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5 cursor-pointer">
            <span className="text-sm font-medium text-on-surface">All day</span>
            <ToggleSwitch
              checked={newEventAllDay}
              onChange={() => {
                const next = !newEventAllDay;
                const nextDate = next ? newEventDate : timedInputFromAllDay(newEventDate);
                setNewEventAllDay(next);
                // The end keeps the day it was given, in the other shape.
                setNewEventEndsAt(endAcrossAllDayToggle(newEventEndsAt, next, nextDate));
                setNewEventDate(nextDate);
              }}
              ariaLabel="All day"
            />
          </label>

          <DateTimeRangeFields
            idPrefix={`${fieldIds}-newevent`}
            allDay={newEventAllDay}
            startLabel="Start"
            startRequired
            start={newEventDate}
            onStartChange={changeNewEventDate}
            onStartOpen={() => setNewEventDate(getDefaultDueDate())}
            end={newEventEndsAt}
            onEndChange={setNewEventEndsAt}
          />

          <div>
            <Dropdown
              portal
              label="Type"
              value={newEventType}
              onChange={setNewEventType}
              options={[...EVENT_TYPE_OPTIONS]}
            />
          </div>
          </>}

          {currentStep === 2 && <>
          {/* Link to matter or client */}
          <div>
            <FieldLabel>Link To *</FieldLabel>
            <div className="flex gap-2 mb-2">
              {canCreateMatterEvent && (
              <button
                type="button"
                onClick={() => { setNewEventLinkType('matter'); setNewEventClientId(''); }}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                  newEventLinkType === 'matter'
                    ? 'bg-accent-soft dark:bg-accent-soft border-accent-border-soft dark:border-accent-border-soft text-accent-emphasis dark:text-accent-emphasis'
                    : 'bg-surface border-outline text-on-surface-secondary hover:bg-surface-hover'
                }`}
              >
                Matter
              </button>
              )}
              {canCreateClientEvent && (
              <button
                type="button"
                onClick={() => { setNewEventLinkType('client'); setNewEventMatterId(''); }}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                  newEventLinkType === 'client'
                    ? 'bg-accent-soft dark:bg-accent-soft border-accent-border-soft dark:border-accent-border-soft text-accent-emphasis dark:text-accent-emphasis'
                    : 'bg-surface border-outline text-on-surface-secondary hover:bg-surface-hover'
                }`}
              >
                Client
              </button>
              )}
            </div>

            {newEventLinkType === 'matter' ? (
              <EntityPicker
                entity="matters"
                lawFirmId={lawFirmId ?? undefined}
                portal
                value={newEventMatterId}
                onChange={setNewEventMatterId}
                emptyOption={{ label: "Select a matter...", value: "" }}
                placeholder="Select matter"
              />
            ) : (
              <EntityPicker
                entity="clients"
                lawFirmId={lawFirmId ?? undefined}
                portal
                value={newEventClientId}
                onChange={setNewEventClientId}
                emptyOption={{ label: "Select a client...", value: "" }}
                placeholder="Select client"
              />
            )}
          </div>
          </>}

          {currentStep === 3 && <>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-neweventlocation`}>Location</FieldLabel>
            <TextInput
              id={`${fieldIds}-neweventlocation`}
              type="text"
              value={newEventLocation}
              onChange={(e) => setNewEventLocation(e.target.value)}
              placeholder="Location..."
              maxLength={500}
            />
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-neweventnotes`}>Notes</FieldLabel>
            <textarea
              id={`${fieldIds}-neweventnotes`}
              className="w-full min-h-[5.5rem] max-h-[min(70vh,28rem)] rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring resize-y overflow-x-hidden overflow-y-auto styled-scrollbar"
              rows={EVENT_NOTES_TEXTAREA_ROWS}
              value={newEventNotes}
              onChange={(e) => setNewEventNotes(e.target.value)}
              placeholder="Notes"
            />
          </div>

          <ErrorNotification error={eventCreateError} />
          </>}
          </>}
        </EventFormWizard>
      )}

      {/* Edit Event Modal */}
      {editingEvent && (
        <EventFormWizard
          isOpen={editEventOpen}
          onClose={cancelEditingEvent}
          onSubmit={() => void handleEditEvent()}
          title="Edit Event"
          canContinue={editingEventValid}
          canSubmit={editingEventValid}
          submitting={eventSubmitting}
          submitLabel="Save Changes"
          startWithAllStepsReachable
        >
          {(currentStep) => <>
          <ErrorNotification error={eventError} onClose={() => setEventError(null)} compact />

          {currentStep === 1 && <>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-editingevent`}>Title *</FieldLabel>
            <TextInput
              id={`${fieldIds}-editingevent`}
              type="text"
              value={editingEvent.title}
              onChange={(e) => setEditingEvent(prev => prev ? { ...prev, title: e.target.value } : prev)}
              placeholder="Event title"
              required
            />
          </div>

          <label className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5 cursor-pointer">
            <span className="text-sm font-medium text-on-surface">All day</span>
            <ToggleSwitch
              checked={editingEvent.allDay}
              onChange={() => setEditingEvent(prev => {
                if (!prev) return prev;
                const next = !prev.allDay;
                const date = next ? prev.date : timedInputFromAllDay(prev.date);
                // The end keeps the day it was given, in the other shape.
                return { ...prev, allDay: next, date, endsAt: endAcrossAllDayToggle(prev.endsAt, next, date) };
              })}
              ariaLabel="All day"
            />
          </label>

          <DateTimeRangeFields
            idPrefix={`${fieldIds}-editingevent`}
            allDay={editingEvent.allDay}
            startLabel="Start"
            startRequired
            start={editingEvent.date}
            onStartChange={changeEditingEventDate}
            end={editingEvent.endsAt}
            onEndChange={(v) => setEditingEvent(prev => prev ? { ...prev, endsAt: v } : prev)}
            endRequired={editingEvent.event.source === 'external'
              ? (editingEvent.allDay ? 'Google and Outlook events need an end date.' : 'Google and Outlook events need an end time.')
              : undefined}
          />

          <div>
            <Dropdown
              portal
              label="Type"
              value={editingEvent.eventType}
              onChange={(v) => setEditingEvent(prev => prev ? { ...prev, eventType: v } : prev)}
              options={[...EVENT_TYPE_OPTIONS]}
            />
          </div>
          </>}

          {currentStep === 2 && <>
          <div>
            <Dropdown
              portal
              label="Status"
              value={editingEvent.eventStatus}
              onChange={(v) => setEditingEvent(prev => prev ? { ...prev, eventStatus: v } : prev)}
              options={[...EVENT_STATUS_OPTIONS]}
            />
          </div>
          </>}

          {currentStep === 3 && <>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-location`}>{editingEvent.event.source === 'external' ? 'Location' : 'Address'}</FieldLabel>
            <TextInput
              id={`${fieldIds}-location`}
              type="text"
              value={editingEvent.location}
              onChange={(e) => setEditingEvent(prev => prev ? { ...prev, location: e.target.value } : prev)}
              placeholder={editingEvent.event.source === 'external' ? 'Location...' : 'e.g. 123 Main St, Courtroom 4B'}
              maxLength={500}
            />
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-notes`}>Notes</FieldLabel>
            <textarea
              id={`${fieldIds}-notes`}
              className="w-full min-h-[5.5rem] max-h-[min(70vh,28rem)] rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring resize-y overflow-x-hidden overflow-y-auto styled-scrollbar"
              rows={EVENT_NOTES_TEXTAREA_ROWS}
              value={editingEvent.notes}
              onChange={(e) => setEditingEvent(prev => prev ? { ...prev, notes: e.target.value } : prev)}
              placeholder="Notes"
            />
          </div>
          </>}
          </>}
        </EventFormWizard>
      )}

      {/* Item Detail Popup */}
      {detailItem && (() => {
        const navTarget =
          detailItem.kind === 'task'
            ? { url: getTaskNavUrl(detailItem.task), label: 'Open task' }
            : detailItem.kind === 'event'
              ? { url: getEventNavUrl(detailItem.event), label: 'Open event' }
              : { url: getPaymentNavUrl(detailItem.payment), label: 'View invoice' };
        const heading =
          detailItem.kind === 'task' ? 'Task details'
            : detailItem.kind === 'event' ? 'Event details'
              : 'Payment details';
        const hasNav = !!navTarget.url && navTarget.url !== '#';

        return (
          <Modal
            isOpen={detailOpen}
            onClose={closeDetail}
            title={heading}
            size="md"
            portal
            closeIcon={<X size={18} />}
            footer={
              <>
                <Button type="secondary" size="medium" onClick={closeDetail}>Close</Button>
                {detailItem.kind === 'task' && canUpdateTask && (
                  <Button
                    type={detailItem.task.status === 'completed' ? 'secondary' : 'success'}
                    size="medium"
                    loading={statusUpdating}
                    onClick={() => handleToggleTaskComplete(detailItem.task)}
                  >
                    {detailItem.task.status === 'completed' ? 'Reopen' : 'Mark complete'}
                  </Button>
                )}
                {detailItem.kind === 'event' && detailItem.event.source !== 'external' && canManageEvent(detailItem.event) && (
                  <Button
                    type={detailItem.event.eventStatus === 'completed' ? 'secondary' : 'success'}
                    size="medium"
                    loading={statusUpdating}
                    onClick={() => handleToggleEventComplete(detailItem.event)}
                  >
                    {detailItem.event.eventStatus === 'completed' ? 'Mark upcoming' : 'Mark completed'}
                  </Button>
                )}
                {detailItem.kind === 'payment' && (() => {
                  const p = detailItem.payment;
                  const canMarkPaid = paymentDatePayableAmount(p) > 0;
                  if (!canMarkPaid || !canRecordPayments) return null;
                  return (
                    <Button
                      type="success"
                      size="medium"
                      loading={markingPaid}
                      onClick={() => setPaymentToMarkPaid(p)}
                    >
                      Mark as Paid
                    </Button>
                  );
                })()}
                {hasNav && (
                  <Button
                    type="primary"
                    size="medium"
                    onClick={() => { closeDetail(); navigate(navTarget.url!); }}
                  >
                    {navTarget.label}
                  </Button>
                )}
              </>
            }
          >
            {detailActionError && (
              <ErrorNotification error={detailActionError} onClose={() => setDetailActionError(null)} />
            )}
            {detailItem.kind === 'task' && (() => {
                    const t = detailItem.task;
                    const assigneeIds = Array.isArray(t.assignedTo) ? t.assignedTo : (t.assignedTo ? [t.assignedTo] : []);
                    const assigneeNames = assigneeIds.map(id => lawFirmUsers.find(u => u.uid === id)?.name || 'Unknown').join(', ');
                    const due = t.dueDateLocalInput || t.dueDate;
                    return (
                      <>
                        <div className="flex items-start gap-2">
                          <div className={`w-2.5 h-2.5 mt-1.5 rounded-full ${getTaskColor(t).dot} shrink-0`} />
                          <h3 className="text-base font-semibold text-on-surface break-words">{t.title}</h3>
                        </div>
                        {sanitizeCalendarText(t.description) && (
                          <p className="text-sm text-on-surface-secondary whitespace-pre-wrap break-words">{sanitizeCalendarText(t.description)}</p>
                        )}
                        <DetailField label="When">{due ? (taskMinuteOfDay(t) === null ? `${dayjs(due).format('ddd, MMM D, YYYY')}${taskEndSuffix(t)} · All day` : `${dayjs(due).format('ddd, MMM D, YYYY · h:mm A')}${taskEndSuffix(t)}`) : ''}</DetailField>
                        <DetailField label="Assigned to">{assigneeNames}</DetailField>
                        <DetailField label="Matter">{t.matterId ? (t.matterName || 'Unknown') : ''}</DetailField>
                        <DetailField label="Clients">{t.clientNames?.length ? t.clientNames.join(', ') : ''}</DetailField>
                        <DetailField label="Status">
                          <TaskStatusBadge status={t.status} />
                        </DetailField>
                      </>
                    );
                  })()}

                  {detailItem.kind === 'event' && (() => {
                    const e = detailItem.event;
                    return (
                      <>
                        <div className="flex items-start gap-2">
                          <div className="w-2.5 h-2.5 mt-1.5 rounded-full bg-violet-500 shrink-0" />
                          <h3 className="text-base font-semibold text-on-surface break-words">{e.title}</h3>
                        </div>
                        <DetailField label="When">
                          {formatEventWhen(e) && (
                            <ZonedEventTime
                              when={formatEventWhen(e)}
                              zone={eventZoneSuffix({
                                start: e.start,
                                // The end only where the line above shows one.
                                end: e.startLocalDisplay && !e.endLocalDisplay ? null : e.end,
                                timeZone: e.startTimeZone,
                                allDay: e.allDay,
                              })}
                            />
                          )}
                        </DetailField>
                        {e.meeting && (
                          <>
                            <DetailField label="Organizer">{e.meeting.organizer?.displayName || e.meeting.organizer?.name || e.meeting.organizer?.email || e.meeting.organizer?.address}</DetailField>
                            <DetailField label="Visibility">{e.meeting.isPrivate ? <StatusBadge variant="neutral">Private</StatusBadge> : null}</DetailField>
                            <DetailField label="Invitation">{e.meeting.status === 'tentative' ? 'Tentative' : ''}</DetailField>
                            <DetailField label="Your response">{({ needsAction: 'Awaiting your response', notResponded: 'Awaiting your response', none: 'Awaiting your response', tentative: 'Tentative', tentativelyAccepted: 'Tentative', accepted: 'Accepted', organizer: 'Organizer', declined: 'Declined' } as Record<string, string>)[e.meeting.responseStatus || '']}</DetailField>
                            <DetailField label="Attendees">{e.meeting.attendees.map(person => `${person.displayName || person.email || ''}${person.responseStatus ? ` (${({ needsAction: 'Awaiting response', notResponded: 'Awaiting response', none: 'Awaiting response', tentative: 'Tentative', tentativelyAccepted: 'Tentative', accepted: 'Accepted', declined: 'Declined' } as Record<string, string>)[person.responseStatus] || 'Awaiting response'})` : ''}`).join(', ')}</DetailField>
                            {e.meeting.joinUrl && <DetailField label="Meeting"><LinkifiedText text={`[Join meeting](${e.meeting.joinUrl})`} /></DetailField>}
                            {e.meeting.providerUrl && <DetailField label="Calendar"><LinkifiedText text={`[Open in ${e.provider === 'outlook' ? 'Outlook' : 'Google'}](${e.meeting.providerUrl})`} /></DetailField>}
                          </>
                        )}
                        <DetailField label="Matter">{e.matterId ? (e.matterName || 'Unknown') : (e.matterName || '')}</DetailField>
                        <DetailField label="Type">{e.eventType ? (EVENT_TYPE_OPTIONS.find(o => o.value === e.eventType)?.label ?? e.eventType) : ''}</DetailField>
                        <DetailField label="Court">{e.court}</DetailField>
                        <DetailField label="Location">{e.location ? <LinkifiedText text={e.location} /> : ''}</DetailField>
                        <DetailField label="Clients">{e.clientNames?.length ? e.clientNames.join(', ') : ''}</DetailField>
                        {sanitizeCalendarText(e.notes || e.description) && (
                          <DetailField label="Notes"><span className="whitespace-pre-wrap"><LinkifiedText text={sanitizeCalendarText(e.notes || e.description)} /></span></DetailField>
                        )}
                      </>
                    );
                  })()}

                  {detailItem.kind === 'payment' && (() => {
                    const p = detailItem.payment;
                    const isReceived = p.billingItemType === 'payment_received';
                    const writeOff = p.totalWrittenOff ?? 0;
                    const remaining = p.scheduledAmount ?? paymentDateRemaining(p);
                    const isNextPayment = p.nextPaymentDate && selectedDate &&
                      dayjs(p.nextPaymentDate).format('YYYY-MM-DD') === selectedDate.format('YYYY-MM-DD');
                    const paymentLabel = isReceived
                      ? 'Payment Received'
                      : (p.billingItemType === 'installment'
                        ? 'Payment Plan Installment'
                        : (isNextPayment ? 'Next Payment' : 'Payment Due'));
                    const hasContext = p.totalAmount > 0 && (p.amountPaid > 0 || writeOff > 0);
                    return (
                      <>
                        <div className="flex items-start gap-2">
                          <div className={`w-2.5 h-2.5 mt-1.5 rounded-full bg-gradient-to-r shrink-0 ${isReceived ? 'from-emerald-400 to-emerald-600' : 'from-orange-400 to-orange-600'}`} />
                          <h3 className="text-base font-semibold text-on-surface break-words">{paymentLabel}</h3>
                        </div>
                        {markPaidError && (
                          <ErrorNotification error={markPaidError} onClose={() => setMarkPaidError(null)} />
                        )}
                        <DetailField label={isReceived ? 'Amount paid' : 'Amount due'}>
                          <div>
                            <span>${(isReceived ? (p.paidAmount ?? 0) : remaining).toLocaleString()}</span>
                            {hasContext && (
                              <p className="text-xs text-on-surface-muted font-normal mt-0.5">
                                {p.amountPaid > 0
                                  ? `$${p.amountPaid.toLocaleString()} paid of $${p.totalAmount.toLocaleString()} invoice total`
                                  : `$${p.totalAmount.toLocaleString()} invoice total`}
                                {writeOff > 0 ? ` · $${writeOff.toLocaleString()} credit` : ''}
                              </p>
                            )}
                          </div>
                        </DetailField>
                        <DetailField label="Client">{p.clientName || ''}</DetailField>
                        <DetailField label="Invoice">{p.invoiceNumber ? `#${p.invoiceNumber}` : ''}</DetailField>
                        <DetailField label="Matter">{p.matterName || ''}</DetailField>
                      </>
                    );
                  })()}
          </Modal>
        );
      })()}

      <ConfirmModal
        isOpen={notifyConfirmationOpen}
        onClose={() => setNotifyConfirmationOpen(false)}
        onConfirm={() => { void handleEditEvent(true); }}
        title="Notify meeting attendees"
        message={`${editingEvent?.event.meeting?.attendees.length || 0} ${editingEvent?.event.meeting?.attendees.length === 1 ? 'attendee' : 'attendees'} will be notified.`}
        confirmText="Save and notify"
        confirmType="primary"
        loading={eventSubmitting}
        stacked
      />
      <ConfirmModal
        isOpen={!!taskToDelete}
        onClose={() => { setTaskToDelete(null); setDeleteTaskError(null); }}
        onConfirm={confirmDeleteTask}
        title="Delete task"
        message="Are you sure you want to delete this task? This will remove it from both Paralegix and any synced calendars."
        confirmText="Delete"
        confirmType="danger"
        loading={!!deletingTask}
        extra={deleteTaskError ? <ErrorNotification error={deleteTaskError} onClose={() => setDeleteTaskError(null)} compact /> : undefined}
      />

      <ConfirmModal
        isOpen={!!eventToDelete}
        onClose={() => { setEventToDelete(null); setDeleteEventError(null); setDeleteWholeSeries(false); }}
        onConfirm={confirmDeleteEvent}
        title="Delete event"
        message="Are you sure you want to delete this event?"
        confirmText="Delete"
        confirmType="danger"
        loading={!!deletingEventId}
        extra={<>
          {eventToDelete?.source === 'matter' && eventToDelete.recurrenceGroupId && <Checkbox checked={deleteWholeSeries} onChange={setDeleteWholeSeries} label="Delete the whole series" />}
          {deleteEventError && <ErrorNotification error={deleteEventError} onClose={() => setDeleteEventError(null)} compact />}
        </>}
      />

      <ConfirmModal
        isOpen={!!paymentToMarkPaid}
        onClose={() => { setPaymentToMarkPaid(null); setMarkPaidError(null); }}
        onConfirm={() => { if (paymentToMarkPaid) void handleMarkPaid(paymentToMarkPaid); }}
        title="Mark payment as paid"
        message={paymentToMarkPaid ? (() => {
          const amt = paymentDatePayableAmount(paymentToMarkPaid);
          const inv = paymentToMarkPaid.invoiceNumber ? `invoice #${paymentToMarkPaid.invoiceNumber}` : 'this invoice';
          return `Record payment of $${amt.toLocaleString()} for ${inv}? This will record the payment with today's date.`;
        })() : ''}
        confirmText="Confirm payment"
        confirmType="success"
        loading={markingPaid}
        confirmDisabled={!paymentToMarkPaid || paymentDatePayableAmount(paymentToMarkPaid) <= 0}
        stacked
        extra={markPaidError ? <ErrorNotification error={markPaidError} onClose={() => setMarkPaidError(null)} compact /> : undefined}
      />

      {lawFirmId && (
        <CreateTaskModal
          open={create.open}
          onClose={() => create.setOpen(false)}
          lawFirmId={lawFirmId}
          users={lawFirmUsers.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
          courts={courts.map((c) => ({ id: c.id, name: c.name, abbreviation: c.abbreviation, city: c.city, address: c.address, state: c.state }))}
          courtsLoading={courtsLoading}
          createCourt={createCourt}
          updateCourtAddress={updateCourtAddress}
          canLinkCourtAddress={canManageCourts}
          create={create}
        />
      )}

      {lawFirmId && (
        <EditTaskModal
          open={edit.open}
          onClose={() => edit.setOpen(false)}
          lawFirmId={lawFirmId}
          users={lawFirmUsers.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
          courts={courts.map((c) => ({ id: c.id, name: c.name, abbreviation: c.abbreviation, city: c.city, address: c.address, state: c.state }))}
          courtsLoading={courtsLoading}
          createCourt={createCourt}
          updateCourtAddress={updateCourtAddress}
          canLinkCourtAddress={canManageCourts}
          edit={edit}
        />
      )}

      {/* Tasks / Events / Payments List */}
      <div>
        <div className="p-4 space-y-2">
          {totalItems === 0 ? (
            <div className="text-center py-10">
              <div className="w-12 h-12 mx-auto mb-3 bg-surface-alt rounded-full flex items-center justify-center border border-outline-subtle">
                <svg className="w-6 h-6 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-on-surface mb-1">No items scheduled</p>
              {canCreateTask && <p className="text-xs text-on-surface-muted">Create a task to get started</p>}
            </div>
          ) : (
            <>
              {/* Day agenda: tasks and events interleaved chronologically, with
                  all-day items pinned to the top via a negative flex order. */}
              {(selectedDayTasks.length > 0 || selectedDayEvents.length > 0) && (
                <div className="flex flex-col gap-1.5">
                    {selectedDayTasks.map((task) => {
                      const isDeleting = deletingTask === (task.taskId || task.id);
                      const itemKey = `task-${task.taskId || task.id}`;
                      const isSelected = isHighlighted(itemKey);

                      return (
                        <div
                          key={getTaskKey(task)}
                          ref={itemKey === scrollKey ? selectedItemRef : undefined}
                          role="button"
                          tabIndex={0}
                          style={{ order: taskMinuteOfDay(task) ?? -1 }}
                          className={`bg-surface-alt rounded-xl p-3 flex flex-col gap-0.5 transition-shadow duration-150 cursor-pointer ${isSelected ? 'border-2 border-accent-control-ring ring-1 ring-focus-ring shadow-md' : 'border-2 border-outline-subtle hover:border-outline'}`}
                          onClick={() => openDetail({ kind: 'task', task })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openDetail({ kind: 'task', task });
                            }
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2 mb-1">
                                <div className={`w-2 h-2 mt-1 rounded-full ${getTaskColor(task).dot} shrink-0`} />
                                <h4 className="text-sm font-medium text-on-surface break-words min-w-0">{task.title}</h4>
                              </div>
                            </div>

                            {(canUpdateTask || canDeleteTask) && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              {canUpdateTask && (
                              <Tooltip title="Edit task" enterDelay={300}>
                              <button aria-label="Edit task"
                                type="button"
                                onClick={(e) => { e.stopPropagation(); edit.openWith(task); }}
                                className="p-1.5 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              </Tooltip>
                              )}
                              {canDeleteTask && (
                              <Tooltip title="Delete task" enterDelay={300}>
                              <span>
                              <button aria-label="Delete task"
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setDeleteTaskError(null); setTaskToDelete(task.taskId || task.id); }}
                                disabled={isDeleting}
                                className="p-1.5 text-on-surface-muted hover:text-red-500 hover:bg-surface-hover rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
                              >
                                {isDeleting ? (
                                  <Spinner size={14} className="text-red-600" />
                                ) : (
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                )}
                              </button>
                              </span>
                              </Tooltip>
                              )}
                            </div>
                            )}
                          </div>
                          <div
                            className={SIDE_PANEL_VIEW_BODY_CLASS}
                          >
                            {sanitizeCalendarText(task.description) && (
                              <p className="text-xs text-on-surface-secondary whitespace-pre-wrap break-words mb-2 pl-4">{sanitizeCalendarText(task.description)}</p>
                            )}
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-on-surface-muted pl-4">
                              {(task.dueDateLocalInput || task.dueDate) && (
                                <span className="flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  {taskMinuteOfDay(task) === null ? `All day${taskEndSuffix(task)}` : `${dayjs(task.dueDateLocalInput || task.dueDate).format('h:mm A')}${taskEndSuffix(task)}`}
                                </span>
                              )}
                              {(Array.isArray(task.assignedTo) ? task.assignedTo : (task.assignedTo ? [task.assignedTo] : [])).length > 0 && (
                                <span className="flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                  </svg>
                                  {(Array.isArray(task.assignedTo) ? task.assignedTo : [task.assignedTo]).map(id => lawFirmUsers.find(u => u.uid === id)?.name || 'Unknown').join(', ')}
                                </span>
                              )}
                              {task.matterId && (
                                <span className="flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                  </svg>
                                  {task.matterName || 'Unknown'}
                                </span>
                              )}
                              {task.clientNames?.length ? (
                                <Tooltip title={task.clientNames.join(', ')} enterDelay={300}>
                                  <span className="flex items-center gap-1">
                                    <UserIcon size={11} />
                                    {task.clientNames.join(', ')}
                                  </span>
                                </Tooltip>
                              ) : null}
                              <TaskStatusBadge status={task.status} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {selectedDayEvents.map((event, idx) => {
                      const isDeleting = deletingEventId === event.id;
                      const itemKey = `event-${event.id}`;
                      const isSelected = isHighlighted(itemKey);
                      return (
                        <div
                          key={getEventKey(event, idx)}
                          ref={itemKey === scrollKey ? selectedItemRef : undefined}
                          role="button"
                          tabIndex={0}
                          style={{ order: eventMinuteOfDay(event, agendaDay) ?? -1 }}
                          className={`bg-surface-alt rounded-xl p-3 flex flex-col gap-0.5 transition-shadow duration-150 cursor-pointer ${isSelected ? 'border-2 border-violet-500 ring-1 ring-violet-500/40 shadow-md' : 'border-2 border-outline-subtle hover:border-outline'}`}
                          onClick={() => openDetail({ kind: 'event', event })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openDetail({ kind: 'event', event });
                            }
                          }}
                        >
                          <>
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start gap-2 mb-1">
                                    <div className="w-2 h-2 mt-1 rounded-full bg-violet-500 shrink-0" />
                                    <h4 className="text-sm font-medium text-on-surface break-words min-w-0">{event.title}</h4>
                                  </div>
                                </div>
                                {canManageEvent(event) && (
                                <div className="flex items-center gap-0.5 shrink-0">
                                  <Tooltip title="Edit event" enterDelay={300}>
                                  <button aria-label="Edit event"
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); startEditingEvent(event); }}
                                    className="p-1.5 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                                  >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                  </button>
                                  </Tooltip>
                                  <Tooltip title="Delete event" enterDelay={300}>
                                  <span>
                                  <button aria-label="Delete event"
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setDeleteEventError(null); setEventToDelete(event); }}
                                    disabled={isDeleting}
                                    className="p-1.5 text-on-surface-muted hover:text-red-500 hover:bg-surface-hover rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
                                  >
                                    {isDeleting ? (
                                      <Spinner size={14} className="text-red-500" />
                                    ) : (
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    )}
                                  </button>
                                  </span>
                                  </Tooltip>
                                </div>
                                )}
                              </div>
                              <div
                                className={SIDE_PANEL_VIEW_BODY_CLASS}
                              >
                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-on-surface-muted pl-4">
                                  {event.start && (
                                    <span className="flex items-center gap-1">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                      {eventTimeLabel(event, agendaDay, true)}
                                    </span>
                                  )}
                                  {event.location && (
                                    <span className="flex items-center gap-1 min-w-0 max-w-full break-words">
                                      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                      {event.location}
                                    </span>
                                  )}
                                  {event.clientNames?.length ? (
                                    <Tooltip title={event.clientNames.join(', ')} enterDelay={300}>
                                      <span className="flex items-center gap-1">
                                        <UserIcon size={11} />
                                        {event.clientNames.join(', ')}
                                      </span>
                                    </Tooltip>
                                  ) : null}
                                  {event.eventType && (
                                    <StatusBadge variant={matterEventTypeMeta(event.eventType).variant}>
                                      {matterEventTypeMeta(event.eventType).label}
                                    </StatusBadge>
                                  )}
                                </div>
                                {sanitizeCalendarText(event.notes) && (
                                  <p className="mt-2 pl-4 text-[11px] text-on-surface-muted italic whitespace-pre-wrap break-words">{sanitizeCalendarText(event.notes)}</p>
                                )}
                              </div>
                            </>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Payment Due Dates */}
              {selectedDayPaymentDates.length > 0 && (
                <div>
                  <SectionLabel as="h4" gap="2" className="mt-3 px-1">
                    Payments ({selectedDayPaymentDates.length})
                  </SectionLabel>
                  <div className="space-y-1.5">
                    {selectedDayPaymentDates.map((payment) => {
                      const itemKey = `payment-${payment.id}`;
                      const isSelected = isHighlighted(itemKey);
                      const isReceived = payment.billingItemType === "payment_received";
                      const remaining = payment.scheduledAmount ?? paymentDateRemaining(payment);
                      const amount = isReceived ? (payment.paidAmount ?? 0) : remaining;
                      const isNextPayment = payment.nextPaymentDate && selectedDate &&
                        dayjs(payment.nextPaymentDate).format("YYYY-MM-DD") === selectedDate.format("YYYY-MM-DD");
                      const paymentLabel = isReceived
                        ? "Payment Received"
                        : (payment.billingItemType === "installment"
                          ? "Payment Plan Installment"
                          : (isNextPayment ? "Next Payment" : "Payment Due"));
                      const accent = isReceived
                        ? "bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/10 dark:border-emerald-400/15 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/20"
                        : "bg-orange-500/10 dark:bg-orange-500/15 border-orange-500/10 dark:border-orange-400/15 hover:bg-orange-500/15 dark:hover:bg-orange-500/20";
                      const dot = isReceived ? "from-emerald-400 to-emerald-600" : "from-orange-400 to-orange-600";
                      const badge = isReceived
                        ? "bg-emerald-500/20 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300"
                        : "bg-orange-500/20 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300";
                      // Highlight outline matches the payment type so a selected received
                      // (green) card stays visually distinct from a selected due (orange) one.
                      // An offset ring sits in a gap of the panel background so it reads
                      // clearly against the card's own green/orange tinted fill.
                      const selectedRing = isReceived
                        ? "border-2 border-emerald-400 ring-2 ring-emerald-400 ring-offset-2 ring-offset-surface shadow-lg"
                        : "border-2 border-orange-400 ring-2 ring-orange-400 ring-offset-2 ring-offset-surface shadow-lg";

                      const entityName = payment.matterName || payment.clientName || 'Invoice';
                      const writeOff = payment.totalWrittenOff ?? 0;
                      const trueRemaining = paymentDateRemaining(payment);

                      return (
                        <div
                          key={`payment-${payment.id}`}
                          ref={itemKey === scrollKey ? selectedItemRef : undefined}
                          role="button"
                          tabIndex={0}
                          aria-label={`${paymentLabel}: ${entityName}, $${amount.toLocaleString()}`}
                          className={`rounded-xl p-3 flex flex-col gap-0.5 transition-all duration-150 cursor-pointer ${isSelected ? selectedRing : 'border-2'} ${accent}`}
                          onClick={() => openDetail({ kind: 'payment', payment })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openDetail({ kind: 'payment', payment });
                            }
                          }}
                        >
                          <div className="flex items-center gap-2 mb-0">
                            <div className={`w-2 h-2 rounded-full bg-gradient-to-r shrink-0 ${dot}`} />
                            <h4 className="text-sm font-medium text-on-surface truncate">
                              {paymentLabel}
                            </h4>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ml-auto shrink-0 ${badge}`}>
                              {isReceived ? "+" : ""}${amount.toLocaleString()}
                            </span>
                          </div>

                          <div
                            className={SIDE_PANEL_VIEW_BODY_CLASS}
                          >
                            {payment.clientName && (
                              <p className="text-xs text-on-surface pl-4 mb-1 font-medium whitespace-pre-wrap break-words">{payment.clientName}</p>
                            )}

                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-on-surface-muted pl-4">
                              {payment.invoiceNumber && (
                                <span className="flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  #{payment.invoiceNumber}
                                </span>
                              )}
                              {payment.matterName && (
                                <span className="flex items-center gap-1 min-w-0 break-words">
                                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                  </svg>
                                  {payment.matterName}
                                </span>
                              )}
                              {(payment.amountPaid > 0 || writeOff > 0) && trueRemaining > 0 && (
                                <span className="flex items-center gap-1 text-on-surface-muted">
                                  ${trueRemaining.toLocaleString()} remaining
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      </div>{/* end scrollable content */}
    </div>
  );
};

export default CalendarSidePanel;
