import { FULL_INPUT_CLS } from "./inputClasses";

interface TextareaProps extends Omit<React.ComponentPropsWithRef<"textarea">, "className"> {
  /** Extra classes, appended. `resize-none` is the common one. */
  className?: string;
}

/**
 * The multi-line counterpart to `TextInput`, sharing its control metrics.
 *
 * Same class string as the single-line input by design: a textarea sitting under
 * a text field in the same form has to match its border, radius and padding, and
 * the two drifted apart once already when each was spelled out per call site.
 * Set the height with `rows`, as the native element does.
 */
export default function Textarea({ className = "", ...rest }: TextareaProps) {
  return <textarea {...rest} className={className ? `${FULL_INPUT_CLS} ${className}` : FULL_INPUT_CLS} />;
}
