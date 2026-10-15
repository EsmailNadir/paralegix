"use client";

import {
formatCurrency
} from "@/components/billingComp/utils";
import DatePicker from "@/components/ui/DatePicker";
import RequirePermission from "@/components/ui/RequirePermission";
import RowActionMenu from "@/components/ui/RowActionMenu";
import StatusBadge from "@/components/ui/StatusBadge";
import Tooltip from "@/components/ui/Tooltip";
import type useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import type { Invoice } from "@/types";
import { hasOpenPaymentLink } from "./invoiceDetailHelpers";
import dayjs from "dayjs";
import {
Calendar,
CheckCircle2,
CreditCard,
Pencil,
Trash2,
Undo2
} from "lucide-react";

type Detail = Omit<ReturnType<typeof useInvoiceDetailController>, "invoice"> & { invoice: Invoice };

export default function InvoiceDetailPlan({ detail }: { detail: Detail }) {
  const { canManageInvoices, canRecordPayments, invoice, updatingPayment, stripeStatus, showAllInstallments, setShowAllInstallments, editingInstallmentDate, setEditingInstallmentDate, installmentDateDraft, setInstallmentDateDraft, openRequestPayment, setShowVoidStripeConfirm, voidingStripePayment, planEditing, setShowRemovePlanConfirm, highlightedInstallmentIdx, planPanelRef, status, currentTab, openInstallmentPayModal, cancelInstallmentDateEdit, confirmInstallmentDateEdit, enterPlanEdit, handleUnpayInstallment } = detail;
  // The invoice's one open payment link, and the plan row it charges.
  const linkOpen = hasOpenPaymentLink(invoice);
  const linkInstallmentId = linkOpen ? invoice.payLinkInstallmentId ?? null : null;
  // Requesting and cancelling a link follow the summary's Request Payment
  // button. They live in the row menu, so they are simply absent until Stripe
  // is known to be ready rather than held by a placeholder.
  const canUsePaymentLinks = canRecordPayments && stripeStatus === "ready";
  return <>
            {/* Payment Plan tab */}
            {currentTab === "plan" && invoice.paymentPlan?.enabled && (
              <div ref={planPanelRef}>
                <div className="px-6 pt-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-accent-emphasis" />
                    <span className="text-xs text-on-surface-secondary">
                      {formatCurrency(invoice.paymentPlan.installmentAmount)} every{" "}
                      {invoice.paymentPlan.frequencyDays === 7
                        ? "week"
                        : invoice.paymentPlan.frequencyDays === 14
                          ? "2 weeks"
                          : invoice.paymentPlan.frequencyDays === 30
                            ? "month"
                            : `${invoice.paymentPlan.frequencyDays} days`}
                    </span>
                  </div>
                  <RequirePermission permission="billing.manageInvoices">
                    <button
                      type="button"
                      onClick={enterPlanEdit}
                      disabled={updatingPayment}
                      className={`cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-outline-subtle bg-surface-alt text-on-surface hover:bg-surface-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${planEditing ? "invisible pointer-events-none" : ""}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit plan
                    </button>
                  </RequirePermission>
                </div>
                <div>
                    {/* Plan progress */}
                    {(() => {
                      const ep = invoice.paymentPlan!.expectedPayments || [];
                      const paidCount = ep.filter((p) => p.status === "paid").length;
                      const overdueCount = ep.filter(
                        (p) => p.status === "overdue"
                      ).length;
                      const planProgress =
                        ep.length > 0 ? (paidCount / ep.length) * 100 : 0;
                      return (
                        <div className="px-6 py-3">
                          <div className="flex items-center justify-between text-xs text-on-surface-secondary mb-1">
                            <span>
                              {paidCount} of {ep.length} installments paid
                            </span>
                            {overdueCount > 0 && (
                              <span className="text-red-600 dark:text-red-400 font-medium">
                                {overdueCount} overdue
                              </span>
                            )}
                          </div>
                          <div className="w-full bg-surface-alt rounded-full h-1.5 border border-outline">
                            <div
                              className="bg-green-500 h-1.5 rounded-full transition-all"
                              style={{ width: `${planProgress}%` }}
                            />
                          </div>
                        </div>
                      );
                    })()}
                    <table className="w-full text-sm">
                      <thead className="bg-surface-alt text-on-surface-secondary">
                        <tr>
                          <th className="text-left px-5 py-2 font-medium text-xs">
                            Due Date
                          </th>
                          <th className="text-right px-5 py-2 font-medium text-xs">
                            Amount
                          </th>
                          <th className="text-center px-5 py-2 font-medium text-xs">
                            Status
                          </th>
                          <th className="text-right px-5 py-2 font-medium text-xs min-w-[11rem]">
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {(invoice.paymentPlan!.expectedPayments || [])
                          .map((ep, originalIdx) => ({ ep, originalIdx }))
                          .sort((a, b) => dayjs(a.ep.dueDate).valueOf() - dayjs(b.ep.dueDate).valueOf())
                          .slice(0, showAllInstallments ? undefined : 5)
                          .map(({ ep, originalIdx }) => {
                            // The transition lives on the cells (they carry the
                            // background), so clearing the highlight fades out.
                            const isLinkRow = !!ep.id && ep.id === linkInstallmentId;
                            const rowBg = `transition-colors duration-700 ${
                              highlightedInstallmentIdx === originalIdx
                                ? "bg-blue-100 dark:bg-blue-500/20"
                                : "bg-surface"
                            }`;
                            return (
                            <tr key={`${originalIdx}-${ep.dueDate}`}>
                              <td className={`px-5 py-2 text-on-surface-secondary ${rowBg} text-xs`}>
                                {ep.status !== "paid" && editingInstallmentDate === originalIdx ? (
                                  // The Confirm/Cancel buttons in the actions cell are the
                                  // primary way out of this state; there's no keyboard
                                  // shortcut to replicate since the trigger is a button, not
                                  // a typed field.
                                  <DatePicker
                                    value={installmentDateDraft}
                                    onChange={setInstallmentDateDraft}
                                    className="w-[9.5rem]"
                                  />
                                ) : (
                                  <div className="flex flex-col gap-1 items-start">
                                    {ep.status === "paid" ? (
                                      <span className="text-on-surface">
                                        {dayjs(ep.dueDate).format("MMM DD, YYYY")}
                                      </span>
                                    ) : (
                                      // The due date is the thing being changed,
                                      // so it doubles as the way into Reschedule.
                                      <RequirePermission
                                        permission="billing.manageInvoices"
                                        fallback={
                                          <span className="text-on-surface">
                                            {dayjs(ep.dueDate).format("MMM DD, YYYY")}
                                          </span>
                                        }
                                      >
                                        <Tooltip title="Reschedule this installment" enterDelay={300}>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              openInstallmentPayModal(originalIdx, ep.amount, "reschedule")
                                            }
                                            className="cursor-pointer text-on-surface hover:text-accent-emphasis dark:hover:text-accent-emphasis hover:underline transition-colors"
                                          >
                                            {dayjs(ep.dueDate).format("MMM DD, YYYY")}
                                          </button>
                                        </Tooltip>
                                      </RequirePermission>
                                    )}
                                    {ep.isDownPayment && (
                                      <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-1.5 py-0.5 rounded">
                                        Down payment
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className={`px-5 py-2 text-right text-on-surface ${rowBg} text-xs`}>
                                {formatCurrency(ep.amount)}
                              </td>
                              <td className={`px-5 py-2 text-center ${rowBg}`}>
                                <StatusBadge
                                  variant={
                                    ep.status === "paid"
                                      ? "success"
                                      : ep.status === "overdue"
                                        ? "danger"
                                        : isLinkRow
                                          ? "indigo"
                                          : "neutral"
                                  }
                                >
                                  {ep.status === "paid"
                                    ? "Paid"
                                    : ep.status === "overdue"
                                      ? "Overdue"
                                      : isLinkRow
                                        ? "Payment link sent"
                                        : "Upcoming"}
                                </StatusBadge>
                              </td>
                              <td className={`px-5 py-2 text-right ${rowBg}`}>
                                {(ep.status === "pending" ||
                                  ep.status === "overdue") && (canManageInvoices || canRecordPayments) && (
                                  <div className="flex items-center justify-end gap-1.5">
                                    {canManageInvoices && editingInstallmentDate === originalIdx ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            confirmInstallmentDateEdit(originalIdx, ep.dueDate)
                                          }
                                          disabled={updatingPayment}
                                          className="cursor-pointer px-2.5 py-1 text-[11px] font-medium rounded-md bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                        >
                                          {updatingPayment ? "..." : "Confirm"}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={cancelInstallmentDateEdit}
                                          disabled={updatingPayment}
                                          className="cursor-pointer px-2.5 py-1 text-[11px] font-medium rounded-md border border-outline-subtle bg-surface-alt text-on-surface hover:bg-surface-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                        >
                                          Cancel
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        {canManageInvoices && (
                                          <button
                                            onClick={() => openInstallmentPayModal(originalIdx, ep.amount)}
                                            disabled={updatingPayment}
                                            className="cursor-pointer px-2.5 py-1 text-[11px] font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                          >
                                            {updatingPayment ? "..." : "Record"}
                                          </button>
                                        )}
                                        {(() => {
                                          const actions = [
                                            ...(canUsePaymentLinks && ep.id && !isLinkRow
                                              ? [
                                                  {
                                                    label: "Send payment link",
                                                    icon: <CreditCard className="w-3.5 h-3.5" />,
                                                    onClick: () => {
                                                      if (updatingPayment) return;
                                                      openRequestPayment(ep.id ?? null);
                                                    },
                                                  },
                                                ]
                                              : []),
                                            ...(canUsePaymentLinks && isLinkRow
                                              ? [
                                                  {
                                                    label: voidingStripePayment ? "Cancelling..." : "Cancel payment link",
                                                    icon: <Undo2 className="w-3.5 h-3.5" />,
                                                    onClick: () => {
                                                      if (voidingStripePayment || updatingPayment) return;
                                                      setShowVoidStripeConfirm(true);
                                                    },
                                                  },
                                                ]
                                              : []),
                                            ...(canManageInvoices
                                              ? [
                                                  {
                                                    label: "Change due date",
                                                    icon: <Pencil className="w-3.5 h-3.5" />,
                                                    onClick: () => {
                                                      if (updatingPayment) return;
                                                      setEditingInstallmentDate(originalIdx);
                                                      setInstallmentDateDraft(dayjs(ep.dueDate).format("YYYY-MM-DD"));
                                                    },
                                                  },
                                                ]
                                              : []),
                                          ];
                                          return actions.length > 0 ? (
                                            <RowActionMenu ariaLabel="More installment actions" actions={actions} />
                                          ) : null;
                                        })()}
                                      </>
                                    )}
                                  </div>
                                )}
                                {ep.status === "paid" && canManageInvoices && (
                                  <Tooltip title="Mark as unpaid" placement="top" enterDelay={300}>
                                    <span className="inline-flex">
                                      <button aria-label="Mark as unpaid"
                                        onClick={() => handleUnpayInstallment(originalIdx)}
                                        disabled={updatingPayment}
                                        className="group flex items-center gap-1 ml-auto disabled:opacity-50 cursor-pointer"
                                      >
                                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 group-hover:hidden" />
                                        <Undo2 className="w-4 h-4 text-orange-500 hidden group-hover:block" />
                                      </button>
                                    </span>
                                  </Tooltip>
                                )}
                              </td>
                            </tr>
                            );
                          })}
                      </tbody>
                    </table>
                    {(invoice.paymentPlan!.expectedPayments || []).length > 5 && (
                      <div className="flex justify-center border-t border-outline-subtle">
                        <button
                          type="button"
                          onClick={() => setShowAllInstallments((prev) => !prev)}
                          className="cursor-pointer w-full px-5 py-2.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover transition-colors"
                        >
                          {showAllInstallments
                            ? "Show less"
                            : `Show ${(invoice.paymentPlan!.expectedPayments || []).length - 5} more`}
                        </button>
                      </div>
                    )}
                    <RequirePermission permission="billing.manageInvoices">
                      <div className="px-6 py-3 border-t border-outline flex justify-end">
                        <button
                          onClick={() => setShowRemovePlanConfirm(true)}
                          disabled={updatingPayment}
                          className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 bg-transparent hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          <Trash2 className="w-3 h-3" />
                          Remove payment plan
                        </button>
                      </div>
                    </RequirePermission>
                  </div>

              </div>
            )}

  </>;
}
