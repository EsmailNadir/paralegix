import { FULL_INPUT_CLS } from "./inputClasses";

/**
 * Every native `<input>` prop passes through, `ref` included: React 19 hands a
 * function component its ref as an ordinary prop, so spreading `rest` onto the
 * element is enough and no `forwardRef` wrapper is needed.
 */
interface TextInputProps extends Omit<React.ComponentPropsWithRef<"input">, "className"> {
  /** Extra classes, appended after the shared control metrics. */
  className?: string;
}

/**
 * The full-width text input used in forms and filter rows.
 *
 * It renders `FULL_INPUT_CLS`, the same thirteen classes 63 call sites used to
 * spell out inline. Height comes from the padding rather than a fixed `h-*` so
 * the box resolves to the same metrics as the `Dropdown` and `EntityPicker`
 * triggers it sits beside; a fixed height makes the input visibly taller than the
 * dropdowns in the same row.
 *
 * Two other input spellings survive in the codebase on purpose. `trustComp/` uses
 * a `rounded-lg` variant consistently across its own forms, and the two
 * generate-invoice pages use one without a placeholder colour. Both render
 * differently from this, so switching them here would be a visual change rather
 * than a refactor. They are listed in the class-migration gate as deliberate
 * exclusions.
 */
export default function TextInput({ className = "", ...rest }: TextInputProps) {
  return <input {...rest} className={className ? `${FULL_INPUT_CLS} ${className}` : FULL_INPUT_CLS} />;
}
