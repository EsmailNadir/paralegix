"use client";

import { useState, type ReactElement } from "react";

import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import SuccessNotification from "@/components/SuccessNotification";
import {
formatCurrency,
getRecurringRetainerPlanName
} from "@/components/billingComp/utils";
import BackButton from "@/components/ui/BackButton";
import Button from "@/components/ui/Button";
import DatePicker from "@/components/ui/DatePicker";
import FieldError from "@/components/ui/FieldError";
import InlineWarning from "@/components/ui/InlineWarning";
import ItemActionMenu,{ menuPositionFromEvent,type ItemMenuAction } from "@/components/ui/ItemActionMenu";
import RequirePermission from "@/components/ui/RequirePermission";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import TabBar from "@/components/ui/TabBar";
import Tooltip from "@/components/ui/Tooltip";
import useInvoiceDetailController from "@/hooks/billingHooks/useInvoiceDetailController";
import { REQUEST_TIMEOUT_MS } from "@/lib/constants/requestTimeouts";
import { getErrorMessage, toApiError } from "@/lib/utils/apiErrors";
import { getFirebaseToken } from "@/lib/utils/auth";
import { isBeforeToday } from "@/lib/utils/dateUtils";
import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import { formatFileSize,formatHoursMinutes } from "@/lib/utils/format";
import billingService from "@/services/billing.service";
import dayjs from "dayjs";
import {
Ban,
Building2,
CreditCard,
DollarSign,
Download,
Eye,
FileText,
MoreHorizontal,
Pencil,
Percent,
Plus,
Receipt,
RefreshCw,
Send,
Trash2,
User,
Users
} from "lucide-react";
import InvoiceDetailDialogs from "./InvoiceDetailDialogs";
import EditBillingEmailModal from "./EditBillingEmailModal";
import type { BillingContext } from "@/types/billing";
import InvoiceDetailLineItems from "./InvoiceDetailLineItems";
import InvoiceDetailPayments from "./InvoiceDetailPayments";
import InvoiceDetailPlan from "./InvoiceDetailPlan";
import InvoiceDetailSummary from "./InvoiceDetailSummary";
import type { InvoiceDetailViewProps } from "./invoiceDetailTypes";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api";

const FROZEN_AT_ISSUE_HINT = "Fixed once the invoice is issued, since the client holds a copy carrying it.";

export default function InvoiceDetailView(props: InvoiceDetailViewProps) {
  const state = useInvoiceDetailController(props);
  const { loadInvoice, lawFirmId, entityId, invoiceId, contextType, backHref, backLabel, navigate, hasPermission, canManageInvoices, canViewClients, readOnlyInvoice, queryClient, resolveUserName, invoice, setInvoice, loading, error, setError, client, updatingPayment, generatingPDF, setExportingLedes, refreshingRecipients, setShowSendInvoiceModal, setSendInvoiceError, setSendInvoiceSuccess, setEmailRecipient, nextPaymentDate, setShowCreditNoteModal, setCreditNoteAmount, setCreditNoteDescription, setCreditNoteType, setCreditNoteError, setShowAddAmountModal, setAddAmountValue, setAddAmountNote, setAddAmountError, setShowOrgAccessModal, editingDetails, setEditingDetails, editName, setEditName, editNumber, setEditNumber, editDate, setEditDate, editDueDate, setEditDueDate, editRemitToName, setEditRemitToName, editRemitToAddress, setEditRemitToAddress, savingDetails, setSavingDetails, setShowDeleteConfirm, setShowVoidConfirm, successMessage, setSuccessMessage, setActiveTab, moreMenuOpen, setMoreMenuOpen, moreMenuPos, setMoreMenuPos, goToPaymentPlan, billingContext, lineEditor, totalAmount, totalHours, amountPaid, totalWrittenOff, remainingBalance, creditBalance, payments, creditNotes, auditLog, sentCopies, downloadingCopy, sentCopyError, setSentCopyError, handleDownloadSentCopy, isPaid, status, canApplyLateFee, taxAmount, taxLabel, resolvedClient, billTo, isCompanyClient, orgClientId, resolvedClientName, remitTo, recurringRetainerInvoice, detailTabs, currentTab, openPaymentModal, handleApplyLateFee, handleRefreshBillingRecipients, downloadInvoicePdf, handlePreviewPdf } = state;
  const [editNameError, setEditNameError] = useState<string | null>(null);
  // The number, invoice date and remit-to are frozen once the invoice is issued
  // (`billingSnapshotAt` stamped). They are shown read-only and left out of the
  // save, which the server would otherwise refuse.
  const detailsFrozen = !!invoice?.billingSnapshotAt;
  const frozenField = (field: ReactElement) =>
    detailsFrozen ? (
      <Tooltip title={FROZEN_AT_ISSUE_HINT} enterDelay={300}>
        <span className="block">{field}</span>
      </Tooltip>
    ) : (
      field
    );
  const [editBillingEmailOpen, setEditBillingEmailOpen] = useState(false);
  // ── Loading / Error states ──

  if (loading) return <LoadingSpinner fullPage />;

  if (!invoice) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="text-center">
          <FileText className="w-12 h-12 text-on-surface-muted mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-on-surface mb-2">Invoice not found</h2>
          <ErrorNotification
            error={error || "The requested invoice could not be loaded."}
            onRetry={() => void loadInvoice()}
            className="mb-4"
          />
          <Button
            onClick={() => navigate(backHref)}
            type="primary"
          >
            {backLabel}
          </Button>
        </div>
      </div>
    );
  }

  const detail = { ...state, invoice };
  const canEditBillingEmail = canManageInvoices && !readOnlyInvoice && invoice?.status !== "voided";
  const currentBillingEmails: string[] = billTo?.emails?.length
    ? billTo.emails
    : (invoice?.billingEmail ? [invoice.billingEmail] : []);

  const renderNextPayment = (containerClassName: string) => {
    if (!invoice?.nextPaymentDate || isPaid) return null;
    const nextIsOverdue = isBeforeToday(invoice.nextPaymentDate);
    const dateLine = (
      <>
        {dayjs(invoice.nextPaymentDate).format("MMM DD, YYYY")}
        {nextIsOverdue && <span className="text-xs ml-1">(OVERDUE)</span>}
      </>
    );
    const amountClass = nextIsOverdue
      ? "text-red-600 dark:text-red-400"
      : "text-on-surface";

    if (invoice.paymentPlan?.enabled) {
      return (
        <div className={containerClassName}>
          <Tooltip title="View payment schedule to reschedule" enterDelay={300}>
            <button
              type="button"
              onClick={goToPaymentPlan}
              className="cursor-pointer text-left rounded-md -mx-1 px-1 py-0.5 hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                Next Payment
              </p>
              <p className={`font-medium group-hover:underline ${amountClass}`}>
                {dateLine}
              </p>
            </button>
          </Tooltip>
        </div>
      );
    }

    return (
      <div className={containerClassName}>
        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
          Next Payment
        </p>
        <p className={`font-medium ${amountClass}`}>{dateLine}</p>
      </div>
    );
  };

  // ── Render ──

  return (
    <RequirePermission permission="billing.viewInvoices">
      <div className="min-h-screen bg-page">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8">
          {/* Back navigation + top actions */}
          <div className="flex items-center justify-between mb-6">
            <BackButton href={backHref} label={backLabel} variant="link" />
          </div>

          {error && (
            <div className="mb-4">
              <ErrorNotification error={error} onClose={() => setError(null)} />
            </div>
          )}
          {successMessage && (
            <div className="mb-4">
              <SuccessNotification message={successMessage} onClose={() => setSuccessMessage(null)} compact />
            </div>
          )}

          {invoice?.refundDue && canManageInvoices && (
            <InlineWarning className="mb-4">
              {invoice.refundDue.reason === "voided"
                ? `Refund due: ${formatCurrency(invoice.refundDue.amount)} was paid after this invoice was voided. Refund it from your payment processor.`
                : `Overpaid by ${formatCurrency(invoice.refundDue.amount)}. Refund the difference or apply it to another invoice.`}
            </InlineWarning>
          )}

          {readOnlyInvoice && (
            <div className="mb-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
              You can view this invoice, but changing it needs the <code>billing.manageInvoices</code>{" "}
              permission and recording a payment needs <code>billing.recordPayments</code>.
            </div>
          )}

          {/* ── Header band: identity, meta, and primary actions ── */}
              <div className="bg-surface rounded-lg border border-outline p-5 md:p-6 shadow-sm mb-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    {editingDetails ? (
                      <div className="space-y-2">
                        <div>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => {
                              setEditName(e.target.value);
                              setEditNameError(null);
                            }}
                            placeholder="Invoice Name"
                            aria-invalid={!!editNameError}
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-1.5 text-lg font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          />
                          <FieldError message={editNameError} />
                        </div>
                        {frozenField(
                          <input
                            type="text"
                            value={editNumber}
                            onChange={(e) => setEditNumber(e.target.value)}
                            placeholder="Invoice Number"
                            disabled={detailsFrozen}
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                          />,
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h1 className="text-2xl font-bold text-on-surface">
                          {invoice.invoiceName}
                        </h1>
                        {invoice.invoiceNumber && (
                          <span className="text-sm text-on-surface-muted font-normal">{invoice.invoiceNumber}</span>
                        )}
                        {invoice.splitGroupId && (
                          <StatusBadge variant="purple">Split Matter Invoice</StatusBadge>
                        )}
                        {recurringRetainerInvoice && (
                          <StatusBadge variant="success">Recurring Retainer</StatusBadge>
                        )}
                        {status && (
                          <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
                        )}
                      </div>
                    )}
                    {invoice.splitGroupId && !editingDetails && (
                      <p className="text-xs text-on-surface-muted">
                        Linked split group {invoice.splitGroupId.slice(0, 8)}{invoice.splitRecipientCount ? ` • ${invoice.splitRecipientCount} recipients` : ""}
                      </p>
                    )}
                    {invoice.createdAt && !editingDetails && (
                      <p className="text-xs text-on-surface-muted mt-1">
                        Created {dayjs(invoice.createdAt).format("MMM DD, YYYY")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    {editingDetails ? (
                      <RequirePermission permission="billing.manageInvoices">
                        <div className="flex items-center gap-2">
                          <Button
                            type="primary"
                            size="small"
                            loading={savingDetails}
                            onClick={async () => {
                              if (!editName.trim()) {
                                setEditNameError("Invoice name is required");
                                return;
                              }
                              setSavingDetails(true);
                              try {
                                // Only the parts of the remit-to block the form shows are
                                // edited; city, state and zip ride along unchanged. It is
                                // cleared only when nothing of it is left, so a block with
                                // an address but no name is kept.
                                const remitFields = {
                                  name: editRemitToName.trim() || undefined,
                                  address: editRemitToAddress.trim() || undefined,
                                  city: remitTo?.city,
                                  state: remitTo?.state,
                                  zip: remitTo?.zip,
                                };
                                const hasRemitTo = Object.values(remitFields).some(Boolean);
                                const updated = await billingService.updateInvoiceDetails(
                                  billingContext,
                                  invoiceId,
                                  {
                                    invoiceName: editName.trim(),
                                    dueDate: editDueDate || null,
                                    ...(detailsFrozen
                                      ? {}
                                      : {
                                          invoiceNumber: editNumber.trim() || null,
                                          invoiceDate: editDate || null,
                                          remitTo: hasRemitTo ? remitFields : null,
                                        }),
                                  }
                                );
                                setInvoice(updated);
                                setEditingDetails(false);
                                queryClient.invalidateQueries({ queryKey: ['billing', 'paymentDates', lawFirmId] });
                              } catch (err) {
                                setError(getErrorMessage(err, "Failed to update invoice"));
                              } finally {
                                setSavingDetails(false);
                              }
                            }}
                          >
                            Save
                          </Button>
                          <Button type="secondary" size="small" onClick={() => setEditingDetails(false)}>Cancel</Button>
                        </div>
                      </RequirePermission>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Tooltip title="Preview invoice PDF" enterDelay={300}>
                          <span>
                            <button aria-label="Preview invoice PDF"
                              onClick={handlePreviewPdf}
                              disabled={generatingPDF}
                              className="cursor-pointer p-1.5 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50"
                            >
                              <Eye size={15} />
                            </button>
                          </span>
                        </Tooltip>
                        <RequirePermission permission="billing.manageInvoices">
                          <Tooltip title="Edit invoice details" enterDelay={300}>
                            <button aria-label="Edit invoice details"
                              onClick={() => {
                                // invoices.invoice_name is a nullable text column even
                                // though the Invoice type declares it non-null (see
                                // getInvoiceDisplayName), and a null here reaches the
                                // input as value={null}, which React rejects.
                                setEditName(invoice.invoiceName || "");
                                setEditNumber(invoice.invoiceNumber || "");
                                setEditDate(invoice.invoiceDate ? dayjs(invoice.invoiceDate).format("YYYY-MM-DD") : "");
                                setEditDueDate(invoice.dueDate ? dayjs(invoice.dueDate).format("YYYY-MM-DD") : "");
                                setEditRemitToName(remitTo?.name || (typeof invoice.remitTo === "string" ? invoice.remitTo : "") || "");
                                setEditRemitToAddress(remitTo?.address || "");
                                setEditNameError(null);
                                setEditingDetails(true);
                              }}
                              className="cursor-pointer p-1.5 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                            >
                              <Pencil size={15} />
                            </button>
                          </Tooltip>
                        </RequirePermission>
                        <div className="w-px h-6 bg-outline mx-1" />
                      </div>
                    )}
                    {!editingDetails && (
                      <>
                        <RequirePermission permission="billing.manageInvoices">
                          <Button
                            onClick={() => {
                              setSendInvoiceError(null);
                              setSendInvoiceSuccess(null);
                              setEmailRecipient(invoice?.billingEmail || invoice?.clientEmail || "");
                              setShowSendInvoiceModal(true);
                            }}
                            type="secondary"
                            size="small"
                            icon={<Send className="w-4 h-4" />}
                          >
                            Send to Client
                          </Button>
                        </RequirePermission>
                        {!isPaid && (
                          <RequirePermission permission="billing.recordPayments">
                            <Button
                              onClick={() => openPaymentModal()}
                              type="primary"
                              size="small"
                              disabled={updatingPayment}
                              icon={<DollarSign className="w-4 h-4" />}
                            >
                              Record Payment
                            </Button>
                          </RequirePermission>
                        )}
                        {/* Overflow menu: adjustments, exports, destructive actions */}
                        {/* No tooltip: the button opens a menu that names every
                            action it holds, so a hover label only covers it. */}
                        <button aria-label="More actions"
                          data-item-menu-trigger
                          onClick={(e) => {
                            if (moreMenuOpen) { setMoreMenuOpen(false); return; }
                            setMoreMenuPos(menuPositionFromEvent(e));
                            setMoreMenuOpen(true);
                          }}
                          className={`cursor-pointer p-1.5 rounded-md border border-outline text-on-surface-secondary hover:bg-surface-hover transition-[background-color] ${moreMenuOpen ? "bg-surface-hover" : ""}`}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        <ItemActionMenu
                          open={moreMenuOpen}
                          anchorTop={moreMenuPos?.anchorTop ?? 0}
                          anchorBottom={moreMenuPos?.anchorBottom ?? 0}
                          right={moreMenuPos?.right ?? 0}
                          onClose={() => setMoreMenuOpen(false)}
                          actions={([
                            !isPaid && hasPermission("billing.manageInvoices") && {
                              key: "add-amount",
                              label: "Add Amount",
                              icon: <Plus size={13} strokeWidth={2.2} />,
                              disabled: updatingPayment,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                setAddAmountValue("");
                                setAddAmountNote("");
                                setAddAmountError(null);
                                setShowAddAmountModal(true);
                              },
                            },
                            !isPaid && hasPermission("billing.manageInvoices") && {
                              key: "add-credit-note",
                              label: "Add Credit Note",
                              icon: <Receipt size={13} strokeWidth={2.2} />,
                              disabled: updatingPayment,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                setCreditNoteAmount("");
                                setCreditNoteDescription("");
                                setCreditNoteType("write_off");
                                setCreditNoteError(null);
                                setShowCreditNoteModal(true);
                              },
                            },
                            !isPaid && hasPermission("billing.manageInvoices") && canApplyLateFee && {
                              key: "apply-late-fee",
                              label: "Apply Late Fee",
                              icon: <Percent size={13} strokeWidth={2.2} />,
                              disabled: updatingPayment,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                handleApplyLateFee();
                              },
                            },
                            {
                              key: "download-invoice-pdf",
                              label: generatingPDF ? "Generating..." : "Download Invoice PDF",
                              icon: <Download size={13} strokeWidth={2.2} />,
                              disabled: generatingPDF,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                downloadInvoicePdf();
                              },
                            },
                            hasPermission("billing.manageInvoices") && {
                              key: "download-ledes",
                              label: "Download LEDES",
                              icon: <FileText size={13} strokeWidth={2.2} />,
                              onClick: async () => {
                                setMoreMenuOpen(false);
                                setExportingLedes(true);
                                try {
                                  const token = await getFirebaseToken();
                                  const res = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/billing/invoices/${contextType}/${entityId}/${invoiceId}/export/ledes`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                    timeoutMs: REQUEST_TIMEOUT_MS.upload,
                                  });
                                  if (!res.ok) throw await toApiError(res, "Failed to export LEDES file");
                                  const blob = await res.blob();
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement("a");
                                  a.href = url;
                                  a.download = `${invoice?.invoiceName || invoiceId}.ledes`;
                                  a.click();
                                  URL.revokeObjectURL(url);
                                } catch (err) {
                                  setError(getErrorMessage(err, "Failed to export LEDES file"));
                                } finally {
                                  setExportingLedes(false);
                                }
                              },
                            },
                            // Only meaningful once something has actually been frozen -
                            // refreshing a still-draft invoice has nothing to correct,
                            // since a draft already reads today's roster live.
                            !!invoice.billingSnapshotAt && hasPermission("billing.manageInvoices") && {
                              key: "refresh-recipients",
                              label: "Refresh Billing Recipients",
                              icon: <RefreshCw size={13} strokeWidth={2.2} />,
                              disabled: refreshingRecipients,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                handleRefreshBillingRecipients();
                              },
                            },
                            // The backend refuses a voided invoice and one with payments, so the
                            // item is hidden rather than offered to always fail.
                            !isPaid && hasPermission("billing.manageInvoices") && payments.length === 0 && amountPaid === 0 && {
                              key: "void-invoice",
                              label: "Void Invoice",
                              icon: <Ban size={13} strokeWidth={2.2} />,
                              danger: true,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                setShowVoidConfirm(true);
                              },
                            },
                            hasPermission("billing.manageInvoices") && {
                              key: "delete-invoice",
                              label: "Delete Invoice",
                              icon: <Trash2 size={13} strokeWidth={2.2} />,
                              danger: true,
                              onClick: () => {
                                setMoreMenuOpen(false);
                                setShowDeleteConfirm(true);
                              },
                            },
                          ] as Array<ItemMenuAction | false>).filter((a): a is ItemMenuAction => Boolean(a))}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Invoice details grid */}
                {recurringRetainerInvoice && (
                  <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">
                    This invoice was generated from a recurring retainer plan
                    {getRecurringRetainerPlanName(invoice) ? `: ${getRecurringRetainerPlanName(invoice)}.` : "."}
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm pt-4 border-t border-outline-subtle">
                  <div>
                    <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                      Invoice Date
                    </p>
                    {editingDetails ? (
                      frozenField(
                        <DatePicker
                          value={editDate}
                          onChange={setEditDate}
                          className="text-sm"
                          disabled={detailsFrozen}
                        />,
                      )
                    ) : (
                      <p className="text-on-surface font-medium">
                        {invoice.invoiceDate ? dayjs(invoice.invoiceDate).format("MMM DD, YYYY") : "-"}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                      Due Date
                    </p>
                    {editingDetails ? (
                      invoice.paymentPlan?.enabled ? (
                        <Tooltip title="Due date follows the payment plan's final installment. Edit the schedule to change it." enterDelay={300}>
                          <span>
                            <DatePicker
                              value={editDueDate}
                              onChange={setEditDueDate}
                              className="text-sm"
                              disabled
                            />
                          </span>
                        </Tooltip>
                      ) : (
                        <DatePicker
                          value={editDueDate}
                          onChange={setEditDueDate}
                          className="text-sm"
                        />
                      )
                    ) : (
                      <p className="text-on-surface font-medium">
                        {invoice.dueDate ? dayjs(invoice.dueDate).format("MMM DD, YYYY") : "-"}
                      </p>
                    )}
                    {renderNextPayment("hidden md:block mt-2.5")}
                  </div>
                  {renderNextPayment("col-span-2 md:hidden")}
                  {/* Once this invoice has issued, `billTo` reads the frozen snapshot
                      (migration 0171): the company/person's own name with an
                      attention line and address when a company snapshot has one,
                      and every recipient it was actually billed to. Before that
                      first issue there is nothing frozen yet, so this falls back to
                      the live client record and the single override, unchanged from
                      before this snapshot existed. */}
                  {/* Client information display */}
                  {resolvedClientName && (() => {
                    // Only a link where there is somewhere to land. An invoice can
                    // name a client it holds no id for, because `billTo` reads a
                    // frozen snapshot once the invoice has issued, and the client
                    // page is a `clients.view` page, so without that permission the
                    // link would open a refusal.
                    const canOpenClient = Boolean(orgClientId) && canViewClients;
                    const TypeIcon = isCompanyClient ? Building2 : User;
                    const detail = resolvedClient?.email || invoice?.clientEmail;

                    // Spans, not paragraphs: these sit inside a button below, and a
                    // block element there is invalid markup.
                    const lines = (
                      <>
                        <span className="inline-flex items-center gap-1.5">
                          <TypeIcon className="w-3.5 h-3.5 text-on-surface-muted flex-shrink-0" />
                          <span className="font-medium text-on-surface">{resolvedClientName}</span>
                        </span>
                        {billTo?.attentionLine && (
                          <span className="mt-0.5 block text-xs text-on-surface-muted">{billTo.attentionLine}</span>
                        )}
                        {billTo?.address && (
                          <span className="mt-0.5 block text-xs text-on-surface-muted">{billTo.address}</span>
                        )}
                        {!billTo?.address && detail && (
                          <span className="mt-0.5 block text-xs text-on-surface-muted">{detail}</span>
                        )}
                      </>
                    );

                    return (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                          Client
                        </p>
                        <div className="flex items-start gap-1">
                          {canOpenClient ? (
                            // The whole block is the target, address and all: a
                            // short name is a small thing to hit, and the lines
                            // under it describe the same client. Negative margins
                            // let the hover fill reach past the text without the
                            // block moving when it appears.
                            //
                            // No Tooltip: it would set an aria-label over a control
                            // that already reads as the client's name and address,
                            // so a screen reader would announce the hint instead.
                            <button
                              type="button"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${orgClientId}`)}
                              className="group min-w-0 flex-1 cursor-pointer rounded-md -mx-2 -my-1 px-2 py-1 text-left transition-colors hover:bg-surface-hover"
                            >
                              {lines}
                            </button>
                          ) : (
                            <div className="min-w-0 flex-1">{lines}</div>
                          )}

                          {/* The roster dialog is a `clients.view` read. Offering it
                              to a billing-only role opened a dialog that could only
                              ever answer "Failed to load organization members", so
                              it is simply absent for them. It sits beside the block
                              rather than inside it, because a button within a button
                              is invalid and swallows one of the two clicks. */}
                          {isCompanyClient && orgClientId && canViewClients && (
                            <Tooltip title="View Organization members with billing & email access" enterDelay={300}>
                              <button
                                type="button"
                                aria-label="View Organization members"
                                onClick={() => setShowOrgAccessModal(true)}
                                className="shrink-0 cursor-pointer rounded p-1 text-on-surface-muted transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
                              >
                                <Users className="w-3.5 h-3.5" />
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Billing Email display, with the correction a firm makes when
                      it learns the address was wrong. */}
                  {(canEditBillingEmail || (billTo?.emails?.length ? billTo.emails.length > 0 : Boolean(invoice?.billingEmail))) && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide">
                          Billing Email{(billTo?.emails?.length ?? 1) > 1 ? "s" : ""}
                        </p>
                        {canEditBillingEmail && (
                          <Tooltip title="Edit billing email" enterDelay={300}>
                            <button
                              type="button"
                              aria-label="Edit billing email"
                              onClick={() => setEditBillingEmailOpen(true)}
                              className="shrink-0 cursor-pointer rounded p-0.5 text-on-surface-muted transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                      <p className="text-on-surface font-medium break-all text-xs">
                        {currentBillingEmails.length ? currentBillingEmails.join(", ") : "None"}
                      </p>
                    </div>
                  )}
                  {/* Remit To display or edit */}
                  {editingDetails ? (
                    <div>
                      <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                        Remit To
                      </p>
                      <div className="space-y-1">
                        {frozenField(
                          <input
                            type="text"
                            value={editRemitToName}
                            onChange={(e) => setEditRemitToName(e.target.value)}
                            placeholder="Remit To Name"
                            disabled={detailsFrozen}
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                          />,
                        )}
                        {frozenField(
                          <input
                            type="text"
                            value={editRemitToAddress}
                            onChange={(e) => setEditRemitToAddress(e.target.value)}
                            placeholder="Address (optional)"
                            disabled={detailsFrozen}
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                          />,
                        )}
                      </div>
                    </div>
                  ) : (
                    remitTo && (remitTo.name || remitTo.address) && (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">
                          Remit To
                        </p>
                        <div className="text-on-surface text-sm space-y-0.5">
                          {remitTo.name && <p className="font-medium">{remitTo.name}</p>}
                          {remitTo.address && <p className="text-xs text-on-surface-muted">{remitTo.address}</p>}
                          {(remitTo.city || remitTo.state || remitTo.zip) && (
                            <p className="text-xs text-on-surface-muted">
                              {[remitTo.city, remitTo.state, remitTo.zip]
                                .filter(Boolean)
                                .join(", ")}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  )}
                </div>

                {/* Stripe payment status */}
                {invoice.stripePaymentRequested && invoice.stripePaymentStatus !== "completed" && (
                  <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-700">
                    <CreditCard className="w-4 h-4 text-accent-emphasis" />
                    <span className="text-xs font-medium text-blue-700 dark:text-accent-emphasis">
                      Online payment requested
                    </span>
                  </div>
                )}
              </div>

          {/* ── Financial stat strip ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-5">
            <button
              onClick={() => setActiveTab("items")}
              className="cursor-pointer bg-surface rounded-lg border border-outline p-4 shadow-sm text-left hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.99] motion-reduce:active:scale-100"
            >
              <p className="text-[11px] text-on-surface-muted uppercase tracking-wide mb-1">
                Invoice Total
              </p>
              <p className="text-2xl font-bold text-on-surface">{formatCurrency(totalAmount)}</p>
              {totalHours > 0 && (
                <p className="text-[11px] text-on-surface-muted mt-1">
                  {formatHoursMinutes(totalHours)} billed
                </p>
              )}
              {taxAmount > 0 && (
                <p className="text-[11px] text-on-surface-muted mt-1">
                  Includes {taxLabel} {formatCurrency(taxAmount)}
                  {invoice?.taxRate ? ` (${invoice.taxRate}%)` : ""}
                </p>
              )}
            </button>
            <button
              onClick={() => setActiveTab("payments")}
              className="cursor-pointer bg-surface rounded-lg border border-outline p-4 shadow-sm text-left hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.99] motion-reduce:active:scale-100"
            >
              <p className="text-[11px] text-on-surface-muted uppercase tracking-wide mb-1">Paid</p>
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">
                {formatCurrency(amountPaid)}
              </p>
              <p className="text-[11px] text-on-surface-muted mt-1">
                {payments.length} payment{payments.length === 1 ? "" : "s"} · View all
              </p>
            </button>
            {creditNotes.length > 0 ? (
              <button
                onClick={() => setActiveTab("credits")}
                className="cursor-pointer bg-surface rounded-lg border border-outline p-4 shadow-sm text-left hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              >
                <p className="text-[11px] text-on-surface-muted uppercase tracking-wide mb-1">
                  Credits / Write-offs
                </p>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                  {formatCurrency(totalWrittenOff)}
                </p>
                <p className="text-[11px] text-on-surface-muted mt-1">
                  {creditNotes.length} credit note{creditNotes.length === 1 ? "" : "s"}
                </p>
              </button>
            ) : (
              <div className="bg-surface rounded-lg border border-outline p-4 shadow-sm">
                <p className="text-[11px] text-on-surface-muted uppercase tracking-wide mb-1">
                  Credits / Write-offs
                </p>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                  {formatCurrency(totalWrittenOff)}
                </p>
                <p className="text-[11px] text-on-surface-muted mt-1">
                  {creditNotes.length} credit note{creditNotes.length === 1 ? "" : "s"}
                </p>
              </div>
            )}
            <div
              className={`bg-surface rounded-lg border-2 p-4 shadow-sm ${
                creditBalance > 0
                  ? "border-amber-300 dark:border-amber-500/40"
                  : remainingBalance > 0
                    ? "border-red-300 dark:border-red-500/40"
                    : "border-green-300 dark:border-green-500/40"
              }`}
            >
              <p className="text-[11px] text-on-surface-muted uppercase tracking-wide mb-1">
                {creditBalance > 0 ? "Credit Due" : "Remaining Balance"}
              </p>
              <p
                className={`text-2xl font-bold ${
                  creditBalance > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : remainingBalance > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-green-700 dark:text-green-400"
                }`}
              >
                {formatCurrency(creditBalance > 0 ? creditBalance : remainingBalance)}
              </p>
              {/* The progress bar measures how much of the total has been applied,
                  which says nothing useful once more than the total came in - so an
                  over-settled invoice gets the explanation instead of the bar. */}
              {creditBalance > 0 ? (
                <p className="text-[11px] text-on-surface-muted mt-2.5">
                  Over-settled: refund or apply to another invoice
                </p>
              ) : totalAmount > 0 && (
                <div className="mt-2.5">
                  <div className="w-full bg-surface-alt rounded-full h-1.5 border border-outline-subtle">
                    <div
                      className="bg-blue-500 dark:bg-accent-solid h-1.5 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(((amountPaid + totalWrittenOff) / totalAmount) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-on-surface-muted mt-1">
                    {Math.round(Math.min(((amountPaid + totalWrittenOff) / totalAmount) * 100, 100))}% applied
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Body: tabbed detail (left) + payment rail (right) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {/* ── Left Column (2/3): tabbed card ── */}
            <div className="lg:col-span-2 bg-surface rounded-lg border border-outline shadow-sm overflow-hidden">
              {/* `pt-2` because the strip sits flush against the card's top edge:
                  the tab's own padding alone leaves the labels crowding the border. */}
              <TabBar
                className="px-5 pt-2"
                tabs={detailTabs.map((t) => ({ value: t.id, label: t.label }))}
                value={currentTab}
                onChange={setActiveTab}
                trailing={
                  // A split invoice holds one recipient's share of the matter's work,
                  // so its lines cannot be edited in isolation - the backend refuses
                  // them and the affordance would be a dead end.
                  currentTab === "items" && !invoice.splitGroupId && !lineEditor.open ? (
                    <RequirePermission permission="billing.manageInvoices">
                      <Tooltip title="Edit line items" enterDelay={300}>
                        <button
                          type="button"
                          onClick={() => lineEditor.setOpen(true)}
                          // Labelled explicitly because the text drops away on
                          // narrow screens, leaving an unnamed icon button.
                          aria-label="Edit line items"
                          // `shrink-0` and `whitespace-nowrap` together: as a flex
                          // child of the tab strip the button was free to shrink to
                          // its longest word, which broke the label over two lines
                          // and made the strip taller than its tabs.
                          className="cursor-pointer inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-md border border-outline-subtle bg-surface-alt text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Edit line items</span>
                        </button>
                      </Tooltip>
                    </RequirePermission>
                  ) : undefined
                }
              />

<InvoiceDetailLineItems detail={detail} />
<InvoiceDetailPlan detail={detail} />
<InvoiceDetailPayments detail={detail} />
            {/* Activity tab */}
            {currentTab === "activity" && sentCopies.length > 0 && (
              <div className="px-6 py-4 border-b border-outline-subtle">
                <h3 className="text-sm font-semibold text-on-surface">Sent copies</h3>
                <p className="mt-0.5 text-xs text-on-surface-muted">
                  The invoice exactly as it was emailed, kept for each send. Downloading the
                  invoice above gives you today&apos;s version instead.
                </p>
                <ErrorNotification
                  error={sentCopyError}
                  onClose={() => setSentCopyError(null)}
                  compact
                  className="mt-3"
                />
                <div className="mt-3 space-y-2">
                  {sentCopies.map((copy) => (
                    <div
                      key={copy.name}
                      className="flex items-center justify-between gap-3 rounded-lg border border-outline px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-on-surface">
                          {copy.sentAt
                            ? `Sent ${dayjs(copy.sentAt).format("MMM DD, YYYY h:mm A")}`
                            : "Sent copy"}
                        </p>
                        <p className="text-xs text-on-surface-muted">
                          {formatFileSize(copy.sizeBytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDownloadSentCopy(copy.name)}
                        disabled={downloadingCopy === copy.name}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-outline px-3 py-1.5 text-xs font-medium text-on-surface transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover disabled:opacity-50 cursor-pointer"
                      >
                        {downloadingCopy === copy.name ? <Spinner size={13} /> : <Download size={13} />}
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentTab === "activity" && auditLog.length > 0 && (
              <div>
                {(
                  <div className="px-6 py-4">
                    <div className="space-y-3">
                      {auditLog.map((entry, idx) => (
                        <div
                          key={idx}
                          className="flex items-start gap-3 text-xs"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-on-surface-muted mt-1.5 shrink-0" />
                          <div className="flex-1">
                            <p className="text-on-surface">
                              <span className="font-medium">{entry.action}</span>
                              {entry.amount !== undefined && (
                                <span className="text-on-surface-secondary">
                                  {" "}
                                  -- {formatCurrency(entry.amount)}
                                </span>
                              )}
                              {entry.description && (
                                <span className="text-on-surface-muted">
                                  {" "}
                                  -- {entry.description}
                                </span>
                              )}
                            </p>
                            <p className="text-on-surface-muted mt-0.5">
                              {resolveUserName(entry.performedBy)} --{" "}
                              {dayjs(entry.timestamp).format(
                                "MMM DD, YYYY h:mm A"
                              )}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            </div>

            {/* ── Right Column (1/3) ── */}
            <InvoiceDetailSummary detail={detail} />
          </div>

        </div>

        {/* ── Modals ── */}

<InvoiceDetailDialogs detail={detail} />
      {invoice && (
        <EditBillingEmailModal
          open={editBillingEmailOpen}
          onClose={() => setEditBillingEmailOpen(false)}
          onSaved={() => void loadInvoice({ background: true })}
          invoice={invoice}
          billingContext={billingContext as BillingContext}
          clientId={orgClientId || null}
          clientName={resolvedClientName || "the client"}
          canUpdateClient={!isCompanyClient && !!orgClientId && hasPermission("clients.manage")}
          currentEmails={currentBillingEmails}
        />
      )}
      </div>
    </RequirePermission>
  );
}
