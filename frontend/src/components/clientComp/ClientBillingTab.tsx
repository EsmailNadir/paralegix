"use client";

import Spinner from "@/components/ui/Spinner";
import InvoiceMoneySummary from "@/components/billingComp/InvoiceMoneySummary";

import BillingSummaryCard from "@/components/billingComp/BillingSummaryCard";
import { FlatFeeEditorRow,FlatFeeSavedRow } from "@/components/billingComp/FlatFeeEditor";
import InvoiceListCard from "@/components/billingComp/InvoiceListCard";
import { downloadInvoicePdf } from "@/components/billingComp/invoicePdf";
import { hasOpenPaymentLink } from "@/components/billingComp/invoiceDetailHelpers";
import RecordPaymentModal from "@/components/billingComp/RecordPaymentModal";
import { RecurringRetainerPlanCard,RecurringRetainerSection } from "@/components/billingComp/RecurringRetainerPanel";
import { formatCurrency,getInvoiceDisplayName,getInvoiceRemainingBalance,getInvoiceStatus,getInvoiceStatusKey,getRecurringRetainerPlanName,isClosedStatusKey,isRecurringRetainerInvoice } from "@/components/billingComp/utils";
import {
buildMatterBillingDraftHref,
getBillingRelationLabel,
resolveMatterItemDraftRecipientTarget,
type ClientScopedInvoice
} from "@/components/clientComp/billingAwareness";
import ErrorNotification from "@/components/ErrorNotification";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import type { StripeStatus } from "@/hooks/billingHooks/useStripeStatus";
import ConfirmModal from "@/components/ui/ConfirmModal";
import DatePicker from "@/components/ui/DatePicker";
import DateRangePicker from "@/components/ui/DateRangePicker";
import Dropdown from "@/components/ui/Dropdown";
import ErrorToast from "@/components/ui/ErrorToast";
import FieldLabel from "@/components/ui/FieldLabel";
import { FIELD_CLS,FIELD_LABEL_CLS,INPUT_CLS } from "@/components/ui/inputClasses";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListPager,{ AutoPager,DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import Modal from "@/components/ui/Modal";
import type { RowAction } from "@/components/ui/RowActionMenu";
import StatusBadge from "@/components/ui/StatusBadge";
import RequestPaymentDialog from "@/components/billingComp/RequestPaymentDialog";
import TagChip from "@/components/ui/TagChip";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import useClientBillingFlatFees,{
type ClientBillingFlatFee,
type DraftClientBillingFlatFee,
} from "@/hooks/billingHooks/useClientBillingFlatFees";
import useFirmInvoicesTable from "@/hooks/billingHooks/useFirmInvoicesTable";
import { findLinkedCompanyName } from "@/hooks/clientHooks/useClients";
import usePagedRows from "@/hooks/usePagedRows";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { parseMoneyInput } from "@/lib/utils/currency";
import { formatDateOnly,todayLocalDate } from "@/lib/utils/dateUtils";
import { formatHoursMinutes } from "@/lib/utils/format";
import billingService from "@/services/billing.service";
import TasksService from "@/services/tasks.service";
import type { BillingPlan,Client,Invoice } from "@/types";
import type { Matter } from "@/types/matter";
import type { Task } from "@/types/task";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import {
Briefcase,
Calendar,
ClipboardCheck,
CreditCard,
DollarSign,
Download,
ExternalLink,
FileText,
Plus,
Trash2
} from "lucide-react";
import { useCallback,useEffect,useId,useMemo,useRef,useState } from "react";

const INVOICE_TASK_OPTION_LIMIT = 200;
const EMPTY_TASKS: Task[] = [];
type MergedInvoice = ClientScopedInvoice & {
  /** The linked company this invoice belongs to, when it isn't this client's own. */
  _companyName?: string;
};
function getSharedMatterMarker(otherClientCount: number) {
  if (otherClientCount <= 0) return null;
  return `Shared with ${otherClientCount} other client${otherClientCount === 1 ? "" : "s"}`;
}
export default function ClientBillingTab({
  billingInvoices,
  recurringRetainers,
  clientMatters,
  client,
  clientId,
  lawFirmId,
  navigate,
  onRefreshInvoices,
  stripeStatus,
  companyNames,
}: {
  billingInvoices: ClientScopedInvoice[];
  recurringRetainers: BillingPlan[];
  clientMatters: Matter[];
  client: Client | null;
  clientId: string;
  lawFirmId: string;
  navigate: (href: string) => void;
  onRefreshInvoices: () => Promise<void>;
  /** The firm's Stripe readiness; the row's Request Payment needs `ready`. */
  stripeStatus: StripeStatus;
  /** Linked-company id -> name, for the "why is this here" badge on an invoice
   *  pulled in from a company this client is linked to. */
  companyNames: Map<string, string>;
}) {
  const fieldIds = useId();
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManageInvoices = hasPermission("billing.manageInvoices");
  const canRecordPayments = hasPermission("billing.recordPayments");

  // Server-paged. `clientScope` is the whole relationship (their direct invoices
  // plus every invoice on a matter they are on), which is what this tab shows - 
  // `clientId` alone would drop the co-client invoices on a shared matter.
  const invoiceTable = useFirmInvoicesTable(lawFirmId, {
    defaultSort: [{ field: "createdAt", sort: "desc" }],
    initialFilters: { clientScope: clientId },
    includeDetails: true,
    enabled: Boolean(lawFirmId && clientId),
  });

  // Anything that changes an invoice has to refresh BOTH reads: the parent's
  // arrays (which still back the flat-fee and awareness surfaces) and the server
  // page (which backs the list, its status chips and the money summary). Deleting
  // a row also moves the page behind it, so re-reading is not optional.
  // Depends on `refetch` rather than the whole table object: the object is a new
  // identity every render, which would make this callback - and every handler
  // that closes over it - unmemoizable.
  const refetchInvoicePage = invoiceTable.refetch;
  const refreshInvoiceViews = useCallback(async () => {
    await Promise.all([onRefreshInvoices(), refetchInvoicePage()]);
  }, [onRefreshInvoices, refetchInvoicePage]);

  // ── Payment modal state ──
  const [paymentModalInvoice, setPaymentModalInvoice] = useState<MergedInvoice | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAmountError, setPaymentAmountError] = useState<string | null>(null);
  const [paymentNote, setPaymentNote] = useState("");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  const [allowOverpayment, setAllowOverpayment] = useState(false);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // Which plan installment (if any) the Record Payment dialog should settle.
  const [paymentInstallmentIndex, setPaymentInstallmentIndex] = useState<number | null>(null);

  // ── Detail modal state ──
  const [detailInvoice, setDetailInvoice] = useState<MergedInvoice | null>(null);
  const [detailInvoiceOpen, setDetailInvoiceOpen] = useState(false);
  const detailInvoiceTitleId = useId();
  // Shown in the dialog when deleting the open invoice fails, so the firm is not
  // left looking at an invoice it believes it deleted.
  const [deleteInvoiceError, setDeleteInvoiceError] = useState<string | null>(null);
  const [deletingInvoice, setDeletingInvoice] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── Row-level delete state ──
  const [confirmDeleteRowId, setConfirmDeleteRowId] = useState<string | null>(null);
  const [deletingRowId, setDeletingRowId] = useState<string | null>(null);
  const [rowDeleteError, setRowDeleteError] = useState<string | null>(null);

  // ── Stripe state ──
  // Open state is tracked separately from the invoice so closing doesn't blank the
  // dialog's name and fee note mid-exit. The invoice is kept until the next one opens.
  const [stripeConfirmInvoice, setStripeConfirmInvoice] = useState<MergedInvoice | null>(null);
  const [stripeConfirmOpen, setStripeConfirmOpen] = useState(false);

  const stripeContextFor = (inv: MergedInvoice) => (inv._source === "matter"
    ? { type: 'matter' as const, lawFirmId, entityId: (inv as any).matterId }
    : { type: 'client' as const, lawFirmId, entityId: clientId });

  // ── PDF download ──
  const { lawFirm } = useLawFirm();
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownloadInvoicePdf = async (inv: MergedInvoice) => {
    setDownloadingInvoiceId(inv.id);
    try {
      await downloadInvoicePdf(inv as unknown as Invoice, {
        lawFirmName: lawFirm?.name,
        lawFirmLogoUrl: lawFirm?.logoUrl,
        lawFirmAddress: lawFirm ?? undefined,
        billingClient: client ? { name: client.name, email: client.email } : null,
      });
    } catch {
      setDownloadError("Failed to generate PDF");
    } finally {
      setDownloadingInvoiceId(null);
    }
  };

  // ── Filter state ──
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [invoicePagerPending, setInvoicePagerPending] = useState(false);
  const [filterSearch, setFilterSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterBillingRelation, setFilterBillingRelation] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterMatterId, setFilterMatterId] = useState("");

  // Each control is a server filter now, so it narrows every invoice under the
  // relationship rather than the ones a first request happened to load. The
  // "Billed to" control especially: it reads a field the server derives, so
  // filtering it in the browser would only ever have filtered the current page.
  const { setFilter: setInvoiceFilter, setSearch: setInvoiceSearch } = invoiceTable;
  useEffect(() => { setInvoiceSearch(filterSearch); }, [filterSearch, setInvoiceSearch]);
  useEffect(() => { setInvoiceFilter("matterId", filterMatterId || undefined); }, [filterMatterId, setInvoiceFilter]);
  useEffect(() => { setInvoiceFilter("status", filterStatus || undefined); }, [filterStatus, setInvoiceFilter]);
  useEffect(() => { setInvoiceFilter("billingRelation", filterBillingRelation || undefined); }, [filterBillingRelation, setInvoiceFilter]);
  useEffect(() => { setInvoiceFilter("dateFrom", filterDateFrom || undefined); }, [filterDateFrom, setInvoiceFilter]);
  useEffect(() => { setInvoiceFilter("dateTo", filterDateTo || undefined); }, [filterDateTo, setInvoiceFilter]);

  // ── Create invoice modal state ──
  const [showCreateInvoice, setShowCreateInvoice] = useState(false);
  const createInvoiceTitleId = `${fieldIds}-create-invoice-title`;
  const [newInvNumber, setNewInvNumber] = useState("");
  const [newInvDate, setNewInvDate] = useState(todayLocalDate());
  const [newInvDueDate, setNewInvDueDate] = useState("");
  const [newInvNotes, setNewInvNotes] = useState("");
  const [newInvMatterId, setNewInvMatterId] = useState("");
  const [newInvTaskId, setNewInvTaskId] = useState("");
  const [newInvLineItems, setNewInvLineItems] = useState<{ description: string; amount: string }[]>([
    { description: "", amount: "" },
  ]);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [flatFeeError, setFlatFeeError] = useState<string | null>(null);
  const {
    loading: flatFeesLoading,
    truncated: flatFeesTruncated,
    error: flatFeesReadError,
    directFlatFees,
    setDirectFlatFees,
    linkedMatterFlatFees,
    reload: loadFlatFees,
  } = useClientBillingFlatFees({ lawFirmId, clientId, client, clientMatters });
  const [savingFlatFeeId, setSavingFlatFeeId] = useState<string | null>(null);
  const [deletingFlatFeeKey, setDeletingFlatFeeKey] = useState<string | null>(null);
  const [editingDirectFlatFee, setEditingDirectFlatFee] = useState<{ id: string; description: string; amount: number; date?: string | null } | null>(null);
  const flatFeesSectionRef = useRef<HTMLDivElement | null>(null);

  const clientBillingContext = useMemo(
    () => ({ type: "client" as const, lawFirmId, entityId: clientId }),
    [clientId, lawFirmId],
  );
  const clientMatterMap = useMemo(
    () => new Map(clientMatters.map((clientMatter) => [clientMatter.id, clientMatter])),
    [clientMatters],
  );

  const allInvoices = billingInvoices;
  const ownedInvoices = useMemo(
    () => allInvoices.filter((invoice) => invoice.billingRelation === "owned"),
    [allInvoices],
  );

  const savedDirectFlatFees = useMemo(
    () => directFlatFees.filter((fee) => !fee.id.startsWith("flat-fee-")),
    [directFlatFees],
  );
  const newDirectFlatFees = useMemo(
    () => directFlatFees.filter((fee) => fee.id.startsWith("flat-fee-")),
    [directFlatFees],
  );

  const directFlatFeeTotal = useMemo(
    () => directFlatFees.reduce((sum, fee) => sum + (fee.amount || 0), 0),
    [directFlatFees],
  );
  const linkedMatterFlatFeeTotal = useMemo(
    () => linkedMatterFlatFees.reduce((sum, fee) => sum + (fee.amount || 0), 0),
    [linkedMatterFlatFees],
  );
  const totalVisibleFlatFees = directFlatFeeTotal + linkedMatterFlatFeeTotal;

  // ── Totals ──
  // Across every invoice this client owes on, computed by the server over the
  // whole relationship. NOT a reduce over the rows on screen, which would total
  // one page and label it the client's lifetime billing.
  const totalAmount = invoiceTable.summary.totalBilled;
  const totalPaid = invoiceTable.summary.totalPaid;
  const outstanding = totalAmount - totalPaid;

  // ── Payment plan stats ──
  const invoicesWithPlans = ownedInvoices.filter(
    (inv) => (inv as any).paymentPlan?.enabled
  );
  const planCount = invoicesWithPlans.length;
  const recurringRetainerPlans = useMemo(
    () =>
      [...recurringRetainers].sort((a, b) => {
        const aActive = a.status === "active" ? 0 : a.status === "paused" ? 1 : 2;
        const bActive = b.status === "active" ? 0 : b.status === "paused" ? 1 : 2;
        if (aActive !== bActive) return aActive - bActive;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      }),
    [recurringRetainers]
  );
  const nextPlanPayment = useMemo(() => {
    return invoicesWithPlans
      .flatMap((inv) =>
        ((inv as any).paymentPlan?.expectedPayments || [])
          .filter((ep: any) => ep.status === "pending" || ep.status === "overdue")
          .map((ep: any) => ({ ...ep, invoiceName: inv.invoiceName }))
      )
      .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0] || null;
  }, [invoicesWithPlans]);

  // ── Tasks offered by the create-invoice modal ──
  //
  // Read on demand and scoped to the client (and to the chosen matter, once one
  // is chosen) rather than taken from a list of every task the client has ever
  // had. Gated on the modal being open so a page visit that never creates an
  // invoice never pays for it.
  const { data: invoiceTaskOptions = EMPTY_TASKS } = useQuery<Task[]>({
    queryKey: ["clientInvoiceTaskOptions", lawFirmId, clientId, newInvMatterId || null],
    queryFn: async () => {
      const result = await TasksService.listLawFirmTasksPaged(lawFirmId, {
        clientId,
        matterId: newInvMatterId || undefined,
        limit: INVOICE_TASK_OPTION_LIMIT,
      });
      return result.tasks;
    },
    enabled: showCreateInvoice && !!lawFirmId && !!clientId,
    staleTime: 30_000,
  });

  const openMatterBilling = useCallback(
    (matterIdToOpen: string) => navigate(`/lawfirm/${lawFirmId}/matters/${matterIdToOpen}?tab=billing`),
    [lawFirmId, navigate],
  );

  const routeLinkedMatterFlatFee = useCallback((fee: ClientBillingFlatFee) => {
    if (!fee._matterId) return;

    const matterRecord = clientMatterMap.get(fee._matterId) || null;
    const billingTarget = resolveMatterItemDraftRecipientTarget({
      matterRecord,
      currentClient: client || { id: clientId },
    });

    navigate(buildMatterBillingDraftHref({
      lawFirmId,
      matterId: fee._matterId,
      draftType: "flat_fee",
      draftId: fee.id,
      target: billingTarget,
    }));
  }, [client, clientMatterMap, clientId, lawFirmId, navigate]);

  const addFlatFeeDraft = useCallback(() => {
    const newId = `flat-fee-${Date.now()}`;
    setFlatFeeError(null);
    setDirectFlatFees((prev) => [
      {
        id: newId,
        description: "",
        amount: 0,
        date: dayjs().format("YYYY-MM-DD"),
        _source: "direct",
      },
      ...prev,
    ]);
    requestAnimationFrame(() => {
      flatFeesSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [setDirectFlatFees]);

  const handleSaveFlatFee = useCallback(
    async (fee: DraftClientBillingFlatFee) => {
      if (!fee.description.trim() || fee.amount <= 0) {
        setFlatFeeError("Please provide a description and amount for the flat fee");
        return;
      }

      setSavingFlatFeeId(fee.id);
      try {
        // A flat fee belongs to either a matter or a client, never both, so a draft
        // pointed at a matter is recorded on that matter and comes back under the
        // linked-matter section instead of the direct client one.
        const context = fee._matterId
          ? { type: "matter" as const, lawFirmId, entityId: fee._matterId }
          : clientBillingContext;
        await billingService.addFlatFee(context, {
          description: fee.description.trim(),
          amount: fee.amount,
          date: fee.date || null,
        });
        setDirectFlatFees((prev) => prev.filter((existingFee) => existingFee.id !== fee.id));
        await loadFlatFees();
        setFlatFeeError(null);
      } catch (err) {
        setFlatFeeError(getErrorMessage(err, "Failed to save flat fee"));
      } finally {
        setSavingFlatFeeId(null);
      }
    },
    [clientBillingContext, lawFirmId, loadFlatFees, setDirectFlatFees],
  );

  const removeNewFlatFee = useCallback((feeId: string) => {
    setDirectFlatFees((prev) => prev.filter((fee) => fee.id !== feeId));
  }, [setDirectFlatFees]);

  const removeSavedFlatFee = useCallback(
    async (feeId: string) => {
      const deleteKey = `direct:${feeId}`;
      setDeletingFlatFeeKey(deleteKey);
      try {
        await billingService.removeFlatFee(clientBillingContext, feeId);
        await loadFlatFees();
      } finally {
        setDeletingFlatFeeKey(null);
      }
    },
    [clientBillingContext, loadFlatFees],
  );

  const handleUpdateDirectFlatFee = useCallback(async () => {
    if (!editingDirectFlatFee) return;
    if (!editingDirectFlatFee.description.trim() || editingDirectFlatFee.amount <= 0) {
      setFlatFeeError("Please provide a description and amount for the flat fee");
      return;
    }

    setSavingFlatFeeId(editingDirectFlatFee.id);
    try {
      await billingService.updateFlatFee(clientBillingContext, editingDirectFlatFee.id, {
        description: editingDirectFlatFee.description.trim(),
        amount: editingDirectFlatFee.amount,
        date: editingDirectFlatFee.date || null,
      });
      setEditingDirectFlatFee(null);
      setFlatFeeError(null);
      await loadFlatFees();
    } catch (err) {
      setFlatFeeError(getErrorMessage(err, "Failed to update flat fee"));
    } finally {
      setSavingFlatFeeId(null);
    }
  }, [clientBillingContext, editingDirectFlatFee, loadFlatFees]);

  // ── Payment handlers ──
  const openPaymentModal = (invoice: MergedInvoice) => {
    const remaining =
      (invoice as any).remainingBalance ??
      (invoice.totalAmount || 0) - (invoice.amountPaid || 0) - ((invoice as any).totalWrittenOff || 0);
    setPaymentModalInvoice(invoice);
    setPaymentModalOpen(true);
    setPaymentAmount(remaining > 0 ? remaining.toFixed(2) : "");
    setPaymentNote("");
    setNextPaymentDate("");
    setAllowOverpayment(false);
    setPaymentInstallmentIndex(null);
    setPaymentError(null);
    setPaymentAmountError(null);
  };

  const handleRecordPayment = async () => {
    if (!paymentModalInvoice) return;
    const parsed = parseMoneyInput(paymentAmount);
    if ("error" in parsed) {
      setPaymentAmountError(parsed.error);
      return;
    }
    const amount = parsed.amount;
    // Same derivation the modal displays, so the overpayment check can't
    // disagree with the "Fill Remaining" amount the user just clicked.
    const remaining = getInvoiceRemainingBalance(paymentModalInvoice);
    if (amount > remaining && !allowOverpayment) {
      setPaymentError('Payment exceeds remaining balance. Check "Allow overpayment" to proceed.');
      return;
    }

    setUpdatingPayment(true);
    setPaymentError(null);
    try {
      if (paymentModalInvoice._source === "matter") {
        const matterId = (paymentModalInvoice as any).matterId;
        if (!matterId) throw new Error("Missing matter ID for this invoice");
        await billingService.updateInvoicePayment({
          type: 'matter',
          lawFirmId,
          entityId: matterId,
        }, paymentModalInvoice.id, {
          paymentAmount: amount,
          paidDate: todayLocalDate(),
          nextPaymentDate: nextPaymentDate || null,
          allowOverpayment: amount > remaining ? true : undefined,
          paymentNote: paymentNote.trim() || undefined,
          ...(paymentInstallmentIndex != null ? { installmentIndex: paymentInstallmentIndex } : {}),
        });
      } else {
        await billingService.updateInvoicePayment({
          type: 'client',
          lawFirmId,
          entityId: clientId,
        }, paymentModalInvoice.id, {
          paymentAmount: amount,
          paidDate: todayLocalDate(),
          paymentNote: paymentNote.trim() || undefined,
          allowOverpayment: amount > remaining ? true : undefined,
          ...(paymentInstallmentIndex != null ? { installmentIndex: paymentInstallmentIndex } : {}),
        });
      }
      setPaymentModalOpen(false);
      // A recorded payment changes what the detail modal shows, so close it too
      // rather than leaving stale figures behind the dismissed payment dialog.
      setDetailInvoiceOpen(false);
      await refreshInvoiceViews();
      // The calendar's payment markers are derived from invoice payment state,
      // so invalidate that query to drop/update the marker for the paid invoice.
      queryClient.invalidateQueries({ queryKey: ["billing", "paymentDates", lawFirmId] });
    } catch (err) {
      setPaymentError(getErrorMessage(err, "Failed to record payment"));
    } finally {
      setUpdatingPayment(false);
    }
  };

  // ── Create invoice handlers ──
  const addLineItem = () => {
    setNewInvLineItems((prev) => [...prev, { description: "", amount: "" }]);
  };

  const removeLineItem = (index: number) => {
    setNewInvLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const updateLineItem = (index: number, field: "description" | "amount", value: string) => {
    setNewInvLineItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const lineItemsTotal = newInvLineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

  const handleCreateInvoice = async () => {
    if (!newInvNumber.trim()) {
      setCreateError("Invoice number is required");
      return;
    }
    const validItems = newInvLineItems.filter((li) => li.description.trim() && parseFloat(li.amount) > 0);
    if (validItems.length === 0) {
      setCreateError("At least one line item with a description and amount is required");
      return;
    }

    setCreatingInvoice(true);
    setCreateError(null);
    try {
      const linkedTaskId = newInvTaskId || null;
      const normalizedLineItems = validItems.map((li, index) => ({
        id: `line-${index + 1}`,
        description: li.description.trim(),
        amount: Math.round(parseFloat(li.amount) * 100) / 100,
      }));
      const totalAmount = normalizedLineItems.reduce((sum, item) => sum + item.amount, 0);

      await billingService.createInvoice({
        type: 'client',
        lawFirmId,
        entityId: clientId,
      }, {
        invoiceName: newInvNumber.trim(),
        invoiceDate: newInvDate,
        dueDate: newInvDueDate || null,
        matterId: newInvMatterId || undefined,
        notes: newInvNotes.trim() || undefined,
        timeEntries: [],
        flatFees: normalizedLineItems,
        totalHours: 0,
        totalAmount,
        flatFeesAmount: totalAmount,
      });

      // Add the client to the linked task if not already present
      if (linkedTaskId) {
        // The picker only ever offered what this list holds, so the selection is
        // always in it.
        const linkedTask = invoiceTaskOptions.find((t) => (t.taskId || t.id) === linkedTaskId);
        if (linkedTask && !linkedTask.matterId) {
          const existingIds = linkedTask.clientIds || [];
          if (!existingIds.includes(clientId)) {
            await TasksService.updateTask({
              lawFirmId,
              taskId: linkedTaskId,
              clientIds: [...existingIds, clientId],
            }).catch(() => {});
          }
        }
      }

      setShowCreateInvoice(false);
      resetCreateForm();
      await refreshInvoiceViews();
    } catch (err) {
      setCreateError(getErrorMessage(err, "Failed to create invoice"));
    } finally {
      setCreatingInvoice(false);
    }
  };

  // ── Delete direct invoice handler ──
  const handleDeleteDirectInvoice = async () => {
    if (!detailInvoice) return;
    setDeletingInvoice(true);
    setDeleteInvoiceError(null);
    try {
      await billingService.deleteInvoice(
        { type: 'client', lawFirmId, entityId: clientId },
        detailInvoice.id,
      );
      // Leave `confirmDelete` set: the panel is fading out with the confirmation
      // still showing, and opening the next invoice resets it.
      setDetailInvoiceOpen(false);
      await refreshInvoiceViews();
    } catch (err) {
      // Shown in the dialog, which stays open so the firm can retry.
      setDeleteInvoiceError(getErrorMessage(err, "Failed to delete invoice"));
    } finally {
      setDeletingInvoice(false);
    }
  };

  // ── Row-level delete handler ──
  const handleDeleteFromRow = async (inv: MergedInvoice) => {
    setDeletingRowId(inv.id);
    setRowDeleteError(null);
    try {
      if (inv._source === "direct") {
        await billingService.deleteInvoice(
          { type: 'client', lawFirmId, entityId: clientId },
          inv.id,
        );
      } else {
        const matterId = (inv as any).matterId;
        if (matterId) {
          await billingService.deleteInvoice(
            { type: 'matter', lawFirmId, entityId: matterId },
            inv.id,
          );
        }
      }
      setConfirmDeleteRowId(null);
      await refreshInvoiceViews();
    } catch (err) {
      // The confirm dialog has already closed, so the refusal is raised as a toast.
      setRowDeleteError(getErrorMessage(err, "Failed to delete invoice"));
    } finally {
      setDeletingRowId(null);
    }
  };

  const resetCreateForm = () => {
    setNewInvNumber("");
    setNewInvDate(todayLocalDate());
    setNewInvDueDate("");
    setNewInvNotes("");
    setNewInvMatterId("");
    setNewInvTaskId("");
    setNewInvLineItems([{ description: "", amount: "" }]);
    setCreateError(null);
  };

  // Already the server's page: filtered, ordered and windowed there. The three
  // pagers below stay client-side - those lists are bounded by the relationship's
  // fee and plan count, not by its billing history.
  // The server page, shaped into the row this tab renders. `billingRelation` and
  // the recipient fields now come from the server (it owns the attribution, so the
  // "Billed to" filter and the money summary agree with the list); `_source` and
  // the matter labels are cheap local derivations from the row itself.
  const filteredInvoices = useMemo<MergedInvoice[]>(
    () =>
      invoiceTable.rows.map((inv) => ({
        ...inv,
        billingRelation: inv.billingRelation ?? "shared_unassigned",
        billingRecipientName: inv.billingRecipientName ?? null,
        billingRecipientClientId: inv.billingRecipientClientId ?? null,
        _source: inv.contextType === "matter" ? "matter" : "direct",
        _matterName: inv.matterName || undefined,
        _matterId: inv.matterId || null,
        _companyName: findLinkedCompanyName(
          companyNames,
          inv.billingRecipientClientId,
          inv.entityId,
          inv.clientId,
          inv.matterClientId,
        ),
      }) as MergedInvoice),
    [invoiceTable.rows, companyNames],
  );
  const totalInvoices = invoiceTable.total;
  const invoiceTotalPages = Math.max(
    1,
    Math.ceil(totalInvoices / Math.max(1, invoiceTable.rowsPerPage)),
  );

  const directFeesPager = usePagedRows(savedDirectFlatFees, 10);
  const linkedFeesPager = usePagedRows(linkedMatterFlatFees, 10);
  const retainerPlansPager = usePagedRows(recurringRetainerPlans, 10);

  return (
    <div className="space-y-6">
      {downloadError && (
        <ErrorToast message={downloadError} onDismiss={() => setDownloadError(null)} />
      )}
      {rowDeleteError && (
        <ErrorToast message={rowDeleteError} onDismiss={() => setRowDeleteError(null)} />
      )}
      {/* Header with Create button */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-on-surface">Billing Overview</h3>
        <div className="flex items-center gap-2">
          {/* Every flat-fee write route requires billing.manageInvoices, so a
              member without it sees the fees and no controls. */}
          {canManageInvoices && (
            <Button onClick={addFlatFeeDraft} type="secondary" size="compact" icon={<Plus size={14} strokeWidth={2.2} />}>
              Add Flat Fee
            </Button>
          )}
          {canManageInvoices && (
            <Button
              onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}/generate-invoice`)}
              size="compact"
              icon={<Plus size={14} strokeWidth={2.2} />}
            >
              Create Invoice
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className={`grid grid-cols-2 gap-4 ${planCount > 0 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
        <BillingSummaryCard label="Total Billed" value={formatCurrency(totalAmount)} />
        <BillingSummaryCard label="Total Paid" value={formatCurrency(totalPaid)} />
        <BillingSummaryCard label="Outstanding" value={formatCurrency(outstanding)} highlight={outstanding > 0} />
        <BillingSummaryCard
          label="Unbilled Flat Fees"
          value={formatCurrency(totalVisibleFlatFees)}
          subtitle={
            linkedMatterFlatFeeTotal > 0
              ? `${formatCurrency(directFlatFeeTotal)} direct · ${formatCurrency(linkedMatterFlatFeeTotal)} on linked matters`
              : `${savedDirectFlatFees.length + newDirectFlatFees.length} direct fee${savedDirectFlatFees.length + newDirectFlatFees.length === 1 ? "" : "s"}`
          }
        />
        {planCount > 0 && (
          <BillingSummaryCard
            label="Payment Plans"
            value={`${planCount} active`}
            subtitle={
              nextPlanPayment
                ? `Next: ${formatCurrency(Number(nextPlanPayment.amount) || 0)} on ${formatDateOnly(nextPlanPayment.dueDate)}`
                : undefined
            }
          />
        )}
      </div>

      <div ref={flatFeesSectionRef} className="rounded-2xl border border-outline bg-surface-alt/60 p-4 md:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-on-surface">Unbilled Flat Fees</h4>
            <p className="mt-1 text-sm text-on-surface-secondary">
              Direct client fees can be added and billed here. Matter-owned fees stay on their matter and are shown so this client billing view stays connected to matter billing.
            </p>
          </div>
          {canManageInvoices && (
            <Button onClick={addFlatFeeDraft} type="secondary" size="small" icon={<Plus size={14} />}>
              Add Flat Fee
            </Button>
          )}
        </div>

        {flatFeeError && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800/60 dark:bg-rose-900/20 dark:text-rose-300">
            {flatFeeError}
          </div>
        )}

        {/*
          The firm-wide read serves one bounded page, so a client carrying more
          unbilled fees than it holds gets a window rather than the whole set.
          Say so: this section is what a firm reads to decide what is still to
          be billed, and a silently shortened list is a fee that never gets
          invoiced.
        */}
        <TruncatedListNotice
          truncated={flatFeesTruncated}
          unitLabel="unbilled flat fees"
          mode="firmList"
          className="mt-4"
        />

        {flatFeesLoading ? (
          <ListSkeleton rows={4} label="Loading flat fees" />
        ) : flatFeesReadError ? (
          // A failed read leaves both lists empty; showing their empty states
          // would tell the firm there is nothing left to bill.
          <ErrorNotification error={flatFeesReadError} onRetry={() => void loadFlatFees()} className="mt-4" />
        ) : (
          <div className="mt-5 space-y-5">
            <div className="flex flex-col rounded-2xl border border-outline bg-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h5 className="text-sm font-medium text-on-surface">Direct Client Flat Fees</h5>
                  <p className="mt-0.5 text-xs text-on-surface-muted">These fees belong to this client directly and appear in the client invoice flow.</p>
                </div>
                <span className="rounded-full bg-surface-alt px-2.5 py-1 text-xs font-medium text-on-surface-secondary">
                  {formatCurrency(directFlatFeeTotal)}
                </span>
              </div>

              {savedDirectFlatFees.length > 0 && (
                <div className="order-2 space-y-2">
                  {directFeesPager.pagedRows.map((fee) => (
                    editingDirectFlatFee?.id === fee.id ? (
                      <FlatFeeEditorRow
                        key={fee.id}
                        fee={editingDirectFlatFee}
                        onChange={setEditingDirectFlatFee}
                        onSave={() => void handleUpdateDirectFlatFee()}
                        onDiscard={() => setEditingDirectFlatFee(null)}
                        saving={savingFlatFeeId === fee.id}
                        saveLabel="Save"
                        discardAs="button"
                      />
                    ) : (
                      <FlatFeeSavedRow
                        key={fee.id}
                        fee={fee}
                        badge={<StatusBadge variant="info">Direct client fee</StatusBadge>}
                        onEdit={canManageInvoices ? () => setEditingDirectFlatFee({
                          id: fee.id,
                          description: fee.description,
                          amount: fee.amount,
                          date: fee.date || "",
                        }) : undefined}
                        onDelete={canManageInvoices ? () => removeSavedFlatFee(fee.id) : undefined}
                        deleting={deletingFlatFeeKey === `direct:${fee.id}`}
                        disabled={Boolean(editingDirectFlatFee)}
                      />
                    )
                  ))}
                  {directFeesPager.total > directFeesPager.rowsPerPage && (
                    <AutoPager pager={directFeesPager} />
                  )}
                </div>
              )}

              {newDirectFlatFees.length > 0 && (
                <div className="order-1 mb-4 space-y-3">
                  {newDirectFlatFees.map((fee) => (
                    <FlatFeeEditorRow
                      key={fee.id}
                      fee={fee}
                      onChange={(next) =>
                        setDirectFlatFees((prev) =>
                          prev.map((existingFee) => (existingFee.id === fee.id ? { ...existingFee, ...next } : existingFee)),
                        )
                      }
                      onSave={() => void handleSaveFlatFee(fee)}
                      onDiscard={() => removeNewFlatFee(fee.id)}
                      saving={savingFlatFeeId === fee.id}
                      saveLabel="Done"
                      discardAs="trash"
                      matterLink={
                        clientMatters.length > 0
                          ? {
                              value: fee._matterId || "",
                              options: [
                                { value: "", label: "No matter (direct client fee)" },
                                ...clientMatters.map((clientMatter) => ({
                                  value: clientMatter.id,
                                  label: clientMatter.name,
                                })),
                              ],
                              onChange: (matterId) =>
                                setDirectFlatFees((prev) =>
                                  prev.map((existingFee) =>
                                    existingFee.id === fee.id
                                      ? { ...existingFee, _matterId: matterId || null }
                                      : existingFee,
                                  ),
                                ),
                              note: fee._matterId
                                ? "Saved on the matter and billed from matter billing."
                                : undefined,
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}

              {savedDirectFlatFees.length === 0 && newDirectFlatFees.length === 0 && (
                <p className="rounded-xl border border-dashed border-outline px-4 py-6 text-center text-sm text-on-surface-muted">
                  {canManageInvoices
                    ? "No direct client flat fees yet. Add one here to keep it on the client, or use the linked matter section below for matter-owned fees."
                    : "No direct client flat fees yet."}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-outline bg-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h5 className="text-sm font-medium text-on-surface">Linked Matter Flat Fees</h5>
                  <p className="mt-0.5 text-xs text-on-surface-muted">These fees stay on their matter. Billing routes into matter billing with this fee preselected.</p>
                </div>
                <span className="rounded-full bg-surface-alt px-2.5 py-1 text-xs font-medium text-on-surface-secondary">
                  {formatCurrency(linkedMatterFlatFeeTotal)}
                </span>
              </div>

              {linkedMatterFlatFees.length === 0 ? (
                <p className="rounded-xl border border-dashed border-outline px-4 py-6 text-center text-sm text-on-surface-muted">
                  No unbilled matter flat fees are linked to this client right now.
                </p>
              ) : (
                <div className="space-y-2">
                  {linkedFeesPager.pagedRows.map((fee) => {
                    const sharedLabel = getSharedMatterMarker(fee._otherClientCount || 0);
                    return (
                      <div key={`case-${fee.id}-${fee._matterId}`} className="flex items-center justify-between gap-3 rounded-xl border border-outline bg-surface-alt/40 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-on-surface">{fee.description}</span>
                            <StatusBadge variant="success">Unbilled</StatusBadge>
                            {fee._matterName && (
                              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                                Matter: {fee._matterName}
                              </span>
                            )}
                            {fee._recipientStatusLabel && (
                              <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-semibold text-on-surface-secondary">
                                {fee._recipientStatusLabel}
                              </span>
                            )}
                            {sharedLabel && (
                              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                                {sharedLabel}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-secondary">
                            <span>{formatCurrency(fee.amount)}</span>
                            {fee.date && <span>{dayjs(fee.date).format("MMM D, YYYY")}</span>}
                            <span>Managed from matter billing</span>
                          </div>
                        </div>
                        {fee._matterId && (
                          <Button onClick={() => routeLinkedMatterFlatFee(fee)} type="secondary" size="small">
                            <span className="flex items-center gap-1">
                              <ExternalLink size={12} />
                              {fee._billingActionLabel || "Open Matter Billing"}
                            </span>
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {linkedFeesPager.total > linkedFeesPager.rowsPerPage && (
                    <AutoPager pager={linkedFeesPager} />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-outline bg-surface-alt/60 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <label className={`min-w-[200px] flex-1 ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Search</span>
            <input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Search invoices..."
              className={INPUT_CLS}
            />
          </label>

          {clientMatters.length > 1 && (
            <label className={`min-w-[180px] ${FIELD_CLS}`}>
              <span className={FIELD_LABEL_CLS}>Matter</span>
              <Dropdown
                value={filterMatterId}
                onChange={setFilterMatterId}
                options={[
                  { value: "", label: "All matters" },
                  ...clientMatters.map((clientMatter) => ({ value: clientMatter.id, label: clientMatter.name })),
                ]}
              />
            </label>
          )}

          <label className={`min-w-[160px] ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Status</span>
            <Dropdown
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: "", label: "All" },
                { value: "outstanding", label: "Unpaid" },
                { value: "overdue", label: "Overdue" },
                { value: "partially_paid", label: "Partially Paid" },
                { value: "paid", label: "Paid" },
                { value: "credited", label: "Written Off" },
                { value: "voided", label: "Voided" },
              ]}
            />
          </label>

          <label className={`min-w-[220px] ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Billing</span>
            <Dropdown
              value={filterBillingRelation}
              onChange={setFilterBillingRelation}
              options={[
                { value: "", label: "All" },
                { value: "owned", label: "This client" },
                { value: "other_client", label: "Other client on shared matter" },
                { value: "shared_unassigned", label: "Shared matter / no recipient" },
              ]}
            />
          </label>

          <label className={`min-w-[280px] ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Date Range</span>
            <DateRangePicker
              from={filterDateFrom}
              to={filterDateTo}
              onChange={(next) => {
                setFilterDateFrom(next.from ?? "");
                setFilterDateTo(next.to ?? "");
              }}
            />
          </label>

          {(filterSearch || filterMatterId || filterStatus || filterBillingRelation || filterDateFrom || filterDateTo) && (
            <button
              type="button"
              onClick={() => { setFilterSearch(""); setFilterMatterId(""); setFilterStatus(""); setFilterBillingRelation(""); setFilterDateFrom(""); setFilterDateTo(""); }}
              className="rounded-xl border border-outline px-4 py-2 text-sm font-medium text-on-surface-secondary transition hover:bg-surface-hover active:scale-[0.96] motion-reduce:active:scale-100"
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Every control above is a server filter, so the rows and this count stay
          as they were until the response lands. The busy line is what says so. */}
      <div className="flex items-center gap-3">
        <p className="text-sm text-on-surface-secondary">
          {totalInvoices} {totalInvoices === 1 ? "invoice" : "invoices"}
        </p>
        <ListBusyIndicator busy={invoiceTable.fetching && !invoiceTable.loading && !invoicePagerPending} />
      </div>

      {recurringRetainerPlans.length > 0 && (
        <RecurringRetainerSection
          title="Evergreen retainers linked to this client"
          description="Direct client retainers and linked matter retainers show up here."
          onOpenWorkbench={() => navigate(`/lawfirm/${lawFirmId}/billing`)}
        >
          {retainerPlansPager.pagedRows.map((plan) => {
            const relatedMatter = plan.contextType === "matter" ? clientMatterMap.get(plan.entityId) || null : null;
            return (
              <RecurringRetainerPlanCard
                key={plan.id}
                plan={plan}
                lawFirmId={lawFirmId}
                navigate={navigate}
                badges={
                  <span className="inline-flex items-center rounded-full bg-surface-alt px-2.5 py-0.5 text-xs font-medium text-on-surface-secondary">
                    {plan.contextType === "matter" ? "Linked matter" : "Direct client"}
                  </span>
                }
                amountSuffix={relatedMatter ? ` • ${relatedMatter.name}` : ""}
                latestInvoiceHref={(draft) =>
                  draft.generatedInvoiceEntityId
                    ? draft.generatedInvoiceContextType === "matter"
                      ? `/lawfirm/${lawFirmId}/matters/${draft.generatedInvoiceEntityId}/invoices/${draft.generatedInvoiceId}`
                      : `/lawfirm/${lawFirmId}/clients/${draft.generatedInvoiceEntityId}/invoices/${draft.generatedInvoiceId}`
                    : null
                }
              />
            );
          })}
          <AutoPager pager={retainerPlansPager} />
        </RecurringRetainerSection>
      )}

      {/* Invoice cards. The region holds a floor height so narrowing the filters from a
          full page of results down to one row leaves space instead of collapsing. */}
      <div className="min-h-[420px]">
        {invoiceTable.loading ? (
          <ListSkeleton rows={5} label="Loading client invoices" />
        ) : totalInvoices === 0 ? (
          <ListEmptyState
            icon={<FileText size={40} />}
            title={allInvoices.length === 0 ? "No invoices yet" : "No invoices match these filters"}
            message={
              allInvoices.length === 0
                ? "Create an invoice to get started."
                : "Try adjusting the search or filters."
            }
          />
        ) : (
          <div className="space-y-3">
            {filteredInvoices.map((inv) => {
              const isOwnedInvoice = inv.billingRelation === "owned";
              // Paid, written off or voided: nothing is owed, so no payment is offered.
              // A voided invoice keeps `isPaid` false, so the status decides too.
              const isSettled = isClosedStatusKey(getInvoiceStatusKey(inv)) || inv.isPaid;
              const menuActions: RowAction[] = [
                {
                  label: downloadingInvoiceId === inv.id ? "Generating..." : "Download PDF",
                  icon: <Download className="w-4 h-4" />,
                  onClick: () => handleDownloadInvoicePdf(inv),
                },
                ...(isOwnedInvoice && canManageInvoices
                  ? [
                      {
                        label: "Delete",
                        icon: <Trash2 className="w-4 h-4" />,
                        onClick: () => setConfirmDeleteRowId(inv.id),
                        danger: true,
                      },
                    ]
                  : []),
              ];

              return (
                <InvoiceListCard
                  key={`${inv._source}-${inv.id}`}
                  invoice={inv as unknown as Invoice}
                  onOpen={() => { setDetailInvoice(inv); setDetailInvoiceOpen(true); setConfirmDelete(false); setDeleteInvoiceError(null); }}
                  menuActions={menuActions}
                  actions={
                    <>
                      {inv._source === "matter" && (inv as any).matterId && (
                        <Button onClick={() => openMatterBilling((inv as any).matterId)} type="secondary" size="small">
                          <span className="flex items-center gap-1">
                            <ExternalLink size={11} />
                            Matter Billing
                          </span>
                        </Button>
                      )}
                      {/* Shown busy while Stripe is checked, so it never pops in. */}
                      {canRecordPayments && (stripeStatus === "loading" || stripeStatus === "ready") && !isSettled && isOwnedInvoice && (
                        <button
                          onClick={() => { setStripeConfirmInvoice(inv); setStripeConfirmOpen(true); }}
                          disabled={stripeStatus === "loading"}
                          className="inline-flex items-center gap-1 rounded-lg bg-accent-solid px-2.5 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          {stripeStatus === "loading" ? <Spinner size={11} /> : <CreditCard size={11} />}
                          Request Payment
                        </button>
                      )}
                      {canRecordPayments && !isSettled && isOwnedInvoice && (
                        <Button onClick={() => openPaymentModal(inv)} type="success" size="small" icon={<DollarSign size={11} />}>
                          Pay
                        </Button>
                      )}
                    </>
                  }
                >
                  {inv.invoiceDate && <div>{dayjs(inv.invoiceDate).format("MMM D, YYYY")}</div>}
                  {(inv._matterName || inv._taskName) ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {inv._matterName && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                          <Briefcase size={11} />
                          Matter: {inv._matterName}
                        </span>
                      )}
                      {inv._taskName && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-2.5 py-1 text-[11px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                          <ClipboardCheck size={11} />
                          Task: {inv._taskName}
                        </span>
                      )}
                      {inv._source === "matter" && inv.billingRelation !== "owned" && (
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          inv.billingRelation === "other_client"
                            ? "bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                            : "bg-surface-alt text-on-surface-secondary"
                        }`}>
                          {getBillingRelationLabel(inv.billingRelation, inv.billingRecipientName)}
                        </span>
                      )}
                      {inv._companyName && <TagChip label={inv._companyName} />}
                      {isRecurringRetainerInvoice(inv) && getRecurringRetainerPlanName(inv) && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          Plan: {getRecurringRetainerPlanName(inv)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-on-surface-secondary">
                        Direct client invoice
                      </span>
                      {inv._companyName && <TagChip label={inv._companyName} />}
                      {isRecurringRetainerInvoice(inv) && getRecurringRetainerPlanName(inv) && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          Plan: {getRecurringRetainerPlanName(inv)}
                        </span>
                      )}
                    </div>
                  )}
                  {!isOwnedInvoice && (
                    <p className="mt-2 text-on-surface-muted">
                      Visible for shared-matter context only. Totals and balance on this page do not include this invoice.
                    </p>
                  )}
                </InvoiceListCard>
              );
            })}
            <ListPager
              page={invoiceTable.page}
              totalPages={invoiceTotalPages}
              total={totalInvoices}
              rowsPerPage={invoiceTable.rowsPerPage}
              onPageChange={invoiceTable.setPage}
              onRowsPerPageChange={invoiceTable.setRowsPerPage}
              rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
              busy={invoiceTable.fetching}
              onPendingChange={setInvoicePagerPending}
              serverPaged
            />
          </div>
        )}
      </div>

      {/* ── Record Payment Modal ── */}
      {paymentModalInvoice && (
        <RecordPaymentModal
          open={paymentModalOpen}
          onClose={() => setPaymentModalOpen(false)}
          invoiceLabel={getInvoiceDisplayName(paymentModalInvoice)}
          totalAmount={paymentModalInvoice.totalAmount || 0}
          amountPaid={paymentModalInvoice.amountPaid || 0}
          remainingBalance={getInvoiceRemainingBalance(paymentModalInvoice)}
          amount={paymentAmount}
          onAmountChange={(value) => { setPaymentAmount(value); setPaymentAmountError(null); }}
          amountError={paymentAmountError}
          allowOverpayment={allowOverpayment}
          onAllowOverpaymentChange={setAllowOverpayment}
          note={paymentNote}
          onNoteChange={setPaymentNote}
          nextPaymentDate={paymentModalInvoice._source === "matter" ? nextPaymentDate : undefined}
          onNextPaymentDateChange={
            paymentModalInvoice._source === "matter" ? setNextPaymentDate : undefined
          }
          installments={(paymentModalInvoice.paymentPlan?.expectedPayments || [])
            .map((ep, index) => ({ ep, index }))
            .filter(({ ep }) => ep.status === "pending" || ep.status === "overdue")
            .map(({ ep, index }) => ({ index, dueDate: ep.dueDate, amount: ep.amount }))}
          selectedInstallmentIndex={paymentInstallmentIndex}
          onSelectedInstallmentChange={setPaymentInstallmentIndex}
          stacked={detailInvoiceOpen}
          error={paymentError}
          submitting={updatingPayment}
          onSubmit={handleRecordPayment}
        />
      )}

      {/* ── Create Invoice Modal ── */}
      <Modal
        isOpen={showCreateInvoice}
        onClose={() => setShowCreateInvoice(false)}
        showClose={false}
        labelledBy={createInvoiceTitleId}
        bodyClassName={null}
        size="lg"
        className="rounded-xl border border-outline overflow-y-auto overflow-x-hidden"
      >
            <div className="p-6">
              <h2 id={createInvoiceTitleId} className="text-lg font-semibold text-on-surface mb-1">Create Invoice</h2>
              <p className="text-sm text-on-surface-secondary mb-6">
                Create a new invoice for {client?.name || "this client"}.
              </p>

              {createError && (
                <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 rounded-lg text-xs text-rose-700 dark:text-rose-300">
                  {createError}
                </div>
              )}

              <div className="space-y-4">
                {/* Invoice Name */}
                <div>
                  <FieldLabel htmlFor={`${fieldIds}-newinvnumber`}>Invoice Name *</FieldLabel>
                  <input
                    id={`${fieldIds}-newinvnumber`}
                    type="text"
                    value={newInvNumber}
                    onChange={(e) => setNewInvNumber(e.target.value)}
                    className="w-full px-3 py-2 border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
                    placeholder="e.g. Client Intake, Monthly Retainer"
                    autoFocus
                  />
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel id={`${fieldIds}-invoice-date-label`}>Invoice Date *</FieldLabel>
                    <DatePicker
                      ariaLabelledBy={`${fieldIds}-invoice-date-label`}
                      value={newInvDate} onChange={setNewInvDate} className="w-full" />
                  </div>
                  <div>
                    <FieldLabel id={`${fieldIds}-due-date-label`}>
                      Due Date
                    </FieldLabel>
                    <DatePicker
                      ariaLabelledBy={`${fieldIds}-due-date-label`}
                      value={newInvDueDate} onChange={setNewInvDueDate} className="w-full" />
                  </div>
                </div>

                {/* Optional matter / task links */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel id={`${fieldIds}-link-to-matter-label`}>
                      Link to Matter
                    </FieldLabel>
                    <Dropdown
                      ariaLabelledBy={`${fieldIds}-link-to-matter-label`}
                      portal
                      value={newInvMatterId}
                      onChange={(value) => {
                        setNewInvMatterId(value);
                        setNewInvTaskId("");
                      }}
                      options={[
                        { value: "", label: "None" },
                        ...clientMatters.map((clientMatter) => ({
                          value: clientMatter.id,
                          label: clientMatter.name || "Unnamed Matter",
                        })),
                      ]}
                      buttonClassName="border-input-border bg-input-bg"
                    />
                  </div>
                  <div>
                    <FieldLabel id={`${fieldIds}-link-to-task-label`}>
                      Link to Task
                    </FieldLabel>
                    <Dropdown
                      ariaLabelledBy={`${fieldIds}-link-to-task-label`}
                      portal
                      value={newInvTaskId}
                      onChange={setNewInvTaskId}
                      options={[
                        { value: "", label: "None" },
                        ...invoiceTaskOptions.map((task) => ({
                          value: task.taskId || task.id,
                          label: task.title,
                        })),
                      ]}
                      buttonClassName="border-input-border bg-input-bg"
                    />
                  </div>
                </div>

                {/* Line Items */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-on-surface">Line Items *</label>
                    <button
                      onClick={addLineItem}
                      className="text-xs text-accent-emphasis hover:underline font-medium cursor-pointer"
                    >
                      + Add Item
                    </button>
                  </div>
                  <div className="space-y-2">
                    {newInvLineItems.map((item, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={item.description}
                          onChange={(e) => updateLineItem(i, "description", e.target.value)}
                          className="flex-1 px-3 py-2 border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none text-sm"
                          placeholder="Description"
                        />
                        <div className="relative w-28">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted text-sm">
                            $
                          </span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.amount}
                            onChange={(e) => updateLineItem(i, "amount", e.target.value)}
                            className="w-full pl-7 pr-3 py-2 border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none text-sm"
                            placeholder="0.00"
                          />
                        </div>
                        {newInvLineItems.length > 1 && (
                          <ActionIconButton
                            label="Remove line item"
                            onClick={() => removeLineItem(i)}
                            tone="danger"
                          >
                            <Trash2 size={14} />
                          </ActionIconButton>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-right text-sm font-semibold text-on-surface">
                    Total: {formatCurrency(lineItemsTotal)}
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <FieldLabel htmlFor={`${fieldIds}-newinvnotes`}>
                    Notes
                  </FieldLabel>
                  <textarea
                    id={`${fieldIds}-newinvnotes`}
                    value={newInvNotes}
                    onChange={(e) => setNewInvNotes(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none resize-none text-sm"
                    placeholder="Additional notes..."
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-outline px-6 py-4 flex justify-end gap-3">
              <Button
                onClick={() => setShowCreateInvoice(false)}
                type="secondary"
                size="small"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateInvoice}
                type="primary"
                size="small"
                disabled={
                  creatingInvoice ||
                  !newInvNumber.trim() ||
                  !newInvLineItems.some((li) => li.description.trim() && parseFloat(li.amount) > 0)
                }
              >
                {creatingInvoice ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
      </Modal>

      {/* ── Invoice Detail Modal ── */}
      {detailInvoice && (() => {
        const isDirect = detailInvoice._source === "direct";
        const isMatter = detailInvoice._source === "matter";
        const isOwnedInvoice = detailInvoice.billingRelation === "owned";
        const isSettled = isClosedStatusKey(getInvoiceStatusKey(detailInvoice)) || detailInvoice.isPaid;
        const invoiceData = detailInvoice as Invoice & MergedInvoice;

        // The API returns typed arrays (time entries, flat fees, expenses)
        // rather than one mixed list, so build the display list from those.
        const lineItems: { label: string; detail?: string; amount: number }[] = [];
        (invoiceData.timeEntries || []).forEach((te) => {
          lineItems.push({
            label: te.name || te.description || "Time entry",
            detail: te.hours ? `${formatHoursMinutes(te.hours)} × ${formatCurrency(Number(te.rate) || 0)}` : undefined,
            amount: te.amount || 0,
          });
        });
        (invoiceData.flatFees || []).forEach((ff) => {
          lineItems.push({ label: ff.description || "Flat fee", amount: ff.amount || 0 });
        });

        const payments = invoiceData.payments || [];
        const notes = invoiceData.notes;
        // The balance every other invoice surface shows, including the Record
        // Payment dialog this one opens. The server's raw `remainingBalance` is
        // not zeroed for a voided invoice.
        const remaining = getInvoiceRemainingBalance(detailInvoice);

        return (
          <Modal
            isOpen={detailInvoiceOpen}
            onClose={() => setDetailInvoiceOpen(false)}
            labelledBy={detailInvoiceTitleId}
            size="xl"
            showClose={false}
            bodyClassName={null}
            className="border border-outline rounded-xl"
          >
              <div className="p-6 overflow-y-auto overflow-x-hidden styled-scrollbar">
                <ErrorNotification
                  error={deleteInvoiceError}
                  onClose={() => setDeleteInvoiceError(null)}
                  compact
                  className="mb-4"
                />
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 id={detailInvoiceTitleId} className="text-lg font-semibold text-on-surface">
                      {detailInvoice.invoiceName}
                    </h2>
                    <p className="text-sm text-on-surface-secondary mt-0.5">
                      {detailInvoice.invoiceDate
                        ? formatDateOnly(detailInvoice.invoiceDate)
                        : "No date"}
                      {detailInvoice.dueDate && (
                        <> &middot; Due: {formatDateOnly(detailInvoice.dueDate)}</>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isRecurringRetainerInvoice(detailInvoice) && (
                      <StatusBadge variant="success">Recurring Retainer</StatusBadge>
                    )}
                    {(detailInvoice as any).paymentPlan?.enabled && (
                      <StatusBadge variant="purple"><Calendar size={10} /> Payment Plan</StatusBadge>
                    )}
                    {(() => {
                      const { label, variant } = getInvoiceStatus(detailInvoice);
                      return <StatusBadge variant={variant}>{label}</StatusBadge>;
                    })()}
                  </div>
                </div>

                {/* Source & linked matter/task */}
                {isRecurringRetainerInvoice(detailInvoice) && (
                  <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">
                    This invoice was generated from a recurring retainer plan
                    {getRecurringRetainerPlanName(detailInvoice) ? `: ${getRecurringRetainerPlanName(detailInvoice)}.` : "."}
                  </div>
                )}
                <div className="flex items-center gap-2 mb-4 flex-wrap">
                  {detailInvoice._matterName && (
                    <span className="text-xs font-medium px-2 py-1 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 inline-flex items-center gap-1">
                      <Briefcase size={11} />
                      {detailInvoice._matterName}
                    </span>
                  )}
                  {detailInvoice._taskName && (
                    <span className="text-xs font-medium px-2 py-1 rounded bg-purple-50 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 inline-flex items-center gap-1">
                      <ClipboardCheck size={11} />
                      {detailInvoice._taskName}
                    </span>
                  )}
                  {isDirect && !detailInvoice._matterName && !detailInvoice._taskName && (
                    <StatusBadge variant="neutral">Direct Invoice</StatusBadge>
                  )}
                  {isMatter && detailInvoice.billingRelation !== "owned" && (
                    <StatusBadge variant={detailInvoice.billingRelation === "other_client" ? "warning" : "neutral"}>
                      {getBillingRelationLabel(detailInvoice.billingRelation, detailInvoice.billingRecipientName)}
                    </StatusBadge>
                  )}
                </div>

                {isMatter && !isOwnedInvoice && (
                  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
                    This invoice is shown here because it belongs to a shared matter. It is not counted toward this client's totals on this page.
                  </div>
                )}

                {/* Line Items */}
                {lineItems.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-2">
                      {isMatter ? "Billed Items" : "Line Items"}
                    </p>
                    <div className="bg-surface-alt rounded-lg border border-outline-subtle divide-y divide-outline-subtle overflow-hidden">
                      {lineItems.map((li, i) => (
                        <div key={i} className="flex items-center justify-between px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <span className="text-sm text-on-surface">{li.label}</span>
                            {li.detail && (
                              <span className="text-xs text-on-surface-muted ml-2">{li.detail}</span>
                            )}
                          </div>
                          <span className="text-sm font-medium text-on-surface shrink-0 ml-3">
                            {formatCurrency(li.amount)}
                          </span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between px-4 py-2.5 bg-surface">
                        <span className="text-sm font-semibold text-on-surface">Total</span>
                        <span className="text-sm font-bold text-on-surface">
                          {formatCurrency(detailInvoice.totalAmount || 0)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Payment Summary */}
                <InvoiceMoneySummary presentation="client" items={[
                  { label: "Paid", value: formatCurrency(detailInvoice.amountPaid || 0) },
                  { label: "Remaining", value: formatCurrency(Math.max(0, remaining)) },
                  { label: "Payments", value: payments.length },
                ]} />

                {/* Payment History */}
                {payments.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-2">
                      Payment History
                    </p>
                    <div className="bg-surface-alt rounded-lg border border-outline-subtle divide-y divide-outline-subtle">
                      {payments.map((p: any, i: number) => (
                        <div key={i} className="flex items-center justify-between px-4 py-2.5">
                          <div>
                            <span className="text-sm text-on-surface">
                              {dayjs(p.date).format("M/D/YYYY")}
                            </span>
                            {(p.note || p.description) && (
                              <span className="text-xs text-on-surface-muted ml-2">{p.note || p.description}</span>
                            )}
                          </div>
                          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                            +{formatCurrency(p.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Payment Plan Schedule */}
                {(detailInvoice as any).paymentPlan?.enabled && (() => {
                  const plan = (detailInvoice as any).paymentPlan;
                  const eps = plan.expectedPayments || [];
                  const paidCount = eps.filter((p: any) => p.status === "paid").length;
                  const overdueCount = eps.filter((p: any) => p.status === "overdue").length;
                  const progress = eps.length > 0 ? (paidCount / eps.length) * 100 : 0;
                  return (
                    <div className="mb-4">
                      <p className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-3">Payment Plan Schedule</p>
                      <div className="mb-3">
                        <div className="flex items-center justify-between text-[10px] text-on-surface-muted mb-1.5">
                          <span>{paidCount} of {eps.length} installments paid</span>
                          {overdueCount > 0 && (
                            <span className="text-rose-600 dark:text-rose-400 font-medium">{overdueCount} overdue</span>
                          )}
                        </div>
                        <div className="w-full bg-surface-alt rounded-full h-1.5">
                          <div className="bg-emerald-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                      <div className="rounded-lg border border-outline-subtle overflow-hidden">
                        <div className="grid grid-cols-3 px-4 py-2 bg-surface-alt border-b border-outline-subtle text-[10px] font-semibold text-on-surface-muted uppercase tracking-wide">
                          <span>Due Date</span>
                          <span className="text-right">Amount</span>
                          <span className="text-center">Status</span>
                        </div>
                        {eps.map((ep: any, idx: number) => (
                          <div key={idx} className="grid grid-cols-3 items-center px-4 py-2.5 border-b border-outline-subtle last:border-b-0">
                            <span className="text-xs text-on-surface-secondary">
                              {dayjs(ep.dueDate).format("M/D/YYYY")}
                            </span>
                            <span className="text-xs text-on-surface text-right">{formatCurrency(ep.amount)}</span>
                            <span className="flex justify-center">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                ep.status === "paid"
                                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
                                  : ep.status === "overdue"
                                  ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400"
                                  : "bg-surface-alt text-on-surface-muted"
                              }`}>
                                {ep.status === "paid" ? "Paid" : ep.status === "overdue" ? "Overdue" : "Upcoming"}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Notes */}
                {notes && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-1">Notes</p>
                    <p className="text-sm text-on-surface-secondary">{notes}</p>
                  </div>
                )}

                {/* Delete confirmation (direct only) */}
                {isDirect && confirmDelete && (
                  <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 rounded-lg">
                    <p className="text-xs text-rose-700 dark:text-rose-300 font-medium mb-2">
                      Are you sure you want to delete this invoice? This cannot be undone.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button onClick={handleDeleteDirectInvoice} type="danger" size="small" disabled={deletingInvoice}>
                        {deletingInvoice ? "Deleting..." : "Yes, Delete"}
                      </Button>
                      <Button onClick={() => setConfirmDelete(false)} type="secondary" size="small">
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer actions. One right-aligned wrapping row so a matter invoice's extra
                  navigation button lines up with the rest instead of stranding Close beside
                  a second row of buttons. */}
              <div className="border-t border-outline px-6 py-4 flex flex-wrap items-center justify-end gap-2 shrink-0">
                {/* View / Print invoice */}
                {isMatter && invoiceData.matterId && (
                  <Button
                    onClick={() => {
                      setDetailInvoiceOpen(false);
                      navigate(
                        `/lawfirm/${lawFirmId}/matters/${invoiceData.matterId}/invoices/${detailInvoice.id}`
                      );
                    }}
                    type="secondary"
                    size="small"
                  >
                    <span className="flex items-center gap-1">
                      <ExternalLink size={12} />
                      View Invoice
                    </span>
                  </Button>
                )}
                {isDirect && (
                  <Button
                    onClick={() => {
                      setDetailInvoiceOpen(false);
                      navigate(`/lawfirm/${lawFirmId}/clients/${clientId}/invoices/${detailInvoice.id}`);
                    }}
                    type="secondary"
                    size="small"
                  >
                    <span className="flex items-center gap-1">
                      <ExternalLink size={12} />
                      View Invoice
                    </span>
                  </Button>
                )}
                {/* Matter link */}
                {isMatter && invoiceData.matterId && (
                  <Button
                    onClick={() => {
                      setDetailInvoiceOpen(false);
                      openMatterBilling(invoiceData.matterId!);
                    }}
                    type="secondary"
                    size="small"
                  >
                    <span className="flex items-center gap-1">
                      <ExternalLink size={12} />
                      Go to Matter Billing
                    </span>
                  </Button>
                )}
                {/* Delete (direct only) */}
                {canManageInvoices && isDirect && isOwnedInvoice && !confirmDelete && (
                  <Button onClick={() => setConfirmDelete(true)} type="danger" size="small">
                    <span className="flex items-center gap-1">
                      <Trash2 size={12} />
                      Delete
                    </span>
                  </Button>
                )}
                <Button onClick={() => setDetailInvoiceOpen(false)} type="secondary" size="small">
                  Close
                </Button>
                {/* Record payment */}
                {canRecordPayments && !isSettled && isOwnedInvoice && (
                  <Button
                    // Opens above this dialog rather than replacing it, so
                    // cancelling returns to the invoice the user was reading.
                    onClick={() => openPaymentModal(detailInvoice)}
                    type="primary"
                    size="small"
                  >
                    Record Payment
                  </Button>
                )}
              </div>
          </Modal>
        );
      })()}

      {/* Row-level delete confirmation modal */}
      <ConfirmModal
        isOpen={confirmDeleteRowId !== null}
        onClose={() => { if (!deletingRowId) setConfirmDeleteRowId(null); }}
        onConfirm={() => {
          const inv = allInvoices.find((i) => i.id === confirmDeleteRowId);
          if (inv) handleDeleteFromRow(inv);
        }}
        title="Delete invoice"
        message="Are you sure you want to delete this invoice? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
      />

      <RequestPaymentDialog
        open={stripeConfirmOpen}
        onClose={() => setStripeConfirmOpen(false)}
        onRequested={() => refreshInvoiceViews()}
        billingContext={stripeConfirmInvoice ? stripeContextFor(stripeConfirmInvoice) : null}
        invoiceId={stripeConfirmInvoice?.id}
        paymentPlan={(stripeConfirmInvoice as Invoice | null)?.paymentPlan}
        hasOpenLink={hasOpenPaymentLink(stripeConfirmInvoice as Invoice | null)}
      />
    </div>
  );
}
