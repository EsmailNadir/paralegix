"use client";

import { useEffect, useState, type ReactNode } from "react";
import Modal from "@/components/ui/Modal";
import FormStepIndicator from "@/components/ui/FormStepIndicator";
import StepModalFooter from "@/components/ui/StepModalFooter";

const EVENT_STEPS = [
  { label: "Event Details" },
  { label: "People & Matter" },
  { label: "Location & Options" },
];

interface EventFormWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: () => void;
  title: string;
  canContinue: boolean;
  canSubmit: boolean;
  submitting?: boolean;
  submitLabel?: string;
  /** Existing events have every field populated, so all stages are immediately revisitable. */
  startWithAllStepsReachable?: boolean;
  children: (step: number) => ReactNode;
}

/**
 * Shared staged dialog chrome for every event editor. Parent surfaces supply
 * their own fields and persistence, while this keeps their navigation and
 * footer behaviour identical to the matter and task creation flows.
 */
export default function EventFormWizard({
  isOpen,
  onClose,
  onSubmit,
  title,
  canContinue,
  canSubmit,
  submitting = false,
  submitLabel = "Add Event",
  startWithAllStepsReachable = false,
  children,
}: EventFormWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(() => startWithAllStepsReachable ? EVENT_STEPS.length : 1);

  useEffect(() => {
    // The wizard stays mounted while its modal animates out. Resetting on both
    // edges makes its next opening reflect whether it is creating or editing.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- modal open/close establishes the staged-form baseline
    setCurrentStep(1);
    setMaxStepReached(startWithAllStepsReachable ? EVENT_STEPS.length : 1);
  }, [isOpen, startWithAllStepsReachable]);

  const continueToNextStep = () => {
    if (currentStep === 1 && !canContinue) return;
    setCurrentStep((step) => {
      const next = Math.min(step + 1, EVENT_STEPS.length);
      setMaxStepReached((max) => Math.max(max, next));
      return next;
    });
  };

  const handleStepClick = (targetStep: number) => {
    if (currentStep === 1 && targetStep !== 1 && !canContinue) return;
    setCurrentStep(targetStep);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dismissible={!submitting}
      title={title}
      size="xl"
      height="steps"
      footerAlign="between"
      showClose={false}
      bodyClassName={null}
      footer={
        <StepModalFooter
          currentStep={currentStep}
          stepCount={EVENT_STEPS.length}
          onCancel={onClose}
          onBack={() => setCurrentStep((step) => step - 1)}
          onContinue={continueToNextStep}
          continueDisabled={currentStep === 1 && !canContinue}
          busy={submitting}
          submit={{
            onClick: onSubmit,
            loading: submitting,
            disabled: submitting || !canSubmit,
            label: submitLabel,
          }}
        />
      }
    >
      <FormStepIndicator
        steps={EVENT_STEPS}
        currentStep={currentStep}
        maxStepReached={maxStepReached}
        onStepClick={handleStepClick}
        disabled={submitting}
      />
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar px-6 py-5">
        {children(currentStep)}
      </div>
    </Modal>
  );
}
