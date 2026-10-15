"use client";

import { completeInvoiceDraft } from "@/components/billingComp/submitInvoiceDraft";
import InvoiceDraftFields from "@/components/billingComp/InvoiceDraftFields";
import useInvoiceDraft from "@/hooks/billingHooks/useInvoiceDraft";

import { FlatFeeEditorRow } from "@/components/billingComp/FlatFeeEditor";
import PaymentPlanFields,{
buildPaymentPlanPayload
} from "@/components/billingComp/PaymentPlanFields";
import { formatCurrency, getTimeEntryRate } from "@/components/billingComp/utils";
import ClientContactModal from "@/components/clientComp/ClientContactModal";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import ActionIconButton from "@/components/ui/ActionIconButton";
import BackButton from "@/components/ui/BackButton";
import ConfirmAction from "@/components/ui/ConfirmAction";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import CollapsibleList from "@/components/ui/CollapsibleList";
import CollapsibleSection from "@/components/ui/CollapsibleSection";
import DatePicker from "@/components/ui/DatePicker";
import DateRangePicker from "@/components/ui/DateRangePicker";
import Dropdown from "@/components/ui/Dropdown";
import FieldLabel from "@/components/ui/FieldLabel";
import ListEmptyState from "@/components/ui/ListEmptyState";
import RequirePermission from "@/components/ui/RequirePermission";
import ShowMoreButton from "@/components/ui/ShowMoreButton";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import TextInput from "@/components/ui/TextInput";
import Tooltip from "@/components/ui/Tooltip";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { lineSourceId } from "@/lib/billing/lineSource";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { hourlyAmount } from "@/lib/utils/currency";
import { formatHoursMinutes } from "@/lib/utils/format";
import billingService,{ UNINVOICED_BILLING_STATUSES } from "@/services/billing.service";
import clientsService from "@/services/clients.service";
import type { Client,FlatFee,TimeEntry } from "@/types";
import { isCompanyRosterContact,type CompanyRosterContact } from "@/types/client";
import dayjs from "dayjs";
import { DollarSign,Eye,Info,Pencil,Star,Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback,useEffect,useMemo,useState } from "react";

type SelectionMode = "all" | "dateRange" | "manual";

// How many items each list on this page shows before the "Show N more" toggle.
const LIST_PREVIEW_LIMIT = 5;

type DraftFlatFee = FlatFee & {
  id: string;
  amount: number;
  description: string;
  date?: string | null;
};

/**
 * How much uninvoiced work is sitting on this client's matters, as two numbers.
 *
 * Both reads are firm-wide and answer over the whole match set, so neither one
 * grows with the client's matter count and neither downloads a row to count it:
 * the flat-fee route has a `countOnly` mode, and the time-entry route reports
 * `totalItems` for the whole filter on a one-row page.
 *
 * A failed read reports zero rather than failing the page, which is what the
 * per-matter loop did when a matter refused a read.
 */
async function countLinkedMatterWork(
  lawFirmId: string,
  clientId: string,
  linkedMatterIds: string[],
): Promise<{ timeEntries: number; flatFees: number }> {
  const [timeEntries, flatFees] = await Promise.all([
    billingService
      .listFirmTimeEntriesPage(lawFirmId, {
        // The matters this client is on, and only the work logged ON a matter:
        // the client's own entries are the list this page already shows.
        clientScope: clientId,
        context: "matter",
        billingStatus: UNINVOICED_BILLING_STATUSES,
        limit: 1,
      })
      .then((page) => page.totalItems)
      .catch(() => 0),
    billingService
      .listClientScopeFlatFees(lawFirmId, {
        matterIds: linkedMatterIds,
        billingStatus: "unbilled",
        countOnly: true,
      })
      .then((page) => page.totalItems)
      .catch(() => 0),
  ]);

  return { timeEntries, flatFees };
}

function ClientGenerateInvoiceContent() {
  const params = useParams();
  const { navigate } = useNavigation();

  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const clientId = Array.isArray(params?.clientId) ? params.clientId[0] : (params?.clientId as string);
  const clientBillingContext = useMemo(
    () => ({ type: "client" as const, lawFirmId, entityId: clientId }),
    [clientId, lawFirmId],
  );
  const { lawFirm } = useLawFirm();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [flatFees, setFlatFees] = useState<DraftFlatFee[]>([]);
  const [linkedMatterWorkSummary, setLinkedMatterWorkSummary] = useState({ timeEntries: 0, flatFees: 0 });

  const {
    invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate,
    dueDate, setDueDate, billingEmail, setBillingEmail, notes, setNotes, remitTo, setRemitTo,
    prePayments, setPrePayments, editingPrePayments, setEditingPrePayments,
    paymentPlanOpen, setPaymentPlanOpen, paymentPlanEnabled, setPaymentPlanEnabled,
    paymentPlan, updatePaymentPlan,
  } = useInvoiceDraft();

  const [selectionMode, setSelectionMode] = useState<SelectionMode>("all");
  const [dateRange, setDateRange] = useState({
    startDate: dayjs().subtract(30, "day").format("YYYY-MM-DD"),
    endDate: dayjs().format("YYYY-MM-DD"),
  });
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [selectedTimeEntries, setSelectedTimeEntries] = useState<Set<string>>(new Set());
  const [selectedFlatFees, setSelectedFlatFees] = useState<Set<string>>(new Set());

  // Pre-recorded payments (payments already made before invoice is generated)

  // Retainer plan. Client-scoped plans have no matter to close, so "matter_closed"
  // is not offered here the way it is on the matter-level invoice flow.
  const [retainerName, setRetainerName] = useState("");
  const [retainerAmount, setRetainerAmount] = useState("");
  const [retainerInterval, setRetainerInterval] = useState<"week" | "month">("month");
  const [retainerStartDate, setRetainerStartDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [retainerEndCondition, setRetainerEndCondition] = useState<"manual" | "date">("manual");
  const [retainerEndDate, setRetainerEndDate] = useState("");
  const [savingRetainer, setSavingRetainer] = useState(false);
  const [retainerSaved, setRetainerSaved] = useState(false);

  // Payment plan setup


  // Who at a COMPANY client will receive/see this invoice, loaded from that
  // company's roster of linked Person clients.
  const [billingRecipients, setBillingRecipients] = useState<CompanyRosterContact[]>([]);
  const [billingRecipientsLoading, setBillingRecipientsLoading] = useState(false);
  const [editingBillingRecipient, setEditingBillingRecipient] = useState<CompanyRosterContact | null>(null);
  const [billingRecipientModalOpen, setBillingRecipientModalOpen] = useState(false);

  // Collapsible section state. Sections whose default depends on data the page
  // loads asynchronously use a `null` override meaning "follow the data"; a
  // boolean means the user has explicitly opened or closed the section.
  const [remitToOpen, setRemitToOpen] = useState(false);
  const [billingRecipientsOpen, setBillingRecipientsOpen] = useState(false);
  const [retainerOpen, setRetainerOpen] = useState(false);
  const [flatFeesOpenOverride, setFlatFeesOpenOverride] = useState<boolean | null>(null);
  const [prePaymentsOpenOverride, setPrePaymentsOpenOverride] = useState<boolean | null>(null);
  const [entryFiltersOpen, setEntryFiltersOpen] = useState(false);

  // Long lists start clipped to LIST_PREVIEW_LIMIT rows so the form stays scannable.
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [showAllTimeEntries, setShowAllTimeEntries] = useState(false);
  const [showAllSavedFlatFees, setShowAllSavedFlatFees] = useState(false);
  const [showAllNewFlatFees, setShowAllNewFlatFees] = useState(false);
  const [showAllMemberTotals, setShowAllMemberTotals] = useState(false);
  const [showAllPrePayments, setShowAllPrePayments] = useState(false);

  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [savingFlatFeeId, setSavingFlatFeeId] = useState<string | null>(null);
  const [deletingFlatFeeId, setDeletingFlatFeeId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!lawFirmId || !clientId) return;

    setLoading(true);
    setError(null);
    try {
      const clientRes = await clientsService.getClient(lawFirmId, clientId);
      const linkedMatterIds = Array.isArray(clientRes?.matterIds) ? clientRes.matterIds.filter(Boolean) : [];
      const [entries, fees, linkedMatterWork] = await Promise.all([
        billingService.listTimeEntries(clientBillingContext),
        billingService.listFlatFees(clientBillingContext),
        // Two COUNTS, not two row sets. Both callouts below say only how much
        // work is waiting on the client's matters, so the rows were fetched
        // once per matter and thrown away. The server totals them instead.
        linkedMatterIds.length > 0
          ? countLinkedMatterWork(lawFirmId, clientId, linkedMatterIds)
          : Promise.resolve({ timeEntries: 0, flatFees: 0 }),
      ]);

      setClient(clientRes || null);
      setTimeEntries((entries || []).filter((entry) => !entry.isBilled));
      setFlatFees(((fees || []) as DraftFlatFee[]).filter((fee) => !fee.isBilled));
      setLinkedMatterWorkSummary(linkedMatterWork);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load invoice setup"));
    } finally {
      setLoading(false);
    }
  }, [clientBillingContext, clientId, lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: invoice setup/loading/error state set as the request progresses
    void loadData();
  }, [loadData]);

  // Seed the billing email and remit-to defaults from the firm record, sourced from the
  // firm layout's shared context instead of a redundant per-page fetch.
  useEffect(() => {
    if (!lawFirm) return;
    if (lawFirm.email) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds form defaults from the shared firm record (external source)
      setBillingEmail((prev) => prev || lawFirm.email || "");
    }
    setRemitTo((prev) => ({
      name: prev.name || lawFirm.name || "",
      address: prev.address || lawFirm.address || "",
      city: prev.city || lawFirm.city || "",
      state: prev.state || lawFirm.state || "",
      zip: prev.zip || lawFirm.zip || "",
    }));
  }, [lawFirm]);

  const isCompanyClient = client?.clientType === "company";

  // Who at the billed company will receive/see this invoice, sourced from
  // that company's roster of linked Person clients.
  const loadBillingRecipients = useCallback(() => {
    if (!lawFirmId || !clientId || !isCompanyClient) {
      setBillingRecipients([]);
      return;
    }
    setBillingRecipientsLoading(true);
    clientsService
      .listClientContacts(lawFirmId, clientId)
      .then((contacts) => setBillingRecipients(contacts.filter(isCompanyRosterContact)))
      .catch(() => setBillingRecipients([]))
      .finally(() => setBillingRecipientsLoading(false));
  }, [lawFirmId, clientId, isCompanyClient]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: roster state set as the request progresses
    loadBillingRecipients();
  }, [loadBillingRecipients]);

  const billingRecipientsCount = billingRecipients.filter((c) => c.isEmailRecipient).length;
  const billingRecipientsSummary = billingRecipientsLoading
    ? "Loading..."
    : billingRecipientsCount === 0
      ? "No one set to receive billing emails"
      : `${billingRecipientsCount} of ${billingRecipients.length} receive billing emails`;

  const memberSummaries = useMemo(() => {
    const map = new Map<string, { userId: string; userName: string; hourlyRate: number; hours: number; amount: number }>();

    timeEntries.forEach((entry) => {
      const rate = getTimeEntryRate(entry);
      const existing = map.get(entry.userId) || {
        userId: entry.userId,
        userName: entry.userName || "Unknown",
        hourlyRate: rate,
        hours: 0,
        amount: 0,
      };

      map.set(entry.userId, {
        ...existing,
        hourlyRate: existing.hourlyRate || rate,
        hours: existing.hours + entry.hours,
        amount: existing.amount + hourlyAmount(entry.hours, rate),
      });
    });

    return Array.from(map.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [timeEntries]);

  useEffect(() => {
    if (memberSummaries.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects all members into user-editable selection state once summaries load
    setSelectedMembers(new Set(memberSummaries.map((member) => member.userId)));
  }, [memberSummaries]);

  const savedFlatFees = useMemo(() => flatFees.filter((fee) => !fee.id.startsWith("flat-fee-")), [flatFees]);
  const newFlatFees = useMemo(() => flatFees.filter((fee) => fee.id.startsWith("flat-fee-")), [flatFees]);

  const visibleTimeEntries = useMemo(() => {
    if (selectionMode === "dateRange") {
      const start = dayjs(dateRange.startDate);
      const end = dayjs(dateRange.endDate).endOf("day");

      return timeEntries.filter((entry) => {
        const entryDate = dayjs(entry.date);
        return (
          selectedMembers.has(entry.userId) &&
          entryDate.isAfter(start.subtract(1, "day")) &&
          entryDate.isBefore(end.add(1, "day"))
        );
      });
    }

    return timeEntries.filter((entry) => selectedMembers.has(entry.userId));
  }, [dateRange.endDate, dateRange.startDate, selectedMembers, selectionMode, timeEntries]);

  useEffect(() => {
    if (selectionMode === "manual") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs auto-selected time entries to the visible set in non-manual selection modes
    setSelectedTimeEntries(new Set(visibleTimeEntries.map((entry) => entry.id)));
  }, [selectionMode, visibleTimeEntries]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects all flat fees into user-editable selection state when they load
    setSelectedFlatFees(new Set(flatFees.map((fee) => fee.id)));
  }, [flatFees]);


  const selectedEntries = useMemo(
    () => timeEntries.filter((entry) => selectedTimeEntries.has(entry.id)),
    [selectedTimeEntries, timeEntries],
  );

  const selectedFeeList = useMemo(
    () => flatFees.filter((fee) => selectedFlatFees.has(fee.id)),
    [flatFees, selectedFlatFees],
  );

  const totals = useMemo(() => {
    const memberTotals = new Map<string, { userName: string; hours: number; amount: number }>();

    selectedEntries.forEach((entry) => {
      const rate = getTimeEntryRate(entry);
      const current = memberTotals.get(entry.userId) || {
        userName: entry.userName || "Unknown",
        hours: 0,
        amount: 0,
      };

      memberTotals.set(entry.userId, {
        userName: current.userName,
        hours: current.hours + entry.hours,
        amount: current.amount + hourlyAmount(entry.hours, rate),
      });
    });

    const totalHours = selectedEntries.reduce((sum, entry) => sum + entry.hours, 0);
    const timeEntryAmount = selectedEntries.reduce(
      (sum, entry) => sum + hourlyAmount(entry.hours, getTimeEntryRate(entry)),
      0,
    );
    const flatFeesAmount = selectedFeeList.reduce((sum, fee) => sum + fee.amount, 0);
    // Every addend is whole cents; rounding the float sum keeps it whole cents too.
    const totalAmount = Math.round((timeEntryAmount + flatFeesAmount) * 100) / 100;

    return { memberTotals, totalHours, timeEntryAmount, flatFeesAmount, totalAmount };
  }, [selectedEntries, selectedFeeList]);

  // Optional sections start open whenever they already carry money, so nothing
  // that lands on the invoice can hide behind a collapsed header.
  const flatFeesOpen = flatFeesOpenOverride ?? flatFees.length > 0;
  const prePaymentsOpen = prePaymentsOpenOverride ?? prePayments.length > 0;
  const totalPrePayments = prePayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const balanceDue = totals.totalAmount - totalPrePayments;

  const remitToSummary =
    [
      remitTo.name,
      remitTo.address,
      [remitTo.city, remitTo.state].filter(Boolean).join(", "),
      remitTo.zip,
    ]
      .filter(Boolean)
      .join(" · ") || "Not set";

  const memberScopeLabel =
    selectedMembers.size === memberSummaries.length
      ? `All ${memberSummaries.length} team members`
      : `${selectedMembers.size} of ${memberSummaries.length} team members`;
  const entryScopeLabel =
    selectionMode === "all"
      ? "all unbilled entries"
      : selectionMode === "dateRange"
        ? `${dayjs(dateRange.startDate).format("MMM D")} to ${dayjs(dateRange.endDate).format("MMM D, YYYY")}`
        : "manual selection";

  const toggleMember = (userId: string) => {
    const next = new Set(selectedMembers);
    if (next.has(userId)) {
      next.delete(userId);
    } else {
      next.add(userId);
    }
    setSelectedMembers(next);
  };

  const toggleTimeEntry = (entryId: string) => {
    const next = new Set(selectedTimeEntries);
    if (next.has(entryId)) {
      next.delete(entryId);
    } else {
      next.add(entryId);
    }
    setSelectedTimeEntries(next);
  };

  const addFlatFee = () => {
    const newId = `flat-fee-${Date.now()}`;
    setFlatFees((prev) => [
      ...prev,
      {
        id: newId,
        description: "",
        amount: 0,
        date: dayjs().format("YYYY-MM-DD"),
      },
    ]);
    setSelectedFlatFees((prev) => new Set([...prev, newId]));
    // The new row is appended, so expand past the preview limit to reveal it.
    setShowAllNewFlatFees(true);
  };


  const removeFlatFee = async (id: string) => {
    if (id.startsWith("flat-fee-")) {
      setFlatFees((prev) => prev.filter((fee) => fee.id !== id));
      setSelectedFlatFees((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    setDeletingFlatFeeId(id);
    try {
      await billingService.removeFlatFee(clientBillingContext, id);
      await loadData();
    } finally {
      setDeletingFlatFeeId(null);
    }
  };

  const handleSaveFlatFee = async (fee: DraftFlatFee) => {
    if (!fee.description.trim() || fee.amount <= 0) {
      setCreateError("Please provide a description and amount for the flat fee");
      return;
    }

    setSavingFlatFeeId(fee.id);
    setCreateError(null);
    try {
      const savedFee = await billingService.addFlatFee(clientBillingContext, {
        description: fee.description.trim(),
        amount: fee.amount,
        date: fee.date || null,
      });

      setFlatFees((prev) => prev.filter((item) => item.id !== fee.id));
      await loadData();
      if (savedFee?.id) {
        setSelectedFlatFees((prev) => new Set([...prev, savedFee.id]));
      }
    } catch (err) {
      setCreateError(getErrorMessage(err, "Failed to save flat fee"));
    } finally {
      setSavingFlatFeeId(null);
    }
  };

  const handleCreateInvoice = async () => {
    if (!invoiceName.trim()) {
      setCreateError("Invoice name is required");
      return;
    }

    if (selectedEntries.length === 0 && selectedFeeList.length === 0) {
      setCreateError("Select at least one time entry or flat fee");
      return;
    }

    if (totals.totalAmount <= 0) {
      setCreateError("Invoice total must be greater than $0");
      return;
    }

    if (totalPrePayments > totals.totalAmount) {
      setCreateError("Payments received cannot exceed the invoice total");
      return;
    }

    const planResult = paymentPlanEnabled ? buildPaymentPlanPayload(paymentPlan, balanceDue) : null;
    if (planResult?.error) {
      setCreateError(planResult.error);
      return;
    }

    setCreatingInvoice(true);
    setCreateError(null);
    try {
      const createdInvoice = await billingService.createInvoice(clientBillingContext, {
        invoiceName: invoiceName.trim(),
        invoiceNumber: invoiceNumber.trim() || null,
        invoiceDate,
        dueDate: dueDate || null,
        billingEmail: billingEmail.trim() || null,
        notes: notes.trim() || undefined,
        remitTo: remitTo.name || remitTo.address ? remitTo : null,
        timeEntries: selectedEntries.map((entry) => {
          const rate = getTimeEntryRate(entry);
          return {
            ...lineSourceId(entry.id),
            name: entry.name || "Service",
            description: entry.description || undefined,
            rate,
            hours: entry.hours,
            amount: hourlyAmount(entry.hours, rate),
          };
        }),
        flatFees: selectedFeeList.map((fee) => ({
          ...lineSourceId(fee.id),
          description: fee.description,
          amount: fee.amount,
        })),
        totalHours: totals.totalHours,
        totalAmount: totals.totalAmount,
        flatFeesAmount: totals.flatFeesAmount,
      });

      await completeInvoiceDraft(clientBillingContext, createdInvoice.id, planResult?.payload, prePayments);

      navigate(`/lawfirm/${lawFirmId}/clients/${clientId}/invoices/${createdInvoice.id}`);
    } catch (err) {
      setCreateError(getErrorMessage(err, "Failed to create invoice"));
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleCreateRetainer = async () => {
    if (!retainerAmount || Number(retainerAmount) <= 0) {
      setCreateError("Enter a valid retainer amount.");
      return;
    }
    setSavingRetainer(true);
    setCreateError(null);
    try {
      await billingService.createPlan(lawFirmId, {
        contextType: "client",
        entityId: clientId,
        name: retainerName.trim() || "Evergreen Retainer",
        amount: Number(retainerAmount),
        intervalUnit: retainerInterval,
        intervalCount: 1,
        startDate: retainerStartDate,
        endCondition: retainerEndCondition,
        endDate: retainerEndCondition === "date" ? (retainerEndDate || null) : null,
      });
      setRetainerSaved(true);
    } catch (err) {
      setCreateError(getErrorMessage(err, "Failed to create retainer plan"));
    } finally {
      setSavingRetainer(false);
    }
  };

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-4 mb-6 sm:mb-8">
        <BackButton
          href={`/lawfirm/${lawFirmId}/clients/${clientId}?tab=billing`}
          label="Back to Client Billing"
        />
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-on-surface">Generate Invoice</h1>
          <p className="text-sm text-on-surface-secondary mt-1">
            {client?.name || client?.email || "Client"}
          </p>
        </div>
      </div>

      {error && !createError && (
        <div className="mb-4">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>
      )}

      {createError && (
        <div className="mb-4">
          <ErrorNotification error={createError} onClose={() => setCreateError(null)} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-surface rounded-lg shadow-sm border border-outline p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-on-surface mb-4">Invoice Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <FieldLabel tone="secondary">Bill To (Client) *</FieldLabel>
                <Dropdown
                  value={clientId}
                  disabled
                  options={[
                    {
                      value: clientId,
                      label: client?.name || client?.email || "Client",
                    },
                  ]}
                  buttonClassName="border-input-border bg-input-bg opacity-90"
                />
              </div>
              <InvoiceDraftFields
                draft={{ invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate, dueDate, setDueDate, billingEmail, setBillingEmail }}
                numberLabel="Invoice Number (Optional)"
                namePlaceholder={`Invoice for ${client?.name || client?.email || "Client"}`}
              />
              <div className="md:col-span-2">
                <FieldLabel tone="secondary">Notes</FieldLabel>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Optional notes for this invoice..."
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
            </div>
          </div>

          {/* Remit To Section */}
          <CollapsibleSection
            title="Remit To (Payment Address)"
            description="Where the client sends payment. Prefilled from your firm profile."
            summary={remitToSummary}
            open={remitToOpen}
            onToggle={() => setRemitToOpen(!remitToOpen)}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <FieldLabel tone="secondary">Name</FieldLabel>
                <input
                  type="text"
                  value={remitTo.name}
                  onChange={(e) => setRemitTo({ ...remitTo, name: e.target.value })}
                  placeholder="Name or Organization"
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div className="md:col-span-2">
                <FieldLabel tone="secondary">Address</FieldLabel>
                <input
                  type="text"
                  value={remitTo.address}
                  onChange={(e) => setRemitTo({ ...remitTo, address: e.target.value })}
                  placeholder="Street Address"
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div>
                <FieldLabel tone="secondary">City</FieldLabel>
                <input
                  type="text"
                  value={remitTo.city}
                  onChange={(e) => setRemitTo({ ...remitTo, city: e.target.value })}
                  placeholder="City"
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div>
                <FieldLabel tone="secondary">State</FieldLabel>
                <input
                  type="text"
                  value={remitTo.state}
                  onChange={(e) => setRemitTo({ ...remitTo, state: e.target.value })}
                  placeholder="State"
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div>
                <FieldLabel tone="secondary">ZIP Code</FieldLabel>
                <input
                  type="text"
                  value={remitTo.zip}
                  onChange={(e) => setRemitTo({ ...remitTo, zip: e.target.value })}
                  placeholder="ZIP Code"
                  className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
            </div>
          </CollapsibleSection>

          {/* Billing Recipients Section: who at a COMPANY client will receive/see this invoice. */}
          {isCompanyClient && (
            <CollapsibleSection
              title="Billing Recipients"
              description="People at this company who will receive the invoice email or can view billing in the client portal."
              summary={billingRecipientsSummary}
              open={billingRecipientsOpen}
              onToggle={() => setBillingRecipientsOpen(!billingRecipientsOpen)}
            >
              {billingRecipientsLoading ? (
                <div className="flex justify-center py-4">
                  <Spinner size={20} />
                </div>
              ) : billingRecipients.length === 0 ? (
                <ListEmptyState
                  compact
                  title="No linked clients yet"
                  message="Link people at this company as clients of their own to control who receives this invoice."
                />
              ) : (
                <div className="space-y-2">
                  {billingRecipients.map((contact) => (
                    <div
                      key={contact.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-outline-subtle bg-surface px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-on-surface truncate">{contact.name}</p>
                          {contact.isPrimary && (
                            <StatusBadge variant="info"><Star size={11} /> Primary</StatusBadge>
                          )}
                          {contact.isEmailRecipient && (
                            <StatusBadge variant="success"><DollarSign size={11} /> Receives emails</StatusBadge>
                          )}
                          {contact.canViewBilling && (
                            <StatusBadge variant="purple"><Eye size={11} /> Can view billing</StatusBadge>
                          )}
                        </div>
                        {contact.email && (
                          <p className="text-xs text-on-surface-muted mt-0.5">{contact.email}</p>
                        )}
                      </div>
                      <Button
                        type="secondary"
                        size="small"
                        icon={<Pencil size={12} />}
                        onClick={() => {
                          setEditingBillingRecipient(contact);
                          setBillingRecipientModalOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>
          )}

          {isCompanyClient && clientId && (
            <ClientContactModal
              open={billingRecipientModalOpen}
              onClose={() => setBillingRecipientModalOpen(false)}
              onSaved={loadBillingRecipients}
              lawFirmId={lawFirmId}
              clientId={clientId}
              editing={editingBillingRecipient}
              clientType="company"
              otherEmailRecipientCount={
                editingBillingRecipient
                  ? billingRecipients.filter((c) => c.id !== editingBillingRecipient.id && c.isEmailRecipient).length
                  : billingRecipients.filter((c) => c.isEmailRecipient).length
              }
            />
          )}

          {/* Flat Fees Section */}
          <CollapsibleSection
            title="Flat Fees"
            description="Include saved unbilled direct client flat fees, or add a new one for this client invoice."
            summary={
              flatFees.length === 0
                ? "No unbilled flat fees"
                : `${selectedFeeList.length} of ${flatFees.length} selected · ${formatCurrency(totals.flatFeesAmount)}`
            }
            open={flatFeesOpen}
            onToggle={() => setFlatFeesOpenOverride(!flatFeesOpen)}
            actions={
              <Button onClick={addFlatFee} type="secondary" size="small">
                + Add Flat Fee
              </Button>
            }
          >
            <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-3 text-xs text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
              Only direct client flat fees appear here. Linked matter flat fees stay on their matter and bill from the matter invoice flow.
            </div>

            {savedFlatFees.length > 0 && (
              <div className="mb-6">
                <h5 className="text-sm font-medium text-on-surface-secondary mb-3">Saved Unbilled Flat Fees</h5>
                <CollapsibleList
                  items={savedFlatFees}
                  previewLimit={LIST_PREVIEW_LIMIT}
                  expanded={showAllSavedFlatFees}
                  className="space-y-2"
                  renderItem={(fee) => (
                    <div key={fee.id} className="flex items-center gap-3 p-3 border border-outline rounded-lg bg-green-50 dark:bg-green-900/20">
                      <Checkbox
                        checked={selectedFlatFees.has(fee.id)}
                        onChange={(checked) => {
                          const next = new Set(selectedFlatFees);
                          if (checked) next.add(fee.id);
                          else next.delete(fee.id);
                          setSelectedFlatFees(next);
                        }}
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-on-surface">{fee.description}</span>
                          <StatusBadge variant="success">Unbilled</StatusBadge>
                          <span className="text-sm text-on-surface-secondary">{formatCurrency(fee.amount)}</span>
                          {fee.date && (
                            <span className="text-xs text-on-surface-muted">{dayjs(fee.date).format("MMM DD, YYYY")}</span>
                          )}
                        </div>
                      </div>
                      <ConfirmAction title="Remove Flat Fee" message={`Remove "${fee.description}" (${formatCurrency(fee.amount)})? This deletes the saved flat fee.`} onConfirm={() => removeFlatFee(fee.id)} stacked>
                        {(request, busy) => (
                          <Tooltip title="Remove flat fee" enterDelay={300}>
                            <span>
                              <button aria-label="Remove flat fee"
                                onClick={request}
                                disabled={deletingFlatFeeId === fee.id || busy}
                                className="p-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                              >
                                <Trash2 size={16} />
                              </button>
                            </span>
                          </Tooltip>
                        )}
                      </ConfirmAction>
                    </div>
                  )}
                />
                <ShowMoreButton
                  expanded={showAllSavedFlatFees}
                  hiddenCount={savedFlatFees.length - LIST_PREVIEW_LIMIT}
                  onToggle={() => setShowAllSavedFlatFees(!showAllSavedFlatFees)}
                />
              </div>
            )}

            <div className="space-y-3">
              <CollapsibleList
                items={newFlatFees}
                previewLimit={LIST_PREVIEW_LIMIT}
                expanded={showAllNewFlatFees}
                className="space-y-3"
                renderItem={(fee) => (
                  <FlatFeeEditorRow
                    key={fee.id}
                    fee={fee}
                    onChange={(next) => setFlatFees(flatFees.map(f => (f.id === fee.id ? { ...f, ...next } : f)))}
                    onSave={() => handleSaveFlatFee(fee)}
                    onDiscard={() => removeFlatFee(fee.id)}
                    saving={savingFlatFeeId === fee.id}
                    deleting={deletingFlatFeeId === fee.id}
                    saveLabel="Done"
                    discardAs="trash"
                    select={{
                      checked: selectedFlatFees.has(fee.id),
                      onChange: (checked) => {
                        const newSelected = new Set(selectedFlatFees);
                        if (checked) {
                          newSelected.add(fee.id);
                        } else {
                          newSelected.delete(fee.id);
                        }
                        setSelectedFlatFees(newSelected);
                      },
                    }}
                  />
                )}
              />

              {savedFlatFees.length === 0 && newFlatFees.length === 0 && (
                linkedMatterWorkSummary.flatFees > 0 ? (
                  <ListEmptyState
                    compact
                    title="No direct client flat fees are available for this invoice"
                    message={`${linkedMatterWorkSummary.flatFees} linked matter flat ${linkedMatterWorkSummary.flatFees === 1 ? "fee is" : "fees are"} available from matter billing.`}
                    action={
                      <button
                        type="button"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}?tab=billing`)}
                        className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover cursor-pointer"
                      >
                        Review linked matter billing
                      </button>
                    }
                  />
                ) : (
                  <p className="text-sm text-on-surface-muted text-center py-4">
                    No unbilled direct client flat fees available. Click &quot;Add Flat Fee&quot; to include filing fees, fixed charges, or other non-time items.
                  </p>
                )
              )}
              <ShowMoreButton
                expanded={showAllNewFlatFees}
                hiddenCount={newFlatFees.length - LIST_PREVIEW_LIMIT}
                onToggle={() => setShowAllNewFlatFees(!showAllNewFlatFees)}
              />
            </div>

            {(savedFlatFees.length > 0 || newFlatFees.length > 0) && (
              <div className="mt-4 pt-4 border-t border-outline">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-on-surface-secondary">Total Selected Unbilled Flat Fees:</span>
                  <span className="text-lg font-semibold text-on-surface">{formatCurrency(totals.flatFeesAmount)}</span>
                </div>
              </div>
            )}
          </CollapsibleSection>

          {/* Pre-Recorded Payments */}
          <CollapsibleSection
            title="Payments Received"
            description="Record payments received before this invoice was generated"
            summary={
              prePayments.length === 0
                ? "None recorded"
                : `${prePayments.length} recorded · ${formatCurrency(totalPrePayments)}`
            }
            open={prePaymentsOpen}
            onToggle={() => setPrePaymentsOpenOverride(!prePaymentsOpen)}
            actions={
              <Button
                onClick={() => {
                  const newPaymentId = `prepay-${Date.now()}`;
                  setPrePayments([...prePayments, {
                    id: newPaymentId,
                    amount: "",
                    date: dayjs().format("YYYY-MM-DD"),
                    invoiceNumber: "",
                    note: "",
                  }]);
                  setEditingPrePayments((prev) => new Set([...prev, newPaymentId]));
                  setPrePaymentsOpenOverride(true);
                  setShowAllPrePayments(true);
                }}
                type="secondary"
                size="small"
              >
                + Add Payment
              </Button>
            }
          >
            {prePayments.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                No pre-payments recorded. Click &quot;Add Payment&quot; if the client already paid some or all of this amount.
              </p>
            ) : (
              <div className="space-y-3">
                <CollapsibleList
                  items={prePayments}
                  previewLimit={LIST_PREVIEW_LIMIT}
                  expanded={showAllPrePayments}
                  className="space-y-3"
                  renderItem={(payment, idx) => {
                    const paymentAmount = Number(payment.amount) || 0;
                    const removePayment = () => {
                      setPrePayments(prePayments.filter((p) => p.id !== payment.id));
                      setEditingPrePayments((prev) => {
                        const next = new Set(prev);
                        next.delete(payment.id);
                        return next;
                      });
                    };

                    if (!editingPrePayments.has(payment.id)) {
                      return (
                        <div key={payment.id} className="rounded-lg border border-outline bg-surface-alt/40 p-3">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-on-surface">Payment {idx + 1}</div>
                              <div className="mt-1 text-xs text-on-surface-muted">
                                {payment.date ? dayjs(payment.date).format("MMM DD, YYYY") : "No date"}
                                {payment.invoiceNumber.trim() ? ` • #${payment.invoiceNumber.trim()}` : ""}
                              </div>
                              {payment.note.trim() && (
                                <div className="mt-1 text-xs text-on-surface-secondary">{payment.note.trim()}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                                {formatCurrency(paymentAmount)}
                              </div>
                              <Tooltip title="Edit" enterDelay={300}>
                                <button aria-label="Edit"
                                  onClick={() => setEditingPrePayments((prev) => new Set([...prev, payment.id]))}
                                  className="p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                              </Tooltip>
                              <ActionIconButton label="Remove payment" onClick={removePayment} tone="danger" size="sm">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </ActionIconButton>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={payment.id} className="p-4 border border-outline rounded-lg bg-surface-alt space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-on-surface">Payment {idx + 1}</span>
                          <Tooltip title="Remove payment" enterDelay={300}>
                            <button aria-label="Remove payment"
                              onClick={removePayment}
                              className="p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </Tooltip>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <FieldLabel size="xs" tone="secondary">Amount *</FieldLabel>
                            <TextInput
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              value={payment.amount}
                              onChange={(e) => setPrePayments(prePayments.map((p) => p.id === payment.id ? { ...p, amount: e.target.value } : p))}
                            />
                          </div>
                          <div>
                            <FieldLabel size="xs" tone="secondary">Date</FieldLabel>
                            <DatePicker
                              value={payment.date}
                              onChange={(value) => setPrePayments(prePayments.map((p) => p.id === payment.id ? { ...p, date: value } : p))}
                              className="w-full"
                            />
                          </div>
                          <div>
                            <FieldLabel size="xs" tone="secondary">Invoice #</FieldLabel>
                            <TextInput
                              type="text"
                              placeholder="Receipt or invoice number"
                              value={payment.invoiceNumber}
                              onChange={(e) => setPrePayments(prePayments.map((p) => p.id === payment.id ? { ...p, invoiceNumber: e.target.value } : p))}
                            />
                          </div>
                          <div>
                            <FieldLabel size="xs" tone="secondary">Note</FieldLabel>
                            <TextInput
                              type="text"
                              placeholder="e.g. Wire transfer, check #..."
                              value={payment.note}
                              onChange={(e) => setPrePayments(prePayments.map((p) => p.id === payment.id ? { ...p, note: e.target.value } : p))}
                            />
                          </div>
                        </div>
                        <div className="flex justify-end pt-1">
                          <Tooltip title={paymentAmount > 0 ? "" : "Enter an amount first"} enterDelay={300}>
                            <span>
                              <Button
                                type="primary"
                                size="small"
                                disabled={paymentAmount <= 0}
                                onClick={() => setEditingPrePayments((prev) => {
                                  const next = new Set(prev);
                                  next.delete(payment.id);
                                  return next;
                                })}
                              >
                                Save
                              </Button>
                            </span>
                          </Tooltip>
                        </div>
                      </div>
                    );
                  }}
                />
                <ShowMoreButton
                  expanded={showAllPrePayments}
                  hiddenCount={prePayments.length - LIST_PREVIEW_LIMIT}
                  onToggle={() => setShowAllPrePayments(!showAllPrePayments)}
                />
                <div className="mt-2 pt-3 border-t border-outline flex justify-between items-center">
                  <span className="text-sm font-medium text-on-surface-secondary">Total Pre-Payments:</span>
                  <span className="text-base font-semibold text-green-600 dark:text-green-400">
                    {formatCurrency(totalPrePayments)}
                  </span>
                </div>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Payment Plan (Installments)"
            description="Optional: set up automated installments for this invoice"
            summary={
              paymentPlanEnabled
                ? paymentPlan.installmentMode === "amount"
                  ? `Enabled • $${paymentPlan.installmentAmount || "0"} per installment`
                  : `Enabled • ${paymentPlan.paymentCount || "0"} payments`
                : "Optional: set up automated installments for this invoice"
            }
            open={paymentPlanOpen}
            onToggle={() => setPaymentPlanOpen(!paymentPlanOpen)}
            actions={
              paymentPlanEnabled ? (
                <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-1 rounded-full">
                  Payment plan enabled
                </span>
              ) : undefined
            }
          >
            <div className="space-y-4">
              <div className="rounded-xl border border-blue-200 dark:border-blue-800/40 bg-blue-50/70 dark:bg-blue-500/10 p-3.5 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                <p className="text-xs text-blue-900 dark:text-blue-300 leading-relaxed">
                  <strong>Note:</strong> Payment plans can also be created or edited at any time after the invoice is generated.
                </p>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <Checkbox
                  checked={paymentPlanEnabled}
                  onChange={setPaymentPlanEnabled}
                  className="mt-0.5"
                />
                <div>
                  <span className="text-sm font-semibold text-on-surface">Enable Payment Plan for this invoice</span>
                  <p className="text-xs text-on-surface-muted">
                    Automatically schedule recurring installment payments for the client.
                  </p>
                </div>
              </label>

              {paymentPlanEnabled && (
                <PaymentPlanFields
                  values={paymentPlan}
                  onChange={updatePaymentPlan}
                  balance={balanceDue}
                  radioName="genInvoiceClientPlanMode"
                  className="pt-1"
                />
              )}
            </div>
          </CollapsibleSection>

          <div className="rounded-lg p-4 sm:p-6 bg-surface border-2 border-outline shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-on-surface">
                  {selectionMode === "manual" ? "Select Time Entries" : "Included Time Entries"}
                </h2>
                <p className="text-xs text-on-surface-muted mt-1">
                  {selectionMode === "all"
                    ? "Showing all unbilled direct client entries for the selected team members."
                    : selectionMode === "dateRange"
                      ? "Showing direct client entries currently included by your selected date range."
                      : "Choose exactly which direct client entries to include on this invoice."}
                </p>
              </div>
            </div>

            {/* Filters that decide which entries land in the list below. */}
            <CollapsibleSection
              tone="inline"
              title="Filters"
              summary={selectionMode === "manual" ? memberScopeLabel : `${memberScopeLabel} · ${entryScopeLabel}`}
              open={entryFiltersOpen}
              onToggle={() => setEntryFiltersOpen(!entryFiltersOpen)}
              className="mb-4"
            >
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-medium text-on-surface-secondary">Team Members</p>
                  {memberSummaries.length > 0 ? (
                    <CollapsibleList
                      items={memberSummaries}
                      previewLimit={LIST_PREVIEW_LIMIT}
                      expanded={showAllMembers}
                      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                      overflowClassName="col-span-full"
                      renderItem={(member) => (
                        <label
                          key={member.userId}
                          className="flex items-center rounded-lg border border-outline bg-surface p-2.5 hover:bg-surface-hover cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedMembers.has(member.userId)}
                            onChange={() => toggleMember(member.userId)}
                          />
                          <div className="ml-2.5 min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-on-surface">{member.userName}</div>
                            <div className="text-xs text-on-surface-muted">
                              {formatHoursMinutes(member.hours)} total • {formatCurrency(member.amount)}
                            </div>
                          </div>
                        </label>
                      )}
                    />
                  ) : (
                    <p className="text-sm text-on-surface-muted">No unbilled client time entries found.</p>
                  )}
                  <ShowMoreButton
                    expanded={showAllMembers}
                    hiddenCount={memberSummaries.length - LIST_PREVIEW_LIMIT}
                    onToggle={() => setShowAllMembers(!showAllMembers)}
                  />
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium text-on-surface-secondary">Entries To Include</p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { value: "all", label: "All Entries" },
                      { value: "dateRange", label: "Date Range" },
                      { value: "manual", label: "Manual Selection" },
                    ] as const).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSelectionMode(option.value)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                          selectionMode === option.value
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                            : "bg-surface border border-outline text-on-surface-secondary hover:bg-surface-hover"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {selectionMode === "dateRange" && (
                    <div className="mt-2">
                      <DateRangePicker
                        from={dateRange.startDate}
                        to={dateRange.endDate}
                        onChange={(next) => setDateRange({ startDate: next.from ?? "", endDate: next.to ?? "" })}
                        className="w-full"
                      />
                    </div>
                  )}
                </div>
              </div>
            </CollapsibleSection>

            <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-3 text-xs text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
              Only direct client billing entries appear here. Linked matter time entries stay on their matter and bill from the matter invoice flow.
            </div>

            <div className="space-y-2">
              <CollapsibleList
                items={visibleTimeEntries}
                previewLimit={LIST_PREVIEW_LIMIT}
                expanded={showAllTimeEntries}
                className="space-y-2"
                renderItem={(entry) => {
                  const rate = getTimeEntryRate(entry);
                  const amount = hourlyAmount(entry.hours, rate);
                  const isSelected = selectedTimeEntries.has(entry.id);

                  if (selectionMode === "manual") {
                    return (
                      <label
                        key={entry.id}
                        className="flex items-start p-3 border border-outline rounded-lg hover:bg-surface-hover cursor-pointer"
                      >
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggleTimeEntry(entry.id)}
                        />
                        <div className="ml-3 flex-1">
                          <div className="flex justify-between items-start gap-4">
                            <div>
                              <div className="text-sm font-medium text-on-surface">{entry.userName || "Unknown"}</div>
                              {entry.name && <div className="mt-1 text-sm font-semibold text-on-surface">{entry.name}</div>}
                              <div className="mt-1 text-xs text-on-surface-muted">
                                {dayjs(entry.date).format("MMM DD, YYYY")} • {formatHoursMinutes(entry.hours)} @ {formatCurrency(rate)}/hr
                              </div>
                              {entry.description && (
                                <div className="mt-1 text-xs text-on-surface-secondary">{entry.description}</div>
                              )}
                            </div>
                            <div className="text-sm font-semibold text-on-surface">{formatCurrency(amount)}</div>
                          </div>
                        </div>
                      </label>
                    );
                  }

                  return (
                    <div key={entry.id} className="rounded-lg border border-outline bg-surface-alt/40 p-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-on-surface">{entry.userName || "Unknown"}</div>
                            <StatusBadge variant="success">Included</StatusBadge>
                          </div>
                          {entry.name && <div className="mt-1 text-sm font-semibold text-on-surface">{entry.name}</div>}
                          <div className="mt-1 text-xs text-on-surface-muted">
                            {dayjs(entry.date).format("MMM DD, YYYY")} • {formatHoursMinutes(entry.hours)} @ {formatCurrency(rate)}/hr
                          </div>
                          {entry.description && (
                            <div className="mt-1 text-xs text-on-surface-secondary">{entry.description}</div>
                          )}
                        </div>
                        <div className="text-sm font-semibold text-on-surface">{formatCurrency(amount)}</div>
                      </div>
                    </div>
                  );
                }}
              />

              {visibleTimeEntries.length === 0 && (
                linkedMatterWorkSummary.timeEntries > 0 && timeEntries.length === 0 ? (
                  <ListEmptyState
                    compact
                    title="No direct client time entries are available for this invoice"
                    message={`${linkedMatterWorkSummary.timeEntries} linked matter ${linkedMatterWorkSummary.timeEntries === 1 ? "entry is" : "entries are"} available from matter billing.`}
                    action={
                      <button
                        type="button"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}?tab=billing`)}
                        className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover cursor-pointer"
                      >
                        Review linked matter billing
                      </button>
                    }
                  />
                ) : (
                  <p className="text-sm text-on-surface-muted text-center py-4">
                    {selectionMode === "dateRange"
                      ? "No direct client time entries found in this date range for the selected members."
                      : "No direct client time entries found for the selected members."}
                  </p>
                )
              )}
            </div>
            <ShowMoreButton
              expanded={showAllTimeEntries}
              hiddenCount={visibleTimeEntries.length - LIST_PREVIEW_LIMIT}
              onToggle={() => setShowAllTimeEntries(!showAllTimeEntries)}
            />
          </div>

          {/* Recurring Retainer Section */}
          <CollapsibleSection
            title="Set Up Evergreen Retainer"
            description="Optional: create an auto-billing plan for this client"
            summary={
              retainerSaved
                ? "Evergreen retainer created"
                : "Optional: create an auto-billing plan for this client"
            }
            open={retainerOpen}
            onToggle={() => setRetainerOpen(!retainerOpen)}
            actions={
              retainerSaved ? (
                <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-1 rounded-full">
                  ✓ Evergreen retainer created
                </span>
              ) : undefined
            }
          >
            {retainerSaved ? (
              <div className="text-sm text-on-surface-secondary py-2">
                Evergreen retainer plan created successfully. You can manage it from the{" "}
                <button
                  type="button"
                  onClick={() => navigate(`/lawfirm/${lawFirmId}/billing`)}
                  className="text-accent-emphasis hover:underline cursor-pointer"
                >
                  billing workbench
                </button>.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <FieldLabel tone="secondary">Plan Name</FieldLabel>
                    <input
                      type="text"
                      value={retainerName}
                      onChange={(e) => setRetainerName(e.target.value)}
                      placeholder="e.g. Evergreen Retainer"
                      className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <div>
                    <FieldLabel tone="secondary">Amount *</FieldLabel>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted text-sm">$</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={retainerAmount}
                        onChange={(e) => setRetainerAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full border border-input-border bg-input-bg text-on-surface rounded-md pl-7 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel tone="secondary">Billing Interval</FieldLabel>
                    <Dropdown
                      value={retainerInterval}
                      onChange={(value) => setRetainerInterval(value as "week" | "month")}
                      options={[
                        { value: "month", label: "Monthly" },
                        { value: "week", label: "Weekly" },
                      ]}
                      buttonClassName="border-input-border bg-input-bg"
                    />
                  </div>
                  <div>
                    <FieldLabel tone="secondary">Start Date</FieldLabel>
                    <DatePicker
                      value={retainerStartDate}
                      onChange={setRetainerStartDate}
                      className="w-full"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface-secondary mb-2">When does this evergreen retainer end?</label>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" value="manual" checked={retainerEndCondition === "manual"} onChange={() => setRetainerEndCondition("manual")} className="accent-blue-600" />
                      <span className="text-sm text-on-surface">Manually</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" value="date" checked={retainerEndCondition === "date"} onChange={() => setRetainerEndCondition("date")} className="accent-blue-600" />
                      <span className="text-sm text-on-surface">On a specific date</span>
                    </label>
                  </div>
                  {retainerEndCondition === "date" && (
                    <DatePicker
                      value={retainerEndDate}
                      onChange={setRetainerEndDate}
                      className="mt-2"
                    />
                  )}
                </div>

                <div className="pt-1">
                  <Button
                    onClick={() => void handleCreateRetainer()}
                    type="secondary"
                    loading={savingRetainer}
                  >
                    Create Evergreen Retainer Plan
                  </Button>
                </div>
              </div>
            )}
          </CollapsibleSection>

        </div>

        <div className="lg:col-span-1">
          <div className="bg-surface rounded-lg shadow-sm border border-outline p-4 sm:p-6 sticky top-6">
            <h2 className="text-lg font-semibold text-on-surface mb-4">Invoice Summary</h2>

            <div className="space-y-4">
              <div>
                <div className="text-sm text-on-surface-secondary mb-2">Client</div>
                <div className="text-xl font-bold text-on-surface">{client?.name || client?.email || "Client"}</div>
              </div>

              <div>
                <div className="text-sm text-on-surface-secondary mb-2">Selected Entries</div>
                <div className="text-2xl font-bold text-on-surface">{selectedTimeEntries.size}</div>
              </div>

              <div className="border-t border-outline pt-4">
                <div className="mb-4">
                  <CollapsibleList
                    items={Array.from(totals.memberTotals.entries())}
                    previewLimit={LIST_PREVIEW_LIMIT}
                    expanded={showAllMemberTotals}
                    className="space-y-2"
                    renderItem={([userId, member]) => (
                      <div key={userId} className="flex justify-between text-sm">
                        <span className="text-on-surface-secondary">{member.userName}</span>
                        <span className="text-on-surface font-medium">
                          {formatHoursMinutes(member.hours)} • {formatCurrency(member.amount)}
                        </span>
                      </div>
                    )}
                  />
                  <ShowMoreButton
                    expanded={showAllMemberTotals}
                    hiddenCount={totals.memberTotals.size - LIST_PREVIEW_LIMIT}
                    onToggle={() => setShowAllMemberTotals(!showAllMemberTotals)}
                  />
                </div>

                <div className="border-t border-outline pt-4">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-on-surface-secondary">Time Entry Hours</span>
                    <span className="text-on-surface font-medium">{formatHoursMinutes(totals.totalHours)}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-on-surface-secondary">Time Entry Amount</span>
                    <span className="text-on-surface font-medium">{formatCurrency(totals.timeEntryAmount)}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-on-surface-secondary">Flat Fees</span>
                    <span className="text-on-surface font-medium">{formatCurrency(totals.flatFeesAmount)}</span>
                  </div>
                  <div className="flex justify-between text-sm pt-2 border-t border-outline">
                    <span className="text-on-surface-secondary font-medium">Subtotal</span>
                    <span className="text-on-surface font-medium">{formatCurrency(totals.totalAmount)}</span>
                  </div>
                  {totalPrePayments > 0 && (
                    <div className="flex justify-between text-sm mt-2">
                      <span className="text-on-surface-secondary font-medium">Payments Received</span>
                      <span className="text-green-600 dark:text-green-400 font-medium">-{formatCurrency(totalPrePayments)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-lg font-bold text-on-surface pt-2 mt-2 border-t border-outline">
                    <span>Balance Due</span>
                    <span>{formatCurrency(balanceDue)}</span>
                  </div>
                </div>
              </div>

              <Button
                onClick={() => void handleCreateInvoice()}
                type="primary"
                className="w-full mt-4"
                loading={creatingInvoice}
                disabled={creatingInvoice || (selectedTimeEntries.size === 0 && selectedFlatFees.size === 0) || totals.totalAmount <= 0}
              >
                Generate Invoice
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Creating an invoice needs billing.manageInvoices on the backend. The gate sits
 * outside the component that owns the data hooks, so a member without it sees
 * the denial page without the page first loading the client's billable work.
 */
export default function ClientGenerateInvoicePage() {
  return (
    <RequirePermission permission="billing.manageInvoices" page>
      <ClientGenerateInvoiceContent />
    </RequirePermission>
  );
}
