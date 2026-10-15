"use client";

import AttachClientModal, { type AttachClientTarget } from "@/components/clientComp/AttachClientModal";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  matterId: string;
  onAfter?: () => Promise<void> | void;
  existingMatterClientIds?: string[];
};

/**
 * Attach a client to a matter. The search / create / edit flow is shared with
 * the task version; only the attach and detach calls are the matter's own.
 */
export default function AddClientModal({
  open,
  onClose,
  lawFirmId,
  matterId,
  onAfter,
  existingMatterClientIds = [],
}: Props) {
  const target: AttachClientTarget = {
    label: "Matter",
    attachedClientIds: existingMatterClientIds,
    attach: async ({ clientId, name }) => {
      const { default: MattersService } = await import("@/services/matters.service");
      await MattersService.addClient({ lawFirmId, matterId, client: { clientId, name } });
    },
    detach: async (clientId) => {
      const { default: MattersService } = await import("@/services/matters.service");
      await MattersService.removeClient({ lawFirmId, matterId, clientId });
    },
    invalidateKeys: [["matters", lawFirmId]],
  };

  return (
    <AttachClientModal
      open={open}
      onClose={onClose}
      lawFirmId={lawFirmId}
      target={target}
      onAfter={onAfter}
    />
  );
}
