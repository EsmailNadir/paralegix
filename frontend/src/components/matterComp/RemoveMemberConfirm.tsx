"use client";

import { useMemo, useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import type { MemberRemovalPreview } from "@/services/matters.service";

export interface RemoveMemberConfirmMember {
  userId: string;
  name?: string | null;
  email?: string | null;
}

interface RemoveMemberConfirmProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the member who inherits the assignments, or null to leave them unassigned. */
  onConfirm: (reassignTo: string | null) => void;
  /** Everyone being removed in this action. */
  members: RemoveMemberConfirmMember[];
  /** Members who stay on the matter. A member being removed is never offered as the target. */
  remainingMembers: RemoveMemberConfirmMember[];
  /** What the server says is still assigned to `members` on this matter. */
  preview: MemberRemovalPreview | null;
  loading?: boolean;
  /** Render above another open dialog instead of beside it. */
  stacked?: boolean;
}

const UNASSIGNED = "";

const displayName = (member: RemoveMemberConfirmMember) => member.name || member.email || "Unnamed member";

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * The confirm shown before members leave a matter.
 *
 * Removing a member does not touch the tasks and events they were assigned on
 * this matter, so the confirm says how much is still pointing at them and lets
 * the caller hand it to a member who stays. With nothing assigned it is the
 * plain "are you sure". Task reminders are never moved: they stop, and the
 * confirm says so without offering a target.
 *
 * Shared by the matter page's Team tab and the Team step of `EditMatterModal`.
 */
export default function RemoveMemberConfirm({
  isOpen,
  onClose,
  onConfirm,
  members,
  remainingMembers,
  preview,
  loading,
  stacked,
}: RemoveMemberConfirmProps) {
  const [reassignTo, setReassignTo] = useState(UNASSIGNED);
  useResetAfterClose(isOpen, () => setReassignTo(UNASSIGNED));

  const removedIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  const totals = useMemo(() => {
    const sums = { openTasks: 0, upcomingEvents: 0, reminderSlots: 0 };
    for (const entry of preview?.users ?? []) {
      if (!removedIds.has(entry.userId)) continue;
      sums.openTasks += entry.openTasks;
      sums.upcomingEvents += entry.upcomingEvents;
      sums.reminderSlots += entry.reminderSlots;
    }
    return sums;
  }, [preview, removedIds]);

  const targets = useMemo(
    () => remainingMembers.filter((m) => !removedIds.has(m.userId)),
    [remainingMembers, removedIds],
  );

  const who = members.length === 1 ? displayName(members[0]) : "the members being removed";
  const names = members.map(displayName).join(", ");
  const hasWork = totals.openTasks + totals.upcomingEvents > 0;
  const canReassign = hasWork && targets.length > 0;

  let message: string;
  if (hasWork) {
    const parts = [
      totals.openTasks > 0 ? plural(totals.openTasks, "open task") : null,
      totals.upcomingEvents > 0 ? plural(totals.upcomingEvents, "upcoming event") : null,
    ].filter(Boolean);
    message = `Remove “${names}” from this matter? ${parts.join(" and ")} on this matter ${
      totals.openTasks + totals.upcomingEvents === 1 ? "is" : "are"
    } assigned to ${who}.`;
  } else if (totals.reminderSlots > 0) {
    message = `Remove “${names}” from this matter? They are a recipient of ${plural(
      totals.reminderSlots,
      "task reminder",
    )} on this matter and will stop receiving them.`;
  } else {
    message = `Are you sure you want to remove “${names}” from this matter? This action cannot be undone.`;
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={() => onConfirm(canReassign && reassignTo ? reassignTo : null)}
      title={members.length === 1 ? "Remove User from Matter?" : "Remove Users from Matter?"}
      message={message}
      confirmText="Remove"
      loading={loading}
      stacked={stacked}
      extra={
        canReassign ? (
          <Dropdown
            label="Reassign to"
            value={reassignTo}
            onChange={setReassignTo}
            options={[
              { label: "Leave unassigned", value: UNASSIGNED },
              ...targets.map((m) => ({ label: displayName(m), value: m.userId })),
            ]}
          />
        ) : null
      }
    />
  );
}
