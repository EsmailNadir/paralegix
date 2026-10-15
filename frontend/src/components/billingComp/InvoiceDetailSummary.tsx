"use client";

import {
formatCurrency
} from "@/components/billingComp/utils";
import Button from "@/components/ui/Button";
import CopyPaymentLinkButton from "@/components/billingComp/CopyPaymentLinkButton";
import { hasOpenPaymentLink } from "./invoiceDetailHelpers";
import Tooltip from "@/components/ui/Tooltip";
import type useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import type { Invoice } from "@/types";
import dayjs from "dayjs";
import {
Calendar,
ChevronRight,
CreditCard,
Eye,
Info,
Landmark,
Undo2,
Wallet
} from "lucide-react";

type Detail = Omit<ReturnType<typeof useInvoiceDetailController>, "invoice"> & { invoice: Invoice };

export default function InvoiceDetailSummary({ detail }: { detail: Detail }) {
  const { lawFirmId, navigate, canManageInvoices, canRecordPayments, readOnlyInvoice, invoice, updatingPayment, viewingReceiptIdx, stripeStatus, retryStripeStatus, canManageFirmSettings, setShowPaymentPlanModal, setPlanError, setPlanInstallment, setPlanStartDate, setPlanInstallmentMode, setPlanPaymentCount, clientTrustBalance, trustAccounts, selectedTrustAccountId, openRequestPayment, voidingStripePayment, setShowVoidStripeConfirm, setActiveTab, totalAmount, amountPaid, totalWrittenOff, remainingBalance, creditBalance, payments, timeEntries, timeEntriesTotal, flatFeesTotal, expensesTotal, adjustmentsTotal, isPaid, status, taxAmount, subtotalAmount, taxLabel, showStripeSetupCard, openPaymentModal, handleViewPaymentReceipt } = detail;
  const linkOpen = hasOpenPaymentLink(invoice);
  // Stripe controls hold their slot while the status is being read, and only a
  // ready account can take a new request or cancel an open one. Copying an
  // open link needs nothing from Stripe.
  const stripeUsable = stripeStatus === "loading" || stripeStatus === "ready";
  const showTrustRow =
    canRecordPayments && !!clientTrustBalance && clientTrustBalance.totalBalanceCents > 0;
  const showPlanButton = canManageInvoices && !invoice.paymentPlan?.enabled;
  const showRequestSlot = canRecordPayments && stripeUsable && !invoice.stripePaymentRequested;
  const showCopyLink = canRecordPayments && linkOpen && !!invoice.paymentLinkUrl;
  const showCancelSlot = canRecordPayments && stripeUsable && linkOpen;
  // Only when a Stripe control would otherwise be offered here.
  const showStripeError =
    canRecordPayments && stripeStatus === "error" && (!invoice.stripePaymentRequested || linkOpen);
  const hasPaymentOptions =
    showTrustRow || showPlanButton || showRequestSlot || showCopyLink || showCancelSlot || showStripeError;
  const setupNeeded = stripeStatus === "needs_setup";
  return (<div className="space-y-5 md:space-y-4 lg:sticky lg:top-6 self-start">
              {/* Summary Card */}
              <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-on-surface mb-3">
                  Summary
                </h2>
                <div className="space-y-3">
                  {timeEntries.length > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Time Entries</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(timeEntriesTotal)}
                      </span>
                    </div>
                  )}
                  {flatFeesTotal > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Flat Fees</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(flatFeesTotal)}
                      </span>
                    </div>
                  )}
                  {expensesTotal > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Expenses</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(expensesTotal)}
                      </span>
                    </div>
                  )}
                  {adjustmentsTotal !== 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Adjustments</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(adjustmentsTotal)}
                      </span>
                    </div>
                  )}
                  {taxAmount > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm pt-2 border-t border-outline-subtle">
                      <span className="text-on-surface-secondary">Subtotal</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(subtotalAmount)}
                      </span>
                    </div>
                  )}
                  {taxAmount > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">{taxLabel}</span>
                      <span className="text-on-surface font-medium">
                        {formatCurrency(taxAmount)}
                      </span>
                    </div>
                  )}
                  <div className={`flex items-baseline justify-between gap-3 text-sm ${taxAmount > 0 ? "" : "pt-2 border-t border-outline-subtle"}`}>
                    <span className="text-on-surface font-medium">Total</span>
                    <span className="text-on-surface font-semibold">
                      {formatCurrency(totalAmount)}
                    </span>
                  </div>
                  {totalWrittenOff > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Credits / Adjustments</span>
                      <span className="text-red-600 dark:text-red-400 font-medium">
                        -{formatCurrency(totalWrittenOff)}
                      </span>
                    </div>
                  )}
                  {amountPaid > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-on-surface-secondary">Paid</span>
                      <span className="text-green-700 dark:text-green-400 font-medium">
                        {formatCurrency(amountPaid)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline pt-3 border-t-2 border-outline">
                    <span className="text-sm text-on-surface font-bold">
                      {creditBalance > 0 ? "Credit Due" : "Remaining Balance"}
                    </span>
                    <span
                      className={`text-lg font-bold ${
                        creditBalance > 0
                          ? "text-amber-600 dark:text-amber-400"
                          : remainingBalance > 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-green-700 dark:text-green-400"
                      }`}
                    >
                      {formatCurrency(creditBalance > 0 ? creditBalance : remainingBalance)}
                    </span>
                  </div>
                </div>

              </div>

              {showStripeSetupCard && (
                <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-accent-emphasis dark:bg-blue-500/10 dark:text-accent-emphasis">
                      <Info className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold text-on-surface">
                        Online Payments
                      </h2>
                      <p className="mt-2 text-sm text-on-surface-secondary leading-relaxed">
                        {canManageFirmSettings
                          ? setupNeeded
                            ? "Finish setting up Stripe to request online payments."
                            : "Connect Stripe to request online payments from clients on this invoice."
                          : setupNeeded
                            ? "Ask a firm admin to finish setting up Stripe to request online payments."
                            : "Ask a firm admin to connect Stripe to request online payments."}
                      </p>
                      {canManageFirmSettings && (
                        <Button
                          onClick={() => navigate(`/lawfirm/${lawFirmId}/settings/payments`)}
                          type="secondary"
                          size="small"
                          className="mt-3 w-full"
                          icon={<CreditCard className="w-4 h-4" />}
                        >
                          Open Payment Settings
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Ways this invoice can be settled: trust, an instalment plan, or an online request */}
              {!isPaid && !readOnlyInvoice && hasPaymentOptions && (
              <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-on-surface mb-3">
                  Payment Options
                </h2>
                <div className="space-y-2">
                  {/* Trust balance: opens Record Payment with trust preselected. Shown
                      against the account that will actually be preselected there (not
                      the sum across every trust account), so this promise matches what
                      the payment form validates against. */}
                  {showTrustRow && clientTrustBalance && (() => {
                    const selectedAcctBal = clientTrustBalance.accountBalances.find(
                      (b) => b.trustAccountId === selectedTrustAccountId
                    );
                    const availableCents = selectedAcctBal
                      ? selectedAcctBal.balanceCents
                      : clientTrustBalance.totalBalanceCents;
                    const coversBalance = availableCents >= Math.round(remainingBalance * 100);
                    return (
                      <button
                        onClick={() => openPaymentModal(true)}
                        // `rounded-md` and the same `px-3` as the buttons below:
                        // this row is the first option in a stack of them, so a
                        // softer corner made it read as a different kind of thing.
                        // Its own `mb-1` is gone too, which put 12px under this row
                        // where every other gap in the card is 8px.
                        //
                        // The hover tint has to clear `accent-soft` in BOTH themes
                        // (10% light, 15% dark). It used to repaint its own
                        // background colour, so the row answered a hover with
                        // nothing at all.
                        className="cursor-pointer w-full text-left flex items-center justify-between gap-2 rounded-md bg-accent-soft border border-accent-border-soft hover:bg-accent-solid/20 transition-colors px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Landmark size={13} className="text-accent-emphasis shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-accent-emphasis leading-tight">
                              Pay from Trust
                            </p>
                            <p className="text-xs text-accent-emphasis leading-tight mt-0.5">
                              {formatCurrency(availableCents / 100)} available
                              {trustAccounts.length > 1 ? " in selected account" : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {coversBalance && (
                            <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                              Covers balance
                            </span>
                          )}
                          <ChevronRight size={14} className="text-accent-emphasis" />
                        </div>
                      </button>
                    );
                  })()}
                  {!isPaid && (
                    <>
                      {showPlanButton && (
                        <Button
                          onClick={() => {
                            setPlanInstallment("");
                            setPlanPaymentCount("");
                            setPlanInstallmentMode("amount");
                            setPlanStartDate(dayjs().add(7, "day").format("YYYY-MM-DD"));
                            setPlanError(null);
                            setShowPaymentPlanModal(true);
                          }}
                          type="secondary"
                          size="small"
                          className="w-full"
                          disabled={updatingPayment}
                          icon={<Calendar className="w-4 h-4" />}
                        >
                          Setup Payment Plan
                        </Button>
                      )}

                      {/* While Stripe is checked the button is already in place,
                          busy, so nothing appears or shifts when the answer lands. */}
                      {showRequestSlot && (stripeStatus === "loading" || stripeStatus === "ready") && (
                        <Button
                          onClick={() => openRequestPayment(null)}
                          type="secondary"
                          size="small"
                          className="w-full"
                          loading={stripeStatus === "loading"}
                          icon={<CreditCard className="w-4 h-4" />}
                        >
                          Request Payment via Stripe
                        </Button>
                      )}

                      {/* Copy: the open request's link, to text or message it */}
                      {showCopyLink && invoice.paymentLinkUrl && (
                        <CopyPaymentLinkButton url={invoice.paymentLinkUrl} />
                      )}

                      {/* Cancel: ends the open payment link */}
                      {showCancelSlot && (stripeStatus === "loading" || stripeStatus === "ready") && (
                        <Button
                          onClick={() => setShowVoidStripeConfirm(true)}
                          type="secondary"
                          size="small"
                          className="w-full border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                          disabled={voidingStripePayment}
                          loading={stripeStatus === "loading"}
                          icon={<Undo2 className="w-4 h-4" />}
                        >
                          {voidingStripePayment ? "Cancelling..." : "Cancel Payment Link"}
                        </Button>
                      )}

                      {showStripeError && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-on-surface-muted">Couldn&apos;t check Stripe.</span>
                          <button
                            type="button"
                            onClick={retryStripeStatus}
                            className="cursor-pointer text-xs font-medium text-accent-emphasis hover:underline"
                          >
                            Try again
                          </button>
                        </div>
                      )}

                    </>
                  )}
                </div>
              </div>
              )}

              {/* Recent payments: visible without opening the Payments tab */}
              {payments.length > 0 && (
                <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-on-surface">
                      Recent Payments
                    </h2>
                    <button
                      onClick={() => setActiveTab("payments")}
                      className="cursor-pointer text-xs font-medium text-accent-emphasis hover:underline"
                    >
                      View all
                    </button>
                  </div>
                  <div className="divide-y divide-outline-subtle">
                    {payments
                      .map((payment, idx) => ({ payment, idx }))
                      .slice(-3)
                      .reverse()
                      .map(({ payment, idx }) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="h-7 w-7 rounded-full bg-green-50 dark:bg-green-500/10 flex items-center justify-center shrink-0">
                              {payment.paymentSource === "trust" ? (
                                <Landmark size={13} className="text-green-600 dark:text-green-400" />
                              ) : payment.paymentSource === "stripe" ||
                                payment.stripePaymentIntentId ||
                                payment.stripeSessionId ? (
                                <CreditCard size={13} className="text-green-600 dark:text-green-400" />
                              ) : (
                                <Wallet size={13} className="text-green-600 dark:text-green-400" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-on-surface">
                                {formatCurrency(payment.amount)}
                              </p>
                              <p className="text-[11px] text-on-surface-muted truncate">
                                {dayjs(payment.date).format("MMM DD, YYYY")}
                                {payment.paymentSource === "trust"
                                  ? " · Trust"
                                  : payment.paymentSource === "stripe" ||
                                      payment.stripePaymentIntentId ||
                                      payment.stripeSessionId
                                    ? " · Stripe"
                                    : ""}
                              </p>
                            </div>
                          </div>
                          <Tooltip title="View receipt" enterDelay={300}>
                            <span>
                              <button aria-label="View receipt"
                                onClick={() => handleViewPaymentReceipt(payment, idx)}
                                disabled={viewingReceiptIdx === idx}
                                className="cursor-pointer p-1.5 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50"
                              >
                                <Eye size={13} />
                              </button>
                            </span>
                          </Tooltip>
                        </div>
                      ))}
                  </div>
                </div>
              )}

            </div>);
}
