import TaskFormBody, { TASK_FORM_STEPS, type TaskFieldState } from "./taskForm/TaskFormBody";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import Modal from "@/components/ui/Modal";
import { useDuplicateNameCheck, useEntityByIds, type LookupItem } from "@/hooks/useEntityLookup";

import ErrorNotification from "@/components/ErrorNotification";
import { getDefaultDateTimeLocalValue } from "@/lib/utils/dateUtils";
import type { CourtUpsertData, CreateCourtResponse } from "@/services/courts.service";

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
  /**
   * Restricts the matter picker to this client's matters. Set when the modal is
   * opened from a single client's page, where offering every firm matter would
   * invite filing the task against an unrelated client's matter.
   */
  clientId?: string;
  create: TaskFieldState & {
    submitting?: boolean;
    submit: (setError: (e: string | null) => void) => void;
  };
};

export default function CreateTaskModal({
  open,
  onClose,
  lawFirmId,
  users,
  courts = [],
  courtsLoading = false,
  createCourt,
  updateCourtAddress,
  canLinkCourtAddress = false,
  clientId,
  create,
}: Props) {
  const fieldIds = useId();
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [error, setLocalError] = useState<string | null>(null);
  const syncedMatterIdRef = useRef<string | null>(null);
  const { setMatterId, setClientIds, setCourtId } = create;
  const { duplicate: duplicateTask } = useDuplicateNameCheck("tasks", lawFirmId, create.title, {
    enabled: open,
    matterId: create.matterId || null,
  });

  const toggleAssignee = (userId: string) => {
    if (create.assignedTo.includes(userId)) {
      create.setAssignedTo(create.assignedTo.filter((id) => id !== userId));
    } else {
      create.setAssignedTo([...create.assignedTo, userId]);
    }
  };

  // The matter behind the current selection. The picker resolves the same
  // lookup query internally, so this shares its cache entry rather than adding
  // a request, and it also covers a matterId set before the modal opened (the
  // "add task" button on a matter's Tasks tab), which never goes through the
  // picker's onChange.
  const selectedMatterIds = useMemo(
    () => (create.matterId ? [create.matterId] : []),
    [create.matterId]
  );
  const { items: resolvedMatters } = useEntityByIds("matters", lawFirmId, selectedMatterIds);
  const selectedMatter = resolvedMatters[0] ?? null;

  // A task inherits the court of its matter: prefer the matter's linked court
  // id, else match its court name against the firm's courts.
  const syncCourtForMatter = useCallback((matter: LookupItem | null) => {
    if (!matter) {
      setCourtId("");
      return;
    }

    const linkedCourtId = matter.courtId?.trim();
    if (linkedCourtId) {
      setCourtId(linkedCourtId);
      return;
    }

    const linkedCourtName = matter.courtName?.trim().toLowerCase();
    if (!linkedCourtName) {
      setCourtId("");
      return;
    }

    const matchedCourt = courts.find((court) => court.name.trim().toLowerCase() === linkedCourtName);
    setCourtId(matchedCourt?.id || "");
  }, [courts, setCourtId]);

  const handleMatterChange = (matterId: string) => {
    // Mark the id as already handled so the sync effect below leaves the court
    // that onSelectItem is about to set alone.
    syncedMatterIdRef.current = matterId;
    setMatterId(matterId);
    if (matterId) setClientIds([]);
  };

  // Moving the due date carries the end along; clearing it clears the end,
  // which needs a start to come after.
  const changeDueDate = (next: string) => {
    create.setEndsAt(next ? endFollowingStart(create.dueDate || "", next, create.endsAt, create.allDay) : "");
    create.setDueDate(next);
  };
  const endFits = endFitsStart(create.dueDate || "", create.endsAt, create.allDay);

  const handleDueDateFocus = () => {
    if (!create.dueDate) {
      create.setDueDate(getDefaultDateTimeLocalValue());
    }
  };

  // Opened from a single client's page, the task belongs to that client. With a
  // matter chosen the task carries the matter's clients instead, so the link is
  // only added while there is no matter. The picked clients are read through a
  // ref so removing the chip in the picker is not undone by this effect.
  const clientIdsRef = useRef(create.clientIds);
  clientIdsRef.current = create.clientIds;
  useEffect(() => {
    if (!open || !clientId || create.matterId) return;
    const current = clientIdsRef.current;
    if (current.includes(clientId)) return;
    setClientIds([...current, clientId]);
  }, [open, clientId, create.matterId, setClientIds]);

  useEffect(() => {
    if (!open) {
      syncedMatterIdRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the staged form UI when the modal closes
      setCurrentStep(1);
      setMaxStepReached(1);
      setLocalError(null);
      return;
    }

    if (syncedMatterIdRef.current === create.matterId) return;
    // Wait for the lookup before syncing an id set outside this modal; acting on
    // an unresolved matter would clear a court the matter actually has. The
    // courts load when the modal opens, so wait for them too: a matter linked
    // to its court only by name can only be matched once the list is in.
    if (create.matterId && !selectedMatter) return;
    if (create.matterId && courtsLoading) return;

    syncedMatterIdRef.current = create.matterId;
    syncCourtForMatter(selectedMatter);
  }, [open, create.matterId, selectedMatter, syncCourtForMatter, courtsLoading]);

  const continueToNextStep = () => {
    if (currentStep === 1 && !create.title.trim()) {
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

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!create.submitting}
      title="Create a New Task"
      size="xl"
      height="steps"
      footerAlign="between"
      showClose={false}
      bodyClassName={null}
      footer={
        // The banner sits directly above the buttons, so a failed save is read
        // where the user just clicked and not scrolled out of view in the body.
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
              continueDisabled={currentStep === 1 && (!create.title.trim() || !endFits)}
              busy={create.submitting}
              submit={{
                onClick: () => create.submit(setLocalError),
                loading: create.submitting,
                disabled: create.submitting || !create.title.trim() || !endFits,
                label: create.submitting ? "Creating..." : "Create",
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
        onStepClick={setCurrentStep}
        disabled={create.submitting}
      />

      <TaskFormBody state={create} dueDate={create.dueDate || ""} clientId={clientId}
        handleMatterChange={handleMatterChange} onMatterSelected={syncCourtForMatter} currentStep={currentStep} fieldIds={fieldIds} duplicateTask={duplicateTask}
        lawFirmId={lawFirmId} changeDueDate={changeDueDate} handleDueDateFocus={handleDueDateFocus}
        toggleAssignee={toggleAssignee} users={users} courts={courts} courtsLoading={courtsLoading}
        createCourt={createCourt} canLinkCourtAddress={canLinkCourtAddress} updateCourtAddress={updateCourtAddress} />
    </Modal>
  );
}
