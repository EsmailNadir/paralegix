"use client";

import { useState, useRef, useCallback } from "react";
import FilesService, { type UploadResponse } from "@/services/files.service";
import { scopeFromIds } from "@/lib/files/fileScope";
import Button from "@/components/ui/Button";
import { uploadJobKey } from "@/contexts/FileUploadContext";
import { useUploadJob } from "@/hooks/fileHooks/useUploadJob";
import { UploadFailures, UploadInProgress } from "./UploadStatus";

interface FileUploadProps {
  lawFirmId: string;
  matterId?: string;
  taskId?: string; // For tasks without a matter
  clientId?: string; // For client-specific files
  folderId?: string;
  /** Where the dropzone says files will land, e.g. "Root / Client Documents". */
  locationLabel?: string;
  /** The files that landed, and those that did not (each named, with its reason). */
  onUploadComplete?: (files: any[], failures: NonNullable<UploadResponse["failures"]>) => void;
  onError?: (error: string) => void;
  /**
   * Separates this dropzone's uploads from another's into the same scope. A
   * dropzone mounting mid-upload takes over the upload running under its key,
   * including what happens when it finishes, so two surfaces whose completion
   * does different work must not share one.
   */
  uploadSlot?: string;
}

export default function FileUpload({
  lawFirmId,
  matterId,
  taskId,
  clientId,
  folderId,
  locationLabel,
  onUploadComplete,
  onError,
  uploadSlot,
}: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<Array<{ name: string; error: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // On screen, this dropzone is the upload's display, so the provider's pill
  // stands down; and it, not one that unmounted, hears how the upload ends.
  const upload = useUploadJob({
    jobKey: uploadJobKey(lawFirmId, { matterId, taskId, clientId }, uploadSlot),
    onDone: (response) => {
      const failures = response.failures || [];
      setUploadFailures(failures);
      // What failed stays selected, so trying again is one click. By position:
      // two picked files can share a name, and matching on it kept the one
      // that landed selected, to be uploaded again.
      const failedAt = new Set(failures.map((failure) => failure.index));
      const failedNames = new Set(
        failures.filter((failure) => failure.index === undefined).map((failure) => failure.name),
      );
      setSelectedFiles((current) => current.filter((file, index) => failedAt.has(index) || failedNames.has(file.name)));
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onUploadComplete?.(response.files, failures);
    },
    onFailed: (message) => onError?.(message),
  });
  const isUploading = upload.uploading;
  // Coming back mid-upload, the list shows what is uploading.
  const [selectedFiles, setSelectedFiles] = useState<File[]>(() => upload.job?.files ?? []);

  const handleFiles = useCallback((files: FileList | File[], addToExisting = false) => {
    const fileArray = Array.from(files);

    // Filter out duplicates when adding to existing files
    let filesToProcess = fileArray;
    if (addToExisting) {
      filesToProcess = fileArray.filter(newFile =>
        !selectedFiles.some(existingFile =>
          existingFile.name === newFile.name &&
          existingFile.size === newFile.size &&
          existingFile.lastModified === newFile.lastModified
        )
      );
    }

    if (addToExisting) {
      setSelectedFiles(prev => [...prev, ...filesToProcess]);
    } else {
      setSelectedFiles(filesToProcess);
    }
    setUploadFailures([]);
  }, [selectedFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // The list is what is uploading; it does not change until the upload ends.
    if (isUploading) return;
    // A dropped folder arrives in `files` as a File with the folder's name and
    // nothing readable behind it, which fails the whole batch when it is read or
    // uploads as an empty document. Only the entry says what it is, and it is
    // only readable during this event.
    const items = Array.from(e.dataTransfer.items ?? []);
    if (items.length === 0 || items.some((item) => typeof item.webkitGetAsEntry !== 'function')) {
      handleFiles(e.dataTransfer.files, true);
      return;
    }
    const files: File[] = [];
    const folders: string[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry();
      if (entry?.isDirectory) {
        folders.push(entry.name);
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    // Always add to existing files when dropping
    handleFiles(files, true);
    setUploadFailures(folders.map((name) => ({
      name,
      error: "Folders can't be uploaded. Drop the files inside it instead.",
    })));
  }, [handleFiles, isUploading]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, addToExisting = false) => {
    if (e.target.files) {
      handleFiles(e.target.files, addToExisting);
      // Clear the input to prevent duplicate selections
      e.target.value = '';
    }
  }, [handleFiles]);

  const handleUpload = () => {
    if (selectedFiles.length === 0 || isUploading) return;

    setUploadFailures([]);
    const files = selectedFiles;
    // A matter-linked task uploads into the task, so its files carry the
    // taskId metadata that keeps them in the task's view (see uploadContextFor).
    const scope = scopeFromIds({ matterId, taskId, clientId });
    upload.start(files, (signal, onFinalizing) => FilesService.upload(
      lawFirmId,
      scope,
      files,
      // No progress callback: the bar is one steady indicator for the whole
      // upload, because a byte percentage measures only the transfer and runs
      // out long before the server has finished with the files.
      undefined,
      folderId,
      signal,
      onFinalizing
    ));
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-4">
      {/* Upload Area */}
      <div
        aria-disabled={isUploading}
        className={`border-2 border-dashed rounded-lg py-6 px-4 md:py-8 md:px-6 text-center transition-colors ${
          isUploading
            ? 'border-outline opacity-60 cursor-not-allowed'
            : isDragOver
              ? 'border-accent-control-ring bg-blue-50 dark:bg-blue-900/20 cursor-pointer'
              : 'border-outline hover:border-input-border cursor-pointer'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}
      >
        <input
          ref={fileInputRef}
          name="file-upload"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e, selectedFiles.length > 0)}
          accept="*/*"
        />
        <svg className="mx-auto h-10 w-10 md:h-12 md:w-12 text-on-surface-muted" stroke="currentColor" fill="none" viewBox="0 0 48 48">
          <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="mt-2 md:mt-3 text-xs md:text-sm font-medium text-accent-emphasis">Upload files</p>
        <p className="mt-0.5 md:mt-1 text-xs md:text-sm text-on-surface-secondary">or drag and drop</p>
        {locationLabel && (
          <p className="mt-1.5 text-xs text-on-surface-muted">Uploads to {locationLabel}</p>
        )}
      </div>

      <UploadFailures failures={uploadFailures} />

      {/* Selected Files */}
      {selectedFiles.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-on-surface">
              Selected Files ({selectedFiles.length})
            </h3>
            <div className="flex items-center space-x-3">
              <button
                onClick={clearFiles}
                disabled={isUploading}
                className="text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Clear all
              </button>
            </div>
          </div>
          
          {/* Scrollable file list with max height */}
          <div className="max-h-60 overflow-y-auto overflow-x-hidden space-y-2 border border-outline rounded-lg p-2">
            {selectedFiles.map((file, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-surface-alt rounded-lg">
                <div className="flex items-center space-x-3 min-w-0 flex-1">
                  <svg className="h-5 w-5 text-on-surface-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-on-surface truncate">{file.name}</p>
                    <p className="text-xs text-on-surface-muted">{FilesService.formatFileSize(file.size)}</p>
                  </div>
                </div>
                <button
                  onClick={() => removeFile(index)}
                  disabled={isUploading}
                  aria-label={`Remove ${file.name}`}
                  className="p-1.5 -m-1.5 text-red-600 hover:text-red-700 hover:bg-red-100 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/40 rounded-md transition-colors cursor-pointer flex-shrink-0 ml-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Upload Progress */}
          {isUploading && <UploadInProgress finalizing={upload.finalizing} onCancel={upload.cancel} />}

          {/* Upload Button */}
          <Button
            onClick={handleUpload}
            disabled={isUploading}
            className="w-full"
          >
            {isUploading ? 'Uploading...' : `Upload ${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''}`}
          </Button>
        </div>
      )}
    </div>
  );
}
