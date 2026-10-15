"use client";

import PaymentSurchargeNote from "@/components/billingComp/PaymentSurchargeNote";
import PaymentCardFeeRefundNote from "@/components/billingComp/PaymentCardFeeRefundNote";
import ConfirmAction from "@/components/ui/ConfirmAction";

import {
formatCurrency
} from "@/components/billingComp/utils";
import ActionIconButton from "@/components/ui/ActionIconButton";
import RequirePermission from "@/components/ui/RequirePermission";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import type useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import type { Invoice } from "@/types";
import dayjs from "dayjs";
import {
CreditCard,
Download,
Eye,
Landmark,
Pencil,
Trash2
} from "lucide-react";

type Detail = Omit<ReturnType<typeof useInvoiceDetailController>, "invoice"> & { invoice: Invoice };

export default function InvoiceDetailPayments({ detail }: { detail: Detail }) {
  const { resolveUserName, updatingPayment, downloadingReceiptIdx, viewingReceiptIdx, setEditingPayment, setEditPaymentOpen, setEditPaymentError, setDeletePaymentConfirm, setDeletePaymentError, showAllPayments, setShowAllPayments, payments, creditNotes, currentTab, handleDeleteCreditNote, handleDownloadPaymentReceipt, handleViewPaymentReceipt } = detail;
  return <>
            {/* Payments tab */}
            {currentTab === "payments" && (
              <div>
                {payments.length === 0 ? (
                  <p className="px-6 py-10 text-sm text-on-surface-muted text-center">
                    No payments recorded yet.
                  </p>
                ) : (
                  <div>
                    <table className="w-full text-sm">
                      <thead className="bg-surface-alt text-on-surface-secondary">
                        <tr>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Date
                          </th>
                          <th className="text-right px-5 py-3 font-medium text-xs">
                            Amount
                          </th>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Invoice #
                          </th>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Note
                          </th>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Recorded By
                          </th>
                          <th className="text-right px-5 py-3 font-medium text-xs w-24">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {/* Sliced from the front so `idx` stays the payment's real
                            position in payments[] - it is the index the edit and
                            delete endpoints address the payment by. */}
                        {payments.slice(0, showAllPayments ? undefined : 5).map((payment, idx) => (
                          <tr key={idx}>
                                <td className="px-5 py-3 text-on-surface bg-surface">
                                  {dayjs(payment.date).format("MMM DD, YYYY")}
                                </td>
                                <td className="px-5 py-3 text-right text-on-surface font-medium bg-surface">
                                  {formatCurrency(payment.amount)}
                                  <PaymentSurchargeNote surchargeCents={payment.surchargeCents} />
                                </td>
                                <td className="px-5 py-3 text-on-surface-muted bg-surface text-xs">
                                  {payment.invoiceNumber || "-"}
                                </td>
                                <td className="px-5 py-3 text-on-surface-muted bg-surface text-xs">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {payment.paymentSource === "trust" && (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent-emphasis dark:text-accent-emphasis bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-1.5 py-0.5 rounded">
                                        <Landmark size={9} />
                                        Trust
                                      </span>
                                    )}
                                    {(payment.paymentSource === "stripe" || payment.stripePaymentIntentId || payment.stripeSessionId) && (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 px-1.5 py-0.5 rounded">
                                        <CreditCard size={9} />
                                        Stripe
                                      </span>
                                    )}
                                    <span>{payment.note || (payment.paymentSource === "trust" || payment.paymentSource === "stripe" || payment.stripePaymentIntentId || payment.stripeSessionId ? "" : "-")}</span>
                                  </div>
                                  <PaymentCardFeeRefundNote payment={payment} />
                                </td>
                                <td className="px-5 py-3 text-on-surface-muted bg-surface text-xs">
                                  {payment.recordedBy ? resolveUserName(payment.recordedBy) : "-"}
                                </td>
                                <td className="px-5 py-3 text-right bg-surface">
                                  <div className="flex items-center justify-end gap-1">
                                    <ActionIconButton
                                      label="View receipt"
                                      onClick={() => handleViewPaymentReceipt(payment, idx)}
                                      disabled={viewingReceiptIdx === idx}
                                      tone="info"
                                      size="sm"
                                    >
                                      {viewingReceiptIdx === idx ? <Spinner /> : <Eye className="w-3.5 h-3.5" />}
                                    </ActionIconButton>
                                    <ActionIconButton
                                      label="Download receipt"
                                      onClick={() => handleDownloadPaymentReceipt(payment, idx)}
                                      disabled={downloadingReceiptIdx === idx}
                                      tone="success"
                                      size="sm"
                                    >
                                      {downloadingReceiptIdx === idx ? <Spinner /> : <Download className="w-3.5 h-3.5" />}
                                    </ActionIconButton>
                                    <RequirePermission permission="billing.recordPayments">
                                      <ActionIconButton
                                        label="Edit payment"
                                        onClick={() => {
                                          setEditingPayment({
                                            index: idx,
                                            id: payment.id,
                                            amount: payment.amount.toFixed(2),
                                            date: dayjs(payment.date).format("YYYY-MM-DD"),
                                            note: payment.note || "",
                                            invoiceNumber: payment.invoiceNumber || "",
                                          });
                                          setEditPaymentError(null);
                                          setEditPaymentOpen(true);
                                        }}
                                        tone="info"
                                        size="sm"
                                      >
                                        <Pencil className="w-3.5 h-3.5" />
                                      </ActionIconButton>
                                      <ActionIconButton
                                        label="Delete payment"
                                        onClick={() => {
                                          setDeletePaymentError(null);
                                          setDeletePaymentConfirm({
                                            index: idx,
                                            id: payment.id,
                                            amount: payment.amount,
                                            date: payment.date,
                                          });
                                        }}
                                        tone="danger"
                                        size="sm"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </ActionIconButton>
                                    </RequirePermission>
                                  </div>
                                </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {payments.length > 5 && (
                      <div className="border-t border-outline">
                        <button
                          type="button"
                          onClick={() => setShowAllPayments((prev) => !prev)}
                          className="cursor-pointer w-full px-5 py-2.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover transition-colors"
                        >
                          {showAllPayments
                            ? "Show less"
                            : `Show ${payments.length - 5} more`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Credit Notes tab */}
            {currentTab === "credits" && creditNotes.length > 0 && (
              <div>
                {(
                  <div>
                    <table className="w-full text-sm">
                      <thead className="bg-surface-alt text-on-surface-secondary">
                        <tr>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Type
                          </th>
                          <th className="text-right px-5 py-3 font-medium text-xs">
                            Amount
                          </th>
                          <th className="text-left px-5 py-3 font-medium text-xs">
                            Description
                          </th>
                          <th className="text-right px-5 py-3 font-medium text-xs w-16">
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-subtle">
                        {creditNotes.map((cn, cnIndex) => (
                          <tr key={cn.id || cnIndex}>
                            <td className="px-5 py-3 bg-surface">
                              <StatusBadge
                                variant={
                                  cn.type === "write_off"
                                    ? "neutral"
                                    : cn.type === "discount"
                                      ? "purple"
                                      : "warning"
                                }
                              >
                                {cn.label ||
                                  cn.type
                                    ?.replace(/_/g, " ")
                                    .replace(/\b\w/g, (c: string) =>
                                      c.toUpperCase()
                                    ) ||
                                  "Write Off"}
                              </StatusBadge>
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-medium bg-surface">
                              -{formatCurrency(cn.amount)}
                            </td>
                            <td className="px-5 py-3 text-on-surface-secondary bg-surface text-xs">
                              {cn.description}
                            </td>
                            <td className="px-5 py-3 text-right bg-surface">
                              <RequirePermission permission="billing.manageInvoices">
                                <ConfirmAction title="Remove Credit Note" message={`Remove credit note "${cn.description || cn.type}" (${formatCurrency(cn.amount)})? This will update the invoice balance.`} onConfirm={() => cn.id ? handleDeleteCreditNote(cn.id) : undefined} stacked>
                                  {(request, busy) => (
                                    <ActionIconButton
                                      label="Remove credit note"
                                      onClick={request}
                                      disabled={updatingPayment || busy || !cn.id}
                                      tone="danger"
                                      size="sm"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </ActionIconButton>
                                  )}
                                </ConfirmAction>
                              </RequirePermission>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

  </>;
}
