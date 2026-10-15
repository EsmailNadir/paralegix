"use client";

import CreditNoteModal from "@/components/billingComp/CreditNoteModal";
import { useParams, useSearchParams } from "next/navigation";
import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import ConfirmAction from "@/components/ui/ConfirmAction";
import ConfirmModal from "@/components/ui/ConfirmModal";
import billingService from "@/services/billing.service";
import clientsService from "@/services/clients.service";
import trustService from "@/services/trust.service";
import { useNavigation } from "@/contexts/NavigationContext";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import type { Invoice, LawFirm } from "@/types";
import type { TrustAccount } from "@/types/trust";
import type { Client } from "@/types";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import RequirePermission from "@/components/ui/RequirePermission";
import BackButton from "@/components/ui/BackButton";
import RequestPaymentDialog from "@/components/billingComp/RequestPaymentDialog";
import CopyPaymentLinkButton from "@/components/billingComp/CopyPaymentLinkButton";
import PaymentSurchargeNote from "@/components/billingComp/PaymentSurchargeNote";
import PaymentCardFeeRefundNote from "@/components/billingComp/PaymentCardFeeRefundNote";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import Modal from "@/components/ui/Modal";
import { formatCurrency, getInvoiceCreditBalance, installmentAmountFromPaymentCount, parseRemitTo } from "@/components/billingComp/utils";
import Checkbox from "@/components/ui/Checkbox";
import { parsePlanAmountInput } from "@/components/billingComp/PaymentPlanFields";
import { usePermissions } from "@/contexts/PermissionsContext";
import { formatHoursMinutes } from "@/lib/utils/format";
import { parseMoneyInput } from "@/lib/utils/currency";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { useStripeStatus } from "@/hooks/billingHooks/useStripeStatus";
import StatusBadge from "@/components/ui/StatusBadge";
import { getInvoiceDisplayName, getInvoiceStatus, isClosedStatusKey } from "@/components/billingComp/utils";
import Tooltip from "@/components/ui/Tooltip";
import OrgAccessModal from "@/components/billingComp/OrgAccessModal";
import RecordPaymentModal from "@/components/billingComp/RecordPaymentModal";
import Th from "@/components/ui/Th";
import {
  Pencil,
  Trash2,
  Building2,
  CreditCard,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Download,
  Receipt,
  Landmark,
  CheckCircle2,
  Calendar,
  Hash,
} from "lucide-react";

export default function ClientInvoiceDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const { lawFirm } = useLawFirm();
  const { features } = useFirmSettings();
  const queryClient = useQueryClient();

  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const invoiceId = Array.isArray(params?.invoiceId) ? params.invoiceId[0] : (params?.invoiceId as string);
  const clientId = searchParams?.get("clientId") || "";

  const { users } = useLawFirmUsers(lawFirmId);
  const resolveUserName = useCallback(
    (uid: string) => {
      if (uid.toLowerCase() === "stripe") return "Stripe";
      const user = users.find((u) => u.uid === uid);
      return user ? user.name || user.email || uid : uid;
    },
    [users]
  );

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [, setLawFirmData] = useState<LawFirm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  // Set synchronously while a payment is recorded, edited or deleted, or a credit note
  // or payment plan is saved. State is not enough: a second click lands before the
  // re-render that disables the button.
  const paymentMutationInFlight = useRef(false);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  // Read from the shared per-firm cache, so it starts with the page. Without a
  // client the page loads nothing and renders no payment actions.
  const { status: stripeStatus } = useStripeStatus(lawFirmId, { enabled: !!clientId });

  // Payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAmountError, setPaymentAmountError] = useState<string | null>(null);
  // A refused payment is reported inside the Record Payment dialog. The page
  // banner sits under the dialog's backdrop, so writing it there would hide the
  // reason while the form stays open for a retry.
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentNote, setPaymentNote] = useState("");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  const [paymentInvoiceNumber, setPaymentInvoiceNumber] = useState("");
  const [paymentInstallmentIndex, setPaymentInstallmentIndex] = useState<number | null>(null);
  const [allowOverpayment, setAllowOverpayment] = useState(false);

  // Payment editing
  const [editingPayment, setEditingPayment] = useState<{ index: number; id?: string; amount: string; date: string; note: string } | null>(null);

  // Credit note modal
  const [showCreditNoteModal, setShowCreditNoteModal] = useState(false);
  const [showOrgAccessModal, setShowOrgAccessModal] = useState(false);
  const [creditNoteAmount, setCreditNoteAmount] = useState("");
  const [creditNoteDescription, setCreditNoteDescription] = useState("");
  const [creditNoteType, setCreditNoteType] = useState<"write_off" | "discount" | "adjustment">("write_off");
  // Reported inside the Add Credit Note dialog, for the same reason as `paymentError`.
  const [creditNoteError, setCreditNoteError] = useState<string | null>(null);

  // Payment plan modal
  const [showPaymentPlanModal, setShowPaymentPlanModal] = useState(false);
  const [planInstallment, setPlanInstallment] = useState("");
  const [planInstallmentMode, setPlanInstallmentMode] = useState<"amount" | "count">("amount");
  const [planPaymentCount, setPlanPaymentCount] = useState("");
  const [planFrequency, setPlanFrequency] = useState("30");
  const [planStartDate, setPlanStartDate] = useState("");
  // Reported inside the payment plan dialog, for the same reason as `paymentError`.
  const [planError, setPlanError] = useState<string | null>(null);

  // Trust accounting
  const [clientTrustBalance, setClientTrustBalance] = useState<{
    totalBalanceCents: number;
    accountBalances: Array<{ clientId: string; trustAccountId: string; balanceCents: number }>;
  } | null>(null);
  const [trustAccounts, setTrustAccounts] = useState<TrustAccount[]>([]);
  const [selectedTrustAccountId, setSelectedTrustAccountId] = useState<string>("");
  const [payFromTrust, setPayFromTrust] = useState(false);

  // Stripe
  const [showStripeConfirm, setShowStripeConfirm] = useState(false);
  const [voidingStripePayment, setVoidingStripePayment] = useState(false);
  const [showVoidStripeConfirm, setShowVoidStripeConfirm] = useState(false);

  // Delete invoice
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingInvoice, setDeletingInvoice] = useState(false);

  const closePaymentPlanModal = useCallback(() => setShowPaymentPlanModal(false), []);

  useResetAfterClose(showPaymentPlanModal, () => {
    setPlanPaymentCount("");
    setPlanInstallmentMode("amount");
  });

  const paymentPlanTitleId = useId();

  // Expandable sections
  const [expandedPayments, setExpandedPayments] = useState(true);
  const [expandedCreditNotes, setExpandedCreditNotes] = useState(true);

  const billingContext = { type: "client" as const, lawFirmId, entityId: clientId };

  const loadInvoice = useCallback(async () => {
    if (!lawFirmId || !invoiceId) return;
    if (!clientId) {
      setError("Client ID is required to view this invoice.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invoicesList = await billingService.listInvoices(billingContext);
      const found = invoicesList.find((inv) => inv.id === invoiceId);
      if (!found) {
        setError("Invoice not found");
        setLoading(false);
        return;
      }
      const totalAmount = typeof found.totalAmount === "number" ? found.totalAmount : parseFloat(String(found.totalAmount ?? 0)) || 0;
      const flatFeesAmount = typeof found.flatFeesAmount === "number" ? found.flatFeesAmount : parseFloat(String(found.flatFeesAmount ?? 0)) || 0;
      setInvoice({
        ...found,
        totalAmount,
        flatFeesAmount,
        amountPaid: found.amountPaid || 0,
        payments: found.payments || [],
        timeEntries: found.timeEntries ?? [],
        flatFees: found.flatFees ?? [],
        creditNotes: found.creditNotes || [],
        totalWrittenOff: found.totalWrittenOff || 0,
        remainingBalance: found.remainingBalance ?? totalAmount - (found.amountPaid || 0) - (found.totalWrittenOff || 0),
      });
      // Keep the calendar's payment markers in sync: they are derived from
      // invoice payment state, so a paid/unpaid change here must invalidate that
      // query instead of leaving a stale entry on the calendar.
      queryClient.invalidateQueries({ queryKey: ["billing", "paymentDates", lawFirmId] });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load invoice"));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lawFirmId, clientId, invoiceId]);

  const loadSupportData = useCallback(async () => {
    if (!lawFirmId || !clientId) return;
    try {
      setClient(await clientsService.getClient(lawFirmId, clientId));
    } catch (err) {
      console.error("Error loading support data:", err);
    }
  }, [lawFirmId, clientId]);

  useEffect(() => {
    if (lawFirmId && clientId && invoiceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: invoice and support data state set as requests resolve
      loadInvoice();
      loadSupportData();
    }
  }, [lawFirmId, clientId, invoiceId, loadInvoice, loadSupportData]);

  // The firm record (invoice letterhead / receipt remit-to defaults) is sourced
  // from the firm layout's shared context instead of a redundant per-invoice
  // fetch. Mirrors InvoiceDetailView.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the firm record from the shared layout context (external source)
    if (lawFirm) setLawFirmData(lawFirm);
  }, [lawFirm]);

  // Load trust balance. Skipped without the feature or without `trust.view`,
  // exactly as InvoiceDetailView skips it: the trust routes are behind
  // `requireFeature('trustAccounting')` and require `trust.view`, so otherwise
  // both calls are guaranteed refusals and the pay-from-trust block below can
  // never render.
  const trustEnabled = features.trustAccounting && hasPermission("trust.view");
  useEffect(() => {
    if (!lawFirmId || !clientId || !trustEnabled) return;
    Promise.all([
      trustService.getClientBalance(lawFirmId, clientId),
      trustService.listAccounts(lawFirmId),
    ]).then(([balance, accounts]) => {
      setClientTrustBalance(balance);
      const active = accounts.filter((a: TrustAccount) => a.status === "active");
      setTrustAccounts(active);
      if (active.length > 0 && !selectedTrustAccountId) {
        setSelectedTrustAccountId(active[0].id);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lawFirmId, clientId, trustEnabled]);

  // ── Derived values ──
  const totalAmount = invoice?.totalAmount || 0;
  const amountPaid = invoice?.amountPaid || 0;
  const totalWrittenOff = invoice?.totalWrittenOff || 0;
  const remainingBalance = Math.max(0, invoice?.remainingBalance ?? totalAmount - amountPaid - totalWrittenOff);
  // Money owed back to the client, non-zero only when the invoice is settled past
  // its total (editing line items below what was collected is what causes it).
  const creditBalance = invoice ? getInvoiceCreditBalance(invoice) : 0;
  const payments = invoice?.payments || [];
  const creditNotes = invoice?.creditNotes || [];
  const timeEntries = invoice?.timeEntries || [];
  const flatFees = invoice?.flatFees || [];
  // Derived from the rendered arrays rather than the denormalized flatFeesAmount
  // scalar, which can be stale (e.g. flat_fees_amount_cents never written for
  // legacy rows). Mirrors InvoicePDFDocument / InvoiceDetailView.
  const timeEntriesTotal = timeEntries.reduce((sum, entry: any) => sum + (Number(entry.amount) || 0), 0);
  const flatFeesTotal = flatFees.reduce((sum, fee: any) => sum + (Number(fee.amount) || 0), 0);
  const isPaid = isClosedStatusKey(invoice?.status) || invoice?.isPaid || false;
  const status = invoice ? getInvoiceStatus(invoice) : null;
  const remitTo = parseRemitTo(invoice?.remitTo);

  // ── Handlers ──

  const openPaymentModal = () => {
    setPaymentAmount(remainingBalance > 0 ? remainingBalance.toFixed(2) : "");
    setPaymentAmountError(null);
    setPaymentError(null);
    setPaymentNote("");
    setNextPaymentDate("");
    setPaymentInvoiceNumber("");
    setPaymentInstallmentIndex(null);
    setAllowOverpayment(false);
    setPayFromTrust(false);
    setShowPaymentModal(true);
  };

  const handleRecordPayment = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(paymentAmount);
    if ("error" in parsed) { setPaymentAmountError(parsed.error); return; }
    const amount = parsed.amount;
    if (amount > remainingBalance && !allowOverpayment) { setPaymentError('Payment exceeds remaining balance. Check "Allow overpayment" to proceed.'); return; }

    if (payFromTrust && selectedTrustAccountId) {
      const acctBal = clientTrustBalance?.accountBalances.find((b) => b.trustAccountId === selectedTrustAccountId);
      if (Math.round(amount * 100) > (acctBal?.balanceCents ?? 0)) {
        setPaymentError(`Insufficient trust balance. Available: ${formatCurrency((acctBal?.balanceCents ?? 0) / 100)}`);
        return;
      }
    }

    paymentMutationInFlight.current = true;
    setPaymentError(null);
    setUpdatingPayment(true);
    try {
      await billingService.updateInvoicePayment(billingContext, invoice.id, {
        paymentAmount: amount,
        paidDate: dayjs().format("YYYY-MM-DD"),
        nextPaymentDate: nextPaymentDate || null,
        allowOverpayment: amount > remainingBalance ? true : undefined,
        invoiceNumber: paymentInvoiceNumber.trim() || undefined,
        paymentNote: paymentNote.trim() || undefined,
        ...(paymentInstallmentIndex != null ? { installmentIndex: paymentInstallmentIndex } : {}),
        ...(payFromTrust && selectedTrustAccountId && clientId
          ? { paymentSource: "trust" as const, trustAccountId: selectedTrustAccountId, trustClientId: clientId, trustClientName: client?.name || client?.email || "" }
          : {}),
      });
      setShowPaymentModal(false);
      setClientTrustBalance(null);
      await loadInvoice();
    } catch (err) {
      setPaymentError(getErrorMessage(err, "Failed to record payment"));
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleEditPayment = async () => {
    if (!editingPayment || !invoice) return;
    const parsed = parseMoneyInput(editingPayment.amount);
    if ("error" in parsed) { setError(parsed.error); return; }
    const amount = parsed.amount;
    if (paymentMutationInFlight.current) return;
    paymentMutationInFlight.current = true;
    setUpdatingPayment(true);
    try {
      await billingService.editInvoicePayment(billingContext, invoice.id, {
        paymentId: editingPayment.id,
        paymentIndex: editingPayment.index,
        amount,
        date: editingPayment.date,
        note: editingPayment.note,
      });
      setEditingPayment(null);
      await loadInvoice();
    } catch (err: any) {
      setError(err.message || "Failed to edit payment");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleDeletePayment = async (payment: { index: number; id?: string }) => {
    if (!invoice) return;
    if (paymentMutationInFlight.current) return;
    paymentMutationInFlight.current = true;
    setUpdatingPayment(true);
    try {
      await billingService.deleteInvoicePayment(
        billingContext,
        invoice.id,
        payment.index,
        payment.id,
      );
      await loadInvoice();
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleAddCreditNote = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(creditNoteAmount);
    if ("error" in parsed) { setCreditNoteError(parsed.error); return; }
    const amount = parsed.amount;
    paymentMutationInFlight.current = true;
    setCreditNoteError(null);
    setUpdatingPayment(true);
    try {
      await billingService.addCreditNote(billingContext, invoice.id, {
        amount,
        description: creditNoteDescription || creditNoteType.replace("_", " "),
        type: creditNoteType,
      });
      setShowCreditNoteModal(false);
      setCreditNoteAmount("");
      setCreditNoteDescription("");
      setCreditNoteType("write_off");
      await loadInvoice();
    } catch (err: any) {
      setCreditNoteError(err.message || "Failed to add credit note");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleDeleteCreditNote = async (creditNoteId: string) => {
    if (!invoice) return;
    setUpdatingPayment(true);
    try {
      await billingService.deleteCreditNote(billingContext, invoice.id, creditNoteId);
      await loadInvoice();
    } finally {
      setUpdatingPayment(false);
    }
  };

  const handleSetPaymentPlan = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    if (remainingBalance <= 0) {
      setPlanError("Invoice has no remaining balance");
      return;
    }
    let amount: number;
    if (planInstallmentMode === "count") {
      const n = parseInt(planPaymentCount, 10);
      if (isNaN(n) || n < 1) {
        setPlanError("Enter a valid number of payments (at least 1)");
        return;
      }
      amount = installmentAmountFromPaymentCount(remainingBalance, n);
      if (isNaN(amount) || amount <= 0) {
        setPlanError("Could not compute installment amount for that number of payments");
        return;
      }
    } else {
      const parsed = parsePlanAmountInput(planInstallment, "Enter a valid installment amount");
      if (parsed.error !== undefined) {
        setPlanError(parsed.error);
        return;
      }
      amount = parsed.amount;
    }
    if (!planStartDate) { setPlanError("Select a start date"); return; }
    paymentMutationInFlight.current = true;
    setPlanError(null);
    setUpdatingPayment(true);
    try {
      await billingService.setPaymentPlan(billingContext, invoice.id, {
        installmentAmount: amount,
        frequencyDays: parseInt(planFrequency),
        planStartDate,
      });
      setShowPaymentPlanModal(false);
      setPlanInstallment("");
      setPlanPaymentCount("");
      setPlanInstallmentMode("amount");
      setPlanStartDate("");
      await loadInvoice();
    } catch (err: any) {
      setPlanError(err.message || "Failed to set payment plan");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleRemovePaymentPlan = async () => {
    if (!invoice) return;
    setUpdatingPayment(true);
    try {
      await billingService.removePaymentPlan(billingContext, invoice.id);
      await loadInvoice();
    } finally {
      setUpdatingPayment(false);
    }
  };

  const handleVoidStripePayment = async () => {
    if (!invoice) return;
    setVoidingStripePayment(true);
    try {
      await billingService.voidStripePaymentRequest(billingContext, invoice.id);
      setShowVoidStripeConfirm(false);
      await loadInvoice();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to void online payment"));
    } finally {
      setVoidingStripePayment(false);
    }
  };

  const handleDeleteInvoice = async () => {
    if (!invoice) return;
    setDeletingInvoice(true);
    try {
      await billingService.deleteInvoice(billingContext, invoice.id);
      navigate(`/lawfirm/${lawFirmId}/clients/${clientId}`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete invoice"));
      setDeletingInvoice(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!invoice) return;
    setGeneratingPDF(true);
    try {
      const { pdf: renderPdf } = await import("@react-pdf/renderer");
      const InvoicePDFDocument = (await import("@/components/billingComp/InvoicePDFDocument")).default;
      const blob = await renderPdf(
        <InvoicePDFDocument invoice={invoice} />
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Invoice-${invoice.invoiceName || invoice.id}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to generate PDF"));
    } finally {
      setGeneratingPDF(false);
    }
  };

  // Checked before the spinner: without a clientId the load effect never runs, so
  // `loading` would stay at its initial true and the page would spin forever.
  if (!clientId) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <p className="text-sm text-on-surface-secondary">Client ID is required. Please navigate here from a client record.</p>
      </div>
    );
  }

  if (loading) return <LoadingSpinner fullPage />;

  return (
    <RequirePermission permission="billing.viewInvoices" page>
      <div className="min-h-screen bg-page">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8">
          {/* Back navigation */}
          <BackButton
            href={`/lawfirm/${lawFirmId}/clients/${clientId}?tab=billing`}
            label={`Back to ${client?.name || "Client"} Billing`}
            variant="link"
            className="mb-6"
          />

          {error && (
            <div className="mb-4">
              <ErrorNotification error={error} onClose={() => setError(null)} />
            </div>
          )}

          {(!invoice) ? (
            <div className="text-center py-16">
              <p className="text-on-surface-secondary text-sm">Invoice not found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* ── Left Column (2/3) ── */}
              <div className="lg:col-span-2 space-y-6">
                {/* Invoice Header */}
                <div className="bg-surface rounded-lg border border-outline p-5 md:p-6 shadow-sm">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h1 className="text-2xl font-bold text-on-surface">
                          {invoice.invoiceName}
                        </h1>
                        {status && (
                          <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
                        )}
                      </div>
                      {invoice.createdAt && (
                        <p className="text-xs text-on-surface-muted mt-1">
                          Created {dayjs(invoice.createdAt).format("MMM DD, YYYY")}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Invoice details grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">Invoice Date</p>
                      <p className="text-on-surface font-medium">
                        {invoice.invoiceDate ? dayjs(invoice.invoiceDate).format("MMM DD, YYYY") : "-"}
                      </p>
                    </div>
                    {invoice.dueDate && (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">Due Date</p>
                        <p className="text-on-surface font-medium">{dayjs(invoice.dueDate).format("MMM DD, YYYY")}</p>
                      </div>
                    )}
                    {client && (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">Client</p>
                        {/* The roster behind this modal is a `clients.view`
                            read, so a billing-only role gets the name as plain
                            text rather than a button that opens a dialog which
                            can only fail to load. */}
                        {client.clientType === "company"
                          && hasPermission("clients.view") ? (
                          <Tooltip title="Click to view Organization members with billing & email access" enterDelay={300}>
                            <button
                              type="button"
                              onClick={() => setShowOrgAccessModal(true)}
                              className="group inline-flex items-center gap-1.5 cursor-pointer text-left rounded-md -mx-1 px-1 py-0.5 hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                            >
                              <Building2 className="w-3.5 h-3.5 text-accent-emphasis flex-shrink-0" />
                              <span className="text-on-surface font-medium group-hover:text-accent-emphasis group-hover:underline">
                                {client.name}
                              </span>
                            </button>
                          </Tooltip>
                        ) : (
                          <p className="text-on-surface font-medium">{client.name}</p>
                        )}
                        {client.email && <p className="text-on-surface-muted text-xs">{client.email}</p>}
                      </div>
                    )}
                    {invoice.billingEmail && (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">Billing Email</p>
                        <p className="text-on-surface font-medium break-all text-xs">{invoice.billingEmail}</p>
                      </div>
                    )}
                    {remitTo && (remitTo.name || remitTo.address) && (
                      <div>
                        <p className="text-on-surface-muted text-xs uppercase tracking-wide mb-1">Remit To</p>
                        <div className="text-on-surface text-xs space-y-0.5">
                          {remitTo.name && <p className="font-medium">{remitTo.name}</p>}
                          {remitTo.address && <p>{remitTo.address}</p>}
                          {(remitTo.city || remitTo.state || remitTo.zip) && (
                            <p>{[remitTo.city, remitTo.state, remitTo.zip].filter(Boolean).join(", ")}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {invoice.stripePaymentRequested && invoice.stripePaymentStatus !== "completed" && (
                    <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-700">
                      <CreditCard className="w-4 h-4 text-accent-emphasis" />
                      <span className="text-xs font-medium text-blue-700 dark:text-accent-emphasis">Online payment requested</span>
                    </div>
                  )}
                </div>

                {/* Time Entries */}
                {timeEntries.length > 0 && (
                  <div className="bg-surface rounded-lg border border-outline shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-outline">
                      <h2 className="text-base font-semibold text-on-surface">Time Entries</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-alt">
                          <tr>
                            <Th>Description</Th>
                            <Th align="right">Rate</Th>
                            <Th align="right">Hours</Th>
                            <Th align="right">Amount</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-subtle">
                          {timeEntries.map((entry, index) => (
                            <tr key={entry.id || index} className="hover:bg-surface-hover transition-colors">
                              <td className="px-5 py-3 text-on-surface">
                                <div className="font-medium">
                                  {entry.name || "Service"}
                                  {(entry as any).allocationPercent != null && (entry as any).allocationPercent < 100 && (
                                    <span className="text-xs text-on-surface-muted font-normal ml-1.5">({(entry as any).allocationPercent}%)</span>
                                  )}
                                </div>
                                {entry.description && <div className="text-xs text-on-surface-muted mt-0.5">{entry.description}</div>}
                              </td>
                              <td className="px-5 py-3 text-right text-on-surface tabular-nums">{formatCurrency(entry.rate || 0)}</td>
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
                        <tfoot>
                          <tr className="bg-surface-alt border-t border-outline">
                            <td colSpan={2} className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium">Total Hours:</td>
                            <td className="px-5 py-3 text-right text-on-surface font-semibold tabular-nums">
                              {formatHoursMinutes(invoice.totalHours || 0)}
                            </td>
                            <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">
                              {formatCurrency(timeEntriesTotal)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Flat Fees */}
                {flatFees.length > 0 && (
                  <div className="bg-surface rounded-lg border border-outline shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-outline">
                      <h2 className="text-base font-semibold text-on-surface">Flat Fees</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-alt">
                          <tr>
                            <Th>Description</Th>
                            <Th align="right">Amount</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-subtle">
                          {flatFees.map((fee, index) => (
                            <tr key={fee.id || `fee-${index}`} className="hover:bg-surface-hover transition-colors">
                              <td className="px-5 py-3 text-on-surface">
                                {fee.description}
                                {(fee as any).allocationPercent != null && (fee as any).allocationPercent < 100 && (
                                  <span className="text-xs text-on-surface-muted ml-1.5">({(fee as any).allocationPercent}%)</span>
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
                            <td className="px-5 py-3 text-right text-on-surface-secondary text-xs font-medium">Total Flat Fees:</td>
                            <td className="px-5 py-3 text-right text-on-surface font-bold tabular-nums">{formatCurrency(flatFeesTotal)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Notes */}
                {invoice.notes && (
                  <div className="bg-surface rounded-lg border border-outline p-6 shadow-sm">
                    <h2 className="text-base font-semibold text-on-surface mb-3">Notes</h2>
                    <p className="text-sm text-on-surface-secondary whitespace-pre-wrap leading-relaxed">{invoice.notes}</p>
                  </div>
                )}

                {/* Payments Section */}
                {payments.length > 0 && (
                  <div className="bg-surface rounded-lg border border-outline shadow-sm overflow-hidden">
                    <button
                      onClick={() => setExpandedPayments((e) => !e)}
                      className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-hover transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg">
                          <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <span className="text-sm font-semibold text-on-surface">
                          Payments ({payments.length})
                        </span>
                        <span className="text-sm text-on-surface-muted">Total: {formatCurrency(amountPaid)}</span>
                      </div>
                      {expandedPayments ? <ChevronUp className="w-4 h-4 text-on-surface-muted" /> : <ChevronDown className="w-4 h-4 text-on-surface-muted" />}
                    </button>

                    {expandedPayments && (
                      <div className="border-t border-outline overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-surface-alt">
                            <tr>
                              <Th>Date</Th>
                              <Th align="right">Amount</Th>
                              <Th>Note</Th>
                              <Th>Recorded By</Th>
                              <Th align="right">Actions</Th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-outline-subtle">
                            {payments.map((pmt, idx) => (
                              <tr key={idx} className="hover:bg-surface-hover transition-colors">
                                {editingPayment?.index === idx ? (
                                  <>
                                    <td className="px-5 py-2">
                                      <DatePicker
                                        value={editingPayment.date}
                                        onChange={(value) => setEditingPayment({ ...editingPayment, date: value })}
                                        className="w-full"
                                      />
                                    </td>
                                    <td className="px-5 py-2">
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={editingPayment.amount}
                                        onChange={(e) => setEditingPayment({ ...editingPayment, amount: e.target.value })}
                                        className="w-full text-xs border border-input-border rounded px-2 py-1 bg-input-bg text-on-surface text-right"
                                      />
                                    </td>
                                    <td className="px-5 py-2" colSpan={2}>
                                      <input
                                        type="text"
                                        value={editingPayment.note}
                                        onChange={(e) => setEditingPayment({ ...editingPayment, note: e.target.value })}
                                        placeholder="Note"
                                        className="w-full text-xs border border-input-border rounded px-2 py-1 bg-input-bg text-on-surface"
                                      />
                                    </td>
                                    <td className="px-5 py-2">
                                      <div className="flex items-center justify-end gap-1">
                                        <Button onClick={handleEditPayment} type="primary" size="small" disabled={updatingPayment}>Save</Button>
                                        <Button onClick={() => setEditingPayment(null)} type="secondary" size="small">Cancel</Button>
                                      </div>
                                    </td>
                                  </>
                                ) : (
                                  <>
                                    <td className="px-5 py-3 text-on-surface-secondary whitespace-nowrap">
                                      {dayjs(pmt.date).format("MMM DD, YYYY")}
                                    </td>
                                    <td className="px-5 py-3 text-right font-medium text-on-surface">
                                      {formatCurrency(pmt.amount)}
                                      {pmt.paymentSource === "trust" && (
                                        <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
                                          <Landmark size={9} /> Trust
                                        </span>
                                      )}
                                      {pmt.paymentSource === "stripe" && (
                                        <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                                          <CreditCard size={9} /> Stripe
                                        </span>
                                      )}
                                      <PaymentSurchargeNote surchargeCents={pmt.surchargeCents} />
                                    </td>
                                    <td className="px-5 py-3 text-on-surface-muted">
                                      {pmt.note || "-"}
                                      <PaymentCardFeeRefundNote payment={pmt} />
                                    </td>
                                    <td className="px-5 py-3 text-on-surface-secondary">{resolveUserName(pmt.recordedBy || "")}</td>
                                    <td className="px-5 py-3">
                                      <div className="flex items-center justify-end gap-1">
                                        <ActionIconButton
                                          label="Edit payment"
                                          onClick={() => setEditingPayment({ index: idx, id: pmt.id, amount: pmt.amount.toFixed(2), date: pmt.date ? dayjs(pmt.date).format("YYYY-MM-DD") : "", note: pmt.note || "" })}
                                          size="sm"
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </ActionIconButton>
                                        <ConfirmAction title="Delete Payment" message={`Delete payment of ${formatCurrency(pmt.amount)} from ${dayjs(pmt.date).format("MMM DD, YYYY")}? This will update the invoice balance.`} confirmText="Delete" onConfirm={() => handleDeletePayment({ index: idx, id: pmt.id })} stacked>
                                          {(request) => (
                                            <ActionIconButton
                                              label="Delete payment"
                                              onClick={request}
                                              tone="danger"
                                              size="sm"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </ActionIconButton>
                                          )}
                                        </ConfirmAction>
                                      </div>
                                    </td>
                                  </>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Credit Notes Section */}
                {creditNotes.length > 0 && (
                  <div className="bg-surface rounded-lg border border-outline shadow-sm overflow-hidden">
                    <button
                      onClick={() => setExpandedCreditNotes((e) => !e)}
                      className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-hover transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-purple-50 dark:bg-purple-500/10 rounded-lg">
                          <Receipt className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                        </div>
                        <span className="text-sm font-semibold text-on-surface">
                          Credits / Adjustments ({creditNotes.length})
                        </span>
                        <span className="text-sm text-on-surface-muted">Total: {formatCurrency(totalWrittenOff)}</span>
                      </div>
                      {expandedCreditNotes ? <ChevronUp className="w-4 h-4 text-on-surface-muted" /> : <ChevronDown className="w-4 h-4 text-on-surface-muted" />}
                    </button>

                    {expandedCreditNotes && (
                      <div className="border-t border-outline overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-surface-alt">
                            <tr>
                              <Th>Date</Th>
                              <Th>Type</Th>
                              <Th>Description</Th>
                              <Th align="right">Amount</Th>
                              <Th align="right">Actions</Th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-outline-subtle">
                            {creditNotes.map((cn) => (
                              <tr key={cn.id} className="hover:bg-surface-hover transition-colors">
                                <td className="px-5 py-3 text-on-surface-secondary whitespace-nowrap">
                                  {cn.createdAt ? dayjs(cn.createdAt).format("MMM DD, YYYY") : "-"}
                                </td>
                                <td className="px-5 py-3">
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400">
                                    {(cn as any).type?.replace("_", " ") || "credit"}
                                  </span>
                                </td>
                                <td className="px-5 py-3 text-on-surface-muted">{cn.description || cn.label || "-"}</td>
                                <td className="px-5 py-3 text-right font-medium text-purple-700 dark:text-purple-400">
                                  -{formatCurrency(cn.amount)}
                                </td>
                                <td className="px-5 py-3 text-right">
                                  <ConfirmAction title="Remove Credit Note" message={`Remove credit note "${cn.description || cn.type}" (${formatCurrency(cn.amount)})? This will update the invoice balance.`} onConfirm={() => handleDeleteCreditNote(cn.id)} stacked>
                                    {(request) => (
                                      <ActionIconButton
                                        label="Remove credit note"
                                        onClick={request}
                                        tone="danger"
                                        size="sm"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </ActionIconButton>
                                    )}
                                  </ConfirmAction>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Right Column (1/3) ── */}
              <div className="space-y-5 md:space-y-4 lg:sticky lg:top-6 self-start">
                {/* Summary Card */}
                <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-on-surface mb-4">Summary</h2>
                  <div className="space-y-3">
                    {timeEntries.length > 0 && (
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-on-surface-secondary">Time Entries</span>
                        <span className="text-on-surface font-medium">{formatCurrency(timeEntriesTotal)}</span>
                      </div>
                    )}
                    {flatFeesTotal > 0 && (
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-on-surface-secondary">Flat Fees</span>
                        <span className="text-on-surface font-medium">{formatCurrency(flatFeesTotal)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between gap-3 text-sm pt-2 border-t border-outline-subtle">
                      <span className="text-on-surface font-medium">Subtotal</span>
                      <span className="text-on-surface font-semibold">{formatCurrency(totalAmount)}</span>
                    </div>
                    {totalWrittenOff > 0 && (
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-on-surface-secondary">Credits / Adjustments</span>
                        <span className="text-red-600 dark:text-red-400 font-medium">-{formatCurrency(totalWrittenOff)}</span>
                      </div>
                    )}
                    {amountPaid > 0 && (
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-on-surface-secondary">Paid</span>
                        <span className="text-green-700 dark:text-green-400 font-medium">{formatCurrency(amountPaid)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-baseline pt-3 border-t-2 border-outline">
                      <span className="text-sm text-on-surface font-bold">
                        {creditBalance > 0 ? "Credit Due" : "Remaining Balance"}
                      </span>
                      <span className={`text-lg font-bold ${creditBalance > 0 ? "text-amber-600 dark:text-amber-400" : remainingBalance > 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}>
                        {formatCurrency(creditBalance > 0 ? creditBalance : remainingBalance)}
                      </span>
                    </div>
                  </div>

                  {!isPaid && amountPaid > 0 && totalAmount > 0 && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between text-xs text-on-surface-muted mb-1">
                        <span>{Math.round(((amountPaid + totalWrittenOff) / totalAmount) * 100)}% applied</span>
                        <span>{formatCurrency(remainingBalance)} remaining</span>
                      </div>
                      <div className="w-full bg-surface-alt rounded-full h-2 border border-outline">
                        <div
                          className="bg-blue-500 dark:bg-accent-solid h-2 rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(((amountPaid + totalWrittenOff) / totalAmount) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions Card */}
                <div className="bg-surface rounded-lg border border-outline p-4 md:p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-on-surface mb-3">Actions</h2>
                  <div className="space-y-2">
                    {/* Trust balance banner */}
                    {!isPaid && clientTrustBalance && clientTrustBalance.totalBalanceCents > 0 && (
                      <div className="flex items-center justify-between rounded-lg bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-3 py-2 mb-1">
                        <div className="flex items-center gap-2">
                          <Landmark size={13} className="text-accent-emphasis shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-accent-emphasis dark:text-accent-emphasis leading-tight">Trust Balance</p>
                            <p className="text-xs text-accent-emphasis dark:text-accent-emphasis">{formatCurrency(clientTrustBalance.totalBalanceCents / 100)} available</p>
                          </div>
                        </div>
                        {clientTrustBalance.totalBalanceCents >= Math.round(remainingBalance * 100) && (
                          <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                            Covers balance
                          </span>
                        )}
                      </div>
                    )}

                    {!isPaid && (
                      <>
                        <Button onClick={openPaymentModal} type="primary" size="small" className="w-full" disabled={updatingPayment} icon={<DollarSign className="w-4 h-4" />}>
                          Record Payment
                        </Button>
                        <Button
                          onClick={() => { setCreditNoteAmount(""); setCreditNoteDescription(""); setCreditNoteType("write_off"); setCreditNoteError(null); setShowCreditNoteModal(true); }}
                          type="secondary" size="small" className="w-full" disabled={updatingPayment} icon={<Receipt className="w-4 h-4" />}
                        >
                          Add Credit Note
                        </Button>
                        {!invoice.paymentPlan?.enabled && (
                          <Button
                            onClick={() => {
                              setPlanInstallment("");
                              setPlanPaymentCount("");
                              setPlanInstallmentMode("amount");
                              setPlanStartDate(dayjs().add(7, "day").format("YYYY-MM-DD"));
                              setPlanError(null);
                              setShowPaymentPlanModal(true);
                            }}
                            type="secondary" size="small" className="w-full" disabled={updatingPayment}
                          >
                            Setup Payment Plan
                          </Button>
                        )}
                        {invoice.paymentPlan?.enabled && (
                          <ConfirmAction title="Remove Payment Plan" message="Remove this payment plan? Recorded payments will remain on the invoice." onConfirm={handleRemovePaymentPlan} stacked>
                            {(request) => (
                              <Button onClick={request} type="secondary" size="small" className="w-full" disabled={updatingPayment}>
                                Remove Payment Plan
                              </Button>
                            )}
                          </ConfirmAction>
                        )}
                        {/* Stripe controls show busy while the status is read, and
                            stay only for an account that can take charges. */}
                        {(stripeStatus === "loading" || stripeStatus === "ready") && !invoice.stripePaymentRequested && (
                          <Button onClick={() => setShowStripeConfirm(true)} type="secondary" size="small" className="w-full" disabled={updatingPayment} loading={stripeStatus === "loading"} icon={<CreditCard className="w-4 h-4" />}>
                            Request Payment via Stripe
                          </Button>
                        )}
                        {invoice.stripePaymentRequested && invoice.stripePaymentStatus === "pending" && invoice.paymentLinkUrl && (
                          <CopyPaymentLinkButton url={invoice.paymentLinkUrl} />
                        )}
                        {(stripeStatus === "loading" || stripeStatus === "ready") && invoice.stripePaymentRequested && invoice.stripePaymentStatus !== "completed" && (
                          <Button onClick={() => setShowVoidStripeConfirm(true)} type="secondary" size="small" className="w-full" disabled={voidingStripePayment} loading={stripeStatus === "loading"}>
                            Cancel Payment Link
                          </Button>
                        )}
                      </>
                    )}

                    {isPaid && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30">
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
                        <span className="text-xs font-medium text-green-800 dark:text-green-300">Invoice Paid</span>
                      </div>
                    )}

                    <Button onClick={handleDownloadPdf} type="secondary" size="small" className="w-full" loading={generatingPDF} disabled={generatingPDF} icon={<Download className="w-4 h-4" />}>
                      Download Invoice
                    </Button>

                    {hasPermission("billing.manageInvoices") && (
                      <Button onClick={() => setShowDeleteConfirm(true)} type="danger" size="small" className="w-full" icon={<Trash2 className="w-4 h-4" />}>
                        Delete Invoice
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Payment Modal ── */}
        {invoice && (
          <RecordPaymentModal
            open={showPaymentModal}
            onClose={() => setShowPaymentModal(false)}
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
                <div className="rounded-lg border border-accent-border-soft dark:border-accent-border-soft bg-accent-soft dark:bg-accent-soft p-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={payFromTrust}
                      onChange={setPayFromTrust}
                    />
                    <span className="text-xs font-medium text-accent-emphasis dark:text-accent-emphasis">
                      Pay from trust account ({formatCurrency(clientTrustBalance.totalBalanceCents / 100)} available)
                    </span>
                  </label>
                  {payFromTrust && trustAccounts.length > 1 && (
                    <Dropdown
                      value={selectedTrustAccountId}
                      onChange={setSelectedTrustAccountId}
                      options={trustAccounts.map((acct) => ({
                        value: acct.id,
                        label: acct.name,
                      }))}
                      className="mt-2"
                      buttonClassName="text-xs px-2 py-1 bg-input-bg border-input-border rounded"
                      portal
                    />
                  )}
                </div>
              ) : undefined
            }
          />
        )}

        {/* ── Credit Note Modal ── */}
        {invoice && (
          <CreditNoteModal open={showCreditNoteModal} onClose={() => setShowCreditNoteModal(false)}
            presentation="client" saving={updatingPayment} onSave={handleAddCreditNote} error={creditNoteError}
            invoiceName={invoice.invoiceName} remaining={formatCurrency(remainingBalance)}
            type={creditNoteType} onTypeChange={setCreditNoteType}
            amount={creditNoteAmount} onAmountChange={setCreditNoteAmount}
            description={creditNoteDescription} onDescriptionChange={setCreditNoteDescription} />
        )}

        {/* ── Payment Plan Modal ── */}
        <Modal
          isOpen={showPaymentPlanModal && !!invoice}
          onClose={closePaymentPlanModal}
          labelledBy={paymentPlanTitleId}
          showClose={false}
          size="xl"
          className="rounded-2xl border border-outline shadow-2xl overflow-hidden"
          bodyClassName={null}
        >
          {invoice && (
            <>
              {/* Header */}
              <div className="border-b border-outline-subtle bg-gradient-to-br from-surface-alt/80 to-surface-alt/30 px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-emphasis">
                      <Calendar className="h-[18px] w-[18px]" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <h3 id={paymentPlanTitleId} className="text-base font-semibold tracking-tight text-on-surface truncate">
                        Set up payment plan
                      </h3>
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
              <div className="px-6 py-5 max-h-[min(68vh,560px)] overflow-y-auto overflow-x-hidden styled-scrollbar space-y-4">
                <ErrorNotification error={planError} compact />
                {/* 1. Installment Strategy Card */}
                <div className="rounded-xl border border-outline-subtle bg-surface-alt/25 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
                    <Hash className="h-3.5 w-3.5 text-accent-emphasis" aria-hidden />
                    <span>Installment Strategy</span>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <label
                      className={`relative flex cursor-pointer select-none items-start gap-2.5 rounded-xl border p-3 transition-all duration-150 focus-within:ring-2 focus-within:ring-focus-ring/35 focus-within:ring-offset-2 focus-within:ring-offset-surface ${
                        planInstallmentMode === "count"
                          ? "border-accent-border-soft bg-accent-soft dark:bg-accent-solid/10"
                          : "border-outline-subtle bg-input-bg/40 hover:border-outline hover:bg-surface-hover"
                      }`}
                    >
                      <input
                        type="radio"
                        name="clientPlanInstallmentMode"
                        checked={planInstallmentMode === "count"}
                        onChange={() => setPlanInstallmentMode("count")}
                        className="sr-only"
                      />
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          planInstallmentMode === "count"
                            ? "bg-accent-soft text-accent-emphasis"
                            : "bg-surface-alt text-on-surface-muted"
                        }`}
                      >
                        <Hash className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold leading-tight text-on-surface">Split into N</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-on-surface-muted">Divide balance into equal payments</span>
                      </span>
                    </label>
                    <label
                      className={`relative flex cursor-pointer select-none items-start gap-2.5 rounded-xl border p-3 transition-all duration-150 focus-within:ring-2 focus-within:ring-focus-ring/35 focus-within:ring-offset-2 focus-within:ring-offset-surface ${
                        planInstallmentMode === "amount"
                          ? "border-accent-border-soft bg-accent-soft dark:bg-accent-solid/10"
                          : "border-outline-subtle bg-input-bg/40 hover:border-outline hover:bg-surface-hover"
                      }`}
                    >
                      <input
                        type="radio"
                        name="clientPlanInstallmentMode"
                        checked={planInstallmentMode === "amount"}
                        onChange={() => setPlanInstallmentMode("amount")}
                        className="sr-only"
                      />
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          planInstallmentMode === "amount"
                            ? "bg-accent-soft text-accent-emphasis"
                            : "bg-surface-alt text-on-surface-muted"
                        }`}
                      >
                        <DollarSign className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold leading-tight text-on-surface">Fixed amount</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-on-surface-muted">Set fixed dollar amount per payment</span>
                      </span>
                    </label>
                  </div>

                  {planInstallmentMode === "count" ? (
                    <div className="space-y-3 pt-1">
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-on-surface-secondary">
                          Quick Presets
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {[2, 3, 4, 6].map((num) => (
                            <button
                              key={num}
                              type="button"
                              onClick={() => setPlanPaymentCount(String(num))}
                              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                                planPaymentCount === String(num)
                                  ? "bg-accent-solid text-on-accent-solid shadow-sm"
                                  : "border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover"
                              }`}
                            >
                              {num} payments
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1 pt-1">
                        <label className="block text-xs font-medium text-on-surface">
                          Number of payments <span aria-hidden="true">*</span>
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={planPaymentCount}
                          onChange={(e) => setPlanPaymentCount(e.target.value)}
                          className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-focus-ring/25"
                          placeholder="e.g. 4"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1 pt-1">
                      <label className="block text-xs font-medium text-on-surface">
                        Installment amount <span aria-hidden="true">*</span>
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={planInstallment}
                          onChange={(e) => setPlanInstallment(e.target.value)}
                          className="w-full rounded-lg border border-input-border bg-input-bg py-2 pl-8 pr-3 text-sm text-on-surface shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-focus-ring/25"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 2. Schedule & Timing Card */}
                <div className="rounded-xl border border-outline-subtle bg-surface-alt/25 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
                    <Calendar className="h-3.5 w-3.5 text-accent-emphasis" aria-hidden />
                    <span>Schedule & Timing</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Dropdown
                        label="Frequency *"
                        labelClassName="text-xs font-medium text-on-surface mb-1"
                        value={planFrequency}
                        onChange={setPlanFrequency}
                        options={[
                          { value: "30", label: "Monthly" },
                          { value: "14", label: "Bi-weekly" },
                          { value: "7", label: "Weekly" },
                        ]}
                        buttonClassName="w-full rounded-lg border-input-border bg-input-bg py-2 shadow-sm"
                        portal
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-on-surface mb-1">
                        First payment date <span aria-hidden="true">*</span>
                      </label>
                      <DatePicker
                        value={planStartDate}
                        onChange={setPlanStartDate}
                      />
                    </div>
                  </div>
                </div>

                {/* Live Payment Schedule Breakdown */}
                {(() => {
                  const freq = parseInt(planFrequency, 10);
                  if (remainingBalance <= 0 || isNaN(freq) || freq < 1) return null;

                  const scheduleRows: { label: string; date: string; amount: number }[] = [];
                  const startDay = planStartDate ? dayjs(planStartDate) : null;

                  if (planInstallmentMode === "count") {
                    const n = parseInt(planPaymentCount, 10);
                    if (!isNaN(n) && n > 0 && remainingBalance > 0) {
                      const per = installmentAmountFromPaymentCount(remainingBalance, n);
                      let runningSum = 0;
                      for (let i = 0; i < n; i++) {
                        const amt = i === n - 1 ? Number((remainingBalance - runningSum).toFixed(2)) : per;
                        runningSum += amt;
                        const dueDateStr = startDay
                          ? freq === 30
                            ? startDay.add(i, "month").format("MMM DD, YYYY")
                            : startDay.add(i * freq, "day").format("MMM DD, YYYY")
                          : `Payment ${i + 1}`;
                        scheduleRows.push({
                          label: `Installment ${i + 1} of ${n}`,
                          date: dueDateStr,
                          amount: amt,
                        });
                      }
                    }
                  } else {
                    const amt = parseFloat(planInstallment);
                    if (!isNaN(amt) && amt > 0 && remainingBalance > 0) {
                      const count = Math.ceil(remainingBalance / amt);
                      let currentRem = remainingBalance;
                      for (let i = 0; i < count; i++) {
                        const itemAmt = i === count - 1 ? Number(currentRem.toFixed(2)) : amt;
                        currentRem -= itemAmt;
                        const dueDateStr = startDay
                          ? freq === 30
                            ? startDay.add(i, "month").format("MMM DD, YYYY")
                            : startDay.add(i * freq, "day").format("MMM DD, YYYY")
                          : `Payment ${i + 1}`;
                        scheduleRows.push({
                          label: `Installment ${i + 1} of ${count}`,
                          date: dueDateStr,
                          amount: itemAmt,
                        });
                      }
                    }
                  }

                  if (scheduleRows.length === 0) return null;

                  const totalAccounted = scheduleRows.reduce((acc, r) => acc + r.amount, 0);

                  return (
                    <div className="space-y-2 rounded-xl border border-outline-subtle bg-surface p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
                          Generated Schedule Preview ({scheduleRows.length} payment{scheduleRows.length !== 1 ? "s" : ""})
                        </span>
                        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>{formatCurrency(totalAccounted)} of {formatCurrency(remainingBalance)}</span>
                        </div>
                      </div>
                      <div className="overflow-hidden rounded-lg border border-outline-subtle text-xs">
                        <table className="w-full text-left">
                          <thead className="bg-surface-alt/60 font-medium text-on-surface-muted border-b border-outline-subtle">
                            <tr>
                              <th className="px-3 py-2">Payment</th>
                              <th className="px-3 py-2">Due Date</th>
                              <th className="px-3 py-2 text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-outline-subtle text-on-surface">
                            {scheduleRows.map((row, idx) => (
                              <tr key={idx} className="hover:bg-surface-hover">
                                <td className="px-3 py-2 font-medium">{row.label}</td>
                                <td className="px-3 py-2 text-on-surface-secondary">{row.date}</td>
                                <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(row.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="flex justify-end gap-3 border-t border-outline-subtle bg-surface-alt/40 px-6 py-4">
                <Button
                  onClick={closePaymentPlanModal}
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
                  loading={updatingPayment}
                >
                  Save plan
                </Button>
              </div>
            </>
          )}
        </Modal>

        <RequestPaymentDialog
          open={showStripeConfirm}
          onClose={() => setShowStripeConfirm(false)}
          onRequested={() => loadInvoice()}
          billingContext={billingContext}
          invoiceId={invoice?.id}
          paymentPlan={invoice?.paymentPlan}
          hasOpenLink={invoice?.stripePaymentRequested === true && invoice?.stripePaymentStatus === "pending"}
        />

        <ConfirmModal
          isOpen={showVoidStripeConfirm}
          onClose={() => setShowVoidStripeConfirm(false)}
          onConfirm={handleVoidStripePayment}
          title="Cancel Payment Link"
          message="The client will no longer be able to pay with the current link. You can send a new one afterward."
          confirmText="Cancel Payment Link"
          cancelText="Keep Link"
          loading={voidingStripePayment}
        />

        <ConfirmModal
          isOpen={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={handleDeleteInvoice}
          title="Delete Invoice"
          message="Are you sure you want to delete this invoice? This action cannot be undone."
          confirmText="Delete Invoice"
          loading={deletingInvoice}
        />

        {client && (
          <OrgAccessModal
            isOpen={showOrgAccessModal}
            onClose={() => setShowOrgAccessModal(false)}
            lawFirmId={lawFirmId}
            clientId={client.id}
            clientName={client.name || "Organization"}
          />
        )}
      </div>
    </RequirePermission>
  );
}
