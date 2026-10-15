"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, Pencil, Trash2, ExternalLink, BookmarkPlus, Lock } from "lucide-react";
import mattersService from "@/services/matters.service";
import contactsService from "@/services/contacts.service";
import type { MatterContact } from "@/types";
import ActionIconButton from "@/components/ui/ActionIconButton";
import ContactCategoryBadge from "@/components/ui/ContactCategoryBadge";
import StatusBadge from "@/components/ui/StatusBadge";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import ListView from "@/components/ui/ListView";
import { getErrorMessage, isForbiddenError } from "@/lib/utils/apiErrors";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import LinkContactModal from "./LinkContactModal";
import Button from "@/components/ui/Button";

interface MatterContactsTabProps {
  lawFirmId: string;
  matterId: string;
  canEdit: boolean;
}

/**
 * The non-client parties on a matter.
 *
 * Each card is one link into the firm-wide contact directory: the role and the
 * note belong to this matter, everything else is the shared contact record. So
 * "Remove" takes the contact off this matter and leaves the directory alone,
 * and a corrected phone number is edited on the contact, where every other
 * matter picks it up too.
 */
export default function MatterContactsTab({ lawFirmId, matterId, canEdit }: MatterContactsTabProps) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const queryKey = ["matter-contacts", lawFirmId, matterId];
  const { data: contacts = [], isLoading, error } = useQuery<MatterContact[]>({
    queryKey,
    queryFn: () => mattersService.listContacts(lawFirmId, matterId),
    enabled: !!lawFirmId && !!matterId,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MatterContact | null>(null);
  const [deleting, setDeleting] = useState<MatterContact | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // A refusal is not a fault the reader can act on, so the list says it is not
  // theirs to see instead of showing a red banner over an empty table.
  const accessDenied = isForbiddenError(error);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey });
    // Adding a contact can create a directory record, and every link changes a
    // contact's matter count, so the directory's own lists are stale too.
    queryClient.invalidateQueries({ queryKey: ["contacts", lawFirmId] });
  };

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (contact: MatterContact) => { setEditing(contact); setModalOpen(true); };
  const requestDelete = (contact: MatterContact) => { setDeleting(contact); setDeleteOpen(true); };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setMutationError(null);
    try {
      await mattersService.deleteContact(lawFirmId, matterId, deleting.id);
      setDeleteOpen(false);
      refresh();
    } catch (err) {
      setMutationError(getErrorMessage(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const [promoting, setPromoting] = useState<string | null>(null);

  const promoteToDirectory = async (contact: MatterContact) => {
    setPromoting(contact.id);
    setMutationError(null);
    try {
      await contactsService.updateContact(lawFirmId, contact.contactId, { oneTime: false });
      refresh();
    } catch (err) {
      setMutationError(getErrorMessage(err));
    } finally {
      setPromoting(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">Related Contacts</h3>
          <p className="text-xs text-on-surface-secondary mt-0.5">
            Opposing counsel, witnesses, experts, and other non-client parties on this matter.
          </p>
        </div>
        {canEdit && (
          <Button
            size="compact"
            onClick={openAdd}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            Add Contact
          </Button>
        )}
      </div>

      <div className="space-y-4">
      {mutationError && <ErrorNotification error={mutationError} onClose={() => setMutationError(null)} />}
      {error && !accessDenied && <ErrorNotification error={error as Error} />}

      <ListView
        rows={contacts}
        loading={isLoading}
        getRowId={(contact) => contact.id}
        renderRow={(contact) => ({
          title: contact.name,
          badges: (
            <>
              <ContactCategoryBadge category={contact.role} />
              {contact.oneTime && <StatusBadge variant="neutral">One-time</StatusBadge>}
            </>
          ),
          meta: [
            [contact.title, contact.organization].filter(Boolean).join(" · "),
            contact.email,
            contact.phone,
            contact.notes,
          ]
            .filter(Boolean)
            .join("  ·  "),
        })}
        rowActions={(contact) => (
          <>
            {hasPermission("contacts.view") && (
              <ActionIconButton
                label="Open contact"
                onClick={() => navigate(`/lawfirm/${lawFirmId}/contacts/${contact.contactId}`)}
              >
                <ExternalLink size={15} />
              </ActionIconButton>
            )}
            {canEdit && hasPermission("contacts.manage") && contact.oneTime && (
              <ActionIconButton
                label="Save to Contacts directory"
                tooltip="Save to Contacts directory so it can be reused on other matters"
                onClick={() => promoteToDirectory(contact)}
                disabled={promoting === contact.id}
                tone="success"
              >
                <BookmarkPlus size={15} />
              </ActionIconButton>
            )}
            {canEdit && (
              <>
                <ActionIconButton label="Edit role on this matter" onClick={() => openEdit(contact)} tone="info">
                  <Pencil size={15} />
                </ActionIconButton>
                <ActionIconButton label="Remove from matter" onClick={() => requestDelete(contact)} tone="danger">
                  <Trash2 size={15} />
                </ActionIconButton>
              </>
            )}
          </>
        )}
        emptyIcon={accessDenied ? <Lock size={40} /> : <Users size={40} />}
        emptyTitle={accessDenied ? "Contacts are not shown for this matter" : "No related contacts yet"}
        emptyMessage={
          accessDenied
            ? "Only people on the matter can see the parties tied to it."
            : "Track opposing counsel, witnesses, experts, and other parties tied to this matter."
        }
      />
      </div>

      <LinkContactModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={refresh}
        lawFirmId={lawFirmId}
        matterId={matterId}
        editing={editing}
        canCreateContact={hasPermission("contacts.manage")}
      />

      <ConfirmModal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
        title="Remove Contact"
        message={
          deleting?.oneTime
            ? `Delete "${deleting?.name ?? "this contact"}"? It was only added for this matter.`
            : `Remove "${deleting?.name ?? "this contact"}" from this matter? They stay in your firm's contacts.`
        }
        confirmText="Remove"
        confirmType="danger"
        loading={deleteBusy}
      />
    </div>
  );
}
