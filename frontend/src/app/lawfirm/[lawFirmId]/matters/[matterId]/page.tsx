"use client";

import { getMatterLeadNames } from '@/lib/matters/leadNames';

import { useParams, useSearchParams } from "next/navigation";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList, FolderOpen, Landmark,
  Pencil, Trash2, Users, UserRound, StickyNote,
  Briefcase, ArrowLeft, ChevronRight, FileText, Plus,
} from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import dayjs from "dayjs";
import dynamic from "next/dynamic";
import Button from "@/components/ui/Button";
import BackButton from "@/components/ui/BackButton";
import PageHeader from "@/components/ui/PageHeader";
import ListEmptyState from "@/components/ui/ListEmptyState";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import DetailField from "@/components/ui/DetailField";
import ConfirmModal from "@/components/ui/ConfirmModal";
import StatTile from "@/components/ui/StatTile";
import Tooltip from "@/components/ui/Tooltip";
import { formatHoursMinutes } from "@/lib/utils/format";
import { hoursTimesRateCents, hoursToHundredths } from "@/lib/utils/currency";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { isPastInstant, isTaskOverdue, toLocalDate, isBeforeToday } from "@/lib/utils/dateUtils";

import MattersService from "@/services/matters.service";
import TasksService from "@/services/tasks.service";
import EntityClientsTab from "@/components/clientComp/EntityClientsTab";
import EntityTasksTab from "@/components/taskComp/EntityTasksTab";
import CreateTaskModal from "@/components/taskComp/CreateTaskModal";
import EditTaskModal from "@/components/taskComp/EditTaskModal";
import { useCreateTask, useEditTask } from "@/hooks/taskHooks/useTasks";
import useCourts from "@/hooks/courtHooks/useCourts";
import EntityTeamSection from "@/components/teamComp/EntityTeamSection";
import billingService from "@/services/billing.service";
import filesService from "@/services/files.service";
import type { FolderCrumb } from "@/lib/files/filePaths";
import useMatterTrustBalances from "@/hooks/trustHooks/useMatterTrustBalances";
import useMatterEventsList from "@/hooks/matterHooks/useMatterEventsList";
import type { MatterEvent } from "@/types/matterEvent";
import { matterEventTypeMeta } from "@/constants/statusMeta";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useAuth } from "@/hooks/useAuth";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import RemoveMemberConfirm from "@/components/matterComp/RemoveMemberConfirm";
import type { MemberRemovalPreview } from "@/services/matters.service";

// Import EditMatterModal dynamically to avoid SSR hydration issues
const EditMatterModal = dynamic(() => import("@/components/matterComp/EditMatterModal"), {
  ssr: false
});

/**
 * Whether the viewer's permissions let them see a matter tab at all. The Billing
 * tab mixes invoice-backed sections (invoices, flat fees) with time-entry-backed
 * ones (hours, member totals), so either read is enough to show it.
 */
function isMatterTabShown(tab: string, hasPermission: (code: string) => boolean): boolean {
  if (tab === 'messages') return hasPermission('messaging.view');
  if (tab === 'time-tracking') return hasPermission('billing.viewTimeEntries');
  if (tab === 'billing') return hasPermission('billing.viewInvoices') || hasPermission('billing.viewTimeEntries');
  return true;
}

/**
 * The matter detail views, in the order they appear in the tab strip. `messages`,
 * `time-tracking` and `billing` are filtered out for members without the read
 * permissions behind them (see `isMatterTabShown`), and a `?tab=` deep link
 * is checked against this list so an unknown value falls back to the Overview.
 */
const MATTER_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'events', label: 'Events' },
  { value: 'clients', label: 'Clients' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'messages', label: 'Messages' },
  { value: 'team', label: 'Team' },
  { value: 'notes', label: 'Notes' },
  { value: 'time-tracking', label: 'Time Tracking' },
  { value: 'billing', label: 'Billing' },
  { value: 'documents', label: 'Documents' },
] as const;
import AddClientModal from "@/components/matterComp/AddClientModal";
import TabBar from "@/components/ui/TabBar";
import Checkbox from "@/components/ui/Checkbox";
import EditClientModal from "@/components/matterComp/EditClientModal";
import NotesSection from "@/components/notesComp/NotesSection";
import FilesSection from "@/components/filesComp/FilesSection";
import DocumentRequestsPanel from "@/components/documentRequestsComp/DocumentRequestsPanel";
import MatterFileQuickAdd from "@/components/filesComp/MatterFileQuickAdd";
import TimeTracking from "@/components/matterComp/TimeTracking";
import MatterEventsTab from "@/components/matterComp/MatterEventsTab";
import MatterMessagesTab from "@/components/matterComp/MatterMessagesTab";
import MatterContactsTab from "@/components/matterComp/MatterContactsTab";
import MatterActivityFeed, { matterActivityQueryOptions } from "@/components/matterComp/MatterActivityFeed";
import MatterCustomFieldsCard, { matterFieldDefsQueryOptions } from "@/components/matterComp/MatterCustomFieldsCard";
import { matterPipelinesQueryOptions } from "@/hooks/matterConfigHooks/useMatterPipelines";
import MatterStageBar from "@/components/matterComp/MatterStageBar";
import MatterBudgetCard from "@/components/matterComp/MatterBudgetCard";
import EditMatterBillingModal from "@/components/matterComp/EditMatterBillingModal";
import TimeEntryModal, { type TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import {
  formatCurrency,
  getInvoiceDisplayName,
  getInvoiceNextPaymentInfo,
  getInvoiceRemainingBalance,
  getInvoiceStatus,
  getInvoiceStatusKey,
  getInvoiceTotal,
  isClosedStatusKey,
  sortInvoicesForList,
  summarizeInvoiceMoney,
} from "@/components/billingComp/utils";
import BillingSummaryCard from "@/components/billingComp/BillingSummaryCard";
import { FlatFeeEditorRow, FlatFeeSavedRow } from "@/components/billingComp/FlatFeeEditor";
import type { Matter, Task, User, TimeEntry, Member, MatterClient, Client } from "@/types";
import type { Invoice } from "@/types/billing";
import LoadingSpinner from "@/components/LoadingSpinner";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ErrorNotification from "@/components/ErrorNotification";
import StatusBadge from "@/components/ui/StatusBadge";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import TaskPriorityBadge from "@/components/ui/TaskPriorityBadge";
import PaymentOngoingBadge from "@/components/ui/PaymentOngoingBadge";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import { taskEndSuffix } from "@/components/calendarComp/calendarTiming";

const MATTER_BILLING_METHOD_LABELS: Record<string, string> = {
  hourly: "Hourly",
  flat: "Flat Fee",
  contingency: "Contingency",
  pro_bono: "Pro Bono",
};

const CARD_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm";

// Color a statute-of-limitations date by urgency: red once it is within a week
// or already passed, amber within 30 days, muted otherwise.
function solUrgencyClass(dateStr: string): string {
  const days = dayjs(dateStr).startOf("day").diff(dayjs().startOf("day"), "day");
  if (days <= 7) return "text-red-600 dark:text-red-400";
  if (days <= 30) return "text-amber-600 dark:text-amber-400";
  return "text-on-surface";
}

/**
 * A time entry as the matter context list serves it: the stored row, which
 * carries the rate the server resolved for it and its value at that rate.
 * `rateSource` is null only on a row nothing has rated yet.
 */
type ServedTimeEntry = TimeEntry & {
  amount?: number | null;
  rateSource?: string | null;
};

type MatterClientView = MatterClient & {
  canonicalClientId?: string | null;
  status?: string;
  invitedAt?: string;
  joinedAt?: string | null;
};



// Cap on unsaved (open, not-yet-saved) flat-fee rows the user can stack at once.
const MAX_OPEN_FLAT_FEES = 10;

export default function ViewMatterPage() {
  const params = useParams();
  const { navigate } = useNavigation();
  const searchParams = useSearchParams();

  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const matterId = Array.isArray(params?.matterId) ? params.matterId[0] : (params?.matterId as string);
  const matterBillingContext = useMemo(
    () => ({ type: 'matter' as const, lawFirmId, entityId: matterId }),
    [lawFirmId, matterId],
  );

  const [matterData, setMatterData] = useState<Matter | null>(null);
  const [matterTasks, setMatterTasks] = useState<Task[]>([]);
  // Set when the task read fails, so the Tasks tab says so instead of showing an
  // empty list that reads as "this matter has no tasks".
  const [matterTasksError, setMatterTasksError] = useState<string | null>(null);
  const [matterClients, setMatterClients] = useState<MatterClientView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editBillingModalOpen, setEditBillingModalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [addUserDialogOpen, setAddUserDialogOpen] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [addMemberSearch, setAddMemberSearch] = useState("");
  const [removeUserDialogOpen, setRemoveUserDialogOpen] = useState(false);
  const [userToRemove, setUserToRemove] = useState<any>(null);
  // What removing `userToRemove` leaves assigned on this matter, read before the confirm opens.
  const [removePreview, setRemovePreview] = useState<MemberRemovalPreview | null>(null);
  const [checkingRemoval, setCheckingRemoval] = useState(false);
  const [addClientModalOpen, setAddClientModalOpen] = useState(false);
  const [editClientModalOpen, setEditClientModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<MatterClient | null>(null);
  const [removeClientDialogOpen, setRemoveClientDialogOpen] = useState(false);
  const [clientToRemove, setClientToRemove] = useState<MatterClient | null>(null);
  const [removingClient, setRemovingClient] = useState(false);
  const [addingUsers, setAddingUsers] = useState(false);
  const [removingUser, setRemovingUser] = useState(false);
  // Files and document requests share one "Documents" tab. Older ?tab=files /
  // ?tab=requests deep links still resolve: they open the Documents tab on the
  // matching sub-view.
  const initialTabParam = searchParams?.get('tab') || 'overview';
  const { hasPermission } = usePermissions();
  // A deep link names a tab that may not exist, or one this viewer is not shown
  // (Messages without messaging access). Either would leave no panel on screen,
  // so it falls back to the Overview rather than being stored as the active tab.
  const [requestedTab, setActiveTab] = useState(() => {
    if (initialTabParam === 'files' || initialTabParam === 'requests') return 'documents';
    return MATTER_TABS.some((tab) => tab.value === initialTabParam) ? initialTabParam : 'overview';
  });
  // A gated tab is shown only while the viewer's permissions grant it. Deciding
  // that once at mount would send a member whose permissions had not loaded yet
  // to the Overview for good; deriving it keeps the link alive until they have.
  const activeTab = isMatterTabShown(requestedTab, hasPermission) ? requestedTab : 'overview';
  const [documentsSubTab, setDocumentsSubTab] = useState<'files' | 'requests'>(
    initialTabParam === 'requests' ? 'requests' : 'files'
  );
  const [revealTrail, setRevealTrail] = useState<FolderCrumb[] | undefined>(undefined);
  const [revealHighlightId, setRevealHighlightId] = useState<string | null>(null);
  // The folders above a document are a lookup, not a string slice on its
  // storage path: the path says nothing about the tree any more. One request,
  // and only on an explicit "reveal this file".
  const handleRevealFile = useCallback(async (fileId: string) => {
    setDocumentsSubTab('files');
    try {
      const location = await filesService.fileLocation(lawFirmId, fileId);
      setRevealTrail(location.trail);
    } catch {
      // The scope root still shows the document's own folder tree, which is
      // more useful than refusing to switch tabs.
      setRevealTrail([]);
    }
    setRevealHighlightId(fileId);
    window.setTimeout(() => setRevealHighlightId(null), 2000);
  }, [lawFirmId]);

  // Billing tab state
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [loadingTimeEntries, setLoadingTimeEntries] = useState(false);
  const [editingBillingRate, setEditingBillingRate] = useState<{ userId: string; value: string } | null>(null);
  const [showAllBillingMembers, setShowAllBillingMembers] = useState(false);
  const [updatingBillingRate, setUpdatingBillingRate] = useState(false);
  const [selectedBillingUser, setSelectedBillingUser] = useState<string>("");
  const [addHoursModalOpen, setAddHoursModalOpen] = useState(false);
  const [timeEntryPrefill, setTimeEntryPrefill] = useState<TimerPrefill | null>(null);
  const [newFlatFees, setNewFlatFees] = useState<Array<{ id: string; description: string; amount: number; date?: string | null }>>([]);
  const [savedFlatFees, setSavedFlatFees] = useState<Array<{ id: string; description: string; amount: number; date?: string | null; createdAt?: string | null }>>([]);

  // Flat fees accumulate over the life of the matter, so the rendered rows are
  // windowed.
  const flatFeesPager = usePagedRows(savedFlatFees, 5);
  const [loadingFlatFees, setLoadingFlatFees] = useState(false);
  const [savingFlatFeeId, setSavingFlatFeeId] = useState<string | null>(null);
  const [deletingFlatFeeId, setDeletingFlatFeeId] = useState<string | null>(null);
  const [editingFlatFee, setEditingFlatFee] = useState<{ id: string; description: string; amount: number; date?: string | null } | null>(null);

  // Upcoming events for overview panel
  const [overviewEvents, setOverviewEvents] = useState<MatterEvent[]>([]);
  const [totalEventsCount, setTotalEventsCount] = useState(0);



  // Recent invoices for billing tab
  const [matterInvoices, setMatterInvoices] = useState<Invoice[]>([]);
  const [loadingMatterInvoices, setLoadingMatterInvoices] = useState(false);

  const billingSummary = useMemo(() => {
    const { totalBilled, totalPaid, outstanding } = summarizeInvoiceMoney(matterInvoices);
    const unbilledFlatFees = [...savedFlatFees, ...newFlatFees].reduce((sum, fee) => sum + fee.amount, 0);
    const totalHours = timeEntries.reduce((sum, entry) => sum + (entry.hours || 0), 0);
    return { totalBilled, totalPaid, outstanding, unbilledFlatFees, totalHours };
  }, [matterInvoices, savedFlatFees, newFlatFees, timeEntries]);

  const { users } = useLawFirmUsers(lawFirmId);
  // Charge codes feed only the Add Hours time-entry modal, so they load when it
  // first opens. The cache key is shared, so reopening does not refetch.
  const { chargeCodes } = useChargeCodes(lawFirmId, false, addHoursModalOpen);
  const { features } = useFirmSettings();
  const { user } = useAuth();

  // Matter-scoped events. Shares the React Query cache with the Events tab
  // (same key) so the list is fetched once for both consumers.
  const { events: matterEventsList } = useMatterEventsList(lawFirmId, matterId);

  const canViewMessaging = hasPermission("messaging.view");
  // Billing reads are explicit role grants, not part of the member baseline, so
  // each section of the Billing tab renders and loads only for its own permission.
  const canViewInvoices = hasPermission("billing.viewInvoices");
  const canViewTimeEntries = hasPermission("billing.viewTimeEntries");
  const canViewTrust = hasPermission("trust.view");
  const canUpdateMatter = hasPermission("matters.update");
  const canDeleteMatter = hasPermission("matters.delete");
  // The delete route requires membership of THIS matter on top of
  // matters.delete, with no owner or admin bypass (`deleteMatter` asserts it
  // strictly), so a firm admin reading a matter they are not on is not offered
  // a delete the server would refuse.
  const isMatterMember = Boolean(
    user?.uid && matterData?.members?.some((member) => member.userId === user.uid),
  );
  const canDeleteThisMatter = canDeleteMatter && isMatterMember;
  const canManageMembers = hasPermission("matters.manageMembers");
  const canManageClients = hasPermission("matters.manageClients");
  // Editing a client from here writes the firm-wide client record, which the
  // backend gates on clients.manage as well as matters.manageClients.
  const canEditClientRecords = hasPermission("clients.manage");
  const canCreateTask = hasPermission("tasks.create");
  const canUpdateTask = hasPermission("tasks.update");
  const canDeleteTask = hasPermission("tasks.delete");
  const canRequestDocuments = hasPermission("documents.request");
  const canManageCourts = hasPermission("courts.manage");
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  const canManageInvoices = hasPermission("billing.manageInvoices");

  const handleEventsChange = useCallback((events: MatterEvent[]) => {
    setOverviewEvents(events.filter((e) => e.status === 'upcoming'));
    setTotalEventsCount(events.filter((e) => e.status !== 'completed').length);
  }, []);

  const mergeMatterClientsWithCanonical = useCallback(
    async (clients: MatterClient[]): Promise<MatterClientView[]> => {
      if (!lawFirmId || !Array.isArray(clients) || clients.length === 0) {
        return clients as MatterClientView[];
      }

      // The batch read is keyed by `clients.id`. A portal client's `userId` is a
      // Firebase uid, which that read can never match.
      const canonicalClientIds = Array.from(
        new Set(
          clients
            .map((client) => client.id)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
        ),
      );

      if (canonicalClientIds.length === 0) {
        return clients as MatterClientView[];
      }

      try {
        const canonicalById = await MattersService.getClientProfilesByIds(lawFirmId, canonicalClientIds);
        return clients.map((client) => {
          const canonicalLookupId = client.id;
          const canonical: Client | undefined = canonicalLookupId ? canonicalById[canonicalLookupId] : undefined;
          if (!canonical) return client as MatterClientView;

          return {
            ...client,
            canonicalClientId: canonical.id || canonicalLookupId,
            name: canonical.name || client.name,
            email: canonical.email || client.email,
            phone: canonical.phone || client.phone,
            organization: canonical.organization || client.organization,
            address: canonical.address || client.address,
            preferredContactMethod: canonical.preferredContactMethod || client.preferredContactMethod,
            status: canonical.status || undefined,
            invitedAt: canonical.invitedAt || undefined,
            joinedAt: canonical.joinedAt || undefined,
          };
        });
      } catch (err) {
        console.warn("Failed to load canonical client profiles for matter clients:", err);
        return clients as MatterClientView[];
      }
    },
    [lawFirmId],
  );

  // Guards against a stale response landing after a newer one. This page keeps
  // its own matter/tasks/clients state in plain `useState` rather than React
  // Query, so nothing else stops a slow `loadMatter` call for the OLD matterId
  // from overwriting state after the viewer has already navigated to a
  // different matter (browser back/forward can reuse this same page instance
  // rather than remounting it). Every call claims the next id; a call whose id
  // no longer matches the ref by the time it resolves lost the race and skips
  // applying its result.
  const loadRequestIdRef = useRef(0);

  const loadMatter = useCallback(async (showLoader = true) => {
    if (!lawFirmId || !matterId) return;

    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => loadRequestIdRef.current === requestId;

    if (showLoader) setLoading(true);
    setError(null);

    try {
      // These three reads are independent, run them in one wave instead of a
      // sequential waterfall. Each settled so one failure doesn't sink the others
      // (preserving the prior per-section try/catch fallbacks).
      const [matterResult, tasksResult, clientsResult] = await Promise.allSettled([
        MattersService.getMatterById(matterId, lawFirmId),
        TasksService.listMatterTasks(lawFirmId, matterId),
        MattersService.listClients(lawFirmId, matterId),
      ]);

      if (!isCurrentRequest()) return;

      // Matter info. This is the critical read; a failure surfaces to the user
      // exactly as before (rethrown into the outer catch).
      if (matterResult.status === 'rejected') {
        throw matterResult.reason;
      }
      setMatterData(matterResult.value);

      // Load associated tasks
      if (tasksResult.status === 'fulfilled') {
        setMatterTasks(tasksResult.value || []);
        setMatterTasksError(null);
      } else {
        console.warn("Could not load matter tasks:", tasksResult.reason);
        setMatterTasks([]);
        setMatterTasksError(getErrorMessage(tasksResult.reason, "Failed to load tasks"));
      }

      // Load matter clients (merge canonical profiles via the batched endpoint)
      if (clientsResult.status === 'fulfilled') {
        try {
          const mergedClients = await mergeMatterClientsWithCanonical(clientsResult.value || []);
          if (!isCurrentRequest()) return;
          setMatterClients(mergedClients);
        } catch (clientError) {
          console.warn("Could not load matter clients:", clientError);
          if (isCurrentRequest()) setMatterClients([]);
        }
      } else {
        console.warn("Could not load matter clients:", clientsResult.reason);
        setMatterClients([]);
      }
    } catch (err) {
      if (isCurrentRequest()) setError(getErrorMessage(err, "Failed to load matter"));
    } finally {
      if (showLoader && isCurrentRequest()) setLoading(false);
    }
  }, [lawFirmId, matterId, mergeMatterClientsWithCanonical]);

  const createTask = useCreateTask(lawFirmId, () => loadMatter(false));
  const handleOpenCreateTask = useCallback(() => {
    createTask.openNew({ matterId });
  }, [createTask, matterId]);

  const editTask = useEditTask(lawFirmId, () => loadMatter(false));

  // Deleting a task from the Tasks tab, behind a confirm. A refusal (a matter
  // under legal hold refuses every task delete) is shown in the page banner.
  // Only a delete that went through re-reads the matter: that read clears the
  // banner, which would hide the refusal as it appeared.
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
  const [deleteTaskDialogOpen, setDeleteTaskDialogOpen] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const handleDeleteTask = useCallback((task: Task) => {
    if (!canDeleteTask) return;
    setTaskToDelete(task);
    setDeleteTaskDialogOpen(true);
  }, [canDeleteTask]);
  const closeDeleteTaskDialog = useCallback(() => {
    if (deletingTask) return;
    setDeleteTaskDialogOpen(false);
  }, [deletingTask]);
  const confirmDeleteTask = async () => {
    if (!taskToDelete || !canDeleteTask) return;
    setDeletingTask(true);
    try {
      await TasksService.deleteTask(lawFirmId, taskToDelete.taskId || taskToDelete.id);
      void loadMatter(false);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete task"));
    } finally {
      setDeletingTask(false);
      // Keep taskToDelete set so its title stays visible during the close
      // animation; it is overwritten the next time the dialog opens.
      setDeleteTaskDialogOpen(false);
    }
  };

  // Courts feed only the create/edit task modals, so they load when one first
  // opens. The cache key is shared, so reopening does not refetch.
  const { courts, loading: courtsLoading, updateCourt } = useCourts(lawFirmId, createTask.open || editTask.open);
  const updateCourtAddress = (courtId: string, address: string) => updateCourt(courtId, { address });

  // The Overview's stage bar, custom-field card and activity feed only mount
  // once the matter has loaded, but none of their reads needs the matter. Start
  // them now, under the keys those sections read, so they arrive with the
  // matter instead of after it. Only for the Overview: another tab never mounts
  // them.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!lawFirmId || !matterId || activeTab !== 'overview') return;
    void queryClient.prefetchQuery(matterPipelinesQueryOptions(lawFirmId));
    void queryClient.prefetchQuery(matterFieldDefsQueryOptions(lawFirmId));
    void queryClient.prefetchQuery(matterActivityQueryOptions(lawFirmId, matterId));
  }, [queryClient, lawFirmId, matterId, activeTab]);

  const handleDelete = async () => {
    if (!matterData || !canDeleteThisMatter) return;
    
    setDeleting(true);
    try {
      await MattersService.deleteMatter(lawFirmId, matterId);
      navigate(`/lawfirm/${lawFirmId}/matters`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete matter"));
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleEdit = () => {
    if (!canUpdateMatter) return;
    setEditModalOpen(true);
  };

  const handleAddUsers = async () => {
    if (!matterData || selectedUsers.length === 0 || !canManageMembers) return;

    setAddingUsers(true);
    try {
      const userIds = selectedUsers.map(user => user.uid);
      await MattersService.addMembers({
        lawFirmId,
        matterId,
        targetUserIds: userIds,
        role: 'member',
      });
      await loadMatter();
      setAddUserDialogOpen(false);
      setSelectedUsers([]); // Clear selection after adding
    } catch {
      setError("Failed to add users");
    } finally {
      setAddingUsers(false);
    }
  };

  // Removing a member leaves their tasks and events on the matter, so the server
  // is asked what is still assigned to them first. The confirm then offers to
  // hand it to a member who stays. A failed preview removes nobody: confirming
  // blind is how work ends up assigned to someone with no access to it.
  const handleRemoveUser = async (user: any) => {
    if (!canManageMembers || checkingRemoval) return;
    setCheckingRemoval(true);
    try {
      const preview = await MattersService.previewRemoveMembers({
        lawFirmId,
        matterId,
        targetUserIds: [user.userId],
      });
      setRemovePreview(preview);
      setUserToRemove(user);
      setRemoveUserDialogOpen(true);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to check what removing this member affects"));
    } finally {
      setCheckingRemoval(false);
    }
  };

  const confirmRemoveUser = async (reassignTo: string | null) => {
    if (!userToRemove || !canManageMembers) return;

    setRemovingUser(true);
    try {
      await MattersService.removeMembers({
        lawFirmId,
        matterId,
        targetUserIds: [userToRemove.userId],
        reassignTo,
      });
      await loadMatter();
      setRemoveUserDialogOpen(false);
      setUserToRemove(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove user"));
    } finally {
      setRemovingUser(false);
    }
  };

  const handleRemoveClient = (client: MatterClient) => {
    if (!canManageClients) return;
    setClientToRemove(client);
    setRemoveClientDialogOpen(true);
  };

  const confirmRemoveClient = async () => {
    if (!clientToRemove || !lawFirmId || !matterId || !canManageClients) return;
    setRemovingClient(true);
    try {
      await MattersService.removeClient({
        lawFirmId,
        matterId,
        clientId: clientToRemove.id,
      });
      await loadMatter();
      setRemoveClientDialogOpen(false);
      setClientToRemove(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove client from matter"));
    } finally {
      setRemovingClient(false);
    }
  };





  const handleAddNote = async (noteData: {
    content: string;
    contentHtml: string;
    subject?: string;
    noteType?: string;
    noteDate?: string;
    mentions?: string[];
    attachments?: Array<{ id: string; name: string; size: number; type: string; file?: File; url?: string }>;
    timeEntries?: Array<{
      timeSpent: number;
      timeEntryDate?: string;
      activityName?: string;
      activityDescription?: string;
      isBillable?: boolean;
    }>;
  }) => {
    if (!matterData) return;

    try {
      const result = await MattersService.addNoteToMatter(lawFirmId, matterId, noteData);
      loadMatter(false); // Reload matter to get updated notes, without the full-page loading spinner
      // The panel reads the new note's id from this to open "Save & Add Time".
      return result;
    } catch (err) {
      console.error("Error adding note:", err);
      setError(getErrorMessage(err, "Failed to add note"));
      throw err; // Re-throw so the NotesSection can handle it
    }
  };

  const handleUpdateNote = async (
    noteId: string,
    noteData: {
      content: string;
      contentHtml: string;
      subject?: string;
      noteType?: string;
      noteDate?: string;
      attachments?: Array<{ id: string; name: string; size: number; type: string; file?: File; url?: string }>;
    }
  ) => {
    if (!matterData) return;

    try {
      await MattersService.updateNoteInMatter(lawFirmId, matterId, noteId, noteData);
      loadMatter(false); // Reload matter to get updated notes, without the full-page loading spinner
    } catch (err) {
      console.error("Error updating note:", err);
      setError(getErrorMessage(err, "Failed to update note"));
      throw err; // Re-throw so the NotesSection can handle it
    }
  };

  // A note is retracted, not deleted: its time entries and any links stay on
  // the matter record. `reason` is optional and ignored by the task-notes page,
  // which still performs a real delete.
  const handleRetractNote = async (noteId: string, reason?: string) => {
    if (!matterData) return;

    try {
      await MattersService.retractNoteFromMatter(lawFirmId, matterId, noteId, reason);
      loadMatter(false); // no full-page loading spinner for a single note's retraction
    } catch (err) {
      console.error("Error retracting note:", err);
      setError(getErrorMessage(err, "Failed to retract note"));
      throw err; // Re-throw so the NotesSection can handle it
    }
  };

  const handleAddTimeEntry = async (noteId: string, entry: {
    timeSpent: number;
    timeEntryDate?: string;
    activityName?: string;
    activityDescription?: string;
    isBillable?: boolean;
  }) => {
    if (!matterData) return;

    try {
      await MattersService.addNoteTimeEntry(lawFirmId, matterId, noteId, entry);
      loadMatter(false); // Reload matter to get updated notes, without the full-page loading spinner
    } catch (err) {
      console.error("Error adding time entry:", err);
      setError(getErrorMessage(err, "Failed to add time entry"));
      throw err;
    }
  };

  const handleUpdateTimeEntry = async (noteId: string, timeEntryId: string, entry: {
    timeSpent: number;
    timeEntryDate?: string;
    activityName?: string;
    activityDescription?: string;
    isBillable?: boolean;
  }) => {
    if (!matterData) return;

    try {
      await MattersService.updateNoteTimeEntry(lawFirmId, matterId, noteId, timeEntryId, entry);
      loadMatter(false); // Reload matter to get updated notes, without the full-page loading spinner
    } catch (err) {
      console.error("Error updating time entry:", err);
      setError(getErrorMessage(err, "Failed to update time entry"));
      throw err;
    }
  };

  const handleRemoveTimeEntry = async (noteId: string, timeEntryId: string) => {
    if (!matterData) return;

    try {
      await MattersService.removeNoteTimeEntry(lawFirmId, matterId, noteId, timeEntryId);
      loadMatter(false); // Reload matter to get updated notes, without the full-page loading spinner
    } catch (err) {
      console.error("Error removing time entry:", err);
      setError(getErrorMessage(err, "Failed to remove time entry"));
      throw err;
    }
  };

  const handleSetNotePinned = async (noteId: string, pinned: boolean) => {
    if (!matterData) return;

    try {
      await MattersService.setNotePinned(lawFirmId, matterId, noteId, pinned);
      loadMatter(false); // no full-page loading spinner for a pin toggle
    } catch (err) {
      console.error("Error updating pin:", err);
      setError(getErrorMessage(err, "Failed to update pin"));
      throw err;
    }
  };


  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMatter();
  }, [lawFirmId, matterId, loadMatter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    handleEventsChange(matterEventsList);
  }, [matterEventsList, handleEventsChange]);

  // Billing functions
  const loadMatterInvoices = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    setLoadingMatterInvoices(true);
    try {
      const invoices = await billingService.listInvoices(matterBillingContext);
      setMatterInvoices(invoices || []);
    } catch (err) {
      console.error('Error loading matter invoices:', err);
    } finally {
      setLoadingMatterInvoices(false);
    }
  }, [lawFirmId, matterId, matterBillingContext]);

  const loadTimeEntries = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    
    setLoadingTimeEntries(true);
    try {
      // Unbilled-only is asked of the SERVER: this tab never renders billed
      // entries, and on a long-running matter they are most of the table.
      const entries = await billingService.listTimeEntries(matterBillingContext, undefined, {
        unbilledOnly: true,
      });
      setTimeEntries(entries || []);
    } catch (err) {
      console.error('Error loading time entries:', err);
      setError(getErrorMessage(err, 'Failed to load time entries'));
    } finally {
      setLoadingTimeEntries(false);
    }
  }, [lawFirmId, matterId, matterBillingContext]);

  const handleUpdateBillingRate = async (userId: string, rateValue: string) => {
    if (updatingBillingRate || !canManageMembers) return;
    
    setUpdatingBillingRate(true);
    try {
      const hourlyRate = rateValue === '' || rateValue === null || rateValue === undefined 
        ? null 
        : parseFloat(rateValue);
      
      if (hourlyRate !== null && (isNaN(hourlyRate) || hourlyRate < 0)) {
        setError("Hourly rate must be a non-negative number");
        setUpdatingBillingRate(false);
        return;
      }

      await MattersService.updateMemberHourlyRate({
        lawFirmId,
        matterId,
        userId,
        hourlyRate,
      });
      await loadMatter();
      await loadTimeEntries();
      setEditingBillingRate(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update hourly rate"));
    } finally {
      setUpdatingBillingRate(false);
    }
  };

  const handleAddHours = (userId?: string) => {
    const userToUse = userId || selectedBillingUser;
    
    if (!userToUse) {
      setError("Please select a team member");
      return;
    }
    
    setSelectedBillingUser(userToUse);
    setTimeEntryPrefill({
      matterId,
      userId: userToUse,
      hours: 1,
    });
    setAddHoursModalOpen(true);
  };

  const resetAddHoursModal = useCallback(() => {
    setAddHoursModalOpen(false);
    setSelectedBillingUser("");
    setTimeEntryPrefill(null);
  }, []);
  // Closes the modal, then opens the composer when the save chose "bill now".
  // The draft's own context decides which composer: an entry the modal filed
  // under a client opens that client's, not this matter's.
  const billNowRedirect = useBillNowRedirect(lawFirmId, resetAddHoursModal);

  const closeAddUserDialog = useCallback(() => setAddUserDialogOpen(false), []);

  useResetAfterClose(addUserDialogOpen, () => {
    setSelectedUsers([]);
    setAddMemberSearch("");
  });

  const closeRemoveUserDialog = useCallback(() => {
    setRemoveUserDialogOpen(false);
  }, []);

  const closeRemoveClientDialog = useCallback(() => {
    if (removingClient) return;
    setRemoveClientDialogOpen(false);
  }, [removingClient]);

  const closeDeleteDialog = useCallback(() => {
    if (deleting) return;
    setDeleteDialogOpen(false);
  }, [deleting]);

  // Per-user hours and value, accumulated in ONE pass over the entries rather
  // than re-filtering every entry once per member while rendering.
  //
  // Value is the server's, in whole cents. An entry the server has rated
  // (`rateSource` set) carries `amount`, hours times the rate it was stamped at
  // through the full cascade (override, matter, client, charge code, member
  // default, firm default), which is what the Time Tracking tab shows and what
  // an invoice bills. Pricing it here from the override or the member's matter
  // rate alone showed $0.00 for time rated from any other source.
  //
  // Only a row nothing has rated yet is priced here, by the backend's own live
  // fallback for that case (`billingReads.storedOrLiveRate`): its override,
  // else the member's matter rate, which is a render-time argument and so kept
  // as unrated hundredths of an hour.
  const billingTotalsByUser = useMemo(() => {
    const totals = new Map<string, {
      hours: number;
      ratedCents: number;
      unratedHundredths: number;
    }>();
    for (const entry of timeEntries as ServedTimeEntry[]) {
      if (!entry.userId) continue;
      const acc = totals.get(entry.userId) || { hours: 0, ratedCents: 0, unratedHundredths: 0 };
      acc.hours += entry.hours;
      if (entry.rateSource) {
        acc.ratedCents += typeof entry.amount === "number" ? Math.round(entry.amount * 100) : 0;
      } else if (typeof entry.hourlyRate === "number") {
        acc.ratedCents += hoursTimesRateCents(hoursToHundredths(entry.hours), Math.round(entry.hourlyRate * 100));
      } else {
        acc.unratedHundredths += hoursToHundredths(entry.hours);
      }
      totals.set(entry.userId, acc);
    }
    return totals;
  }, [timeEntries]);

  const getTotalHoursForUser = (userId: string): number =>
    billingTotalsByUser.get(userId)?.hours ?? 0;

  /** The member's unbilled time on this matter, in dollars summed from cents. */
  const getTotalAmountForUser = (userId: string, fallbackRate: number | null | undefined): number => {
    const acc = billingTotalsByUser.get(userId);
    if (!acc) return 0;
    const fallbackCents = Math.round((fallbackRate || 0) * 100);
    return (acc.ratedCents + hoursTimesRateCents(acc.unratedHundredths, fallbackCents)) / 100;
  };

  const loadFlatFees = useCallback(async () => {
    if (!lawFirmId || !matterId) return;
    
    setLoadingFlatFees(true);
    try {
      const fees = await billingService.listFlatFees(matterBillingContext, { unbilledOnly: true });
      setSavedFlatFees(fees || []);
    } catch (err) {
      console.error('Error loading flat fees:', err);
      setError(getErrorMessage(err, 'Failed to load flat fees'));
    } finally {
      setLoadingFlatFees(false);
    }
  }, [lawFirmId, matterId, matterBillingContext]);

  const handleSaveFlatFee = async (fee: { id: string; description: string; amount: number; date?: string | null }) => {
    if (!fee.description.trim() || fee.amount <= 0) {
      setError("Please provide a description and amount for the flat fee");
      return;
    }

    setSavingFlatFeeId(fee.id);
    try {
      await billingService.addFlatFee(matterBillingContext, {
        description: fee.description.trim(),
        amount: fee.amount,
        date: fee.date || null,
      });

      // Remove from new flat fees and reload saved ones
      setNewFlatFees(prev => prev.filter(f => f.id !== fee.id));
      await loadFlatFees();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save flat fee"));
    } finally {
      setSavingFlatFeeId(null);
    }
  };

  const handleUpdateFlatFee = async () => {
    if (!editingFlatFee) return;
    if (!editingFlatFee.description.trim() || editingFlatFee.amount <= 0) {
      setError("Please provide a description and amount for the flat fee");
      return;
    }

    setSavingFlatFeeId(editingFlatFee.id);
    try {
      await billingService.updateFlatFee(matterBillingContext, editingFlatFee.id, {
        description: editingFlatFee.description.trim(),
        amount: editingFlatFee.amount,
        date: editingFlatFee.date || null,
      });
      setEditingFlatFee(null);
      await loadFlatFees();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update flat fee"));
    } finally {
      setSavingFlatFeeId(null);
    }
  };

  const removeNewFlatFee = (id: string) => {
    setNewFlatFees(prev => prev.filter(f => f.id !== id));
  };

  const removeSavedFlatFee = async (id: string) => {
    try {
      setDeletingFlatFeeId(id);
      await billingService.removeFlatFee(matterBillingContext, id);
      await loadFlatFees();
    } finally {
      setDeletingFlatFeeId(null);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Load time entries, flat fees, and invoices when billing tab is active
  useEffect(() => {
    if (activeTab === 'billing' && matterData) {
      // Each read answers 403 without its own view permission, so only the
      // sections this viewer can see are loaded.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (canViewTimeEntries) loadTimeEntries();
      if (canViewInvoices) {
        loadFlatFees();
        loadMatterInvoices();
      }
    }
  }, [activeTab, matterData, canViewTimeEntries, canViewInvoices, loadTimeEntries, loadFlatFees, loadMatterInvoices]);

  // Trust balance for the matter's clients, shown in the billing tab callout.
  //
  // Read from the firm-wide balance report, which carries per-client balances,
  // so this is ONE request however many clients the matter has. It used to be
  // one request per client, all fired at once, against an API instance with a
  // twelve-connection Postgres pool.
  //
  // Held back until the billing tab is open AND the plan includes trust
  // accounting: the trust routes answer 403 without `trustAccounting`, so
  // asking earlier spends a doomed request.
  //
  // The report resolves a client by its UUID (`clients.id`), not the linked
  // portal user's Firebase UID, so pass `c.id`.
  const { balances: matterTrustBalances } = useMatterTrustBalances(
    lawFirmId,
    matterClients,
    activeTab === 'billing' && features.trustAccounting && canViewTrust,
  );



  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  // `error` is shared by the initial matter load AND every action handler on
  // this page (add/remove a member, remove a client, delete the matter, ...).
  // Gating this fallback on `error` as well as `!matterData` used to mean a
  // FAILED ACTION - the matter loaded fine, then e.g. its delete was refused -
  // blanked the whole page into "Matter not found", discarding a matter that
  // was right there in state the whole time. Once `matterData` is populated it
  // is never cleared by an action failure, so `!matterData` alone is the
  // correct "we have nothing to show" check; a later action error is surfaced
  // by the banner below instead of hiding the page that error is about.
  if (!matterData) {
    return (
      <div className="min-h-screen bg-page">
        <div className="p-6 max-w-[1600px] mx-auto">
          {error && <ErrorNotification error={error} onRetry={() => void loadMatter()} className="mb-4" />}
          <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
            <Briefcase size={32} className="text-on-surface-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-on-surface mb-1">Matter not found</p>
            <p className="text-xs text-on-surface-muted">
              This matter may have been removed from your law firm.
            </p>
          </div>
          <Button
            onClick={() => navigate(`/lawfirm/${lawFirmId}/matters`)}
            type="secondary"
            className="mt-4"
            icon={<ArrowLeft className="h-4 w-4" />}
          >
            Back to Matters
          </Button>
        </div>
      </div>
    );
  }

  const leadNames = getMatterLeadNames(matterData, users);
  const createdByUser = users.find(u => u.uid === matterData.createdBy);

  // Counts shown beside a tab's label. A tab with no entry here renders its label alone.
  const tabCounts: Partial<Record<(typeof MATTER_TABS)[number]['value'], number>> = {
    tasks: matterTasks.length,
    events: totalEventsCount,
    clients: matterClients.length,
    team: matterData.members?.length || 0,
    notes: matterData.totalNotes || 0,
  };





  return (
    <div className="min-h-screen bg-page">
    <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
      {/* A failed ACTION (as opposed to the initial load, handled above) shows
          here, above every tab, rather than only on the Billing tab that used
          to render its own copy of this same `error` state. */}
      <ErrorNotification error={error} onClose={() => setError(null)} />

      {/* Unbordered: the TabBar right below draws the one rule this page shows
          between its header and body. */}
      <PageHeader
        bordered={false}
        leading={<BackButton href={`/lawfirm/${lawFirmId}/matters`} label="Back to Matters" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{matterData.name}</span>
            <MatterStatusBadge status={matterData.status} />
            {matterData.paymentOngoing && <PaymentOngoingBadge />}
          </span>
        }
        description={matterData.matterReferenceId ? `Matter ID: ${matterData.matterReferenceId}` : undefined}
        actions={
          (canUpdateMatter || canDeleteThisMatter) && (
            <>
              {canUpdateMatter && (
                <Button
                  onClick={handleEdit}
                  type="secondary"
                  size="compact"
                  icon={<Pencil size={14} strokeWidth={2.2} />}
                >
                  Edit
                </Button>
              )}
              {canDeleteThisMatter && (
                <Button
                  onClick={() => setDeleteDialogOpen(true)}
                  type="danger"
                  size="compact"
                  icon={<Trash2 size={14} strokeWidth={2.2} />}
                >
                  Delete
                </Button>
              )}
            </>
          )
        }
      />

      {/* Tabbed Interface */}
      <div>
        <TabBar
          value={activeTab}
          onChange={setActiveTab}
          tabs={MATTER_TABS
            .filter((tab) => isMatterTabShown(tab.value, hasPermission))
            .map((tab) => ({ value: tab.value, label: tab.label, count: tabCounts[tab.value] }))}
        />

        <div className="pt-6 pr-2 -mr-2 min-w-0 overflow-x-hidden">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6 min-w-0">
              {/* Pipeline stage tracker */}
              <MatterStageBar
                lawFirmId={lawFirmId}
                matter={matterData}
                canEdit={canUpdateMatter}
                onChanged={() => loadMatter(false)}
              />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
              {/* Matter Details */}
              <div className={`${CARD_CLASS} lg:col-span-2 min-w-0`}>
                <h3 className="text-sm font-semibold text-on-surface mb-4">Matter Information</h3>
                <div className="min-w-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-w-0">
                    <DetailField label="Matter Number" value={matterData.matterNumber} />
                    <DetailField
                      label={leadNames.length > 1 ? "Leads" : "Lead"}
                      value={leadNames.length ? leadNames.join(", ") : undefined}
                      empty="Unassigned"
                    />
                    <DetailField label="Practice Area" value={matterData.practiceAreaName} />
                    <DetailField label="Court" value={matterData.courtName} />
                    <DetailField label="Category">
                      {matterData.category ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {matterData.category.split(' > ').map((part, index, parts) => (
                            <span key={index} className="inline-flex items-center">
                              <span className="inline-flex items-center rounded-full bg-surface-alt px-2.5 py-0.5 text-xs font-medium text-on-surface-secondary">
                                {part}
                              </span>
                              {index < parts.length - 1 && (
                                <ChevronRight size={12} className="mx-1.5 text-on-surface-muted" aria-hidden="true" />
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm font-medium text-on-surface-muted italic mt-1">Not specified</p>
                      )}
                    </DetailField>
                    <DetailField label="Created By" value={createdByUser?.name} empty="Unknown" />
                    <DetailField
                      label="Created"
                      value={(matterData.createdAtLocalDisplay || matterData.createdAt)
                        ? dayjs(matterData.createdAt).format('MMM DD, YYYY')
                        : undefined}
                      empty="Not available"
                    />
                    <DetailField label="Billing Method">
                      <p className="text-sm font-medium text-on-surface mt-1">
                        {MATTER_BILLING_METHOD_LABELS[matterData.billingMethod || 'hourly']}
                        {matterData.isBillable === false && (
                          <span className="ml-2 text-xs text-on-surface-muted">(non-billable)</span>
                        )}
                      </p>
                    </DetailField>
                    <DetailField
                      label="Opened"
                      value={matterData.openDate ? dayjs(matterData.openDate).format('MMM DD, YYYY') : undefined}
                      empty="Not set"
                    />
                    {matterData.closeDate && (
                      <DetailField label="Closed" value={dayjs(matterData.closeDate).format('MMM DD, YYYY')} />
                    )}
                    <DetailField label="Statute of Limitations">
                      {matterData.statuteOfLimitationsDate ? (
                        <p className={`text-sm font-medium mt-1 ${solUrgencyClass(matterData.statuteOfLimitationsDate)}`}>
                          {dayjs(matterData.statuteOfLimitationsDate).format('MMM DD, YYYY')}
                          {(() => {
                            const days = dayjs(matterData.statuteOfLimitationsDate).startOf('day').diff(dayjs().startOf('day'), 'day');
                            if (days < 0) return <span className="ml-2 text-xs">(passed)</span>;
                            if (days <= 30) return <span className="ml-2 text-xs">({days}d left)</span>;
                            return null;
                          })()}
                        </p>
                      ) : (
                        <p className="text-sm font-medium text-on-surface-muted italic mt-1">Not set</p>
                      )}
                    </DetailField>
                  </div>

                {matterData.description && (
                  <div className="mt-6 pt-6 border-t border-outline-subtle">
                    <span className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wide block mb-2">Description</span>
                    <p className="text-sm text-on-surface leading-relaxed">{matterData.description}</p>
                  </div>
                )}

                {/* Quick Add Files - like task attachments */}
                <div className="mt-6 pt-6 border-t border-outline-subtle">
                  <MatterFileQuickAdd
                    lawFirmId={lawFirmId}
                    matterId={matterId}
                    onError={(msg) => msg != null && setError(msg)}
                    onViewFiles={() => { setActiveTab("documents"); setDocumentsSubTab("files"); }}
                  />
                </div>
              </div>
              </div>

              {/* Sidebar: quick stats, upcoming events, upcoming tasks */}
              <div className="space-y-4 min-w-0">
                <div className="grid grid-cols-2 gap-3">
                  <StatTile label="Clients" value={matterClients.length} icon={Users} onClick={() => setActiveTab('clients')} />
                  <StatTile label="Team" value={matterData.members?.length || 0} icon={UserRound} onClick={() => setActiveTab('team')} />
                  <StatTile label="Notes" value={matterData.totalNotes || 0} icon={StickyNote} onClick={() => setActiveTab('notes')} />
                  <StatTile label="Tasks" value={matterTasks.length} icon={ClipboardList} onClick={() => setActiveTab('tasks')} />
                </div>

                {/* Upcoming Events */}
                <div className={CARD_CLASS}>
                  <h3 className="text-sm font-semibold text-on-surface mb-3">Upcoming Events</h3>
                  {overviewEvents.length === 0 ? (
                    <div className="text-xs text-on-surface-muted text-center py-4 rounded-lg border border-dashed border-outline-subtle">
                      No upcoming events
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {overviewEvents.slice(0, 2).map((ev) => {
                        const isPast = isPastInstant(ev.date);
                        return (
                          <button
                            key={ev.id}
                            type="button"
                            onClick={() => setActiveTab('events')}
                            className="w-full text-left p-3 rounded-lg border text-xs bg-surface-alt border-outline-subtle hover:bg-surface-hover transition-colors cursor-pointer"
                          >
                            <StatusBadge variant={isPast ? "danger" : "info"}>
                              {matterEventTypeMeta(ev.type).label}
                              {isPast && ' · Overdue'}
                            </StatusBadge>
                            <p className="font-medium text-on-surface truncate mt-1.5">{ev.title}</p>
                            <p className="text-on-surface-muted mt-0.5">{ev.dateLocalDisplay || (ev.date ? new Date(ev.date).toLocaleString() : '')}</p>
                          </button>
                        );
                      })}
                      {overviewEvents.length > 2 && (
                        <button
                          onClick={() => setActiveTab('events')}
                          className="w-full text-xs text-accent-emphasis hover:underline py-1 cursor-pointer"
                        >
                          +{overviewEvents.length - 2} more
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Upcoming Tasks */}
                <div className={CARD_CLASS}>
                  <h3 className="text-sm font-semibold text-on-surface mb-3">Upcoming Tasks</h3>
                  {(() => {
                    const upcomingTasks = matterTasks
                      .filter((t) => t.status !== 'completed' && t.dueDate)
                      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());
                    if (upcomingTasks.length === 0) {
                      return (
                        <div className="text-xs text-on-surface-muted text-center py-4 rounded-lg border border-dashed border-outline-subtle">
                          No upcoming tasks
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-2">
                        {upcomingTasks.slice(0, 2).map((task) => {
                          const isOverdue = isTaskOverdue(task);
                          return (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() => setActiveTab('tasks')}
                              className="w-full text-left p-3 rounded-lg border text-xs bg-surface-alt border-outline-subtle hover:bg-surface-hover transition-colors cursor-pointer"
                            >
                              <div className="flex items-center gap-1.5 mb-1">
                                <TaskPriorityBadge priority={task.priority} />
                                {isOverdue && (
                                  <StatusBadge variant="danger">Overdue</StatusBadge>
                                )}
                              </div>
                              <p className="font-medium text-on-surface truncate">{task.title}</p>
                              <p className="text-on-surface-muted mt-0.5">
                                {task.dueDateLocalDisplay || (task.dueDate ? (toLocalDate(task.dueDate)?.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) ?? '') : '')}
                                {taskEndSuffix(task)}
                              </p>
                            </button>
                          );
                        })}
                        {upcomingTasks.length > 2 && (
                          <button
                            onClick={() => setActiveTab('tasks')}
                            className="w-full text-xs text-accent-emphasis hover:underline py-1 cursor-pointer"
                          >
                            +{upcomingTasks.length - 2} more
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              </div>

              {/* Custom fields (firm-defined, scoped by practice area) */}
              <MatterCustomFieldsCard
                lawFirmId={lawFirmId}
                matter={matterData}
                canEdit={canUpdateMatter}
                onSaved={() => loadMatter(false)}
              />

              {/* Chronological matter activity feed */}
              <div className="min-w-0">
                <MatterActivityFeed
                  lawFirmId={lawFirmId}
                  matterId={matterId}
                />
              </div>
            </div>
          )}

          {/* Clients Tab */}
          {activeTab === 'clients' && (
            <div>
              <div className="mb-4">
                <p className="text-sm text-on-surface-secondary">Clients linked to this matter and billed through it.</p>
              </div>
              <EntityClientsTab
                lawFirmId={lawFirmId}
                clients={matterClients.map((c) => ({
                  ...c,
                  canonicalClientId: c.canonicalClientId ?? undefined,
                }))}
                canManageClients={canManageClients}
                onAddClientClick={() => setAddClientModalOpen(true)}
                onEditClient={canEditClientRecords ? (client) => {
                  const found = matterClients.find((m) => m.id === client.id);
                  if (found) {
                    setEditingClient(found);
                    setEditClientModalOpen(true);
                  }
                } : undefined}
                onRemoveClient={(client) => {
                  const found = matterClients.find((m) => m.id === client.id);
                  if (found) handleRemoveClient(found);
                }}
                showSearch
                emptyTitle="No clients on this matter yet"
                emptyMessage="Add a client to link them to this matter and bill through it."
              />
            </div>
          )}

          {/* Team Tab */}
          {activeTab === 'team' && (
            <EntityTeamSection
              members={(matterData.members || []).map((m) => ({
                id: m.userId,
                name: m.name,
                email: m.email,
                role: m.role || "Team Member",
                hourlyRate: m.hourlyRate,
                isLead: m.role === "lead",
              }))}
              canManageTeam={canManageMembers}
              onAddMemberClick={() => setAddUserDialogOpen(true)}
              onRemoveMember={(m) => handleRemoveUser({ userId: m.id, name: m.name || undefined })}
            />
          )}

          {/* Time Tracking Tab */}
          {activeTab === 'time-tracking' && matterData && (
            <TimeTracking
              context={matterBillingContext}
              members={matterData.members || []}
              users={users}
              matterName={matterData.name || "Matter"}
              onRefresh={loadMatter}
              onGoToBilling={() => setActiveTab('billing')}
            />
          )}

          {/* Notes Tab */}
          {activeTab === 'notes' && (
            <div>
              <NotesSection
                lawFirmId={lawFirmId}
                parentType="matter"
                parentId={matterId}
                onAddNote={canUpdateMatter ? handleAddNote : undefined}
                onUpdateNote={canUpdateMatter ? handleUpdateNote : undefined}
                onDeleteNote={canUpdateMatter ? handleRetractNote : undefined}
                onAddTimeEntry={canManageTimeEntries ? handleAddTimeEntry : undefined}
                onUpdateTimeEntry={canManageTimeEntries ? handleUpdateTimeEntry : undefined}
                onRemoveTimeEntry={canManageTimeEntries ? handleRemoveTimeEntry : undefined}
                onSetPinned={canUpdateMatter ? handleSetNotePinned : undefined}
                onTaskCreated={() => void loadMatter(false)}
              />
            </div>
          )}

          {/* Billing Tab */}
          {activeTab === 'billing' && matterData && (
            <div className="relative">
              {/* Budget vs billed (burn-down) + billing method */}
              <MatterBudgetCard
                matter={matterData}
                className="mb-6"
                onEdit={canUpdateMatter ? () => setEditBillingModalOpen(true) : undefined}
              />
              <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-on-surface mb-2">Billing</h3>
                  <p className="text-sm text-on-surface-secondary">Manage hourly rates, flat fees, and track hours for this matter</p>
                </div>
                {canViewInvoices && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-3 shrink-0">
                    <Button
                      type="secondary"
                      size="compact"
                      onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices`)}
                      className="w-full sm:w-auto"
                    >
                      View Invoices
                    </Button>
                    {canManageInvoices && (
                      <Button
                        size="compact"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/generate-invoice`)}
                        icon={<Plus size={14} strokeWidth={2.2} />}
                        className="w-full sm:w-auto"
                      >
                        Create Invoice
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {canViewInvoices && (
                <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <BillingSummaryCard
                    label="Total Billed"
                    value={formatCurrency(billingSummary.totalBilled)}
                    subtitle={billingSummary.totalHours > 0 ? `${formatHoursMinutes(billingSummary.totalHours)} logged` : undefined}
                  />
                  <BillingSummaryCard label="Total Paid" value={formatCurrency(billingSummary.totalPaid)} />
                  <BillingSummaryCard
                    label="Outstanding"
                    value={formatCurrency(billingSummary.outstanding)}
                    highlight={billingSummary.outstanding > 0}
                  />
                  <BillingSummaryCard label="Unbilled Flat Fees" value={formatCurrency(billingSummary.unbilledFlatFees)} />
                </div>
              )}

              {loadingTimeEntries && (
                <div className="absolute inset-0 bg-surface/80 backdrop-blur-sm flex items-center justify-center z-10 rounded-lg">
                  <LoadingSpinner />
                </div>
              )}

              {/* Trust balance callout */}
              {matterTrustBalances.length > 0 && (
                <div className="mb-4 flex items-start gap-3 rounded-2xl bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-4 py-3">
                  <Landmark className="w-4 h-4 text-accent-emphasis mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-accent-emphasis dark:text-accent-emphasis">
                      Trust funds available
                    </p>
                    <p className="text-xs text-accent-emphasis dark:text-accent-emphasis mt-0.5">
                      {matterTrustBalances.map((b) => (
                        <span key={b.clientId} className="mr-3">
                          {b.clientName}: {formatCurrency(b.totalBalanceCents / 100)}
                        </span>
                      ))}
                      Can be applied to invoices when recording payment
                    </p>
                  </div>
                </div>
              )}

              {canViewInvoices && (
                <>
                {/* Upcoming Invoice Payments Section */}
                <div className="mb-6 bg-surface rounded-2xl border border-outline-subtle p-4 md:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-semibold text-on-surface">Upcoming Invoice Payments</h4>
                    <button
                      onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices`)}
                      className="text-sm text-accent-emphasis hover:text-accent-emphasis-hover font-medium cursor-pointer"
                    >
                      View all
                    </button>
                  </div>
                  {loadingMatterInvoices ? (
                    <ListSkeleton rows={4} label="Loading upcoming invoices" bordered={false} />
                  ) : matterInvoices.length === 0 ? (
                    <ListEmptyState
                      compact
                      icon={<FileText size={32} />}
                      title="No invoices yet"
                      message={canManageInvoices ? "Use Create Invoice above to create one." : "Invoices for this matter will appear here."}
                    />
                  ) : (
                    <div className="space-y-2">
                      {sortInvoicesForList(matterInvoices, "nextPayment")
                        .slice(0, 5)
                        .map((invoice) => {
                          const statusKey = getInvoiceStatusKey(invoice);
                          const { label: statusLabel, variant: statusVariant } = getInvoiceStatus(invoice);
                          const displayAmount = getInvoiceTotal(invoice);
                          const remaining = getInvoiceRemainingBalance(invoice);
                          const nextPayment = getInvoiceNextPaymentInfo(invoice);
                          const planPayments = invoice.paymentPlan?.expectedPayments || [];
                          const nextPlanIndex = invoice.paymentPlan?.enabled
                            ? planPayments.findIndex((payment) => payment.status === "pending" || payment.status === "overdue")
                            : -1;
                          const isSettled = isClosedStatusKey(statusKey);
                          const isOverdue = !isSettled && !!nextPayment.date &&
                            isBeforeToday(nextPayment.date);

                          return (
                            <button
                              key={invoice.id}
                              type="button"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${invoice.id}`)}
                              className="w-full flex items-center justify-between gap-4 p-3 rounded-lg border border-outline hover:bg-surface-hover transition-colors text-left cursor-pointer"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-medium text-on-surface truncate">{getInvoiceDisplayName(invoice)}</p>
                                  {invoice.paymentPlan?.enabled && (
                                    <StatusBadge variant="purple">Payment plan</StatusBadge>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-2 mt-0.5">
                                  <p className="text-xs text-on-surface-muted">
                                    {invoice.invoiceDate ? dayjs(invoice.invoiceDate).format('MMM D, YYYY') : 'No date'}
                                    {invoice.clientName ? ` · ${invoice.clientName}` : ''}
                                  </p>
                                  {!isSettled && nextPayment.fromPlan && nextPayment.date ? (
                                    <p className={`text-xs font-medium ${isOverdue ? 'text-red-600 dark:text-red-400' : 'text-on-surface-secondary'}`}>
                                      · {nextPlanIndex >= 0 && `Installment ${nextPlanIndex + 1} of ${planPayments.length} · `}
                                      Due {dayjs(nextPayment.date).format('MMM D, YYYY')}
                                      {isOverdue ? ' · Overdue' : ''}
                                    </p>
                                  ) : !isSettled && nextPayment.date ? (
                                    <p className={`text-xs font-medium ${isOverdue ? 'text-red-600 dark:text-red-400' : 'text-on-surface-secondary'}`}>
                                      · Due {dayjs(nextPayment.date).format('MMM D, YYYY')}{isOverdue ? ' · Overdue' : ''}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
                                <div className="text-right">
                                  <p className="text-sm font-semibold text-on-surface">
                                    {formatCurrency(!isSettled && remaining > 0 ? remaining : displayAmount)}
                                  </p>
                                  {!isSettled && nextPayment.fromPlan && nextPayment.amount != null ? (
                                    <p className="text-xs text-on-surface-muted tabular-nums">
                                      Next: {formatCurrency(Number(nextPayment.amount))}
                                    </p>
                                  ) : remaining > 0 && remaining < displayAmount ? (
                                    <p className="text-xs text-on-surface-muted">{formatCurrency(remaining)} remaining</p>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>

                {/* Flat Fees Section */}
                <div className="mb-6 flex flex-col bg-surface rounded-2xl border border-outline-subtle p-4 md:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                    <div>
                      <h4 className="text-sm font-semibold text-on-surface">Flat Fees</h4>
                      <p className="text-xs text-on-surface-muted mt-0.5">Manage saved unbilled flat fees for this matter, or add a new one to invoice later.</p>
                    </div>
                    {/* Every flat-fee write route requires billing.manageInvoices,
                        so a member without it sees the fees and no controls. */}
                    {canManageInvoices && (
                      <Tooltip
                        title={newFlatFees.length >= MAX_OPEN_FLAT_FEES ? `You can have up to ${MAX_OPEN_FLAT_FEES} unsaved flat fees open at once. Save or remove one to add more.` : ""}
                        enterDelay={300}
                      >
                        <span className="w-full sm:w-auto">
                          <Button
                            onClick={() => {
                              if (newFlatFees.length >= MAX_OPEN_FLAT_FEES) return;
                              const newFee = {
                                id: `flat-fee-${Date.now()}`,
                                description: "",
                                amount: 0,
                                date: "",
                              };
                              setNewFlatFees([newFee, ...newFlatFees]);
                            }}
                            disabled={newFlatFees.length >= MAX_OPEN_FLAT_FEES}
                            type="secondary"
                            size="small"
                            className="w-full sm:w-auto"
                          >
                            + Add Flat Fee
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                  </div>

                  {/* Saved Flat Fees */}
                  {loadingFlatFees ? (
                    <ListSkeleton rows={4} label="Loading flat fees" />
                  ) : savedFlatFees.length > 0 ? (
                    <div className="order-2">
                      <h5 className="text-sm font-medium text-on-surface-secondary mb-3">Saved Unbilled Flat Fees</h5>
                      <div className="space-y-2">
                        {flatFeesPager.pagedRows.map((fee) => (
                          editingFlatFee?.id === fee.id ? (
                            <FlatFeeEditorRow
                              key={fee.id}
                              fee={editingFlatFee}
                              onChange={setEditingFlatFee}
                              onSave={handleUpdateFlatFee}
                              onDiscard={() => setEditingFlatFee(null)}
                              saving={savingFlatFeeId === fee.id}
                              saveLabel="Save"
                              discardAs="button"
                            />
                          ) : (
                            <FlatFeeSavedRow
                              key={fee.id}
                              fee={fee}
                              onEdit={canManageInvoices ? () => setEditingFlatFee({
                                id: fee.id,
                                description: fee.description,
                                amount: fee.amount,
                                date: fee.date || '',
                              }) : undefined}
                              onDelete={canManageInvoices ? () => removeSavedFlatFee(fee.id) : undefined}
                              deleting={deletingFlatFeeId === fee.id}
                              disabled={Boolean(editingFlatFee)}
                            />
                          )
                        ))}
                        {flatFeesPager.total > flatFeesPager.rowsPerPage && (
                          <AutoPager pager={flatFeesPager} />
                        )}
                      </div>
                    </div>
                  ) : null}

                  {/* New Flat Fees (not yet saved) */}
                  <div className="order-1 mb-6 space-y-3">
                    {newFlatFees.map((fee) => (
                      <FlatFeeEditorRow
                        key={fee.id}
                        fee={fee}
                        onChange={(next) => setNewFlatFees(newFlatFees.map(f => (f.id === fee.id ? next : f)))}
                        onSave={() => handleSaveFlatFee(fee)}
                        onDiscard={() => removeNewFlatFee(fee.id)}
                        saving={savingFlatFeeId === fee.id}
                        saveLabel="Done"
                        discardAs="trash"
                      />
                    ))}
                    {newFlatFees.length === 0 && savedFlatFees.length === 0 && (
                      <p className="text-sm text-on-surface-muted text-center py-4">
                        {canManageInvoices
                          ? 'No unbilled flat fees available. Click "Add Flat Fee" to add charges like driving time or filing fees.'
                          : "No unbilled flat fees available."}
                      </p>
                    )}
                  </div>
                  {(savedFlatFees.length > 0 || newFlatFees.length > 0) && (
                    <div className="order-3 mt-4 pt-4 border-t border-outline">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-on-surface-secondary">Total Unbilled Flat Fees:</span>
                        <span className="text-lg font-semibold text-on-surface">
                          {formatCurrency([...savedFlatFees, ...newFlatFees].reduce((sum, fee) => sum + fee.amount, 0))}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                </>
              )}

              {canViewTimeEntries && (
                <div className="space-y-4">
                    {matterData.members && matterData.members.length > 0 ? (() => {
                      // Members with logged hours or a set rate are the ones that matter for
                      // billing, so surface them first (busiest on top) and collapse the rest.
                      const COLLAPSE_MIN = 6;
                      const withStats = matterData.members.map((member: Member) => ({
                        member,
                        userHours: getTotalHoursForUser(member.userId),
                        isActive:
                          getTotalHoursForUser(member.userId) > 0 ||
                          (member.hourlyRate !== null && member.hourlyRate !== undefined),
                      }));
                      const ordered = [
                        ...withStats.filter((m) => m.isActive).sort((a, b) => b.userHours - a.userHours),
                        ...withStats.filter((m) => !m.isActive),
                      ];
                      const activeCount = withStats.filter((m) => m.isActive).length;
                      const collapsible = ordered.length > COLLAPSE_MIN;
                      const visible =
                        collapsible && !showAllBillingMembers
                          ? ordered.slice(0, Math.max(activeCount, COLLAPSE_MIN))
                          : ordered;
                      const hiddenCount = ordered.length - visible.length;

                      return (
                        <>
                          {visible.map(({ member, userHours }) => {
                        const userAmount = getTotalAmountForUser(member.userId, member.hourlyRate);
                        const isEditingRate = editingBillingRate?.userId === member.userId;

                        return (
                          <div key={member.userId} className="border border-outline-subtle rounded-2xl p-4 bg-surface-alt">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h4 className="font-semibold text-on-surface">{member.name || 'Unknown'}</h4>
                                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                                  <div>
                                    <span className="text-on-surface-secondary">Matter Rate</span>
                                    <Tooltip
                                      title="Per-matter hourly rate for this member. When set, it takes priority over client rates, charge code rates, and the member's default rate."
                                      enterDelay={300}
                                    >
                                      <span className="text-on-surface-muted cursor-help ml-1">ⓘ</span>
                                    </Tooltip>
                                    <span className="text-on-surface-secondary">:</span>
                                    {isEditingRate && canManageMembers ? (
                                      <div className="flex items-center gap-2 mt-1">
                                        <input
                                          type="number"
                                          min="0"
                                          step="0.01"
                                          value={editingBillingRate.value}
                                          onChange={(e) => setEditingBillingRate({ ...editingBillingRate, value: e.target.value })}
                                          className="w-24 px-2 py-1 text-sm border border-input-border rounded bg-input-bg text-on-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                              handleUpdateBillingRate(member.userId, editingBillingRate.value);
                                            } else if (e.key === "Escape") {
                                              setEditingBillingRate(null);
                                            }
                                          }}
                                          autoFocus
                                        />
                                        <button
                                          onClick={() => handleUpdateBillingRate(member.userId, editingBillingRate.value)}
                                          disabled={updatingBillingRate}
                                          className="text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 disabled:opacity-50 text-xs cursor-pointer"
                                        >
                                          ✓
                                        </button>
                                        <button
                                          onClick={() => setEditingBillingRate(null)}
                                          className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-xs cursor-pointer"
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="mt-1">
                                        <span className="text-on-surface font-medium">
                                          {member.hourlyRate !== null && member.hourlyRate !== undefined
                                            ? formatCurrency(member.hourlyRate)
                                            : "Not set"}
                                        </span>
                                        {canManageMembers && (
                                          <button
                                            onClick={() =>
                                              setEditingBillingRate({
                                                userId: member.userId,
                                                value:
                                                  member.hourlyRate !== null && member.hourlyRate !== undefined
                                                    ? member.hourlyRate.toString()
                                                    : "",
                                              })
                                            }
                                            className="ml-2 text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover text-xs cursor-pointer"
                                          >
                                            Edit
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <span className="text-on-surface-secondary">Total Hours:</span>
                                    <div className="mt-1 text-on-surface font-medium">{formatHoursMinutes(userHours)}</div>
                                  </div>
                                  <div>
                                    <span className="text-on-surface-secondary">Total Amount:</span>
                                    <div className="mt-1 text-on-surface font-medium">{formatCurrency(userAmount)}</div>
                                  </div>
                                </div>
                              </div>
                              <Button type="secondary" size="small" onClick={() => handleAddHours(member.userId)}>
                                Log Time
                              </Button>
                            </div>
                          </div>
                        );
                          })}
                          {collapsible && (
                            <button
                              type="button"
                              onClick={() => setShowAllBillingMembers((v) => !v)}
                              className="w-full py-2 text-sm font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover hover:bg-surface-hover rounded-lg border border-outline transition-colors cursor-pointer"
                            >
                              {showAllBillingMembers
                                ? "Show fewer"
                                : `Show ${hiddenCount} member${hiddenCount === 1 ? "" : "s"} with no hours`}
                            </button>
                          )}
                        </>
                      );
                    })() : (
                      <div className="text-center py-12 text-on-surface-muted">
                        <p>No team members found. Add members to the matter to start tracking billing.</p>
                      </div>
                    )}
                  </div>
              )}
            </div>
          )}

          {/* Tasks Tab */}
          {activeTab === 'tasks' && (
            matterTasksError ? (
              <ErrorNotification error={matterTasksError} onRetry={() => void loadMatter(false)} />
            ) : (
              <EntityTasksTab
                lawFirmId={lawFirmId}
                tasks={matterTasks}
                // Each action is offered on its own permission: New Task on
                // tasks.create, Edit on tasks.update, Delete on tasks.delete.
                canManageTasks={canCreateTask || canUpdateTask || canDeleteTask}
                onCreateTaskClick={canCreateTask ? handleOpenCreateTask : undefined}
                onEditTask={canUpdateTask ? editTask.openWith : undefined}
                onDeleteTask={canDeleteTask ? handleDeleteTask : undefined}
                emptyTitle="No tasks found for this matter"
                emptyMessage="Create a task to link it to this matter."
              />
            )
          )}

          {/* Documents Tab: files and document requests grouped together. The
              segmented control only appears when the user can request documents;
              otherwise this tab is just the file browser. */}
          {activeTab === 'documents' && (
            <div>
              {canRequestDocuments && (
                <SegmentedToggle
                  className="mb-5"
                  ariaLabel="Documents view"
                  value={documentsSubTab}
                  onChange={setDocumentsSubTab}
                  options={[
                    { value: 'files', label: 'Files', icon: FolderOpen },
                    { value: 'requests', label: 'Requests', icon: ClipboardList },
                  ]}
                />
              )}

              {!canRequestDocuments || documentsSubTab === 'files' ? (
                <FilesSection
                  lawFirmId={lawFirmId}
                  matterId={matterId}
                  onError={(error) => setError(error)}
                  shareClients={matterClients.map((c) => ({ id: c.id, name: c.name || "Client", userId: c.userId }))}
                  initialTrail={revealTrail}
                  highlightFileId={revealHighlightId}
                />
              ) : (
                <DocumentRequestsPanel
                  lawFirmId={lawFirmId}
                  matterId={matterId}
                  clients={matterClients.map((c) => ({ id: c.id, name: c.name || "Client" }))}
                  onRevealFile={handleRevealFile}
                />
              )}
            </div>
          )}

          {/* Events Tab */}
          {activeTab === 'events' && (
            <MatterEventsTab
              lawFirmId={lawFirmId}
              matterId={matterId}
              canManage={canUpdateMatter}
              courtId={matterData.courtId}
              courtName={matterData.courtName}
              onEventsChange={handleEventsChange}
            />
          )}

          {/* Messages Tab */}
          {activeTab === 'messages' && canViewMessaging && user && (
            <MatterMessagesTab
              lawFirmId={lawFirmId}
              matterId={matterId}
              currentUserId={user.uid}
            />
          )}

          {/* Contacts Tab (non-client parties: opposing counsel, judge, witnesses, ...) */}
          {activeTab === 'contacts' && (
            <MatterContactsTab
              lawFirmId={lawFirmId}
              matterId={matterId}
              canEdit={canUpdateMatter}
            />
          )}

        </div>
      </div>



      {/* Edit Matter Modal */}
      {mounted && canUpdateMatter && (
        <EditMatterModal
          open={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          lawFirmId={lawFirmId}
          users={users}
          matterItem={matterData}
          onAfter={loadMatter}
        />
      )}

      {mounted && canUpdateMatter && matterData && (
        <EditMatterBillingModal
          open={editBillingModalOpen}
          onClose={() => setEditBillingModalOpen(false)}
          lawFirmId={lawFirmId}
          matter={matterData}
          onAfter={loadMatter}
        />
      )}





      {/* Add Client Modal */}
      {canManageClients && (
        <AddClientModal
          open={addClientModalOpen}
          onClose={() => setAddClientModalOpen(false)}
          lawFirmId={lawFirmId}
          matterId={matterId}
          onAfter={loadMatter}
          existingMatterClientIds={matterClients.map((c) => c.id)}
        />
      )}

      {/* Create Task Modal */}
      {canCreateTask && (
        <CreateTaskModal
          open={createTask.open}
          onClose={() => createTask.setOpen(false)}
          lawFirmId={lawFirmId}
          users={users.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
          courts={courts}
          courtsLoading={courtsLoading}
          updateCourtAddress={updateCourtAddress}
          canLinkCourtAddress={canManageCourts}
          create={createTask}
        />
      )}

      {/* Edit Task Modal */}
      {canUpdateTask && (
        <EditTaskModal
          open={editTask.open}
          onClose={() => editTask.setOpen(false)}
          lawFirmId={lawFirmId}
          users={users.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
          courts={courts}
          courtsLoading={courtsLoading}
          updateCourtAddress={updateCourtAddress}
          canLinkCourtAddress={canManageCourts}
          edit={editTask}
        />
      )}

      {/* Edit Client Modal */}
      {canManageClients && canEditClientRecords && (
        <EditClientModal
          open={editClientModalOpen}
          onClose={() => {
            setEditClientModalOpen(false);
          }}
          lawFirmId={lawFirmId}
          client={editingClient}
          onAfter={loadMatter}
        />
      )}

      {/* Add Users Dialog */}
      {canManageMembers && (() => {
        const existingMemberIds = new Set((matterData?.members ?? []).map((m) => m.userId));
        // Exclude clients only; show everyone else
        const nonClientUsers = users.filter((u) => u.userType !== "client");
        const availableUsers = nonClientUsers.filter((u) => !existingMemberIds.has(u.uid));
        const filteredAvailable = addMemberSearch.trim()
          ? availableUsers.filter(
              (u) =>
                (u.name ?? "").toLowerCase().includes(addMemberSearch.toLowerCase()) ||
                (u.email ?? "").toLowerCase().includes(addMemberSearch.toLowerCase())
            )
          : availableUsers;
        return (
          <Modal
            isOpen={addUserDialogOpen && canManageMembers}
            onClose={closeAddUserDialog}
            dismissible={!addingUsers}
            title="Add Users to Matter"
            closeIcon="✕"
            size="md"
            bodyClassName="px-6 py-4"
            footer={
              <>
                <Button
                  type="secondary"
                  onClick={closeAddUserDialog}
                  disabled={addingUsers}
                >
                  Cancel
                </Button>
                <Button
                  type="primary"
                  onClick={handleAddUsers}
                  disabled={selectedUsers.length === 0 || availableUsers.length === 0}
                  loading={addingUsers}
                >
                  Add
                </Button>
              </>
            }
          >
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Select team members to add
            </label>
            {availableUsers.length === 0 ? (
              <p className="text-sm text-on-surface-muted py-6 text-center">
                All firm members are already on this matter.
              </p>
            ) : (
              <>
                <input
                  type="search"
                  placeholder="Search by name or email..."
                  value={addMemberSearch}
                  onChange={(e) => setAddMemberSearch(e.target.value)}
                className="mb-3 w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
                <div className="max-h-56 overflow-y-auto rounded-md border border-outline bg-surface-alt styled-scrollbar">
                  {filteredAvailable.length === 0 ? (
                    <p className="text-sm text-on-surface-muted py-4 text-center">No matches</p>
                  ) : (
                    <ul className="py-1">
                      {filteredAvailable.map((user) => {
                        const isSelected = selectedUsers.some((u) => u.uid === user.uid);
                        return (
                          <li key={user.uid}>
                            <label className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-surface-hover text-on-surface">
                              <Checkbox
                                checked={isSelected}
                                onChange={() => {
                                  setSelectedUsers((prev) =>
                                    isSelected ? prev.filter((u) => u.uid !== user.uid) : [...prev, user]
                                  );
                                }}
                              />
                              <span className="text-sm font-medium truncate">{user.name || user.email}</span>
                              {user.email && user.name && (
                                <span className="text-xs text-on-surface-muted truncate flex-shrink-0 max-w-[min(200px,40%)]">{user.email}</span>
                              )}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                {selectedUsers.length > 0 && (
                  <p className="text-xs text-on-surface-muted mt-2">
                    {selectedUsers.length} selected
                  </p>
                )}
              </>
            )}
          </Modal>
        );
      })()}

      {/* Remove User Confirmation Dialog */}
      <RemoveMemberConfirm
        isOpen={removeUserDialogOpen && canManageMembers}
        onClose={closeRemoveUserDialog}
        onConfirm={confirmRemoveUser}
        members={userToRemove ? [{ userId: userToRemove.userId, name: userToRemove.name, email: userToRemove.email }] : []}
        remainingMembers={matterData?.members ?? []}
        preview={removePreview}
        loading={removingUser}
      />

      {/* Remove Client Confirmation Dialog */}
      <Modal
        isOpen={removeClientDialogOpen && canManageClients}
        onClose={closeRemoveClientDialog}
        title="Remove Client from Matter?"
        closeIcon="✕"
        size="md"
        dismissible={!removingClient}
        bodyClassName="px-6 py-4"
        footer={
          <>
            <Button type="secondary" onClick={() => setRemoveClientDialogOpen(false)} disabled={removingClient}>
              Cancel
            </Button>
            <Button type="danger" onClick={confirmRemoveClient} disabled={removingClient}>
              {removingClient ? "Removing…" : "Remove"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-on-surface-secondary">
          Are you sure you want to remove &ldquo;{clientToRemove?.name}&rdquo; from this matter?
          They will no longer have access to this matter in the client portal.
        </p>
      </Modal>

      <TimeEntryModal
        open={addHoursModalOpen}
        onClose={resetAddHoursModal}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        defaultUserId={selectedBillingUser || user?.uid}
        defaultTarget={`matter:${matterId}`}
        scopeMatterId={matterId}
        prefill={timeEntryPrefill}
        onSuccess={async (result) => {
          await Promise.all([loadTimeEntries(), loadMatter()]);
          billNowRedirect(result);
        }}
      />

      {canDeleteTask && (
        <ConfirmModal
          isOpen={deleteTaskDialogOpen}
          onClose={closeDeleteTaskDialog}
          onConfirm={confirmDeleteTask}
          title="Delete Task"
          message={`Are you sure you want to delete "${taskToDelete?.title ?? ""}"? This action cannot be undone.`}
          confirmText="Delete"
          loading={deletingTask}
        />
      )}

      {canDeleteThisMatter && (
        <ConfirmModal
          isOpen={deleteDialogOpen}
          onClose={closeDeleteDialog}
          onConfirm={handleDelete}
          title="Delete Matter"
          message={`Are you sure you want to delete "${matterData?.name ?? ""}"? This action cannot be undone.`}
          confirmText="Delete"
          loading={deleting}
        />
      )}
    </div>
    </div>
  );
}
