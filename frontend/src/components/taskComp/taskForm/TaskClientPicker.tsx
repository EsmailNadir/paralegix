import { useState } from "react";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import SelectablePersonList from "@/components/ui/SelectablePersonList";
import { useEntityLookup } from "@/hooks/useEntityLookup";
import FieldLabel from "@/components/ui/FieldLabel";
import AttachClientModal, { type AttachClientTarget } from "@/components/clientComp/AttachClientModal";
import { usePermissions } from "@/contexts/PermissionsContext";

/**
 * Clients field for the task modals. When a matter is selected, clients are
 * inherited from it, so this shows the matter's actual clients read-only
 * rather than letting the user pick; otherwise renders a server-backed
 * client multi-select, so a firm with thousands of clients stays usable.
 */
export default function TaskClientPicker({
  lawFirmId,
  matterId,
  selectedIds,
  onChange,
}: {
  lawFirmId: string;
  matterId: string;
  selectedIds: string[];
  onChange: (clientIds: string[]) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const { hasPermission } = usePermissions();
  const target: AttachClientTarget = {
    label: "Task",
    attachedClientIds: selectedIds,
    attach: async ({ clientId }) => {
      if (!selectedIds.includes(clientId)) onChange([...selectedIds, clientId]);
    },
    invalidateKeys: [],
  };
  const { items: matterClients, loading: matterClientsLoading } = useEntityLookup(
    "clients",
    lawFirmId,
    { matterId, enabled: !!matterId }
  );

  if (matterId) {
    return (
      <div>
        <FieldLabel>Clients</FieldLabel>
        <p className="mb-2 text-xs text-on-surface-muted">
          Inherited from the selected matter.
        </p>
        <div className="overflow-hidden rounded-md border border-input-border bg-input-bg">
          {matterClientsLoading ? (
            <p className="px-3 py-6 text-center text-sm text-on-surface-muted">Loading...</p>
          ) : matterClients.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-on-surface-muted">
              This matter has no clients.
            </p>
          ) : (
            <SelectablePersonList
              people={matterClients.map((c) => ({ id: c.id, name: c.label, email: c.sublabel }))}
              selectedIds={matterClients.map((c) => c.id)}
              onToggle={() => {}}
              disabled
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <EntityMultiPicker
        entity="clients"
        lawFirmId={lawFirmId}
        label="Clients"
        selectedIds={selectedIds}
        onChange={onChange}
        disabled={!hasPermission("clients.manage")}
        listClassName="max-h-36"
        onCreateNew={hasPermission("clients.manage") ? () => setCreateOpen(true) : undefined}
        createNewLabel="Create a new client"
      />
      <AttachClientModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        lawFirmId={lawFirmId}
        target={target}
        initialMode="create"
      />
    </>
  );
}
