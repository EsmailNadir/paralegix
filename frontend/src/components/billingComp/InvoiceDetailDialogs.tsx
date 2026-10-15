"use client";

import { useId } from "react";
import ErrorNotification from "@/components/ErrorNotification";
import CreditNoteModal from "@/components/billingComp/CreditNoteModal";
import EditPaymentModal from "@/components/billingComp/EditPaymentModal";
import OrgAccessModal from "@/components/billingComp/OrgAccessModal";
import PaymentPlanFields, { installmentRowLimitMessage } from "@/components/billingComp/PaymentPlanFields";
import RecordPaymentModal from "@/components/billingComp/RecordPaymentModal";
import { formatCurrency, getInvoiceDisplayName } from "@/components/billingComp/utils";
import ActionIconButton from "@/components/ui/ActionIconButton";
import BusyToast from "@/components/ui/BusyToast";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import FieldLabel from "@/components/ui/FieldLabel";
import Modal from "@/components/ui/Modal";
import StatusBadge from "@/components/ui/StatusBadge";
import RequestPaymentDialog from "@/components/billingComp/RequestPaymentDialog";
import Tooltip from "@/components/ui/Tooltip";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import { addPaymentPlanPeriod, hasOpenPaymentLink, isInstallmentLocked } from "./invoiceDetailHelpers";
import type useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import { MONEY_DECIMALS_MESSAGE } from "@/lib/utils/currency";
import type { Invoice } from "@/types";
import dayjs from "dayjs";
import { AlertTriangle, Calendar, CheckCircle2, ChevronRight, Download, ExternalLink, Landmark, Mail, Minus, Plus, Send, Trash2, X } from "lucide-react";

type Detail = Omit<ReturnType<typeof useInvoiceDetailController>, "invoice"> & { invoice: Invoice };

export default function InvoiceDetailDialogs({ detail }: { detail: Detail }) {
  const { lawFirmId, entityId, contextType, fieldIds, sendInvoiceTitleId, addAmountTitleId, creditNoteTitleId, paymentPlanTitleId, installmentTitleId, editPlanTitleId, navigate, invoice, loading, client, updatingPayment, generatingPDF, exportingLedes, refreshingRecipients, showSendInvoiceModal, sendingInvoiceToPortal, sendInvoiceError, sendInvoiceSuccess, sendingEmail, emailRecipient, setEmailRecipient, previewPdfUrl, previewReceiptPdfUrl, previewReceiptDownloadName, showPaymentModal, setShowPaymentModal, paymentAmount, setPaymentAmount, paymentAmountError, setPaymentAmountError, paymentError, paymentNote, setPaymentNote, paymentInvoiceNumber, setPaymentInvoiceNumber, nextPaymentDate, setNextPaymentDate, paymentInstallmentIndex, setPaymentInstallmentIndex, allowOverpayment, setAllowOverpayment, editingPayment, setEditingPayment, editPaymentOpen, setEditPaymentOpen, editPaymentError, setEditPaymentError, deletePaymentConfirm, setDeletePaymentConfirm, deletePaymentError, showCreditNoteModal, setShowCreditNoteModal, creditNoteAmount, setCreditNoteAmount, creditNoteDescription, setCreditNoteDescription, creditNoteType, setCreditNoteType, creditNoteError, showAddAmountModal, setShowAddAmountModal, addAmountValue, setAddAmountValue, addAmountNote, setAddAmountNote, addAmountError, showPaymentPlanModal, setShowPaymentPlanModal, planError, planInstallment, setPlanFrequencyCustom, setPlanDownPayment, setPlanDownPaymentPaid, planInstallmentMode, setPlanInstallmentMode, planPaymentCount, setPlanPaymentCount, planValues, applyPlanPatch, payingInstallment, installmentPayAmount, setInstallmentPayAmount, installmentAmountError, setInstallmentAmountError, installmentError, shortfallAction, setShortfallAction, installmentModalTab, setInstallmentModalTab, installmentPaymentInvoiceNumber, setInstallmentPaymentInvoiceNumber, installmentPaymentNote, setInstallmentPaymentNote, installmentPayFromTrust, setInstallmentPayFromTrust, installmentDelayMode, setInstallmentDelayMode, installmentDelayCustomDate, setInstallmentDelayCustomDate, showOrgAccessModal, setShowOrgAccessModal, planEditing, draftInstallments, draftFrequency, setDraftFrequency, draftFreqIsCustom, setDraftFreqIsCustom, savingSchedule, dateShiftPrompt, setDateShiftPrompt, clientTrustBalance, trustAccounts, selectedTrustAccountId, setSelectedTrustAccountId, payFromTrust, setPayFromTrust, showStripeConfirm, setShowStripeConfirm, requestInstallmentId, showVoidStripeConfirm, setShowVoidStripeConfirm, showRemovePlanConfirm, setShowRemovePlanConfirm, showDeleteConfirm, setShowDeleteConfirm, showVoidConfirm, setShowVoidConfirm, voidingInvoice, deletingInvoice, shownReceiptPdfUrl, shownInvoicePdfUrl, activeInstallment, lineEditor, totalAmount, amountPaid, totalWrittenOff, remainingBalance, payments, expenses, status, orgClientId, orgClientName, canSendInvoiceToPortal, portalSendHelperText, closeSendInvoiceModal, handleSendInvoiceByEmail, handleRecordPayment, handleEditPayment, handleDeletePayment, handleAddCreditNote, handleAddAmount, handleSetPaymentPlan, handleRemovePaymentPlan, closeInstallmentModal, handleRescheduleInstallment, handlePayInstallment, draftAtRowLimit, draftTarget, draftScheduledTotal, draftMismatchCents, cancelPlanEdit, setDraftAmount, setDraftDate, deleteDraftRow, addDraftRow, applyDateShift, distributeDraftEvenly, distributeRemainingDraft, addShortfallToNextInstallment, addShortfallAsNewInstallment, trimOverageFromEnd, savePlanSchedule, handleVoidStripePayment, handleDeleteInvoice, handleVoidInvoice, downloadInvoicePdf, closePreviewPdf, closePreviewReceiptPdf, handleSendInvoiceToPortal } = detail;
  const receiptPreviewTitleId = useId();
  const invoicePreviewTitleId = useId();
  return <>
        {/* Send Invoice Modal */}
        {invoice && (
          <Modal
            isOpen={showSendInvoiceModal}
            onClose={closeSendInvoiceModal}
            labelledBy={sendInvoiceTitleId}
            size="md"
            showClose={false}
            bodyClassName={null}
            className="rounded-xl border border-outline"
          >
              <div className="p-6">
                <h2 id={sendInvoiceTitleId} className="text-lg font-semibold text-on-surface mb-1">
                  Send Invoice
                </h2>
                <p className="text-sm text-on-surface-secondary mb-5">
                  {invoice.invoiceNumber || invoice.invoiceName}
                </p>

                {sendInvoiceError && (
                  <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                    {sendInvoiceError}
                  </div>
                )}

                {sendInvoiceSuccess && (
                  <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
                    {sendInvoiceSuccess}
                  </div>
                )}

                <div className="space-y-3">
                  {/* Send via Email */}
                  <div className="rounded-xl border border-outline px-4 py-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-accent-soft dark:bg-accent-soft p-2">
                        <Mail className="w-4 h-4 text-accent-emphasis" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-on-surface">Send via Email</p>
                        <p className="text-xs text-on-surface-secondary mt-1 mb-3">
                          Email the invoice as a PDF attachment.
                        </p>
                        <FieldLabel>Email *</FieldLabel>
                        <div className="flex gap-2">
                          <input
                            type="email"
                            value={emailRecipient}
                            onChange={(e) => setEmailRecipient(e.target.value)}
                            placeholder="client@email.com"
                            className="flex-1 min-w-0 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          />
                          <button
                            type="button"
                            onClick={handleSendInvoiceByEmail}
                            disabled={!emailRecipient.trim() || sendingEmail || generatingPDF}
                            className="shrink-0 rounded-md bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground px-3 py-1.5 text-sm font-medium transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {sendingEmail ? "Sending..." : "Send"}
                          </button>
                        </div>
                        {invoice?.clientEmail && emailRecipient.trim().toLowerCase() !== invoice.clientEmail.toLowerCase() && (
                          <p className="text-xs text-on-surface-muted mt-1">
                            Also sent to the client's own email, {invoice.clientEmail}.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Send via Client Portal */}
                  <button
                    type="button"
                    onClick={canSendInvoiceToPortal ? handleSendInvoiceToPortal : undefined}
                    disabled={!canSendInvoiceToPortal || generatingPDF || sendingInvoiceToPortal}
                    className={`w-full rounded-xl border px-4 py-4 text-left transition-colors ${
                      canSendInvoiceToPortal
                        ? "border-outline hover:bg-surface-hover"
                        : "border-outline-subtle"
                    } disabled:opacity-70`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`rounded-lg p-2 ${canSendInvoiceToPortal ? "bg-blue-50 dark:bg-blue-500/10" : "bg-surface-alt"}`}>
                        <Send className={`w-4 h-4 ${canSendInvoiceToPortal ? "text-accent-emphasis" : "text-on-surface-muted"}`} />
                      </div>
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${canSendInvoiceToPortal ? "text-on-surface" : "text-on-surface-muted"}`}>
                          {sendingInvoiceToPortal ? "Sending to client portal..." : "Send via Client Portal"}
                        </p>
                        <p className={`text-xs mt-1 ${canSendInvoiceToPortal ? "text-on-surface-secondary" : "text-on-surface-muted"}`}>
                          {portalSendHelperText}
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Set up portal access link when client is not in portal */}
                  {!canSendInvoiceToPortal && (contextType === "client" || invoice?.clientId) && (
                    <button
                      type="button"
                      onClick={() => {
                        closeSendInvoiceModal();
                        const clientDetailId = contextType === "client" ? entityId : invoice?.clientId;
                        if (clientDetailId) {
                          navigate(`/lawfirm/${lawFirmId}/clients/${clientDetailId}`);
                        }
                      }}
                      className="w-full flex items-center justify-center gap-2 text-xs text-accent-emphasis hover:underline cursor-pointer py-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Set up portal access for this client
                    </button>
                  )}

                  {/* Download */}
                  <button
                    type="button"
                    onClick={downloadInvoicePdf}
                    disabled={generatingPDF || sendingInvoiceToPortal}
                    className="w-full rounded-xl border border-outline px-4 py-4 text-left transition-colors hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-surface-alt p-2">
                        <Download className="w-4 h-4 text-on-surface" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-on-surface">
                          {generatingPDF && !sendingInvoiceToPortal && !sendingEmail
                            ? "Preparing download..."
                            : "Download Invoice"}
                        </p>
                        <p className="text-xs text-on-surface-secondary mt-1">
                          Save a PDF copy of this invoice to your device.
                        </p>
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              <div className="border-t border-outline px-6 py-4 flex justify-end">
                <Button
                  onClick={closeSendInvoiceModal}
                  type="secondary"
                  size="small"
                >
                  Close
                </Button>
              </div>
          </Modal>
        )}

        {/* Record Payment Modal */}
        {invoice && (
          <RecordPaymentModal
            open={showPaymentModal}
            onClose={() => { setShowPaymentModal(false); setPaymentInvoiceNumber(""); setPaymentNote(""); }}
            invoiceLabel={getInvoiceDisplayName(invoice)}
            totalAmount={totalAmount}
            amountPaid={amountPaid}
            remainingBalance={remainingBalance}
            amount={paymentAmount}
            onAmountChange={(value) => { setPaymentAmount(value); setPaymentAmountError(null); }}
            amountError={paymentAmountError}
            error={paymentError}
            allowOverpayment={allowOverpayment}
            onAllowOverpaymentChange={setAllowOverpayment}
            note={paymentNote}
            onNoteChange={setPaymentNote}
            invoiceNumber={paymentInvoiceNumber}
            onInvoiceNumberChange={setPaymentInvoiceNumber}
            nextPaymentDate={nextPaymentDate}
            onNextPaymentDateChange={setNextPaymentDate}
            installments={(invoice.paymentPlan?.expectedPayments || [])
              .map((ep, index) => ({ ep, index }))
              .filter(({ ep }) => ep.status === "pending" || ep.status === "overdue")
              .map(({ ep, index }) => ({ index, dueDate: ep.dueDate, amount: ep.amount }))}
            selectedInstallmentIndex={paymentInstallmentIndex}
            onSelectedInstallmentChange={setPaymentInstallmentIndex}
            submitting={updatingPayment}
            onSubmit={handleRecordPayment}
            extraFields={
              clientTrustBalance && clientTrustBalance.totalBalanceCents > 0 && trustAccounts.length > 0 ? (
                <div className="rounded-lg border border-outline-subtle bg-surface-alt p-3 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={payFromTrust} onChange={setPayFromTrust} />
                    <span className="text-sm font-medium text-on-surface flex items-center gap-1.5">
                      <Landmark size={14} className="text-accent-emphasis" />
                      Pay from trust account
                    </span>
                    <span className="text-xs text-on-surface-muted ml-auto">
                      {formatCurrency(
                        (clientTrustBalance.accountBalances.find(
                          (b) => b.trustAccountId === selectedTrustAccountId
                        )?.balanceCents ?? clientTrustBalance.totalBalanceCents) / 100
                      )}{" "}
                      available
                    </span>
                  </label>
                  {payFromTrust && (
                    <div>
                      <label id={`${fieldIds}-trust-account-label`} className="block text-xs text-on-surface-secondary mb-1">Trust Account *</label>
                      <Dropdown
                        ariaLabelledBy={`${fieldIds}-trust-account-label`}
                        value={selectedTrustAccountId}
                        onChange={setSelectedTrustAccountId}
                        options={trustAccounts.map((acct) => {
                          const acctBal = clientTrustBalance.accountBalances.find(
                            (b) => b.trustAccountId === acct.id
                          );
                          return {
                            value: acct.id,
                            label: `${acct.name}: ${formatCurrency((acctBal?.balanceCents ?? 0) / 100)}`,
                          };
                        })}
                        buttonClassName="w-full px-2 py-1.5 text-sm bg-input-bg border-input-border rounded-lg"
                        portal
                      />
                    </div>
                  )}
                </div>
              ) : undefined
            }
          />
        )}

        {/* Add Amount Modal */}
        {invoice && (
          <Modal
            isOpen={showAddAmountModal}
            onClose={() => setShowAddAmountModal(false)}
            labelledBy={addAmountTitleId}
            size="md"
            showClose={false}
            bodyClassName={null}
            className="rounded-xl border border-outline"
          >
              <div className="p-6">
                <h2 id={addAmountTitleId} className="text-lg font-semibold text-on-surface mb-1">
                  Add Amount to Invoice
                </h2>
                <p className="text-sm text-on-surface-secondary mb-6">
                  Invoice: {invoice.invoiceName}, Current total:{" "}
                  {formatCurrency(invoice.totalAmount ?? 0)}
                </p>
                <div className="space-y-4">
                  <ErrorNotification error={addAmountError} compact />
                  <div>
                    <FieldLabel htmlFor={`${fieldIds}-addamountvalue`}>
                      Amount to Add *
                    </FieldLabel>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">
                        $
                      </span>
                      <input
                        id={`${fieldIds}-addamountvalue`}
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={addAmountValue}
                        onChange={(e) => setAddAmountValue(e.target.value)}
                        className={`${INPUT_CLS} w-full pl-7`}
                        placeholder="0.00"
                        autoFocus
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel htmlFor={`${fieldIds}-addamountnote`}>
                      Note
                    </FieldLabel>
                    <input
                      id={`${fieldIds}-addamountnote`}
                      type="text"
                      value={addAmountNote}
                      onChange={(e) => setAddAmountNote(e.target.value)}
                      className={`${INPUT_CLS} w-full`}
                      placeholder="e.g. Additional services, scope change"
                    />
                  </div>
                </div>
              </div>
              <div className="border-t border-outline px-6 py-4 flex justify-end gap-3">
                <Button
                  onClick={() => setShowAddAmountModal(false)}
                  type="secondary"
                  size="small"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAddAmount}
                  type="primary"
                  size="small"
                  disabled={updatingPayment || !(parseFloat(addAmountValue) > 0)}
                >
                  {updatingPayment ? "Adding..." : "Add Amount"}
                </Button>
              </div>
          </Modal>
        )}

        {/* Credit Note Modal */}
        {invoice && (
          <CreditNoteModal open={showCreditNoteModal} onClose={() => setShowCreditNoteModal(false)}
            presentation="detail" titleId={creditNoteTitleId} saving={updatingPayment} onSave={handleAddCreditNote} error={creditNoteError}
            invoiceName={invoice.invoiceName} remaining={formatCurrency(remainingBalance)}
            type={creditNoteType} onTypeChange={setCreditNoteType}
            amount={creditNoteAmount} onAmountChange={setCreditNoteAmount}
            description={creditNoteDescription} onDescriptionChange={setCreditNoteDescription} />
        )}

        {/* Payment Plan Modal */}
        {invoice && (
          <Modal
            isOpen={showPaymentPlanModal}
            onClose={() => {
              setShowPaymentPlanModal(false);
              setPlanDownPayment("");
              setPlanDownPaymentPaid(false);
              setPlanFrequencyCustom("");
              setPlanPaymentCount("");
              setPlanInstallmentMode("amount");
            }}
            labelledBy={paymentPlanTitleId}
            size="xl"
            showClose={false}
            bodyClassName={null}
            className="rounded-2xl border border-outline overflow-hidden shadow-2xl"
          >
              {/* Header */}
              <div className="border-b border-outline-subtle bg-gradient-to-br from-surface-alt/80 to-surface-alt/30 px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-emphasis">
                      <Calendar className="h-[18px] w-[18px]" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <h2 id={paymentPlanTitleId} className="text-base font-semibold tracking-tight text-on-surface truncate">
                        Set up payment plan
                      </h2>
                      {invoice.invoiceName && (
                        <p className="text-xs text-on-surface-secondary truncate">
                          {invoice.invoiceName}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-on-surface-muted">
                      Remaining Balance
                    </p>
                    <p className="text-base font-semibold tabular-nums text-on-surface">
                      {formatCurrency(remainingBalance)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Form Body */}
              <div className="px-6 py-5 max-h-[min(68vh,560px)] overflow-y-auto overflow-x-hidden styled-scrollbar">
                <ErrorNotification error={planError} compact className="mb-4" />
                <PaymentPlanFields
                  values={planValues}
                  onChange={applyPlanPatch}
                  balance={remainingBalance}
                  radioName="planInstallmentMode"
                  portalDropdown
                />
              </div>
              <div className="flex justify-end gap-3 border-t border-outline-subtle bg-surface-alt/40 px-6 py-4">
                <Button
                  onClick={() => {
                    setShowPaymentPlanModal(false);
                    setPlanDownPayment("");
                    setPlanDownPaymentPaid(false);
                    setPlanFrequencyCustom("");
                    setPlanPaymentCount("");
                    setPlanInstallmentMode("amount");
                  }}
                  type="secondary"
                  size="small"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSetPaymentPlan}
                  type="primary"
                  size="small"
                  disabled={
                    updatingPayment ||
                    (planInstallmentMode === "amount"
                      ? !(parseFloat(planInstallment) > 0)
                      : !(parseInt(planPaymentCount, 10) > 0))
                  }
                >
                  {updatingPayment ? "Setting Up..." : "Create Payment Plan"}
                </Button>
              </div>
          </Modal>
        )}

        {/* Installment Payment Modal */}
        {activeInstallment && invoice && (
          <Modal
            isOpen={!!payingInstallment}
            onClose={closeInstallmentModal}
            labelledBy={installmentTitleId}
            size="md"
            showClose={false}
            bodyClassName={null}
            className="rounded-xl border border-outline"
          >
              <div className="p-6 overflow-y-auto overflow-x-hidden styled-scrollbar space-y-4">
                <div>
                  <h2 id={installmentTitleId} className="text-lg font-semibold text-on-surface mb-1">
                    {installmentModalTab === "record" ? "Record Installment Payment" : "Reschedule Installment"}
                  </h2>
                  <p className="text-sm text-on-surface-secondary">
                    Installment #{activeInstallment.index + 1} - Due: {formatCurrency(activeInstallment.amount)}
                    {invoice.paymentPlan?.expectedPayments?.[activeInstallment.index]?.dueDate && (
                      <>
                        {" "}
                        - {dayjs(
                          invoice.paymentPlan.expectedPayments[activeInstallment.index].dueDate
                        ).format("MMM D, YYYY")}
                      </>
                    )}
                  </p>
                </div>

                <ErrorNotification error={installmentError} compact />

                <div className="flex rounded-lg border border-outline p-0.5 bg-surface-alt/50">
                  <button
                    type="button"
                    onClick={() => setInstallmentModalTab("record")}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      installmentModalTab === "record"
                        ? "bg-surface text-on-surface shadow-sm"
                        : "text-on-surface-secondary hover:text-on-surface"
                    }`}
                  >
                    Record payment
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstallmentModalTab("reschedule")}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      installmentModalTab === "reschedule"
                        ? "bg-surface text-on-surface shadow-sm"
                        : "text-on-surface-secondary hover:text-on-surface"
                    }`}
                  >
                    Reschedule
                  </button>
                </div>

                {installmentModalTab === "reschedule" ? (
                  <div className="space-y-4">
                    <p className="text-sm text-on-surface-secondary">
                      Move this installment&apos;s due date without recording a payment. Use this when the client needs
                      more time.
                    </p>
                    {(() => {
                      const ep = invoice.paymentPlan?.expectedPayments?.[activeInstallment.index];
                      const freq = invoice.paymentPlan?.frequencyDays ?? 30;
                      const pushed = ep ? addPaymentPlanPeriod(ep.dueDate, freq) : "";
                      return (
                        <div className="space-y-3">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="installmentDelayMode"
                              checked={installmentDelayMode === "next_period"}
                              onChange={() => setInstallmentDelayMode("next_period")}
                              className="mt-1 accent-blue-600"
                            />
                            <span className="text-sm text-on-surface">
                              <span className="font-medium">Next period</span>
                              <span className="block text-on-surface-secondary text-xs mt-0.5">
                                {ep
                                  ? `New due date: ${dayjs(pushed).format("MMM D, YYYY")} (${freq === 30 ? "1 month" : `${freq} days`} after current due date)`
                                  : "-"}
                              </span>
                            </span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="installmentDelayMode"
                              checked={installmentDelayMode === "custom"}
                              onChange={() => setInstallmentDelayMode("custom")}
                              className="mt-1 accent-blue-600"
                            />
                            <span className="text-sm text-on-surface font-medium">Pick a date</span>
                          </label>
                          {installmentDelayMode === "custom" && (
                            <DatePicker
                              value={installmentDelayCustomDate}
                              onChange={setInstallmentDelayCustomDate}
                            />
                          )}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <FieldLabel htmlFor={`${fieldIds}-installmentpayamount`}>Payment Amount *</FieldLabel>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">$</span>
                        <input
                          id={`${fieldIds}-installmentpayamount`}
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={installmentPayAmount}
                          onChange={(e) => { setInstallmentPayAmount(e.target.value); setInstallmentAmountError(null); }}
                          className={`${INPUT_CLS} w-full pl-7`}
                          autoFocus
                        />
                      </div>
                      <FieldError message={installmentAmountError} />
                    </div>
                    {/* Shortfall options: only show if paying less */}
                    {(() => {
                      const payAmt = parseFloat(installmentPayAmount);
                      const shortfall =
                        !isNaN(payAmt) && payAmt > 0 && payAmt < activeInstallment.amount
                          ? Math.round((activeInstallment.amount - payAmt) * 100) / 100
                          : 0;
                      if (shortfall <= 0) return null;
                      const hasNextInstallment = (invoice?.paymentPlan?.expectedPayments || []).some(
                        (ep, i) => i > activeInstallment.index && (ep.status === "pending" || ep.status === "overdue")
                      );
                      const opts: { value: "write_off" | "add_to_next" | "add_to_current"; label: string }[] = [
                        { value: "write_off", label: `Write off ${formatCurrency(shortfall)}` },
                        {
                          value: "add_to_next",
                          label: hasNextInstallment
                            ? `Add ${formatCurrency(shortfall)} to next installment`
                            : `Create next installment for ${formatCurrency(shortfall)}`,
                        },
                        { value: "add_to_current", label: `Add ${formatCurrency(shortfall)} to current installment` },
                      ];
                      return (
                        <div className="bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800 rounded-lg p-3 space-y-2">
                          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                            Shortfall: {formatCurrency(shortfall)}
                          </p>
                          <div className="space-y-1.5">
                            {opts.map((opt) => (
                              <label
                                key={opt.value}
                                className="flex items-center gap-2 text-xs text-on-surface cursor-pointer"
                              >
                                <input
                                  type="radio"
                                  name="shortfallAction"
                                  value={opt.value}
                                  checked={shortfallAction === opt.value}
                                  onChange={() => setShortfallAction(opt.value)}
                                  className="accent-blue-600"
                                />
                                {opt.label}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    <div>
                      <FieldLabel htmlFor={`${fieldIds}-installmentpaymentinvoicenumber`}>
                        Invoice Number
                      </FieldLabel>
                      <input
                        id={`${fieldIds}-installmentpaymentinvoicenumber`}
                        type="text"
                        value={installmentPaymentInvoiceNumber}
                        onChange={(e) => setInstallmentPaymentInvoiceNumber(e.target.value)}
                        className={`${INPUT_CLS} w-full`}
                        placeholder="e.g. INV-001"
                      />
                    </div>

                    <div>
                      <FieldLabel htmlFor={`${fieldIds}-installmentpaymentnote`}>
                        Note
                      </FieldLabel>
                      <input
                        id={`${fieldIds}-installmentpaymentnote`}
                        type="text"
                        value={installmentPaymentNote}
                        onChange={(e) => setInstallmentPaymentNote(e.target.value)}
                        className={`${INPUT_CLS} w-full`}
                        placeholder="e.g. Check #1234, Wire transfer, etc."
                      />
                    </div>

                    {clientTrustBalance && clientTrustBalance.totalBalanceCents > 0 && trustAccounts.length > 0 && (
                      <div className="rounded-lg border border-outline-subtle bg-surface-alt p-3 space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={installmentPayFromTrust}
                            onChange={setInstallmentPayFromTrust}
                          />
                          <span className="text-sm font-medium text-on-surface flex items-center gap-1.5">
                            <Landmark size={14} className="text-accent-emphasis" />
                            Pay from trust account
                          </span>
                          <span className="text-xs text-on-surface-muted ml-auto">
                            {formatCurrency(clientTrustBalance.totalBalanceCents / 100)} available
                          </span>
                        </label>
                        {installmentPayFromTrust && (
                          <div>
                            <label id={`${fieldIds}-trust-account-2-label`} className="block text-xs text-on-surface-secondary mb-1">Trust Account *</label>
                            <Dropdown
                              ariaLabelledBy={`${fieldIds}-trust-account-2-label`}
                              value={selectedTrustAccountId}
                              onChange={setSelectedTrustAccountId}
                              options={trustAccounts.map((acct) => {
                                const acctBal = clientTrustBalance.accountBalances.find(
                                  (b) => b.trustAccountId === acct.id
                                );
                                return {
                                  value: acct.id,
                                  label: `${acct.name}: ${formatCurrency((acctBal?.balanceCents ?? 0) / 100)}`,
                                };
                              })}
                              buttonClassName="w-full px-2 py-1.5 text-sm bg-input-bg border-input-border rounded-lg"
                              portal
                            />
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                )}
              </div>
              <div className="border-t border-outline px-6 py-4 flex justify-end gap-3 shrink-0">
                <Button onClick={closeInstallmentModal} type="secondary" size="small">
                  Cancel
                </Button>
                {installmentModalTab === "reschedule" ? (
                  <Button
                    onClick={handleRescheduleInstallment}
                    type="primary"
                    size="small"
                    disabled={
                      updatingPayment ||
                      (installmentDelayMode === "custom" && !installmentDelayCustomDate.trim())
                    }
                  >
                    {updatingPayment ? "Saving..." : "Reschedule"}
                  </Button>
                ) : (
                  <Button
                    onClick={handlePayInstallment}
                    type="primary"
                    size="small"
                    disabled={updatingPayment || !(parseFloat(installmentPayAmount) > 0)}
                  >
                    {updatingPayment ? "Recording..." : "Record Payment"}
                  </Button>
                )}
              </div>
          </Modal>
        )}

        {/* Edit a recorded payment. Rendered unconditionally so its exit animation
            can play; `editPaymentOpen` drives it rather than `editingPayment`. */}
        <EditPaymentModal
          open={editPaymentOpen}
          payment={editingPayment}
          amountLocked={(() => {
            const p = editingPayment ? payments[editingPayment.index] : null;
            return Boolean(
              p && (p.paymentSource === "stripe" || p.stripePaymentIntentId || p.stripeSessionId)
            );
          })()}
          saving={updatingPayment}
          error={editPaymentError}
          onClearError={() => setEditPaymentError(null)}
          onChange={setEditingPayment}
          onClose={() => setEditPaymentOpen(false)}
          onSave={handleEditPayment}
        />

        {/* Line-item edit that would settle the invoice past its own total. The
            server refuses this once and reports the credit; confirming re-sends the
            same payload with the acknowledgement. */}
        <ConfirmModal
          isOpen={lineEditor.overpayCredit !== null}
          onClose={() => {
            if (!lineEditor.submitting) lineEditor.setOverpayCredit(null);
          }}
          onConfirm={() => lineEditor.submit(true)}
          title="Total is below what has been paid"
          message={`${formatCurrency(amountPaid + totalWrittenOff)} has already been settled against this invoice, and the new total is ${formatCurrency(lineEditor.overpayCredit ?? 0)} less than that. Saving will leave that amount as a credit owed to the client.`}
          confirmText="Save anyway"
          cancelText="Go back"
          confirmType="primary"
          loading={lineEditor.submitting}
        />

        {/* Void Invoice Confirmation */}
        <ConfirmModal
          isOpen={showVoidConfirm}
          onClose={() => {
            if (!voidingInvoice) setShowVoidConfirm(false);
          }}
          onConfirm={handleVoidInvoice}
          title="Void invoice"
          message="This cancels the invoice and its payment link stops working. Its time entries, flat fees and expenses become billable again. This cannot be undone."
          confirmText="Void invoice"
          cancelText="Cancel"
          loading={voidingInvoice}
        />

        {/* Delete Invoice Confirmation */}
        <ConfirmModal
          isOpen={showDeleteConfirm}
          onClose={() => {
            if (!deletingInvoice) setShowDeleteConfirm(false);
          }}
          onConfirm={handleDeleteInvoice}
          title="Delete invoice"
          message="Are you sure you want to delete this invoice? This action cannot be undone."
          confirmText="Delete"
          cancelText="Cancel"
        />

        {/* Delete Payment Confirmation */}
        <ConfirmModal
          isOpen={deletePaymentConfirm !== null}
          onClose={() => setDeletePaymentConfirm(null)}
          onConfirm={handleDeletePayment}
          loading={updatingPayment}
          title="Delete payment"
          message={
            deletePaymentConfirm
              ? `Remove payment of ${formatCurrency(deletePaymentConfirm.amount)} from ${dayjs(deletePaymentConfirm.date).format("MMM DD, YYYY")}? This will update the invoice balance.`
              : ""
          }
          confirmText="Delete Payment"
          cancelText="Cancel"
          extra={deletePaymentError ? <ErrorNotification error={deletePaymentError} compact /> : undefined}
        />

        {/* Request payment: one secure link, emailed or copied */}
        <RequestPaymentDialog
          open={showStripeConfirm}
          onClose={() => setShowStripeConfirm(false)}
          onRequested={() => detail.loadInvoice()}
          billingContext={detail.billingContext}
          invoiceId={invoice?.id}
          paymentPlan={invoice?.paymentPlan}
          initialInstallmentId={requestInstallmentId}
          hasOpenLink={hasOpenPaymentLink(invoice)}
        />

        {/* Cancel the open payment link, from the summary or the plan row it charges */}
        <ConfirmModal
          isOpen={showVoidStripeConfirm}
          onClose={() => setShowVoidStripeConfirm(false)}
          onConfirm={handleVoidStripePayment}
          title="Cancel Payment Link"
          message="The client will no longer be able to pay with the current link. You can send a new one afterward."
          confirmText="Cancel Payment Link"
          cancelText="Keep Link"
          confirmType="danger"
        />

        {/* Remove Payment Plan Confirmation */}
        <ConfirmModal
          isOpen={showRemovePlanConfirm}
          onClose={() => setShowRemovePlanConfirm(false)}
          onConfirm={() => { setShowRemovePlanConfirm(false); void handleRemovePaymentPlan(); }}
          title="Remove payment plan"
          message="This will remove the payment schedule and all upcoming installments. Any payments already recorded will not be affected."
          confirmText="Remove plan"
          cancelText="Cancel"
          confirmType="danger"
        />

        {/* Receipt Preview Modal. Opened from the payments list, which can sit
            under another dialog, so it stacks. */}
        <Modal
          isOpen={!!previewReceiptPdfUrl}
          onClose={closePreviewReceiptPdf}
          labelledBy={receiptPreviewTitleId}
          stacked
          size="4xl"
          height="fill"
          showClose={false}
          bodyClassName={null}
          className="border border-outline rounded-xl overflow-hidden"
        >
              <div className="flex items-center justify-between px-5 py-3 border-b border-outline shrink-0">
                <h2 id={receiptPreviewTitleId} className="text-sm font-semibold text-on-surface">Receipt Preview</h2>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => {
                      if (!previewReceiptPdfUrl) return;
                      const link = document.createElement("a");
                      link.href = previewReceiptPdfUrl;
                      link.download = previewReceiptDownloadName || "Receipt.pdf";
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                    }}
                    type="secondary"
                    size="small"
                    icon={<Download className="w-3.5 h-3.5" />}
                  >
                    Download
                  </Button>
                  <button
                    onClick={closePreviewReceiptPdf}
                    className="p-1.5 rounded-md hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 text-on-surface-muted hover:text-on-surface cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <iframe
                  src={shownReceiptPdfUrl ?? undefined}
                  className="w-full h-full border-0"
                  title="Receipt PDF Preview"
                />
              </div>
        </Modal>

        {/* Edit Payment Plan Modal */}
        {invoice?.paymentPlan?.enabled && (
          <Modal
            isOpen={planEditing}
            onClose={cancelPlanEdit}
            labelledBy={editPlanTitleId}
            size="2xl"
            showClose={false}
            bodyClassName={null}
          >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
                  <div>
                    <h2 id={editPlanTitleId} className="text-base font-semibold text-on-surface">Edit Payment Schedule</h2>
                    <p className="text-xs text-on-surface-muted mt-0.5">
                      {formatCurrency(remainingBalance)} remaining · edit dates and amounts, then save
                    </p>
                  </div>
                  <button
                    onClick={cancelPlanEdit}
                    className="p-1.5 rounded-md hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 text-on-surface-muted hover:text-on-surface cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Date shift prompt */}
                {dateShiftPrompt && (
                  <div className="px-6 py-3 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 shrink-0">
                    <p className="text-xs font-medium text-blue-800 dark:text-blue-200 mb-2">
                      Date shifted by {Math.abs(dateShiftPrompt.offsetDays)} day{Math.abs(dateShiftPrompt.offsetDays) !== 1 ? "s" : ""}
                      {dateShiftPrompt.offsetDays > 0 ? " later" : " earlier"}.
                      Shift later dates too?
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => applyDateShift(dateShiftPrompt.offsetDays)}
                        className="cursor-pointer px-2.5 py-1 text-xs font-medium rounded-md bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                      >
                        Same offset ({dateShiftPrompt.offsetDays > 0 ? "+" : ""}{dateShiftPrompt.offsetDays}d)
                      </button>
                      {Math.abs(dateShiftPrompt.offsetDays) !== 7 && (
                        <button
                          onClick={() => applyDateShift(dateShiftPrompt.offsetDays > 0 ? 7 : -7)}
                          className="cursor-pointer px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          By 1 week
                        </button>
                      )}
                      {Math.abs(dateShiftPrompt.offsetDays) !== 14 && (
                        <button
                          onClick={() => applyDateShift(dateShiftPrompt.offsetDays > 0 ? 14 : -14)}
                          className="cursor-pointer px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          By 2 weeks
                        </button>
                      )}
                      {Math.abs(dateShiftPrompt.offsetDays) !== 30 && (
                        <button
                          onClick={() => applyDateShift(dateShiftPrompt.offsetDays > 0 ? 30 : -30)}
                          className="cursor-pointer px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          By 1 month
                        </button>
                      )}
                      <button
                        onClick={() => setDateShiftPrompt(null)}
                        className="cursor-pointer px-2.5 py-1 text-xs font-medium rounded-md border border-outline-subtle bg-surface-alt text-on-surface-secondary hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                      >
                        Don&apos;t shift
                      </button>
                    </div>
                  </div>
                )}

                {/* Scrollable table */}
                <div className="flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar min-h-0">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-alt text-on-surface-secondary sticky top-0">
                      <tr>
                        <th className="text-left px-5 py-2.5 font-medium text-xs">Due Date</th>
                        <th className="text-right px-5 py-2.5 font-medium text-xs">Amount</th>
                        <th className="text-center px-5 py-2.5 font-medium text-xs">Status</th>
                        <th className="text-center px-5 py-2.5 font-medium text-xs w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-subtle">
                      {/* Locked installments stay read-only */}
                      {(invoice.paymentPlan.expectedPayments || [])
                        .filter((ep) => isInstallmentLocked(ep))
                        .slice()
                        .sort((a, b) => dayjs(a.dueDate).valueOf() - dayjs(b.dueDate).valueOf())
                        .map((ep, i) => (
                          <tr key={`locked-${ep.id || i}`} className="opacity-50">
                            <td className="px-5 py-2.5 text-on-surface bg-surface text-xs">
                              {dayjs(ep.dueDate).format("MMM DD, YYYY")}
                            </td>
                            <td className="px-5 py-2.5 text-right text-on-surface bg-surface text-xs">
                              {formatCurrency(ep.amount)}
                            </td>
                            <td className="px-5 py-2.5 text-center bg-surface">
                              <StatusBadge variant="success">Paid</StatusBadge>
                            </td>
                            <td className="px-5 py-2.5 text-center bg-surface text-on-surface-muted text-xs">
                              🔒
                            </td>
                          </tr>
                        ))}
                      {/* Editable draft rows */}
                      {draftInstallments.map((r) => (
                        <tr key={r.key} className={dateShiftPrompt?.rowKey === r.key ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}>
                          <td className="px-5 py-2.5 bg-surface">
                            <DatePicker
                              value={r.dueDate}
                              onChange={(v) => setDraftDate(r.key, v)}
                              className="w-[9.5rem]"
                            />
                          </td>
                          <td className="px-5 py-2.5 text-right bg-surface">
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-on-surface-muted text-xs">$</span>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={r.amount || ""}
                                onChange={(e) => setDraftAmount(r.key, e.target.value)}
                                placeholder="0.00"
                                className={`${INPUT_CLS} w-24 py-1 text-xs text-right tabular-nums`}
                              />
                            </div>
                            <FieldError message={r.subCent ? MONEY_DECIMALS_MESSAGE : null} />
                          </td>
                          <td className="px-5 py-2.5 text-center bg-surface">
                            <StatusBadge variant="neutral">Upcoming</StatusBadge>
                          </td>
                          <td className="px-5 py-2.5 text-center bg-surface">
                            <ActionIconButton
                              label="Remove installment"
                              onClick={() => deleteDraftRow(r.key)}
                              tone="danger"
                              size="sm"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </ActionIconButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Add installment */}
                  <div className="px-5 py-2.5 border-t border-outline-subtle">
                    <button
                      type="button"
                      onClick={addDraftRow}
                      className="cursor-pointer inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border border-outline-subtle bg-surface-alt text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                    >
                      <Plus className="w-3 h-3" />
                      Add installment
                    </button>
                    <FieldError
                      message={
                        draftAtRowLimit
                          ? installmentRowLimitMessage()
                          : null
                      }
                    />
                  </div>
                </div>

                {/* Cadence + distribute - only shown when there's a mismatch */}
                {draftMismatchCents !== 0 && (
                  <div className="px-6 py-4 border-t border-outline flex flex-wrap items-end gap-3 bg-surface-alt/50 shrink-0">
                    <div className="w-44">
                      <Dropdown
                        label="Frequency (for distribute)"
                        value={draftFreqIsCustom ? "custom" : String(draftFrequency)}
                        onChange={(v) => {
                          if (v === "custom") {
                            setDraftFreqIsCustom(true);
                          } else {
                            setDraftFreqIsCustom(false);
                            setDraftFrequency(Number(v));
                          }
                        }}
                        options={[
                          { label: "Weekly", value: "7" },
                          { label: "Every 2 weeks", value: "14" },
                          { label: "Monthly", value: "30" },
                          { label: "Custom", value: "custom" },
                        ]}
                        portal
                      />
                    </div>
                    {draftFreqIsCustom && (
                      <div>
                        <label htmlFor={`${fieldIds}-draftfrequency`} className="mb-1 block text-xs font-medium text-on-surface">Every (days)</label>
                        <input
                          id={`${fieldIds}-draftfrequency`}
                          type="number"
                          min={1}
                          value={draftFrequency}
                          onChange={(e) => setDraftFrequency(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-24 rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        />
                      </div>
                    )}
                    <Tooltip title="Split the remaining balance evenly and step dates by the chosen frequency" enterDelay={300}>
                      <button
                        type="button"
                        onClick={distributeDraftEvenly}
                        className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                      >
                        <Calendar className="w-4 h-4" />
                        Split amounts &amp; dates evenly
                      </button>
                    </Tooltip>
                  </div>
                )}

                {/* Live balance check - always visible */}
                <div className="px-6 py-3 border-t border-outline shrink-0">
                    <div
                      className={`rounded-md text-xs border ${
                        draftMismatchCents === 0
                          ? "bg-green-50/60 dark:bg-green-950/20 border-green-200 dark:border-green-800/50 text-green-700 dark:text-green-400"
                          : "bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {/* Balance row */}
                      <div className="flex items-center justify-between px-3 py-2.5">
                        <span className="flex items-center gap-1.5 font-medium">
                          {draftMismatchCents === 0 ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          )}
                          Scheduled {formatCurrency(draftScheduledTotal)} of{" "}
                          {formatCurrency(remainingBalance)} remaining
                        </span>
                        {draftMismatchCents !== 0 && (
                          <StatusBadge variant="warning">
                            {draftMismatchCents > 0 ? "Over by " : "Short by "}
                            {formatCurrency(Math.abs(draftMismatchCents) / 100)}
                          </StatusBadge>
                        )}
                      </div>

                      {/* Fix buttons - a shortfall can be added somewhere, an overage can only be taken back */}
                      {draftMismatchCents !== 0 && draftInstallments.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-t border-amber-200/60 dark:border-amber-800/40">
                          {(() => {
                            const hasManualEdits = draftInstallments.some((r) => r.manualAmount);
                            const flexCount = draftInstallments.filter((r) => !r.manualAmount).length;
                            const manualTotalCents = draftInstallments
                              .filter((r) => r.manualAmount)
                              .reduce((s, r) => s + Math.round((r.amount || 0) * 100), 0);
                            const remTargetCents = Math.max(0, Math.round(draftTarget * 100) - manualTotalCents);

                            const tooltipMsg =
                              hasManualEdits && flexCount > 0
                                ? `Split the remaining ${formatCurrency(remTargetCents / 100)} balance evenly across the other ${flexCount} installment${flexCount !== 1 ? "s" : ""}, keeping your custom payment amount${draftInstallments.filter((r) => r.manualAmount).length !== 1 ? "s" : ""} intact`
                                : `Split the ${formatCurrency(draftTarget)} balance evenly across these ${draftInstallments.length} installments without changing due dates`;

                            const labelMsg = hasManualEdits && flexCount > 0 ? "Split remaining evenly" : "Split evenly";

                            return (
                              <Tooltip title={tooltipMsg} enterDelay={300}>
                                <button
                                  type="button"
                                  onClick={distributeRemainingDraft}
                                  className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                >
                                  <Calendar className="w-3 h-3" />
                                  {labelMsg}
                                </button>
                              </Tooltip>
                            );
                          })()}
                          {draftMismatchCents < 0 ? (
                            <>
                              <Tooltip title={`Add ${formatCurrency(Math.abs(draftMismatchCents) / 100)} to the installment that comes due first`} enterDelay={300}>
                                <button
                                  type="button"
                                  onClick={addShortfallToNextInstallment}
                                  className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                >
                                  <ChevronRight className="w-3 h-3" />
                                  Add to next installment
                                </button>
                              </Tooltip>
                              <Tooltip title={`Schedule the remaining ${formatCurrency(Math.abs(draftMismatchCents) / 100)} as one more installment after the last one`} enterDelay={300}>
                                <button
                                  type="button"
                                  onClick={addShortfallAsNewInstallment}
                                  className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                                >
                                  <Plus className="w-3 h-3" />
                                  New installment
                                </button>
                              </Tooltip>
                            </>
                          ) : (
                            <Tooltip title={`Take ${formatCurrency(draftMismatchCents / 100)} back off the last installments, removing any that reach $0`} enterDelay={300}>
                              <button
                                type="button"
                                onClick={trimOverageFromEnd}
                                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                              >
                                <Minus className="w-3 h-3" />
                                Trim from the end
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
                  <div className="text-xs text-on-surface-muted">
                    {draftInstallments.length} installment{draftInstallments.length !== 1 ? "s" : ""} · amounts are manually set
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="secondary" onClick={cancelPlanEdit} disabled={savingSchedule}>
                      Cancel
                    </Button>
                    <Tooltip
                      title={
                        draftMismatchCents !== 0
                          ? `The schedule must add up to the ${formatCurrency(remainingBalance)} remaining (it's ${draftMismatchCents > 0 ? "over" : "short"} by ${formatCurrency(Math.abs(draftMismatchCents) / 100)})`
                          : ""
                      }
                      enterDelay={300}
                    >
                      <span>
                        <Button
                          type="primary"
                          onClick={savePlanSchedule}
                          loading={savingSchedule}
                          disabled={
                            draftMismatchCents !== 0 ||
                            draftInstallments.length === 0 ||
                            draftInstallments.some((r) => !(r.amount > 0) || !r.dueDate)
                          }
                        >
                          Save schedule
                        </Button>
                      </span>
                    </Tooltip>
                  </div>
                </div>
          </Modal>
        )}

        {/* PDF Preview Modal */}
        <Modal
          isOpen={!!previewPdfUrl}
          onClose={closePreviewPdf}
          labelledBy={invoicePreviewTitleId}
          size="4xl"
          height="fill"
          showClose={false}
          bodyClassName={null}
          className="border border-outline rounded-xl overflow-hidden"
        >
              <div className="flex items-center justify-between px-5 py-3 border-b border-outline shrink-0">
                <h2 id={invoicePreviewTitleId} className="text-sm font-semibold text-on-surface">Invoice Preview</h2>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={downloadInvoicePdf}
                    type="secondary"
                    size="small"
                    icon={<Download className="w-3.5 h-3.5" />}
                  >
                    Download
                  </Button>
                  <button
                    onClick={closePreviewPdf}
                    className="p-1.5 rounded-md hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 text-on-surface-muted hover:text-on-surface cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <iframe
                  src={shownInvoicePdfUrl ?? undefined}
                  className="w-full h-full border-0"
                  title="Invoice PDF Preview"
                />
              </div>
        </Modal>

        {/* Organization roster & access permissions modal */}
        <OrgAccessModal
          isOpen={showOrgAccessModal}
          onClose={() => setShowOrgAccessModal(false)}
          lawFirmId={lawFirmId}
          clientId={orgClientId}
          clientName={orgClientName}
        />

        {/* The PDF and LEDES exports, and the billing-recipients refresh, are all
            launched from the "More" menu, which closes on click, so the wait is
            reported here instead. */}
        <BusyToast
          message={
            generatingPDF ? "Generating invoice PDF…"
              : exportingLedes ? "Preparing LEDES export…"
              : refreshingRecipients ? "Refreshing billing recipients…"
              : null
          }
        />
  </>;
}
