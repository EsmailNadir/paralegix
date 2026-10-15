"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import HoursMinutesInput from "@/components/ui/HoursMinutesInput";
import InvoiceLineTextModal from "@/components/billingComp/InvoiceLineTextModal";
import {
  AmountCols,
  lineTableCls,
  TimeEntryCols,
} from "@/components/billingComp/invoiceLineColumns";
import { formatCurrency } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import { lineHours, type EditableLine } from "@/hooks/billingHooks/useInvoiceLineItemEditor";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";

/**
 * Edit mode for an invoice's line items.
 *
 * The read-only tables stay in InvoiceDetailView; this renders the same table
 * skeleton with inputs in place of text so toggling between the two does not
 * shift the layout. Header, cell padding, dividers and `tabular-nums` are copied
 * from that read view deliberately - they must not drift apart. The column
 * widths are no longer copied at all: both views take them from
 * `invoiceLineColumns`, which is the one part of that promise a file can keep on
 * its own rather than by being careful.
 *
 * A time entry's title and description are edited in a dialog, opened from the
 * row, rather than in the table. The first column is ~190px: enough for the
 * wrapped sentence the read view prints there, not enough for two input boxes.
 * Widening it would have cost the numeric columns their alignment, and giving
 * the description a full-width row of its own turned every line into a stack of
 * five controls. So the row goes on printing the pair as text, and only the
 * numbers, which are short, are edited in place.
 *
 * A line's amount is never an input for hourly work: the server prices it as
 * hours x rate and ignores any amount sent for a time entry, so showing an
 * editable box would promise something the API does not honour.
 */

// The native number spinners sit on top of a right-aligned figure and cover it,
// so they are stripped the same way every other numeric field in the app does it.
const NUM_INPUT_CLS =
  `${FULL_INPUT_CLS} text-right tabular-nums`;
const TH_CLS =
  "text-left px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide";
const TH_RIGHT_CLS =
  "text-right px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide";
const SECTION_TITLE_CLS = "text-base font-semibold text-on-surface";
// Negative margins so the hover fill reaches past the text without the cell
// growing: the row has to stay the height it is in the read view beside it.
const TEXT_BTN_CLS =
  "group flex w-full items-start gap-2 -mx-2 -my-1 cursor-pointer rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-hover";
// The remove button's column gives up its left padding and keeps the table's own
// 20px on the right, so the icon sits the same distance from the panel edge as
// the description does from the other one.
const ACTIONS_CELL_CLS = "py-3 pl-0 pr-5 text-right";
const REMOVE_BTN_CLS =
  "cursor-pointer p-1.5 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100";

/**
 * The list setters are the `useState` setters from `useInvoiceLineItemEditor`,
 * typed to accept an updater rather than only a finished array.
 *
 * That is not a formality. `HoursMinutesInput` reports a carry between its two
 * fields as two calls, one per field, and both land in the same tick. Built from
 * the array in the render closure, the second call would be computed from the
 * state before the first and would silently overwrite it: typing 199 minutes
 * saved 19 and dropped the three hours it carried.
 */
type LineSetter = React.Dispatch<React.SetStateAction<EditableLine[]>>;

interface Props {
  timeEntries: EditableLine[];
  setTimeEntries: LineSetter;
  flatFees: EditableLine[];
  setFlatFees: LineSetter;
  expenses: EditableLine[];
  setExpenses: LineSetter;
  preview: {
    subtotal: number;
    tax: number;
    total: number;
    hours: number;
    settled: number;
    creditIfSaved: number;
    delta: number;
  };
  taxRate?: number | null;
  submitting: boolean;
  error: string | Error | null;
  onClearError: () => void;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * Replace one row in a list, keyed on the stable rowKey.
 *
 * Returns an updater rather than an array so two changes in one tick compose:
 * see `LineSetter` for the carry that made this necessary.
 */
function patch(rowKey: string, changes: Partial<EditableLine>) {
  return (lines: EditableLine[]) =>
    lines.map((line) => (line.rowKey === rowKey ? { ...line, ...changes } : line));
}

export default function InvoiceLineItemsEditor({
  timeEntries,
  setTimeEntries,
  flatFees,
  setFlatFees,
  expenses,
  setExpenses,
  preview,
  taxRate,
  submitting,
  error,
  onClearError,
  onCancel,
  onSave,
}: Props) {
  const empty = timeEntries.length === 0 && flatFees.length === 0 && expenses.length === 0;

  // Which line's text dialog is open, by the same stable key the rows patch on.
  // Holding the key rather than the line keeps the dialog reading the draft, so
  // it cannot show a copy that went stale while it was open.
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const editingLine = timeEntries.find((line) => line.rowKey === editingRowKey) ?? null;

  /** Flat fees and expenses differ only in their heading and which list they write. */
  const renderAmountTable = (
    title: string,
    lines: EditableLine[],
    setLines: LineSetter,
    topBorder: boolean,
  ) => (
    <div className={topBorder ? "border-t border-outline pt-6" : ""}>
      <div className="px-6 py-4 border-b border-outline">
        <h2 className={SECTION_TITLE_CLS}>{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className={lineTableCls("amount", "edit")}>
          <AmountCols mode="edit" />
          <thead className="bg-surface-alt">
            <tr>
              <th className={TH_CLS}>Description</th>
              <th className={TH_RIGHT_CLS}>Amount</th>
              <th className={ACTIONS_CELL_CLS} />
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-subtle">
            {lines.map((line) => (
              <tr key={line.rowKey}>
                <td className="px-5 py-3">
                  <input
                    type="text"
                    aria-label="Line description"
                    className={FULL_INPUT_CLS}
                    value={line.description ?? ""}
                    placeholder="Description"
                    onChange={(e) => setLines(patch(line.rowKey, { description: e.target.value }))}
                  />
                </td>
                <td className="px-5 py-3">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    aria-label="Amount"
                    className={NUM_INPUT_CLS}
                    value={line.amount ?? 0}
                    onChange={(e) => setLines(patch(line.rowKey, { amount: Number(e.target.value) }))}
                  />
                </td>
                <td className={ACTIONS_CELL_CLS}>
                  <Tooltip title="Remove line" enterDelay={300}>
                    <button
                      type="button"
                      aria-label="Remove line"
                      className={REMOVE_BTN_CLS}
                      onClick={() => setLines((rows) => rows.filter((l) => l.rowKey !== line.rowKey))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      {/* Edit mode replaces the read tables in place, so the panel has to say it
          changed: without this the only sign is that some of the text became
          inputs. The actions sit here rather than under the last table because
          the control that opens the editor is in the tab strip directly above,
          so this is where the reader is already looking. Below a full invoice's
          worth of lines they were off the bottom of the screen, and the panel
          cannot hold them there: the card around it is `overflow-hidden`, which
          makes a `sticky` bar stick to nothing. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-outline bg-surface-alt px-6 py-3">
        <Pencil size={14} className="shrink-0 text-accent-emphasis" />
        <h2 className="text-sm font-medium text-on-surface">Editing line items</h2>
        <p className="hidden text-xs text-on-surface-muted sm:block">
          Nothing changes until you save.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button type="secondary" size="small" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="primary" size="small" loading={submitting} onClick={onSave}>
            Save changes
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-6 pt-4">
          <ErrorNotification error={error} onClose={onClearError} compact />
        </div>
      )}

      {empty && (
        <p className="px-6 py-10 text-sm text-on-surface-muted text-center">
          Every line has been removed. Saving will leave this invoice with a zero total.
        </p>
      )}

      {timeEntries.length > 0 && (
        <div>
          <div className="px-6 py-4 border-b border-outline">
            <h2 className={SECTION_TITLE_CLS}>Time Entries</h2>
          </div>
          <div className="overflow-x-auto">
            <table className={lineTableCls("timeEntry", "edit")}>
              <TimeEntryCols mode="edit" />
              <thead className="bg-surface-alt">
                <tr>
                  <th className={TH_CLS}>Description</th>
                  <th className={TH_RIGHT_CLS}>Rate</th>
                  <th className={TH_RIGHT_CLS}>Hours</th>
                  <th className={TH_RIGHT_CLS}>Amount</th>
                  <th className={ACTIONS_CELL_CLS} />
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-subtle">
                {timeEntries.map((line) => {
                  const lineAmount = lineHours(line) * (Number(line.rate) || 0);
                  return (
                    <tr key={line.rowKey}>
                      <td className="px-5 py-3">
                        {/* The whole text block is the control, so the target is
                            the thing being edited rather than a 13px icon. The
                            pencil marks it as one; the sr-only line names the
                            action, which the title and description alone do not. */}
                        <button
                          type="button"
                          className={TEXT_BTN_CLS}
                          onClick={() => setEditingRowKey(line.rowKey)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-on-surface">
                              {line.name || "Service"}
                            </span>
                            {line.description && (
                              <span className="mt-0.5 block text-xs text-on-surface-muted">
                                {line.description}
                              </span>
                            )}
                          </span>
                          <Pencil
                            size={13}
                            className="mt-0.5 shrink-0 text-on-surface-muted transition-colors group-hover:text-on-surface"
                          />
                          <span className="sr-only">Edit title and description</span>
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          aria-label="Rate"
                          className={NUM_INPUT_CLS}
                          value={line.rate ?? 0}
                          onChange={(e) =>
                            setTimeEntries(patch(line.rowKey, { rate: Number(e.target.value) }))
                          }
                        />
                      </td>
                      <td className="px-5 py-3">
                        <HoursMinutesInput
                          size="sm"
                          hours={line.hoursInput ?? ""}
                          minutes={line.minutesInput ?? ""}
                          onHoursChange={(value) =>
                            setTimeEntries(patch(line.rowKey, { hoursInput: value }))
                          }
                          onMinutesChange={(value) =>
                            setTimeEntries(patch(line.rowKey, { minutesInput: value }))
                          }
                        />
                      </td>
                      <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                        {formatCurrency(lineAmount)}
                      </td>
                      <td className={ACTIONS_CELL_CLS}>
                        <Tooltip title="Remove line" enterDelay={300}>
                          <button
                            type="button"
                            aria-label="Remove line"
                            className={REMOVE_BTN_CLS}
                            onClick={() =>
                              setTimeEntries((rows) => rows.filter((l) => l.rowKey !== line.rowKey))
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {flatFees.length > 0 &&
        renderAmountTable("Flat Fees", flatFees, setFlatFees, timeEntries.length > 0)}

      {expenses.length > 0 &&
        renderAmountTable(
          "Expenses",
          expenses,
          setExpenses,
          timeEntries.length > 0 || flatFees.length > 0,
        )}

      {/* Live totals, so the effect of an edit is visible before it is saved. */}
      <div className="border-t border-outline px-6 py-4 space-y-1.5">
        {timeEntries.length > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-on-surface-secondary">Total Hours</span>
            <span className="text-on-surface tabular-nums">
              {formatHoursMinutes(preview.hours)}
            </span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-on-surface-secondary">Subtotal</span>
          <span className="text-on-surface tabular-nums">{formatCurrency(preview.subtotal)}</span>
        </div>
        {Number(taxRate) > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-on-surface-secondary">Tax ({taxRate}%)</span>
            <span className="text-on-surface tabular-nums">{formatCurrency(preview.tax)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm pt-1.5 border-t border-outline-subtle">
          <span className="font-semibold text-on-surface">New Total</span>
          <span className="font-bold text-on-surface tabular-nums">
            {formatCurrency(preview.total)}
          </span>
        </div>
        {preview.delta !== 0 && (
          <p className="text-xs text-on-surface-muted text-right">
            {preview.delta > 0 ? "+" : "−"}
            {formatCurrency(Math.abs(preview.delta))} vs the current total
          </p>
        )}
      </div>

      {/* Not an error - the save is allowed. It is a consequence the user should
          see before committing to it, so it reads as a warning, not a failure. */}
      {preview.creditIfSaved > 0 && (
        <div className="px-6 pb-4">
          <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
            <p className="text-xs text-amber-900 dark:text-amber-200">
              This total is {formatCurrency(preview.creditIfSaved)} below the{" "}
              {formatCurrency(preview.settled)} already settled on this invoice. Saving
              will leave that amount as a credit owed to the client.
            </p>
          </div>
        </div>
      )}

      {/* One dialog for the whole table rather than one per row: only a single
          line can be open at a time, and mounting a panel per line would mount
          a focus trap per line with it. */}
      <InvoiceLineTextModal
        isOpen={editingRowKey !== null}
        line={editingLine}
        onClose={() => setEditingRowKey(null)}
        onDone={(text) => {
          if (editingRowKey) setTimeEntries(patch(editingRowKey, text));
          setEditingRowKey(null);
        }}
      />
    </div>
  );
}
