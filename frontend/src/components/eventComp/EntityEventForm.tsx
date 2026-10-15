"use client";

import ClientEventDescriptionField from "./ClientEventDescriptionField";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { getDefaultDateTimeLocalValue } from "@/lib/utils/dateUtils";
import type { MatterEventStatus, MatterEventType } from "@/types/matterEvent";
import type { Contact } from "@/types";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { useMatterById } from "@/hooks/matterHooks/useMatters";
import { usePermissions } from "@/contexts/PermissionsContext";
import ContactFormModal from "@/components/contactsComp/ContactFormModal";
import FilePickerModal, { type SelectedFile } from "@/components/matterComp/FilePickerModal";
import ErrorNotification from "@/components/ErrorNotification";
import Checkbox from "@/components/ui/Checkbox";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import FieldLabel from "@/components/ui/FieldLabel";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import EventFormWizard from "@/components/eventComp/EventFormWizard";
import EventAssigneePicker from "@/components/eventComp/EventAssigneePicker";
import EventLinkedFiles from "@/components/eventComp/EventLinkedFiles";
import DateTimeRangeFields from "@/components/eventComp/DateTimeRangeFields";
import { endAcrossAllDayToggle, endFitsStart, endFollowingStart } from "@/components/calendarComp/calendarTiming";

const INPUT_CLASS = FULL_INPUT_CLS;

/** The form fields every parent's event form carries, as `resetFields` takes them. */
export interface EventFormFieldValues {
  type: MatterEventType;
  title: string;
  date: string;
  /**
   * Optional. A timed end is a wall clock like `date`; an all-day end is the
   * last day the event covers, which `endsAtPayloadFor` turns into the
   * exclusive day the API stores.
   */
  endsAt: string;
  notes: string;
  locationName: string;
  location: string;
  status: MatterEventStatus;
  allDay: boolean;
  assignedTo: string[];
  assignedToName: string[];
  /**
   * Attendees who are not firm members: opposing counsel, a court reporter, an
   * expert. Directory contacts, so they are picked by id.
   */
  contactIds: string[];
  linkedFiles: SelectedFile[];
  clientVisible: boolean;
  clientDescription?: string;
}

/**
 * State for the fields `EntityEventForm` renders, plus the submit and error
 * state around them. The parent's form owns the hook so its own submit and
 * reset logic can read and write the same values.
 */
export function useEventFormFields() {
  const [type, setType] = useState<MatterEventType>("court_date");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [notes, setNotes] = useState("");
  const [locationName, setLocationName] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<MatterEventStatus>("upcoming");
  const [allDay, setAllDay] = useState(false);
  const [assignedTo, setAssignedTo] = useState<string[]>([]);
  const [assignedToName, setAssignedToName] = useState<string[]>([]);
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [linkedFiles, setLinkedFiles] = useState<SelectedFile[]>([]);
  const [clientVisible, setClientVisible] = useState(false);
  const [clientDescription, setClientDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Loads every field at once and clears the error, as a form does when it opens. */
  const resetFields = useCallback((values: EventFormFieldValues) => {
    setType(values.type);
    setTitle(values.title);
    setDate(values.date);
    setEndsAt(values.endsAt);
    setNotes(values.notes);
    setLocationName(values.locationName);
    setLocation(values.location);
    setStatus(values.status);
    setAllDay(values.allDay);
    setAssignedTo(values.assignedTo);
    setAssignedToName(values.assignedToName);
    setContactIds(values.contactIds);
    setLinkedFiles(values.linkedFiles);
    setClientVisible(values.clientVisible);
    setClientDescription(values.clientDescription || "");
    setError(null);
  }, []);

  return {
    type, setType,
    title, setTitle,
    date, setDate,
    endsAt, setEndsAt,
    notes, setNotes,
    locationName, setLocationName,
    location, setLocation,
    status, setStatus,
    allDay, setAllDay,
    assignedTo, setAssignedTo,
    assignedToName, setAssignedToName,
    contactIds, setContactIds,
    linkedFiles, setLinkedFiles,
    clientVisible, setClientVisible,
    clientDescription, setClientDescription,
    submitting, setSubmitting,
    error, setError,
    resetFields,
  };
}

export type EventFormFields = ReturnType<typeof useEventFormFields>;

interface EntityEventFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: () => void;
  lawFirmId: string;
  /** The parent form's `useId()`, so the parent's own fields share its id prefix. */
  fieldIds: string;
  fields: EventFormFields;
  /** Whether the record on screen is an edit, held through the exit animation. */
  isEditing: boolean;
  /** The id of the event being edited, if any, straight from the parent's prop. */
  editingId: string | undefined;
  /** Dialog title when adding ("Add Matter Event"). */
  addTitle: string;
  /**
   * The matter the event is linked to, if any. Scopes the file picker to that
   * matter's files (undefined browses everything) and the assignee roster to
   * that matter's members.
   */
  filePickerMatterId: string | undefined;
  /** Step 1: the event type control, first on the step. */
  typeField: ReactNode;
  /** Step 1: anything between the date and the status control. */
  afterDateFields?: ReactNode;
  /** Step 1: the status control, last on the step. */
  statusField: ReactNode;
  /** Step 2: anything before the location name. */
  beforeLocationFields?: ReactNode;
  /** Step 3: anything after the client-portal visibility toggle. */
  afterVisibilityFields?: ReactNode;
  /** The parent's own dialogs, rendered between the file picker and the contact form. */
  dialogs?: ReactNode;
}

/**
 * The three-step event form every parent shares: title, notes and date on step
 * one, place and people on step two, files and client visibility on step three.
 * Each parent supplies the controls that are genuinely its own through the slots.
 */
export default function EntityEventForm({
  open,
  onClose,
  onSubmit,
  lawFirmId,
  fieldIds,
  fields,
  isEditing,
  editingId,
  addTitle,
  filePickerMatterId,
  typeField,
  afterDateFields,
  statusField,
  beforeLocationFields,
  afterVisibilityFields,
  dialogs,
}: EntityEventFormProps) {
  const {
    title, setTitle,
    date, setDate,
    endsAt, setEndsAt,
    notes, setNotes,
    locationName, setLocationName,
    location, setLocation,
    allDay, setAllDay,
    assignedTo, setAssignedTo,
    assignedToName, setAssignedToName,
    contactIds, setContactIds,
    linkedFiles, setLinkedFiles,
    clientVisible, setClientVisible,
    clientDescription, setClientDescription,
    submitting,
    error, setError,
  } = fields;
  const { hasPermission } = usePermissions();
  const canCreateContact = hasPermission("contacts.manage");
  const [contactCreateOpen, setContactCreateOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  // The assignee picker's roster loads when the modal first opens; the modal
  // stays mounted while closed. The cache key is shared, so reopening is instant.
  const { users: firmUsers } = useLawFirmUsers(lawFirmId, open);
  // A matter event's assignees must be members of its matter: the backend
  // rejects anyone else (they would get reminder emails carrying the matter's
  // details). So with a matter linked, the roster is that matter's members, and
  // until they load it offers no one rather than the whole firm.
  const { matter: linkedMatter } = useMatterById(lawFirmId, open ? filePickerMatterId : undefined);
  const users = useMemo(() => {
    if (!filePickerMatterId) return firmUsers;
    const memberIds = new Set([
      ...(linkedMatter?.members ?? []).map((member) => member.userId),
      ...(linkedMatter?.memberUserIds ?? []),
    ]);
    if (memberIds.size === 0) return [];
    return firmUsers.filter((user: any) => memberIds.has(user.id || user.uid));
  }, [filePickerMatterId, firmUsers, linkedMatter]);

  // A contact created from the attendees picker is added to the selection the
  // same way an existing one would be, whether it's a brand-new record or the
  // duplicate-check surfaced an existing match instead.
  // Moving the start carries the end along, so the event keeps its length the
  // way it does in Google and Outlook.
  const changeDate = (next: string) => {
    setEndsAt(endFollowingStart(date, next, endsAt, allDay));
    setDate(next);
  };
  const endFits = endFitsStart(date, endsAt, allDay);

  const handleContactCreated = (contact: Contact) => {
    setContactIds((prev) => (prev.includes(contact.id) ? prev : [...prev, contact.id]));
    setContactCreateOpen(false);
  };

  return (
    <>
    <EventFormWizard
      isOpen={open}
      onClose={onClose}
      onSubmit={onSubmit}
      title={isEditing ? "Edit Event" : addTitle}
      canContinue={!!title.trim() && !!date && endFits}
      canSubmit={!!title.trim() && !!date && endFits}
      submitting={submitting}
      submitLabel={isEditing ? "Save Changes" : "Add Event"}
      startWithAllStepsReachable={isEditing}
    >
      {(currentStep) => <>
        <ErrorNotification error={error} onClose={() => setError(null)} />

        {currentStep === 1 && <>
            {typeField}

            <div>
              <FieldLabel htmlFor={`${fieldIds}-title`}>Title *</FieldLabel>
              <input
                id={`${fieldIds}-title`}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Motion to Dismiss Hearing"
                className={INPUT_CLASS}
                maxLength={300}
              />
            </div>

            <div>
              <FieldLabel htmlFor={`${fieldIds}-notes`}>Notes</FieldLabel>
              <textarea
                id={`${fieldIds}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Additional details..."
                rows={3}
                className={INPUT_CLASS}
                maxLength={2000}
              />
            </div>

            <label className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5 cursor-pointer">
              <span className="text-sm font-medium text-on-surface">All day</span>
              <ToggleSwitch
                checked={allDay}
                onChange={() => {
                  const next = !allDay;
                  const nextDate = !next && date.endsWith("T00:00") ? `${date.slice(0, 10)}T12:00` : date;
                  setAllDay(next);
                  // The end keeps the day it was given, in the other shape.
                  setEndsAt(endAcrossAllDayToggle(endsAt, next, nextDate));
                  if (nextDate !== date) setDate(nextDate);
                }}
                ariaLabel="All day"
              />
            </label>
            <DateTimeRangeFields
              idPrefix={fieldIds}
              allDay={allDay}
              startLabel="Start"
              startRequired
              start={date}
              onStartChange={changeDate}
              onStartOpen={() => setDate(getDefaultDateTimeLocalValue())}
              end={endsAt}
              onEndChange={setEndsAt}
            />

            {afterDateFields}

            {statusField}
        </>}

        {currentStep === 2 && <>
            {beforeLocationFields}

            <div>
              <FieldLabel htmlFor={`${fieldIds}-locationname`}>Location Name</FieldLabel>
              <input
                id={`${fieldIds}-locationname`}
                type="text"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder="e.g. Superior Court of California"
                className={INPUT_CLASS}
                maxLength={300}
              />
            </div>

            <div>
              <FieldLabel htmlFor={`${fieldIds}-location`}>Address</FieldLabel>
              <input
                id={`${fieldIds}-location`}
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. 123 Main St, Courtroom 4B"
                className={INPUT_CLASS}
                maxLength={500}
              />
            </div>

            <EventAssigneePicker
              // Remounting clears the search box, which the form reset used to do.
              key={`${open}-${editingId ?? "new"}`}
              users={users}
              assignedTo={assignedTo}
              assignedToName={assignedToName}
              onChange={(ids, names) => {
                setAssignedTo(ids);
                setAssignedToName(names);
              }}
            />

            <div>
              <EntityMultiPicker
                entity="contacts"
                lawFirmId={lawFirmId}
                selectedIds={contactIds}
                onChange={setContactIds}
                label="Other Attendees"
                placeholder="Opposing counsel, experts, court reporters…"
                max={50}
                onCreateNew={canCreateContact ? () => setContactCreateOpen(true) : undefined}
                createNewLabel="Create a new contact"
              />
            </div>
        </>}

        {currentStep === 3 && <>
            <EventLinkedFiles
              files={linkedFiles}
              onChange={setLinkedFiles}
              onBrowse={() => setFilePickerOpen(true)}
            />

            <div>
              <Checkbox
                checked={clientVisible}
                onChange={setClientVisible}
                label="Visible to client portal"
              />
              <p className="mt-1 text-xs text-on-surface-muted">When enabled, this event appears in the client portal.</p>
            </div>

            {clientVisible && <ClientEventDescriptionField id={`${fieldIds}-client-description`} value={clientDescription} onChange={setClientDescription} />}

            {afterVisibilityFields}
        </>}
      </>}
    </EventFormWizard>

      <FilePickerModal
        open={filePickerOpen}
        onClose={() => setFilePickerOpen(false)}
        onSelect={(selected) => {
          const existing = new Set(linkedFiles.map((f) => f.fileId));
          const newFiles = selected.filter((f) => !existing.has(f.fileId));
          setLinkedFiles([...linkedFiles, ...newFiles]);
        }}
        lawFirmId={lawFirmId}
        matterId={filePickerMatterId}
        alreadyLinked={linkedFiles.map((f) => f.fileId)}
      />

      {dialogs}

      <ContactFormModal
        open={contactCreateOpen}
        onClose={() => setContactCreateOpen(false)}
        onSaved={handleContactCreated}
        onUseExisting={handleContactCreated}
        lawFirmId={lawFirmId}
        matterContext
      />
    </>
  );
}
