"use client";

import LinkifiedText from "@/components/ui/LinkifiedText";
import { endsAtPayloadFor, eventListWhen, eventScheduleFormValues, eventZoneSuffix, scheduleEdits } from "@/components/calendarComp/calendarTiming";
import ZonedEventTime from "@/components/calendarComp/ZonedEventTime";
import { eventCourtName } from "@/components/eventComp/eventCourt";

import { useId, useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, CheckCircle, Briefcase } from 'lucide-react';
import useCourts from "@/hooks/courtHooks/useCourts";
import CourtDirectoryLink from "@/components/courtsComp/CourtDirectoryLink";
import clientsService from "@/services/clients.service";
import matterEventsService from "@/services/matterEvents.service";
import type { EventGraphNode } from "@/types/matterEvent";
import useClientDetailEvents from "@/hooks/clientHooks/useClientDetailEvents";
import type { ClientEvent, MatterEventType, MatterEventStatus, CreateClientEventRequest, UpdateClientEventRequest } from "@/types/clientEvent";
import { MATTER_EVENT_TYPE_OPTIONS } from "@/constants/statusMeta";
import { formatCourtOptionLabel } from "@/types/court";
import { useNavigation } from "@/contexts/NavigationContext";
import ActionIconButton from "@/components/ui/ActionIconButton";
import TagChip from "@/components/ui/TagChip";
import StatusBadge from "@/components/ui/StatusBadge";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { type RowAction } from "@/components/ui/RowActionMenu";
import useClientEventsPage from "@/hooks/clientHooks/useClientEventsPage";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";
import EntityEventsTab, { useEventStatusFilter, type EntityEventsAdapter } from "@/components/eventComp/EntityEventsTab";
import EntityEventForm, { useEventFormFields } from "@/components/eventComp/EntityEventForm";

interface MatterOption {
  id: string;
  name: string;
  courtId?: string | null;
}

interface EventFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lawFirmId: string;
  clientId: string;
  clientMatters: MatterOption[];
  editing?: ClientEvent | null;
}

function EventFormModal({ open, onClose, onSaved, lawFirmId, clientId, clientMatters, editing }: EventFormModalProps) {
  const fieldIds = useId();
  // Courts are not deferred to the modal's first open the way the assignee
  // roster is: choosing a matter copies its court's name and address into the
  // form, which needs the list already in hand.
  const { courts, loading: courtsLoading } = useCourts(lawFirmId);
  const fields = useEventFormFields();
  const {
    type, setType,
    title, date, endsAt, notes,
    locationName, setLocationName,
    location, setLocation,
    status, setStatus,
    allDay, assignedTo, assignedToName, contactIds, linkedFiles, clientVisible, clientDescription,
    setSubmitting,
    setError,
    resetFields,
  } = fields;
  const [selectedCourtId, setSelectedCourtId] = useState("");
  const [selectedMatterId, setSelectedMatterId] = useState("");
  const [courtTouched, setCourtTouched] = useState(false);

  // The parent clears `editing` in the same handler that closes this. Keep the
  // record's visual state stable until Modal finishes its exit animation.
  const displayedEditing = useLastOpenValue(open, editing);
  const isEditing = !!displayedEditing;

  const getCourtName = useCallback((courtId: string) =>
    courts.find((court) => court.id === courtId)?.name?.trim() || "",
  [courts]);

  const getCourtAddress = useCallback((courtId: string) =>
    courts.find((court) => court.id === courtId)?.address?.trim() || "",
  [courts]);

  const applyCourtSelection = useCallback((courtId: string, { markTouched = false }: { markTouched?: boolean } = {}) => {
    const previousCourtName = getCourtName(selectedCourtId);
    const previousCourtAddress = getCourtAddress(selectedCourtId);
    const nextCourtName = getCourtName(courtId);
    const nextCourtAddress = getCourtAddress(courtId);

    setSelectedCourtId(courtId);
    if (markTouched) {
      setCourtTouched(true);
    }

    setLocationName((currentLocationName) => {
      const trimmedLocationName = currentLocationName.trim();
      const isUsingPreviousCourtName = !!previousCourtName && trimmedLocationName === previousCourtName;

      if (!trimmedLocationName || isUsingPreviousCourtName) {
        return nextCourtName;
      }

      return currentLocationName;
    });

    setLocation((currentLocation) => {
      const trimmedLocation = currentLocation.trim();
      const isUsingPreviousCourtAddress = !!previousCourtAddress && trimmedLocation === previousCourtAddress;

      if (!trimmedLocation || isUsingPreviousCourtAddress) {
        return nextCourtAddress;
      }

      return currentLocation;
    });
  }, [getCourtAddress, getCourtName, selectedCourtId, setLocation, setLocationName]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      resetFields({
        type: editing.type,
        title: editing.title,
        ...eventScheduleFormValues(editing),
        notes: editing.notes || "",
        // A matter event's court is its matter's, not a venue it chose, so only a
        // client event falls back to its court for the location name.
        locationName: editing.locationName || (editing.source === "client" ? editing.courtName : "") || "",
        location: editing.location || "",
        status: editing.status,
        assignedTo: editing.assignedTo || [],
        assignedToName: editing.assignedToName || [],
        contactIds: (editing.contacts || []).map((c) => c.contactId),
        linkedFiles: (editing.linkedFiles || []).map((f) => ({
          fileId: f.fileId,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          scope: f.scope,
          scopeId: f.scopeId,
        })),
        clientVisible: editing.clientVisible ?? false,
        clientDescription: editing.clientDescription || "",
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the event being edited or resets them when opening blank
      setSelectedCourtId(editing.courtId || "");
      // When editing a matter event, lock the matter selector to that matter
      setSelectedMatterId(editing.matterId || "");
    } else {
      resetFields({
        type: "court_date",
        title: "",
        date: "",
        endsAt: "",
        notes: "",
        locationName: "",
        location: "",
        status: "upcoming",
        allDay: false,
        assignedTo: [],
        assignedToName: [],
        contactIds: [],
        linkedFiles: [],
        clientVisible: false,
      });
      setSelectedCourtId("");
      setSelectedMatterId("");
    }
    setCourtTouched(false);
  }, [editing, open, resetFields]);

  useEffect(() => {
    if (!editing || selectedCourtId || courts.length === 0) return;

    const existingCourtName = (editing.courtName || editing.locationName || "").trim().toLowerCase();
    if (!existingCourtName) return;

    const matchedCourt = courts.find((court) => court.name.trim().toLowerCase() === existingCourtName);
    if (matchedCourt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- selects the matching court once the async-fetched court list is available
      if (editing.source === "matter") setSelectedCourtId(matchedCourt.id);
      else applyCourtSelection(matchedCourt.id);
    }
  }, [applyCourtSelection, courts, editing, selectedCourtId]);

  const handleTypeChange = (newType: MatterEventType) => {
    setType(newType);
  };

  const handleMatterChange = (matterId: string) => {
    setSelectedMatterId(matterId);
    const linkedMatter = clientMatters.find((clientMatter) => clientMatter.id === matterId);
    applyCourtSelection(linkedMatter?.courtId || "");
  };

  const handleCourtChange = (courtId: string) => {
    applyCourtSelection(courtId, { markTouched: true });
  };

  const eventTypeOptions: DropdownOption[] = MATTER_EVENT_TYPE_OPTIONS.map((opt) => ({
    label: opt.label,
    value: opt.value,
  }));

  const statusOptions: DropdownOption[] = [
    { label: "Upcoming", value: "upcoming" },
    { label: "Completed", value: "completed" },
    { label: "Cancelled", value: "cancelled" },
  ];

  const matterOptions: DropdownOption[] = [
    { label: "No matter (standalone event)", value: "" },
    ...clientMatters.map((clientMatter) => ({ label: clientMatter.name, value: clientMatter.id })),
  ];

  const courtOptions: DropdownOption[] = [
    { label: "No court", value: "" },
    ...courts.map((court) => ({ label: formatCourtOptionLabel(court), value: court.id })),
  ];

  const handleSubmit = async () => {
    if (!title.trim()) { setError("Title is required"); return; }
    if (!date) { setError("Date is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        // Only the parts of the schedule the user changed: one left alone keeps
        // the value the server stores, which may be newer than this form's copy.
        const schedule = scheduleEdits(eventScheduleFormValues(editing), { date, endsAt, allDay });
        const payload: UpdateClientEventRequest = {
          source: editing.source,
          matterId: editing.matterId || undefined,
          type,
          title,
          ...(schedule.date !== undefined ? { date } : {}),
          ...(schedule.endsAt !== undefined ? { endsAt: endsAtPayloadFor(allDay, endsAt) } : {}),
          ...(schedule.allDay !== undefined ? { allDay } : {}),
          notes: notes || null,
          ...(courtTouched ? { courtId: selectedCourtId || null } : {}),
          locationName: locationName || null,
          location: location || null,
          status,
          assignedTo,
          assignedToName,
          contactIds,
          linkedFiles,
          clientVisible,
          clientDescription: clientDescription || null,
        };
        await clientsService.updateClientEvent(lawFirmId, clientId, editing.id, payload);
      } else {
        const payload: CreateClientEventRequest = {
          type,
          title,
          date,
          endsAt: endsAtPayloadFor(allDay, endsAt) ?? undefined,
          notes: notes || undefined,
          courtId: selectedCourtId || undefined,
          locationName: locationName || undefined,
          location: location || undefined,
          status,
          matterId: selectedMatterId || undefined,
          allDay,
          assignedTo,
          assignedToName,
          contactIds,
          linkedFiles,
          clientVisible,
          clientDescription: clientDescription || undefined,
        };
        await clientsService.createClientEvent(lawFirmId, clientId, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save event"));
    } finally {
      setSubmitting(false);
    }
  };

  const isMatterEventEdit = displayedEditing?.source === "matter";

  return (
    <EntityEventForm
      open={open}
      onClose={onClose}
      onSubmit={handleSubmit}
      lawFirmId={lawFirmId}
      fieldIds={fieldIds}
      fields={fields}
      isEditing={isEditing}
      editingId={editing?.id}
      addTitle="Add Client Event"
      filePickerMatterId={selectedMatterId || undefined}
      typeField={
            <Dropdown
              portal
              label="Event Type"
              value={type}
              onChange={(value) => handleTypeChange(value as MatterEventType)}
              options={eventTypeOptions}
            />
      }
      statusField={
            <Dropdown
              portal
              label="Status"
              value={status}
              onChange={(value) => setStatus(value as MatterEventStatus)}
              options={statusOptions}
            />
      }
      beforeLocationFields={
        <>
            {!isEditing && clientMatters.length > 0 && (
              <div>
                <FieldLabel id={`${fieldIds}-link-to-matter-label`}>
                  Link to Matter
                </FieldLabel>
                <Dropdown
                  ariaLabelledBy={`${fieldIds}-link-to-matter-label`}
                  portal
                  value={selectedMatterId}
                  onChange={handleMatterChange}
                  options={matterOptions}
                  placeholder="No matter (standalone event)"
                />
                {selectedMatterId && (
                  <p className="mt-1 text-xs text-on-surface-muted">
                    This event will also appear in the matter&apos;s Events tab.
                  </p>
                )}
              </div>
            )}

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-sm font-medium text-on-surface">Court</label>
                <CourtDirectoryLink lawFirmId={lawFirmId} />
              </div>
              <Dropdown
                portal
                value={selectedCourtId}
                onChange={handleCourtChange}
                options={courtOptions}
                placeholder={courtsLoading ? "Loading courts..." : "No court"}
                disabled={courtsLoading}
                searchable
                searchPlaceholder="Search courts"
              />
            </div>

            {isMatterEventEdit && displayedEditing?.matterName && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-surface-alt border border-outline-subtle">
                <Briefcase size={13} className="text-on-surface-muted shrink-0" />
                <span className="text-xs text-on-surface-secondary">
                  Linked to matter: <span className="font-medium text-on-surface">{displayedEditing.matterName}</span>
                </span>
              </div>
            )}
        </>
      }
    />
  );
}

/**
 * Where an event happened, as shown in its details panel: the court, the
 * location name, then the address, dropping a part that repeats an earlier one.
 */
function venueParts(event: ClientEvent): string[] {
  return [eventCourtName(event.source, event), event.locationName || null, event.location || null].filter(
    (value, index, arr): value is string => !!value && arr.findIndex((part) => (part || "").toLowerCase() === value.toLowerCase()) === index
  );
}

interface ClientEventsTabProps {
  lawFirmId: string;
  clientId: string;
  clientMatters: MatterOption[];
  canManage: boolean;
  /**
   * Whether the viewer may change a MATTER's events. The backend requires
   * `matters.update` on top of `clients.manage` to edit, delete or complete a
   * matter-sourced event from here, so without it those rows offer no controls.
   */
  canUpdateMatters?: boolean;
  /** Linked-company id -> name, for the "why is this here" badge on an event
   *  pulled in from a company this client is linked to. */
  companyNames: Map<string, string>;
}

export default function ClientEventsTab({ lawFirmId, clientId, clientMatters, canManage, canUpdateMatters = false, companyNames }: ClientEventsTabProps) {
  const { navigate } = useNavigation();
  // Shared with ClientDetail via the ["clientDetailEvents", ...] query key, so the
  // list that backs ClientDetail's count badge is fetched once and re-read by the
  // invalidation below after a mutation. The rows this tab renders come from the
  // paged sections underneath, which now hang off that same key.
  const { error: loadError } = useClientDetailEvents(lawFirmId, clientId);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ClientEvent | null>(null);
  const [deletingEvent, setDeletingEvent] = useState<ClientEvent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [completingEventId, setCompletingEventId] = useState<string | null>(null);
  // A matter event being completed while events it depends on are unfinished,
  // with those events, held for the same confirm the matter tab asks for.
  const [completionOverride, setCompletionOverride] = useState<{ event: ClientEvent; unresolved: EventGraphNode[] } | null>(null);
  const shownCompletionOverride = useLastOpenValue(!!completionOverride, completionOverride);
  const filter = useEventStatusFilter();

  const handleDelete = async () => {
    if (!deletingEvent) return;
    setDeleting(true);
    try {
      await clientsService.deleteClientEvent(
        lawFirmId,
        clientId,
        deletingEvent.id,
        deletingEvent.source,
        deletingEvent.matterId || undefined,
      );
      const deleted = deletingEvent;
      setDeletingEvent(null);
      await refreshEvents(deleted);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete event"));
    } finally {
      setDeleting(false);
    }
  };

  // The unfinished events a matter event depends on, read from the matter's
  // whole dependency graph under the same key the matter tab reads it from, so a
  // dependency that is not on this client's page still counts.
  const unresolvedDependenciesOf = useCallback(async (event: ClientEvent): Promise<EventGraphNode[]> => {
    if (event.source !== "matter" || !event.matterId) return [];
    const matterId = event.matterId;
    const graph = await queryClient.fetchQuery({
      queryKey: ["matterEvents", lawFirmId, matterId, "graph"],
      queryFn: () => matterEventsService.getEventGraph(lawFirmId, matterId),
      staleTime: 30_000,
    });
    const nodes = graph?.events ?? [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const dependsOn = byId.get(event.id)?.dependsOn ?? [];
    return dependsOn
      .map((id) => byId.get(id))
      .filter((node): node is EventGraphNode => !!node && node.status !== "completed");
  }, [lawFirmId, queryClient]);

  const handleMarkComplete = async (event: ClientEvent, skipWarning = false) => {
    setCompletingEventId(event.id);
    try {
      if (!skipWarning) {
        const unresolved = await unresolvedDependenciesOf(event);
        if (unresolved.length > 0) {
          setCompletionOverride({ event, unresolved });
          return;
        }
      }
      await clientsService.updateClientEvent(lawFirmId, clientId, event.id, {
        source: event.source,
        matterId: event.matterId || undefined,
        status: "completed",
      });
      await refreshEvents(event);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update event"));
    } finally {
      setCompletingEventId(null);
    }
  };

  // Each section is its own server page. This tab aggregates events across every
  // matter linked to the client and completed events are never pruned, so the
  // browser never holds an institutional client's whole history.
  const upcomingPager = useClientEventsPage(lawFirmId, clientId, "upcoming", filter.showUpcoming);
  const completedPager = useClientEventsPage(lawFirmId, clientId, "completed", filter.showCompleted);
  const cancelledPager = useClientEventsPage(lawFirmId, clientId, "cancelled", filter.showCancelled);

  // A mutation can move an event between sections, so refreshing only the one
  // that was acted on would leave it showing in both places or neither. The
  // shared list goes too, so ClientDetail's count badge keeps up.
  //
  // One invalidation on the shared key prefix rather than a fan of `refetch()`
  // calls. `refetch()` ignores a query's `enabled` flag, so the fan re-read the
  // two sections the status chips had filtered OUT of view as eagerly as the one
  // on screen: four simultaneous requests from a single click, against an API
  // instance holding twelve Postgres pool connections. Invalidating refetches
  // what is mounted and marks the rest stale, so a hidden section is re-read
  // when (and only when) it comes back.
  //
  // A matter event is also on its matter's own Events tab, which reads it under
  // ["matterEvents", firm, matter]; that prefix covers the matter's list, its
  // status sections and its dependency graph, so they are invalidated too.
  const refreshEvents = useCallback(async (changed?: ClientEvent | null) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["clientDetailEvents", lawFirmId, clientId] }),
      changed?.source === "matter" && changed.matterId
        ? queryClient.invalidateQueries({ queryKey: ["matterEvents", lawFirmId, changed.matterId] })
        : null,
    ]);
  }, [queryClient, lawFirmId, clientId]);

  const adapter: EntityEventsAdapter<ClientEvent> = {
    detailsIdPrefix: "client-event-details-",
    // The details panel holds the venue and the notes, nothing else.
    hasDetails: (event) => venueParts(event).length > 0 || !!event.notes,
    renderBadges: (event, { isOverdue }) => {
      const companyName = event.clientId ? companyNames.get(event.clientId) : undefined;
      return (
        <>
          {isOverdue && <StatusBadge variant="danger">Overdue</StatusBadge>}
          {event.source === "matter" && event.matterName && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (event.matterId) navigate(`/lawfirm/${lawFirmId}/matters/${event.matterId}`);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis hover:bg-accent-soft dark:hover:bg-accent-soft transition-[background-color,color,transform] cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <Briefcase size={10} />
              {event.matterName}
            </button>
          )}
          {companyName && <TagChip label={companyName} />}
        </>
      );
    },
    renderMeta: (event) => (
      <ZonedEventTime
        when={eventListWhen(event)}
        zone={eventZoneSuffix({ start: event.date, end: event.endsAt, timeZone: event.timeZone, allDay: event.allDay })}
        inheritTone
      />
    ),
    renderDetails: (event) => {
      const venue = venueParts(event);
      return (
        <>
          {venue.length > 0 && (
            <p className="text-xs text-on-surface-muted"><LinkifiedText text={venue.join(" · ")} /></p>
          )}
          {event.notes && (
            <p className="text-xs leading-relaxed text-on-surface-muted"><LinkifiedText text={event.notes} /></p>
          )}
        </>
      );
    },
    // Standalone events pulled in from a linked company aren't this client's own
    // record to mutate: edit/delete/complete on them 404s server-side, since those
    // actions are scoped to the person's own client id, not the widened set this
    // tab reads from. Matter-sourced events are unaffected (they're scoped by
    // matterId, not clientId) and keep full controls.
    rowActions: (event) => {
      const companyName = event.clientId ? companyNames.get(event.clientId) : undefined;
      if (!canManage || companyName) return null;
      // A matter event is the matter's record; changing it also needs matters.update.
      if (event.source === "matter" && !canUpdateMatters) return null;

      const rowMenuActions: RowAction[] = [
        {
          label: "Edit event",
          icon: <Pencil className="w-4 h-4" />,
          onClick: () => setEditingEvent(event),
        },
        {
          label: "Delete event",
          icon: <Trash2 className="w-4 h-4" />,
          danger: true,
          onClick: () => setDeletingEvent(event),
        },
      ];

      return {
        // Offered on open events only, as on the matter tab. Reopening a
        // completed event is done from Edit, so this button never undoes itself.
        primary: event.status !== "cancelled" && event.status !== "completed" && (
          <ActionIconButton
            label="Mark as completed"
            onClick={() => handleMarkComplete(event)}
            disabled={completingEventId === event.id}
            tone="success"
          >
            {completingEventId === event.id
              ? <Spinner size={15} />
              : <CheckCircle size={15} />}
          </ActionIconButton>
        ),
        menu: rowMenuActions,
      };
    },
    // The menu always carries edit and delete, so it is never empty.
    hideEmptyRowMenu: false,
    emptyMessage: {
      canManage: "Add court dates, deadlines, and meetings to track important dates for this client.",
      readOnly: "No events have been added for this client.",
    },
  };

  return (
    <EntityEventsTab<ClientEvent>
      canManage={canManage}
      filter={filter}
      sections={{ upcoming: upcomingPager, completed: completedPager, cancelled: cancelledPager }}
      error={error ?? (loadError ? "Failed to load events" : null)}
      onDismissError={() => setError(null)}
      onAdd={() => setAddOpen(true)}
      adapter={adapter}
    >
      <EventFormModal
        open={addOpen || !!editingEvent}
        onClose={() => { setAddOpen(false); setEditingEvent(null); }}
        onSaved={() => refreshEvents(editingEvent)}
        lawFirmId={lawFirmId}
        clientId={clientId}
        clientMatters={canUpdateMatters ? clientMatters : []}
        editing={editingEvent}
      />

      <ConfirmModal
        isOpen={!!deletingEvent}
        title="Delete Event"
        message={`Are you sure you want to delete "${deletingEvent?.title}"?${deletingEvent?.source === "matter" ? " This will also remove it from the matter's events." : ""}`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeletingEvent(null)}
      />

      <ConfirmModal
        isOpen={!!completionOverride}
        title="Complete Blocked Event?"
        message={`This event still depends on unfinished events: ${(shownCompletionOverride?.unresolved ?? []).map((node) => node.title).join(", ")}. You can mark it completed anyway if that is intentional.`}
        confirmText="Complete Anyway"
        onConfirm={() => {
          if (!completionOverride) return;
          const { event } = completionOverride;
          setCompletionOverride(null);
          void handleMarkComplete(event, true);
        }}
        onClose={() => setCompletionOverride(null)}
      />
    </EntityEventsTab>
  );
}
