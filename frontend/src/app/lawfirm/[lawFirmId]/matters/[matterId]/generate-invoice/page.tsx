"use client";

import { completeInvoiceDraft } from "@/components/billingComp/submitInvoiceDraft";
import { getTimeEntryRate } from "@/components/billingComp/utils";
import InvoiceDraftFields from "@/components/billingComp/InvoiceDraftFields";
import useInvoiceDraft from "@/hooks/billingHooks/useInvoiceDraft";

import { FlatFeeEditorRow } from "@/components/billingComp/FlatFeeEditor";
import MatterSplitInvoiceComposer from "@/components/billingComp/MatterSplitInvoiceComposer";
import PaymentPlanFields,{
buildPaymentPlanPayload
} from "@/components/billingComp/PaymentPlanFields";
import ClientContactModal from "@/components/clientComp/ClientContactModal";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import AddClientModal from "@/components/matterComp/AddClientModal";
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
import { ACTIVITY_CODES,TASK_CODES } from "@/lib/data/utbmsCodes";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatCurrency,hourlyAmount } from "@/lib/utils/currency";
import { formatHoursMinutes,hmToHours,hoursToHm } from "@/lib/utils/format";
import billingService from "@/services/billing.service";
import { chargeCodesService } from "@/services/chargeCodes.service";
import clientsService from "@/services/clients.service";
import MattersService from "@/services/matters.service";
import type { ChargeCode,Matter,MatterClient,Member,TimeEntry } from "@/types";
import { isCompanyRosterContact,type CompanyRosterContact } from "@/types/client";
import dayjs from "dayjs";
import { DollarSign,Eye,Info,Pencil,Star } from "lucide-react";
import { useParams,useRouter,useSearchParams } from "next/navigation";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";

// How many items each list on this page shows before the "Show N more" toggle.
const LIST_PREVIEW_LIMIT = 5;

export default function GenerateInvoicePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const matterId = Array.isArray(params?.matterId) ? params.matterId[0] : (params?.matterId as string);
  const requestedBillingMatterClientId = searchParams.get("billToMatterClientId");
  const requestedPreferredMatterClientIds = useMemo(
    () =>
      (searchParams.get("preferredMatterClientIds") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [searchParams],
  );
  const requestedDraftId = searchParams.get("draftId");
  const requestedDraftType = searchParams.get("draftType");
  
  const [matterData, setMatterData] = useState<Matter | null>(null);
  const { lawFirm } = useLawFirm();
  const [matterClients, setMatterClients] = useState<MatterClient[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [savingInvoice, setSavingInvoice] = useState(false);

  // Invoice configuration
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState({
    startDate: dayjs().subtract(30, 'days').format('YYYY-MM-DD'),
    endDate: dayjs().format('YYYY-MM-DD'),
  });
  const [selectedTimeEntries, setSelectedTimeEntries] = useState<Set<string>>(new Set());
  const [selectedFlatFees, setSelectedFlatFees] = useState<Set<string>>(new Set());
  const {
    invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate,
    dueDate, setDueDate, billingEmail, setBillingEmail, notes, setNotes, remitTo, setRemitTo,
    prePayments, setPrePayments, editingPrePayments, setEditingPrePayments,
    paymentPlanOpen, setPaymentPlanOpen, paymentPlanEnabled, setPaymentPlanEnabled,
    paymentPlan, updatePaymentPlan,
  } = useInvoiceDraft();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [invoiceMode, setInvoiceMode] = useState<"single" | "split">("single");
  const [addClientModalOpen, setAddClientModalOpen] = useState(false);
  const [flatFees, setFlatFees] = useState<Array<{ id: string; description: string; amount: number; date?: string | null }>>([]);
  
  // Pre-recorded payments (payments already made before invoice is generated)

  // Retainer plan
  const [retainerName, setRetainerName] = useState("");
  const [retainerAmount, setRetainerAmount] = useState("");
  const [retainerInterval, setRetainerInterval] = useState<"week" | "month">("month");
  const [retainerStartDate, setRetainerStartDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [retainerEndCondition, setRetainerEndCondition] = useState<"manual" | "matter_closed" | "date">("manual");
  const [retainerEndDate, setRetainerEndDate] = useState("");
  const [savingRetainer, setSavingRetainer] = useState(false);
  const [retainerSaved, setRetainerSaved] = useState(false);

  // Payment plan setup


  // Selection mode
  const [selectionMode, setSelectionMode] = useState<'all' | 'dateRange' | 'manual'>('dateRange');
  const timeEntriesSectionRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [savingFlatFeeId, setSavingFlatFeeId] = useState<string | null>(null);
  const [deletingFlatFeeId, setDeletingFlatFeeId] = useState<string | null>(null);
  const [chargeCodes, setChargeCodes] = useState<ChargeCode[]>([]);
  const [editingManualEntries, setEditingManualEntries] = useState<Set<string>>(new Set());

  // Who at a COMPANY client's company will receive/see this invoice, loaded
  // from that company's roster of linked Person clients.
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
  const [showAllPrePayments, setShowAllPrePayments] = useState(false);
  const [showAllMemberTotals, setShowAllMemberTotals] = useState(false);

  const getEntryRate = useCallback((entry: TimeEntry) => {
    const member = matterData?.members?.find((m) => m.userId === entry.userId);
    return getTimeEntryRate(entry, member?.hourlyRate ?? 0);
  }, [matterData?.members]);

  // Scroll to time entries section when manual selection is chosen
  useEffect(() => {
    if (selectionMode === 'manual' && timeEntriesSectionRef.current) {
      setTimeout(() => {
        timeEntriesSectionRef.current?.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        });
      }, 100);
    }
  }, [selectionMode]);

  // Scroll to error when it appears
  useEffect(() => {
    if (validationError && errorRef.current) {
      setTimeout(() => {
        errorRef.current?.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'center' 
        });
      }, 100);
    }
  }, [validationError]);

  const loadMatter = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const [matterInfo, clients] = await Promise.all([
        MattersService.getMatterById(matterId, lawFirmId),
        MattersService.listClients(lawFirmId, matterId)
      ]);
      setMatterData(matterInfo);
      setMatterClients(clients || []);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load matter"));
    } finally {
      setLoading(false);
    }
  }, [lawFirmId, matterId]);

  // Seed the remit-to defaults from the firm record, sourced from the firm
  // layout's shared context instead of a redundant per-page fetch. Billing
  // email is left blank by default: it's an override for when the client
  // wants the invoice sent somewhere other than their own email, and the
  // backend already falls back to the client's email when it's left empty.
  useEffect(() => {
    if (!lawFirm) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds form defaults from the shared firm record (external source)
    setRemitTo(prev => ({
      name: prev.name || lawFirm.name || '',
      address: prev.address || lawFirm.address || '',
      city: prev.city || lawFirm.city || '',
      state: prev.state || lawFirm.state || '',
      zip: prev.zip || lawFirm.zip || '',
    }));
  }, [lawFirm]);

  const loadTimeEntries = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    
    try {
      const entries = await billingService.listTimeEntries({
        type: 'matter',
        lawFirmId,
        entityId: matterId,
      });
      setTimeEntries((entries || []).filter(e => !e.isBilled));
    } catch (err) {
      console.error('Error loading time entries:', err);
      setError(getErrorMessage(err, 'Failed to load time entries'));
    }
  }, [lawFirmId, matterId]);

  const loadFlatFees = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    
    try {
      const fees = await billingService.listFlatFees({
        type: 'matter',
        lawFirmId,
        entityId: matterId,
      });
      const unbilledFees = (fees || []).filter(f => !f.isBilled);
      setFlatFees(unbilledFees);
      // Auto-select all flat fees when loaded
      setSelectedFlatFees(new Set(unbilledFees.map(f => f.id)));
    } catch (err) {
      console.error('Error loading flat fees:', err);
      // Don't set error for flat fees, just log it
    }
  }, [lawFirmId, matterId]);

  const handleSaveFlatFee = useCallback(async (fee: { id: string; description: string; amount: number; date?: string | null }) => {
    if (!fee.description.trim() || fee.amount <= 0) {
      setValidationError("Please provide a description and amount for the flat fee");
      return;
    }
    setSavingFlatFeeId(fee.id);
    try {
      const savedFee = await billingService.addFlatFee(
        { type: 'matter', lawFirmId, entityId: matterId },
        {
          description: fee.description.trim(),
          amount: fee.amount,
          date: fee.date || null,
        },
      );
      setFlatFees(prev => prev.filter(f => f.id !== fee.id));
      await loadFlatFees();
      if (savedFee?.id) {
        setSelectedFlatFees(prev => new Set([...prev, savedFee.id]));
      }
    } catch (err) {
      setValidationError(getErrorMessage(err, "Failed to save flat fee"));
    } finally {
      setSavingFlatFeeId(null);
    }
  }, [lawFirmId, matterId, loadFlatFees]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: matter/time-entry/flat-fee/charge-code state set as requests resolve
    loadMatter();
    loadTimeEntries();
    loadFlatFees();
    chargeCodesService.getChargeCodes(lawFirmId).then(res => setChargeCodes(res.chargeCodes.filter(c => c.isActive))).catch(() => {});
  }, [lawFirmId, matterId, loadMatter, loadTimeEntries, loadFlatFees]);

  useEffect(() => {
    if (matterClients.length === 0) return;

    if (requestedBillingMatterClientId && matterClients.some((matterClient) => matterClient.id === requestedBillingMatterClientId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects the billing recipient from params/draft into user-editable selection state
      setSelectedClientId(requestedBillingMatterClientId);
      return;
    }

    const draftEntry = requestedDraftId && requestedDraftType === "time_entry"
      ? timeEntries.find((entry) => entry.id === requestedDraftId) || null
      : null;
    const draftHasExplicitRecipients = Boolean(
      draftEntry?.matterClientId ||
      (draftEntry?.matterClientIds && draftEntry.matterClientIds.length > 0) ||
      requestedPreferredMatterClientIds.length > 0,
    );
    const shouldDeferRecipientSelection =
      matterClients.length > 1 &&
      Boolean(requestedDraftId) &&
      !requestedBillingMatterClientId &&
      (
        requestedDraftType === "flat_fee" ||
        (requestedDraftType === "time_entry" && !draftHasExplicitRecipients)
      );

    if (shouldDeferRecipientSelection) {
      setSelectedClientId((prev) => {
        if (!prev) return null;
        return matterClients.some((matterClient) => matterClient.id === prev) ? prev : null;
      });
      return;
    }

    if (!selectedClientId) {
      setSelectedClientId(matterClients[0].id);
    }
  }, [
    matterClients,
    requestedBillingMatterClientId,
    requestedDraftId,
    requestedDraftType,
    requestedPreferredMatterClientIds,
    selectedClientId,
    timeEntries,
  ]);

  // Auto-select members when matter loads
  useEffect(() => {
    if (matterData?.members && matterData.members.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects matter members into user-editable selection state once the matter loads
      setSelectedMembers(new Set(matterData.members.map(m => m.userId)));
    }
  }, [matterData]);

  const selectedMatterClient = matterClients.find((matterClient) => matterClient.id === selectedClientId) || null;
  const isCompanyClient = selectedMatterClient?.clientType === "company";

  // Who at the billed company will receive/see this invoice, sourced from
  // that company's roster of linked Person clients.
  const loadBillingRecipients = useCallback(() => {
    if (!lawFirmId || !selectedClientId || !isCompanyClient) {
      setBillingRecipients([]);
      return;
    }
    setBillingRecipientsLoading(true);
    clientsService
      .listClientContacts(lawFirmId, selectedClientId)
      .then((contacts) => setBillingRecipients(contacts.filter(isCompanyRosterContact)))
      .catch(() => setBillingRecipients([]))
      .finally(() => setBillingRecipientsLoading(false));
  }, [lawFirmId, selectedClientId, isCompanyClient]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: roster state set as the request progresses
    loadBillingRecipients();
  }, [loadBillingRecipients]);

  useEffect(() => {
    if (searchParams.get("mode") === "split" && matterClients.length > 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes invoice mode from URL params into user-editable state
      setInvoiceMode("split");
    }
  }, [matterClients.length, searchParams]);

  useEffect(() => {
    const draftType = searchParams.get("draftType");
    if (!draftType) return;

    const singleId = searchParams.get("draftId");
    const multiIds = searchParams.get("draftIds");
    const ids = multiIds
      ? multiIds.split(",").map((v) => v.trim()).filter(Boolean)
      : singleId
        ? [singleId]
        : [];
    if (ids.length === 0) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds selection mode and selected items from draft URL params into user-editable state
    setSelectionMode("manual");
    if (draftType === "time_entry") {
      const valid = ids.filter((id) => timeEntries.some((entry) => entry.id === id));
      if (valid.length > 0) setSelectedTimeEntries(new Set(valid));
      setSelectedFlatFees(new Set());
    } else if (draftType === "flat_fee") {
      const valid = ids.filter((id) => flatFees.some((fee) => fee.id === id));
      if (valid.length > 0) setSelectedFlatFees(new Set(valid));
      setSelectedTimeEntries(new Set());
    }
  }, [flatFees, searchParams, timeEntries]);

  useEffect(() => {
    if (requestedBillingMatterClientId) return;

    if (!requestedDraftId || requestedDraftType !== "time_entry") return;

    const draftEntry = timeEntries.find((entry) => entry.id === requestedDraftId);
    if (!draftEntry?.matterClientId) return;
    if (!matterClients.some((matterClient) => matterClient.id === draftEntry.matterClientId)) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects the draft's matter client into user-editable selection state
    setSelectedClientId(draftEntry.matterClientId);
  }, [matterClients, requestedBillingMatterClientId, requestedDraftId, requestedDraftType, timeEntries]);

  const preferredSplitClientIds = useMemo(() => {
    const validRequestedIds = requestedPreferredMatterClientIds.filter((matterClientId) =>
      matterClients.some((matterClient) => matterClient.id === matterClientId),
    );
    if (validRequestedIds.length > 0) {
      return validRequestedIds;
    }

    if (!requestedDraftId || requestedDraftType !== "time_entry") return [];

    const draftEntry = timeEntries.find((entry) => entry.id === requestedDraftId);
    if (!draftEntry?.matterClientIds?.length) return [];

    return draftEntry.matterClientIds.filter((matterClientId) =>
      matterClients.some((matterClient) => matterClient.id === matterClientId),
    );
  }, [matterClients, requestedDraftId, requestedDraftType, requestedPreferredMatterClientIds, timeEntries]);

  // Auto-select time entries based on selection mode
  useEffect(() => {
    if (selectionMode === 'all') {
      const filtered = timeEntries.filter(entry => selectedMembers.has(entry.userId));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- recomputes auto-selected time entries when selection mode/members/date range change
      setSelectedTimeEntries(new Set(filtered.map(e => e.id)));
    } else if (selectionMode === 'dateRange') {
      const start = dayjs(dateRange.startDate);
      const end = dayjs(dateRange.endDate).endOf('day');
      const filtered = timeEntries.filter(entry => {
        const entryDate = dayjs(entry.date);
        return selectedMembers.has(entry.userId) && 
               entryDate.isAfter(start.subtract(1, 'day')) && 
               entryDate.isBefore(end.add(1, 'day'));
      });
      setSelectedTimeEntries(new Set(filtered.map(e => e.id)));
    }
  }, [selectionMode, selectedMembers, dateRange, timeEntries]);

  const visibleTimeEntries = useMemo(() => {
    const isManualEntry = (entry: TimeEntry) => entry.id.startsWith("manual-te-");
    if (selectionMode === 'dateRange') {
      const start = dayjs(dateRange.startDate);
      const end = dayjs(dateRange.endDate).endOf('day');
      return timeEntries.filter((entry) => {
        if (isManualEntry(entry)) return true;
        const entryDate = dayjs(entry.date);
        return (
          selectedMembers.has(entry.userId) &&
          entryDate.isAfter(start.subtract(1, 'day')) &&
          entryDate.isBefore(end.add(1, 'day'))
        );
      });
    }

    return timeEntries.filter((entry) => isManualEntry(entry) || selectedMembers.has(entry.userId));
  }, [dateRange.endDate, dateRange.startDate, selectedMembers, selectionMode, timeEntries]);

  const matterClientNameById = useMemo(() => {
    return new Map(
      matterClients.map((matterClient) => [
        matterClient.id,
        matterClient.name || matterClient.email || matterClient.id,
      ]),
    );
  }, [matterClients]);

  const toggleMember = (userId: string) => {
    const newSet = new Set(selectedMembers);
    if (newSet.has(userId)) {
      newSet.delete(userId);
    } else {
      newSet.add(userId);
    }
    setSelectedMembers(newSet);
  };

  const toggleTimeEntry = (entryId: string) => {
    const newSet = new Set(selectedTimeEntries);
    if (newSet.has(entryId)) {
      newSet.delete(entryId);
    } else {
      newSet.add(entryId);
    }
    setSelectedTimeEntries(newSet);
  };

  const getSelectedEntries = () => {
    return timeEntries.filter(entry => selectedTimeEntries.has(entry.id));
  };

  const calculateTotals = () => {
    const entries = getSelectedEntries();
    const memberTotals = new Map<string, { hours: number; amount: number }>();
    
    entries.forEach(entry => {
      const rate = getEntryRate(entry);
      const current = memberTotals.get(entry.userId) || { hours: 0, amount: 0 };
      memberTotals.set(entry.userId, {
        hours: current.hours + entry.hours,
        amount: current.amount + hourlyAmount(entry.hours, rate),
      });
    });
    
    const totalHours = Array.from(memberTotals.values()).reduce((sum, t) => sum + t.hours, 0);
    const timeEntryAmount = Array.from(memberTotals.values()).reduce((sum, t) => sum + t.amount, 0);
    const flatFeesAmount = flatFees
      .filter(fee => selectedFlatFees.has(fee.id))
      .reduce((sum, fee) => sum + fee.amount, 0);
    const totalAmount = timeEntryAmount + flatFeesAmount;
    
    return { memberTotals, totalHours, totalAmount, flatFeesAmount };
  };

  const handleSaveInvoice = async () => {
    // Clear any previous validation errors
    setValidationError(null);
    
    // Validate and show specific error messages
    if (!selectedClientId) {
      setValidationError("Please select a client to bill");
      return;
    }
    if (!invoiceName || !invoiceDate) {
      const missingFields = [];
      if (!invoiceName) missingFields.push("Invoice Name");
      if (!invoiceDate) missingFields.push("Invoice Date");
      setValidationError(`Please fill in the following required fields: ${missingFields.join(", ")}`);
      return;
    }
    if (selectedTimeEntries.size === 0 && selectedFlatFees.size === 0) {
      setValidationError("Please select at least one time entry or one flat fee");
      return;
    }
    const { totalAmount } = calculateTotals();
    if (totalAmount <= 0) {
      setValidationError("Invoice total must be greater than $0");
      return;
    }
    const prePaymentsTotal = prePayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    if (prePaymentsTotal > totalAmount) {
      setValidationError("Payments received cannot exceed the invoice total");
      return;
    }
    const planResult = paymentPlanEnabled ? buildPaymentPlanPayload(paymentPlan, balanceDue) : null;
    if (planResult?.error) {
      setValidationError(planResult.error);
      return;
    }

    setSavingInvoice(true);
    try {
      // Recalculate everything fresh to ensure we have the latest values
      const { totalHours } = calculateTotals();
      const invoiceTimeEntries = getInvoiceTimeEntries();
      const selectedFlatFeesList = flatFees.filter(fee => selectedFlatFees.has(fee.id));

      // Calculate time entry amount to ensure accuracy
      const timeEntryAmount = invoiceTimeEntries.reduce((sum, entry) => {
        const amount = typeof entry.amount === 'number' ? entry.amount : parseFloat(entry.amount) || 0;
        return sum + amount;
      }, 0);
      
      // Calculate flat fees amount to ensure accuracy
      const calculatedFlatFeesAmount = selectedFlatFeesList.reduce((sum, fee) => {
        const amount = typeof fee.amount === 'number' ? fee.amount : parseFloat(fee.amount) || 0;
        return sum + amount;
      }, 0);
      
      // Recalculate total to ensure it matches what's displayed
      const calculatedTotalAmount = timeEntryAmount + calculatedFlatFeesAmount;

      const saveData = {
        lawFirmId,
        matterId,
        invoiceName,
        invoiceNumber: invoiceNumber || null,
        invoiceDate,
        dueDate: dueDate || null,
        billingEmail: billingEmail || null,
        notes: notes || null,
        clientId: selectedClientId,
        remitTo: remitTo.name || remitTo.address ? remitTo : null,
        timeEntries: invoiceTimeEntries.map(entry => ({
          ...lineSourceId(entry.id),
          name: entry.name || 'Service',
          description: entry.description || undefined,
          rate: typeof entry.rate === 'number' ? entry.rate : parseFloat(entry.rate) || 0,
          hours: typeof entry.hours === 'number' ? entry.hours : parseFloat(entry.hours) || 0,
          amount: typeof entry.amount === 'number' ? entry.amount : parseFloat(entry.amount) || 0,
        })),
        flatFees: selectedFlatFeesList.map(fee => ({
          ...lineSourceId(fee.id),
          description: fee.description,
          amount: typeof fee.amount === 'number' ? fee.amount : parseFloat(fee.amount) || 0,
        })),
        totalHours: typeof totalHours === 'number' ? totalHours : parseFloat(totalHours) || 0,
        totalAmount: typeof calculatedTotalAmount === 'number' ? calculatedTotalAmount : parseFloat(calculatedTotalAmount) || 0,
        flatFeesAmount: typeof calculatedFlatFeesAmount === 'number' ? calculatedFlatFeesAmount : parseFloat(calculatedFlatFeesAmount) || 0,
      };

      const createdInvoice = await billingService.createInvoice(
        { type: 'matter', lawFirmId, entityId: matterId },
        saveData,
      );

      await completeInvoiceDraft({ type: 'matter', lawFirmId, entityId: matterId }, createdInvoice.id, planResult?.payload, prePayments);

      setValidationError(null);
      navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${createdInvoice.id}`);
    } catch (err) {
      setValidationError(getErrorMessage(err, "Failed to save invoice"));
    } finally {
      setSavingInvoice(false);
    }
  };

  const handleCreateRetainer = async () => {
    if (!retainerAmount || Number(retainerAmount) <= 0) {
      setValidationError("Enter a valid retainer amount.");
      return;
    }
    setSavingRetainer(true);
    setValidationError(null);
    try {
      await billingService.createPlan(lawFirmId, {
        contextType: "matter",
        entityId: matterId,
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
      setValidationError(getErrorMessage(err, "Failed to create retainer plan"));
    } finally {
      setSavingRetainer(false);
    }
  };

  const handleSplitInvoicesCreated = ({ createdCount }: { createdCount: number; splitGroupId: string }) => {
    navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices?createdSplit=${createdCount}`);
  };

  const getInvoiceTimeEntries = () => {
    return getSelectedEntries().map(entry => {
      const rate = getEntryRate(entry);
      const amount = hourlyAmount(entry.hours, rate);
      return {
        ...entry,
        billedBy: entry.userName || 'Unknown',
        rate,
        amount,
      };
    });
  };

  if (loading) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  // Only show fatal error page if matterData is missing (loading failed) or there's a fatal error
  // Don't show it for validation errors - those should show the form
  if (!matterData && !loading) {
    return (
      <div className="p-6 max-w-[1600px] mx-auto">
        <ErrorNotification error={error || "Matter not found"} className="mb-4" />
        <Button
          onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}`)}
          type="secondary"
        >
          Back to Matter
        </Button>
      </div>
    );
  }

  // Don't render the form if still loading or if matterData is null
  if (loading || !matterData) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  const { memberTotals, totalHours, totalAmount, flatFeesAmount } = calculateTotals();
  const invoiceTimeEntries = getInvoiceTimeEntries();
  const selectedFlatFeesList = flatFees.filter(fee => selectedFlatFees.has(fee.id));
  const totalPrePayments = prePayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const balanceDue = totalAmount - totalPrePayments;

  // Optional sections start open whenever they already carry money, so nothing
  // that lands on the invoice can hide behind a collapsed header.
  const flatFeesOpen = flatFeesOpenOverride ?? flatFees.length > 0;
  const prePaymentsOpen = prePaymentsOpenOverride ?? prePayments.length > 0;
  const selectedFlatFeesTotal = selectedFlatFeesList.reduce((sum, fee) => sum + fee.amount, 0);

  const remitToSummary =
    [
      remitTo.name,
      remitTo.address,
      [remitTo.city, remitTo.state].filter(Boolean).join(", "),
      remitTo.zip,
    ]
      .filter(Boolean)
      .join(" · ") || "Not set";

  const billingRecipientsCount = billingRecipients.filter((c) => c.isEmailRecipient).length;
  const billingRecipientsSummary = billingRecipientsLoading
    ? "Loading..."
    : billingRecipientsCount === 0
      ? "No one set to receive billing emails"
      : `${billingRecipientsCount} of ${billingRecipients.length} receive billing emails`;

  const matterMembers = matterData?.members || [];

  // Manually added entries are drafts the user is still filling in, so they stay
  // visible regardless of how much of the loaded list is collapsed.
  const manualVisibleEntries = visibleTimeEntries.filter((entry) => entry.id.startsWith("manual-te-"));
  const loadedVisibleEntries = visibleTimeEntries.filter((entry) => !entry.id.startsWith("manual-te-"));
  const memberScopeLabel =
    selectedMembers.size === matterMembers.length
      ? `All ${matterMembers.length} team members`
      : `${selectedMembers.size} of ${matterMembers.length} team members`;
  const entryScopeLabel =
    selectionMode === 'all'
      ? 'all unbilled entries'
      : selectionMode === 'dateRange'
        ? `${dayjs(dateRange.startDate).format('MMM D')} to ${dayjs(dateRange.endDate).format('MMM D, YYYY')}`
        : 'manual selection';

  const addFlatFee = () => {
    const newFee = {
      id: `flat-fee-${Date.now()}`,
      description: '',
      amount: 0,
      date: '',
    };
    setFlatFees([...flatFees, newFee]);
    // Auto-select new flat fees when added
    setSelectedFlatFees(prev => new Set([...prev, newFee.id]));
    setFlatFeesOpenOverride(true);
    // The new row is appended, so expand past the preview limit to reveal it.
    setShowAllNewFlatFees(true);
  };
  
  
  // Separate saved flat fees (from backend) from new ones (being added)
  const savedFlatFees = flatFees.filter(f => !f.id.startsWith('flat-fee-'));
  const newFlatFees = flatFees.filter(f => f.id.startsWith('flat-fee-'));

  const removeFlatFee = async (id: string) => {
    // If it's a saved flat fee (from backend), delete it
    if (!id.startsWith('flat-fee-')) {
      try {
        setDeletingFlatFeeId(id);
        await billingService.removeFlatFee(
          { type: 'matter', lawFirmId, entityId: matterId },
          id,
        );
        await loadFlatFees();
      } finally {
        setDeletingFlatFeeId(null);
      }
    } else {
      // Just remove from local state if it's a new fee
      setFlatFees(flatFees.filter(fee => fee.id !== id));
    }
  };

  // ── Manual time entries ──
  const addManualTimeEntry = () => {
    const newEntry: TimeEntry = {
      id: `manual-te-${Date.now()}`,
      lawFirmId,
      userId: "",
      userName: "Manual Entry",
      hours: 0,
      date: dayjs().format("YYYY-MM-DD"),
      name: "",
      hourlyRate: 0,
    };
    setTimeEntries((prev) => [...prev, newEntry]);
    setSelectedTimeEntries((prev) => new Set([...prev, newEntry.id]));
    setEditingManualEntries((prev) => new Set([...prev, newEntry.id]));
  };

  const updateManualTimeEntry = (id: string, field: string, value: string | number | null) => {
    setTimeEntries((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
    );
  };

  const removeManualTimeEntry = (id: string) => {
    setTimeEntries((prev) => prev.filter((entry) => entry.id !== id));
    setSelectedTimeEntries((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };


  return (
    <RequirePermission
      permission="billing.manageInvoices"
      fallback={
        <div className="flex flex-col items-center justify-center min-h-screen gap-3 text-center px-4">
          <p className="text-base font-semibold text-on-surface">Permission required</p>
          <p className="text-sm text-on-surface-muted">You need the <span className="font-medium">billing.manageInvoices</span> permission to generate invoices.</p>
          <button
            onClick={() => router.back()}
            className="mt-2 px-4 py-2 text-sm font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-transform active:scale-[0.96] motion-reduce:active:scale-100"
          >
            Go back
          </button>
        </div>
      }
    >
      <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 sm:mb-8">
        <div className="flex items-center gap-4">
          <BackButton href={`/lawfirm/${lawFirmId}/matters/${matterId}`} label="Back to Matter" />
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-on-surface">Generate Invoice</h1>
            <p className="text-sm text-on-surface-secondary mt-1">{matterData.name}</p>
          </div>
        </div>
      </div>

      {validationError && (
        <div ref={errorRef} className="mb-4">
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">Please fix the following issue:</h3>
                <p className="text-sm text-red-700 dark:text-red-400">{validationError}</p>
              </div>
              <div className="ml-auto flex-shrink-0">
                <button
                  type="button"
                  className="inline-flex rounded-md bg-red-50 dark:bg-red-950/30 p-1.5 text-red-500 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                  onClick={() => setValidationError(null)}
                >
                  <span className="sr-only">Dismiss</span>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && !validationError && (
        <div className="mb-4">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Configuration */}
        <div className="lg:col-span-2 space-y-6">
          {/* Invoice Details */}
          <div className="bg-surface rounded-lg shadow-sm border border-outline p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-on-surface mb-4">Invoice Details</h2>
            <div className="mb-4">
              <p className="text-sm font-medium text-on-surface-secondary mb-2">Invoice Mode</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setInvoiceMode("single")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                    invoiceMode === "single"
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                      : "bg-surface-alt text-on-surface-secondary hover:bg-surface-hover"
                  }`}
                >
                  Single Client
                </button>
                <button
                  type="button"
                  onClick={() => setInvoiceMode("split")}
                  disabled={matterClients.length < 2}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                    invoiceMode === "split"
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                      : "bg-surface-alt text-on-surface-secondary hover:bg-surface-hover"
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  Split Across Clients
                </button>
              </div>
              {matterClients.length < 2 ? (
                <p className="mt-2 text-xs text-on-surface-muted">
                  Add at least two clients to this matter to enable split billing.
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {invoiceMode === "single" ? (
                <div>
                  <FieldLabel tone="secondary">Bill To (Client) *</FieldLabel>
                  <Dropdown
                    value={selectedClientId || ''}
                    onChange={(value) => setSelectedClientId(value || null)}
                    placeholder="Select a client..."
                    options={matterClients.map((client) => ({
                      value: client.id,
                      label: `${client.name}${client.organization ? ` (${client.organization})` : ""}`,
                    }))}
                    buttonClassName="border-input-border bg-input-bg"
                  />
                  <button
                    type="button"
                    onClick={() => setAddClientModalOpen(true)}
                    className="mt-1.5 text-xs text-accent-emphasis hover:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
                  >
                    + Add a client to this matter
                  </button>
                </div>
              ) : (
                <div>
                  <FieldLabel tone="secondary">Split Recipients</FieldLabel>
                  <div className="rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface-secondary">
                    Select clients and set each share below.
                  </div>
                  <button
                    type="button"
                    onClick={() => setAddClientModalOpen(true)}
                    className="mt-1.5 text-xs text-accent-emphasis hover:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
                  >
                    + Add a client to this matter
                  </button>
                </div>
              )}
              <InvoiceDraftFields
                draft={{ invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate, dueDate, setDueDate, billingEmail, setBillingEmail }}
                nameLabel={invoiceMode === "split" ? "Base Invoice Name *" : "Invoice Name *"}
                numberLabel={invoiceMode === "split" ? "Base Invoice Number" : "Invoice Number"}
                namePlaceholder="e.g. Client Intake, Monthly Retainer"
                requiredName
                billingEmailLabel={<label className="flex items-center gap-1 text-sm font-medium text-on-surface-secondary mb-1">
                  Billing Email
                  <Tooltip title="Optional. Adds an extra recipient, e.g. a bookkeeper, alongside the client's own email. Generating the invoice here does not email anyone; this is used later when you send the invoice from its detail page." enterDelay={300}>
                    <Info size={13} className="text-on-surface-muted cursor-help" />
                  </Tooltip>
                </label>}
              />
            </div>
            <div className="mt-4">
              <FieldLabel tone="secondary">Notes</FieldLabel>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Additional notes or terms..."
                className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          </div>

          {/* Remit To Section */}
          <CollapsibleSection
            title="Remit To (Payment Address)"
            description="Where clients send payment. Prefilled from your firm profile."
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

          {isCompanyClient && selectedClientId && (
            <ClientContactModal
              open={billingRecipientModalOpen}
              onClose={() => setBillingRecipientModalOpen(false)}
              onSaved={loadBillingRecipients}
              lawFirmId={lawFirmId}
              clientId={selectedClientId}
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
            description="Include saved unbilled flat fees, or add a new one for this invoice."
            summary={
              flatFees.length === 0
                ? "No unbilled flat fees"
                : `${selectedFlatFeesList.length} of ${flatFees.length} selected · ${formatCurrency(selectedFlatFeesTotal)}`
            }
            open={flatFeesOpen}
            onToggle={() => setFlatFeesOpenOverride(!flatFeesOpen)}
            actions={
              <Button
                onClick={addFlatFee}
                type="secondary"
                size="small"
              >
                + Add Flat Fee
              </Button>
            }
          >
            {/* Saved Flat Fees */}
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
                          const newSelected = new Set(selectedFlatFees);
                          if (checked) {
                            newSelected.add(fee.id);
                          } else {
                            newSelected.delete(fee.id);
                          }
                          setSelectedFlatFees(newSelected);
                        }}
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-on-surface">{fee.description}</span>
                          <StatusBadge variant="success">Unbilled</StatusBadge>
                          <span className="text-sm text-on-surface-secondary">{formatCurrency(fee.amount)}</span>
                          {fee.date && (
                            <span className="text-xs text-on-surface-muted">
                              {dayjs(fee.date).format('MMM DD, YYYY')}
                            </span>
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
                        className="p-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingFlatFeeId === fee.id ? (
                          <Spinner size={20} />
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )}
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

            {/* New Flat Fees (not yet saved) */}
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
                <p className="text-sm text-on-surface-muted text-center py-4">No unbilled flat fees available. Click "Add Flat Fee" to add charges like driving time or filing fees.</p>
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
                  <span className="text-lg font-semibold text-on-surface">
                    ${[...savedFlatFees, ...newFlatFees]
                      .filter(fee => selectedFlatFees.has(fee.id))
                      .reduce((sum, fee) => sum + fee.amount, 0).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </CollapsibleSection>

          {/* Pre-Recorded Payments */}
          {invoiceMode === "single" && (
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
                    amount: '',
                    date: dayjs().format('YYYY-MM-DD'),
                    invoiceNumber: '',
                    note: '',
                  }]);
                  setEditingPrePayments(prev => new Set([...prev, newPaymentId]));
                  setPrePaymentsOpenOverride(true);
                  // The new row is appended, so expand past the preview limit to reveal it.
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
                      setPrePayments(prePayments.filter(p => p.id !== payment.id));
                      setEditingPrePayments(prev => {
                        const next = new Set(prev);
                        next.delete(payment.id);
                        return next;
                      });
                    };

                    // Compact (saved) view
                    if (!editingPrePayments.has(payment.id)) {
                      return (
                        <div key={payment.id} className="rounded-lg border border-outline bg-surface-alt/40 p-3">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-on-surface">Payment {idx + 1}</div>
                              <div className="mt-1 text-xs text-on-surface-muted">
                                {payment.date ? dayjs(payment.date).format('MMM DD, YYYY') : 'No date'}
                                {payment.invoiceNumber.trim() ? ` • #${payment.invoiceNumber.trim()}` : ''}
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
                                onClick={() => setEditingPrePayments(prev => new Set([...prev, payment.id]))}
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
                            onChange={(e) => setPrePayments(prePayments.map(p => p.id === payment.id ? { ...p, amount: e.target.value } : p))}
                          />
                        </div>
                        <div>
                          <FieldLabel size="xs" tone="secondary">Date</FieldLabel>
                          <DatePicker
                            value={payment.date}
                            onChange={(value) => setPrePayments(prePayments.map(p => p.id === payment.id ? { ...p, date: value } : p))}
                            className="w-full"
                          />
                        </div>
                        <div>
                          <FieldLabel size="xs" tone="secondary">Invoice #</FieldLabel>
                          <TextInput
                            type="text"
                            placeholder="Receipt or invoice number"
                            value={payment.invoiceNumber}
                            onChange={(e) => setPrePayments(prePayments.map(p => p.id === payment.id ? { ...p, invoiceNumber: e.target.value } : p))}
                          />
                        </div>
                        <div>
                          <FieldLabel size="xs" tone="secondary">Note</FieldLabel>
                          <TextInput
                            type="text"
                            placeholder="e.g. Wire transfer, check #..."
                            value={payment.note}
                            onChange={(e) => setPrePayments(prePayments.map(p => p.id === payment.id ? { ...p, note: e.target.value } : p))}
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
                              onClick={() => setEditingPrePayments(prev => {
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
                    {formatCurrency(prePayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0))}
                  </span>
                </div>
              </div>
            )}
          </CollapsibleSection>
          )}

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
                  radioName="genInvoiceMatterPlanMode"
                  className="pt-1"
                />
              )}
            </div>
          </CollapsibleSection>

          {/* Time Entries List */}
          <div
            ref={timeEntriesSectionRef}
            className="rounded-lg p-4 sm:p-6 bg-surface border-2 border-outline shadow-sm"
          >
            <div className="flex items-center gap-2 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-on-surface">
                  {selectionMode === 'manual' ? 'Select Time Entries' : 'Included Time Entries'}
                </h2>
                <p className="text-xs text-on-surface-muted mt-1">
                  {selectionMode === 'all'
                    ? 'Showing all unbilled entries for the selected team members.'
                    : selectionMode === 'dateRange'
                      ? 'Showing entries currently included by your selected date range.'
                      : 'Choose exactly which entries to include on this invoice.'}
                </p>
              </div>
            </div>

            {/* Filters that decide which entries land in the list below. */}
            <CollapsibleSection
              tone="inline"
              title="Filters"
              summary={selectionMode === 'manual' ? memberScopeLabel : `${memberScopeLabel} · ${entryScopeLabel}`}
              open={entryFiltersOpen}
              onToggle={() => setEntryFiltersOpen(!entryFiltersOpen)}
              className="mb-4"
            >
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-medium text-on-surface-secondary">Team Members</p>
                  {matterMembers.length > 0 ? (
                    <CollapsibleList
                      items={matterMembers}
                      previewLimit={LIST_PREVIEW_LIMIT}
                      expanded={showAllMembers}
                      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                      overflowClassName="col-span-full"
                      renderItem={(member: Member) => (
                        <label
                          key={member.userId}
                          className="flex items-center rounded-lg border border-outline bg-surface p-2.5 hover:bg-surface-hover cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedMembers.has(member.userId)}
                            onChange={() => toggleMember(member.userId)}
                          />
                          <div className="ml-2.5 min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-on-surface">{member.name || 'Unknown'}</div>
                            <div className="text-xs text-on-surface-muted">
                              Rate: {formatCurrency(member.hourlyRate ?? 0)}/hr
                            </div>
                          </div>
                        </label>
                      )}
                    />
                  ) : (
                    <p className="text-sm text-on-surface-muted">No team members found</p>
                  )}
                  <ShowMoreButton
                    expanded={showAllMembers}
                    hiddenCount={matterMembers.length - LIST_PREVIEW_LIMIT}
                    onToggle={() => setShowAllMembers(!showAllMembers)}
                  />
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium text-on-surface-secondary">Entries To Include</p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { value: 'all', label: 'All Entries' },
                      { value: 'dateRange', label: 'Date Range' },
                      { value: 'manual', label: 'Manual Selection' },
                    ] as const).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSelectionMode(option.value)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                          selectionMode === option.value
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                            : 'bg-surface border border-outline text-on-surface-secondary hover:bg-surface-hover'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {selectionMode === 'dateRange' && (
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

            <div className="space-y-2">
              <CollapsibleList
                items={loadedVisibleEntries}
                previewLimit={LIST_PREVIEW_LIMIT}
                expanded={showAllTimeEntries}
                pinned={manualVisibleEntries}
                className="space-y-2"
                renderItem={(entry) => {
                  if (entry.id.startsWith("manual-te-")) {
                    const manualRate = entry.hourlyRate || 0;
                    const manualAmount = hourlyAmount(entry.hours, manualRate);
                    const isEditing = editingManualEntries.has(entry.id);

                    // Compact (done) view
                    if (!isEditing) {
                      return (
                        <div key={entry.id} className="rounded-lg border border-outline bg-surface-alt/40 p-3">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="text-sm font-medium text-on-surface">{entry.userName || "Manual Entry"}</div>
                                <StatusBadge variant="info">Manual</StatusBadge>
                              </div>
                              {entry.name && (
                                <div className="mt-1 text-sm font-semibold text-on-surface">{entry.name}</div>
                              )}
                              <div className="mt-1 text-xs text-on-surface-muted">
                                {entry.date ? dayjs(entry.date).format("MMM DD, YYYY") : ""} {entry.hours > 0 ? `• ${formatHoursMinutes(entry.hours)}` : ""} {manualRate > 0 ? `@ ${formatCurrency(manualRate)}/hr` : ""}
                              </div>
                              {entry.description && (
                                <div className="mt-1 text-xs text-on-surface-secondary">{entry.description}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="text-sm font-semibold text-on-surface">{formatCurrency(manualAmount)}</div>
                              <Tooltip title="Edit" enterDelay={300}>
                              <button aria-label="Edit"
                                onClick={() => setEditingManualEntries(prev => new Set([...prev, entry.id]))}
                                className="p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover rounded transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                              </button>
                              </Tooltip>
                              <ActionIconButton label="Remove" onClick={() => removeManualTimeEntry(entry.id)} tone="danger" size="sm">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </ActionIconButton>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    // Editing view
                    const chargeCodeOptions = [
                      { label: "None", value: "" },
                      ...chargeCodes.map(cc => ({ label: `${cc.code}: ${cc.name}`, value: cc.id })),
                    ];
                    const taskCodeOptions = [
                      { label: "None", value: "" },
                      ...TASK_CODES.map(tc => ({ label: `${tc.code}: ${tc.label}`, value: tc.code })),
                    ];
                    const activityCodeOptions = [
                      { label: "None", value: "" },
                      ...ACTIVITY_CODES.map(ac => ({ label: `${ac.code}: ${ac.label}`, value: ac.code })),
                    ];
                    const memberOptions = (matterData?.members || []).map(m => ({
                      label: m.name || m.email || m.userId,
                      value: m.userId,
                    }));
                    return (
                      <div key={entry.id} className="rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/10 p-3 space-y-2.5">
                        {/* Header */}
                        <div className="flex items-center justify-between">
                          <StatusBadge variant="info">Manual Entry</StatusBadge>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-on-surface">{formatCurrency(manualAmount)}</span>
                            <ActionIconButton label="Remove" onClick={() => removeManualTimeEntry(entry.id)} tone="danger" size="sm">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </ActionIconButton>
                          </div>
                        </div>

                        {/* Row 1: Member + Date */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Team Member</label>
                            <Dropdown
                              value={entry.userId || ""}
                              onChange={(val) => {
                                const member = matterData?.members?.find(m => m.userId === val);
                                updateManualTimeEntry(entry.id, "userId", val);
                                updateManualTimeEntry(entry.id, "userName", member?.name || member?.email || "Manual Entry");
                              }}
                              options={memberOptions}
                              placeholder="Select member"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Date</label>
                            <DatePicker
                              value={entry.date || ""}
                              onChange={(value) => updateManualTimeEntry(entry.id, "date", value)}
                              className="w-full"
                            />
                          </div>
                        </div>

                        {/* Row 2: Name */}
                        <div>
                          <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Entry Name</label>
                          <input
                            type="text"
                            value={entry.name || ""}
                            onChange={(e) => updateManualTimeEntry(entry.id, "name", e.target.value)}
                            placeholder="Document review, client call, drafting..."
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          />
                        </div>

                        {/* Row 3: Description */}
                        <div>
                          <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Description</label>
                          <textarea
                            value={entry.description || ""}
                            onChange={(e) => updateManualTimeEntry(entry.id, "description", e.target.value)}
                            placeholder="What work was done?"
                            rows={2}
                            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring resize-none"
                          />
                        </div>

                        {/* Row 4: Hours + Rate + Charge Code */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Time</label>
                            <div className="flex items-center gap-1.5">
                              <div className="relative flex-1">
                                <input
                                  type="number"
                                  value={entry.hours ? hoursToHm(entry.hours).h || "" : ""}
                                  onChange={(e) => updateManualTimeEntry(entry.id, "hours", hmToHours(e.target.value, hoursToHm(entry.hours).m))}
                                  placeholder="0"
                                  min="0"
                                  step="1"
                                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 pr-6 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-muted pointer-events-none">h</span>
                              </div>
                              <div className="relative flex-1">
                                <input
                                  type="number"
                                  value={entry.hours ? hoursToHm(entry.hours).m || "" : ""}
                                  onChange={(e) => updateManualTimeEntry(entry.id, "hours", hmToHours(hoursToHm(entry.hours).h, e.target.value))}
                                  placeholder="0"
                                  min="0"
                                  max="59"
                                  step="1"
                                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 pr-6 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-muted pointer-events-none">m</span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Rate ($/hr)</label>
                            <input
                              type="number"
                              value={entry.hourlyRate || ""}
                              onChange={(e) => updateManualTimeEntry(entry.id, "hourlyRate", parseFloat(e.target.value) || 0)}
                              placeholder="0.00"
                              min="0"
                              step="1"
                              className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">Charge Code</label>
                            <Dropdown
                              value={entry.chargeCodeId || ""}
                              onChange={(val) => {
                                updateManualTimeEntry(entry.id, "chargeCodeId", val || null);
                                if (val) {
                                  const cc = chargeCodes.find(c => c.id === val);
                                  if (cc?.defaultRate != null && !entry.hourlyRate) {
                                    updateManualTimeEntry(entry.id, "hourlyRate", cc.defaultRate);
                                  }
                                }
                              }}
                              options={chargeCodeOptions}
                              placeholder="None"
                            />
                          </div>
                        </div>

                        {/* Row 5: UTBMS Codes */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">UTBMS Task Code</label>
                            <Dropdown
                              value={entry.utbmsTaskCode || ""}
                              onChange={(val) => updateManualTimeEntry(entry.id, "utbmsTaskCode", val || null)}
                              options={taskCodeOptions}
                              placeholder="None"
                              searchable
                              searchPlaceholder="Search codes"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-on-surface-muted uppercase tracking-wide">UTBMS Activity Code</label>
                            <Dropdown
                              value={entry.utbmsActivityCode || ""}
                              onChange={(val) => updateManualTimeEntry(entry.id, "utbmsActivityCode", val || null)}
                              options={activityCodeOptions}
                              placeholder="None"
                              searchable
                              searchPlaceholder="Search codes"
                            />
                          </div>
                        </div>

                        {/* Done button */}
                        <div className="flex justify-end pt-1">
                          <Button
                            onClick={() => setEditingManualEntries(prev => { const next = new Set(prev); next.delete(entry.id); return next; })}
                            type="primary"
                            size="small"
                          >
                            Done
                          </Button>
                        </div>
                      </div>
                    );
                  }
                  const rate = getEntryRate(entry);
                  const amount = hourlyAmount(entry.hours, rate);
                  const isSelected = selectedTimeEntries.has(entry.id);
                  const preferredClientNames = (
                    entry.matterClientIds?.length
                      ? entry.matterClientIds
                      : entry.matterClientId
                        ? [entry.matterClientId]
                        : []
                  )
                    .map((matterClientId) => matterClientNameById.get(matterClientId) || null)
                    .filter((value): value is string => Boolean(value));
                  const preferredClientLabel =
                    preferredClientNames.length === 0
                      ? null
                      : preferredClientNames.length === 1
                        ? `Preferred client: ${preferredClientNames[0]}`
                        : `Preferred clients: ${preferredClientNames.join(", ")}`;
                  const preferredClientMatchesSelection = Boolean(
                    selectedClientId &&
                      (
                        entry.matterClientIds?.includes(selectedClientId) ||
                        entry.matterClientId === selectedClientId
                      ),
                  );

                  if (selectionMode === 'manual') {
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
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="text-sm font-medium text-on-surface">{entry.userName || 'Unknown'}</div>
                                {preferredClientLabel && (
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                      preferredClientMatchesSelection
                                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                        : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                    }`}
                                  >
                                    {preferredClientLabel}
                                  </span>
                                )}
                              </div>
                              {entry.name && (
                                <div className="mt-1 text-sm font-semibold text-on-surface">{entry.name}</div>
                              )}
                              <div className="mt-1 text-xs text-on-surface-muted">
                                {dayjs(entry.date).format('MMM DD, YYYY')} • {formatHoursMinutes(entry.hours)} @ {formatCurrency(rate)}/hr
                              </div>
                              {entry.description && (
                                <div className="mt-1 text-xs text-on-surface-secondary">{entry.description}</div>
                              )}
                            </div>
                            <div className="text-sm font-semibold text-on-surface">
                              {formatCurrency(amount)}
                            </div>
                          </div>
                        </div>
                      </label>
                    );
                  }

                  return (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-outline bg-surface-alt/40 p-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="text-sm font-medium text-on-surface">{entry.userName || 'Unknown'}</div>
                            <StatusBadge variant="success">Included</StatusBadge>
                            {preferredClientLabel && (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  preferredClientMatchesSelection
                                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                    : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                }`}
                              >
                                {preferredClientLabel}
                              </span>
                            )}
                          </div>
                          {entry.name && (
                            <div className="mt-1 text-sm font-semibold text-on-surface">{entry.name}</div>
                          )}
                          <div className="mt-1 text-xs text-on-surface-muted">
                            {dayjs(entry.date).format('MMM DD, YYYY')} • {formatHoursMinutes(entry.hours)} @ {formatCurrency(rate)}/hr
                          </div>
                          {entry.description && (
                            <div className="mt-1 text-xs text-on-surface-secondary">{entry.description}</div>
                          )}
                        </div>
                        <div className="text-sm font-semibold text-on-surface">
                          {formatCurrency(amount)}
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
              {visibleTimeEntries.length === 0 && !timeEntries.some(e => e.id.startsWith("manual-te-")) && (
                <p className="text-sm text-on-surface-muted text-center py-4">
                  {selectionMode === 'dateRange'
                    ? 'No time entries found in this date range for the selected members.'
                    : 'No time entries found for the selected members.'}
                </p>
              )}
            </div>
            <ShowMoreButton
              expanded={showAllTimeEntries}
              hiddenCount={loadedVisibleEntries.length - LIST_PREVIEW_LIMIT}
              onToggle={() => setShowAllTimeEntries(!showAllTimeEntries)}
            />
            <button
              onClick={addManualTimeEntry}
              className="mt-3 flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover transition-colors cursor-pointer"
            >
              + Add Time Entry
            </button>
          </div>

          {/* Recurring Retainer Section */}
          <CollapsibleSection
            title="Set Up Evergreen Retainer"
            description="Optional: create an auto-billing plan for this matter"
            summary={
              retainerSaved
                ? "Evergreen retainer created"
                : "Optional: create an auto-billing plan for this matter"
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
                      <input type="radio" value="matter_closed" checked={retainerEndCondition === "matter_closed"} onChange={() => setRetainerEndCondition("matter_closed")} className="accent-blue-600" />
                      <span className="text-sm text-on-surface">When matter is closed</span>
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
                    onClick={handleCreateRetainer}
                    type="secondary"
                    loading={savingRetainer}
                  >
                    Create Evergreen Retainer Plan
                  </Button>
                </div>
              </div>
            )}
          </CollapsibleSection>

          {invoiceMode === "split" && (
            <MatterSplitInvoiceComposer
              lawFirmId={lawFirmId}
              matterId={matterId}
              matterClients={matterClients}
              initialSelectedClientIds={preferredSplitClientIds}
              invoiceDate={invoiceDate}
              dueDate={dueDate}
              notes={notes}
              remitTo={remitTo}
              baseInvoiceName={invoiceName}
              baseInvoiceNumber={invoiceNumber}
              timeEntries={invoiceTimeEntries}
              flatFees={selectedFlatFeesList}
              onValidationError={setValidationError}
              onCreated={handleSplitInvoicesCreated}
            />
          )}
        </div>

        {/* Right Column - Summary */}
        <div className="lg:col-span-1">
          <div className="bg-surface rounded-lg shadow-sm border border-outline p-4 sm:p-6 sticky top-6">
            <h2 className="text-lg font-semibold text-on-surface mb-4">
              {invoiceMode === "split" ? "Split Source Summary" : "Invoice Summary"}
            </h2>

            {invoiceMode === "single" ? (
              <div className="space-y-4">
                <div>
                  <div className="text-sm text-on-surface-secondary mb-2">Selected Entries</div>
                  <div className="text-2xl font-bold text-on-surface">{selectedTimeEntries.size}</div>
                </div>

                <div className="border-t border-outline pt-4">
                  <div className="mb-4">
                    <CollapsibleList
                      items={Array.from(memberTotals.entries())}
                      previewLimit={LIST_PREVIEW_LIMIT}
                      expanded={showAllMemberTotals}
                      className="space-y-2"
                      renderItem={([userId, totals]) => {
                        const member = matterData?.members?.find(m => m.userId === userId);
                        return (
                          <div key={userId} className="flex justify-between text-sm">
                            <span className="text-on-surface-secondary">{member?.name || 'Unknown'}</span>
                            <span className="text-on-surface font-medium">
                              {formatHoursMinutes(totals.hours)} • {formatCurrency(totals.amount)}
                            </span>
                          </div>
                        );
                      }}
                    />
                    <ShowMoreButton
                      expanded={showAllMemberTotals}
                      hiddenCount={memberTotals.size - LIST_PREVIEW_LIMIT}
                      onToggle={() => setShowAllMemberTotals(!showAllMemberTotals)}
                    />
                  </div>

                  <div className="border-t border-outline pt-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-on-surface-secondary">Total Hours</span>
                      <span className="text-on-surface font-medium">{formatHoursMinutes(totalHours)}</span>
                    </div>
                    <div className="flex justify-between text-sm pt-2 border-t border-outline">
                      <span className="text-on-surface-secondary font-medium">Subtotal</span>
                      <span className="text-on-surface font-medium">{formatCurrency(totalAmount)}</span>
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

                {flatFeesAmount > 0 && (
                  <div className="border-t border-outline pt-4 mt-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-on-surface-secondary">Flat Fees:</span>
                      <span className="text-on-surface font-medium">{formatCurrency(flatFeesAmount)}</span>
                    </div>
                  </div>
                )}
                <Button
                  onClick={() => void handleSaveInvoice()}
                  type="primary"
                  className="w-full mt-4"
                  loading={savingInvoice}
                  disabled={
                    savingInvoice ||
                    (selectedTimeEntries.size === 0 && selectedFlatFees.size === 0) ||
                    totalAmount <= 0
                  }
                >
                  Generate Invoice
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Selected time entries</span>
                  <span className="text-on-surface font-medium">{selectedTimeEntries.size}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Selected flat fees</span>
                  <span className="text-on-surface font-medium">{selectedFlatFeesList.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Source hours</span>
                  <span className="text-on-surface font-medium">{formatHoursMinutes(totalHours)}</span>
                </div>
                <div className="flex justify-between text-lg font-bold text-on-surface pt-2 border-t border-outline">
                  <span>Source total</span>
                  <span>{formatCurrency(totalAmount)}</span>
                </div>
                <p className="text-xs text-on-surface-muted">
                  Use the split billing panel to choose recipients, allocate each item, and create separate invoices per client.
                </p>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
      <AddClientModal
        open={addClientModalOpen}
        onClose={() => setAddClientModalOpen(false)}
        lawFirmId={lawFirmId}
        matterId={matterId}
        existingMatterClientIds={matterClients.map((c) => c.id)}
        onAfter={async () => {
          const updated = await MattersService.listClients(lawFirmId, matterId);
          setMatterClients(updated || []);
          if (updated && updated.length > 0 && !selectedClientId) {
            setSelectedClientId(updated[0].id);
          }
        }}
      />
    </RequirePermission>
  );
}
