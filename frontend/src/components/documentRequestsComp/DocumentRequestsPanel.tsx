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
import useDocumentRequests, { documentRequestsKey } from "@/hooks/documentRequestsHooks/useDocumentRequests";
import CreateDocumentRequestModal from "./CreateDocumentRequestModal";
import DocumentRequestCard from "./DocumentRequestCard";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from "@/components/ui/ListPager";
import Button from "@/components/ui/Button";

interface DocumentRequestsPanelProps {
  lawFirmId: string;
  matterId: string;
  clients: { id: string; name: string }[];
  /** Switch to the Files tab, open the folder a fulfillment's file lives in,
   *  and briefly flash it. */
  onRevealFile?: (objectPath: string) => void;
}

export default function DocumentRequestsPanel({
  lawFirmId,
  matterId,
  clients,
  onRevealFile,
}: DocumentRequestsPanelProps) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("documents.request");

  // Each request renders its items and their fulfillments, so the row count is
  // the product rather than the sum. The server windows at the request level.
  const requestsPage = useDocumentRequests(lawFirmId, matterId);
  const { requests, loading, error } = requestsPage;

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
    queryClient.invalidateQueries({ queryKey: documentRequestsKey(lawFirmId, matterId) });

  const clientNameById = (id: string) => clients.find((c) => c.id === id)?.name || "Client";

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

  return (
    <div>
      {/* Title row */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">Document requests</h3>
          <p className="text-sm text-on-surface-secondary">
            Ask clients for documents and track what has been received.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={() => setCreateOpen(true)}
            disabled={clients.length === 0}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New request
          </Button>
        )}
      </div>

      <div className="space-y-4">
      <ErrorNotification error={error instanceof Error ? error : actionError} />

      {/* List / empty state */}
      {requestsPage.total === 0 ? (
        <ListEmptyState
          compact
          icon={<FileText size={32} />}
          title="No document requests yet"
          message={
            canManage
              ? "Create a request to ask a client for the documents you need."
              : "Requests sent to clients on this matter will appear here."
          }
        />
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <DocumentRequestCard
              key={request.id}
              request={request}
              clientName={clientNameById(request.clientId)}
              canManage={canManage}
              requestBusy={busyRequestId === request.id}
              busyItemId={busyItemId}
              onSetRequestStatus={handleSetRequestStatus}
              onDelete={openDelete}
              onSetItemStatus={handleSetItemStatus}
              onOpenFilePicker={(req, itemId) => setFilePickerTarget({ request: req, itemId })}
              onUnlinkFile={handleUnlinkFile}
              onRevealFile={onRevealFile}
            />
          ))}
          {pagerWillRender(requestsPage.total) && (
            <div>
              <ListPager
                page={requestsPage.page}
                totalPages={requestsPage.totalPages}
                total={requestsPage.total}
                rowsPerPage={requestsPage.rowsPerPage}
                onPageChange={requestsPage.setPage}
                busy={requestsPage.fetching}
                serverPaged
                rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
                onRowsPerPageChange={requestsPage.setRowsPerPage}
              />
            </div>
          )}
        </div>
      )}
      </div>

      {canManage && (
        <CreateDocumentRequestModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          lawFirmId={lawFirmId}
          matterId={matterId}
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

      {canManage && filePickerShown && (
        <FilePickerModal
          open={filePickerOpen}
          onClose={() => setFilePickerTarget(null)}
          onSelect={handleLinkFiles}
          lawFirmId={lawFirmId}
          matterId={matterId}
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
