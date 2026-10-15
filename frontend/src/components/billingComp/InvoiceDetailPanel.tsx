"use client";

import { useState } from "react";
import { CreditCard, Landmark } from "lucide-react";
import { formatCurrency, getInvoiceCreditBalance } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import StatusBadge from "@/components/ui/StatusBadge";
import ShowMoreButton from "@/components/ui/ShowMoreButton";
import type { Invoice } from "@/types";
import SectionLabel from "@/components/ui/SectionLabel";

interface InvoiceDetailPanelProps {
  invoice: Invoice;
  formatDate: (date: any) => string;
  resolveUserName?: (uid: string) => string;
}

/** Installments shown before the list collapses behind "Show N more". */
const INSTALLMENT_PREVIEW_LIMIT = 5;

export default function InvoiceDetailPanel({
  invoice,
  formatDate,
  resolveUserName,
}: InvoiceDetailPanelProps) {
  const [showAllInstallments, setShowAllInstallments] = useState(false);
  const totalAmount = invoice.totalAmount || 0;
  const amountPaid = invoice.amountPaid || 0;
  const writtenOff = invoice.totalWrittenOff || 0;
  const remaining = invoice.remainingBalance ?? Math.max(0, totalAmount - amountPaid - writtenOff);
  const creditBalance = getInvoiceCreditBalance(invoice);
  const expectedPayments = invoice.paymentPlan?.expectedPayments || [];
  const visibleInstallments = showAllInstallments
    ? expectedPayments
    : expectedPayments.slice(0, INSTALLMENT_PREVIEW_LIMIT);

  return (
    <div className="bg-surface rounded-xl border border-outline-subtle shadow-sm overflow-hidden">
      {/* Notes */}
      {invoice.notes && (
        <div className="p-4 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-100 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-300">
          <span className="font-semibold mr-1">Note:</span> {invoice.notes}
        </div>
      )}

      {/* Time Entries */}
      {invoice.timeEntries && invoice.timeEntries.length > 0 && (
        <div className="p-4">
          <SectionLabel gap="3">
            Time Entries
          </SectionLabel>
          <table className="w-full text-sm">
            <thead className="text-[10px] text-on-surface-muted border-b border-outline-subtle">
              <tr>
                <th className="text-left font-medium py-2">Service</th>
                <th className="text-right font-medium py-2">Rate</th>
                <th className="text-right font-medium py-2">Hours</th>
                <th className="text-right font-medium py-2">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-subtle">
              {invoice.timeEntries.map((entry, idx) => (
                <tr key={entry.id || idx}>
                  <td className="py-2.5 pr-4">
                    <p className="text-xs font-medium text-on-surface">
                      {entry.name || "Legal Service"}
                      {entry.allocationPercent != null && entry.allocationPercent < 100 && (
                        <span className="text-on-surface-muted font-normal ml-1">({entry.allocationPercent}%)</span>
                      )}
                    </p>
                    {entry.description && (
                      <p className="text-on-surface-muted text-[10px] mt-0.5">
                        {entry.description}
                      </p>
                    )}
                  </td>
                  <td className="py-2.5 text-right text-xs text-on-surface-secondary">
                    {formatCurrency(entry.rate || 0)}/hr
                  </td>
                  <td className="py-2.5 text-right text-xs text-on-surface-secondary">
                    {formatHoursMinutes(entry.hours || 0)}
                  </td>
                  <td className="py-2.5 text-right text-xs font-medium text-on-surface">
                    {/* Show the stored ALLOCATED amount so split-invoice line items sum
                        to the invoice total; grossing up to the full line broke that. */}
                    {formatCurrency(entry.amount || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Flat Fees */}
      {invoice.flatFees && invoice.flatFees.length > 0 && (
        <div className="p-4 border-t border-outline-subtle">
          <SectionLabel gap="3">
            Flat Fees
          </SectionLabel>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-outline-subtle">
              {invoice.flatFees.map((fee, idx) => (
                <tr key={fee.id || idx}>
                  <td className="py-2.5 pr-4 text-xs font-medium text-on-surface">
                    {fee.description}
                    {fee.allocationPercent != null && fee.allocationPercent < 100 && (
                      <span className="text-on-surface-muted font-normal ml-1">({fee.allocationPercent}%)</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right text-xs font-medium text-on-surface">
                    {/* Allocated amount (not grossed up) so the line reconciles with the total. */}
                    {formatCurrency(fee.amount || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expenses */}
      {invoice.expenses && invoice.expenses.length > 0 && (
        <div className="p-4 border-t border-outline-subtle">
          <SectionLabel gap="3">
            Expenses
          </SectionLabel>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-outline-subtle">
              {invoice.expenses.map((expense, idx) => (
                <tr key={expense.id || idx}>
                  <td className="py-2.5 pr-4 text-xs font-medium text-on-surface">
                    {expense.description || "Expense"}
                    {expense.vendor && (
                      <span className="text-on-surface-muted font-normal ml-1">({expense.vendor})</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right text-xs font-medium text-on-surface">
                    {formatCurrency(expense.amount || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Payment History */}
      {invoice.payments && invoice.payments.length > 0 && (
        <div className="p-4 border-t border-outline-subtle">
          <SectionLabel gap="3">
            Payment History
          </SectionLabel>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-outline-subtle">
              {invoice.payments.map((payment, idx) => (
                <tr key={idx}>
                  <td className="py-2 text-xs text-on-surface-secondary">
                    <div className="flex items-center gap-2">
                      <span>{formatDate(payment.date)}</span>
                      {payment.paymentSource === "trust" && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent-emphasis dark:text-accent-emphasis bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-1.5 py-0.5 rounded">
                          <Landmark size={9} />
                          Trust
                        </span>
                      )}
                      {payment.paymentSource === "stripe" && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 px-1.5 py-0.5 rounded">
                          <CreditCard size={9} />
                          Stripe
                        </span>
                      )}
                    </div>
                    {payment.note && (
                      <p className="text-[10px] text-on-surface-muted mt-0.5">{payment.note}</p>
                    )}
                    {resolveUserName && payment.recordedBy && (
                      <p className="text-[10px] text-on-surface-muted mt-0.5">
                        by {resolveUserName(payment.recordedBy)}
                      </p>
                    )}
                  </td>
                  <td className="py-2 text-right text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(payment.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Credit Notes / Adjustments */}
      {invoice.creditNotes && invoice.creditNotes.length > 0 && (
        <div className="p-4 border-t border-outline-subtle">
          <SectionLabel gap="3">
            Adjustments
          </SectionLabel>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-outline-subtle">
              {invoice.creditNotes.map((cn) => (
                <tr key={cn.id}>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      cn.type === "write_off"
                        ? "bg-surface-alt text-on-surface-muted"
                        : cn.type === "discount"
                        ? "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400"
                        : "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                    }`}>
                      {cn.label || cn.type?.replace("_", " ") || "Adjustment"}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-on-surface-secondary">{cn.description}</td>
                  <td className="py-2 text-right text-xs font-medium text-on-surface">
                    -{formatCurrency(cn.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Payment Plan Schedule */}
      {invoice.paymentPlan?.enabled && (
        <div className="p-4 border-t border-outline-subtle">
          <SectionLabel gap="3">
            Payment Plan
          </SectionLabel>
          {(() => {
            const paidCount = expectedPayments.filter((p) => p.status === "paid").length;
            const overdueCount = expectedPayments.filter((p) => p.status === "overdue").length;
            const progress = expectedPayments.length > 0 ? (paidCount / expectedPayments.length) * 100 : 0;
            return (
              <div className="mb-3">
                <div className="flex items-center justify-between text-[10px] text-on-surface-muted mb-1">
                  <span>
                    {paidCount} of {expectedPayments.length} installments paid
                  </span>
                  {overdueCount > 0 && (
                    <span className="text-rose-600 dark:text-rose-400 font-medium">
                      {overdueCount} overdue
                    </span>
                  )}
                </div>
                <div className="w-full bg-surface-alt rounded-full h-1.5 border border-outline-subtle">
                  <div
                    className="bg-emerald-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            );
          })()}
          <div className="rounded-lg border border-outline-subtle overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <th className="text-left font-medium text-[10px] uppercase tracking-[0.06em] px-3 py-2">Due Date</th>
                  <th className="text-right font-medium text-[10px] uppercase tracking-[0.06em] px-3 py-2">Amount</th>
                  <th className="text-center font-medium text-[10px] uppercase tracking-[0.06em] px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-subtle">
                {visibleInstallments.map((ep, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2 text-xs text-on-surface-secondary">
                      {formatDate(ep.dueDate)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-on-surface">
                      {formatCurrency(ep.amount)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <StatusBadge
                        variant={ep.status === "paid" ? "success" : ep.status === "overdue" ? "danger" : "neutral"}
                      >
                        {ep.status === "paid" ? "Paid" : ep.status === "overdue" ? "Overdue" : "Upcoming"}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ShowMoreButton
            expanded={showAllInstallments}
            hiddenCount={expectedPayments.length - INSTALLMENT_PREVIEW_LIMIT}
            onToggle={() => setShowAllInstallments((prev) => !prev)}
          />
        </div>
      )}

      {/* Total Footer */}
      <div className="bg-surface-alt p-4 border-t border-outline-subtle flex justify-end">
        <div className="text-right">
          <p className="text-[10px] text-on-surface-muted">Invoice Total</p>
          <p className="text-lg font-bold text-on-surface">{formatCurrency(totalAmount)}</p>
          {amountPaid > 0 && remaining > 0 && (
            <div className="mt-1">
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Paid: {formatCurrency(amountPaid)}
              </p>
              <p className="text-xs font-bold text-rose-600 dark:text-rose-400">
                Remaining: {formatCurrency(remaining)}
              </p>
            </div>
          )}
          {/* An over-settled invoice has remaining === 0, so it would otherwise show
              nothing at all here despite the firm owing the client money. */}
          {creditBalance > 0 && (
            <div className="mt-1">
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Paid: {formatCurrency(amountPaid)}
              </p>
              <p className="text-xs font-bold text-amber-600 dark:text-amber-400">
                Credit due: {formatCurrency(creditBalance)}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
