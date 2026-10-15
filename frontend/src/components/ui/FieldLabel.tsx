import { FIELD_LABEL_BLOCK_CLS } from "./inputClasses";

export type FieldLabelSize = "sm" | "xs";
export type FieldLabelTone = "default" | "secondary";
export type FieldLabelGap = "1" | "1.5";

/**
 * Every native `<label>` attribute passes through. The sites this replaced were
 * plain `<label>` elements, so several already carried `id` (an aria-labelledby
 * target) or `onClick`; a narrower prop list would have forced those to stay
 * hand-written. `className` is re-declared because it is appended to the computed
 * classes rather than replacing them.
 */
interface FieldLabelProps extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, 'className'> {
  /** The control this labels. Same value as the control's `id`. */
  htmlFor?: string;
  /** `sm` for a form field, `xs` for a filter row or a dense sub-form. */
  size?: FieldLabelSize;
  /** `secondary` for a label inside an already-labelled group, where full contrast would compete. */
  tone?: FieldLabelTone;
  /** Gap beneath the label. `1.5` only where the control below it has no top padding of its own. */
  gap?: FieldLabelGap;
  /** Extra classes, appended. Reach for a prop first; this is for genuine one-offs. */
  className?: string;
  children: React.ReactNode;
}

/**
 * The text label sitting above a form control.
 *
 * The four size/tone/gap combinations below are not new: they are the four that
 * already existed across 313 hand-written `<label className="...">` sites, which
 * is why they are props rather than a single fixed string. Two of those sites'
 * spellings wrote the same four classes in a different order (`block text-sm
 * font-medium text-on-surface mb-1` against `mb-1 block text-sm ...`), which is
 * the drift a shared component removes: the rendered result was always identical,
 * but each new spelling gave the next author another thing to copy.
 *
 * `Dropdown` renders its own label from a `label` prop using the same metrics, so
 * a `FieldLabel` above an `<input>` and a `Dropdown` label beside it sit on one
 * baseline. Do not add a size here without adding it there too.
 */
export default function FieldLabel({
  htmlFor,
  size = "sm",
  tone = "default",
  gap = "1",
  className = "",
  children,
  ...rest
}: FieldLabelProps) {
  return (
    <label {...rest} htmlFor={htmlFor} className={fieldLabelClass({ size, tone, gap, className })}>
      {children}
    </label>
  );
}

/**
 * The class string `FieldLabel` renders, exposed for the handful of call sites
 * that need the label element itself (a `<legend>`, a label wrapping its own
 * control). Prefer the component.
 */
export function fieldLabelClass({
  size = "sm",
  tone = "default",
  gap = "1",
  className = "",
}: {
  size?: FieldLabelSize;
  tone?: FieldLabelTone;
  gap?: FieldLabelGap;
  className?: string;
} = {}): string {
  // Spelled out rather than assembled from fragments: Tailwind v4 scans source
  // text for class names, so `text-${size}` would never reach the stylesheet.
  const base =
    size === "sm"
      ? tone === "default"
        ? "block text-sm font-medium text-on-surface"
        : "block text-sm font-medium text-on-surface-secondary"
      : tone === "default"
        ? "block text-xs font-medium text-on-surface"
        : "block text-xs font-medium text-on-surface-secondary";

  const margin = gap === "1.5" ? "mb-1.5" : "mb-1";
  return className ? `${margin} ${base} ${className}` : `${margin} ${base}`;
}

/**
 * `FIELD_LABEL_BLOCK_CLS` and the default `fieldLabelClass()` must stay the same
 * string; the constant predates this component and is still imported directly by
 * call sites that build their own label markup.
 */
export const FIELD_LABEL_DEFAULT_CLS = FIELD_LABEL_BLOCK_CLS;
