"use client";

import { X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import GroupParticipants from "./GroupParticipants";
import type { GroupParticipant, PendingGroupClient } from "@/types";

interface GroupParticipantsModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  conversationId: string;
  participants: GroupParticipant[];
  canManage: boolean;
  canAddClients?: boolean;
  currentUserId: string;
  removedParticipantIds?: string[];
  removedClientRecordIds?: string[];
  pendingClients?: PendingGroupClient[];
  // False when this is still a direct (1:1) thread. Both add and remove are
  // offered; on a 1:1 each converts the thread to a group in place first.
  isGroupThread?: boolean;
  groupHasMatter?: boolean;
  onChanged: () => void;
  // Fired when adding a participant converted a direct thread into a group.
  onConverted?: () => void;
}

// Popup dialog listing (and, for firm managers, editing) a group conversation's
// participants. Reuses GroupParticipants in its `bare` form as the modal body.
export default function GroupParticipantsModal({
  open,
  onClose,
  lawFirmId,
  conversationId,
  participants,
  canManage,
  canAddClients,
  currentUserId,
  removedParticipantIds,
  removedClientRecordIds,
  pendingClients,
  isGroupThread = true,
  groupHasMatter,
  onChanged,
  onConverted,
}: GroupParticipantsModalProps) {
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      portal
      size="lg"
      className="relative"
      title={`Participants (${participants.length})`}
      closeIcon={<X size={18} />}
      bodyClassName="px-6 py-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
    >
      <GroupParticipants
        bare
        lawFirmId={lawFirmId}
        conversationId={conversationId}
        participants={participants}
        canManage={canManage}
        canAddClients={canAddClients}
        currentUserId={currentUserId}
        removedParticipantIds={removedParticipantIds}
        removedClientRecordIds={removedClientRecordIds}
        pendingClients={pendingClients}
        isGroupThread={isGroupThread}
        groupHasMatter={groupHasMatter}
        onChanged={onChanged}
        onConverted={onConverted}
      />
    </Modal>
  );
}
