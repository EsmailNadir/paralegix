"use client";

import InvoiceLineItemsEditor from "@/components/billingComp/InvoiceLineItemsEditor";
import {
AmountCols,
lineTableCls,
TimeEntryCols,
} from "@/components/billingComp/invoiceLineColumns";
import {
formatCurrency
} from "@/components/billingComp/utils";
import Th from "@/components/ui/Th";
import type useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import { formatHoursMinutes } from "@/lib/utils/format";
import type { Invoice } from "@/types";
import dayjs from "dayjs";

type Detail = Omit<ReturnType<typeof useInvoiceDetailController>, "invoice"> & { invoice: Invoice };

export default function InvoiceDetailLineItems({ detail }: { detail: Detail }) {
  const { invoice, error, setError, lineEditor, totalHours, timeEntries, flatFees, expenses, timeEntriesTotal, flatFeesTotal, expensesTotal, amountAdjustments, adjustmentsTotal, currentTab } = detail;
  return <>
              {/* Line Items tab */}
              {currentTab === "items" && lineEditor.open && (
                <InvoiceLineItemsEditor
                  timeEntries={lineEditor.timeEntries}
                  setTimeEntries={lineEditor.setTimeEntries}
                  flatFees={lineEditor.flatFees}
                  setFlatFees={lineEditor.setFlatFees}
                  expenses={lineEditor.expenses}
                  setExpenses={lineEditor.setExpenses}
                  preview={lineEditor.preview}
                  taxRate={invoice.taxRate}
                  submitting={lineEditor.submitting}
                  error={lineEditor.error}
                  onClearError={() => lineEditor.setError(null)}
                  onCancel={() => lineEditor.setOpen(false)}
                  onSave={() => lineEditor.submit()}
                />
              )}

              {currentTab === "items" && !lineEditor.open && (
              <div>
              {timeEntries.length === 0 && flatFees.length === 0 && expenses.length === 0 &&
                amountAdjustments.length === 0 && !invoice.notes && (
                <p className="px-6 py-10 text-sm text-on-surface-muted text-center">
                  No line items on this invoice.
                </p>
              )}
              {/* Time Entries */}
              {timeEntries.length > 0 && (
                <div>
                  <div className="px-6 py-4 border-b border-outline">
                    <h2 className="text-base font-semibold text-on-surface">
                      Time Entries
                    </h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={lineTableCls("timeEntry", "read")}>
                      <TimeEntryCols mode="read" />
                      <thead className="bg-surface-alt">
                        <tr>
                          <Th>
                            Description
                          </Th>
                          <Th align="right">
                            Rate
                          </Th>
                          <Th align="right">
                            Hours
                          </Th>
                          <Th align="right">
                            Amount
                          </Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {timeEntries.map((entry, index) => (
                          <tr
                            key={entry.id || index}
                            className="hover:bg-surface-hover transition-colors"
                          >
                            <td className="px-5 py-3 text-on-surface">
                              <div className="font-medium">
                                {entry.name || "Service"}
                                {entry.allocationPercent != null && entry.allocationPercent < 100 && (
                                  <span className="text-xs text-on-surface-muted font-normal ml-1.5">
                                    ({entry.allocationPercent}%)
                                  </span>
                                )}
                              </div>
                              {entry.description && (
                                <div className="text-xs text-on-surface-muted mt-0.5">
                                  {entry.description}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface tabular-nums">
                              {formatCurrency(entry.rate || 0)}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface tabular-nums">
                              {/* entry.hours/amount are already this recipient's allocated
                                  share on a split invoice - grossing them back up to the
                                  full line made the rows not add up to the invoice total. */}
                              {formatHoursMinutes(entry.hours || 0)}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatCurrency(entry.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      {timeEntries.length > 0 && (
                        <tfoot>
                          <tr className="bg-surface-alt border-t border-outline">
                            <td
                              colSpan={2}
                              className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium"
                            >
                              Total Hours:
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatHoursMinutes(totalHours)}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">
                              {formatCurrency(timeEntriesTotal)}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              )}

              {/* Flat Fees */}
              {flatFees.length > 0 && (
                <div className={timeEntries.length > 0 ? "border-t border-outline pt-6" : ""}>
                  <div className="px-6 py-4 border-b border-outline">
                    <h2 className="text-base font-semibold text-on-surface">
                      Flat Fees
                    </h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={lineTableCls("amount", "read")}>
                      <AmountCols mode="read" />
                      <thead className="bg-surface-alt">
                        <tr>
                          <Th>
                            Description
                          </Th>
                          <Th align="right">
                            Amount
                          </Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {flatFees.map((fee, index) => (
                          <tr
                            key={fee.id || `fee-${index}`}
                            className="hover:bg-surface-hover transition-colors"
                          >
                            <td className="px-5 py-3 text-on-surface">
                              {fee.description}
                              {fee.allocationPercent != null && fee.allocationPercent < 100 && (
                                <span className="text-xs text-on-surface-muted ml-1.5">
                                  ({fee.allocationPercent}%)
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatCurrency(fee.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-surface-alt border-t border-outline">
                          <td className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium">
                            Total Flat Fees:
                          </td>
                          <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">
                            {formatCurrency(flatFeesTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Expenses */}
              {expenses.length > 0 && (
                <div className={timeEntries.length > 0 || flatFees.length > 0 ? "border-t border-outline pt-6" : ""}>
                  <div className="px-6 py-4 border-b border-outline">
                    <h2 className="text-base font-semibold text-on-surface">
                      Expenses
                    </h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={lineTableCls("amount", "read")}>
                      <AmountCols mode="read" />
                      <thead className="bg-surface-alt">
                        <tr>
                          <Th>
                            Description
                          </Th>
                          <Th align="right">
                            Amount
                          </Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {expenses.map((expense, index) => (
                          <tr
                            key={expense.id || `expense-${index}`}
                            className="hover:bg-surface-hover transition-colors"
                          >
                            <td className="px-5 py-3 text-on-surface">
                              {expense.description || "Expense"}
                              {expense.vendor && (
                                <span className="text-xs text-on-surface-muted ml-1.5">
                                  ({expense.vendor})
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatCurrency(expense.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-surface-alt border-t border-outline">
                          <td className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium">
                            Total Expenses:
                          </td>
                          <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">
                            {formatCurrency(expensesTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Adjustments (Add Amount / late fees - these raise the total without a line item row) */}
              {amountAdjustments.length > 0 && (
                <div className={timeEntries.length > 0 || flatFees.length > 0 || expenses.length > 0 ? "border-t border-outline pt-6" : ""}>
                  <div className="px-6 py-4 border-b border-outline">
                    <h2 className="text-base font-semibold text-on-surface">
                      Adjustments
                    </h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={lineTableCls("amount", "read")}>
                      <AmountCols mode="read" />
                      <thead className="bg-surface-alt">
                        <tr>
                          <Th>
                            Description
                          </Th>
                          <Th align="right">
                            Amount
                          </Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {amountAdjustments.map((adjustment, index) => (
                          <tr key={index} className="hover:bg-surface-hover transition-colors">
                            <td className="px-5 py-3 text-on-surface">
                              {adjustment.note ||
                                (adjustment.kind
                                  ? adjustment.kind
                                      .replace(/_/g, " ")
                                      .replace(/\b\w/g, (c) => c.toUpperCase())
                                  : "Adjustment")}
                              {adjustment.addedAt && (
                                <span className="text-xs text-on-surface-muted ml-1.5">
                                  {dayjs(adjustment.addedAt).format("MMM D, YYYY")}
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatCurrency(Number(adjustment.amount) || 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-surface-alt border-t border-outline">
                          <td className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium">
                            Total Adjustments:
                          </td>
                          <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">
                            {formatCurrency(adjustmentsTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Notes */}
              {invoice.notes && (
                <div className={`px-6 pb-5 ${timeEntries.length > 0 || flatFees.length > 0 || expenses.length > 0 || amountAdjustments.length > 0 ? "border-t border-outline pt-6" : "pt-5"}`}>
                  <h2 className="text-base font-semibold text-on-surface mb-3">
                    Notes
                  </h2>
                  <p className="text-sm text-on-surface-secondary whitespace-pre-wrap leading-relaxed">
                    {invoice.notes}
                  </p>
                </div>
              )}
              </div>
              )}

  </>;
}
