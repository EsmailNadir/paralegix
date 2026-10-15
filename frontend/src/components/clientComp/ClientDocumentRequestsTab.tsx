"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import FilePickerModal, { type SelectedFile } from "@/components/matterComp/FilePickerModal";
import { usePermissions } from "@/contexts/PermissionsContext";
import documentRequestsService, {
  type DocumentRequest,
  type DocumentRequestItemStatus,
} from "@/services/documentRequests.service";
import useFirmClientDocumentRequests, {
  firmClientDocumentRequestsKey,
} from "@/hooks/documentRequestsHooks/useFirmClientDocumentRequests";
import CreateDocumentRequestModal from "@/components/documentRequestsComp/CreateDocumentRequestModal";
import DocumentRequestCard from "@/components/documentRequestsComp/DocumentRequestCard";
import type { Matter } from "@/types/matter";
import Button from "@/components/ui/Button";

interface ClientDocumentRequestsTabProps {
  lawFirmId: string;
  clientId: string;
  clientName: string;
  clientMatters: Matter[];
  /** Switch to the Files tab, open the folder a fulfillment's file lives in,
   *  and briefly flash it. `matterId` is null for a General request's file
   *  (it lives in the client's own file area rather than a matter's). */
  onRevealFile?: (objectPath: string, matterId: string | null) => void;
}

/**
 * A client's document requests aggregated across every matter they're on,
 * plus any "General" requests not tied to a matter (e.g. an engagement
 * letter). Requests render through the same `DocumentRequestCard` the
 * per-matter Documents tab uses, grouped into a "General" section and one
 * section per matter, each skipped when it has no requests.
 */
export default function ClientDocumentRequestsTab({
  lawFirmId,
  clientId,
  clientName,
  clientMatters,
  onRevealFile,
}: ClientDocumentRequestsTabProps) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("documents.request");

  const { requests, loading, error } = useFirmClientDocumentRequests(lawFirmId, clientId);

  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | Error | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filePickerTarget, setFilePickerTarget] = useState<{ request: DocumentRequest; itemId: string } | null>(null);
  const filePickerOpen = filePickerTarget !== null;
  // Closing clears the target, so render the last one while the picker plays
  // its exit animation instead of unmounting it on the spot.
  const filePickerShown = useLastOpenValue(filePickerOpen, filePickerTarget);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: firmClientDocumentRequestsKey(lawFirmId, clientId) });

  const handleSetItemStatus = async (
    request: DocumentRequest,
    itemId: string,
    status: DocumentRequestItemStatus
  ) => {
    if (!canManage || busyItemId) return;
    setActionError(null);
    setBusyItemId(itemId);
    try {
      await documentRequestsService.setItemStatus(lawFirmId, request.id, itemId, status);
      await invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err : "Failed to update item");
    } finally {
      setBusyItemId(null);
    }
  };

  const handleLinkFiles = async (files: SelectedFile[]) => {
    if (!filePickerTarget) return;
    const { request, itemId } = filePickerTarget;
    setActionError(null);
    setBusyItemId(itemId);
    try {
      // Sequential rather than Promise.all: a failure on one file surfaces its
      // own error without racing the rest.
      for (const file of files) {
        await documentRequestsService.linkFile(lawFirmId, request.id, itemId, file.fileId);
      }
      await invalidate();
      setFilePickerTarget(null);
    } catch (err) {
      setActionError(err instanceof Error ? err : "Failed to link file");
    } finally {
      setBusyItemId(null);
    }
  };

  const handleUnlinkFile = async (request: DocumentRequest, itemId: string, fulfillmentId: string) => {
    if (!canManage || busyItemId) return;
    setActionError(null);
    setBusyItemId(itemId);
    try {
      await documentRequestsService.unlinkFile(lawFirmId, request.id, itemId, fulfillmentId);
      await invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err : "Failed to remove file");
    } finally {
      setBusyItemId(null);
    }
  };

  const handleSetRequestStatus = async (
    request: DocumentRequest,
    status: DocumentRequest["status"]
  ) => {
    if (!canManage || busyRequestId) return;
    setActionError(null);
    setBusyRequestId(request.id);
    try {
      await documentRequestsService.update(lawFirmId, request.id, { status });
      await invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err : "Failed to update request");
    } finally {
      setBusyRequestId(null);
    }
  };

  const openDelete = (request: DocumentRequest) => {
    setDeleteTarget(request);
    setDeleteOpen(true);
  };

  const closeDelete = () => {
    if (deleting) return;
    setDeleteOpen(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      await documentRequestsService.remove(lawFirmId, deleteTarget.id);
      await invalidate();
      setDeleteOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err : "Failed to delete request");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return <ListSkeleton rows={4} label="Loading document requests" />;
  }

  const generalRequests = requests.filter((r) => !r.matterId);
  const requestsByMatterId = new Map<string, DocumentRequest[]>();
  for (const request of requests) {
    if (!request.matterId) continue;
    const list = requestsByMatterId.get(request.matterId);
    if (list) list.push(request);
    else requestsByMatterId.set(request.matterId, [request]);
  }

  const renderCard = (request: DocumentRequest) => (
    <DocumentRequestCard
      key={request.id}
      request={request}
      clientName={clientName}
      canManage={canManage}
      requestBusy={busyRequestId === request.id}
      busyItemId={busyItemId}
      onSetRequestStatus={handleSetRequestStatus}
      onDelete={openDelete}
      onSetItemStatus={handleSetItemStatus}
      onOpenFilePicker={(req, itemId) => setFilePickerTarget({ request: req, itemId })}
      onUnlinkFile={handleUnlinkFile}
      onRevealFile={onRevealFile ? (objectPath) => onRevealFile(objectPath, request.matterId) : undefined}
      // The backend rejects linking an existing file onto a General request
      // (there's no matter file area to link from), so only offer it here for
      // requests that belong to a matter.
      allowFileLink={!!request.matterId}
    />
  );

  return (
    <div className="space-y-4">
      {/* Title row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">Document requests</h3>
          <p className="text-sm text-on-surface-secondary">
            Ask {clientName} for documents and track what has been received, across every matter and general requests.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={() => setCreateOpen(true)}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New request
          </Button>
        )}
      </div>

      <ErrorNotification error={error instanceof Error ? error : actionError} />

      {requests.length === 0 ? (
        <ListEmptyState
          compact
          icon={<FileText size={32} />}
          title="No document requests yet"
          message={
            canManage
              ? "Create a request to ask this client for the documents you need."
              : "Requests sent to this client will appear here."
          }
        />
      ) : (
        <div className="space-y-6">
          {generalRequests.length > 0 && (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-on-surface-secondary uppercase tracking-wide">General</h4>
              <div className="space-y-4">{generalRequests.map(renderCard)}</div>
            </div>
          )}
          {clientMatters.map((matter) => {
            const matterRequests = requestsByMatterId.get(matter.id);
            if (!matterRequests || matterRequests.length === 0) return null;
            return (
              <div key={matter.id} className="space-y-4">
                <h4 className="text-sm font-semibold text-on-surface-secondary uppercase tracking-wide">
                  {matter.name || "Unnamed Matter"}
                </h4>
                <div className="space-y-4">{matterRequests.map(renderCard)}</div>
              </div>
            );
          })}
        </div>
      )}

      {canManage && (
        <CreateDocumentRequestModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          lawFirmId={lawFirmId}
          clientId={clientId}
          matterOptions={clientMatters.map((m) => ({ id: m.id, name: m.name || "Unnamed Matter" }))}
          onCreated={invalidate}
        />
      )}

      <ConfirmModal
        isOpen={deleteOpen}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title="Delete document request"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.title}"? This removes the request and its checklist for the client.`
            : "Delete this document request?"
        }
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />

      {canManage && filePickerShown?.request.matterId && (
        <FilePickerModal
          open={filePickerOpen}
          onClose={() => setFilePickerTarget(null)}
          onSelect={handleLinkFiles}
          lawFirmId={lawFirmId}
          matterId={filePickerShown.request.matterId}
          alreadyLinked={
            filePickerShown.request.items
              .find((i) => i.id === filePickerShown.itemId)
              ?.fulfillments.map((f) => f.objectPath) ?? []
          }
        />
      )}
    </div>
  );
}
