"use client";

import BillingTab from "./ClientBillingTab";
import OverviewTab from "./ClientOverviewTab";

import {
buildClientScopedInvoices,
type ClientScopedInvoice
} from "@/components/clientComp/billingAwareness";
import ClientBillingTimeEntriesSection from "@/components/clientComp/ClientBillingTimeEntriesSection";
import ClientContactModal from "@/components/clientComp/ClientContactModal";
import ClientContacts from "@/components/clientComp/ClientContacts";
import ClientDocumentRequestsTab from "@/components/clientComp/ClientDocumentRequestsTab";
import ClientEventsTab from "@/components/clientComp/ClientEventsTab";
import ClientFilesTab from "@/components/clientComp/ClientFilesTab";
import ClientMessagesTab from "@/components/clientComp/ClientMessagesTab";
import IdentityVerifiedBadge from "@/components/clientComp/IdentityVerifiedBadge";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import CreateMatterModal from "@/components/matterComp/CreateMatterModal";
import EntityMattersTab from "@/components/matterComp/EntityMattersTab";
import NotesSection from "@/components/notesComp/NotesSection";
import SuccessNotification from "@/components/SuccessNotification";
import CreateTaskModal from "@/components/taskComp/CreateTaskModal";
import EditTaskModal from "@/components/taskComp/EditTaskModal";
import EntityTasksTab from "@/components/taskComp/EntityTasksTab";
import BackButton from "@/components/ui/BackButton";
import Button from "@/components/ui/Button";
import ClientStatusBadge from "@/components/ui/ClientStatusBadge";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ItemActionMenu,{ menuPositionFromEvent,type ItemMenuAction } from "@/components/ui/ItemActionMenu";
import ListPager,{ DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import PageHeader from "@/components/ui/PageHeader";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import { useClientCompanyRelationships } from "@/hooks/clientHooks/useClients";
import { useStripeStatus } from "@/hooks/billingHooks/useStripeStatus";
import useClientTasksPage from "@/hooks/clientHooks/useClientTasksPage";
import useClientMatterFiles from "@/hooks/fileHooks/useClientMatterFiles";
import { useEntityByIdsChunked } from "@/hooks/useEntityLookup";
import type { FolderCrumb } from "@/lib/files/filePaths";
import { getErrorMessage, isApiError } from "@/lib/utils/apiErrors";
import billingService from "@/services/billing.service";
import clientsService,{ type ClientSummary } from "@/services/clients.service";
import FilesService from "@/services/files.service";
import MattersService from "@/services/matters.service";
import privacyService from "@/services/privacy.service";
import TasksService from "@/services/tasks.service";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback,useEffect,useMemo,useState } from "react";

import ListSkeleton from "@/components/ui/ListSkeleton";
import TabBar from "@/components/ui/TabBar";
import Tooltip from "@/components/ui/Tooltip";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import useClientDetailEvents from "@/hooks/clientHooks/useClientDetailEvents";
import useCourts from "@/hooks/courtHooks/useCourts";
import useFirmConversations from "@/hooks/messagingHooks/useFirmConversations";
import { useCreateTask,useEditTask } from "@/hooks/taskHooks/useTasks";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { downloadJson } from "@/lib/utils/csv";
import type { BillingPlan,Client,Invoice } from "@/types";
import type { Matter } from "@/types/matter";
import type { Task } from "@/types/task";
import {
Building2,
ClipboardList,
Download,
Eye,
FolderOpen,
Mail,
MoreHorizontal,
Pencil,
Phone,
Plus,
Send,
Trash2,
User,
X
} from "lucide-react";


import type { ClientDetailTab as Tab } from "./clientDetailTypes";

// Ordered to match the matter detail page's tab strip (Overview, Tasks, Events,
// [relation tab], Contacts, Messages, Notes, Time Tracking, Billing, Documents),
// with "Matters" standing in for that page's "Clients"/"Team" tabs.
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "events", label: "Events" },
  { key: "matters", label: "Matters" },
  { key: "contacts", label: "Contacts" },
  { key: "messages", label: "Messages" },
  { key: "notes", label: "Notes" },
  { key: "time-tracking", label: "Time Tracking" },
  { key: "billing", label: "Billing" },
  { key: "documents", label: "Documents" },
];

// For a company client, the people tab (real linked Person clients now, not
// directory contacts - client_company_links migration) is promoted to right
// after Overview, since it's the primary way to see who's there, and
// relabeled "Related Clients" to match what it actually shows and the
// ClientContacts.tsx panel's own heading. A person client keeps the default
// order and "Contacts" label above (guardians/assistants, unchanged).
const COMPANY_TABS: { key: Tab; label: string }[] = [
  TABS[0],
  { key: "contacts", label: "Related Clients" },
  ...TABS.slice(1).filter((t) => t.key !== "contacts"),
];

type Props = {
  lawFirmId: string;
  clientId: string;
};

/**
 * How many tasks the create-invoice modal offers to link against. Well above any
 * plausible per-matter task count, and the picker is a dropdown rather than a
 * search field, so this is a ceiling rather than a page.
 */
const INVOICE_TASK_OPTION_LIMIT = 200;

const PREFERRED_CONTACT_LABELS: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  sms: "SMS",
  portal: "Portal",
};

// Stable reference so the picker's dependency arrays don't churn while the query
// is still loading.
const EMPTY_TASKS: Task[] = [];
const EMPTY_MATTERS: Matter[] = [];
const EMPTY_INVOICES: Invoice[] = [];
const EMPTY_PLANS: BillingPlan[] = [];

// The tabs that render the client's full matter list. Every other tab, and the
// header counts, work from the summary, so the list loads only when one of these
// opens.
const MATTER_LIST_TABS: ReadonlySet<Tab> = new Set<Tab>(["matters", "time-tracking", "events", "documents", "billing"]);

async function listAllClientMatters(lawFirmId: string, clientId: string): Promise<Matter[]> {
  const items: Matter[] = [];
  for (let page = 1; ; page += 1) {
    const result = await MattersService.getMattersPaged(lawFirmId, {
      clientId,
      page,
      limit: 500,
    });
    items.push(...result.matters);
    if (items.length >= result.totalItems || result.matters.length === 0) return items;
  }
}

async function listAllClientInvoices(lawFirmId: string, clientId: string): Promise<Invoice[]> {
  const items: Invoice[] = [];
  for (let page = 1; ; page += 1) {
    const result = await billingService.listFirmInvoicesPage(lawFirmId, {
      relatedClientId: clientId,
      includeDetails: true,
      page,
      limit: 200,
    });
    items.push(...result.invoices);
    if (items.length >= result.totalItems || result.invoices.length === 0) return items;
  }
}

export default function ClientDetail({ lawFirmId, clientId }: Props) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigation();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [clientNotFound, setClientNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [addClientModalOpen, setAddClientModalOpen] = useState(false);
  const [createMatterModalOpen, setCreateMatterModalOpen] = useState(false);
  const { hasPermission } = usePermissions();
  const canManageCourts = hasPermission("courts.manage");
  const canUpdateTask = hasPermission("tasks.update");
  const canDeleteTask = hasPermission("tasks.delete");
  const canManageClientRecord = hasPermission("clients.manage");
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  // The time-entry list read answers 403 without this, and it is not part of the
  // member baseline, so the Time Tracking tab is absent rather than failing.
  const canViewTimeEntries = hasPermission("billing.viewTimeEntries");
  // The invoice and plan reads answer 403 without this and are not part of the
  // member baseline, so the Billing tab is absent rather than showing empty data.
  const canViewInvoices = hasPermission("billing.viewInvoices");
  // The firm conversation list is gated on messaging.view by the backend, so a
  // role without it neither sees the Messages tab nor asks for the list.
  const canViewMessaging = hasPermission("messaging.view");
  const createTask = useCreateTask(lawFirmId, () => void tasksPage.refresh());
  const editTask = useEditTask(lawFirmId, () => void tasksPage.refresh());
  // The roster and courts feed only the create-matter and task modals,
  // so each loads when a modal that needs it first opens. The cache keys are
  // shared, so reopening does not refetch.
  const { users } = useLawFirmUsers(lawFirmId, createMatterModalOpen || createTask.open || editTask.open);
  const { courts, loading: courtsLoading, updateCourt } = useCourts(lawFirmId, createTask.open || editTask.open);
  const updateCourtAddress = (courtId: string, address: string) => updateCourt(courtId, { address });
  // Tasks roll up across every matter the client is on, so this is the one list
  // here that grows without bound. It reads a server page rather than the
  // client's whole task history, and `total` is what the counts above read.
  const tasksPage = useClientTasksPage(lawFirmId, clientId);
  // The task under the delete confirmation. Kept after the dialog closes so its
  // title stays on screen through the exit animation; the open flag drives it.
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
  const [deleteTaskOpen, setDeleteTaskOpen] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const handleDeleteTask = async () => {
    if (!taskToDelete || !canDeleteTask) return;
    setDeletingTask(true);
    try {
      await TasksService.deleteTask(lawFirmId, taskToDelete.taskId || taskToDelete.id);
      setDeleteTaskOpen(false);
      tasksPage.setPage(1);
      await tasksPage.refresh();
    } catch (err) {
      setDeleteTaskOpen(false);
      setError(getErrorMessage(err, "Failed to delete task"));
    } finally {
      setDeletingTask(false);
    }
  };
  // Shared with ClientMessagesTab via the ["firmConversations", lawFirmId] query
  // key, so the firm conversation list is fetched once.
  const { conversations } = useFirmConversations(
    lawFirmId,
    !!client?.userId && canViewMessaging,
    { clientId: client?.userId || undefined },
  );
  // Files and document requests share one "Documents" tab. Older ?tab=files /
  // ?tab=document-requests deep links still resolve: they open the Documents
  // tab on the matching sub-view. Mirrors the matter detail page.
  const initialTabParam = searchParams?.get('tab') || 'overview';
  const [requestedTab, setActiveTab] = useState<Tab>(() => {
    if (initialTabParam === 'files' || initialTabParam === 'document-requests') return 'documents';
    // A tab the viewer is not shown (Messages without messaging access) would
    // leave no panel on screen, so it falls back to the Overview too.
    if (initialTabParam === 'messages' && !canViewMessaging) return 'overview';
    return (['overview', 'matters', 'tasks', 'time-tracking', 'events', 'notes', 'contacts', 'messages', 'billing', 'documents'].includes(initialTabParam) ? initialTabParam : 'overview') as Tab;
  });
  // Derived rather than stored, so a link to Time Tracking or Billing stays alive
  // while the viewer's permissions load and falls back to the Overview once they
  // are known not to grant it.
  const activeTab: Tab =
    (requestedTab === "time-tracking" && !canViewTimeEntries)
    || (requestedTab === "billing" && !canViewInvoices)
      ? "overview"
      : requestedTab;
  const [documentsSubTab, setDocumentsSubTab] = useState<'files' | 'requests'>(
    initialTabParam === 'document-requests' ? 'requests' : 'files'
  );
  // The header counts and the Overview's billing figures, counted by the server.
  // Under the ["clients", lawFirmId] prefix so a client invalidation refreshes it.
  const summaryQuery = useQuery<ClientSummary>({
    queryKey: ["clients", lawFirmId, "summary", clientId],
    queryFn: () => clientsService.getClientSummary(lawFirmId, clientId),
    enabled: !!lawFirmId && !!clientId,
  });
  const summary = summaryQuery.data;

  // The full lists behind the tabs that render them, each loaded the first time
  // such a tab opens and kept when the viewer moves to another tab.
  const needsMatterList = MATTER_LIST_TABS.has(activeTab);
  const mattersQuery = useQuery({
    queryKey: ["clientDetail", lawFirmId, clientId, "matters"],
    queryFn: () => listAllClientMatters(lawFirmId, clientId),
    enabled: needsMatterList,
  });
  const matters = mattersQuery.data ?? EMPTY_MATTERS;
  const needsBillingLists = activeTab === "billing";
  const invoicesQuery = useQuery({
    queryKey: ["clientDetail", lawFirmId, clientId, "invoices"],
    queryFn: () => listAllClientInvoices(lawFirmId, clientId).catch(() => [] as Invoice[]),
    enabled: needsBillingLists,
  });
  const plansQuery = useQuery({
    queryKey: ["clientDetail", lawFirmId, clientId, "plans"],
    queryFn: () => billingService.listPlans(lawFirmId, { relatedClientId: clientId }).catch(() => [] as BillingPlan[]),
    enabled: needsBillingLists,
  });
  const relatedInvoices = invoicesQuery.data ?? EMPTY_INVOICES;
  const invoices = useMemo(() => relatedInvoices.filter((invoice) => invoice.contextType === "matter"), [relatedInvoices]);
  const directInvoices = useMemo(() => relatedInvoices.filter((invoice) => invoice.contextType === "client"), [relatedInvoices]);
  const billingPlans = plansQuery.data ?? EMPTY_PLANS;
  // A list tab waiting on its first load shows the same spinner the Files view
  // shows while its listing loads, rather than an empty state it has no data for.
  const tabListLoading = (needsMatterList && mattersQuery.isLoading)
    || (needsBillingLists && (invoicesQuery.isLoading || plansQuery.isLoading));
  // The matter list failing used to fail the whole page with this message; it
  // now reaches the page's error banner while a tab that needs the list is open.
  const mattersErrorMessage = needsMatterList && mattersQuery.error
    ? getErrorMessage(mattersQuery.error, "Failed to load client data")
    : null;

  // Shared with ClientEventsTab via the ["clientDetailEvents", ...] query key,
  // so the client events list is fetched once and drives the tab badge count.
  const { totalEvents: clientEventsCount } = useClientDetailEvents(lawFirmId, clientId);
  // Companies this (person) client is linked to via client_company_links.
  // Fetched once here rather than per-tab: every tab that widens to include a
  // linked company's items (Matters, Tasks, Events, Notes, Time Tracking,
  // Billing, Documents) needs the same id-to-name map to badge those rows.
  // A company client has no companies of its own to link to.
  const { relationships: companyRelationships, refresh: refreshCompanyRelationships } = useClientCompanyRelationships(
    lawFirmId,
    clientId,
    !!client && client.clientType !== "company",
  );
  const companyNames = useMemo(
    () => new Map(companyRelationships.map((relationship) => [relationship.companyClientId, relationship.companyName])),
    [companyRelationships],
  );
  // Stripe status gates the pay-by-card action. It depends on nothing else on
  // the page, so it starts with the page rather than after the client loads.
  const { status: stripeStatus } = useStripeStatus(lawFirmId);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [exportingClientData, setExportingClientData] = useState(false);
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [actionsMenuPos, setActionsMenuPos] = useState<{ anchorTop: number; anchorBottom: number; right: number } | null>(null);
  // Set by "Manage portal access" on the company's Related Clients tab
  // (?highlight=portal), so landing here draws the eye to whichever portal
  // action button is actually showing (Invite / Awaiting Signup / Revoke),
  // rather than leaving the visitor to find it themselves. Same 2s
  // flash-then-clear shape as handleRevealFile's file highlight.
  const [highlightPortalAction, setHighlightPortalAction] = useState(false);
  useEffect(() => {
    if (searchParams?.get('highlight') !== 'portal') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacts to a one-time deep-link query param on mount, not to component state
    setHighlightPortalAction(true);
    const timer = window.setTimeout(() => setHighlightPortalAction(false), 2000);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const canRequestDocuments = hasPermission("documents.request");
  // Files and document requests share one "Documents" tab, mirroring the matter
  // detail page. The toggle only appears when the user can request documents;
  // otherwise the tab is just the file browser.
  const showingFiles = !canRequestDocuments || documentsSubTab === "files";
  // Files tab: managing the files, or previewing what the client sees in their
  // portal instead.
  const [filesPreviewMode, setFilesPreviewMode] = useState(false);
  const documentsToggle = canRequestDocuments ? (
    <SegmentedToggle
      ariaLabel="Documents view"
      value={documentsSubTab}
      onChange={setDocumentsSubTab}
      options={[
        { value: 'files', label: 'Files', icon: FolderOpen },
        { value: 'requests', label: 'Requests', icon: ClipboardList },
      ]}
    />
  ) : null;
  // Mirrors the data-export route: `clients.view` is baseline for every member,
  // so exporting a client's personal data needs a client-management permission.
  const canExportClientData = hasPermission("clients.manage") || hasPermission("clients.erase");
  // Every entry in the "More actions" menu needs one of these, so the trigger
  // is hidden rather than opening an empty menu.
  const hasActionsMenu = hasPermission("clients.manage") || hasPermission("clients.erase");
  const hasClientEmail = Boolean(client?.email?.trim());


  // Matters belonging to this client, plus (per the widened `matters` query)
  // any matter belonging to a company this client is linked to. `client.matterIds`
  // is a lateral aggregate scoped to this exact client id and is never widened,
  // so it can only ever confirm the client's own matters. A matter that made it
  // into `matters` on a company link is recognized instead by its `clients`
  // array carrying one of the linked company ids.
  const deriveClientMatters = useCallback((eligibleCompanyIds: Set<string>) => {
    const matterIdSet = new Set((client?.matterIds || []).filter(Boolean));
    return matters.filter((c) => {
      if (matterIdSet.has(c.id)) return true;
      if (Array.isArray(c.clients) && c.clients.some((matterClient) => eligibleCompanyIds.has(matterClient.id))) return true;
      if (matterIdSet.size === 0 && Array.isArray(c.clientUserIds) && c.clientUserIds.includes(clientId)) return true;
      return false;
    });
  }, [matters, client, clientId]);

  const companyIds = useMemo(() => new Set(companyNames.keys()), [companyNames]);
  const clientMatters = useMemo(() => deriveClientMatters(companyIds), [deriveClientMatters, companyIds]);

  // Same derivation, but a company's matters only qualify when that company's
  // link grants this person `canViewBilling`. Feeds Billing and Documents only
  // (flat fees, recurring retainers, file listing), the two surfaces this
  // feature deliberately gates. `clientMatters` above stays ungated: the
  // Matters tab (and Tasks/Events/Notes/Time Tracking) always show every
  // linked company's matters regardless of this flag.
  const billingEligibleCompanyIds = useMemo(
    () => new Set(companyRelationships.filter((r) => r.canViewBilling).map((r) => r.companyClientId)),
    [companyRelationships],
  );
  const billingEligibleMatters = useMemo(
    () => deriveClientMatters(billingEligibleCompanyIds),
    [deriveClientMatters, billingEligibleCompanyIds],
  );

  // Direct conversations for this client. Threads key on the client's portal user
  // id (client.userId), NOT the client record id, so match on that.
  const clientConversations = useMemo(() => {
    const uid = client?.userId;
    if (!uid) return [];
    return conversations.filter((c) => c.conversationType !== "group" && c.clientId === uid);
  }, [conversations, client]);

  // Only the direct invoices that were raised against a task need a task NAME,
  // and there are as many of those as there are such invoices - so the labels are
  // resolved by id through the tasks lookup rather than by holding every task the
  // client has ever had in memory to read a handful of titles off it.
  const invoiceTaskIds = useMemo(
    () => Array.from(new Set(directInvoices.map((invoice) => invoice.taskId).filter(Boolean) as string[])),
    [directInvoices],
  );
  const { items: invoiceTaskItems } = useEntityByIdsChunked("tasks", lawFirmId, invoiceTaskIds);
  const taskNameMap = useMemo(() => {
    const map = new Map<string, string>();
    invoiceTaskItems.forEach((task) => map.set(task.id, task.label || "Unnamed Task"));
    return map;
  }, [invoiceTaskItems]);

  const billingInvoices = useMemo<ClientScopedInvoice[]>(() => {
    if (!client) return [];
    return buildClientScopedInvoices({
      matterInvoices: invoices,
      directInvoices,
      clientMatters,
      currentClient: client,
      taskNames: taskNameMap,
    });
  }, [client, clientMatters, directInvoices, invoices, taskNameMap]);

  const clientRecurringRetainers = useMemo(() => {
    const linkedMatterIds = new Set(billingEligibleMatters.map((clientMatter) => clientMatter.id));
    return billingPlans.filter((plan) => {
      if (plan.planType !== "retainer") return false;
      if (plan.contextType === "client") return plan.entityId === clientId;
      return linkedMatterIds.has(plan.entityId);
    });
  }, [billingPlans, billingEligibleMatters, clientId]);

  // Lazy-loaded the first time the Files tab is activated, and in ONE request
  // for the whole list of matters rather than one listing per matter.
  const {
    files: clientFiles,
    truncated: filesTruncated,
    loading: filesLoading,
    reload: reloadClientFiles,
  } = useClientMatterFiles({
    lawFirmId,
    matters: billingEligibleMatters,
    enabled: activeTab === "documents" && documentsSubTab === "files" && !!mattersQuery.data,
  });

  const handleFilesUploadComplete = useCallback(() => {
    void reloadClientFiles();
  }, [reloadClientFiles]);

  // Set by "reveal this file" from the document requests tab: switches to
  // Files, opens the matter (or the client's own file area, for a General
  // request) the file lives in, and briefly flashes it. Mirrors the same
  // pattern on the matter detail page. `revealMatterId` is kept separate from
  // `revealHighlightId` (which auto-clears) so the folder view doesn't
  // re-snap when the flash ends.
  const [revealMatterId, setRevealMatterId] = useState<string | null>(null);
  const [revealTrail, setRevealTrail] = useState<FolderCrumb[] | undefined>(undefined);
  const [revealHighlightId, setRevealHighlightId] = useState<string | null>(null);
  // The folders above a document are a lookup, not a string slice on its
  // storage path: the path says nothing about the tree any more.
  const handleRevealFile = useCallback(async (fileId: string, matterId: string | null) => {
    setActiveTab("documents");
    setDocumentsSubTab("files");
    setRevealMatterId(matterId);
    try {
      const location = await FilesService.fileLocation(lawFirmId, fileId);
      setRevealTrail(location.trail);
    } catch {
      // The scope root still shows the document's own folder tree, which is
      // more useful than refusing to switch tabs.
      setRevealTrail([]);
    }
    setRevealHighlightId(fileId);
    window.setTimeout(() => setRevealHighlightId(null), 2000);
  }, [lawFirmId, setActiveTab]);

  // Client notes are the same feature matter/task notes are (rich content,
  // pinning, retraction, replies, time entries billed directly to the
  // client) - `NotesSection` owns its own query cache and refreshes itself
  // after each mutation, so these just forward to the service.
  const handleAddNote = async (noteData: Parameters<typeof clientsService.addClientNote>[2]) => {
    try {
      return await clientsService.addClientNote(lawFirmId, clientId, noteData);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to add note"));
    }
  };

  const handleUpdateNote = async (noteId: string, noteData: Parameters<typeof clientsService.updateClientNote>[3]) => {
    try {
      await clientsService.updateClientNote(lawFirmId, clientId, noteId, noteData);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update note"));
    }
  };

  const handleRetractNote = async (noteId: string, reason?: string) => {
    try {
      await clientsService.retractClientNote(lawFirmId, clientId, noteId, reason);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to retract note"));
    }
  };

  const handleAddTimeEntry = async (noteId: string, entry: Parameters<typeof clientsService.addClientNoteTimeEntry>[3]) => {
    try {
      await clientsService.addClientNoteTimeEntry(lawFirmId, clientId, noteId, entry);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to add time entry"));
    }
  };

  const handleUpdateTimeEntry = async (noteId: string, timeEntryId: string, entry: Parameters<typeof clientsService.updateClientNoteTimeEntry>[4]) => {
    try {
      await clientsService.updateClientNoteTimeEntry(lawFirmId, clientId, noteId, timeEntryId, entry);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update time entry"));
    }
  };

  const handleRemoveTimeEntry = async (noteId: string, timeEntryId: string) => {
    try {
      await clientsService.removeClientNoteTimeEntry(lawFirmId, clientId, noteId, timeEntryId);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to remove time entry"));
    }
  };

  const handleSetNotePinned = async (noteId: string, pinned: boolean) => {
    try {
      await clientsService.setClientNotePinned(lawFirmId, clientId, noteId, pinned);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update pin"));
    }
  };

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        setClient(null);
        setClientNotFound(false);

        const clientRes = await clientsService.getClient(lawFirmId, clientId);

        if (cancelled) return;

        setClient(clientRes || null);
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, "Failed to load client data"));
          setClientNotFound(isApiError(err) && err.status === 404);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [lawFirmId, clientId, loadAttempt]);

  // Re-reads the billing lists and the figures counted from them. Failures of
  // the lists resolve to empty, as they always have.
  const refreshInvoices = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["clientDetail", lawFirmId, clientId, "invoices"] }),
      queryClient.invalidateQueries({ queryKey: ["clientDetail", lawFirmId, clientId, "plans"] }),
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId, "summary", clientId] }),
    ]);
  }, [queryClient, lawFirmId, clientId]);



  const handleRemoveClient = useCallback(async () => {
    try {
      setRemoving(true);
      setError(null);
      await clientsService.deleteClient(lawFirmId, clientId);
      navigate(`/lawfirm/${lawFirmId}/clients`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove client"));
      setRemoving(false);
      setShowRemoveConfirm(false);
    }
  }, [lawFirmId, clientId, navigate]);

  const handleInviteToPortal = useCallback(async () => {
    const email = client?.email?.trim();
    if (!email) {
      setInviteSuccess(null);
      setError("Add an email address to this client before inviting them to the portal.");
      return;
    }
    try {
      setInviting(true);
      setError(null);
      setInviteSuccess(null);
      const result = await clientsService.inviteClientToLawFirm(email, lawFirmId);
      if (result.status === "added") {
        setInviteSuccess("Client has been connected to the portal.");
      } else {
        setInviteSuccess(`Invitation sent to ${email}. They will be added when they sign up.`);
      }
      // Refresh client data
      const updated = await clientsService.getClient(lawFirmId, clientId);
      setClient(updated);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to send invitation"));
    } finally {
      setInviting(false);
    }
  }, [client, lawFirmId, clientId]);

  const handleResendInvite = useCallback(async () => {
    if (!clientId || !client) return;
    try {
      setInviting(true);
      setError(null);
      setInviteSuccess(null);
      await clientsService.resendClientInvitation(lawFirmId, clientId);
      setInviteSuccess(`Invitation resent to ${client.email}.`);
      const updated = await clientsService.getClient(lawFirmId, clientId);
      setClient(updated);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to resend invitation"));
    } finally {
      setInviting(false);
    }
  }, [client, lawFirmId, clientId]);

  const handleRevokePortalAccess = useCallback(async () => {
    try {
      setRevoking(true);
      setError(null);
      await clientsService.revokePortalAccess(lawFirmId, clientId);
      const updated = await clientsService.getClient(lawFirmId, clientId);
      setClient(updated);
      setShowRevokeConfirm(false);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to revoke portal access"));
      setShowRevokeConfirm(false);
    } finally {
      setRevoking(false);
    }
  }, [lawFirmId, clientId]);

  const handleExportClientData = useCallback(async () => {
    try {
      setExportingClientData(true);
      setError(null);
      const data = await privacyService.exportClientData(lawFirmId, clientId);
      downloadJson(`paralegix-client-${clientId}.json`, data);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to export client data"));
    } finally {
      setExportingClientData(false);
    }
  }, [lawFirmId, clientId]);

  const handleEraseClient = useCallback(async () => {
    try {
      setErasing(true);
      setError(null);
      await privacyService.eraseClient(lawFirmId, clientId);
      navigate(`/lawfirm/${lawFirmId}/clients`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to erase client"));
      setErasing(false);
      setShowEraseConfirm(false);
    }
  }, [lawFirmId, clientId, navigate]);

  if (loading || summaryQuery.isLoading) {
    return <LoadingSpinner fullPage />;
  }

  if (!client) {
    return (
      <div className="min-h-screen bg-page">
        <div className="p-6 max-w-[1600px] mx-auto">
          <BackButton href={`/lawfirm/${lawFirmId}/clients`} label="Back to Clients" variant="link" className="mb-6" />
          <ErrorNotification error={error} onRetry={() => setLoadAttempt((attempt) => attempt + 1)} className="mb-4" />
          {(!error || clientNotFound) && <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
            <User size={32} className="text-on-surface-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-on-surface mb-1">Client not found</p>
            <p className="text-xs text-on-surface-muted">
              This client may have been removed from your law firm.
            </p>
          </div>}
        </div>
      </div>
    );
  }

  // Tabs whose contents are counted advertise the count on the tab; the rest are
  // absent rather than zero, so `TabBar` draws no badge for them.
  const TAB_COUNTS: Partial<Record<Tab, number>> = {
    matters: summary?.matters?.count ?? 0,
    tasks: tasksPage.total,
    events: clientEventsCount,
    messages: clientConversations.length,
    billing: summary?.billing?.invoiceCount ?? 0,
  };

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
        {/* A failed ACTION (as opposed to the initial load, handled above) shows
            here, above every tab. */}
        <ErrorNotification error={error ?? mattersErrorMessage} onClose={() => setError(null)} />

        {/* Page Header. Unbordered: the TabBar right below it draws the one rule
            this page shows between its header and body, as on the matter and
            task detail pages, which use the same PageHeader. The back control is
            the inline icon beside the title, not a separate labelled row above. */}
        <PageHeader
          bordered={false}
          eyebrow={client.clientType === "company" ? "Organization Client" : "Client"}
          title={
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{client.name || "Unnamed Client"}</span>
              <ClientStatusBadge status={client.status} />
              {client.clientType !== "company" && <IdentityVerifiedBadge lawFirmId={lawFirmId} clientId={clientId} />}
            </span>
          }
          leading={
            <>
              <BackButton href={`/lawfirm/${lawFirmId}/clients`} label="Back to Clients" />
              <div className="w-14 h-14 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shrink-0">
                {client.clientType === "company" ? (
                  <Building2 size={22} />
                ) : (
                  <span className="text-xl font-bold">
                    {(client.name || "?").charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
            </>
          }
          description={
            (client.email || client.phone) && (
              <span className="block space-y-1">
                {client.email && (
                  <span className="flex items-center gap-1.5 text-on-surface-secondary">
                    <Mail size={13} />
                    {client.email}
                  </span>
                )}
                {client.phone && (
                  <span className="flex items-center gap-1.5 text-on-surface-secondary">
                    <Phone size={13} />
                    {client.phone}
                  </span>
                )}
              </span>
            )
          }
          actions={
            (hasPermission("clients.manage") || hasPermission("clients.erase")) && (
            <>
            {hasPermission("clients.manage") && (
              <>
                {client.clientType === "company" && (
                  <Button
                    size="compact"
                    onClick={() => setAddClientModalOpen(true)}
                    icon={<Plus size={14} strokeWidth={2.2} />}
                  >
                    Add Client
                  </Button>
                )}
                <Button
                  type={client.clientType === "company" ? "secondary" : "primary"}
                  size="compact"
                  onClick={() => { setActiveTab("overview"); setEditingProfile(true); }}
                  icon={<Pencil size={14} strokeWidth={2.2} />}
                >
                  Edit
                </Button>
                <span className={`inline-flex rounded-xl ${highlightPortalAction ? "highlight-pulse" : ""}`}>
                {client.clientType !== "company" && !client.joinedAt && !client.invitedAt && (
                  <Tooltip title={hasClientEmail ? "" : "Add an email address before inviting this client to the portal."}>
                    <span className="inline-flex">
                      <Button
                        type="secondary"
                        size="compact"
                        onClick={handleInviteToPortal}
                        disabled={!hasClientEmail || inviting}
                        icon={<Send size={14} strokeWidth={2.2} />}
                      >
                        {inviting ? "Sending..." : "Invite to Portal"}
                      </Button>
                    </span>
                  </Tooltip>
                )}
                {client.clientType !== "company" && client.email && !client.joinedAt && client.invitedAt && (() => {
                  const lastSent = client.invitationSentAt || client.invitedAt;
                  const msSince = lastSent ? Date.now() - new Date(lastSent).getTime() : Infinity;
                  const canResend = msSince >= 24 * 60 * 60 * 1000;
                  const hoursLeft = canResend ? 0 : Math.ceil(24 - msSince / (1000 * 60 * 60));
                  const tooltipText = canResend
                    ? "Click to resend the invite email"
                    : `You can resend in ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}`;
                  return (
                    <Tooltip title={tooltipText} enterDelay={300}>
                      <span>
                        <Button
                          type="secondary"
                          size="compact"
                          onClick={canResend ? handleResendInvite : undefined}
                          disabled={inviting || !canResend}
                          icon={<Send size={14} strokeWidth={2.2} />}
                        >
                          {inviting ? "Sending..." : "Invite Sent, Awaiting Signup"}
                        </Button>
                      </span>
                    </Tooltip>
                  );
                })()}
                {client.clientType !== "company" && client.joinedAt && (
                  <button
                    onClick={() => setShowRevokeConfirm(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-amber-300 dark:border-amber-700 bg-surface text-amber-700 dark:text-amber-300 text-xs font-medium rounded-xl hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-[background-color,border-color,color,transform] cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                  >
                    <X size={14} strokeWidth={2.2} />
                    Revoke Portal Access
                  </button>
                )}
                </span>
              </>
            )}
            {hasActionsMenu && (
              <>
                {/* No tooltip: the button opens a menu that names every action it
                    holds, so a hover label only covers it. */}
                <button aria-label="More actions"
                  data-item-menu-trigger
                  onClick={(e) => {
                    if (actionsMenuOpen) { setActionsMenuOpen(false); return; }
                    setActionsMenuPos(menuPositionFromEvent(e));
                    setActionsMenuOpen(true);
                  }}
                  className={`inline-flex items-center justify-center p-2 rounded-xl border border-outline text-on-surface-secondary hover:bg-surface-hover transition-[background-color,border-color,color] cursor-pointer ${actionsMenuOpen ? "bg-surface-hover" : "bg-surface"}`}
                >
                  <MoreHorizontal size={16} strokeWidth={2.2} />
                </button>
                <ItemActionMenu
                  open={actionsMenuOpen}
                  anchorTop={actionsMenuPos?.anchorTop ?? 0}
                  anchorBottom={actionsMenuPos?.anchorBottom ?? 0}
                  right={actionsMenuPos?.right ?? 0}
                  onClose={() => setActionsMenuOpen(false)}
                  actions={([
                    canExportClientData && {
                      key: "export-data",
                      label: exportingClientData ? "Exporting..." : "Export Data",
                      icon: <Download size={13} strokeWidth={2.2} />,
                      disabled: exportingClientData,
                      onClick: () => { setActionsMenuOpen(false); handleExportClientData(); },
                    },
                    hasPermission("clients.manage") && {
                      key: "remove",
                      label: "Remove",
                      icon: <Trash2 size={13} strokeWidth={2.2} />,
                      danger: true,
                      onClick: () => { setActionsMenuOpen(false); setShowRemoveConfirm(true); },
                    },
                    hasPermission("clients.erase") && {
                      key: "erase",
                      label: "Erase Client",
                      icon: <Trash2 size={13} strokeWidth={2.2} />,
                      danger: true,
                      disabled: erasing,
                      onClick: () => { setActionsMenuOpen(false); setShowEraseConfirm(true); },
                    },
                  ] as Array<ItemMenuAction | false>).filter((a): a is ItemMenuAction => Boolean(a))}
                />
              </>
            )}
            </>
            )
          }
        />

        {/* Remove Client Confirmation */}
        <ConfirmModal
          isOpen={showRemoveConfirm}
          onClose={() => setShowRemoveConfirm(false)}
          onConfirm={handleRemoveClient}
          title="Remove Client"
          message={`Are you sure you want to remove ${client.name || "this client"} from your law firm? This will remove them from all associated matters and cannot be undone.`}
          confirmText={removing ? "Removing..." : "Remove Client"}
        />

        <ConfirmModal
          isOpen={showRevokeConfirm}
          onClose={() => setShowRevokeConfirm(false)}
          onConfirm={handleRevokePortalAccess}
          title="Revoke Portal Access"
          message={`This will remove ${client.name || "this client"}'s access to the client portal. They will remain on record and linked to their matters, but will no longer be able to log in. You can re-invite them later.`}
          confirmText={revoking ? "Revoking..." : "Revoke Access"}
        />

        {canDeleteTask && (
          <ConfirmModal
            isOpen={deleteTaskOpen}
            onClose={() => { if (!deletingTask) setDeleteTaskOpen(false); }}
            onConfirm={handleDeleteTask}
            title="Delete Task"
            message={`Are you sure you want to delete "${taskToDelete?.title ?? ""}"? This action cannot be undone.`}
            confirmText="Delete"
            loading={deletingTask}
          />
        )}

        <ConfirmModal
          isOpen={showEraseConfirm}
          onClose={() => setShowEraseConfirm(false)}
          onConfirm={handleEraseClient}
          loading={erasing}
          title="Erase Client"
          message={`This permanently erases ${client.name || "this client"} and their personal data, including contacts and notes. This action cannot be undone.`}
          confirmText="Erase Client"
        />

        {client.clientType === "company" && (
          <ClientContactModal
            open={addClientModalOpen}
            onClose={() => setAddClientModalOpen(false)}
            onSaved={() => {
              setAddClientModalOpen(false);
              queryClient.invalidateQueries({ queryKey: ["clientContacts", lawFirmId, clientId] });
              refreshCompanyRelationships();
              setActiveTab("contacts");
            }}
            lawFirmId={lawFirmId}
            clientId={clientId}
            clientType="company"
          />
        )}

        <SuccessNotification message={inviteSuccess} onClose={() => setInviteSuccess(null)} />

        {/* Tabs */}
        <TabBar
          tabs={(client.clientType === "company" ? COMPANY_TABS : TABS)
            .filter(({ key }) => key !== "messages" || canViewMessaging)
            .filter(({ key }) => key !== "time-tracking" || canViewTimeEntries)
            .filter(({ key }) => key !== "billing" || canViewInvoices)
            .map(({ key, label }) => ({
              value: key,
              label,
              count: TAB_COUNTS[key],
            }))}
          value={activeTab}
          onChange={setActiveTab}
        />

        {/* Tab Content */}
        <div>
          {activeTab === "overview" && (
            <OverviewTab
              client={client}
              summary={summary}
              taskCount={tasksPage.total}
              conversations={clientConversations}
              lawFirmId={lawFirmId}
              clientId={clientId}
              canEdit={hasPermission("clients.manage")}
              canViewMessaging={canViewMessaging}
              externalEditing={editingProfile}
              onExternalEditingDone={() => setEditingProfile(false)}
              onClientUpdated={(updated) => setClient((prev) => prev ? { ...prev, ...updated } : prev)}
              companyRelationships={companyRelationships}
              refreshCompanyRelationships={refreshCompanyRelationships}
              onOpenTab={setActiveTab}
            />
          )}
          {activeTab === "notes" && (
            <NotesSection
              lawFirmId={lawFirmId}
              parentType="client"
              parentId={clientId}
              onAddNote={hasPermission("clients.manage") ? handleAddNote : undefined}
              onUpdateNote={hasPermission("clients.manage") ? handleUpdateNote : undefined}
              onDeleteNote={hasPermission("clients.manage") ? handleRetractNote : undefined}
              onAddTimeEntry={canManageClientRecord && canManageTimeEntries ? handleAddTimeEntry : undefined}
              onUpdateTimeEntry={canManageClientRecord && canManageTimeEntries ? handleUpdateTimeEntry : undefined}
              onRemoveTimeEntry={canManageClientRecord && canManageTimeEntries ? handleRemoveTimeEntry : undefined}
              onSetPinned={hasPermission("clients.manage") ? handleSetNotePinned : undefined}
              companyNames={companyNames}
            />
          )}
          {activeTab === "contacts" && (
            <ClientContacts lawFirmId={lawFirmId} clientId={clientId} clientType={client.clientType} />
          )}
          {activeTab === "messages" && canViewMessaging && (
            <ClientMessagesTab
              lawFirmId={lawFirmId}
              clientId={clientId}
              clientUserId={client.userId || null}
              clientType={client.clientType}
              clientName={client.name || ""}
              clientEmail={client.email || ""}
            />
          )}
          {tabListLoading && (
            <ListSkeleton rows={5} label="Loading client lists" />
          )}
          {activeTab === "matters" && !tabListLoading && (
            <EntityMattersTab
              lawFirmId={lawFirmId}
              matters={clientMatters}
              canManageMatters={hasPermission("matters.create")}
              onCreateMatterClick={() => setCreateMatterModalOpen(true)}
              emptyTitle="No matters found for this client"
              emptyMessage="Create a matter to link it to this client."
            />
          )}
          {activeTab === "tasks" && (
            tasksPage.loading ? (
              <ListSkeleton rows={5} label="Loading tasks" />
            ) : tasksPage.error ? (
              // Same treatment as the matter tab: a failed read is not an empty list.
              <ErrorNotification
                error={getErrorMessage(tasksPage.error, "Failed to load tasks")}
                onRetry={() => void tasksPage.refresh()}
              />
            ) : (
              <div className="space-y-4">
                <EntityTasksTab
                  lawFirmId={lawFirmId}
                  tasks={tasksPage.tasks}
                  canManageTasks={hasPermission("tasks.create")}
                  onCreateTaskClick={() => createTask.openNew()}
                  onEditTask={canUpdateTask ? editTask.openWith : undefined}
                  onDeleteTask={canDeleteTask ? (task) => { setTaskToDelete(task); setDeleteTaskOpen(true); } : undefined}
                  emptyTitle="No tasks found for this client"
                  emptyMessage="Create a task to link it to this client."
                  search={{ value: tasksPage.search, onChange: tasksPage.setSearch }}
                  // The list is one server page, so the status filter and the
                  // "All" count both come from the server rather than these rows.
                  status={{ value: tasksPage.status, onChange: tasksPage.setStatus }}
                  total={tasksPage.allTotal ?? tasksPage.total}
                />
                <ListPager
                  page={tasksPage.page}
                  totalPages={tasksPage.totalPages}
                  total={tasksPage.total}
                  rowsPerPage={tasksPage.rowsPerPage}
                  onPageChange={tasksPage.setPage}
                  busy={tasksPage.fetching}
                  serverPaged
                  rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
                  onRowsPerPageChange={tasksPage.setRowsPerPage}
                />
              </div>
            )
          )}
          {activeTab === "time-tracking" && client && !tabListLoading && (
            <ClientBillingTimeEntriesSection
              lawFirmId={lawFirmId}
              client={client}
              clientMatters={clientMatters}
              onGoToBilling={() => setActiveTab("billing")}
              companyNames={companyNames}
            />
          )}
          {activeTab === "events" && !tabListLoading && (
            <ClientEventsTab
              lawFirmId={lawFirmId}
              clientId={clientId}
              clientMatters={clientMatters.map((c) => ({ id: c.id, name: c.name || c.id, courtId: c.courtId ?? null }))}
              canManage={hasPermission("clients.manage")}
              canUpdateMatters={hasPermission("matters.update")}
              companyNames={companyNames}
            />
          )}
          {/* Documents Tab: see `documentsToggle` for how files and requests share it.
              The header row stays mounted across the two views, so the toggle is one
              element whose highlight slides between them rather than a fresh one
              drawn already in place. */}
          {activeTab === "documents" && !tabListLoading && (
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-3">
                {documentsToggle}
                {showingFiles && (
                  <div className="sm:ml-auto">
                    <Button
                      type="secondary"
                      size="compact"
                      onClick={() => setFilesPreviewMode((on) => !on)}
                      icon={filesPreviewMode ? <FolderOpen size={14} /> : <Eye size={14} />}
                    >
                      {filesPreviewMode ? "Back to files" : "Preview as client"}
                    </Button>
                  </div>
                )}
              </div>
              {showingFiles ? (
                <ClientFilesTab
                  previewMode={filesPreviewMode}
                  clientId={clientId}
                  clientName={client.name || "Client"}
                  clientUserId={client.userId}
                  clientFiles={clientFiles}
                  clientMatters={billingEligibleMatters}
                  truncated={filesTruncated}
                  loading={filesLoading}
                  lawFirmId={lawFirmId}
                  onFilesChanged={handleFilesUploadComplete}
                  revealMatterId={revealMatterId}
                  revealTrail={revealTrail}
                  revealHighlightId={revealHighlightId}
                  companyNames={companyNames}
                />
              ) : (
                <ClientDocumentRequestsTab
                  lawFirmId={lawFirmId}
                  clientId={clientId}
                  clientName={client.name || "Client"}
                  clientMatters={billingEligibleMatters}
                  onRevealFile={handleRevealFile}
                />
              )}
            </div>
          )}
          {activeTab === "billing" && !tabListLoading && (
            <BillingTab
              billingInvoices={billingInvoices}
              recurringRetainers={clientRecurringRetainers}
              clientMatters={billingEligibleMatters}
              client={client}
              clientId={clientId}
              lawFirmId={lawFirmId}
              navigate={navigate}
              onRefreshInvoices={refreshInvoices}
              stripeStatus={stripeStatus}
              companyNames={companyNames}
            />
          )}
        </div>

        <CreateMatterModal
          open={createMatterModalOpen}
          onClose={() => setCreateMatterModalOpen(false)}
          lawFirmId={lawFirmId}
          users={users}
          initialClientId={clientId}
          onAfter={async () => {
            setCreateMatterModalOpen(false);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["clientDetail", lawFirmId, clientId, "matters"] }),
              queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId, "summary", clientId] }),
            ]);
          }}
        />

        <CreateTaskModal
          open={createTask.open}
          onClose={() => createTask.setOpen(false)}
          lawFirmId={lawFirmId}
          users={users.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
          courts={courts.map((c) => ({ id: c.id, name: c.name, city: c.city, address: c.address, state: c.state }))}
          courtsLoading={courtsLoading}
          updateCourtAddress={updateCourtAddress}
          canLinkCourtAddress={canManageCourts}
          clientId={clientId}
          create={createTask}
        />

        {canUpdateTask && (
          <EditTaskModal
            open={editTask.open}
            onClose={() => editTask.setOpen(false)}
            lawFirmId={lawFirmId}
            users={users.map((u) => ({ id: u.uid, name: u.name, email: u.email }))}
            courts={courts.map((c) => ({ id: c.id, name: c.name, city: c.city, address: c.address, state: c.state }))}
            courtsLoading={courtsLoading}
            updateCourtAddress={updateCourtAddress}
            canLinkCourtAddress={canManageCourts}
            edit={editTask}
          />
        )}
      </div>
    </div>
  );
}
