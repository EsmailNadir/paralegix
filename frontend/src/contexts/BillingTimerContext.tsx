"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import useTimer, { type TimerStartParams } from "@/hooks/billingHooks/useTimer";
import { useLawFirmUsers } from "@/hooks/useUsers";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import TimeEntryModal from "@/components/billingComp/TimeEntryModal";
import type { TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import TimerWidget from "@/components/billingComp/TimerWidget";
import { useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";

type BillingTimerContextValue = {
  isActive: boolean;
  isRunning: boolean;
  matterId?: string | null;
  clientId?: string | null;
  targetLabel: string;
  formattedTime: string;
  description: string;
  openTargetPicker: () => void;
  startTimer: (params: TimerStartParams) => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  stopTimer: () => void;
  discardTimer: () => void;
  updateTimerDescription: (desc: string) => void;
  setFloatingSuppressed: (suppressed: boolean) => void;
};

const BillingTimerContext = createContext<BillingTimerContextValue>({
  isActive: false,
  isRunning: false,
  matterId: null,
  clientId: null,
  targetLabel: "",
  formattedTime: "00:00:00",
  description: "",
  openTargetPicker: () => {},
  startTimer: () => {},
  pauseTimer: () => {},
  resumeTimer: () => {},
  stopTimer: () => {},
  discardTimer: () => {},
  updateTimerDescription: () => {},
  setFloatingSuppressed: () => {},
});

export function BillingTimerProvider({
  lawFirmId,
  children,
}: {
  lawFirmId: string;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const timer = useTimer(lawFirmId);
  const [timerPickerOpen, setTimerPickerOpen] = useState(false);
  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [prefill, setPrefill] = useState<TimerPrefill | null>(null);
  const closeTimeEntryModal = useCallback(() => {
    setAddTimeEntryOpen(false);
    setPrefill(null);
  }, []);
  // Closes the modal, then opens the composer when the save chose "bill now".
  const billNowRedirect = useBillNowRedirect(lawFirmId, closeTimeEntryModal);
  const [floatingSuppressed, setFloatingSuppressed] = useState(false);
  const [timerTargetType, setTimerTargetType] = useState<"matter" | "client">("matter");
  // The picker holds its own selection so the timer only starts when the user
  // presses Start Timer; picking a matter or client is not itself the commit.
  const [timerTargetId, setTimerTargetId] = useState("");
  const [timerTargetLabel, setTimerTargetLabel] = useState("");
  const [timerPickerError, setTimerPickerError] = useState<string | null>(null);

  useResetAfterClose(timerPickerOpen, () => {
    setTimerTargetType("matter");
    setTimerTargetId("");
    setTimerTargetLabel("");
    setTimerPickerError(null);
  });

  // This provider is mounted on every law-firm route, so anything it fetches at
  // mount is fetched on every page. Matters and clients come from the server
  // typeahead inside the pickers, and these two bounded catalogs are held back
  // until the save modal that consumes them is actually open.
  const { users } = useLawFirmUsers(lawFirmId, addTimeEntryOpen);
  const { chargeCodes } = useChargeCodes(lawFirmId, true, addTimeEntryOpen);

  const handleStop = useCallback(() => {
    const result = timer.stop();
    setPrefill({
      hours: result.hours,
      matterId: result.matterId,
      clientId: result.clientId,
      name: result.name,
      description: result.description,
      chargeCodeId: result.chargeCodeId,
      sourceTaskId: result.sourceTaskId,
      sourceTaskTitle: result.sourceTaskTitle,
      sourceEventId: result.sourceEventId,
      sourceEventTitle: result.sourceEventTitle,
      sourceMatterId: result.sourceMatterId,
      sourceClientIds: result.sourceClientIds,
    });
    setAddTimeEntryOpen(true);
  }, [timer]);

  /**
   * Start a timer, first banking whatever is already on the clock.
   *
   * There is only one timer slot, so starting a second one used to overwrite the
   * first and throw away its elapsed time with no warning. Now the running timer is
   * stopped and handed to the save modal exactly as if the user had pressed stop,
   * so switching tasks never loses recorded work. Time too short to round to a
   * hundredth of an hour is dropped silently rather than prompting for a save.
   */
  const startTimer = useCallback(
    (params: TimerStartParams) => {
      if (timer.isActive) {
        const running = timer.stop();
        if (running.hours > 0) {
          setPrefill({
            hours: running.hours,
            matterId: running.matterId,
            clientId: running.clientId,
            name: running.name,
            description: running.description,
            chargeCodeId: running.chargeCodeId,
            sourceTaskId: running.sourceTaskId,
            sourceTaskTitle: running.sourceTaskTitle,
            sourceEventId: running.sourceEventId,
            sourceEventTitle: running.sourceEventTitle,
            sourceMatterId: running.sourceMatterId,
            sourceClientIds: running.sourceClientIds,
          });
          setAddTimeEntryOpen(true);
        }
      }
      timer.start(params);
    },
    [timer],
  );

  const handleStartFromPicker = useCallback(() => {
    if (!timerTargetId) {
      setTimerPickerError(timerTargetType === "matter" ? "Select a matter." : "Select a client.");
      return;
    }
    startTimer(
      timerTargetType === "matter"
        ? { matterId: timerTargetId, targetLabel: timerTargetLabel }
        : { clientId: timerTargetId, targetLabel: timerTargetLabel },
    );
    setTimerPickerOpen(false);
  }, [startTimer, timerTargetId, timerTargetLabel, timerTargetType]);

  const contextValue = useMemo<BillingTimerContextValue>(
    () => ({
      isActive: timer.isActive,
      isRunning: timer.isRunning,
      matterId: timer.matterId,
      clientId: timer.clientId,
      targetLabel: timer.targetLabel,
      formattedTime: timer.formattedTime,
      description: timer.description,
      openTargetPicker: () => setTimerPickerOpen(true),
      startTimer,
      pauseTimer: timer.pause,
      resumeTimer: timer.resume,
      stopTimer: handleStop,
      discardTimer: timer.discard,
      updateTimerDescription: timer.updateDescription,
      setFloatingSuppressed,
    }),
    [handleStop, startTimer, timer],
  );

  return (
    <BillingTimerContext value={contextValue}>
      {children}

      <Modal
        isOpen={timerPickerOpen}
        onClose={() => setTimerPickerOpen(false)}
        title="Start Timer"
        size="md"
        footer={
          <>
            <Button type="secondary" onClick={() => setTimerPickerOpen(false)}>Cancel</Button>
            <Button type="primary" onClick={handleStartFromPicker} disabled={!timerTargetId}>Start Timer</Button>
          </>
        }
      >
        <ErrorNotification error={timerPickerError} onClose={() => setTimerPickerError(null)} compact />
        <p className="text-sm text-on-surface-secondary">Select a matter or client to start timing:</p>
        <div className="grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] gap-3">
          <Dropdown
            label="Time For"
            value={timerTargetType}
            onChange={(value) => {
              setTimerTargetType(value as "matter" | "client");
              setTimerTargetId("");
              setTimerTargetLabel("");
            }}
            options={[
              { label: "Matter", value: "matter" },
              { label: "Client", value: "client" },
            ]}
            portal
          />
          <EntityPicker
            key={timerTargetType}
            entity={timerTargetType === "matter" ? "matters" : "clients"}
            lawFirmId={lawFirmId}
            label={timerTargetType === "matter" ? "Matter" : "Client"}
            value={timerTargetId}
            onChange={setTimerTargetId}
            onSelectItem={(item) => {
              setTimerTargetLabel(item?.label ?? "");
              if (item) setTimerPickerError(null);
            }}
            placeholder={timerTargetType === "matter" ? "Search matters..." : "Search clients..."}
            portal
          />
        </div>
      </Modal>

      <TimeEntryModal
        open={addTimeEntryOpen}
        onClose={() => {
          setAddTimeEntryOpen(false);
          setPrefill(null);
        }}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        defaultUserId={user?.uid}
        prefill={prefill}
        onSuccess={(result) => {
          void queryClient.invalidateQueries({ queryKey: ["billing"] });
          billNowRedirect(result);
        }}
      />

      <TimerWidget
        isActive={timer.isActive && !floatingSuppressed}
        isRunning={timer.isRunning}
        targetLabel={timer.targetLabel}
        formattedTime={timer.formattedTime}
        description={timer.description}
        onPause={timer.pause}
        onResume={timer.resume}
        onStop={handleStop}
        onDiscard={timer.discard}
        onUpdateDescription={timer.updateDescription}
      />
    </BillingTimerContext>
  );
}

export function useBillingTimer() {
  return useContext(BillingTimerContext);
}
