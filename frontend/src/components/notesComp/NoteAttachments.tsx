"use client";

import { useState, useRef } from 'react';
import ActionIconButton from "@/components/ui/ActionIconButton";
import { Eye, Trash2 } from "lucide-react";
import FilesService from '@/services/files.service';
import FieldError from '@/components/ui/FieldError';
import FilePreviewModal, { type PreviewableFile } from '@/components/filesComp/FilePreviewModal';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  objectPath?: string;
  file?: File;
}

interface NoteAttachmentsProps {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
  readOnly?: boolean;
  lawFirmId?: string;
  matterId?: string;
}

export default function NoteAttachments({
  attachments,
  onChange,
  readOnly = false,
  lawFirmId,
}: NoteAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFileInfo, setPreviewFileInfo] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  // Opens the shared preview modal instead of a new tab, matching every other
  // file-view affordance in the app.
  //
  // A saved attachment's record id IS its file row's, so the modal opens
  // immediately and mints its own fresh signed url from it. A file the user has
  // only just picked, and has not uploaded yet, has no row: its local url is
  // handed to the modal directly.
  const handleViewAttachment = (attachment: Attachment) => {
    setError(null);

    if (attachment.file && attachment.url) {
      setPreviewFileInfo({
        name: attachment.name,
        size: attachment.size,
        contentType: attachment.type,
        signedUrl: attachment.url,
      });
      setIsPreviewOpen(true);
      return;
    }

    if (attachment.id && lawFirmId) {
      setPreviewFileInfo({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        contentType: attachment.type,
      });
      setIsPreviewOpen(true);
      return;
    }

    // Last resort: whatever url is on hand, shown as-is.
    if (attachment.url) {
      setPreviewFileInfo({
        name: attachment.name,
        size: attachment.size,
        contentType: attachment.type,
        signedUrl: attachment.url,
      });
      setIsPreviewOpen(true);
    }
  };

  const handlePreviewDownload = async () => {
    if (!previewFileInfo) return;
    try {
      // A saved attachment mints a fresh url from its row; a locally picked
      // file has only the object url the browser made for it.
      const signedUrl = lawFirmId && previewFileInfo.id
        ? await FilesService.refreshSignedUrl(lawFirmId, previewFileInfo.id)
        : previewFileInfo.signedUrl;
      if (!signedUrl) throw new Error('This file could not be opened.');
      await FilesService.downloadFile(signedUrl, previewFileInfo.name);
    } catch (err) {
      console.error('Failed to download attachment:', err);
      setError(`Failed to download "${previewFileInfo.name}".`);
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setError(null);
    const newAttachments: Attachment[] = [];
    const tooLarge: string[] = [];

    Array.from(files).forEach(file => {
      // Check file size (max 100MB, matching the backend multer cap)
      if (file.size > 100 * 1024 * 1024) {
        tooLarge.push(file.name);
        return;
      }

      newAttachments.push({
        id: `attachment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: file.name,
        size: file.size,
        type: file.type,
        file: file,
        url: URL.createObjectURL(file)
      });
    });

    if (tooLarge.length > 0) {
      setError(
        tooLarge.length === 1
          ? `File "${tooLarge[0]}" is too large. Maximum size is 100MB.`
          : `These files are too large (maximum size is 100MB): ${tooLarge.join(', ')}`
      );
    }

    onChange([...attachments, ...newAttachments]);
  };

  const handleRemove = (id: string) => {
    const attachment = attachments.find(a => a.id === id);
    if (attachment?.url && attachment.file) {
      URL.revokeObjectURL(attachment.url);
    }
    onChange(attachments.filter(a => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getFileIcon = (type: string): string => {
    if (type.startsWith('image/')) return '🖼️';
    if (type === 'application/pdf') return '📕';
    if (type.includes('word') || type.includes('document')) return '📄';
    if (type.includes('excel') || type.includes('spreadsheet')) return '📊';
    if (type.includes('powerpoint') || type.includes('presentation')) return '📽️';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    if (type.includes('zip') || type.includes('compressed')) return '📦';
    return '📎';
  };

  return (
    <div className="space-y-3">
      <FieldError message={error} className="mt-0" />
      {/* Attachment List */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-on-surface">
            Attachments ({attachments.length})
          </label>
          <div className="space-y-2">
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className="flex items-start sm:items-center gap-2 justify-between p-2 bg-surface-alt border border-outline rounded-lg min-w-0"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                  <span className="text-lg flex-shrink-0">{getFileIcon(attachment.type)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-on-surface break-all md:truncate" title={attachment.name}>
                      {attachment.name}
                    </p>
                    <p className="text-xs text-on-surface-muted">
                      {formatFileSize(attachment.size)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {(attachment.url || attachment.objectPath) && (
                    <ActionIconButton label="View" onClick={() => handleViewAttachment(attachment)}>
                      <Eye size={16} />
                    </ActionIconButton>
                  )}
                  {!readOnly && (
                    <ActionIconButton label="Remove attachment" tone="danger" onClick={() => handleRemove(attachment.id)}>
                      <Trash2 size={16} />
                    </ActionIconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload Area */}
      {!readOnly && (
        <div
          role="button"
          tabIndex={0}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer ${
            isDragging
              ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
              : 'border-outline hover:border-input-border'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => handleFileSelect(e.target.files)}
            className="hidden"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.rtf,.odt,.ods,.odp,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.bmp,.tif,.tiff,.zip"
          />
          <svg
            className="mx-auto h-8 w-8 text-on-surface-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          <p className="mt-2 text-sm text-on-surface-secondary">
            <span className="text-accent-emphasis font-medium">Click to upload</span>
            {' '}or drag and drop
          </p>
          <p className="mt-1 text-xs text-on-surface-muted">
            PDF, Word, Excel, Images up to 100MB
          </p>
        </div>
      )}

      <FilePreviewModal
        file={previewFileInfo}
        isOpen={isPreviewOpen}
        onClose={() => { setIsPreviewOpen(false); setPreviewFileInfo(null); }}
        onDownload={handlePreviewDownload}
        lawFirmId={lawFirmId}
      />
    </div>
  );
}
