"use client";

import type { ReactNode } from "react";
import Button from "./Button";

/**
 * The footer of a stepped modal: Cancel or Back on the left, Continue or the
 * submit on the right.
 *
 * `FormStepIndicator` was already shared by the five wizards (create and edit
 * for a matter and a task, plus the event form). The footer was not, so the
 * same four buttons and the same two conditions were written five times.
 *
 * Pass it to `Modal` as `footer` with `footerAlign="between"`, which is what
 * spreads the two sides. The modal's own footer row is `flex items-center`, so
 * the wrappers here only group the buttons; they add no spacing of their own.
 */
export default function StepModalFooter({
  currentStep,
  stepCount,
  onCancel,
  onBack,
  onContinue,
  continueDisabled,
  busy = false,
  submit,
}: {
  currentStep: number;
  /** How many steps the wizard has. The last one shows the submit. */
  stepCount: number;
  onCancel: () => void;
  onBack: () => void;
  onContinue: () => void;
  /** Whether the current step has enough filled in to move on. */
  continueDisabled?: boolean;
  /**
   * The wizard's save is in flight. Holds Cancel and Back shut so the user
   * cannot abandon or navigate away from a save that is still running; pass the
   * same flag to `FormStepIndicator` as `disabled`.
   */
  busy?: boolean;
  submit: {
    onClick: () => void;
    loading?: boolean;
    disabled?: boolean;
    /** "Create", "Saving...", whatever this wizard calls finishing. */
    label: ReactNode;
  };
}) {
  return (
    <>
      <div>
        {currentStep === 1 ? (
          <Button type="secondary" className="min-w-[88px]" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : (
          <Button type="secondary" className="min-w-[88px]" onClick={onBack} disabled={busy}>
            Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {currentStep < stepCount ? (
          <Button type="primary" onClick={onContinue} disabled={continueDisabled}>
            Continue
          </Button>
        ) : (
          <Button
            type="primary"
            onClick={submit.onClick}
            loading={submit.loading}
            disabled={submit.disabled}
          >
            {submit.label}
          </Button>
        )}
      </div>
    </>
  );
}
