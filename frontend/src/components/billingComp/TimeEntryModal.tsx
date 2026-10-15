"use client";

import { TimeDateField, TimeDurationField, timeEntryDuration } from "@/components/billingComp/TimeEntryCore";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { useQueryClient } from "@tanstack/react-query";
import billingService from "@/services/billing.service";
import MattersService from "@/services/matters.service";
import { chargeCodesService } from "@/services/chargeCodes.service";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuth } from "@/hooks/useAuth";
import { useEntityByIds, type FullLookupItem } from "@/hooks/useEntityLookup";
import { useMountTransition, useResetAfterClose } from "@/hooks/useMountTransition";
import type { Matter, MatterClient, Client, User, BillingReadyItem, TimeEntry } from "@/types";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import type { ChargeCode } from "@/types/chargeCode";
import { TASK_CODES, ACTIVITY_CODES } from "@/lib/data/utbmsCodes";
import { formatHoursMinutes, hoursToHm } from "@/lib/utils/format";
import Checkbox from "@/components/ui/Checkbox";
import Tooltip from "@/components/ui/Tooltip";

import RateField from "./RateField";
import { buildRateOptions, rateSourceLabel, resolveRate } from "@/lib/billing/resolveRate";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { getTimeEntryContext, isTimeEntryLocked } from "./utils";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import { formatCurrency, hourlyAmount, hoursToHundredths } from "@/lib/utils/currency";
import { track } from "@/lib/analytics/analytics";

type TargetType = "matter" | "client";
type TargetValue = `matter:${string}` | `client:${string}`;

type ClientOption = Pick<Client, "id" | "name" | "email">;

const TARGET_TYPE_OPTIONS = [
  { value: "matter", label: "Matter" },
  { value: "client", label: "Client" },
];

function RequiredLabel({ children }: { children: string }) {
  return (
    <span>
      {children} <span aria-hidden="true">*</span>
    </span>
  );
}

export interface TimerPrefill {
  hours?: number;
  matterId?: string | null;
  clientId?: string | null;
  userId?: string | null;
  date?: string | null;
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  sourceEventId?: string | null;
  sourceEventTitle?: string | null;
  /**
   * The billing scope the source task belongs to, used to decide whether a target
   * the user picks is still compatible with the link. A task with no matter and no
   * clients has no scope of its own, so any target keeps the link.
   */
  sourceMatterId?: string | null;
  sourceClientIds?: string[] | null;
}

interface ClientBillingRates {
  defaultRate?: number | null;
  memberRates?: Record<string, number>;
}

interface TimeEntryModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  users: User[];
  chargeCodes: ChargeCode[];
  defaultUserId?: string | null;
  defaultTarget?: TargetValue;
  /**
   * Opened from one client's own page: the entry belongs to that client either
   * way, so the client side is fixed to them and the matter side offers only the
   * matters they are on. Without it the picker browses the whole firm, which is
   * how time logged from a client page ends up on someone else's matter.
   */
  scopeClientId?: string | null;
  /**
   * Opened from one matter's own page/tab: scopes client choices to clients
   * connected to this matter, and matter choices to matters of the same client.
   */
  scopeMatterId?: string | null;
  prefill?: TimerPrefill | null;
  /**
   * An existing entry to edit. Its presence is what puts the modal in edit mode:
   * the same form serves both, because a time entry has the same fields however
   * it came to exist. Only the member is pinned, since re-attributing recorded
   * work to someone else is a different operation from correcting it.
   */
  entry?: EnrichedTimeEntry | null;
  /** Map of clientId → billing rates for rate resolution */
  clientBillingRatesMap?: Record<string, ClientBillingRates>;
  /** Map of userId → default hourly rate for firm members */
  memberDefaultRates?: Record<string, number>;
  /** Firm-level default billing rate */
  firmDefaultRate?: number | null;
  /** Whether UTBMS codes are enabled in firm settings */
  utbmsEnabled?: boolean;
  onSuccess: (result?: {
    createdEntry: TimeEntry;
    shouldBillNow: boolean;
    draftItem?: BillingReadyItem;
  }) => void;
}

export default function TimeEntryModal({
  open,
  onClose,
  lawFirmId,
  users,
  chargeCodes,
  defaultUserId,
  defaultTarget,
  scopeClientId,
  scopeMatterId,
  prefill,
  entry,
  clientBillingRatesMap,
  memberDefaultRates,
  firmDefaultRate,
  utbmsEnabled,
  onSuccess,
}: TimeEntryModalProps) {
  const fieldIds = useId();
  // Derive firm default rate and member default rates from context/props when not explicitly passed
  const { settings: _firmSettings } = useFirmSettings();
  const effectiveFirmDefaultRate = firmDefaultRate ?? _firmSettings?.billing?.defaultRate ?? null;
  const effectiveMemberDefaultRates = useMemo(() => {
    if (memberDefaultRates) return memberDefaultRates;
    const map: Record<string, number> = {};
    users.forEach((u) => {
      if (typeof u.defaultHourlyRate === "number") map[u.uid] = u.defaultHourlyRate;
    });
    return Object.keys(map).length > 0 ? map : undefined;
  }, [memberDefaultRates, users]);
  // "Bill this now" opens the invoice composer, which needs this permission.
  const { hasPermission } = usePermissions();
  const canManageInvoices = hasPermission("billing.manageInvoices");
  // Logging time in another member's name needs billing.manageOthersTimeEntries;
  // without it a new entry can only be the viewer's own. An edit keeps the
  // entry's member as it is, so it is never narrowed.
  const canLogForOthers = hasPermission("billing.manageOthersTimeEntries");
  // The charge-code list is read with billing.viewRates. Without it the list is
  // empty and the quick-create and edit actions would be refused, so the whole
  // picker is left out rather than offering only "No charge code".
  const canViewRates = hasPermission("billing.viewRates");
  const { user: authUser } = useAuth();
  const effectiveUtbmsEnabled = utbmsEnabled ?? _firmSettings?.billing?.utbmsEnabled ?? false;

  // The entry is filed against one matter or one client. The type picker chooses
  // which entity is being searched; the id combines with it into the
  // `matter:<id>` / `client:<id>` value the save handler splits apart.
  const [targetType, setTargetType] = useState<TargetType>(
    defaultTarget?.startsWith("client:") ? "client" : "matter",
  );
  const [targetId, setTargetId] = useState(defaultTarget ? defaultTarget.split(":")[1] : "");
  // The record behind the current selection, handed over by the picker so a fresh
  // pick resolves without waiting on a round-trip. Prefilled targets never pass
  // through the picker, so `resolvedTargetItems` below covers those.
  const [targetItem, setTargetItem] = useState<FullLookupItem | null>(null);
  const selectedTarget: TargetValue | "" = targetId ? `${targetType}:${targetId}` : "";
  const [selectedUser, setSelectedUser] = useState(defaultUserId || "");
  const [selectedChargeCodeId, setSelectedChargeCodeId] = useState("");
  const [selectedMatterClientIds, setSelectedMatterClientIds] = useState<string[]>([]);
  const [utbmsTaskCode, setUtbmsTaskCode] = useState("");
  const [utbmsActivityCode, setUtbmsActivityCode] = useState("");
  const [showUtbms, setShowUtbms] = useState(false);
  const [hoursInput, setHoursInput] = useState("1");
  const [minutesInput, setMinutesInput] = useState("");
  const [hourlyRateInput, setHourlyRateInput] = useState("");
  const [hasManualRate, setHasManualRateState] = useState(false);
  // Mirrors `hasManualRate` synchronously. The prefill and edit effects mark a rate
  // manual in the same commit the rate-sync effect runs, when the state value that
  // effect closes over is still the stale `false`; the ref lets it see the change
  // and leave the seeded rate alone instead of overwriting it with the ladder rate.
  const hasManualRateRef = useRef(false);
  const setHasManualRate = useCallback((manual: boolean) => {
    hasManualRateRef.current = manual;
    setHasManualRateState(manual);
  }, []);
  const [date, setDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceTaskId, setSourceTaskId] = useState<string | null>(null);
  const [sourceTaskTitle, setSourceTaskTitle] = useState<string | null>(null);
  const [sourceEventId, setSourceEventId] = useState<string | null>(null);
  const [sourceEventTitle, setSourceEventTitle] = useState<string | null>(null);
  const [sourceMatterId, setSourceMatterId] = useState<string | null>(null);
  const [sourceClientIds, setSourceClientIds] = useState<string[]>([]);
  const [billable, setBillable] = useState(true);
  const [billNow, setBillNow] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matterClientsByMatter, setMatterClientsByMatter] = useState<Record<string, MatterClient[]>>({});
  const [matterClientsLoading, setMatterClientsLoading] = useState(false);

  // quick-create / edit charge code
  const queryClient = useQueryClient();
  const [showChargeCodeQuickCreate, setShowChargeCodeQuickCreate] = useState(false);
  const [quickChargeCode, setQuickChargeCode] = useState("");
  const [quickChargeCodeName, setQuickChargeCodeName] = useState("");
  const [quickChargeCodeRate, setQuickChargeCodeRate] = useState("");
  const [quickChargeCodeCreating, setQuickChargeCodeCreating] = useState(false);
  const [quickChargeCodeError, setQuickChargeCodeError] = useState<string | null>(null);
  useResetAfterClose(showChargeCodeQuickCreate, () => setQuickChargeCodeError(null));

  const [showChargeCodeEdit, setShowChargeCodeEdit] = useState(false);
  const [editChargeCodeName, setEditChargeCodeName] = useState("");
  const [editChargeCodeRate, setEditChargeCodeRate] = useState("");
  const [editChargeCodeSaving, setEditChargeCodeSaving] = useState(false);
  const [editChargeCodeError, setEditChargeCodeError] = useState<string | null>(null);
  useResetAfterClose(showChargeCodeEdit, () => setEditChargeCodeError(null));

  const [editChargeCodeCode, setEditChargeCodeCode] = useState("");

  const openChargeCodeEdit = () => {
    const cc = chargeCodes.find((c) => c.id === selectedChargeCodeId);
    if (!cc) return;
    setEditChargeCodeCode(cc.code);
    setEditChargeCodeName(cc.name);
    setEditChargeCodeRate(cc.defaultRate != null ? String(cc.defaultRate) : "");
    setEditChargeCodeError(null);
    setShowChargeCodeEdit(true);
  };

  const handleChargeCodeEdit = async () => {
    if (!editChargeCodeName.trim()) return;
    setEditChargeCodeSaving(true);
    setEditChargeCodeError(null);
    try {
      const parsedRate = editChargeCodeRate.trim() ? parseFloat(editChargeCodeRate) : null;
      if (parsedRate !== null && (isNaN(parsedRate) || parsedRate < 0)) {
        setEditChargeCodeError("Invalid rate value");
        setEditChargeCodeSaving(false);
        return;
      }
      await billingService.updateChargeCode(lawFirmId, selectedChargeCodeId, {
        code: editChargeCodeCode.trim().toUpperCase(),
        name: editChargeCodeName.trim(),
        defaultRate: parsedRate,
      });
      await queryClient.invalidateQueries({ queryKey: ["chargeCodes", lawFirmId] });
      setShowChargeCodeEdit(false);
    } catch (e: any) {
      setEditChargeCodeError(e?.message || "Failed to update charge code");
    } finally {
      setEditChargeCodeSaving(false);
    }
  };

  const handleChargeCodeQuickCreate = async () => {
    if (!quickChargeCode.trim() || !quickChargeCodeName.trim()) return;
    setQuickChargeCodeCreating(true);
    setQuickChargeCodeError(null);
    try {
      const parsedRate = quickChargeCodeRate.trim() ? parseFloat(quickChargeCodeRate) : null;
      if (parsedRate !== null && isNaN(parsedRate)) {
        setQuickChargeCodeError("Invalid rate value");
        setQuickChargeCodeCreating(false);
        return;
      }
      const result = await chargeCodesService.createChargeCode(lawFirmId, {
        code: quickChargeCode.trim().toUpperCase(),
        name: quickChargeCodeName.trim(),
        defaultRate: parsedRate,
      });
      await queryClient.invalidateQueries({ queryKey: ["chargeCodes", lawFirmId] });
      setSelectedChargeCodeId(result.chargeCodeId);
      setShowChargeCodeQuickCreate(false);
      setQuickChargeCode("");
      setQuickChargeCodeName("");
      setQuickChargeCodeRate("");
    } catch (e: any) {
      setQuickChargeCodeError(e?.message || "Failed to create charge code");
    } finally {
      setQuickChargeCodeCreating(false);
    }
  };

  const { total: totalHours, valid: durationIsValid } = timeEntryDuration(hoursInput, minutesInput);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to props when the modal opens
    setSelectedUser(defaultUserId || "");
    if (defaultTarget) {
      const [type, entityId] = defaultTarget.split(":") as [TargetType, string];
      setTargetType(type);
      setTargetId(entityId);
      setTargetItem(null);
    }
  }, [defaultUserId, defaultTarget, open]);

  const isEdit = Boolean(entry);
  const entryLocked = entry ? isTimeEntryLocked(entry) : false;
  // Moving recorded time onto one of the client's matters. The API supports this
  // one direction only (client-logged entry to a matter), so it is offered as its
  // own field rather than by unlocking the target picker, which would advertise
  // moves the server will refuse. This used to live in the invoice composer,
  // where re-filing an entry happened as a side effect of billing it.
  const [moveToMatterId, setMoveToMatterId] = useState("");
  const canMoveToMatter = Boolean(entry && !entry.matterId && entry.clientId && !entryLocked);

  useEffect(() => {
    if (!open || !entry) return;
    const { h: wholeHours, m: mins } = hoursToHm(entry.hours);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the form from the entry being edited
    setTargetType(entry.matterId ? "matter" : "client");
    setTargetId(entry.matterId || entry.clientId || entry.entityId || "");
    setTargetItem(null);
    setSelectedUser(entry.userId || "");
    setSelectedChargeCodeId(entry.chargeCodeId || "");
    setSelectedMatterClientIds(entry.matterClientIds || []);
    setUtbmsTaskCode(entry.utbmsTaskCode || "");
    setUtbmsActivityCode(entry.utbmsActivityCode || "");
    setShowUtbms(Boolean(entry.utbmsTaskCode || entry.utbmsActivityCode));
    setHoursInput(wholeHours > 0 ? String(wholeHours) : "");
    setMinutesInput(mins > 0 ? String(mins) : "");
    setHourlyRateInput(typeof entry.hourlyRate === "number" ? String(entry.hourlyRate) : "");
    setHasManualRate(typeof entry.hourlyRate === "number");
    setDate(entry.date ? dayjs(entry.date).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD"));
    setName(entry.name || "");
    setDescription(entry.description || "");
    setSourceTaskId(entry.sourceTaskId || null);
    setSourceTaskTitle(entry.sourceTaskTitle || null);
    setSourceEventId(entry.sourceEventId || null);
    setSourceEventTitle(entry.sourceEventTitle || null);
    setBillable(entry.billable !== false);
    setBillNow(false);
    setMoveToMatterId("");
    setError(null);
  }, [open, entry, setHasManualRate]);

  const clearSource = useCallback(() => {
    setSourceTaskId(null);
    setSourceTaskTitle(null);
    setSourceEventId(null);
    setSourceEventTitle(null);
    setSourceMatterId(null);
    setSourceClientIds([]);
  }, []);

  /**
   * Whether the linked task/event can still be recorded under `target`.
   *
   * An event only ever belongs to its own matter. A task belongs to its matter, or
   * to its clients when it has no matter; a task with neither is unscoped and rides
   * along with whatever target the user picks. This mirrors the server-side check
   * in timeEntries.service resolveSourceMetadata, so the UI never keeps a link the
   * API is about to reject, nor drops one the API would have accepted.
   */
  function sourceFitsTarget(target: TargetValue): boolean {
    const [type, entityId] = target.split(":") as ["matter" | "client", string];
    if (sourceEventId) return type === "matter" && entityId === sourceMatterId;
    if (!sourceTaskId) return false;
    if (sourceMatterId) return type === "matter" && entityId === sourceMatterId;
    if (sourceClientIds.length > 0) return type === "client" && sourceClientIds.includes(entityId);
    return true;
  }

  // Prefill from timer/task/event data when provided
  useEffect(() => {
    if (!open || !prefill) return;
    const {
      hours,
      matterId,
      clientId,
      userId,
      date: prefillDate,
      name: prefillName,
      description: prefillDescription,
      hourlyRate,
      chargeCodeId,
      sourceTaskId: nextSourceTaskId,
      sourceTaskTitle: nextSourceTaskTitle,
      sourceEventId: nextSourceEventId,
      sourceEventTitle: nextSourceEventTitle,
      sourceMatterId: nextSourceMatterId,
      sourceClientIds: nextSourceClientIds,
    } = prefill;

    if (typeof hours === "number" && Number.isFinite(hours)) {
      const { h, m } = hoursToHm(hours);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prefills form fields from prefill prop when the modal opens
      setHoursInput(h > 0 ? String(h) : "");
      setMinutesInput(m > 0 ? String(m) : "");
    }

    if (prefillDate) {
      setDate(dayjs(prefillDate).format("YYYY-MM-DD"));
    }

    if (prefillName) setName(prefillName);
    if (prefillDescription) setDescription(prefillDescription);
    if (userId) setSelectedUser(userId);
    if (typeof hourlyRate === "number") {
      setHourlyRateInput(String(hourlyRate));
      setHasManualRate(true);
    }

    if (chargeCodeId) setSelectedChargeCodeId(chargeCodeId);
    if (nextSourceTaskId) {
      setSourceTaskId(nextSourceTaskId);
      setSourceTaskTitle(nextSourceTaskTitle || null);
      setSourceEventId(null);
      setSourceEventTitle(null);
      setSourceMatterId(nextSourceMatterId || null);
      setSourceClientIds(nextSourceClientIds || []);
    } else if (nextSourceEventId) {
      setSourceTaskId(null);
      setSourceTaskTitle(null);
      setSourceEventId(nextSourceEventId);
      setSourceEventTitle(nextSourceEventTitle || null);
      setSourceMatterId(nextSourceMatterId || null);
      setSourceClientIds([]);
    } else {
      clearSource();
    }

    if (matterId) {
      setTargetType("matter");
      setTargetId(matterId);
      setTargetItem(null);
    } else if (clientId) {
      setTargetType("client");
      setTargetId(clientId);
      setTargetItem(null);
    }
  }, [open, prefill, clearSource, setHasManualRate]);

  const selectedTargetParts = useMemo(
    () => (targetId ? { type: targetType, entityId: targetId } : null),
    [targetType, targetId],
  );

  // `full` so the selection carries the whole record: the member list, the
  // matter's clients, and the names the bill-now draft is built from all come off
  // it, none of which a slim picker row holds.
  const targetIds = useMemo(() => (targetId ? [targetId] : []), [targetId]);
  const { items: resolvedTargetItems } = useEntityByIds<FullLookupItem>(
    targetType === "matter" ? "matters" : "clients",
    lawFirmId,
    targetIds,
    { full: true },
  );

  const targetRecord = useMemo(() => {
    if (targetItem && targetItem.id === targetId) return targetItem;
    return resolvedTargetItems.find((item) => item.id === targetId) ?? null;
  }, [targetItem, targetId, resolvedTargetItems]);

  const selectedMatter = useMemo(
    () => (selectedTargetParts?.type === "matter" ? (targetRecord as unknown as Matter | null) : null),
    [selectedTargetParts?.type, targetRecord],
  );

  const selectedClient = useMemo(
    () => (selectedTargetParts?.type === "client" ? (targetRecord as unknown as ClientOption | null) : null),
    [selectedTargetParts?.type, targetRecord],
  );

  const selectedMatterClients = useMemo(() => {
    if (!selectedMatter) return [];
    return matterClientsByMatter[selectedMatter.id] || selectedMatter.clients || [];
  }, [matterClientsByMatter, selectedMatter]);

  const effectiveSelectedMatterClientIds = useMemo(() => {
    if (selectedTargetParts?.type !== "matter") return [];
    const validIds = selectedMatterClientIds.filter((matterClientId) =>
      selectedMatterClients.some((matterClient) => matterClient.id === matterClientId),
    );
    if (validIds.length > 0) return Array.from(new Set(validIds));
    if (selectedMatterClients.length === 1) {
      return [selectedMatterClients[0].id];
    }
    return [];
  }, [selectedMatterClientIds, selectedMatterClients, selectedTargetParts?.type]);

  const effectiveSelectedMatterClients = useMemo(() => {
    if (effectiveSelectedMatterClientIds.length === 0) return [];
    const selectedIds = new Set(effectiveSelectedMatterClientIds);
    return selectedMatterClients.filter((matterClient) => selectedIds.has(matterClient.id));
  }, [effectiveSelectedMatterClientIds, selectedMatterClients]);

  const effectiveSelectedMatterClient = useMemo(() => {
    if (effectiveSelectedMatterClients.length !== 1) return null;
    return effectiveSelectedMatterClients[0];
  }, [effectiveSelectedMatterClients]);

  const effectiveScopeMatterId = useMemo(() => {
    return scopeMatterId || prefill?.sourceMatterId || prefill?.matterId || entry?.matterId || null;
  }, [scopeMatterId, prefill?.sourceMatterId, prefill?.matterId, entry?.matterId]);

  const shouldShowBillingClientPicker = selectedTargetParts?.type === "matter" && selectedMatterClients.length > 1;

  useEffect(() => {
    if (!open || !lawFirmId || selectedTargetParts?.type !== "matter" || !selectedMatter?.id) return;
    if (matterClientsByMatter[selectedMatter.id]) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for an async data fetch
    setMatterClientsLoading(true);

    void MattersService.listClients(lawFirmId, selectedMatter.id)
      .then((matterClients) => {
        if (cancelled) return;
        setMatterClientsByMatter((prev) => ({ ...prev, [selectedMatter.id]: matterClients || [] }));
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (!cancelled) setMatterClientsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [matterClientsByMatter, lawFirmId, open, selectedMatter?.id, selectedTargetParts?.type]);

  useEffect(() => {
    if (selectedTargetParts?.type !== "matter") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reconciles selected client ids against async-fetched matter clients
      setSelectedMatterClientIds([]);
      return;
    }

    setSelectedMatterClientIds((prev) => {
      const validIds = prev.filter((matterClientId) => selectedMatterClients.some((matterClient) => matterClient.id === matterClientId));
      if (validIds.length > 0) {
        return Array.from(new Set(validIds));
      }
      return selectedMatterClients.map((matterClient) => matterClient.id);
    });
  }, [selectedMatterClients, selectedTargetParts?.type]);

  const memberOptions = useMemo(() => {
    const ownOnly = !isEdit && !canLogForOthers;
    const ownUid = authUser?.uid ?? null;
    if (selectedTargetParts?.type === "matter") {
      return (selectedMatter?.members || [])
        .filter((member) => !ownOnly || member.userId === ownUid)
        .map((member) => ({
          value: member.userId,
          label: member.name || "Unknown",
        }));
    }
    return users
      .filter((user) => !ownOnly || user.uid === ownUid)
      .map((user) => ({
        value: user.uid || "",
        label: user.name || user.email || "Unknown",
      }));
  }, [selectedMatter?.members, selectedTargetParts?.type, users, isEdit, canLogForOthers, authUser?.uid]);

  // Fetch client billing rates when target changes (if not passed via prop)
  const [fetchedClientRates, setFetchedClientRates] = useState<Record<string, ClientBillingRates>>({});
  useEffect(() => {
    if (clientBillingRatesMap || !lawFirmId) return;
    // Determine which client ID to fetch for
    let clientId: string | null = null;
    if (selectedTargetParts?.type === "client") {
      clientId = selectedTargetParts.entityId;
    } else if (selectedTargetParts?.type === "matter") {
      // The billing-rates endpoint resolves a client by its UUID (`clients.id`),
      // NOT the linked portal user's Firebase UID, use the matter client's `id`.
      clientId = effectiveSelectedMatterClient?.id || null;
    }
    if (!clientId || fetchedClientRates[clientId]) return;
    (async () => {
      try {
        const { default: clientsService } = await import("@/services/clients.service");
        const result = await clientsService.getClientBillingRates(lawFirmId, clientId!);
        if (result.billingRates && (result.billingRates.defaultRate != null || (result.billingRates.memberRates && Object.keys(result.billingRates.memberRates).length > 0))) {
          setFetchedClientRates((prev) => ({ ...prev, [clientId!]: result.billingRates }));
        }
      } catch { /* client may not have billing rates */ }
    })();
  }, [clientBillingRatesMap, effectiveSelectedMatterClient?.id, fetchedClientRates, lawFirmId, selectedTargetParts]);

  // Fetch linked company relationships when scopeClientId is present
  const [scopedClientOrgIds, setScopedClientOrgIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !lawFirmId || !scopeClientId) return;
    let cancelled = false;
    (async () => {
      try {
        const { default: clientsService } = await import("@/services/clients.service");
        const rels = await clientsService.listClientCompanyRelationships(lawFirmId, scopeClientId);
        if (cancelled) return;
        const orgIds = rels.map((r) => r.companyClientId).filter(Boolean);
        setScopedClientOrgIds(orgIds);
      } catch {
        if (!cancelled) setScopedClientOrgIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lawFirmId, open, scopeClientId]);

  const scopedClientIds = useMemo(() => {
    if (!scopeClientId) return undefined;
    const set = new Set([scopeClientId, ...scopedClientOrgIds]);
    return Array.from(set);
  }, [scopeClientId, scopedClientOrgIds]);

  // Resolve the billing client rates for the currently selected target
  const effectiveClientRatesMap = clientBillingRatesMap || fetchedClientRates;
  const activeClientBillingRates = useMemo(() => {
    if (selectedTargetParts?.type === "client") {
      return effectiveClientRatesMap[selectedTargetParts.entityId] || null;
    }
    if (selectedTargetParts?.type === "matter") {
      const billingClientId = effectiveSelectedMatterClient?.id || null;
      return billingClientId ? effectiveClientRatesMap[billingClientId] || null : null;
    }
    return null;
  }, [effectiveClientRatesMap, effectiveSelectedMatterClient?.id, selectedTargetParts]);

  // 8-tier rate resolution matching Clio hierarchy
  // Inputs to the firm's one rate ladder. `selectedTargetParts` gates the matter
  // tier: an entry filed against a client directly has no matter member rate, and
  // passing the previously-picked matter's members would price it from a matter
  // this entry is not on.
  const ladderInputs = useMemo(
    () => ({
      entry: { userId: selectedUser },
      matterMembers: selectedTargetParts?.type === "matter" ? selectedMatter?.members || null : null,
      clientBillingRates: activeClientBillingRates || null,
      chargeCode: chargeCodes.find((code) => code.id === selectedChargeCodeId) || null,
      memberDefaultRates: effectiveMemberDefaultRates || null,
      firmDefaultRate: effectiveFirmDefaultRate,
    }),
    [
      selectedUser,
      selectedTargetParts,
      selectedMatter?.members,
      activeClientBillingRates,
      chargeCodes,
      selectedChargeCodeId,
      effectiveMemberDefaultRates,
      effectiveFirmDefaultRate,
    ],
  );

  const { rate: resolvedRate, source: rateSource } = useMemo(
    () => resolveRate(ladderInputs),
    [ladderInputs],
  );

  const availableRates = useMemo(() => buildRateOptions(ladderInputs), [ladderInputs]);

  useEffect(() => {
    if (!open || hasManualRate || hasManualRateRef.current) return;
    // Syncs the user-editable rate field to the resolved rate until manually overridden.
    setHourlyRateInput(typeof resolvedRate === "number" ? String(resolvedRate) : "");
  }, [open, hasManualRate, resolvedRate]);

  const effectiveHourlyRate = useMemo(() => {
    const parsed = parseFloat(hourlyRateInput);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return null;
  }, [hourlyRateInput]);

  // Priced the way the row is stored: `activities.hours` keeps hundredths of an
  // hour and `amount_cents` is generated from that, so 1h20m previews as 1.33h.
  // Pricing the unrounded minutes / 60 showed a different amount than the entry
  // (and a bill-now draft line) would carry.
  const previewAmount = useMemo(() => {
    if (effectiveHourlyRate === null || !Number.isFinite(totalHours) || totalHours <= 0) return null;
    return hourlyAmount(totalHours, effectiveHourlyRate);
  }, [effectiveHourlyRate, totalHours]);
  // One hour is prefilled for convenience, but that should not look like a
  // validation attempt before the user has chosen enough context to resolve a
  // rate. Only surface the amber missing-rate state once both required
  // selections are present.
  const shouldWarnMissingRate =
    selectedTargetParts !== null &&
    selectedUser.length > 0 &&
    durationIsValid &&
    effectiveHourlyRate === null;

  // `Modal` owns the dialog's own mount/exit animation. This mirrors its timing
  // for one reason: to skip building this form's large tree while the modal is
  // closed. TimeEntryModal is rendered on seven screens, so an always-built
  // body would be re-created on every one of their renders.
  const { mounted } = useMountTransition(open, 100);

  /**
   * Put the form back the way it opens fresh, once the modal is off screen.
   * Restores the caller's defaults rather than a blank form, so reopening on a
   * client or matter page lands on that target again.
   */
  useResetAfterClose(open, () => {
    setTargetType(defaultTarget?.startsWith("client:") ? "client" : "matter");
    setTargetId(defaultTarget ? defaultTarget.split(":")[1] : "");
    setTargetItem(null);
    setSelectedUser(defaultUserId || "");
    setSelectedChargeCodeId("");
    setSelectedMatterClientIds([]);
    setUtbmsTaskCode("");
    setUtbmsActivityCode("");
    setShowUtbms(false);
    setHoursInput("1");
    setMinutesInput("");
    setHourlyRateInput("");
    setHasManualRate(false);
    setDate(dayjs().format("YYYY-MM-DD"));
    setName("");
    setDescription("");
    clearSource();
    setBillable(true);
    setBillNow(false);
    setMoveToMatterId("");
    setError(null);
  });

  const closeChargeCodeQuickCreate = useCallback(() => {
    if (quickChargeCodeCreating) return;
    setShowChargeCodeQuickCreate(false);
  }, [quickChargeCodeCreating]);
  const closeChargeCodeEdit = useCallback(() => {
    if (editChargeCodeSaving) return;
    setShowChargeCodeEdit(false);
  }, [editChargeCodeSaving]);

  if (!mounted) return null;

  /**
   * Point the entry at whoever the picked target implies. A matter only bills to
   * its own members, so a default user who isn't one is dropped rather than saved
   * against a matter they don't belong to; a client has no member list to fail.
   */
  function applyUserForTarget(type: TargetType, item: FullLookupItem | null) {
    if (!defaultUserId) {
      setSelectedUser("");
      return;
    }
    if (type === "matter") {
      const members = (item?.members as { userId?: string }[] | undefined) || [];
      setSelectedUser(members.some((m) => m.userId === defaultUserId) ? defaultUserId : "");
    } else {
      setSelectedUser(defaultUserId);
    }
  }

  function handleTargetIdChange(nextId: string) {
    setTargetId(nextId);
    setSelectedMatterClientIds([]);
    // Only drop the link when the new target genuinely doesn't fit. Clearing it
    // unconditionally meant every task without a matter lost its link the moment
    // the user picked where to bill it, which is the one case that needs it most.
    if (nextId && !sourceFitsTarget(`${targetType}:${nextId}` as TargetValue)) clearSource();
  }

  function handleTargetTypeChange(nextType: TargetType) {
    setTargetType(nextType);
    // Scoped to one client, the client side has exactly one answer, so switching
    // back to it re-selects them instead of leaving the field empty.
    setTargetId(nextType === "client" && scopeClientId ? scopeClientId : "");
    setTargetItem(null);
    setSelectedUser(defaultUserId || "");
    setSelectedMatterClientIds([]);
    // The link survives switching sides: whichever target is picked next is
    // re-checked against it by handleTargetIdChange.
  }

  // Closing mid-save would leave a failure to land in a dialog that has already
  // gone, and the reset that runs after close would race it.
  function handleClose() {
    if (!updating) onClose();
  }

  async function handleSave() {
    if (!selectedTargetParts) {
      setError(
        sourceTaskTitle
          ? "This task isn't linked to a matter or client, so pick where the time should bill."
          : "Select a matter or client.",
      );
      return;
    }
    if (!selectedUser) {
      setError("Select a team member.");
      return;
    }
    if (!durationIsValid) {
      setError("Enter valid hours.");
      return;
    }
    if (!date) {
      setError("Select a date.");
      return;
    }

    setUpdating(true);
    setError(null);

    try {
      const context =
        selectedTargetParts.type === "matter"
          ? { type: "matter" as const, lawFirmId, entityId: selectedTargetParts.entityId }
          : { type: "client" as const, lawFirmId, entityId: selectedTargetParts.entityId };

      if (entry) {
        // The form shows whole minutes, so a stored duration that is not a whole
        // minute (0.04h is 2.4 minutes) reads back as a different value. Hours are
        // sent only when the duration fields no longer show what was seeded, so
        // editing anything else never re-prices the entry; the API leaves an
        // omitted field as stored.
        const seeded = hoursToHm(entry.hours);
        const durationChanged =
          totalHours !== timeEntryDuration(String(seeded.h), String(seeded.m)).total;
        // The API keys an update by the context the entry is filed under today,
        // so this addresses the original one even when `moveToMatterId` is about
        // to move the entry somewhere else.
        const updated = await billingService.updateTimeEntry(
          getTimeEntryContext(lawFirmId, entry),
          entry.id,
          {
            ...(durationChanged ? { hours: totalHours } : {}),
            date,
            name: name.trim(),
            description: description.trim(),
            hourlyRate: effectiveHourlyRate,
            chargeCodeId: selectedChargeCodeId || null,
            utbmsTaskCode: utbmsTaskCode || null,
            utbmsActivityCode: utbmsActivityCode || null,
            billable,
            ...(selectedTargetParts.type === "matter"
              ? {
                  matterClientId:
                    effectiveSelectedMatterClientIds.length === 1
                      ? effectiveSelectedMatterClientIds[0]
                      : null,
                  matterClientIds: effectiveSelectedMatterClientIds,
                }
              : {}),
            ...(moveToMatterId ? { matterId: moveToMatterId } : {}),
          },
        );

        handleClose();
        onSuccess({ createdEntry: updated, shouldBillNow: false });
        return;
      }

      const createdEntry = await billingService.createTimeEntry(context, {
        userId: selectedUser,
        hours: totalHours,
        // Day-only: send the raw YYYY-MM-DD; toISOString() shifts it a day for UTC+ users.
        date,
        matterClientId: selectedTargetParts.type === "matter" && effectiveSelectedMatterClientIds.length === 1 ? effectiveSelectedMatterClientIds[0] : null,
        matterClientIds: selectedTargetParts.type === "matter" ? effectiveSelectedMatterClientIds : null,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        hourlyRate: effectiveHourlyRate,
        chargeCodeId: selectedChargeCodeId || null,
        sourceTaskId,
        sourceEventId,
        utbmsTaskCode: utbmsTaskCode || null,
        utbmsActivityCode: utbmsActivityCode || null,
        billable,
      });
      track("time_entry_created", {
        target_type: selectedTargetParts.type,
        billable,
        bill_now: billNow,
        has_charge_code: Boolean(selectedChargeCodeId),
        from_task: Boolean(sourceTaskId),
        from_event: Boolean(sourceEventId),
      });

      let draftItem: BillingReadyItem | undefined;
      if (billNow) {
        draftItem = {
          id: createdEntry.id,
          itemType: "time_entry",
          contextType: selectedTargetParts.type,
          entityId: selectedTargetParts.entityId,
          matterId: selectedTargetParts.type === "matter" ? selectedTargetParts.entityId : null,
          matterName: selectedMatter?.name || null,
          matterClientId:
            selectedTargetParts.type === "matter" && effectiveSelectedMatterClientIds.length === 1
              ? effectiveSelectedMatterClientIds[0]
              : null,
          matterClientIds: selectedTargetParts.type === "matter" ? effectiveSelectedMatterClientIds : null,
          // A clients.id, which is what `clientId` means on every other billing
          // surface. This carried the client's portal userId, so the draft
          // composer could seed its billed-client field with an id no client
          // record matches and quietly produce an invoice billed to nobody.
          clientId:
            selectedTargetParts.type === "client"
              ? selectedTargetParts.entityId
              : effectiveSelectedMatterClient?.id || null,
          clientName:
            selectedTargetParts.type === "client"
              ? (selectedClient?.name || selectedClient?.email || selectedClient?.id || null)
              // Only set when the matter has exactly one client, so this is that
              // client rather than a guess between several.
              : effectiveSelectedMatterClient?.name || effectiveSelectedMatterClient?.email || null,
          description: name.trim() || description.trim() || "Time entry",
          amount: previewAmount ?? undefined,
          // The hundredths an entry stores and `previewAmount` is priced on, so
          // the line's hours multiply out to its amount.
          hours: hoursToHundredths(totalHours) / 100,
          date: createdEntry.date,
          timeEntryId: createdEntry.id,
        };
      }

      handleClose();
      onSuccess({
        createdEntry,
        shouldBillNow: billNow,
        draftItem,
      });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add time entry"));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title={isEdit ? "Edit Time Entry" : "Log Billable Hours"}
      subtitle={
        isEdit
          ? "Correct the recorded time, its rate, or what it bills toward."
          : "Capture time for a matter, task, event, or client and bill it immediately when needed."
      }
      size="5xl"
      lockScroll
      dismissible={!updating}
      bodyClassName="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-6 py-5 styled-scrollbar"
      footer={
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Tooltip
                title="Uncheck to record the time for reporting only. Non-billable time is kept on the matter but never appears on an invoice."
                enterDelay={300}
              >
                <span>
                  <Checkbox
                    checked={billable}
                    onChange={(next) => {
                      setBillable(next);
                      // Non-billable time can never reach an invoice, so the
                      // bill-now shortcut cannot stay armed alongside it.
                      if (!next) setBillNow(false);
                    }}
                    label="Billable"
                  />
                </span>
              </Tooltip>
              {canManageInvoices && (
                <Tooltip
                  title={
                    billable
                      ? "Save the time entry, then open a draft invoice with this entry prefilled."
                      : "Non-billable time cannot be invoiced"
                  }
                  enterDelay={300}
                >
                  <span>
                    <Checkbox
                      checked={billNow}
                      onChange={setBillNow}
                      disabled={!billable}
                      label="Bill this now"
                    />
                  </span>
                </Tooltip>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="secondary" onClick={handleClose} disabled={updating}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={handleSave}
                loading={updating}
                disabled={updating || !selectedTargetParts || !selectedUser || !durationIsValid || !date}
              >
                Save Time Entry
              </Button>
            </div>
          </div>
      }
    >
        <ErrorNotification error={error} onClose={() => setError(null)} compact className="mb-5" />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-5">
            <section className="rounded-2xl border border-outline bg-surface-alt/40 p-4 sm:p-5">
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Matter</p>
                <h3 className="mt-1 text-base font-semibold text-on-surface">Where should this time live?</h3>
              </div>

              <div>
                <FieldLabel>
                  <RequiredLabel>Matter or Client</RequiredLabel>
                </FieldLabel>
                <p className="text-xs text-on-surface-muted mb-2">Pick a matter to bill under it, or a client directly for work not tied to a matter.</p>
                <div className="grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)] gap-3">
                  <Dropdown
                    value={targetType}
                    onChange={(value) => handleTargetTypeChange(value as TargetType)}
                    options={TARGET_TYPE_OPTIONS}
                    disabled={isEdit}
                    portal
                  />
                  <EntityPicker<FullLookupItem>
                    key={targetType}
                    entity={targetType === "matter" ? "matters" : "clients"}
                    lawFirmId={lawFirmId}
                    value={targetId}
                    onChange={handleTargetIdChange}
                    onSelectItem={(item) => {
                      setTargetItem(item);
                      applyUserForTarget(targetType, item);
                    }}
                    clientId={targetType === "matter" ? (scopedClientIds?.length ? scopedClientIds.join(",") : scopeClientId ?? undefined) : undefined}
                    matterId={targetType === "client" ? (scopeMatterId || effectiveScopeMatterId) ?? undefined : undefined}
                    ids={targetType === "client" ? scopedClientIds : undefined}
                    // An edit keeps the target it was filed under: the update API
                    // cannot re-file it (the client-to-matter move is its own
                    // field below), so a new pick would be dropped on save.
                    disabled={isEdit || (targetType === "matter" && !!scopeMatterId) || (targetType === "client" && !!scopeClientId && (scopedClientIds?.length ?? 0) <= 1)}
                    emptyOption={{ label: targetType === "matter" ? "Select a matter..." : "Select a client...", value: "" }}
                    placeholder={targetType === "matter" ? "Select a matter..." : "Select a client..."}
                    full
                    portal
                  />
                </div>
              </div>

              {canMoveToMatter && (
                <div className="mt-4">
                  <EntityPicker
                    entity="matters"
                    lawFirmId={lawFirmId}
                    clientId={entry?.clientId || undefined}
                    label="Bill under a matter"
                    value={moveToMatterId}
                    onChange={setMoveToMatterId}
                    emptyOption={{ label: "Keep on the client", value: "" }}
                    full
                    portal
                  />
                  <p className="mt-1 text-xs text-on-surface-muted">
                    {moveToMatterId
                      ? "This time moves to the selected matter and is invoiced there. Only this client's matters are listed."
                      : "Leave as is to keep invoicing this directly to the client."}
                  </p>
                </div>
              )}
              {selectedMatter && (selectedMatter.clientNames?.length || selectedMatterClients.length > 0) && (
                <p className="mt-2.5 text-xs text-on-surface-secondary flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5 text-on-surface-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span>
                    This matter&apos;s {((selectedMatter.clientNames?.length || selectedMatterClients.length) === 1) ? "client" : "clients"}:{" "}
                    <span className="font-medium text-on-surface">
                      {(selectedMatter.clientNames && selectedMatter.clientNames.length > 0
                        ? selectedMatter.clientNames
                        : selectedMatterClients.map((matterClient) => matterClient.name || matterClient.email || matterClient.id)
                      ).join(", ")}
                    </span>
                    {shouldShowBillingClientPicker
                      ? <>. Uncheck any client below that this entry should not bill toward.</>
                      : <>. Time will stay on this matter for billing.</>
                    }
                  </span>
                </p>
              )}

              {selectedTargetParts?.type === "matter" && (
                <div className="mt-4 rounded-xl border border-outline bg-surface px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <FieldLabel>
                        Preferred Clients
                      </FieldLabel>
                      <p className="text-xs text-on-surface-muted">
                        All of this matter&apos;s clients are selected by default. Uncheck any client this entry should not bill toward.
                      </p>
                    </div>
                  </div>

                  {matterClientsLoading && selectedMatterClients.length === 0 ? (
                    <ListSkeleton rows={3} label="Loading matter clients" className="mt-3" bordered={false} />
                  ) : shouldShowBillingClientPicker ? (
                    <div className="mt-3 space-y-2">
                      <div className="grid grid-cols-1 gap-2">
                        {selectedMatterClients.map((matterClient) => {
                          const checked = effectiveSelectedMatterClientIds.includes(matterClient.id);
                          return (
                            <label
                              key={matterClient.id}
                              className={`flex items-center gap-3 rounded-lg border px-3 py-3 cursor-pointer transition-colors ${
                                checked
                                  ? "border-accent-control-ring bg-blue-50/60 dark:bg-blue-950/20"
                                  : "border-outline hover:border-outline-subtle"
                              }`}
                            >
                              <Checkbox
                                checked={checked}
                                onChange={() => {
                                  setSelectedMatterClientIds((prev) =>
                                    prev.includes(matterClient.id)
                                      ? prev.filter((id) => id !== matterClient.id)
                                      : [...prev, matterClient.id],
                                  );
                                }}
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-on-surface">
                                  {matterClient.name || matterClient.email || matterClient.id}
                                </p>
                                {matterClient.email ? (
                                  <p className="text-xs text-on-surface-muted mt-0.5">{matterClient.email}</p>
                                ) : null}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                      <p className="text-xs text-on-surface-muted">
                        {effectiveSelectedMatterClientIds.length === 0
                          ? "No preferred clients selected."
                          : effectiveSelectedMatterClientIds.length === 1
                            ? "One preferred client selected. This can prefill single-client billing later."
                            : `${effectiveSelectedMatterClientIds.length} preferred clients selected. Billing this now will open split billing.`}
                      </p>
                      <p className="mt-2 text-xs text-on-surface-muted">
                        Uncheck all clients to leave this entry unassigned for later billing.
                      </p>
                    </div>
                  ) : effectiveSelectedMatterClient ? (
                    <div className="mt-3 rounded-lg border border-outline-subtle bg-surface-alt/40 px-3 py-3">
                      <p className="text-sm font-medium text-on-surface">
                        {effectiveSelectedMatterClient.name || effectiveSelectedMatterClient.email || effectiveSelectedMatterClient.id}
                      </p>
                      <p className="mt-1 text-xs text-on-surface-muted">
                        This matter has one billing client, so it will be used automatically.
                      </p>
                    </div>
                  ) : null}
                </div>
              )}

              {(sourceTaskTitle || sourceEventTitle) && (
                <div className="mt-4 rounded-xl border border-outline bg-surface px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
                    Related Work
                  </p>
                  <p className="mt-1 text-sm font-medium text-on-surface">
                    {sourceTaskTitle || sourceEventTitle}
                  </p>
                  <p className="text-xs text-on-surface-muted">
                    {sourceTaskTitle ? "Linked to task" : "Linked to event"}
                  </p>
                  {sourceTaskId && !sourceMatterId && sourceClientIds.length === 0 && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      This task isn&apos;t linked to a matter or client, so choose above where the
                      time should bill. The link to the task is kept either way.
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-outline bg-surface-alt/30 p-4 sm:p-5">
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Assignment</p>
                <h3 className="mt-1 text-base font-semibold text-on-surface">Who did the work and how should it bill?</h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <FieldLabel id={`${fieldIds}-team-member-label`}>
                    <RequiredLabel>Team Member</RequiredLabel>
                  </FieldLabel>
                  <Dropdown
                    ariaLabelledBy={`${fieldIds}-team-member-label`}
                    value={selectedUser}
                    onChange={setSelectedUser}
                    options={memberOptions}
                    placeholder="Select a member"
                    // Pinned in an edit: the update API does not re-attribute
                    // recorded work, so a different member would be dropped.
                    disabled={!selectedTarget || isEdit}
                    portal
                  />
                </div>
                {canViewRates && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium text-on-surface">Charge Code</label>
                      <div className="flex items-center gap-1">
                        {selectedChargeCodeId && (
                          <Tooltip title="Edit charge code" enterDelay={300}>
                            <button
                              type="button"
                              onClick={openChargeCodeEdit}
                              className="w-5 h-5 flex items-center justify-center rounded text-[10px] border border-outline text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                            >
                              ✎
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip title="Quick-create a charge code" enterDelay={300}>
                          <button aria-label="Quick-create a charge code"
                            type="button"
                            onClick={() => setShowChargeCodeQuickCreate((prev) => !prev)}
                            className="w-5 h-5 flex items-center justify-center rounded text-xs border border-outline text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                          >
                            {showChargeCodeQuickCreate ? "×" : "+"}
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                    <Dropdown
                      value={selectedChargeCodeId}
                      onChange={setSelectedChargeCodeId}
                      options={[{ label: "No charge code", value: "" }, ...chargeCodes.map((code) => ({ label: `${code.code} - ${code.name}`, value: code.id }))]}
                      placeholder="Select a charge code"
                      portal
                    />
                    <Modal
                      isOpen={showChargeCodeQuickCreate}
                      onClose={closeChargeCodeQuickCreate}
                      dismissible={!quickChargeCodeCreating}
                      stacked
                      size="sm"
                      title="New Charge Code"
                      footer={
                        <>
                          <Button type="secondary" onClick={closeChargeCodeQuickCreate} disabled={quickChargeCodeCreating}>Cancel</Button>
                          <Button
                            type="primary"
                            onClick={handleChargeCodeQuickCreate}
                            disabled={quickChargeCodeCreating || !quickChargeCode.trim() || !quickChargeCodeName.trim()}
                            loading={quickChargeCodeCreating}
                          >
                            Create & Select
                          </Button>
                        </>
                      }
                    >
                      <ErrorNotification
                        error={quickChargeCodeError}
                        onClose={() => setQuickChargeCodeError(null)}
                        compact
                      />

                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-quickchargecode`}><RequiredLabel>Code</RequiredLabel></FieldLabel>
                        <TextInput
                          id={`${fieldIds}-quickchargecode`}
                          type="text"
                          value={quickChargeCode}
                          onChange={(e) => setQuickChargeCode(e.target.value.toUpperCase())}
                          placeholder="e.g. CONSULT"
                          maxLength={10} className="uppercase"
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-quickchargecodename`}><RequiredLabel>Name</RequiredLabel></FieldLabel>
                        <TextInput
                          id={`${fieldIds}-quickchargecodename`}
                          type="text"
                          value={quickChargeCodeName}
                          onChange={(e) => setQuickChargeCodeName(e.target.value)}
                          placeholder="e.g. Consultation"
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-quickchargecoderate`}>Default Rate ($/hr)</FieldLabel>
                        <TextInput
                          id={`${fieldIds}-quickchargecoderate`}
                          type="number"
                          value={quickChargeCodeRate}
                          onChange={(e) => setQuickChargeCodeRate(e.target.value)}
                          placeholder="e.g. 250"
                          min="0"
                          step="0.01"
                        />
                      </div>
                    </Modal>
                    <Modal
                      isOpen={showChargeCodeEdit}
                      onClose={closeChargeCodeEdit}
                      dismissible={!editChargeCodeSaving}
                      stacked
                      size="sm"
                      title="Edit Charge Code"
                      footer={
                        <>
                          <Button type="secondary" onClick={closeChargeCodeEdit} disabled={editChargeCodeSaving}>Cancel</Button>
                          <Button
                            type="primary"
                            onClick={handleChargeCodeEdit}
                            disabled={editChargeCodeSaving || !editChargeCodeName.trim()}
                            loading={editChargeCodeSaving}
                          >
                            Save
                          </Button>
                        </>
                      }
                    >
                      <ErrorNotification
                        error={editChargeCodeError}
                        onClose={() => setEditChargeCodeError(null)}
                        compact
                      />

                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-editchargecodecode`}>Code</FieldLabel>
                        <input
                          id={`${fieldIds}-editchargecodecode`}
                          type="text"
                          value={editChargeCodeCode}
                          onChange={(e) => setEditChargeCodeCode(e.target.value.toUpperCase())}
                          maxLength={10}
                          className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring uppercase"
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-editchargecodename`}><RequiredLabel>Name</RequiredLabel></FieldLabel>
                        <input
                          id={`${fieldIds}-editchargecodename`}
                          type="text"
                          value={editChargeCodeName}
                          onChange={(e) => setEditChargeCodeName(e.target.value)}
                          className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-editchargecoderate`}>Default Rate ($/hr)</FieldLabel>
                        <input
                          id={`${fieldIds}-editchargecoderate`}
                          type="number"
                          value={editChargeCodeRate}
                          onChange={(e) => setEditChargeCodeRate(e.target.value)}
                          placeholder="e.g. 250"
                          min="0"
                          step="0.01"
                          className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        />
                      </div>
                    </Modal>
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-outline bg-surface-alt/20 p-4 sm:p-5">
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Work Details</p>
                <h3 className="mt-1 text-base font-semibold text-on-surface">Describe what was done</h3>
              </div>

              <div className="space-y-4">
                <div>
                  <FieldLabel htmlFor={`${fieldIds}-name`}>Entry Name</FieldLabel>
                  <input
                    id={`${fieldIds}-name`}
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Document review, client call, drafting..."
                    className="w-full rounded-md border border-input-border bg-input-bg px-3.5 py-3 text-sm text-on-surface"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
                  <textarea
                    id={`${fieldIds}-description`}
                    rows={5}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What work was done?"
                    className="w-full rounded-md border border-input-border bg-input-bg px-3.5 py-3 text-sm text-on-surface"
                  />
                </div>

                {effectiveUtbmsEnabled && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowUtbms((v) => !v)}
                      className="text-xs font-medium text-on-surface-muted hover:text-on-surface flex items-center gap-1"
                    >
                      <span>{showUtbms ? "▾" : "▸"}</span>
                      LEDES Billing Codes (UTBMS)
                    </button>
                    {showUtbms && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                        <div>
                          <Dropdown
                            label="Task Code (UTBMS)"
                            value={utbmsTaskCode}
                            onChange={setUtbmsTaskCode}
                            options={[{ label: "None", value: "" }, ...TASK_CODES.map((c) => ({ label: `${c.code}: ${c.label}`, value: c.code }))]}
                            placeholder="None"
                            portal
                            searchable
                            searchPlaceholder="Search codes"
                          />
                        </div>
                        <div>
                          <Dropdown
                            label="Activity Code (UTBMS)"
                            value={utbmsActivityCode}
                            onChange={setUtbmsActivityCode}
                            options={[{ label: "None", value: "" }, ...ACTIVITY_CODES.map((c) => ({ label: `${c.code}: ${c.label}`, value: c.code }))]}
                            placeholder="None"
                            portal
                            searchable
                            searchPlaceholder="Search codes"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-2xl border border-outline bg-surface-alt/40 p-4 sm:p-5">
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Time & Billing</p>
                <h3 className="mt-1 text-base font-semibold text-on-surface">Set the entry details</h3>
              </div>

              <div className="space-y-4">
                <TimeDateField label={<FieldLabel><RequiredLabel>Date</RequiredLabel></FieldLabel>}
                  value={date} onChange={setDate} className="w-full" aria-label="Entry date" />
                <TimeDurationField label={<FieldLabel><RequiredLabel>Time</RequiredLabel></FieldLabel>}
                  hours={hoursInput} minutes={minutesInput} onHoursChange={setHoursInput} onMinutesChange={setMinutesInput} quickPicks />

                <RateField
                  value={hourlyRateInput}
                  onChange={(value) => {
                    setHourlyRateInput(value);
                    setHasManualRate(true);
                  }}
                  onPick={(rate) => {
                    setHourlyRateInput(String(rate));
                    setHasManualRate(true);
                  }}
                  resolvedRate={resolvedRate}
                  rateSource={rateSource}
                  hasManualRate={hasManualRate}
                  availableRates={availableRates}
                  warn={shouldWarnMissingRate}
                />
              </div>
            </section>

            <section className={`rounded-2xl border p-4 sm:p-5 ${shouldWarnMissingRate ? "border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20" : "border-outline bg-surface-alt/30"}`}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Live Preview</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-outline bg-surface px-3 py-3">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-on-surface-muted">Duration</p>
                  <p className="mt-1 text-lg font-semibold text-on-surface">{formatHoursMinutes(totalHours)}</p>
                </div>
                <div className="rounded-xl border border-outline bg-surface px-3 py-3">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-on-surface-muted">Rate</p>
                  <p className={`mt-1 text-lg font-semibold ${shouldWarnMissingRate ? "text-amber-600 dark:text-amber-400" : "text-on-surface"}`}>
                    {typeof effectiveHourlyRate === "number" ? formatCurrency(effectiveHourlyRate) : "No rate"}
                  </p>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-outline bg-surface px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.08em] text-on-surface-muted">Estimated Amount</p>
                <p className={`mt-1 text-2xl font-semibold ${previewAmount === null ? "text-on-surface" : "text-on-surface"}`}>
                  {previewAmount !== null ? formatCurrency(previewAmount) : "$0.00"}
                </p>
                <p className="mt-1 text-xs text-on-surface-muted">
                  {previewAmount !== null
                    ? hasManualRate
                      ? "Using your custom rate."
                      : rateSourceLabel(rateSource) || "Using the current saved rate."
                    : shouldWarnMissingRate
                    ? "Set a rate to turn this into a billable amount."
                    : !selectedTargetParts || !selectedUser
                      ? "Choose a billing target and team member to preview the amount."
                      : "Add time to preview the amount."}
                </p>
              </div>

              {shouldWarnMissingRate && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-600 bg-surface px-3 py-3">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    No billing rate found for this member. This entry will save without an amount unless you enter one here or set a rate in the Rates tab.
                  </p>
                </div>
              )}
            </section>
          </aside>
        </div>
    </Modal>
  );
}
