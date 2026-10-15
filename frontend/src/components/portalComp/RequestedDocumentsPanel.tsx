"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import clientPortalService, {
  PORTAL_DOCUMENTS_PER_UPLOAD,
  type DocumentRequest,
  type DocumentRequestItem,
  type DocumentRequestFulfillment,
  type PortalUploadFailure,
} from "@/services/client-portal.service";
import { UploadCancelledError } from "@/lib/files/resumableUpload";
import useClientDocumentRequests from "@/hooks/documentRequestsHooks/useClientDocumentRequests";
import { useAuth } from "@/hooks/useAuth";
import { formatDate as formatDateWithFallback } from "@/lib/utils/dateUtils";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { AutoPager } from "@/components/ui/ListPager";
import ActionIconButton from "@/components/ui/ActionIconButton";
import UploadProgressBar from "@/components/ui/UploadProgressBar";
import { UploadFailures } from "@/components/filesComp/UploadStatus";
import FilePreviewModal from "@/components/filesComp/FilePreviewModal";
import type { PreviewableFile } from "@/components/filesComp/FilePreviewModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import filesService from "@/services/files.service";
import usePagedRows from "@/hooks/usePagedRows";
import { Upload, Check, ClipboardList, FileText, CalendarClock, ChevronRight, Trash2 } from "lucide-react";
import { UploadLimitNotice } from "@/components/ui/InlineWarning";
import SectionLabel from "@/components/ui/SectionLabel";

interface RequestedDocumentsPanelProps {
  lawFirmId: string;
  // Scope to a single matter's requests (matter-detail page). Omit on the
  // documents page to show every open request across the client's matters.
  matterId?: string;
  // The active client-record association (organization-clients plan, Phase 5).
  // Undefined resolves via the backend's own auto-select-if-unambiguous rule;
  // pages under a firm with more than one association must resolve this before
  // rendering this panel (see ClientRecordPicker / selectionRequired).
  clientRecordId?: string;
  // Tighter styling for embedding inside an existing card (matter-detail).
  compact?: boolean;
  // Optional matter labels so a cross-matter request can show which matter it
  // belongs to. Only used when `matterId` is not set.
  matterTitleById?: Map<string, string>;
  // Fired after a successful item upload so the parent can refresh its own
  // document list (a fulfilled file becomes a shared matter document).
  onFulfilled?: () => void;
}

const formatDate = (value: unknown) => formatDateWithFallback(value, "");

export default function RequestedDocumentsPanel({
  lawFirmId,
  matterId,
  clientRecordId,
  compact = false,
  matterTitleById,
  onFulfilled,
}: RequestedDocumentsPanelProps) {
  const disclosureId = useId();
  const { requests, loading, error: loadError, refresh } = useClientDocumentRequests(lawFirmId, matterId, clientRecordId);
  const { user } = useAuth();
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Every byte has landed and the server is recording it; a cancel no longer stops it.
  const [uploadFinalizing, setUploadFinalizing] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<PortalUploadFailure[]>([]);
  // How many files the last pick left out for going past the per-upload limit.
  const [leftOut, setLeftOut] = useState(0);
  // The upload in flight. Cleared on unmount, which is how a run that outlives
  // the panel knows it has nothing left to update.
  const uploadRef = useRef<AbortController | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  const [openingFulfillmentId, setOpeningFulfillmentId] = useState<string | null>(null);
  const [deletingFulfillmentId, setDeletingFulfillmentId] = useState<string | null>(null);
  const [fileToDelete, setFileToDelete] = useState<{ item: DocumentRequestItem; f: DocumentRequestFulfillment } | null>(null);
  const removalErrorRef = useRef<HTMLDivElement>(null);
  const removalOriginRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (fileToDelete && actionError && !deletingFulfillmentId) removalErrorRef.current?.focus();
  }, [fileToDelete, actionError, deletingFulfillmentId]);

  // A single hidden file input serves every item; the item whose Upload button
  // was clicked is stashed here until the file dialog resolves.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingItemRef = useRef<DocumentRequestItem | null>(null);
  // Id of the most recently clicked fulfillment's signed-url fetch; guards
  // against an older, slower fetch overwriting a newer one's preview.
  const openFileRequestRef = useRef<string | null>(null);

  // An upload failure is the more actionable of the two, so it wins the banner.
  const error = uploadError ?? actionError ?? loadError;

  // A request defaults to collapsed once it's fully done (nothing left to act
  // on) and open otherwise; either can still be toggled by hand, and that
  // manual choice (keyed by request id) overrides the default for as long as
  // this panel stays mounted.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const toggleRequest = (id: string, defaultOpen: boolean) => {
    setExpandedOverrides((prev) => ({ ...prev, [id]: !(prev[id] ?? defaultOpen) }));
  };

  // The whole "Requested documents" section folds the same way: collapsed by
  // default once every request in it is done, open otherwise, manually
  // toggleable either way.
  const [sectionExpandedOverride, setSectionExpandedOverride] = useState<boolean | null>(null);

  // Both 'open' and 'completed' requests stay visible: a completed one still
  // has fulfillment history worth seeing, and its items can still take more
  // files (see the "Upload more" button below). Only 'cancelled' drops off,
  // matching what the backend already sends here (`listForClient`).
  const visibleRequests = useMemo(() => requests.filter((r) => r.status !== "cancelled"), [requests]);
  // On the documents page this panel spans every matter, so requests can pile
  // up; the cards are windowed behind a pager. Derived above the early returns
  // below so the hook runs on every render.
  const requestsPager = usePagedRows(visibleRequests, 5);
  const allRequestsDone = visibleRequests.every((r) => r.status === "completed");
  const sectionOpen = sectionExpandedOverride ?? !allRequestsDone;

  // Leaving the page stops an upload that is still moving bytes, rather than
  // letting it finish unseen and record files against a checklist line the
  // client walked away from. Past finalize the abort stops nothing.
  useEffect(() => () => {
    uploadRef.current?.abort();
    uploadRef.current = null;
  }, []);

  const triggerUpload = (item: DocumentRequestItem) => {
    pendingItemRef.current = item;
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    // Reset so re-selecting the same file still fires change.
    e.target.value = "";
    const item = pendingItemRef.current;
    pendingItemRef.current = null;
    if (!item || picked.length === 0) return;
    // The first files up to the limit are sent, and the rest are named in a
    // warning rather than refused along with the whole pick.
    const files = picked.slice(0, PORTAL_DOCUMENTS_PER_UPLOAD);
    setLeftOut(picked.length - files.length);

    const controller = new AbortController();
    uploadRef.current = controller;
    setUploadingItemId(item.id);
    setUploadFinalizing(false);
    setUploadError(null);
    setUploadFailures([]);
    try {
      const result = await clientPortalService.fulfillRequestItem(
        lawFirmId, item.requestId, item.id, files, undefined, clientRecordId,
        controller.signal, () => setUploadFinalizing(true),
      );
      if (uploadRef.current === controller) {
        setUploadFailures(result.failures);
        await refresh();
      }
      // What finalize recorded is recorded whether or not the panel is still
      // here, so the parent's document list refreshes either way.
      onFulfilled?.();
    } catch (err) {
      if (uploadRef.current !== controller) return;
      // A cancel is not a failure: the item simply goes back to waiting.
      if (!(err instanceof UploadCancelledError)) {
        setUploadError(getErrorMessage(err, "Failed to upload files"));
      }
    } finally {
      if (uploadRef.current === controller) {
        uploadRef.current = null;
        setUploadingItemId(null);
        setUploadFinalizing(false);
      }
    }
  };

  const handleOpenFile = async (item: DocumentRequestItem, f: DocumentRequestFulfillment) => {
    setActionError(null);
    setOpeningFulfillmentId(f.id);
    openFileRequestRef.current = f.id;
    try {
      const { signedUrl, fileName, contentType, size } =
        await clientPortalService.getRequestFulfillmentUrl(lawFirmId, item.requestId, item.id, f.id, clientRecordId);
      // A newer click may have started a fetch for a different fulfillment
      // while this one was in flight; a slower response here would otherwise
      // silently replace whatever the user has since opened.
      if (openFileRequestRef.current !== f.id) return;
      setPreviewFile({ name: fileName, size, contentType, signedUrl });
    } catch (err) {
      if (openFileRequestRef.current === f.id) {
        setActionError(getErrorMessage(err, "Failed to open file"));
      }
    } finally {
      setOpeningFulfillmentId((current) => (current === f.id ? null : current));
    }
  };

  const confirmDeleteFile = async () => {
    if (!fileToDelete) return;
    const { item, f } = fileToDelete;
    setActionError(null);
    setDeletingFulfillmentId(f.id);
    try {
      await clientPortalService.deleteRequestFulfillment(lawFirmId, item.requestId, item.id, f.id, clientRecordId);
      await refresh();
      setFileToDelete(null);
    } catch (err) {
      setActionError(getErrorMessage(err, "Failed to remove file"));
    } finally {
      setDeletingFulfillmentId(null);
    }
  };

  // Render nothing (rather than an empty panel) until the first load resolves and
  // we know whether this client has any open requests at all.
  if (loading) return null;

  if (visibleRequests.length === 0) return loadError ? <ErrorNotification error={loadError} /> : null;

  const renderItem = (item: DocumentRequestItem) => {
    const received = item.status === "received";
    const waived = item.status === "waived";
    const uploading = uploadingItemId === item.id;

    return (
      <div key={item.id} className="flex items-start gap-3 px-4 py-3">
        <div
          className={`p-1.5 rounded-lg flex-shrink-0 mt-0.5 ${
            received
              ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
              : "bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis"
          }`}
        >
          {received ? <Check className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-on-surface">{item.label}</p>
          {item.description && (
            <p className="text-xs text-on-surface-secondary mt-0.5 whitespace-pre-wrap">{item.description}</p>
          )}
          {/* Shown regardless of status: the firm can set an item back to
              pending (e.g. asking for a better copy) without the files already
              on it disappearing from the client's own view of what they sent. */}
          {item.fulfillments.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {item.fulfillments.map((f) => (
                <li key={f.id} className="group flex items-center gap-1.5 text-[11px] text-on-surface-muted">
                  <button
                    type="button"
                    onClick={() => handleOpenFile(item, f)}
                    disabled={openingFulfillmentId === f.id}
                    className="truncate hover:underline hover:text-on-surface disabled:opacity-60 cursor-pointer"
                  >
                    {f.fileName}
                  </button>
                  <span className="text-on-surface-muted">
                    {f.uploadedByName ? `${f.uploadedByName} · ` : ""}
                    {f.uploadedAt ? formatDate(f.uploadedAt) : ""}
                  </span>
                  {/* Only the client's own upload can be removed here, not a
                      file the firm attached on their behalf. */}
                  {f.uploadedBy === user?.uid && (
                    <ActionIconButton
                      label="Remove file"
                      onClick={(event) => { removalOriginRef.current = event.currentTarget.closest('li'); setActionError(null); setFileToDelete({ item, f }); }}
                      disabled={deletingFulfillmentId === f.id}
                      tone="danger"
                      size="sm"
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 size={11} />
                    </ActionIconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {waived && <p className="text-[11px] text-on-surface-muted mt-0.5">Marked as not needed.</p>}
          {uploading && (
            <UploadProgressBar
              className="mt-2"
              onCancel={uploadFinalizing ? undefined : () => uploadRef.current?.abort()}
            />
          )}
        </div>

        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          {received && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="w-3.5 h-3.5" /> Received
            </span>
          )}
          {waived && (
            <span className="inline-flex items-center rounded-md bg-surface-alt text-on-surface-muted text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide">
              Waived
            </span>
          )}
          {/* Kept visible after the item is received: the firm may ask for more
              than one file per item, so uploading once must not be the only chance. */}
          {!waived && (
            <button
              type="button"
              aria-label={`${item.fulfillments.length > 0 ? 'Upload more for' : 'Upload'} ${item.label}`}
              onClick={() => triggerUpload(item)}
              disabled={uploadingItemId !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-solid text-accent-foreground text-xs font-medium px-3 py-1.5 hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {uploading ? (
                <>
                  <LoadingSpinner size="sm" />
                  Uploading
                </>
              ) : (
                <>
                  <Upload className="w-3.5 h-3.5" /> {item.fulfillments.length > 0 ? "Upload more" : "Upload"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderRequest = (req: DocumentRequest) => {
    // A General request has no matter to look up a title for; label it
    // explicitly rather than showing nothing or a broken lookup.
    const matterLabel = !matterId
      ? (req.matterId ? matterTitleById?.get(req.matterId) : "General")
      : undefined;
    const done = req.status === "completed";
    const defaultOpen = !done;
    const open = expandedOverrides[req.id] ?? defaultOpen;
    return (
      <div
        key={req.id}
        className="rounded-xl border border-outline-subtle bg-surface overflow-hidden"
      >
        <button
          type="button"
          onClick={() => toggleRequest(req.id, defaultOpen)}
          aria-expanded={open}
          aria-controls={`${disclosureId}-${req.id}`}
          className="w-full flex items-start justify-between gap-3 px-4 py-3 border-b border-outline-subtle bg-surface-alt/60 text-left cursor-pointer"
        >
          <div className="min-w-0 flex items-start gap-2">
            <ChevronRight
              className="w-4 h-4 mt-0.5 shrink-0 text-on-surface-muted transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-on-surface truncate">{req.title}</p>
              {matterLabel && (
                <p className="text-[11px] text-on-surface-muted mt-0.5 truncate">{matterLabel}</p>
              )}
            </div>
          </div>
          {req.dueDate && (
            <span
              className={`flex-shrink-0 inline-flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-0.5 ${
                done
                  ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10"
                  : "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10"
              }`}
            >
              <CalendarClock className="w-3 h-3" /> Due {formatDate(req.dueDate)}
            </span>
          )}
        </button>
        <div
          id={`${disclosureId}-${req.id}`}
          inert={!open}
          aria-hidden={!open || undefined}
          className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            {/* The note sits in the collapsing body, not the header, so it grows
                and shrinks with the rest instead of snapping the header taller. */}
            <div className="divide-y divide-outline-subtle">
              {req.note && (
                <p className="px-4 py-3 text-xs text-on-surface-secondary whitespace-pre-wrap">
                  {req.note}
                </p>
              )}
              {req.items.map(renderItem)}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const content = (
    <>
      {error && !(fileToDelete && actionError) && (
        <div className="mb-3">
          <ErrorNotification error={error} onClose={() => { setUploadError(null); setActionError(null); }} />
        </div>
      )}
      {leftOut > 0 && (
        <div className="mb-3">
          <UploadLimitNotice limit={PORTAL_DOCUMENTS_PER_UPLOAD} leftOut={leftOut} />
        </div>
      )}
      {uploadFailures.length > 0 && (
        <div className="mb-3">
          <UploadFailures failures={uploadFailures} />
        </div>
      )}
      <div className="space-y-3">
        {requestsPager.pagedRows.map(renderRequest)}
        {requestsPager.total > requestsPager.rowsPerPage && (
          <div className="rounded-xl border border-outline-subtle bg-surface px-4 py-3">
            <AutoPager pager={requestsPager} />
          </div>
        )}
      </div>
    </>
  );

  // Shared hidden input, driven by whichever item's Upload button was clicked.
  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={handleFilesSelected}
    />
  );

  const previewModal = (
    <FilePreviewModal
      file={previewFile}
      isOpen={!!previewFile}
      onClose={() => { openFileRequestRef.current = null; setPreviewFile(null); }}
      onDownload={() => {
        if (previewFile?.signedUrl) {
          filesService.downloadFile(previewFile.signedUrl, previewFile.name);
        }
      }}
    />
  );

  const deleteConfirmModal = (
    <ConfirmModal
      isOpen={!!fileToDelete}
      onClose={() => {
        setFileToDelete(null);
        requestAnimationFrame(() => removalOriginRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]')?.focus());
      }}
      onConfirm={confirmDeleteFile}
      title="Remove file"
      message={`Remove "${fileToDelete?.f.fileName}" from this request? This cannot be undone.`}
      confirmText="Remove"
      confirmType="danger"
      loading={fileToDelete ? deletingFulfillmentId === fileToDelete.f.id : false}
      extra={actionError && <div ref={removalErrorRef} tabIndex={-1}><ErrorNotification error={actionError} onClose={() => {
        const buttons = removalErrorRef.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
        setActionError(null);
        buttons?.[buttons.length - 1]?.focus();
      }} /></div>}
    />
  );

  if (compact) {
    return (
      <div className="p-5 border-b border-outline-subtle">
        <button
          type="button"
          onClick={() => setSectionExpandedOverride(!sectionOpen)}
          aria-expanded={sectionOpen}
          aria-controls={`${disclosureId}-section`}
          className="flex items-center gap-2 mb-3 cursor-pointer"
        >
          <ChevronRight
            className="w-3.5 h-3.5 shrink-0 text-on-surface-muted transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            style={{ transform: sectionOpen ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          <ClipboardList className="w-3.5 h-3.5 text-accent-emphasis" />
          <SectionLabel>
            Requested from you
          </SectionLabel>
        </button>
        <div
          id={`${disclosureId}-section`}
          inert={!sectionOpen}
          aria-hidden={!sectionOpen || undefined}
          className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ gridTemplateRows: sectionOpen ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">{content}</div>
        </div>
        {hiddenInput}
        {previewModal}
        {deleteConfirmModal}
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-6 mb-6">
      <button
        type="button"
        onClick={() => setSectionExpandedOverride(!sectionOpen)}
        aria-expanded={sectionOpen}
        aria-controls={`${disclosureId}-section`}
        className="flex items-center gap-2 mb-1 w-full text-left cursor-pointer"
      >
        <ChevronRight
          className="w-4 h-4 shrink-0 text-on-surface-muted transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ transform: sectionOpen ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        <ClipboardList className="w-4 h-4 text-accent-emphasis" />
        <h2 className="text-base font-semibold text-on-surface">Requested documents</h2>
      </button>
      <div
        id={`${disclosureId}-section`}
        inert={!sectionOpen}
        aria-hidden={!sectionOpen || undefined}
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: sectionOpen ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="text-sm text-on-surface-muted mb-4">
            Your legal team asked you to provide these. Upload a file for each item.
          </p>
          {content}
        </div>
      </div>
      {hiddenInput}
      {previewModal}
      {deleteConfirmModal}
    </div>
  );
}
