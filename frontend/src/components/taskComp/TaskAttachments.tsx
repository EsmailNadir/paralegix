"use client";

import { useState } from "react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import { Eye, Trash2 } from "lucide-react";
import FilesService, { type UploadedFile } from "@/services/files.service";
import type { TaskAttachment } from "@/types";
import FilePreviewModal from "@/components/filesComp/FilePreviewModal";
import type { PreviewableFile } from "@/components/filesComp/FilePreviewModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import BusyToast from "@/components/ui/BusyToast";
import Spinner from "@/components/ui/Spinner";
import Toast from "@/components/ui/Toast";
import FileUpload from "@/components/filesComp/FileUpload";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface TaskAttachmentsProps {
  lawFirmId: string;
  taskId: string;
  attachments: TaskAttachment[];
  onAttachmentsChange: (attachments: TaskAttachment[]) => void;
  readOnly?: boolean;
  onError?: (message: string | null) => void;
  /** When true, show the list of files. Use on Files tab. */
  showFileList?: boolean;
  /** When true with showFileList, render upload area first then file list (matches matter Files layout). */
  uploadFirst?: boolean;
  /** When true, render upload as a compact button instead of large drag-drop area (for Quick Add context). */
  compactUpload?: boolean;
}

export default function TaskAttachments({
  lawFirmId,
  taskId,
  attachments,
  onAttachmentsChange,
  readOnly = false,
  onError,
  showFileList = false,
  uploadFirst = false,
  compactUpload = false,
}: TaskAttachmentsProps) {
  const [downloading, setDownloading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [previewFileInfo, setPreviewFileInfo] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [attachmentToDelete, setAttachmentToDelete] = useState<TaskAttachment | null>(null);
  /** How many files the last batch landed, when it landed whole; drives the toast. */
  const [landed, setLanded] = useState<number | null>(null);

  // Opens the modal immediately, before the signed URL is fetched, and lets
  // FilePreviewModal fetch it itself (via the `lawFirmId` prop below) exactly
  // as FileBrowser does. Its backdrop blocks the attachment list the instant
  // it mounts, which is what makes clicking two attachments in quick
  // succession safe: unlike an await-then-open sequence, there is no window
  // where the list stays clickable while a slower, now-stale fetch is still
  // in flight to overwrite whichever attachment opened first.
  const handleView = (att: TaskAttachment) => {
    onError?.(null);
    // The attachment record's id IS the file row's, so the preview can mint a
    // fresh signed url from it. An older record with only a url still opens,
    // using the url it carries, rather than navigating away to a new tab.
    if (!att.id || !lawFirmId) {
      if (!att.url) return;
      setPreviewFileInfo({
        name: att.name,
        size: att.size,
        contentType: att.type,
        signedUrl: att.url,
      });
      setIsPreviewOpen(true);
      return;
    }
    setPreviewFileInfo({
      id: att.id,
      name: att.name,
      size: att.size,
      contentType: att.type,
    });
    setIsPreviewOpen(true);
  };

  const handlePreviewDownload = async () => {
    if (!previewFileInfo) return;
    setDownloading(true);
    try {
      // FilePreviewModal resolves its own signed URL into local state rather
      // than writing it back here, so the one held here is blank under the
      // open-immediately flow above; resolve it fresh.
      const signedUrl = previewFileInfo.id
        ? await FilesService.refreshSignedUrl(lawFirmId, previewFileInfo.id)
        : previewFileInfo.signedUrl;
      if (!signedUrl) throw new Error("This file could not be opened.");
      await FilesService.downloadFile(signedUrl, previewFileInfo.name);
    } catch (err) {
      onError?.(getErrorMessage(err, "Download failed"));
    } finally {
      setDownloading(false);
    }
  };

  const handleRemoveClick = (att: TaskAttachment) => {
    setAttachmentToDelete(att);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!attachmentToDelete) return;
    const att = attachmentToDelete;
    if (!att.id) {
      onAttachmentsChange(attachments.filter((a) => a.id !== att.id));
      setAttachmentToDelete(null);
      return;
    }
    setRemovingId(att.id);
    onError?.(null);
    try {
      await FilesService.deleteTaskAttachment(lawFirmId, taskId, att.id);
      onAttachmentsChange(attachments.filter((a) => a.id !== att.id));
    } catch (err) {
      onError?.(getErrorMessage(err, "Failed to delete attachment"));
    } finally {
      setRemovingId(null);
      setAttachmentToDelete(null);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const getFileIcon = (contentType: string) => {
    if (contentType.startsWith("image/")) {
      return (
        <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      );
    }
    if (contentType.startsWith("video/")) {
      return (
        <svg className="h-5 w-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      );
    }
    if (contentType.includes("pdf")) {
      return (
        <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      );
    }
    return (
      <svg className="h-5 w-5 text-on-surface-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    );
  };

  const fileListBlock = showFileList && !compactUpload && (
    <div className="space-y-3">
      {!compactUpload && (
        <h3 className="text-lg font-medium text-on-surface">
          Task Files ({attachments.length})
        </h3>
      )}
      <div className={compactUpload ? "space-y-2 max-h-48 overflow-y-auto overflow-x-hidden" : "space-y-3"}>
        {attachments.length > 0 ? (
          attachments.map((att) => (
              <div
                key={att.id}
                className={`flex items-center justify-between gap-2 ${compactUpload ? "py-2 px-3 bg-surface border border-outline-subtle rounded-lg hover:bg-surface-hover" : "p-4 bg-surface border border-outline rounded-lg hover:bg-surface-hover"}`}
              >
                <div className="flex items-center space-x-3 min-w-0 flex-1">
                  {getFileIcon(att.type)}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-on-surface truncate">{att.name}</p>
                    <div className="text-xs text-on-surface-secondary">{formatFileSize(att.size)}</div>
                  </div>
                </div>
                <div className="flex items-center space-x-2 flex-shrink-0">
                  <ActionIconButton label="Preview file" onClick={() => handleView(att)}>
                    <Eye size={16} />
                  </ActionIconButton>
                  {!readOnly && (
                    <ActionIconButton
                      label="Delete file"
                      tone="danger"
                      onClick={() => handleRemoveClick(att)}
                      disabled={removingId === att.id}
                    >
                      {removingId === att.id ? <Spinner size={16} /> : <Trash2 size={16} />}
                    </ActionIconButton>
                  )}
                </div>
              </div>
            ))
        ) : (
          <div className={`text-center border border-outline-subtle rounded-lg bg-surface-alt ${compactUpload ? "py-4" : "py-12"}`}>
            <svg className={`mx-auto text-on-surface-muted ${compactUpload ? "h-8 w-8" : "h-12 w-12"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-on-surface">No files yet</h3>
            <p className={`text-on-surface-muted ${compactUpload ? "text-xs mt-0.5" : "text-sm mt-1"}`}>
              {compactUpload ? "Use the Upload button to add files" : "Upload files using the area above"}
            </p>
          </div>
        )}
      </div>
    </div>
  );

  /**
   * The file manager's dropzone, filing into the task. What lands is added to
   * the task's attachments as they stand when it lands, since this component
   * may have re-rendered (or the task been edited) while the upload ran.
   */
  const handleUploaded = (files: UploadedFile[], failures: Array<{ name: string; error: string }>) => {
    if (files.length > 0) {
      onAttachmentsChange([
        ...attachments,
        ...files.map((file) => ({
          id: file.fileId,
          name: file.name,
          size: file.size,
          type: file.contentType || "application/octet-stream",
          url: file.signedUrl,
          objectPath: file.objectPath,
        })),
      ]);
    }
    if (failures.length === 0) setLanded(files.length);
  };

  const uploadBlock = !readOnly && (
    <>
      <FileUpload
        lawFirmId={lawFirmId}
        taskId={taskId}
        uploadSlot="task-attachments"
        onUploadComplete={handleUploaded}
        onError={(message) => onError?.(message)}
      />
      {landed !== null && (
        <Toast
          message={`Uploaded ${landed} file${landed === 1 ? "" : "s"}`}
          tone="success"
          duration={3000}
          onDismiss={() => setLanded(null)}
        />
      )}
    </>
  );

  return (
    <div className="space-y-4">
      {uploadFirst ? (
        <>
          {uploadBlock}
          {fileListBlock}
        </>
      ) : compactUpload ? (
        uploadBlock
      ) : (
        <>
          {fileListBlock}
          {uploadBlock}
        </>
      )}

      {showFileList && !compactUpload && (
        <>
          <FilePreviewModal
            isOpen={isPreviewOpen}
            onClose={() => { setIsPreviewOpen(false); setPreviewFileInfo(null); }}
            file={previewFileInfo}
            onDownload={handlePreviewDownload}
            lawFirmId={lawFirmId}
          />
          <ConfirmModal
            isOpen={deleteConfirmOpen}
            onClose={() => { setDeleteConfirmOpen(false); setAttachmentToDelete(null); }}
            onConfirm={confirmDelete}
            title="Delete attachment"
            message={`Are you sure you want to delete "${attachmentToDelete?.name}"? This action cannot be undone.`}
            confirmText="Delete"
            cancelText="Cancel"
          />
          <BusyToast message={downloading ? "Downloading…" : null} />
        </>
      )}
    </div>
  );
}
