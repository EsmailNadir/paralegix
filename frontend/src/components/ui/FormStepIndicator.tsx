type Step = {
  label: string;
};

export default function FormStepIndicator({
  steps,
  currentStep,
  maxStepReached,
  onStepClick,
  disabled = false,
}: {
  steps: Step[];
  currentStep: number;
  maxStepReached?: number;
  onStepClick?: (step: number) => void;
  /** Holds the completed steps shut, as while the wizard's save is in flight. */
  disabled?: boolean;
}) {
  return (
    <nav aria-label="Form progress" className="border-b border-outline bg-surface px-6 py-4 shrink-0">
      <ol className="mx-auto flex w-full max-w-lg items-center">
        {steps.map((step, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStep;
          // A step already reached (in either direction) is clickable; only
          // steps ahead of the furthest one visited stay locked.
          const isComplete = stepNumber !== currentStep && stepNumber <= (maxStepReached ?? currentStep);

          return (
            <li key={step.label} className={`flex min-w-0 items-center ${index < steps.length - 1 ? "flex-1" : ""}`}>
              {isComplete && onStepClick ? (
                <button
                  type="button"
                  onClick={() => onStepClick(stepNumber)}
                  disabled={disabled}
                  aria-label={`${step.label}, step ${stepNumber} of ${steps.length}, completed`}
                  className="flex min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-sm text-sm font-medium text-on-surface-secondary transition-colors hover:text-accent-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:hover:text-accent-emphasis disabled:cursor-not-allowed disabled:hover:text-on-surface-secondary"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-control-ring bg-transparent text-xs font-semibold text-accent-emphasis dark:text-accent-emphasis">
                    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path d="m5 10 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="hidden truncate sm:inline">{step.label}</span>
                </button>
              ) : (
                <div
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${step.label}, step ${stepNumber} of ${steps.length}${isComplete ? ", completed" : isActive ? ", current" : ""}`}
                  className={`flex min-w-0 shrink-0 items-center gap-2 text-sm font-medium ${
                    isActive
                      ? "text-accent-emphasis"
                      : isComplete
                        ? "text-on-surface-secondary"
                        : "text-on-surface-muted"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                      isActive
                        ? "border-accent-control-ring bg-accent-solid text-accent-foreground shadow-sm dark:border-accent-control-ring dark:bg-accent-solid"
                        : isComplete
                          ? "border-accent-control-ring bg-transparent text-accent-emphasis dark:text-accent-emphasis"
                          : "border-outline bg-surface text-on-surface-muted"
                    }`}
                  >
                    {isComplete ? (
                      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                        <path d="m5 10 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      stepNumber
                    )}
                  </span>
                  <span className="hidden truncate sm:inline">{step.label}</span>
                </div>
              )}
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px min-w-4 flex-1 ${isComplete ? "bg-accent-indicator" : "bg-outline"}`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
