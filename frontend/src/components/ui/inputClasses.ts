/**
 * Class strings for hand-rolled form controls, so a plain `<input>` matches the
 * `Dropdown` / `EntityPicker` triggers it sits next to.
 *
 * Height is deliberately left to the padding rather than a fixed `h-*`: the
 * trigger button in `Dropdown` is `px-3 py-2 text-sm`, so any input that wants
 * to line up with one in a filter row has to resolve to the same box. A fixed
 * height (`h-11`) makes the input visibly taller than the dropdowns beside it.
 *
 * Width is not included - call sites set their own (`w-full`, `w-[200px]`, …).
 */
export const INPUT_CLS =
  "rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/** Full-width form input using the same control metrics as INPUT_CLS. */
export const FULL_INPUT_CLS = `w-full ${INPUT_CLS}`;

/** Label above a control, matching the one `Dropdown` renders from its `label` prop. */
export const FIELD_LABEL_CLS = "text-sm font-medium text-on-surface";

/** Block label with the standard one-step gap beneath it. */
export const FIELD_LABEL_BLOCK_CLS = `mb-1 block ${FIELD_LABEL_CLS}`;

/**
 * Column wrapper for a label + control pair. `gap-1` matches the `mb-1` the
 * `Dropdown` label uses, so labels and controls in the same row stay on one
 * baseline.
 */
export const FIELD_CLS = "flex flex-col gap-1";
