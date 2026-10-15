import TaskFormBody, { TASK_FORM_STEPS, type TaskFieldState } from "./taskForm/TaskFormBody";
import { useEffect, useId, useMemo, useState } from "react";

import Modal from "@/components/ui/Modal";
import type { Task } from "@/types";
import { taskStatusMeta } from "@/constants/statusMeta";
import ErrorNotification from "@/components/ErrorNotification";
import { getDefaultDateTimeLocalValue } from "@/lib/utils/dateUtils";
import { deriveDueDateInput } from "@/hooks/taskHooks/useTaskForm";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import type { CourtUpsertData, CreateCourtResponse } from "@/services/courts.service";

import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";
import FormStepIndicator from "@/components/ui/FormStepIndicator";

import StepModalFooter from "@/components/ui/StepModalFooter";

import { endFitsStart, endFollowingStart } from "@/components/calendarComp/calendarTiming";

type SimpleUser = { id: string; name?: string | null; email?: string | null };
type SimpleCourt = { id: string; name: string; abbreviation?: string | null; city?: string | null; address?: string | null; state?: string | null };



type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  users: SimpleUser[];
  courts?: SimpleCourt[];
  /** The court list is still loading, so the field can say so. */
  courtsLoading?: boolean;
  createCourt?: (data: CourtUpsertData & { name: string }) => Promise<CreateCourtResponse>;
  /** Saves a manually typed location back onto the selected court's address. */
  updateCourtAddress?: (courtId: string, address: string) => Promise<unknown>;
  /** Whether the current user may save a location back onto a court's address. */
  canLinkCourtAddress?: boolean;
  edit: TaskFieldState & {
    task?: Task | null;
    submitting?: boolean;
    save: (setError: (e: string | null) => void) => void;
  };
};

export default function EditTaskModal({
  open,
  onClose,
  lawFirmId,
  users,
  courts = [],
  courtsLoading = false,
  createCourt,
  updateCourtAddress,
  canLinkCourtAddress = false,
  edit,
}: Props) {
  const fieldIds = useId();
  const [error, setLocalError] = useState<string | null>(null);
  useResetAfterClose(open, () => setLocalError(null));
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(TASK_FORM_STEPS.length);
  const { duplicate: duplicateTask } = useDuplicateNameCheck("tasks", lawFirmId, edit.title, {
    enabled: open,
    excludeId: edit.task?.taskId || edit.task?.id,
    matterId: edit.matterId || null,
  });

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- returns the wizard to the first step each time the modal opens
      setCurrentStep(1);
      // Editing an already-complete task: every step already has valid data, so all are reachable immediately.
      setMaxStepReached(TASK_FORM_STEPS.length);
    }
  }, [open]);

  // Pre-fills the datetime-local input: the live form value wins once the form
  // has one (an empty string is a date the user cleared, not an untouched
  // field), otherwise fall back to deriving one from the task
  // (the same helper `useTaskForm.taskToFormState` uses, so a task loaded any
  // other way than through this modal's own `edit.dueDate` still gets the
  // correct local day - `deriveDueDateInput` reads `dueDate` with UTC getters
  // because the backend anchors a day-only due date at UTC noon specifically
  // so that reading is safe from any viewer's zone; local getters here would
  // reintroduce the classic one-day-off bug for a viewer behind UTC).
  const computedEditDue = useMemo(() => {
    if (edit.dueDate != null) return edit.dueDate;
    return deriveDueDateInput(edit.task);
  }, [edit.dueDate, edit.task]);

  // The task row already carries its matter's name, so the summary panel does
  // not depend on a loaded matter list.
  const matterName = edit.task?.matterId ? (edit.task.matterName || "(Unknown)") : "No matter";

  const toggleAssignee = (userId: string) => {
    if (edit.assignedTo.includes(userId)) {
      edit.setAssignedTo(edit.assignedTo.filter((id) => id !== userId));
    } else {
      edit.setAssignedTo([...edit.assignedTo, userId]);
    }
  };

  // Moving the due date carries the end along; clearing it clears the end,
  // which needs a start to come after.
  const changeDueDate = (next: string) => {
    edit.setEndsAt(next ? endFollowingStart(computedEditDue, next, edit.endsAt, edit.allDay) : "");
    edit.setDueDate(next);
  };
  const endFits = endFitsStart(computedEditDue, edit.endsAt, edit.allDay);

  const handleDueDateFocus = () => {
    if (!computedEditDue) {
      edit.setDueDate(getDefaultDateTimeLocalValue());
    }
  };

  const continueToNextStep = () => {
    if (currentStep === 1 && !edit.title.trim()) {
      setLocalError("Title is required.");
      return;
    }

    setLocalError(null);
    setCurrentStep((step) => {
      const next = Math.min(step + 1, TASK_FORM_STEPS.length);
      setMaxStepReached((max) => Math.max(max, next));
      return next;
    });
  };

  const handleStepClick = (targetStep: number) => {
    if (currentStep === 1 && targetStep !== 1 && !edit.title.trim()) {
      setLocalError("Title is required.");
      return;
    }
    setLocalError(null);
    setCurrentStep(targetStep);
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!edit.submitting}
      title="Edit Task"
      size="xl"
      height="steps"
      footerAlign="between"
      showClose={false}
      bodyClassName={null}
      footer={
        // The banner sits directly above the buttons, as in the create wizard,
        // so a failed save is read where the user just clicked.
        <div className="w-full">
          <ErrorNotification
            error={error}
            onClose={() => setLocalError(null)}
            compact
            className="mb-3"
          />
          <div className="flex items-center justify-between gap-2">
            <StepModalFooter
              currentStep={currentStep}
              stepCount={TASK_FORM_STEPS.length}
              onCancel={onClose}
              onBack={() => setCurrentStep((step) => step - 1)}
              onContinue={continueToNextStep}
              continueDisabled={currentStep === 1 && (!edit.title.trim() || !endFits)}
              busy={edit.submitting}
              submit={{
                onClick: () => edit.save(setLocalError),
                loading: edit.submitting,
                disabled: edit.submitting || !edit.title.trim() || !endFits,
                label: edit.submitting ? "Saving..." : "Save Changes",
              }}
            />
          </div>
        </div>
      }
    >
      <FormStepIndicator
        steps={TASK_FORM_STEPS}
        currentStep={currentStep}
        maxStepReached={maxStepReached}
        onStepClick={handleStepClick}
        disabled={edit.submitting}
      />

      <TaskFormBody state={edit} dueDate={computedEditDue}
        handleMatterChange={(v) => { edit.setMatterId(v); if (v) edit.setClientIds([]); }}
        showSourceNote={edit.task?.source === "recurrence"} excludeTaskId={edit.task?.taskId || edit.task?.id} currentStep={currentStep} fieldIds={fieldIds} duplicateTask={duplicateTask}
        lawFirmId={lawFirmId} changeDueDate={changeDueDate} handleDueDateFocus={handleDueDateFocus}
        toggleAssignee={toggleAssignee} users={users} courts={courts} courtsLoading={courtsLoading}
        createCourt={createCourt} canLinkCourtAddress={canLinkCourtAddress} updateCourtAddress={updateCourtAddress}
        summary={<>
{/* Current Task Info */}
            <div className="p-4 bg-surface-alt rounded-lg border border-outline">
              <h3 className="text-sm font-medium text-on-surface mb-2">Current Task Information</h3>
              <div className="space-y-1 text-sm text-on-surface-secondary">
                <div>
                  <strong>Matter:</strong> {matterName}
                </div>
                <div>
                  <strong>Current Due Date:</strong> {edit.task?.dueDateLocalDisplay || "No due date set"}
                </div>
                <div>
                  <strong>Status:</strong>{" "}
                  {taskStatusMeta(edit.task?.status).label}
                </div>
              </div>
            </div>
        </>} />
    </Modal>
  );
}
