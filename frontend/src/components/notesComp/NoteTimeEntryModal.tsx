"use client";

import { TimeDateField, TimeDurationField, timeEntryDuration } from "@/components/billingComp/TimeEntryCore";

import { useId, useState } from "react";
import dayjs from "dayjs";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

import Checkbox from "@/components/ui/Checkbox";
import ErrorNotification from "@/components/ErrorNotification";

import { INPUT_CLS, FIELD_LABEL_CLS } from "@/components/ui/inputClasses";
import { hoursToHm } from "@/lib/utils/format";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { NoteTimeEntry } from "@/types/note";

export interface NoteTimeEntryFormValue {
  timeSpent: number;
  timeEntryDate: string;
  activityName?: string;
  activityDescription?: string;
  isBillable?: boolean;
}

interface NoteTimeEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (value: NoteTimeEntryFormValue) => Promise<void>;
  submitting?: boolean;
  /**
   * The entry being edited, or null for a new one. The caller is responsible
   * for never opening this in edit mode against an entry whose `editable` is
   * false: once time is on an invoice it is not this modal's job to explain
   * why the edit is refused.
   */
  entry?: NoteTimeEntry | null;
  /** Prefills for a brand-new entry: the note's subject and content. */
  defaultActivityName?: string;
  defaultDescription?: string;
  defaultDate?: string;
}

/**
 * Add or edit a single time entry on a note.
 *
 * One modal serves both flows so they cannot drift: same rounding behavior,
 * same date validation, same billable default, same description fallback as
 * the backend applies when the fields are left blank.
 */
export default function NoteTimeEntryModal({
  isOpen,
  onClose,
  onSubmit,
  submitting = false,
  entry = null,
  defaultActivityName,
  defaultDescription,
  defaultDate,
}: NoteTimeEntryModalProps) {
  const fieldIds = useId();
  const isEdit = !!entry;
  const initialHm = hoursToHm(entry?.hours);

  const [hours, setHours] = useState(isEdit ? (initialHm.h > 0 ? String(initialHm.h) : "") : "1");
  const [minutes, setMinutes] = useState(isEdit ? (initialHm.m > 0 ? String(initialHm.m) : "") : "");
  const [date, setDate] = useState(entry?.entryDate || defaultDate || dayjs().format("YYYY-MM-DD"));
  const [activityName, setActivityName] = useState(entry?.name || defaultActivityName || "");
  const [description, setDescription] = useState(entry?.description || defaultDescription || "");
  const [isBillable, setIsBillable] = useState(entry?.billable !== false);
  const [error, setError] = useState<string | null>(null);

  // One instance serves every note, so the form starts over each time it opens:
  // from the entry being edited, or from the defaults of the note it was opened
  // on. Keying this on the entry id alone left every "Add time" (id null)
  // showing the previous note's activity, description and duration.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen && !wasOpen) {
    setWasOpen(true);
    const hm = hoursToHm(entry?.hours);
    setHours(entry ? (hm.h > 0 ? String(hm.h) : "") : "1");
    setMinutes(entry ? (hm.m > 0 ? String(hm.m) : "") : "");
    setDate(entry?.entryDate || defaultDate || dayjs().format("YYYY-MM-DD"));
    setActivityName(entry?.name || defaultActivityName || "");
    setDescription(entry?.description || defaultDescription || "");
    setIsBillable(entry?.billable !== false);
    setError(null);
  } else if (!isOpen && wasOpen) {
    setWasOpen(false);
  }

  // A close mid-save would hide a failure the dialog is about to report.
  const handleClose = () => {
    if (!submitting) onClose();
  };

  const { total: timeSpent, valid: canSubmit } = timeEntryDuration(hours, minutes, 24);

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(timeSpent <= 0 ? "Please enter a time greater than zero" : "Time spent cannot exceed 24 hours for a single entry");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        timeSpent,
        timeEntryDate: date,
        activityName: activityName || undefined,
        activityDescription: description || undefined,
        isBillable,
      });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save time entry"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      dismissible={!submitting}
      title={isEdit ? "Edit Time Entry" : "Add Time Entry"}
      lockScroll
      footer={
        <>
          <Button type="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting} disabled={!canSubmit}>
            {isEdit ? "Save Changes" : "Add Time"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      <TimeDurationField label={<label className={`block mb-1 ${FIELD_LABEL_CLS}`}>Time <span aria-hidden="true">*</span></label>}
        hours={hours} minutes={minutes} onHoursChange={setHours} onMinutesChange={setMinutes} />
      <TimeDateField label={<label id={`${fieldIds}-date-label`} className={`block mb-1 ${FIELD_LABEL_CLS}`}>Date <span aria-hidden="true">*</span></label>}
        ariaLabelledBy={`${fieldIds}-date-label`} value={date} onChange={setDate} className="w-full" />

      <div>
        <label htmlFor={`${fieldIds}-activityname`} className={`block mb-1 ${FIELD_LABEL_CLS}`}>Activity</label>
        <input
          id={`${fieldIds}-activityname`}
          type="text"
          value={activityName}
          onChange={(e) => setActivityName(e.target.value)}
          placeholder="e.g., Phone Call, Document Review, Research"
          className={`w-full ${INPUT_CLS}`}
        />
      </div>

      <div>
        <label htmlFor={`${fieldIds}-description`} className={`block mb-1 ${FIELD_LABEL_CLS}`}>Description</label>
        <textarea
          id={`${fieldIds}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What work was done..."
          rows={3}
          className={`w-full resize-none ${INPUT_CLS}`}
        />
      </div>

      <Checkbox
        checked={isBillable}
        onChange={setIsBillable}
        label="Billable to client"
        description="Include this time in client invoices"
      />
    </Modal>
  );
}
