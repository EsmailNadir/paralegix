/**
 * Column widths for the invoice line item tables, declared once for the read
 * view and the editor alike.
 *
 * These tables used the browser's default `table-layout: auto`, which sizes a
 * column by what is in it. An amount that gained a digit ($945.00 becoming
 * $8,055.00) widened its own column, and the width came out of the only column
 * that could give any up: the description. The text then rewrapped onto another
 * line and the row grew taller, on a line nobody had edited. Editing an
 * unrelated row's hours did the same thing.
 *
 * `table-fixed` takes the widths from these `col` elements and ignores the
 * content, so a line keeps its shape whatever it is worth. The description
 * column is deliberately the one with NO width: under fixed layout the unsized
 * column absorbs whatever the sized ones leave, so widening the window feeds the
 * prose rather than padding the figures.
 *
 * The money column is the same width in every table here, so the figures line up
 * down the panel across Time Entries, Flat Fees and Expenses.
 */

/** Which of the two renderings of a line table the widths are for. */
export type LineTableMode = "read" | "edit";

/** Which set of columns a table carries. */
export type LineTableColumns = "timeEntry" | "amount";

/**
 * Wide enough for $999,999.99 at `text-sm` with the 40px of cell padding, which
 * covers any line a firm bills. It is NOT sized for MAX_MONEY_AMOUNT
 * ($1,000,000,000.00): reserving 180px for a figure nobody enters would cost the
 * description that width on every invoice in the app.
 */
const AMOUNT_COL = "w-36";
const AMOUNT_PX = 144;

/** Holds "$450.00" as text and the bare "450" as an input, so one width serves both. */
const RATE_COL = "w-32";
const RATE_PX = 128;

/** "2h 42m" as text. */
const HOURS_READ_COL = "w-28";
const HOURS_READ_PX = 112;

/**
 * HoursMinutesInput splits its width between two groups, and the arithmetic per
 * group is unforgiving: 64px of steppers (two at `w-8`), ~20px of field padding
 * and unit label, and the digits themselves. 232px of control, so 116px a group,
 * leaves 52px for a field that needs about 37px.
 *
 * It was 288px, which was slack the description wanted more. 256px was too far
 * the other way: 40px a field clipped the second digit of the minutes against
 * its own "m".
 */
const HOURS_EDIT_COL = "w-[272px]";
const HOURS_EDIT_PX = 272;

/**
 * The editor's trailing remove button.
 *
 * 56px, not 48: the cell keeps the table's own 20px of right padding, and a 48px
 * column left only 8px of content box for a 27px button, so it spilled out of
 * its padding and sat almost against the panel's edge.
 */
const ACTIONS_COL = "w-14";
const ACTIONS_PX = 56;

/**
 * What the description column is never squeezed below.
 *
 * This is a floor, not a comfortable reading width: its only job is to stop the
 * column collapsing to nothing on a narrow window. Set generously it becomes a
 * scrollbar on an ordinary desktop panel, which is worse than a tight column,
 * because the reader then has to scroll to reach the amount on every row.
 */
const DESCRIPTION_FLOOR_PX = 140;

/** Description, Rate, Hours, Amount, and the editor's remove button. */
export function TimeEntryCols({ mode }: { mode: LineTableMode }) {
  return (
    <colgroup>
      <col />
      <col className={RATE_COL} />
      <col className={mode === "edit" ? HOURS_EDIT_COL : HOURS_READ_COL} />
      <col className={AMOUNT_COL} />
      {mode === "edit" && <col className={ACTIONS_COL} />}
    </colgroup>
  );
}

/**
 * Description and Amount, for the tables whose lines carry one figure: flat
 * fees, expenses and adjustments.
 */
export function AmountCols({ mode }: { mode: LineTableMode }) {
  return (
    <colgroup>
      <col />
      <col className={AMOUNT_COL} />
      {mode === "edit" && <col className={ACTIONS_COL} />}
    </colgroup>
  );
}

/**
 * The width the sized columns claim, which the description never gets a share
 * of. Exported for the test that checks the spelled-out minimums below still
 * match the column widths above them.
 */
export function sizedWidth(columns: LineTableColumns, mode: LineTableMode): number {
  const actions = mode === "edit" ? ACTIONS_PX : 0;
  if (columns === "amount") return AMOUNT_PX + actions;
  const hours = mode === "edit" ? HOURS_EDIT_PX : HOURS_READ_PX;
  return RATE_PX + hours + AMOUNT_PX + actions;
}

/** Exported with `sizedWidth`, for the same test. */
export const DESCRIPTION_FLOOR = DESCRIPTION_FLOOR_PX;

/**
 * The table element's own classes, for the column set it carries.
 *
 * `table-fixed` is half the mechanism: a colgroup on an auto-layout table is
 * only a suggestion the content can override. The minimum width is the other
 * half. The description column takes whatever the sized columns leave, and on a
 * window narrower than their total that is nothing at all, so the floor stops it
 * disappearing. Below the floor the `overflow-x-auto` wrapper scrolls, which is
 * what these tables already did at that width. Keep the floor low enough that an
 * ordinary desktop panel clears it: a table that scrolls sideways makes the
 * reader chase the amount on every row.
 */
export function lineTableCls(columns: LineTableColumns, mode: LineTableMode): string {
  // Spelled out per case rather than interpolated from `sizedWidth`: Tailwind v4
  // scans source text, so a `min-w-[${n}px]` template would never reach the
  // stylesheet. `invoiceLineColumns.test.tsx` fails if one of these stops
  // matching the column widths it is the sum of.
  const minCls =
    columns === "timeEntry"
      ? mode === "edit"
        ? "min-w-[740px]"
        : "min-w-[524px]"
      : mode === "edit"
        ? "min-w-[340px]"
        : "min-w-[284px]";
  return `w-full table-fixed text-sm ${minCls}`;
}
