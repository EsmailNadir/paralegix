"use client";

import { useEffect, useRef, useState } from "react";
import clientPortalService, { PORTAL_DOCUMENTS_PER_UPLOAD, type PortalUploadFailure } from "@/services/client-portal.service";
import { UploadCancelledError } from "@/lib/files/resumableUpload";
import Modal from "@/components/ui/Modal";
import Dropdown from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatBytes } from "@/lib/utils/format";
import { Upload, X, FileText, CheckCircle2 } from "lucide-react";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import FieldLabel from "@/components/ui/FieldLabel";
import Button from "@/components/ui/Button";
import UploadProgressBar from "@/components/ui/UploadProgressBar";
import { UploadLimitNotice } from "@/components/ui/InlineWarning";
import { UploadFailures } from "@/components/filesComp/UploadStatus";
import { track } from "@/lib/analytics/analytics";
import useFormFeedback from "@/hooks/useFormFeedback";

// The most files one upload takes. The service declares them to the server in
// smaller groups and files them in one finalize, so this is the same limit every
// portal upload screen shows.
const MAX_FILES = PORTAL_DOCUMENTS_PER_UPLOAD;

interface MatterOption {
  id: string;
  title: string;
  matterNumber?: string;
}

interface UploadDocumentModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  // The active client-record association (organization-clients plan, Phase 5).
  // Undefined resolves via the backend's own auto-select-if-unambiguous rule.
  clientRecordId?: string;
  matters: MatterOption[];
  // Fired after a successful upload so the parent can refresh its document list.
  onUploaded: () => void;
}

export default function UploadDocumentModal({
  open,
  onClose,
  lawFirmId,
  clientRecordId,
  matters,
  onUploaded,
}: UploadDocumentModalProps) {
  const [matterId, setMatterId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, feedbackRef } = useFormFeedback();
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const [success, setSuccess] = useState(false);
  // Every byte has landed and the server is filing; a cancel no longer stops it.
  const [finalizing, setFinalizing] = useState(false);
  const [failures, setFailures] = useState<PortalUploadFailure[]>([]);
  // How many files the last pick left out for going past the limit.
  const [leftOut, setLeftOut] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The upload this dialog owns. Cleared when the dialog closes, which is how a
  // run that outlives its dialog knows it no longer has one to update.
  const uploadRef = useRef<AbortController | null>(null);

  // Closing the dialog, or leaving the page under it, stops an upload that is
  // still moving bytes rather than letting it finish unseen and file documents
  // the client walked away from. Past finalize the abort stops nothing: the
  // server files what landed whatever the browser does.
  useEffect(() => {
    if (!open) return;
    return () => {
      uploadRef.current?.abort();
      uploadRef.current = null;
    };
  }, [open]);

  // Reset the form each time the modal opens. Keyed on the sole matter's id so a
  // single-matter client still gets it preselected if the list arrives late.
  const soleMatterId = matters.length === 1 ? matters[0].id : "";
  useSeedOnOpen(open, () => {
    setMatterId(soleMatterId);
    setFiles([]);
    setUploading(false);
    setFinalizing(false);
    setFailures([]);
    setLeftOut(0);
    setError('');
    setSuccess(false);
  }, soleMatterId);

  const matterOptions = matters.map((m) => ({
    label: m.matterNumber ? `${m.title} (${m.matterNumber})` : m.title,
    value: m.id,
  }));

  const addFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (picked.length === 0) return;
    // The first files up to the limit are kept, and the rest are named in a
    // warning rather than dropped without a word.
    const added = picked.slice(0, Math.max(0, MAX_FILES - files.length));
    setFiles([...files, ...added]);
    setLeftOut(picked.length - added.length);
  };

  // The warning describes an overflow, so it goes once the selection is back
  // under the limit.
  const shownLeftOut = files.length >= MAX_FILES ? leftOut : 0;

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const canSubmit = !!matterId && files.length > 0 && !uploading;

  const handleUpload = async () => {
    if (!canSubmit) return;
    const sent = files;
    const controller = new AbortController();
    uploadRef.current = controller;
    setUploading(true);
    setFinalizing(false);
    setFailures([]);
    setError('');
    try {
      const result = await clientPortalService.uploadMatterDocuments(
        lawFirmId, matterId, sent, undefined, clientRecordId, controller.signal, () => setFinalizing(true),
      );
      // What finalize filed is filed whether or not the dialog is still open,
      // so the list behind it refreshes either way.
      track("client_document_uploaded", { file_count: result.documents.length });
      onUploaded();
      if (uploadRef.current !== controller) return;
      uploadRef.current = null;
      if (result.failures.length > 0) {
        // Only what was refused stays picked, so trying again sends just those.
        const refused = new Set(result.failures.map((f) => f.index));
        setFiles(sent.filter((_, i) => refused.has(i)));
        setFailures(result.failures);
        setUploading(false);
        setFinalizing(false);
        return;
      }
      setSuccess(true);
      // Briefly show the success state, then close.
      setTimeout(() => onClose(), 1200);
    } catch (err) {
      if (uploadRef.current !== controller) return;
      uploadRef.current = null;
      setUploading(false);
      setFinalizing(false);
      // A cancel is not a failure: the picked files stay and nothing is reported.
      if (err instanceof UploadCancelledError) return;
      setError(getErrorMessage(err, "Failed to upload documents"));
    }
  };

  // Closing stops an upload in flight, so a stray backdrop click must not.
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Upload a document"
      icon={<Upload className="w-4 h-4 text-accent-emphasis" />}
      closeIcon={<X className="w-4 h-4" />}
      size="lg"
      dismissible={!uploading}
      bodyClassName="px-5 py-4 overflow-y-auto styled-scrollbar space-y-4"
      footer={
        !success && matters.length > 0 ? (
          <>
            <Button
              type="secondary"
              size="compact"
              onClick={onClose}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button
              ref={uploadButtonRef}
              size="compact"
              onClick={handleUpload}
              disabled={!canSubmit}
              loading={uploading}
              icon={<Upload size={14} />}
            >
              {uploading ? "Uploading" : "Upload"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div ref={feedbackRef} tabIndex={-1}>
        <ErrorNotification error={error} onClose={() => { setError(''); uploadButtonRef.current?.focus(); }} />
      </div>
      <div aria-live="polite" aria-atomic="true" aria-label="Document upload" className="sr-only">
        {success ? 'Upload complete. Your files have been shared with your legal team.' : uploading ? 'Uploading documents...' : ''}
      </div>

      {success ? (
        <div className="py-8 flex flex-col items-center text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-2" />
          <p className="text-sm font-medium text-on-surface">Upload complete</p>
          <p className="text-xs text-on-surface-muted mt-1">Your files have been shared with your legal team.</p>
        </div>
      ) : (
        <>
          {matters.length === 0 ? (
            <p className="text-sm text-on-surface-muted">
              You do not have any matters to upload documents to yet.
            </p>
          ) : (
            <>
              <Dropdown
                label="Matter *"
                value={matterId}
                onChange={setMatterId}
                options={matterOptions}
                placeholder="Select a matter"
                portal
              />

              <div>
                <FieldLabel>Files *</FieldLabel>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-full rounded-md border border-dashed border-input-border bg-input-bg hover:bg-surface-hover text-on-surface-secondary text-sm py-6 flex flex-col items-center gap-1.5 transition-[background-color,border-color,color,transform] active:scale-[0.985] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-60"
                >
                  <Upload className="w-5 h-5 text-on-surface-muted" />
                  <span>Click to choose files</span>
                  <span className="text-[11px] text-on-surface-muted">Up to {MAX_FILES} files</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={addFiles}
                />
              </div>

              <UploadLimitNotice limit={MAX_FILES} leftOut={shownLeftOut} />

              {files.length > 0 && (
                <ul className="space-y-1.5">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center gap-2 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2"
                    >
                      <FileText className="w-4 h-4 text-accent-emphasis flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-on-surface truncate">{file.name}</p>
                        <p className="text-[10px] text-on-surface-muted">{formatBytes(file.size)}</p>
                      </div>
                      {!uploading && (
                        <button
                          type="button"
                          onClick={() => removeFile(index)}
                          className="p-1 rounded-md text-on-surface-muted hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {uploading && (
                <UploadProgressBar
                  onCancel={finalizing ? undefined : () => uploadRef.current?.abort()}
                />
              )}
              <UploadFailures failures={failures} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
