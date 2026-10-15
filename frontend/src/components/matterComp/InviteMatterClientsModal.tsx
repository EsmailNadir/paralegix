"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, UserPlus } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ErrorNotification from "@/components/ErrorNotification";
import EditClientModal from "@/components/matterComp/EditClientModal";
import mattersService from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { MatterClient } from "@/types";
import { useResetAfterClose } from "@/hooks/useMountTransition";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  matterId: string;
};

type RowStatus = "inviting" | "invited";

/**
 * Lists the matter's clients who can't be messaged yet because they have no
 * portal account (Person clients only - a company gets portal access per
 * contact, from its Contacts tab). Each row either sends the invite directly
 * (email already on file) or opens the same edit-and-invite flow used
 * elsewhere on the matter, for a client missing an email.
 */
export default function InviteMatterClientsModal({ open, onClose, lawFirmId, matterId }: Props) {
  const queryClient = useQueryClient();
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const [error, setError] = useState<string | null>(null);
  useResetAfterClose(open, () => setError(null));
  const [editingClient, setEditingClient] = useState<MatterClient | null>(null);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ["matterClients", lawFirmId, matterId],
    queryFn: () => mattersService.listClients(lawFirmId, matterId),
    enabled: open && !!lawFirmId && !!matterId,
  });

  const uninvited = clients.filter((c) => c.clientType !== "company" && !c.userId);

  const refreshClients = () => {
    queryClient.invalidateQueries({ queryKey: ["matterClients", lawFirmId, matterId] });
    queryClient.invalidateQueries({ queryKey: ["portalClients", lawFirmId, matterId] });
  };

  const handleInvite = async (client: MatterClient) => {
    if (!client.email) return;
    setError(null);
    setRowStatus((prev) => ({ ...prev, [client.id]: "inviting" }));
    try {
      await clientsService.inviteClientToLawFirm(client.email, lawFirmId);
      setRowStatus((prev) => ({ ...prev, [client.id]: "invited" }));
      refreshClients();
    } catch (e) {
      setRowStatus((prev) => {
        const next = { ...prev };
        delete next[client.id];
        return next;
      });
      setError(getErrorMessage(e, "Failed to invite client"));
    }
  };

  return (
    <>
      <Modal isOpen={open && !editingClient} onClose={onClose} title="Invite clients to the portal" size="lg" lockScroll bodyClassName={null}>
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-on-surface-secondary">
            A client needs a portal account before they can be messaged here.
          </p>
          <ErrorNotification error={error} onClose={() => setError(null)} compact />

          {isLoading ? (
            <ListSkeleton rows={4} label="Loading clients" />
          ) : uninvited.length === 0 ? (
            <ListEmptyState
              compact
              icon={<UserPlus size={32} />}
              title="Everyone's on the portal"
              message="Every client on this matter already has portal access."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-outline bg-surface">
              {uninvited.map((client) => {
                const status = rowStatus[client.id];
                return (
                  <div
                    key={client.id}
                    className="flex items-center gap-3 border-b border-outline-subtle px-4 py-3 last:border-b-0"
                  >
                    <Avatar size="sm" name={client.name} email={client.email} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-on-surface truncate">{client.name}</div>
                      <div className="text-xs text-on-surface-muted truncate">
                        {client.email || "No email on file"}
                      </div>
                    </div>
                    {status === "invited" ? (
                      <span className="text-xs font-medium text-green-600 dark:text-green-400 shrink-0">Invited</span>
                    ) : client.email ? (
                      <Button
                        type="secondary"
                        size="small"
                        icon={<Mail size={13} />}
                        loading={status === "inviting"}
                        disabled={status === "inviting"}
                        onClick={() => handleInvite(client)}
                      >
                        Invite
                      </Button>
                    ) : (
                      <Button
                        type="secondary"
                        size="small"
                        icon={<Pencil size={13} />}
                        onClick={() => setEditingClient(client)}
                      >
                        Add email
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg">
          <Button type="secondary" onClick={onClose}>Close</Button>
        </div>
      </Modal>

      <EditClientModal
        open={!!editingClient}
        onClose={() => setEditingClient(null)}
        lawFirmId={lawFirmId}
        client={editingClient}
        // Refresh only: the edit dialog closes itself once everything saved, and
        // stays open to say so when the invite was refused.
        onAfter={refreshClients}
      />
    </>
  );
}
