"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Briefcase, CheckSquare2, ArrowLeft, Pencil, Trash2, Clock3, Play } from "lucide-react";
import SegmentedToggle from "@/components/ui/SegmentedToggle";

import TasksService from "@/services/tasks.service";
import MattersService from "@/services/matters.service";
import EntityClientsTab from "@/components/clientComp/EntityClientsTab";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useLawFirmUsers } from "@/hooks/useUsers";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { useEntityByIdsChunked, type FullLookupItem } from "@/hooks/useEntityLookup";
import { useEditTask } from "@/hooks/taskHooks/useTasks";
import { useEntityBillingActions } from "@/hooks/useEntityBillingActions";
import PageHeader from "@/components/ui/PageHeader";
import BackButton from "@/components/ui/BackButton";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import EditTaskModal from "@/components/taskComp/EditTaskModal";
import AddTaskClientModal from "@/components/taskComp/AddTaskClientModal";
import TimeEntryModal from "@/components/billingComp/TimeEntryModal";
import NotesSection from "@/components/notesComp/NotesSection";
import FilesSection from "@/components/filesComp/FilesSection";
import TaskOverviewTab from "@/components/taskComp/TaskOverviewTab";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ui/ConfirmModal";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import type { Matter, Task, TaskStatus } from "@/types";
import { TASK_STATUS_ORDER, taskStatusMeta, styleOf } from "@/constants/statusMeta";
import { useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { useAuth } from "@/hooks/useAuth";
import TabBar from "@/components/ui/TabBar";
import Tooltip from "@/components/ui/Tooltip";
import { canStartTimerForTask, NO_TIMER_TARGET_HINT } from "@/constants/taskConstants";

// The status control's options, in the shared order, each with the dot colour its badge uses.
const STATUS_OPTIONS: DropdownOption[] = TASK_STATUS_ORDER.map((status) => ({
  label: taskStatusMeta(status).label,
  value: status,
  dotClassName: styleOf(taskStatusMeta(status)).dot,
}));

/**
 * The task detail views. Every member who can open the task sees all four, so a
 * `?tab=` deep link (a copied note link is `?tab=notes&note=<id>`) only has to
 * name one of these; anything else falls back to the Overview.
 */
const TASK_TABS = ['overview', 'notes', 'clients', 'files'] as const;
type TaskTab = (typeof TASK_TABS)[number];

const isTaskTab = (value: string | null | undefined): value is TaskTab =>
  (TASK_TABS as readonly string[]).includes(value ?? '');

/** Narrow one enriched lookup field (typed `unknown`) to a plain string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface TaskClientView {
  id: string;
  name: string;
  clientType: "person" | "company";
  email: string;
  phone: string;
  organization: string;
  userId?: string | null;
  portalInvitePending?: boolean;
}

export default function ViewTaskPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const taskId = Array.isArray(params?.taskId) ? params.taskId[0] : (params?.taskId as string);
  
  const [task, setTask] = useState<Task | null>(null);
  const [matterData, setMatterData] = useState<Matter | null>(null);
  // Clients on the task's matter; lets the matter-sourced file view name the
  // clients each shared file is visible to (and flag files no client can see).
  const [matterClients, setMatterClients] = useState<{ id: string; name: string; userId?: string | null }[]>([]);
  // Resolved dependency/dependent tasks (title + status) for the Dependencies section.
  const [dependencyTasks, setDependencyTasks] = useState<Task[]>([]);
  const [dependentTasks, setDependentTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removeClientTarget, setRemoveClientTarget] = useState<{ id: string; name: string } | null>(null);
  const [removingClient, setRemovingClient] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  // A new note link must select its tab even when this page is already mounted.
  const tabLocation = `${taskId}?${searchParams?.toString() || ''}`;
  const requestedTab = searchParams?.get('tab');
  const urlTab: TaskTab = isTaskTab(requestedTab) ? requestedTab : 'overview';
  const [tabSelection, setTabSelection] = useState({ location: tabLocation, tab: urlTab });
  const activeTab = tabSelection.location === tabLocation ? tabSelection.tab : urlTab;
  const setActiveTab = (tab: TaskTab) => setTabSelection({ location: tabLocation, tab });
  const [fileSource, setFileSource] = useState<'task' | 'matter'>('task');
  const [addClientModalOpen, setAddClientModalOpen] = useState(false);



  const { user: currentUser } = useAuth();
  const { users } = useLawFirmUsers(lawFirmId);
  const { hasPermission } = usePermissions();
  const canUpdateTask = hasPermission("tasks.update");
  const canManageClients = canUpdateTask && hasPermission("clients.manage");
  const canDeleteTask = hasPermission("tasks.delete");
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  // Full client objects for clients linked to this task, resolved by id.
  const { items: linkedClientItems } = useEntityByIdsChunked<FullLookupItem>(
    "clients",
    lawFirmId,
    task?.clientIds ?? [],
    { full: true }
  );

  const linkedClientMap = useMemo(() => {
    const map = new Map<string, FullLookupItem>();
    for (const item of linkedClientItems) {
      if (item?.id) map.set(item.id, item);
    }
    return map;
  }, [linkedClientItems]);

  const taskClientRows = useMemo<TaskClientView[]>(
    () =>
      (task?.clientIds || []).map((id, i) => {
        const fullClient = linkedClientMap.get(id);
        return {
          id,
          // A `full=true` lookup row carries its enriched fields through an
          // index signature, so each one arrives as `unknown` and has to be
          // narrowed before it can satisfy TaskClientView.
          name: text(fullClient?.name) || task?.clientNames?.[i] || "Unnamed Client",
          clientType: (fullClient?.clientType as "person" | "company") || "person",
          email: text(fullClient?.email) || text(fullClient?.sublabel),
          phone: text(fullClient?.phone),
          organization: text(fullClient?.organization),
          userId: text(fullClient?.userId) || null,
          portalInvitePending: fullClient?.portalInvitePending === true,
        };
      }),
    [task, linkedClientMap]
  );

  // Guards against a stale response landing after a newer one. This page keeps
  // its own task/matter/clients state in plain `useState` rather than React
  // Query, so nothing else stops a slow `loadTask` call for the OLD taskId
  // from overwriting state after the viewer has already navigated to a
  // different task (browser back/forward can reuse this same page instance
  // rather than remounting it). Every call claims the next id; a call whose id
  // no longer matches the ref by the time it resolves lost the race and skips
  // applying its result.
  const loadRequestIdRef = useRef(0);

  const loadTask = useCallback(async (showLoader = true) => {
    if (!lawFirmId || !taskId) return;

    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => loadRequestIdRef.current === requestId;

    if (showLoader) setLoading(true);
    setError(null);

    try {
      // Load real data
      const taskData = await TasksService.getTask(lawFirmId, taskId);
      if (!isCurrentRequest()) return;
      setTask(taskData as Task);

      // Resolve dependency/dependent task details (title + status) so the
      // Dependencies section can show real tasks, not bare ids.
      const hasGraph =
        (taskData.dependencies?.length || 0) > 0 || (taskData.dependents?.length || 0) > 0;
      if (hasGraph) {
        try {
          const graph = await TasksService.getTaskDependencies(lawFirmId, taskId);
          if (!isCurrentRequest()) return;
          setDependencyTasks(graph.dependencies || []);
          setDependentTasks(graph.dependents || []);
        } catch {
          if (isCurrentRequest()) {
            setDependencyTasks([]);
            setDependentTasks([]);
          }
        }
      } else {
        setDependencyTasks([]);
        setDependentTasks([]);
      }

      // Load associated matter if exists
      if (taskData.matterId) {
        try {
          const matterInfo = await MattersService.getMatterById(taskData.matterId, lawFirmId);
          if (isCurrentRequest()) setMatterData(matterInfo);
        } catch (matterError) {
          console.warn("Could not load matter data:", matterError);
        }
        try {
          const clients = await MattersService.listClients(lawFirmId, taskData.matterId);
          if (isCurrentRequest()) {
            setMatterClients((clients || []).map((c) => ({ id: c.id, name: c.name || "Client", userId: c.userId })));
          }
        } catch {
          if (isCurrentRequest()) setMatterClients([]);
        }
      } else {
        // A matter-less task: clear whatever the PREVIOUS task on this page
        // instance may have populated (matter info and its clients), rather
        // than leaving stale matter data on screen for a task that has none.
        if (isCurrentRequest()) {
          setMatterData(null);
          setMatterClients([]);
        }
      }
    } catch (err) {
      if (isCurrentRequest()) setError(getErrorMessage(err, "Failed to load task"));
    } finally {
      if (showLoader && isCurrentRequest()) setLoading(false);
    }
  }, [lawFirmId, taskId]);

  const editTask = useEditTask(lawFirmId, () => {
    // Refresh task data after edit
    loadTask();
  });

  const handleDelete = async () => {
    if (!task || !canDeleteTask) return;
    
    setDeleting(true);
    try {
      await TasksService.deleteTask(lawFirmId, taskId);
      navigate(`/lawfirm/${lawFirmId}/tasks`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete task"));
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleRemoveClient = async () => {
    if (!task || !removeClientTarget) return;
    setRemovingClient(true);
    try {
      // Only the client that was chosen is removed. An organization's roster
      // people are separate clients on this task and stay attached, the same
      // as removing an organization from a matter.
      const newIds = (task.clientIds || []).filter((id) => id !== removeClientTarget.id);
      await TasksService.updateTask({
        lawFirmId,
        taskId,
        clientIds: newIds,
      });
      await loadTask();
      setRemoveClientTarget(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove client"));
    } finally {
      setRemovingClient(false);
    }
  };

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (!task || !canUpdateTask) return;
    setTogglingStatus(true);
    try {
      await TasksService.updateTask({
        lawFirmId,
        taskId: task.taskId || task.id,
        status: newStatus,
      });
      await loadTask();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update status'));
    } finally {
      setTogglingStatus(false);
    }
  };

  const handleEdit = () => {
    if (task && canUpdateTask) {
      editTask.openWith(task as any);
    }
  };

  const billingContext = useMemo(() => {
    if (!task) return null;
    return {
      matterId: task.matterId || null,
      clientId: !task.matterId && task.clientIds?.length ? task.clientIds[0] : null,
      clientIds: task.clientIds || [],
      matterName: task.matterName || null,
      clientNames: task.clientNames || [],
      sourceTaskId: task.taskId || task.id,
      sourceTaskTitle: task.title,
      title: task.title,
      description: task.description || undefined,
    };
  }, [task]);

  const {
    addTimeEntryOpen,
    setAddTimeEntryOpen,
    timeEntryPrefill,
    setTimeEntryPrefill,
    handleLogTime,
    handleStartTimer,
  } = useEntityBillingActions(billingContext);

  // Charge codes feed only the time-entry modal, so they load when it first
  // opens. The cache key is shared, so reopening does not refetch.
  const { chargeCodes } = useChargeCodes(lawFirmId, false, addTimeEntryOpen);

  const handleTimeEntrySaved = useBillNowRedirect(lawFirmId, () => {
    setAddTimeEntryOpen(false);
    setTimeEntryPrefill(null);
  });

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
    if (!task) return;
    if (!canUpdateTask) throw new Error("You do not have permission to add notes to this task.");

    try {
      const result = await TasksService.addNoteToTask(lawFirmId, taskId, noteData);
      loadTask(false); // Reload task to get updated notes, without the full-page loading spinner
      // The panel reads the new note's id from this to open "Save & Add Time".
      return result;
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to add note"));
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
    if (!task) return;
    if (!canUpdateTask) throw new Error("You do not have permission to edit notes on this task.");

    try {
      await TasksService.updateNoteInTask(lawFirmId, taskId, noteId, noteData);
      loadTask(false); // Reload task to get updated notes, without the full-page loading spinner
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update note"));
    }
  };

  // A note is retracted, not deleted: it stays on the record, and its time
  // entries are untouched. `reason` is optional.
  const handleRetractNote = async (noteId: string, reason?: string) => {
    if (!task) return;
    if (!canUpdateTask) throw new Error("You do not have permission to retract notes on this task.");

    try {
      await TasksService.retractNoteFromTask(lawFirmId, taskId, noteId, reason);
      loadTask(false); // no full-page loading spinner for a single note's retraction
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to retract note"));
    }
  };

  const handleAddTimeEntry = async (noteId: string, entry: {
    timeSpent: number;
    timeEntryDate?: string;
    activityName?: string;
    activityDescription?: string;
    isBillable?: boolean;
  }) => {
    if (!task) return;
    try {
      await TasksService.addTaskNoteTimeEntry(lawFirmId, taskId, noteId, entry);
      loadTask(false); // no full-page loading spinner for a note's time entry
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to add time entry"));
    }
  };

  const handleUpdateTimeEntry = async (noteId: string, timeEntryId: string, entry: {
    timeSpent: number;
    timeEntryDate?: string;
    activityName?: string;
    activityDescription?: string;
    isBillable?: boolean;
  }) => {
    if (!task) return;
    try {
      await TasksService.updateTaskNoteTimeEntry(lawFirmId, taskId, noteId, timeEntryId, entry);
      loadTask(false); // no full-page loading spinner for a note's time entry
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update time entry"));
    }
  };

  const handleRemoveTimeEntry = async (noteId: string, timeEntryId: string) => {
    if (!task) return;
    try {
      await TasksService.removeTaskNoteTimeEntry(lawFirmId, taskId, noteId, timeEntryId);
      loadTask(false); // no full-page loading spinner for a note's time entry
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to remove time entry"));
    }
  };

  const handleSetNotePinned = async (noteId: string, pinned: boolean) => {
    if (!task) return;
    try {
      await TasksService.setTaskNotePinned(lawFirmId, taskId, noteId, pinned);
      loadTask(false); // no full-page loading spinner for a pin toggle
    } catch (err) {
      throw new Error(getErrorMessage(err, "Failed to update pin"));
    }
  };

  // "Add time" only makes sense when the note has somewhere to bill against:
  // the task's own matter, or (for a matter-less task) one of its linked
  // clients. Matches the backend's own billing-context resolution.
  const taskHasBillingContext = !!(task && (task.matterId || task.clientIds?.length));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTask();
  }, [loadTask]);

  if (loading) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  // `error` is shared by the initial task load AND every action handler on this
  // page (delete, status change, remove a client, add/update/retract a note,
  // ...). Gating this fallback on `error` as well as `!task` used to mean a
  // FAILED ACTION - the task loaded fine, then e.g. its delete was refused -
  // blanked the whole page into "Task not found", discarding a task that was
  // right there in state the whole time. Once `task` is populated it is never
  // cleared by an action failure, so `!task` alone is the correct "we have
  // nothing to show" check; a later action error is surfaced by the banner
  // below instead of hiding the page that error is about.
  if (!task) {
    return (
      <div className="min-h-screen bg-page">
        <div className="p-6 max-w-[1600px] mx-auto">
          {error && <ErrorNotification error={error} onRetry={() => void loadTask()} className="mb-4" />}
          <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
            <CheckSquare2 size={32} className="text-on-surface-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-on-surface mb-1">Task not found</p>
            <p className="text-xs text-on-surface-muted">
              This task may have been removed or you may not have access to it.
            </p>
          </div>
          <Button
            onClick={() => navigate(`/lawfirm/${lawFirmId}/tasks`)}
            type="secondary"
            icon={<ArrowLeft className="h-4 w-4" />}
            className="mt-4"
          >
            Back to Tasks
          </Button>
        </div>
      </div>
    );
  }

  const assignedUserNames = Array.isArray(task.assignedToName) ? task.assignedToName.filter(Boolean) : (task.assignedToName ? [task.assignedToName] : []);
  const createdByUser = users.find(u => u.uid === task.createdBy);

  return (
    <div className="min-h-screen bg-page">
    <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
      {/* A failed ACTION (as opposed to the initial load, handled above) shows
          here, above every tab. */}
      <ErrorNotification error={error} onClose={() => setError(null)} />

      {/* Unbordered: the TabBar right below draws the one rule this page shows
          between its header and body. */}
      <PageHeader
        bordered={false}
        leading={<BackButton href={`/lawfirm/${lawFirmId}/tasks`} label="Back to Tasks" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{task.title}</span>
            <TaskStatusBadge status={task.status} />
          </span>
        }
        actions={
          (canUpdateTask || canDeleteTask || canManageTimeEntries) && (
            <>
              {canUpdateTask && (
                <Dropdown
                  value={task.status}
                  onChange={(value) => void handleStatusChange(value as TaskStatus)}
                  options={STATUS_OPTIONS}
                  busy={togglingStatus}
                  className="w-44"
                  ariaLabel="Change status"
                />
              )}
              {canManageTimeEntries && (
                <Button type="secondary" size="compact" onClick={handleLogTime} icon={<Clock3 size={14} strokeWidth={2.2} />}>
                  Log Time
                </Button>
              )}
              {canManageTimeEntries && (canStartTimerForTask(task) ? (
                <Button type="secondary" size="compact" onClick={handleStartTimer} icon={<Play size={14} strokeWidth={2.2} />}>
                  Start Timer
                </Button>
              ) : (
                // No matter and no single client: nothing to bill against, so the
                // tasks grid's rule applies and Log Time, beside it, is the way in.
                // A disabled button fires no pointer events, so the span carries
                // the hover that opens the explanation.
                <Tooltip title={NO_TIMER_TARGET_HINT} enterDelay={300}>
                  <span className="inline-flex">
                    <Button type="secondary" size="compact" disabled icon={<Play size={14} strokeWidth={2.2} />}>
                      Start Timer
                    </Button>
                  </span>
                </Tooltip>
              ))}
              {canUpdateTask && (
                <Button type="secondary" size="compact" onClick={handleEdit} icon={<Pencil size={14} strokeWidth={2.2} />}>
                  Edit
                </Button>
              )}
              {canDeleteTask && (
                <Button type="danger" size="compact" onClick={() => setDeleteDialogOpen(true)} icon={<Trash2 size={14} strokeWidth={2.2} />}>
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
          onChange={(value) => setActiveTab(value as TaskTab)}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'notes', label: 'Notes', count: task.totalNotes || 0 },
            { value: 'clients', label: 'Clients', count: taskClientRows.length },
            { value: 'files', label: 'Files' },
          ]}
        />

        <div className="pt-6 min-w-0 overflow-x-hidden">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <TaskOverviewTab
              lawFirmId={lawFirmId}
              taskId={taskId}
              task={task}
              matterData={matterData}
              assignedUserNames={assignedUserNames}
              createdByUser={createdByUser}
              dependencyTasks={dependencyTasks}
              dependentTasks={dependentTasks}
              canUpdateTask={canUpdateTask}
              onError={setError}
              onViewFiles={() => setActiveTab("files")}
              onViewNotes={() => setActiveTab("notes")}
              onTaskChange={setTask}
            />
          )}

          {/* Notes Tab */}
          {activeTab === 'notes' && (
            <div>
              <NotesSection
                lawFirmId={lawFirmId}
                parentType="task"
                parentId={taskId}
                onAddNote={canUpdateTask ? handleAddNote : undefined}
                onUpdateNote={canUpdateTask ? handleUpdateNote : undefined}
                onDeleteNote={canUpdateTask ? handleRetractNote : undefined}
                onAddTimeEntry={canUpdateTask && canManageTimeEntries && taskHasBillingContext ? handleAddTimeEntry : undefined}
                onUpdateTimeEntry={canUpdateTask && canManageTimeEntries && taskHasBillingContext ? handleUpdateTimeEntry : undefined}
                onRemoveTimeEntry={canUpdateTask && canManageTimeEntries && taskHasBillingContext ? handleRemoveTimeEntry : undefined}
                onSetPinned={canUpdateTask ? handleSetNotePinned : undefined}
              />
            </div>
          )}

          {/* Clients Tab */}
          {activeTab === 'clients' && (
            <div>
              {task.matterId ? (
                <EntityClientsTab
                  lawFirmId={lawFirmId}
                  clients={matterClients}
                  inheritedBanner={
                    <p className="mb-4 text-sm text-on-surface-secondary">
                      These clients are inherited from the linked matter. To manage clients, go to the matter.
                    </p>
                  }
                  emptyTitle="No clients on this matter"
                  emptyMessage="The linked matter doesn't have any clients yet."
                />
              ) : (
                <EntityClientsTab
                  lawFirmId={lawFirmId}
                  clients={taskClientRows}
                  canManageClients={canManageClients}
                  onAddClientClick={() => setAddClientModalOpen(true)}
                  onRemoveClient={(client) => setRemoveClientTarget(client)}
                  emptyTitle="No clients added yet"
                  emptyMessage="Add a client to this task to keep track of who it's for."
                />
              )}
            </div>
          )}

          {/* Files Tab - same view as matter files */}
          {activeTab === 'files' && (
            <div>
              {task.matterId && (
                <SegmentedToggle
                  className="mb-5"
                  ariaLabel="File source"
                  value={fileSource}
                  onChange={setFileSource}
                  options={[
                    { value: 'task', label: 'Task Files', icon: CheckSquare2 },
                    { value: 'matter', label: 'Matter Files', icon: Briefcase },
                  ]}
                />
              )}
              <FilesSection
                lawFirmId={lawFirmId}
                matterId={fileSource === 'matter' ? task.matterId! : undefined}
                taskId={fileSource === 'task' ? taskId : undefined}
                onError={(error) => setError(error)}
                rootLabel={fileSource === 'matter' && matterData?.name ? matterData.name : undefined}
                shareClients={
                  fileSource === 'task'
                    ? (task.clientIds || []).map((id, i) => ({ id, name: task.clientNames?.[i] || 'Client' }))
                    : matterClients
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Edit Task Modal */}
      <EditTaskModal
        open={editTask.open}
        onClose={() => editTask.setOpen(false)}
        lawFirmId={lawFirmId}
        users={users.map(u => ({ id: u.uid, name: u.name, email: u.email }))}
        edit={editTask}
      />

      <TimeEntryModal
        open={addTimeEntryOpen}
        onClose={() => {
          setAddTimeEntryOpen(false);
          setTimeEntryPrefill(null);
        }}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        defaultUserId={currentUser?.uid}
        defaultTarget={task.matterId ? `matter:${task.matterId}` : undefined}
        scopeMatterId={task.matterId || undefined}
        scopeClientId={!task.matterId && task.clientIds?.length ? task.clientIds[0] : undefined}
        prefill={timeEntryPrefill}
        onSuccess={handleTimeEntrySaved}
      />

      {/* Add Client Modal */}
      <AddTaskClientModal
        open={canManageClients && addClientModalOpen}
        onClose={() => setAddClientModalOpen(false)}
        lawFirmId={lawFirmId}
        taskId={taskId}
        existingClientIds={task.clientIds || []}
        onAfter={() => void loadTask(false)}
      />

      {canDeleteTask && (
        <ConfirmModal
          isOpen={deleteDialogOpen}
          onClose={() => { if (!deleting) setDeleteDialogOpen(false); }}
          onConfirm={handleDelete}
          title="Delete Task"
          message={`Are you sure you want to delete "${task.title}"? This action cannot be undone.`}
          confirmText="Delete"
          loading={deleting}
        />
      )}

      <ConfirmModal
        isOpen={!!removeClientTarget}
        onClose={() => { if (!removingClient) setRemoveClientTarget(null); }}
        onConfirm={handleRemoveClient}
        title="Remove Client"
        message={`Are you sure you want to remove "${removeClientTarget?.name ?? ''}" from this task?`}
        confirmText="Remove"
        confirmType="danger"
        loading={removingClient}
      />
    </div>
    </div>
  );
}
