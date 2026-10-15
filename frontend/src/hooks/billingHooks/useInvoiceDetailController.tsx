"use client";

import InvoicePDFDocument from "@/components/billingComp/InvoicePDFDocument";
import {
buildPaymentPlanPayload,
MAX_PLAN_INSTALLMENTS,
type PaymentPlanFormValues
} from "@/components/billingComp/PaymentPlanFields";
import PaymentReceiptPDFDocument from "@/components/billingComp/PaymentReceiptPDFDocument";
import { addPaymentPlanPeriod, isInstallmentLocked } from "@/components/billingComp/invoiceDetailHelpers";
import type { InvoiceDetailViewProps } from "@/components/billingComp/invoiceDetailTypes";
import {
formatCurrency,
getInvoiceBillTo,
getInvoiceCreditBalance,
getInvoiceStatus,
getInvoiceStatusKey,
isClosedStatusKey,
isRecurringRetainerInvoice,
parseRemitTo
} from "@/components/billingComp/utils";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useInvoiceLineItemEditor } from "@/hooks/billingHooks/useInvoiceLineItemEditor";
import { useStripeStatus } from "@/hooks/billingHooks/useStripeStatus";
import { useLastOpenValue,useResetAfterClose } from "@/hooks/useMountTransition";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { track } from "@/lib/analytics/analytics";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { MONEY_DECIMALS_MESSAGE,parseMoneyInput } from "@/lib/utils/currency";
import { isPastDueBeyond } from "@/lib/utils/dateUtils";
import type { InvoiceSentCopy,PaymentPayload } from "@/services/billing.service";
import billingService from "@/services/billing.service";
import clientsService from "@/services/clients.service";
import MattersService from "@/services/matters.service";
import messagesService from "@/services/messages.service";
import trustService from "@/services/trust.service";
import type { BillingContext,Client,Invoice,LawFirm,MatterClient } from "@/types";
import type { TrustAccount } from "@/types/trust";
import { pdf } from "@react-pdf/renderer";
import { useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useCallback,useEffect,useId,useRef,useState } from "react";


// ── Helpers ──

type DraftInstallment = {
  key: string;
  dueDate: string;
  amount: number;
  manualAmount?: boolean;
  /** The typed amount had more than two decimal places; saving is refused until it is fixed. */
  subCent?: boolean;
};


export default function useInvoiceDetailController({
  lawFirmId,
  entityId,
  invoiceId,
  contextType,
  backHref,
  backLabel,
}: InvoiceDetailViewProps) {
  const fieldIds = useId();
  // Heading ids for the dialogs built with `ui/Modal` in this view; each is
  // passed as `labelledBy` so Modal's aria-labelledby points at the caller's
  // own <h2>, since every one of these keeps its original header markup.
  const sendInvoiceTitleId = useId();
  const addAmountTitleId = useId();
  const creditNoteTitleId = useId();
  const paymentPlanTitleId = useId();
  const installmentTitleId = useId();
  const editPlanTitleId = useId();
  const { navigate } = useNavigation();
  const { settings: firmSettings, features } = useFirmSettings();
  const { hasPermission } = usePermissions();
  const canManageInvoices = hasPermission("billing.manageInvoices");
  // Gates the organization-roster shortcut on the "Client" line: the modal it
  // opens reads the company's related clients, which needs `clients.view`.
  const canViewClients = hasPermission("clients.view");
  const canRecordPayments = hasPermission("billing.recordPayments");
  const readOnlyInvoice = !canManageInvoices && !canRecordPayments;
  // Connecting or finishing Stripe happens on the Payments settings page, which
  // only a member who can manage the firm can act on.
  const canManageFirmSettings = hasPermission("settings.manageFirm");
  // Read from the shared per-firm cache, so it starts with the page rather than
  // after the invoice and its clients have loaded.
  const {
    status: stripeStatus,
    directCharges: stripeDirectCharges,
    retry: retryStripeStatus,
  } = useStripeStatus(lawFirmId);
  const queryClient = useQueryClient();
  // ── Users for name resolution ──
  const { users } = useLawFirmUsers(lawFirmId);
  const resolveUserName = useCallback(
    (uid: string) => {
      if (uid.toLowerCase() === 'stripe') return 'Stripe';
      const user = users.find((u) => u.uid === uid);
      return user ? user.name || user.email || uid : uid;
    },
    [users]
  );

  // ── State ──
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lawFirmData, setLawFirmData] = useState<LawFirm | null>(null);
  const { lawFirm } = useLawFirm();
  const [matterClients, setMatterClients] = useState<MatterClient[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [portalClients, setPortalClients] = useState<Client[]>([]);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  // Set synchronously while any save that moves money is in flight: recording, editing,
  // deleting or un-paying a payment or installment, a credit note, an added amount, a
  // reschedule or a new payment plan. State is not enough: a second click lands before
  // the re-render that disables the button.
  const paymentMutationInFlight = useRef(false);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [exportingLedes, setExportingLedes] = useState(false);
  const [refreshingRecipients, setRefreshingRecipients] = useState(false);
  const [downloadingReceiptIdx, setDownloadingReceiptIdx] = useState<number | null>(null);
  const [viewingReceiptIdx, setViewingReceiptIdx] = useState<number | null>(null);
  const [showSendInvoiceModal, setShowSendInvoiceModal] = useState(false);
  const [sendingInvoiceToPortal, setSendingInvoiceToPortal] = useState(false);
  const [sendInvoiceError, setSendInvoiceError] = useState<string | null>(null);
  const [sendInvoiceSuccess, setSendInvoiceSuccess] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState("");
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
  const [previewReceiptPdfUrl, setPreviewReceiptPdfUrl] = useState<string | null>(null);
  const [previewReceiptDownloadName, setPreviewReceiptDownloadName] = useState<string>("");

  // Payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAmountError, setPaymentAmountError] = useState<string | null>(null);
  // A refused payment is reported inside the Record Payment dialog. The view's
  // banner sits under the dialog's backdrop, so writing it there would hide the
  // reason while the form stays open for a retry.
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentInvoiceNumber, setPaymentInvoiceNumber] = useState("");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  // Which plan installment (if any) the Record Payment dialog should settle.
  const [paymentInstallmentIndex, setPaymentInstallmentIndex] = useState<number | null>(null);
  const [allowOverpayment, setAllowOverpayment] = useState(false);

  // Payment editing
  const [editingPayment, setEditingPayment] = useState<{
    index: number;
    id?: string;
    amount: string;
    date: string;
    note: string;
    invoiceNumber: string;
  } | null>(null);
  // Kept separate from `editingPayment` so the dialog's exit animation has data to
  // render while it plays; the payment is only cleared on the next open.
  const [editPaymentOpen, setEditPaymentOpen] = useState(false);
  // Reported inside the Edit payment dialog, for the same reason as `paymentError`.
  const [editPaymentError, setEditPaymentError] = useState<string | null>(null);
  const [deletePaymentConfirm, setDeletePaymentConfirm] = useState<{
    index: number;
    id?: string;
    amount: number;
    date: string;
  } | null>(null);
  // Reported inside the Delete payment confirm, for the same reason as `paymentError`.
  const [deletePaymentError, setDeletePaymentError] = useState<string | null>(null);

  // Credit note modal
  const [showCreditNoteModal, setShowCreditNoteModal] = useState(false);
  const [creditNoteAmount, setCreditNoteAmount] = useState("");
  const [creditNoteDescription, setCreditNoteDescription] = useState("");
  const [creditNoteType, setCreditNoteType] = useState<"write_off" | "discount" | "adjustment">(
    "write_off"
  );
  // Reported inside the Add Credit Note dialog, for the same reason as `paymentError`.
  const [creditNoteError, setCreditNoteError] = useState<string | null>(null);

  // Add amount modal
  const [showAddAmountModal, setShowAddAmountModal] = useState(false);
  const [addAmountValue, setAddAmountValue] = useState("");
  const [addAmountNote, setAddAmountNote] = useState("");
  // Reported inside the Add Amount dialog, for the same reason as `paymentError`.
  const [addAmountError, setAddAmountError] = useState<string | null>(null);

  // Payment plan modal
  const [showPaymentPlanModal, setShowPaymentPlanModal] = useState(false);
  // Reported inside the payment plan dialog, for the same reason as `paymentError`.
  const [planError, setPlanError] = useState<string | null>(null);
  const [planInstallment, setPlanInstallment] = useState("");
  const [planFrequency, setPlanFrequency] = useState("30");
  const [planFrequencyCustom, setPlanFrequencyCustom] = useState("");
  const [planStartDate, setPlanStartDate] = useState("");
  const [planDownPayment, setPlanDownPayment] = useState("");
  const [planDownPaymentPaid, setPlanDownPaymentPaid] = useState(false);
  const [planDownPaymentDueDate, setPlanDownPaymentDueDate] = useState("");
  const [planInstallmentMode, setPlanInstallmentMode] = useState<"amount" | "count">("amount");
  const [planPaymentCount, setPlanPaymentCount] = useState("");

  // The plan form lives in a shared component; these adapt this view's
  // individual fields to its single value object.
  const planValues: PaymentPlanFormValues = {
    installmentMode: planInstallmentMode,
    paymentCount: planPaymentCount,
    installmentAmount: planInstallment,
    frequency: planFrequency,
    frequencyCustom: planFrequencyCustom,
    startDate: planStartDate,
    downPayment: planDownPayment,
    downPaymentPaid: planDownPaymentPaid,
    downPaymentDueDate: planDownPaymentDueDate,
  };
  const applyPlanPatch = (patch: Partial<PaymentPlanFormValues>) => {
    if (patch.installmentMode !== undefined) setPlanInstallmentMode(patch.installmentMode);
    if (patch.paymentCount !== undefined) setPlanPaymentCount(patch.paymentCount);
    if (patch.installmentAmount !== undefined) setPlanInstallment(patch.installmentAmount);
    if (patch.frequency !== undefined) setPlanFrequency(patch.frequency);
    if (patch.frequencyCustom !== undefined) setPlanFrequencyCustom(patch.frequencyCustom);
    if (patch.startDate !== undefined) setPlanStartDate(patch.startDate);
    if (patch.downPayment !== undefined) setPlanDownPayment(patch.downPayment);
    if (patch.downPaymentPaid !== undefined) setPlanDownPaymentPaid(patch.downPaymentPaid);
    if (patch.downPaymentDueDate !== undefined) setPlanDownPaymentDueDate(patch.downPaymentDueDate);
  };

  const [showAllInstallments, setShowAllInstallments] = useState(false);
  const [showAllPayments, setShowAllPayments] = useState(false);

  // Installment editing (explicit Edit → Confirm; draft is YYYY-MM-DD for DatePicker)
  const [editingInstallmentDate, setEditingInstallmentDate] = useState<number | null>(null);
  const [installmentDateDraft, setInstallmentDateDraft] = useState("");
  const [payingInstallment, setPayingInstallment] = useState<{ index: number; amount: number } | null>(null);
  const [installmentPayAmount, setInstallmentPayAmount] = useState("");
  const [installmentAmountError, setInstallmentAmountError] = useState<string | null>(null);
  // A refused installment payment or reschedule, reported inside the installment
  // dialog for the same reason as `paymentError`.
  const [installmentError, setInstallmentError] = useState<string | null>(null);
  const [shortfallAction, setShortfallAction] = useState<"write_off" | "add_to_next" | "add_to_current">("write_off");
  const [installmentModalTab, setInstallmentModalTab] = useState<"record" | "reschedule">("record");
  const [installmentPaymentInvoiceNumber, setInstallmentPaymentInvoiceNumber] = useState("");
  const [installmentPaymentNote, setInstallmentPaymentNote] = useState("");
  const [installmentPayFromTrust, setInstallmentPayFromTrust] = useState(false);
  const [installmentDelayMode, setInstallmentDelayMode] = useState<"next_period" | "custom">("next_period");
  const [installmentDelayCustomDate, setInstallmentDelayCustomDate] = useState("");
  const [showOrgAccessModal, setShowOrgAccessModal] = useState(false);
  const [extraBilledClient, setExtraBilledClient] = useState<Client | null>(null);

  // Bulk schedule editing: turns the unpaid installments into an editable draft.
  // A draft that doesn't sum to the target shows a mismatch banner with explicit
  // remedies (split evenly / add to last / new installment) rather than silently
  // redistributing amounts the user typed.
  const [planEditing, setPlanEditing] = useState(false);
  const [draftInstallments, setDraftInstallments] = useState<DraftInstallment[]>([]);
  const [draftFrequency, setDraftFrequency] = useState<number>(30);
  const [draftFreqIsCustom, setDraftFreqIsCustom] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [dateShiftPrompt, setDateShiftPrompt] = useState<{ rowKey: string; offsetDays: number } | null>(null);

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
  // The plan row (`ExpectedPayment.id`) the Request Payment dialog opens on;
  // null opens it on the full remaining balance.
  const [requestInstallmentId, setRequestInstallmentId] = useState<string | null>(null);
  const [voidingStripePayment, setVoidingStripePayment] = useState(false);
  const [showVoidStripeConfirm, setShowVoidStripeConfirm] = useState(false);
  const [showRemovePlanConfirm, setShowRemovePlanConfirm] = useState(false);

  // Edit invoice details
  const [editingDetails, setEditingDetails] = useState(false);
  const [editName, setEditName] = useState("");
  const [editNumber, setEditNumber] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editRemitToName, setEditRemitToName] = useState("");
  const [editRemitToAddress, setEditRemitToAddress] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);

  // Delete invoice
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [voidingInvoice, setVoidingInvoice] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deletingInvoice, setDeletingInvoice] = useState(false);

  // Detail tabs + header overflow menu
  const [activeTab, setActiveTab] = useState<
    "items" | "payments" | "plan" | "credits" | "activity"
  >("items");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuPos, setMoreMenuPos] = useState<{ anchorTop: number; anchorBottom: number; right: number } | null>(null);

  // Brief tint on the installment the Next Payment field refers to, after
  // jumping to the schedule from it, so that row is easy to pick out.
  const [highlightedInstallmentIdx, setHighlightedInstallmentIdx] = useState<number | null>(null);
  const planPanelRef = useRef<HTMLDivElement>(null);
  const planHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (planHighlightTimer.current) clearTimeout(planHighlightTimer.current);
  }, []);

  const goToPaymentPlan = () => {
    const nextIdx = (invoice?.paymentPlan?.expectedPayments || []).findIndex(
      (ep) => ep.status === "pending" || ep.status === "overdue"
    );
    setActiveTab("plan");
    setHighlightedInstallmentIdx(nextIdx >= 0 ? nextIdx : null);
    // Wait for the tab panel to mount before scrolling to it.
    requestAnimationFrame(() => {
      planPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    if (planHighlightTimer.current) clearTimeout(planHighlightTimer.current);
    planHighlightTimer.current = setTimeout(() => setHighlightedInstallmentIdx(null), 900);
  };

  // The previews close by clearing their url. Keep the last one in the iframe
  // while the panel animates out, or the PDF turns blank as it fades.
  const shownReceiptPdfUrl = useLastOpenValue(!!previewReceiptPdfUrl, previewReceiptPdfUrl);
  const shownInvoicePdfUrl = useLastOpenValue(!!previewPdfUrl, previewPdfUrl);

  // Retain the last installment so its exit animation still has data to render
  // after the underlying state is cleared on close.
  const lastInstallmentRef = useRef(payingInstallment);
  if (payingInstallment) lastInstallmentRef.current = payingInstallment;
  const activeInstallment = payingInstallment ?? lastInstallmentRef.current;

  // ── Billing context helper ──
  const billingContext = { type: contextType, lawFirmId, entityId };

  // ── Line-item editing ──
  const lineEditor = useInvoiceLineItemEditor({
    context: billingContext as BillingContext,
    invoice,
    onSaved: setInvoice,
  });

  // ── Data loading ──

  // This view loads with plain `useState`/`useEffect`, not React Query, so
  // nothing else stops a slow `loadInvoice` call for the OLD invoiceId from
  // overwriting state after the viewer has already navigated to a different
  // invoice (browser back/forward can reuse this same page instance rather
  // than remounting it). Every call claims the next id; a call whose id no
  // longer matches the ref by the time it resolves lost the race and skips
  // applying its result.
  const loadRequestIdRef = useRef(0);

  const loadInvoice = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!lawFirmId || !entityId || !invoiceId) return;
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => loadRequestIdRef.current === requestId;
    if (!background) setLoading(true);
    setError(null);
    try {
      const ctx = { type: contextType, lawFirmId, entityId };
      const invoicesList = await billingService.listInvoices(ctx);
      if (!isCurrentRequest()) return;
      const found = invoicesList.find((inv) => inv.id === invoiceId);
      if (!found) {
        setError("Invoice not found");
        setLoading(false);
        return;
      }
      // Normalize fields
      const totalAmount =
        typeof found.totalAmount === "number"
          ? found.totalAmount
          : parseFloat(String(found.totalAmount ?? 0)) || 0;
      const totalHours =
        typeof found.totalHours === "number"
          ? found.totalHours
          : parseFloat(String(found.totalHours ?? 0)) || 0;
      const flatFeesAmount =
        typeof found.flatFeesAmount === "number"
          ? found.flatFeesAmount
          : parseFloat(String(found.flatFeesAmount ?? 0)) || 0;

      setInvoice({
        ...found,
        totalAmount,
        totalHours,
        flatFeesAmount,
        amountPaid: found.amountPaid || 0,
        payments: found.payments || [],
        timeEntries: found.timeEntries ?? [],
        flatFees: found.flatFees ?? [],
        expenses: found.expenses ?? [],
        creditNotes: found.creditNotes || [],
        totalWrittenOff: found.totalWrittenOff || 0,
        auditLog: found.auditLog || [],
        remainingBalance:
          found.remainingBalance ??
          totalAmount - (found.amountPaid || 0) - (found.totalWrittenOff || 0),
      });
      // The calendar's payment markers are derived from invoice payment state
      // (getCalendarPaymentDates). Mark that query stale on every successful
      // (re)load so paying/unpaying an installment or invoice removes or updates
      // the marker instead of leaving a stale entry on the calendar.
      queryClient.invalidateQueries({ queryKey: ["billing", "paymentDates", lawFirmId] });
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error("Error loading invoice:", err);
      setError(getErrorMessage(err, "Failed to load invoice"));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [lawFirmId, entityId, invoiceId, contextType, queryClient]);

  const loadSupportData = useCallback(async () => {
    if (!lawFirmId || !entityId) return;
    try {
      if (contextType === "matter") {
        const clients = await MattersService.listClients(lawFirmId, entityId);
        const availablePortalClients = clients.length > 0
          ? await clientsService.lookupClients(lawFirmId, {
              ids: clients.map((item) => item.id),
              portalOnly: true,
              full: true,
              limit: Math.min(200, clients.length),
            }).then((result) => result.items as unknown as Client[])
          : [];
        setMatterClients(clients);
        setPortalClients(availablePortalClients);
      } else {
        const [clientData, portalResult] = await Promise.all([
          clientsService.getClient(lawFirmId, entityId),
          clientsService.lookupClients(lawFirmId, {
            ids: [entityId],
            portalOnly: true,
            full: true,
            limit: 1,
          }),
        ]);
        setClient(clientData);
        setPortalClients(portalResult.items as unknown as Client[]);
      }
    } catch (err) {
      console.error("Error loading support data:", err);
    }
  }, [lawFirmId, entityId, contextType]);

  useEffect(() => {
    if (lawFirmId && entityId && invoiceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers async data fetches on mount/id change
      loadInvoice();
      loadSupportData();
    }
  }, [lawFirmId, entityId, invoiceId, loadInvoice, loadSupportData]);

  // The firm record (invoice letterhead / receipt remit-to defaults) is sourced from
  // the firm layout's shared context instead of a redundant per-invoice fetch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the firm record from the shared layout context (external source)
    if (lawFirm) setLawFirmData(lawFirm);
  }, [lawFirm]);

  // Load client trust balance. Skipped without the plan feature (the trust
  // routes are behind `requireFeature('trustAccounting')`) and without
  // `trust.view` (both routes require it): either way both calls are guaranteed
  // refusals and no trust UI can appear anyway.
  const trustClientId = contextType === "matter" ? invoice?.clientId : entityId;
  const trustEnabled = features.trustAccounting && hasPermission("trust.view");
  useEffect(() => {
    if (!lawFirmId || !trustClientId || !trustEnabled) return;
    Promise.all([
      trustService.getClientBalance(lawFirmId, trustClientId),
      trustService.listAccounts(lawFirmId),
    ]).then(([balance, accounts]) => {
      setClientTrustBalance(balance);
      const active = accounts.filter((a: TrustAccount) => a.status === "active");
      setTrustAccounts(active);
      if (active.length > 0 && !selectedTrustAccountId) {
        setSelectedTrustAccountId(active[0].id);
      }
    }).catch(() => {
      // Trust is best-effort, don't block invoice display
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lawFirmId, trustClientId, trustEnabled]);

  // ── Derived values ──
  const totalAmount = invoice?.totalAmount || 0;
  const totalHours = invoice?.totalHours || 0;
  const amountPaid = invoice?.amountPaid || 0;
  const totalWrittenOff = invoice?.totalWrittenOff || 0;
  const remainingBalance = Math.max(
    0,
    invoice?.remainingBalance ?? totalAmount - amountPaid - totalWrittenOff
  );
  // Non-zero only when the invoice is settled past its total - money owed back to
  // the client rather than by them. Editing line items down below what has already
  // been collected is what produces it.
  const creditBalance = invoice ? getInvoiceCreditBalance(invoice) : 0;
  const payments = invoice?.payments || [];
  const creditNotes = invoice?.creditNotes || [];
  const timeEntries = invoice?.timeEntries || [];
  const flatFees = invoice?.flatFees || [];
  const expenses = invoice?.expenses || [];
  const auditLog = invoice?.auditLog || [];
  // Derived from the rendered arrays rather than the denormalized invoice
  // scalars, which can be stale (e.g. flat_fees_amount_cents never written for
  // legacy rows) and, for totalAmount, include tax/expenses/adjustments that
  // don't belong in a "time entries only" subtotal. Mirrors InvoicePDFDocument.
  const timeEntriesTotal = timeEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const flatFeesTotal = flatFees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0);
  const expensesTotal = expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0);
  // "Add amount" and late fees raise the invoice total without creating a line
  // item row, so without these an invoice built only from adjustments rendered
  // as "No line items" above a non-zero total.
  const amountAdjustments = invoice?.amountAdjustmentNotes || [];
  const adjustmentsTotal = amountAdjustments.reduce(
    (sum, adjustment) => sum + (Number(adjustment.amount) || 0),
    0
  );
  // Preserved copies of this invoice as it was emailed. Loaded separately from
  // the invoice because they live in storage, not on the row.
  const [sentCopies, setSentCopies] = useState<InvoiceSentCopy[]>([]);
  const [downloadingCopy, setDownloadingCopy] = useState<string | null>(null);
  const [sentCopyError, setSentCopyError] = useState<string | null>(null);

  const refreshSentCopies = useCallback(async () => {
    if (!lawFirmId || !invoiceId) return;
    try {
      setSentCopies(await billingService.listInvoiceSentCopies(lawFirmId, invoiceId));
    } catch {
      // A missing send history is not worth interrupting the invoice for; the
      // section simply stays empty.
    }
  }, [lawFirmId, invoiceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: the sent-copy list is loaded on mount and sets state when it resolves
    void refreshSentCopies();
  }, [refreshSentCopies]);

  const handleDownloadSentCopy = async (name: string) => {
    setDownloadingCopy(name);
    setSentCopyError(null);
    try {
      await billingService.downloadInvoiceSentCopy(lawFirmId, invoiceId, name);
    } catch (err) {
      setSentCopyError(getErrorMessage(err));
    } finally {
      setDownloadingCopy(null);
    }
  };
  // Derived from the live amounts, not the stored status column, so a legacy
  // row whose column was never rewritten still reads correctly here.
  const invoiceStatusKey = invoice ? getInvoiceStatusKey(invoice) : null;
  // Closed also covers voided: every action gated on this is a way to collect money.
  const isPaid = isClosedStatusKey(invoiceStatusKey) || invoice?.isPaid || false;
  const status = invoice ? getInvoiceStatus(invoice) : null;
  // Late fee eligibility (UI gating only; the backend enforces the grace period).
  const lateFeeSettings = firmSettings.billing.lateFee;
  const lateFeeAlreadyApplied = (invoice?.amountAdjustmentNotes || []).some(
    (a: { kind?: string | null }) => a?.kind === "late_fee",
  );
  const lateFeeDueRaw = invoice?.nextPaymentDate || invoice?.dueDate;
  // `isBeforeToday` compares against the VIEWER's local calendar day.
  // Comparing the raw string against `new Date().toISOString().slice(0, 10)`
  // (UTC today) used to make this button eligible up to a day early for a
  // viewer BEHIND UTC (US zones included): UTC's calendar day rolls over
  // while it is still afternoon/evening there, so a due date of "today" for
  // that viewer already read as "past" against UTC's date. The backend
  // enforces the real grace period regardless, but the button itself should
  // not invite a click it is about to refuse.
  // Past the due day PLUS the grace period, as the backend requires; showing the
  // button during the grace period invited a click the backend then refused.
  const lateFeePastDue = lateFeeDueRaw
    ? isPastDueBeyond(lateFeeDueRaw, Number(lateFeeSettings?.graceDays) || 0)
    : false;
  const canApplyLateFee =
    !!lateFeeSettings?.enabled &&
    !isPaid &&
    remainingBalance > 0 &&
    lateFeePastDue &&
    !lateFeeAlreadyApplied;
  const taxAmount = invoice?.taxAmount || 0;
  const subtotalAmount = invoice?.subtotalAmount ?? totalAmount - taxAmount;
  const taxLabel = firmSettings.billing.tax?.label || "Tax";
  // A failed check never shows the setup card: telling a connected firm to
  // connect Stripe is worse than saying the check failed.
  const showStripeSetupCard =
    !isPaid &&
    canRecordPayments &&
    (stripeStatus === "not_connected" || stripeStatus === "needs_setup") &&
    !invoice?.stripePaymentRequested;
  // invoices.client_id and matter_client_id both hold a clients.id, so they match
  // a matter client's `id`. They were being compared against `userId`, the portal
  // account id, which never matches: every matter invoice then fell through to
  // matterClients[0] and this page named the matter's first client as the payer,
  // whoever the invoice was actually billed to. No fallback now: an invoice with
  // no client attached has no billing client to show.
  const invoiceBilledClientId = invoice?.clientId || invoice?.matterClientId || null;

  useEffect(() => {
    if (!lawFirmId || !invoiceBilledClientId) return;
    const existing =
      (contextType === "matter"
        ? matterClients.find((c) => c.id === invoiceBilledClientId)
        : client) || extraBilledClient;
    if (existing && existing.id === invoiceBilledClientId) return;

    clientsService
      .getClient(lawFirmId, invoiceBilledClientId)
      .then((c) => {
        if (c) setExtraBilledClient(c);
      })
      .catch(() => {});
  }, [lawFirmId, invoiceBilledClientId, matterClients, client, extraBilledClient, contextType]);

  const billingClient =
    (contextType === "matter"
      ? (matterClients.find((c) => c.id === invoiceBilledClientId) || null)
      : client) || extraBilledClient || null;
  const resolvedClient = billingClient || (contextType === "client" ? client : null) || extraBilledClient;

  // Snapshot-first bill-to resolution, shared with the PDF and the portal
  // invoice page so all three agree on who this invoice is billed to.
  const billTo = invoice ? getInvoiceBillTo(invoice, resolvedClient) : null;
  const isCompanyClient =
    resolvedClient?.clientType === "company" ||
    (client as any)?.clientType === "company" ||
    billTo?.isCompany === true;
  const orgClientId =
    resolvedClient?.id || (client as any)?.id || invoice?.clientId || invoice?.matterClientId || "";
  const orgClientName =
    billTo?.name || resolvedClient?.name || (client as any)?.name || invoice?.clientName || "Organization";
  const resolvedClientName =
    billTo?.name || resolvedClient?.name || (contextType === "client" ? client?.name : null) || invoice?.clientName || null;

  const invoiceLinkedClientName =
    (invoiceBilledClientId
      ? matterClients.find((matterClient) => matterClient.id === invoiceBilledClientId)?.name
      : null) ||
    (contextType === "client" ? client?.name ?? null : null) ||
    resolvedClientName ||
    "This client";
  const portalRecipient = portalClients.find((portalClient) => {
    if (invoiceBilledClientId && portalClient.id === invoiceBilledClientId) return true;
    if (contextType === "client" && portalClient.id === entityId) return true;
    if (invoice?.matterClientId && portalClient.id === invoice.matterClientId) return true;
    return false;
  }) || null;
  const portalRecipientUserId = portalRecipient?.userId || null;
  const canSendInvoiceToPortal = Boolean(portalRecipientUserId);
  const portalSendHelperText = !portalRecipientUserId
    ? "This invoice is not linked to a client portal account."
    : canSendInvoiceToPortal
      ? `Send directly to ${portalRecipient?.name || invoiceLinkedClientName} in the client portal.`
      : `${invoiceLinkedClientName} isn't in the client portal yet.`;
  const remitTo = parseRemitTo(invoice?.remitTo);
  const recurringRetainerInvoice = invoice ? isRecurringRetainerInvoice(invoice) : false;

  // Detail tabs: plan/credits/activity tabs only appear when they have content
  const detailTabs: { id: "items" | "payments" | "plan" | "credits" | "activity"; label: string }[] = [
    { id: "items", label: "Line Items" },
    { id: "payments", label: `Payments (${payments.length})` },
    ...(invoice?.paymentPlan?.enabled ? [{ id: "plan" as const, label: "Payment Plan" }] : []),
    ...(creditNotes.length > 0
      ? [{ id: "credits" as const, label: `Credit Notes (${creditNotes.length})` }]
      : []),
    ...(auditLog.length > 0 || sentCopies.length > 0
      ? [{ id: "activity" as const, label: "Activity" }]
      : []),
  ];
  const currentTab = detailTabs.some((t) => t.id === activeTab) ? activeTab : "items";

  // ── Handlers ──

  const closeSendInvoiceModal = () => setShowSendInvoiceModal(false);

  useResetAfterClose(showSendInvoiceModal, () => {
    setSendInvoiceError(null);
    setSendInvoiceSuccess(null);
    setEmailRecipient("");
  });

  const handleSendInvoiceByEmail = async () => {
    if (!invoice || !emailRecipient.trim()) return;
    setSendInvoiceError(null);
    setSendInvoiceSuccess(null);
    setSendingEmail(true);
    try {
      const { blob, fileName } = await createInvoicePdfBlob();
      // The rendered PDF goes to storage on its own leg. It used to be
      // base64 in the request body, which walked the whole document one byte
      // at a time in this tab and then held it three times over in the API.
      const data = await billingService.sendInvoiceEmail(
        { type: contextType, lawFirmId, entityId },
        invoiceId,
        {
          recipientEmail: emailRecipient.trim(),
          recipientName: invoiceLinkedClientName !== "This client" ? invoiceLinkedClientName : undefined,
          pdf: new File([blob], fileName, { type: "application/pdf" }),
        },
      );
      if (data.sent) {
        track("invoice_sent", { channel: "email", context_type: contextType });
        const sentTo = Array.isArray(data.to) && data.to.length > 0 ? data.to.join(", ") : emailRecipient.trim();
        setSendInvoiceSuccess(`Invoice emailed to ${sentTo}.`);
        setEmailRecipient("");
        // The send just produced a preserved copy; show it without a reload.
        void refreshSentCopies();
      } else {
        setSendInvoiceError(data.reason || "Failed to send email.");
      }
    } catch (err) {
      setSendInvoiceError(getErrorMessage(err, "Failed to send invoice email."));
    } finally {
      setSendingEmail(false);
    }
  };

  const openPaymentModal = (fromTrust = false) => {
    setPaymentAmount(remainingBalance > 0 ? remainingBalance.toFixed(2) : "");
    setPaymentAmountError(null);
    setPaymentError(null);
    setPaymentNote("");
    setNextPaymentDate("");
    setAllowOverpayment(false);
    setPayFromTrust(fromTrust);
    setPaymentInstallmentIndex(null);
    setShowPaymentModal(true);
  };

  const handleRecordPayment = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(paymentAmount);
    if ("error" in parsed) {
      setPaymentAmountError(parsed.error);
      return;
    }
    const amount = parsed.amount;
    if (amount > remainingBalance && !allowOverpayment) {
      setPaymentError('Payment exceeds remaining balance. Check "Allow overpayment" to proceed.');
      return;
    }

    // Validate trust balance if paying from trust
    if (payFromTrust && selectedTrustAccountId) {
      const selectedAcctBal = clientTrustBalance?.accountBalances.find(
        (b) => b.trustAccountId === selectedTrustAccountId
      );
      const availableCents = selectedAcctBal?.balanceCents ?? 0;
      if (Math.round(amount * 100) > availableCents) {
        setPaymentError(
          `Insufficient trust balance in selected account. Available: ${formatCurrency(availableCents / 100)}`
        );
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
        ...(payFromTrust && selectedTrustAccountId && (contextType === "matter" ? invoice.clientId : entityId)
          ? {
              paymentSource: "trust" as const,
              trustAccountId: selectedTrustAccountId,
              trustClientId: contextType === "matter" ? (invoice.clientId ?? undefined) : entityId,
              trustClientName: billingClient?.name || billingClient?.email || "",
            }
          : {}),
      });
      setShowPaymentModal(false);
      setPaymentInvoiceNumber("");
      setPaymentNote("");
      setClientTrustBalance(null); // force re-fetch so trust banner updates
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
    if ("error" in parsed) {
      setEditPaymentError(parsed.error);
      return;
    }
    const amount = parsed.amount;
    if (paymentMutationInFlight.current) return;
    paymentMutationInFlight.current = true;
    setEditPaymentError(null);
    setUpdatingPayment(true);
    try {
      await billingService.editInvoicePayment(billingContext, invoice.id, {
        paymentId: editingPayment.id,
        paymentIndex: editingPayment.index,
        amount,
        date: editingPayment.date,
        note: editingPayment.note,
        invoiceNumber: editingPayment.invoiceNumber.trim() || null,
      });
      setEditPaymentOpen(false);
      await loadInvoice();
    } catch (err: any) {
      setEditPaymentError(err.message || "Failed to edit payment");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleDeletePayment = async () => {
    if (!deletePaymentConfirm || !invoice) return;
    if (paymentMutationInFlight.current) return;
    paymentMutationInFlight.current = true;
    setDeletePaymentError(null);
    setUpdatingPayment(true);
    try {
      await billingService.deleteInvoicePayment(
        billingContext,
        invoice.id,
        deletePaymentConfirm.index,
        deletePaymentConfirm.id
      );
      setDeletePaymentConfirm(null);
      await loadInvoice();
    } catch (err: any) {
      setDeletePaymentError(err.message || "Failed to delete payment");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleAddCreditNote = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(creditNoteAmount);
    if ("error" in parsed) {
      setCreditNoteError(parsed.error);
      return;
    }
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

  const handleAddAmount = async () => {
    if (!invoice || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(addAmountValue);
    if ("error" in parsed) {
      setAddAmountError(parsed.error);
      return;
    }
    const amount = parsed.amount;
    paymentMutationInFlight.current = true;
    setAddAmountError(null);
    setUpdatingPayment(true);
    try {
      await billingService.addAmountToInvoice(billingContext, invoice.id, {
        amount,
        note: addAmountNote.trim() || undefined,
      });
      setShowAddAmountModal(false);
      setAddAmountValue("");
      setAddAmountNote("");
      await loadInvoice();
    } catch (err: any) {
      setAddAmountError(err.message || "Failed to add amount to invoice");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleApplyLateFee = async () => {
    if (!invoice) return;
    setUpdatingPayment(true);
    try {
      await billingService.applyLateFee(billingContext, invoice.id);
      await loadInvoice();
    } catch (err: any) {
      setError(err.message || "Failed to apply late fee");
    } finally {
      setUpdatingPayment(false);
    }
  };

  /**
   * Deliberately replace this invoice's frozen bill-to snapshot with the
   * client's current billing recipients - the one sanctioned way to correct a
   * bill issued against a stale or wrong roster, per
   * `billingRecipientSnapshot.service.ts`'s `refreshInvoiceRecipients`. Refetches
   * the whole invoice afterward rather than merging the response by hand, so
   * this reads back through the exact same `billing_*` fields every other
   * bill-to surface trusts.
   */
  const handleRefreshBillingRecipients = async () => {
    if (!invoice) return;
    setRefreshingRecipients(true);
    try {
      await billingService.refreshBillingRecipients(billingContext, invoice.id);
      await loadInvoice();
    } catch (err: any) {
      setError(getErrorMessage(err, "Failed to refresh billing recipients"));
    } finally {
      setRefreshingRecipients(false);
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
    const planResult = buildPaymentPlanPayload(planValues, remainingBalance);
    if (!planResult.payload) {
      setPlanError(planResult.error);
      return;
    }
    paymentMutationInFlight.current = true;
    setPlanError(null);
    setUpdatingPayment(true);
    try {
      await billingService.setPaymentPlan(billingContext, invoice.id, planResult.payload);
      setShowPaymentPlanModal(false);
      setPlanInstallment("");
      setPlanPaymentCount("");
      setPlanInstallmentMode("amount");
      setPlanStartDate("");
      setPlanDownPayment("");
      setPlanDownPaymentPaid(false);
      setPlanDownPaymentDueDate("");
      setPlanFrequencyCustom("");
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
    } catch (err: any) {
      setError(err.message || "Failed to remove payment plan");
    } finally {
      setUpdatingPayment(false);
    }
  };

  // Closing only closes. The dialog stays mounted for its 200ms exit animation, so
  // resetting the tab and the form fields here played the reset on screen: a
  // Reschedule dialog visibly snapped back to Record payment before fading out.
  // openInstallmentPayModal seeds every one of those fields, so the next open is
  // clean without clearing them on the way out.
  const closeInstallmentModal = () => {
    setPayingInstallment(null);
  };

  const openInstallmentPayModal = (
    index: number,
    amount: number,
    tab: "record" | "reschedule" = "record"
  ) => {
    setEditingInstallmentDate(null);
    setInstallmentDateDraft("");
    setPayingInstallment({ index, amount });
    setInstallmentPayAmount(amount.toFixed(2));
    setInstallmentAmountError(null);
    setInstallmentError(null);
    setShortfallAction("write_off");
    setInstallmentModalTab(tab);
    setInstallmentPaymentInvoiceNumber("");
    setInstallmentPaymentNote("");
    setInstallmentPayFromTrust(false);
    setInstallmentDelayMode("next_period");
    setInstallmentDelayCustomDate("");
  };

  const handleRescheduleInstallment = async () => {
    if (!invoice || !payingInstallment || paymentMutationInFlight.current) return;
    const plan = invoice.paymentPlan;
    const ep = plan?.expectedPayments?.[payingInstallment.index];
    if (!plan?.enabled || !ep || ep.status === "paid") {
      setInstallmentError("Cannot reschedule this installment");
      return;
    }
    const frequencyDays = plan.frequencyDays || 30;
    let newDue: string;
    if (installmentDelayMode === "custom") {
      if (!installmentDelayCustomDate.trim()) {
        setInstallmentError("Select a new due date");
        return;
      }
      newDue = installmentDelayCustomDate.trim();
    } else {
      newDue = addPaymentPlanPeriod(ep.dueDate, frequencyDays);
    }
    paymentMutationInFlight.current = true;
    setInstallmentError(null);
    setUpdatingPayment(true);
    try {
      await billingService.updateInstallment(billingContext, invoice.id, payingInstallment.index, {
        dueDate: newDue,
      });
      closeInstallmentModal();
      await loadInvoice();
    } catch (err: any) {
      setInstallmentError(err.message || "Failed to reschedule installment");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handlePayInstallment = async () => {
    if (!invoice || !payingInstallment || paymentMutationInFlight.current) return;
    const parsed = parseMoneyInput(installmentPayAmount);
    if ("error" in parsed) {
      setInstallmentAmountError(parsed.error);
      return;
    }
    const payAmount = parsed.amount;
    if (installmentPayFromTrust) {
      if (!selectedTrustAccountId) {
        setInstallmentError("Select a trust account");
        return;
      }
      const selectedAcctBal = clientTrustBalance?.accountBalances.find(
        (b) => b.trustAccountId === selectedTrustAccountId
      );
      const availableCents = selectedAcctBal?.balanceCents ?? 0;
      if (Math.round(payAmount * 100) > availableCents) {
        setInstallmentError(
          `Insufficient trust balance in selected account. Available: ${formatCurrency(availableCents / 100)}`
        );
        return;
      }
    }
    paymentMutationInFlight.current = true;
    setInstallmentError(null);
    setUpdatingPayment(true);
    try {
      const payload: PaymentPayload = {
        paymentAmount: payAmount,
        paidDate: dayjs().format("YYYY-MM-DD"),
        installmentIndex: payingInstallment.index,
        ...(installmentPaymentInvoiceNumber.trim()
          ? { invoiceNumber: installmentPaymentInvoiceNumber.trim() }
          : {}),
        ...(installmentPaymentNote.trim() ? { paymentNote: installmentPaymentNote.trim() } : {}),
        ...(installmentPayFromTrust && selectedTrustAccountId && (contextType === "matter" ? invoice.clientId : entityId)
          ? {
              paymentSource: "trust",
              trustAccountId: selectedTrustAccountId,
              trustClientId: contextType === "matter" ? invoice.clientId ?? undefined : entityId,
              trustClientName: billingClient?.name || billingClient?.email || "",
            }
          : {}),
      };
      if (payAmount < payingInstallment.amount) {
        payload.shortfallAction = shortfallAction;
      }
      await billingService.updateInvoicePayment(billingContext, invoice.id, payload);
      closeInstallmentModal();
      setClientTrustBalance(null);
      await loadInvoice();
    } catch (err: any) {
      setInstallmentError(err.message || "Failed to record installment payment");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const handleUpdateInstallmentDate = async (index: number, dueDate: string) => {
    if (!invoice) return;
    setUpdatingPayment(true);
    try {
      await billingService.updateInstallment(billingContext, invoice.id, index, { dueDate });
      setEditingInstallmentDate(null);
      setInstallmentDateDraft("");
      await loadInvoice();
    } catch (err: any) {
      setError(err.message || "Failed to update installment date");
    } finally {
      setUpdatingPayment(false);
    }
  };

  const cancelInstallmentDateEdit = () => {
    setEditingInstallmentDate(null);
    setInstallmentDateDraft("");
  };

  const confirmInstallmentDateEdit = async (index: number, currentDue: string) => {
    const next = installmentDateDraft.trim();
    if (!next) {
      setError("Select a due date");
      return;
    }
    const prevNorm = dayjs(currentDue).format("YYYY-MM-DD");
    if (next === prevNorm) {
      cancelInstallmentDateEdit();
      return;
    }
    await handleUpdateInstallmentDate(index, next);
  };

  // ── Bulk schedule editing ───────────────────────────────────────
  // Locked (paid) installments stay out of the draft and are preserved by the
  // backend, so the editable draft covers exactly the remaining balance.
  const planExpectedPayments = invoice?.paymentPlan?.expectedPayments || [];
  // The backend's row limit counts the locked rows it preserves as well as the draft.
  const lockedInstallmentCount = planExpectedPayments.filter((ep) => isInstallmentLocked(ep)).length;
  const draftAtRowLimit = lockedInstallmentCount + draftInstallments.length >= MAX_PLAN_INSTALLMENTS;
  const draftTarget = Math.max(0, Math.round(remainingBalance * 100) / 100);
  const draftScheduledTotal =
    Math.round(draftInstallments.reduce((sum, r) => sum + (r.amount || 0), 0) * 100) / 100;
  const draftMismatchCents = Math.round((draftScheduledTotal - draftTarget) * 100);

  const enterPlanEdit = () => {
    const plan = invoice?.paymentPlan;
    if (!plan?.enabled) return;
    const draft: DraftInstallment[] = (plan.expectedPayments || [])
      .filter((ep) => !isInstallmentLocked(ep))
      .map((ep) => ({
        key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${ep.id || ep.dueDate}-${Math.random()}`,
        dueDate: dayjs(ep.dueDate).format("YYYY-MM-DD"),
        amount: ep.amount,
      }))
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    const freq = plan.frequencyDays || 30;
    setEditingInstallmentDate(null);
    setDateShiftPrompt(null);
    setDraftInstallments(draft);
    setDraftFrequency(freq);
    setDraftFreqIsCustom(![7, 14, 30].includes(freq));
    setPlanEditing(true);
  };

  const cancelPlanEdit = () => {
    // Don't clear draftInstallments here - the modal holds its content during the
    // 200ms exit animation so it doesn't flash to an empty state. The draft is
    // overwritten fresh in enterPlanEdit the next time editing begins.
    setPlanEditing(false);
  };

  const setDraftAmount = (key: string, raw: string) => {
    const parsed = parseFloat(raw);
    const amount = isNaN(parsed) || parsed < 0 ? 0 : parsed;
    const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
    setDraftInstallments((rows) =>
      rows.map((r) => (r.key === key ? { ...r, amount, manualAmount: true, subCent: decimals > 2 } : r)),
    );
  };

  const setDraftDate = (key: string, value: string) => {
    const row = draftInstallments.find((r) => r.key === key);
    if (row?.dueDate && value && row.dueDate !== value) {
      const offsetDays = dayjs(value).diff(dayjs(row.dueDate), "day");
      if (offsetDays !== 0) {
        setDateShiftPrompt({ rowKey: key, offsetDays });
      }
    }
    setDraftInstallments((rows) => rows.map((r) => (r.key === key ? { ...r, dueDate: value } : r)));
  };

  const deleteDraftRow = (key: string) => {
    setDraftInstallments((rows) => rows.filter((r) => r.key !== key));
  };

  const addDraftRow = () => {
    if (lockedInstallmentCount + draftInstallments.length >= MAX_PLAN_INSTALLMENTS) return;
    setDraftInstallments((rows) => {
      const lastDate = rows.length ? rows[rows.length - 1].dueDate : dayjs().format("YYYY-MM-DD");
      const newRow: DraftInstallment = {
        key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `add-${Math.random()}`,
        dueDate: rows.length ? addPaymentPlanPeriod(lastDate, draftFrequency) : lastDate,
        amount: 0,
      };
      return [...rows, newRow];
    });
  };

  const applyDateShift = (shiftDays: number) => {
    if (!dateShiftPrompt) return;
    const { rowKey } = dateShiftPrompt;
    setDraftInstallments((rows) => {
      const rowIdx = rows.findIndex((r) => r.key === rowKey);
      if (rowIdx === -1) return rows;
      return rows.map((r, i) => {
        if (i <= rowIdx) return r;
        return { ...r, dueDate: dayjs(r.dueDate).add(shiftDays, "day").format("YYYY-MM-DD") };
      });
    });
    setDateShiftPrompt(null);
  };

  // Reset and re-split the full target evenly across all rows, restepping dates from
  // the first row by the chosen cadence and clearing every manual amount pin.
  const distributeDraftEvenly = () => {
    setDraftInstallments((rows) => {
      const count = rows.length;
      if (count === 0) return rows;
      const targetCents = Math.round(draftTarget * 100);
      const perCents = Math.max(1, Math.floor(targetCents / count));
      let remainder = targetCents - perCents * count;
      let date = rows[0]?.dueDate || dayjs().format("YYYY-MM-DD");
      return rows.map((r, i) => {
        const extra = i < remainder ? 1 : 0;
        const cents = perCents + extra;
        const row: DraftInstallment = { ...r, amount: cents / 100, dueDate: date, manualAmount: false, subCent: false };
        date = addPaymentPlanPeriod(date, draftFrequency);
        return row;
      });
    });
  };

  // Balance the target amount across remaining un-edited installments without touching user-edited amounts or due dates.
  const distributeRemainingDraft = () => {
    setDraftInstallments((rows) => {
      if (rows.length === 0) return rows;
      const targetCents = Math.round(draftTarget * 100);

      const flexibleRows = rows.filter((r) => !r.manualAmount);
      const targetFlexRows = flexibleRows.length > 0 ? flexibleRows : rows;

      const manualCentsSum = rows
        .filter((r) => !targetFlexRows.includes(r))
        .reduce((sum, r) => sum + Math.round((r.amount || 0) * 100), 0);

      const remainingCentsToDistribute = Math.max(0, targetCents - manualCentsSum);
      const flexCount = targetFlexRows.length;
      if (flexCount === 0) return rows;

      const perCents = Math.floor(remainingCentsToDistribute / flexCount);
      let remainder = remainingCentsToDistribute - perCents * flexCount;

      let flexIdx = 0;
      return rows.map((r) => {
        if (!targetFlexRows.includes(r)) {
          return r;
        }
        const extra = flexIdx < remainder ? 1 : 0;
        flexIdx++;
        const newCents = perCents + extra;
        return { ...r, amount: newCents / 100, subCent: false };
      });
    });
  };

  // Put a shortfall on the installment that comes due next, so the schedule balances
  // without disturbing the later due dates already agreed with the client.
  const addShortfallToNextInstallment = () => {
    setDraftInstallments((rows) => {
      if (rows.length === 0) return rows;
      const cents = rows.map((r) => Math.round((r.amount || 0) * 100));
      const shortCents = Math.round(draftTarget * 100) - cents.reduce((a, b) => a + b, 0);
      if (shortCents <= 0) return rows;
      let nextIdx = 0;
      rows.forEach((r, i) => {
        if (r.dueDate && (!rows[nextIdx].dueDate || r.dueDate < rows[nextIdx].dueDate)) nextIdx = i;
      });
      return rows.map((r, i) => (i === nextIdx ? { ...r, amount: (cents[i] + shortCents) / 100, subCent: false } : r));
    });
  };

  // Add a shortfall as one more installment one cadence period after the last one.
  const addShortfallAsNewInstallment = () => {
    setDraftInstallments((rows) => {
      const scheduled = rows.reduce((sum, r) => sum + Math.round((r.amount || 0) * 100), 0);
      const shortCents = Math.round(draftTarget * 100) - scheduled;
      if (shortCents <= 0) return rows;
      const lastDate = rows.length ? rows[rows.length - 1].dueDate : dayjs().format("YYYY-MM-DD");
      const newRow: DraftInstallment = {
        key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `fix-${Math.random()}`,
        dueDate: addPaymentPlanPeriod(lastDate, draftFrequency),
        amount: shortCents / 100,
      };
      return [...rows, newRow];
    });
  };

  // Absorb an over-scheduled amount from the end of the schedule backwards, dropping any
  // installment that gets fully consumed - the mirror of adding a shortfall to the end.
  const trimOverageFromEnd = () => {
    setDraftInstallments((rows) => {
      const cents = rows.map((r) => Math.round((r.amount || 0) * 100));
      let overCents = cents.reduce((a, b) => a + b, 0) - Math.round(draftTarget * 100);
      if (overCents <= 0) return rows;
      for (let i = cents.length - 1; i >= 0 && overCents > 0; i--) {
        const take = Math.min(cents[i], overCents);
        cents[i] -= take;
        overCents -= take;
      }
      return rows
        .map((r, i) => ({ ...r, amount: cents[i] / 100, subCent: false }))
        .filter((r) => r.amount > 0);
    });
  };

  const savePlanSchedule = async () => {
    if (!invoice) return;
    if (draftInstallments.length === 0) {
      setError("A payment plan needs at least one installment");
      return;
    }
    // Before the mismatch check: rounding is exactly what hides a sub-cent row from it.
    if (draftInstallments.some((r) => r.subCent)) {
      setError(MONEY_DECIMALS_MESSAGE);
      return;
    }
    if (draftMismatchCents !== 0) {
      setError(
        `The schedule must add up to the ${formatCurrency(remainingBalance)} remaining balance`
      );
      return;
    }
    if (draftInstallments.some((r) => !(r.amount > 0))) {
      setError("Every installment amount must be greater than 0");
      return;
    }
    if (draftInstallments.some((r) => !r.dueDate)) {
      setError("Every installment needs a due date");
      return;
    }
    setSavingSchedule(true);
    setError(null);
    try {
      await billingService.replacePaymentPlanSchedule(billingContext, invoice.id, {
        installments: draftInstallments.map((r) => ({
          dueDate: r.dueDate,
          amount: Math.round(r.amount * 100) / 100,
        })),
        frequencyDays: draftFrequency,
      });
      setPlanEditing(false);
      await loadInvoice();
    } catch (err: any) {
      setError(err.message || "Failed to update payment plan schedule");
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleUnpayInstallment = async (index: number) => {
    if (!invoice) return;
    if (paymentMutationInFlight.current) return;
    paymentMutationInFlight.current = true;
    setUpdatingPayment(true);
    try {
      // Name the payment this view shows as settling the installment, so a stale
      // view cannot un-pay a different one.
      const matched = invoice.paymentPlan?.expectedPayments?.[index]?.matchedPaymentIndex;
      const paymentId = typeof matched === "number" ? payments[matched]?.id : undefined;
      await billingService.unpayInstallment(billingContext, invoice.id, index, paymentId);
      await loadInvoice();
    } catch (err: any) {
      setError(err.message || "Failed to mark installment as unpaid");
    } finally {
      paymentMutationInFlight.current = false;
      setUpdatingPayment(false);
    }
  };

  const openRequestPayment = (installmentId: string | null = null) => {
    setRequestInstallmentId(installmentId);
    setShowStripeConfirm(true);
  };

  const handleVoidStripePayment = async () => {
    if (!invoice) return;
    setVoidingStripePayment(true);
    try {
      await billingService.voidStripePaymentRequest(billingContext, invoice.id);
      await loadInvoice();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to void payment request"));
    } finally {
      setVoidingStripePayment(false);
    }
  };

  const handleDeleteInvoice = async () => {
    if (!invoice) return;
    setDeletingInvoice(true);
    try {
      await billingService.deleteInvoice(billingContext, invoice.id);
      navigate(backHref);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete invoice"));
    } finally {
      setDeletingInvoice(false);
    }
  };

  const handleVoidInvoice = async () => {
    if (!invoice || voidingInvoice) return;
    setVoidingInvoice(true);
    setError(null);
    try {
      await billingService.voidInvoice(billingContext, invoice.id);
      setShowVoidConfirm(false);
      setSuccessMessage("Invoice voided");
      await loadInvoice();
    } catch (err) {
      setShowVoidConfirm(false);
      setError(getErrorMessage(err, "Failed to void invoice"));
    } finally {
      setVoidingInvoice(false);
    }
  };

  // ── Payment Receipt PDF actions ──

  const createPaymentReceiptPdfBlob = async (
    payment: { amount: number; date: string; invoiceNumber?: string | null; note?: string | null; paymentSource?: string; recordedBy?: string },
    idx: number
  ) => {
    if (!invoice) throw new Error("Invoice not found");
    // Pre-fetch logo as base64 to avoid @react-pdf/renderer hanging on remote URLs
    let logoDataUrl: string | null = null;
    if (lawFirmData?.logoUrl) {
      try {
        const res = await fetch(lawFirmData.logoUrl);
        const blob = await res.blob();
        logoDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch {
        logoDataUrl = null;
      }
    }

    const clientName = client?.name || matterClients.find(c => c.id === invoice.clientId)?.name || "Client";
    const receiptNumber = payment.invoiceNumber || `${invoice.invoiceName}-PMT${idx + 1}`;
    const paymentSourceLabel = payment.paymentSource === "trust" ? "Trust Account" : payment.paymentSource === "stripe" ? "Stripe" : "Manual";
    const firmName = lawFirmData?.name || "Law Firm";

    const ReceiptDoc = (
      <PaymentReceiptPDFDocument
        receiptNumber={receiptNumber}
        // The number is what the client quotes back; invoiceName is the firm's
        // internal label, so it only stands in when there is no number.
        invoiceReference={invoice.invoiceNumber || invoice.invoiceName || "-"}
        clientName={clientName}
        firmName={firmName}
        firmAddressLines={[
          lawFirmData?.address,
          [lawFirmData?.city, lawFirmData?.state, lawFirmData?.zip].filter(Boolean).join(", "),
        ].filter((line): line is string => Boolean(line))}
        logoDataUrl={logoDataUrl}
        amount={payment.amount}
        date={payment.date}
        paymentMethod={paymentSourceLabel}
        note={payment.note}
        recordedByName={payment.recordedBy ? resolveUserName(payment.recordedBy) : null}
      />
    );

    const blob = await pdf(ReceiptDoc).toBlob();
    const fileName = `Receipt-${receiptNumber}-${dayjs(payment.date).format("YYYY-MM-DD")}.pdf`;
    return { blob, fileName };
  };

  const handleDownloadPaymentReceipt = async (payment: { amount: number; date: string; invoiceNumber?: string | null; note?: string | null; paymentSource?: string; recordedBy?: string }, idx: number) => {
    if (!invoice) return;
    setDownloadingReceiptIdx(idx);
    try {
      const { blob, fileName } = await createPaymentReceiptPdfBlob(payment, idx);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to generate receipt"));
    } finally {
      setDownloadingReceiptIdx(null);
    }
  };

  const handleViewPaymentReceipt = async (
    payment: { amount: number; date: string; invoiceNumber?: string | null; note?: string | null; paymentSource?: string; recordedBy?: string },
    idx: number
  ) => {
    if (!invoice) return;
    setViewingReceiptIdx(idx);
    try {
      const { blob, fileName } = await createPaymentReceiptPdfBlob(payment, idx);
      if (previewReceiptPdfUrl) URL.revokeObjectURL(previewReceiptPdfUrl);
      setPreviewReceiptDownloadName(fileName);
      setPreviewReceiptPdfUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to generate receipt preview"));
    } finally {
      setViewingReceiptIdx(null);
    }
  };

  // ── Invoice PDF actions ──

  const createInvoicePdfBlob = async () => {
    if (!invoice) {
      throw new Error("Invoice not found");
    }

    const InvoiceDocument = (
      <InvoicePDFDocument
        invoice={invoice}
        lawFirmName={lawFirmData?.name}
        lawFirmLogoUrl={lawFirmData?.logoUrl}
        lawFirmAddress={lawFirmData}
        billingClient={billingClient}
      />
    );

    return {
      blob: await pdf(InvoiceDocument).toBlob(),
      fileName: `Invoice-${invoice.invoiceNumber || invoice.invoiceName || "INV"}-${dayjs().format("YYYY-MM-DD")}.pdf`,
    };
  };

  const downloadInvoicePdf = async () => {
    setSendInvoiceError(null);
    setSendInvoiceSuccess(null);
    setGeneratingPDF(true);
    try {
      const { blob, fileName } = await createInvoicePdfBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Error generating PDF:", err);
      setSendInvoiceError(getErrorMessage(err, "Failed to generate PDF"));
    } finally {
      setGeneratingPDF(false);
    }
  };

  const handlePreviewPdf = async () => {
    setGeneratingPDF(true);
    try {
      const { blob } = await createInvoicePdfBlob();
      const url = URL.createObjectURL(blob);
      setPreviewPdfUrl(url);
    } catch (err) {
      console.error("Error generating PDF preview:", err);
      setError(getErrorMessage(err, "Failed to generate PDF preview"));
    } finally {
      setGeneratingPDF(false);
    }
  };

  // Release a preview's blob only once its panel has finished animating out: the
  // iframe keeps showing it until then.
  const revokeAfterExit = (url: string) => {
    window.setTimeout(() => URL.revokeObjectURL(url), 200);
  };

  const closePreviewPdf = () => {
    if (previewPdfUrl) {
      revokeAfterExit(previewPdfUrl);
      setPreviewPdfUrl(null);
    }
  };

  const closePreviewReceiptPdf = () => {
    if (previewReceiptPdfUrl) {
      revokeAfterExit(previewReceiptPdfUrl);
      setPreviewReceiptPdfUrl(null);
    }
    setPreviewReceiptDownloadName("");
  };

  const handleSendInvoiceToPortal = async () => {
    if (!invoice || !portalRecipientUserId || !canSendInvoiceToPortal) return;

    setSendInvoiceError(null);
    setSendInvoiceSuccess(null);
    setGeneratingPDF(true);
    setSendingInvoiceToPortal(true);

    try {
      const { blob, fileName } = await createInvoicePdfBlob();
      const file = new File([blob], fileName, { type: "application/pdf" });
      let rejected: Array<{ name: string; error: string }> = [];
      const attachments = await messagesService.uploadAttachments(
        lawFirmId,
        { clientId: portalRecipientUserId },
        [file],
        undefined,
        { onRejected: (refused) => { rejected = refused; } }
      );
      // Finalize can refuse the PDF and still succeed, returning no attachment.
      // The message says the invoice is attached, so it is not sent without it.
      if (rejected.length > 0) {
        const names = rejected.map((r) => `"${r.name}"`).join(", ");
        const reason = rejected.find((r) => r.error)?.error;
        setSendInvoiceError(reason ? `Could not attach ${names}: ${reason}` : `Could not attach ${names}.`);
        return;
      }

      const invoiceLabel = invoice.invoiceNumber || invoice.invoiceName || "your invoice";
      const messageContent = [
        `Hi ${portalRecipient?.name || invoiceLinkedClientName},`,
        "",
        `I've attached ${invoiceLabel === "your invoice" ? invoiceLabel : `invoice ${invoiceLabel}`}.`,
        `Total: ${formatCurrency(totalAmount)}.`,
        remainingBalance !== totalAmount
          ? `Remaining balance: ${formatCurrency(remainingBalance)}.`
          : null,
        invoice.dueDate
          ? `Due date: ${dayjs(invoice.dueDate).format("MMMM DD, YYYY")}.`
          : null,
        "",
        "Please review it in the client portal and let us know if you have any questions.",
      ]
        .filter(Boolean)
        .join("\n");

      await messagesService.sendMessage({
        lawFirmId,
        clientId: portalRecipientUserId,
        content: messageContent,
        matterId: invoice.matterId || (contextType === "matter" ? entityId : undefined),
        attachments,
      });
      track("invoice_sent", { channel: "portal", context_type: contextType });

      setSendInvoiceSuccess(
        `Invoice sent to ${portalRecipient?.name || invoiceLinkedClientName} in the client portal.`
      );
    } catch (err) {
      console.error("Error sending invoice to portal:", err);
      setSendInvoiceError(
        getErrorMessage(err, "Failed to send invoice to client portal")
      );
    } finally {
      setGeneratingPDF(false);
      setSendingInvoiceToPortal(false);
    }
  };


  return {
    loadInvoice,
    lawFirmId,
    entityId,
    invoiceId,
    contextType,
    backHref,
    backLabel,
    fieldIds,
    sendInvoiceTitleId,
    addAmountTitleId,
    creditNoteTitleId,
    paymentPlanTitleId,
    installmentTitleId,
    editPlanTitleId,
    navigate,
    hasPermission,
    canManageInvoices,
    canViewClients,
    canRecordPayments,
    readOnlyInvoice,
    queryClient,
    resolveUserName,
    invoice,
    setInvoice,
    loading,
    error,
    setError,
    matterClients,
    client,
    portalClients,
    updatingPayment,
    generatingPDF,
    exportingLedes,
    setExportingLedes,
    refreshingRecipients,
    downloadingReceiptIdx,
    viewingReceiptIdx,
    stripeStatus,
    stripeDirectCharges,
    retryStripeStatus,
    canManageFirmSettings,
    showSendInvoiceModal,
    setShowSendInvoiceModal,
    sendingInvoiceToPortal,
    sendInvoiceError,
    setSendInvoiceError,
    sendInvoiceSuccess,
    setSendInvoiceSuccess,
    sendingEmail,
    emailRecipient,
    setEmailRecipient,
    previewPdfUrl,
    previewReceiptPdfUrl,
    previewReceiptDownloadName,
    showPaymentModal,
    setShowPaymentModal,
    paymentAmount,
    setPaymentAmount,
    paymentAmountError,
    paymentError,
    setPaymentAmountError,
    paymentNote,
    setPaymentNote,
    paymentInvoiceNumber,
    setPaymentInvoiceNumber,
    nextPaymentDate,
    setNextPaymentDate,
    paymentInstallmentIndex,
    setPaymentInstallmentIndex,
    allowOverpayment,
    setAllowOverpayment,
    editingPayment,
    setEditingPayment,
    editPaymentOpen,
    setEditPaymentOpen,
    editPaymentError,
    setEditPaymentError,
    deletePaymentConfirm,
    setDeletePaymentConfirm,
    deletePaymentError,
    setDeletePaymentError,
    showCreditNoteModal,
    setShowCreditNoteModal,
    creditNoteAmount,
    setCreditNoteAmount,
    creditNoteDescription,
    setCreditNoteDescription,
    creditNoteType,
    setCreditNoteType,
    creditNoteError,
    setCreditNoteError,
    showAddAmountModal,
    setShowAddAmountModal,
    addAmountValue,
    setAddAmountValue,
    addAmountNote,
    setAddAmountNote,
    addAmountError,
    setAddAmountError,
    showPaymentPlanModal,
    setShowPaymentPlanModal,
    planError,
    setPlanError,
    planInstallment,
    setPlanInstallment,
    setPlanFrequencyCustom,
    setPlanStartDate,
    setPlanDownPayment,
    setPlanDownPaymentPaid,
    planInstallmentMode,
    setPlanInstallmentMode,
    planPaymentCount,
    setPlanPaymentCount,
    planValues,
    applyPlanPatch,
    showAllInstallments,
    setShowAllInstallments,
    showAllPayments,
    setShowAllPayments,
    editingInstallmentDate,
    setEditingInstallmentDate,
    installmentDateDraft,
    setInstallmentDateDraft,
    payingInstallment,
    installmentPayAmount,
    setInstallmentPayAmount,
    installmentAmountError,
    setInstallmentAmountError,
    installmentError,
    shortfallAction,
    setShortfallAction,
    installmentModalTab,
    setInstallmentModalTab,
    installmentPaymentInvoiceNumber,
    setInstallmentPaymentInvoiceNumber,
    installmentPaymentNote,
    setInstallmentPaymentNote,
    installmentPayFromTrust,
    setInstallmentPayFromTrust,
    installmentDelayMode,
    setInstallmentDelayMode,
    installmentDelayCustomDate,
    setInstallmentDelayCustomDate,
    showOrgAccessModal,
    setShowOrgAccessModal,
    planEditing,
    draftInstallments,
    draftFrequency,
    setDraftFrequency,
    draftFreqIsCustom,
    setDraftFreqIsCustom,
    savingSchedule,
    dateShiftPrompt,
    setDateShiftPrompt,
    clientTrustBalance,
    trustAccounts,
    selectedTrustAccountId,
    setSelectedTrustAccountId,
    payFromTrust,
    setPayFromTrust,
    showStripeConfirm,
    setShowStripeConfirm,
    requestInstallmentId,
    openRequestPayment,
    voidingStripePayment,
    showVoidStripeConfirm,
    setShowVoidStripeConfirm,
    showRemovePlanConfirm,
    setShowRemovePlanConfirm,
    editingDetails,
    setEditingDetails,
    editName,
    setEditName,
    editNumber,
    setEditNumber,
    editDate,
    setEditDate,
    editDueDate,
    setEditDueDate,
    editRemitToName,
    setEditRemitToName,
    editRemitToAddress,
    setEditRemitToAddress,
    savingDetails,
    setSavingDetails,
    showDeleteConfirm,
    setShowDeleteConfirm,
    showVoidConfirm,
    setShowVoidConfirm,
    voidingInvoice,
    successMessage,
    setSuccessMessage,
    deletingInvoice,
    setActiveTab,
    moreMenuOpen,
    setMoreMenuOpen,
    moreMenuPos,
    setMoreMenuPos,
    highlightedInstallmentIdx,
    planPanelRef,
    goToPaymentPlan,
    shownReceiptPdfUrl,
    shownInvoicePdfUrl,
    activeInstallment,
    billingContext,
    lineEditor,
    totalAmount,
    totalHours,
    amountPaid,
    totalWrittenOff,
    remainingBalance,
    creditBalance,
    payments,
    creditNotes,
    timeEntries,
    flatFees,
    expenses,
    auditLog,
    timeEntriesTotal,
    flatFeesTotal,
    expensesTotal,
    amountAdjustments,
    adjustmentsTotal,
    sentCopies,
    downloadingCopy,
    sentCopyError,
    setSentCopyError,
    handleDownloadSentCopy,
    isPaid,
    status,
    canApplyLateFee,
    taxAmount,
    subtotalAmount,
    taxLabel,
    showStripeSetupCard,
    billingClient,
    resolvedClient,
    billTo,
    isCompanyClient,
    orgClientId,
    orgClientName,
    resolvedClientName,
    invoiceLinkedClientName,
    portalRecipient,
    canSendInvoiceToPortal,
    portalSendHelperText,
    remitTo,
    recurringRetainerInvoice,
    detailTabs,
    currentTab,
    closeSendInvoiceModal,
    handleSendInvoiceByEmail,
    openPaymentModal,
    handleRecordPayment,
    handleEditPayment,
    handleDeletePayment,
    handleAddCreditNote,
    handleAddAmount,
    handleApplyLateFee,
    handleRefreshBillingRecipients,
    handleDeleteCreditNote,
    handleSetPaymentPlan,
    handleRemovePaymentPlan,
    closeInstallmentModal,
    openInstallmentPayModal,
    handleRescheduleInstallment,
    handlePayInstallment,
    cancelInstallmentDateEdit,
    confirmInstallmentDateEdit,
    draftAtRowLimit,
    draftTarget,
    draftScheduledTotal,
    draftMismatchCents,
    enterPlanEdit,
    cancelPlanEdit,
    setDraftAmount,
    setDraftDate,
    deleteDraftRow,
    addDraftRow,
    applyDateShift,
    distributeDraftEvenly,
    distributeRemainingDraft,
    addShortfallToNextInstallment,
    addShortfallAsNewInstallment,
    trimOverageFromEnd,
    savePlanSchedule,
    handleUnpayInstallment,
    handleVoidStripePayment,
    handleDeleteInvoice,
    handleVoidInvoice,
    handleDownloadPaymentReceipt,
    handleViewPaymentReceipt,
    downloadInvoicePdf,
    handlePreviewPdf,
    closePreviewPdf,
    closePreviewReceiptPdf,
    handleSendInvoiceToPortal
  };
}
