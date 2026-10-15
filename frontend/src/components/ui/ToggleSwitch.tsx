"use client";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible label; omit when a visible `<label>`/text already names the switch. */
  ariaLabel?: string;
}

// The app's standard on/off switch: a pill that slides an accent knob. Use this
// for every boolean settings toggle instead of re-inlining the markup.
export default function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
        checked ? "bg-accent-solid" : "bg-surface-alt border border-outline"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-accent-foreground shadow transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
