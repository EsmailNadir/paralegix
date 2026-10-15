"use client";

import { useState, useRef, useEffect } from 'react';
import { Paperclip, X, Upload, FolderOpen, Clock } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import Button from '@/components/ui/Button';
import MentionTextarea from '@/components/ui/MentionTextarea';
import FieldError from '@/components/ui/FieldError';
import UploadProgressBar from '@/components/ui/UploadProgressBar';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import MessageFilePicker, { type PickedFile } from './MessageFilePicker';
import { useFirmMembers } from '@/hooks/useFirmMembers';
import { useMountTransition } from '@/hooks/useMountTransition';
import { menuAnim } from '@/components/ui/transitionClasses';
import messagesService from '@/services/messages.service';
import clientPortalService from '@/services/client-portal.service';
import { UploadCancelledError } from '@/lib/files/resumableUpload';
import type { MessageAttachment } from '@/types';

const MAX_ATTACHMENTS = 5;

interface MessageInputProps {
  // Resolving `false` means the send failed: the composer gives the draft and
  // its attachments back. Anything else counts as sent.
  onSend: (content: string, attachments: MessageAttachment[], mentions: string[]) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  placeholder?: string;
  lawFirmId: string;
  // Direct threads upload against the client id; group threads have no single
  // client, so they upload against the conversation id instead.
  clientId: string;
  conversationId?: string;
  isClient?: boolean;
}

// A device upload in flight. Only it can be cancelled: a file manager attach is
// a server-side copy that aborting the request would not stop.
interface DeviceUpload {
  controller: AbortController;
  files: File[];
  // Set when the composer is left mid-upload. Those files were picked for a
  // thread the user is no longer in, so they are dropped rather than kept.
  abandoned: boolean;
}

// The same file picked again. Name and size are what the composer shows for a
// chip, so two files that match on both would read as one file twice anyway.
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size;

/** Names the files finalize refused, with the first reason it gave. */
function rejectedMessage(rejected: Array<{ name: string; error: string }>): string {
  const names = rejected.map((r) => `"${r.name}"`).join(', ');
  const reason = rejected.find((r) => r.error)?.error;
  return reason ? `Could not attach ${names}: ${reason}` : `Could not attach ${names}.`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function MessageInput({
  onSend,
  disabled,
  placeholder,
  lawFirmId,
  clientId,
  conversationId,
  isClient,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  // Send reads the attachments once its upload lands, and a chip can be
  // removed while that upload runs.
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  // Picked files whose upload was cancelled or failed. They stay in the
  // composer, and Send uploads them before it sends.
  const [unsentFiles, setUnsentFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<DeviceUpload | null>(null);
  const [cancellable, setCancellable] = useState(false);
  // Firm members get a "device vs file manager" chooser on the paperclip; clients
  // have no file manager, so their paperclip opens the device picker directly.
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { mounted: menuMounted, exiting: menuExiting } = useMountTransition(sourceMenuOpen, 150);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  // Firm members power @mention autocomplete; clients can't list members (and
  // don't mention), so the query is disabled for them and the picker stays empty.
  const members = useFirmMembers(isClient ? undefined : lawFirmId);

  // A thread the portal switches to starts with an empty composer. Its thread
  // picker re-renders this composer rather than mounting a new one, so the
  // draft, the mentions and the attachments would otherwise follow into the
  // next thread, where Send posts them to people they were not meant for. A
  // thread gaining its id on its first send is the same thread, so that
  // change keeps everything.
  const [threadKey, setThreadKey] = useState({ lawFirmId, conversationId });
  // Read after an awaited send, to tell whether the composer is still on the
  // thread that send came from.
  const currentThreadRef = useRef({ lawFirmId, conversationId });
  currentThreadRef.current = { lawFirmId, conversationId };
  if (threadKey.lawFirmId !== lawFirmId || threadKey.conversationId !== conversationId) {
    const sameThread = threadKey.lawFirmId === lawFirmId && !threadKey.conversationId;
    setThreadKey({ lawFirmId, conversationId });
    if (!sameThread) {
      setContent('');
      setMentions([]);
      setPendingAttachments([]);
      setUnsentFiles([]);
      setUploadError(null);
    }
  }

  // Auto-resize textarea to fit its content. When empty, clear the inline
  // height so the CSS min-height applies; sizing to scrollHeight there would
  // grow the box to fit a placeholder that wraps on narrow screens.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!content) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [content]);

  // Close the attach-source menu on an outside click or Escape.
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (attachWrapRef.current && !attachWrapRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSourceMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [sourceMenuOpen]);

  // Leaving the composer, or the portal switching thread under it, abandons
  // the upload rather than letting it finish into a thread nobody is looking
  // at. The thread picker re-renders this composer instead of mounting a new
  // one, so the conversation is a dependency, not only the unmount.
  useEffect(() => () => {
    const attempt = uploadRef.current;
    if (!attempt) return;
    attempt.abandoned = true;
    attempt.controller.abort();
  }, [lawFirmId, conversationId]);

  // Puts files back in the composer as not uploaded yet, once each.
  const keepUnsent = (files: File[]) => {
    setUnsentFiles(prev => [...prev, ...files.filter(f => !prev.some(p => sameFile(p, f)))]);
  };

  // A cancel hands the composer back at once, with the files it was uploading
  // kept as not uploaded yet. The aborted attempt is no longer current, so
  // whatever it settles to later touches nothing.
  const cancelUpload = () => {
    const attempt = uploadRef.current;
    if (!attempt) return;
    uploadRef.current = null;
    attempt.controller.abort();
    keepUnsent(attempt.files);
    setCancellable(false);
    setUploading(false);
  };

  // Firm-side uploads need a target: a client for direct threads or the
  // conversation for group threads. Missing both means the thread hasn't
  // loaded yet, so fail with actionable copy instead of a server error.
  const uploadTargetMissing = () => {
    if (isClient || clientId || conversationId) return false;
    setUploadError('This conversation is still loading. Please wait a moment and try again.');
    return true;
  };

  // Uploads files from the device behind the progress bar and its Cancel.
  // Resolves to their attachments, or to null when the upload did not complete:
  // cancelled or failed, the files are kept as not uploaded yet (a failure also
  // shows its error); abandoned by leaving, they are dropped. Files finalize
  // refused are named in the error and reported as `rejected`; the rest attach.
  const uploadFromDevice = async (files: File[]): Promise<{ attachments: MessageAttachment[]; rejected: boolean } | null> => {
    setUploadError(null);
    setUploading(true);
    const attempt: DeviceUpload = { controller: new AbortController(), files, abandoned: false };
    uploadRef.current = attempt;
    setCancellable(true);
    // A cancelled attempt can still settle after the user has picked again, so
    // only the attempt that is still current may touch the composer.
    const isCurrent = () => uploadRef.current === attempt;
    const { signal } = attempt.controller;
    let rejected: Array<{ name: string; error: string }> = [];
    const options = {
      signal,
      // Past finalize a cancel could only discard attachments the server has
      // already verified, so the control is withdrawn, as the file manager does.
      onFinalizing: () => { if (isCurrent()) setCancellable(false); },
      onRejected: (refused: Array<{ name: string; error: string }>) => { rejected = refused; },
    };

    try {
      const uploaded = isClient
        ? await clientPortalService.uploadMessageAttachments(lawFirmId, files, undefined, conversationId, options)
        : await messagesService.uploadAttachments(lawFirmId, { clientId, conversationId }, files, undefined, options);
      if (!isCurrent() || signal.aborted) return null;
      if (rejected.length > 0) setUploadError(rejectedMessage(rejected));
      return { attachments: uploaded, rejected: rejected.length > 0 };
    } catch (err) {
      if (isCurrent() && !attempt.abandoned) {
        keepUnsent(files);
        // A cancel is not a failure, so it reports nothing.
        const cancelled = signal.aborted || err instanceof UploadCancelledError;
        if (!cancelled) setUploadError(getErrorMessage(err, 'The upload failed. Please try again.'));
      }
      return null;
    } finally {
      if (isCurrent()) {
        uploadRef.current = null;
        setCancellable(false);
        setUploading(false);
      }
    }
  };

  const handleSend = async () => {
    const text = content.trim();
    const hasAttachments = pendingAttachments.length > 0 || unsentFiles.length > 0;
    if ((!text && !hasAttachments) || disabled || uploading) return;

    let attachments = pendingAttachments;
    if (unsentFiles.length > 0) {
      if (uploadTargetMissing()) return;
      const files = unsentFiles;
      setUnsentFiles([]);
      const uploaded = await uploadFromDevice(files);
      // Nothing is sent unless every waiting file uploaded; the draft and the
      // files stay for another try.
      if (!uploaded) return;
      if (uploaded.rejected) {
        // A file the server refused would silently drop out of the message, so
        // the ones it accepted wait as chips and the user decides.
        setPendingAttachments(prev => [...prev, ...uploaded.attachments]);
        return;
      }
      attachments = [...pendingAttachmentsRef.current, ...uploaded.attachments];
    }

    // Cleared at once, since the message already shows as a pending bubble,
    // and given back if the send fails, unless the composer has since moved to
    // another thread or the user has started a new draft.
    const sentFrom = currentThreadRef.current;
    const draft = { content, mentions };
    setContent('');
    setMentions([]);
    setPendingAttachments([]);
    setUploadError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = '';
    }

    const sent = await onSend(text, attachments, mentions);
    const sameThread = currentThreadRef.current.lawFirmId === sentFrom.lawFirmId
      && currentThreadRef.current.conversationId === sentFrom.conversationId;
    if (sent !== false || !sameThread) return;
    setContent(prev => (prev ? prev : draft.content));
    setMentions(prev => (prev.length > 0 ? prev : draft.mentions));
    setPendingAttachments(prev => [...attachments, ...prev].slice(0, MAX_ATTACHMENTS));
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Reset input so same file can be picked again
    if (fileInputRef.current) fileInputRef.current.value = '';

    // A file picked again replaces its not-uploaded copy rather than joining it.
    const stillUnsent = unsentFiles.filter(p => !files.some(f => sameFile(p, f)));

    // Validate count
    if (pendingAttachments.length + stillUnsent.length + files.length > MAX_ATTACHMENTS) {
      setUploadError(`Maximum ${MAX_ATTACHMENTS} attachments per message`);
      return;
    }

    // Validate size
    const oversized = files.find(f => f.size > 100 * 1024 * 1024);
    if (oversized) {
      setUploadError(`"${oversized.name}" exceeds the 100 MB limit`);
      return;
    }

    if (uploadTargetMissing()) return;

    setUnsentFiles(stillUnsent);
    const uploaded = await uploadFromDevice(files);
    if (uploaded) setPendingAttachments(prev => [...prev, ...uploaded.attachments]);
  };

  // Paperclip click: firm members choose device vs file manager; clients (no
  // file manager) go straight to the device picker.
  const handleAttachClick = () => {
    if (isClient) {
      fileInputRef.current?.click();
      return;
    }
    setSourceMenuOpen((o) => !o);
  };

  const openDevicePicker = () => {
    setSourceMenuOpen(false);
    fileInputRef.current?.click();
  };

  const openFileManager = () => {
    setSourceMenuOpen(false);
    if (!clientId && !conversationId) {
      setUploadError('This conversation is still loading. Please wait a moment and try again.');
      return;
    }
    setPickerOpen(true);
  };

  // Copy the chosen file-manager files into the conversation via the backend,
  // which re-verifies read access and returns ready-to-send attachments.
  const handleFilesFromManager = async (picked: PickedFile[]) => {
    if (picked.length === 0) return;
    if (pendingAttachments.length + unsentFiles.length + picked.length > MAX_ATTACHMENTS) {
      setUploadError(`Maximum ${MAX_ATTACHMENTS} attachments per message`);
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const attached = await messagesService.attachExistingFiles(
        lawFirmId,
        { clientId: clientId || undefined, conversationId: clientId ? undefined : conversationId },
        picked.map((p) => ({ fileId: p.fileId })),
      );
      setPendingAttachments(prev => [...prev, ...attached]);
    } catch (err) {
      setUploadError(getErrorMessage(err, 'Failed to attach the selected files. Please try again.'));
    } finally {
      setUploading(false);
    }
  };

  // An uploaded chip is already in storage and charged to the firm, so
  // removing it discards the object as well. Best effort: the chip goes at
  // once, and a failed discard is only logged.
  const removeAttachment = (index: number) => {
    const removed = pendingAttachments[index];
    setPendingAttachments(prev => prev.filter((_, i) => i !== index));
    if (!removed?.objectPath) return;
    const discarded = isClient
      ? clientPortalService.discardMessageAttachments(lawFirmId, [removed.objectPath], conversationId)
      : messagesService.discardAttachments(lawFirmId, { clientId, conversationId }, [removed.objectPath]);
    discarded.catch((err) => console.error('Failed to discard the removed attachment:', err));
  };

  const removeUnsentFile = (index: number) => {
    setUnsentFiles(prev => prev.filter((_, i) => i !== index));
  };

  const attachmentCount = pendingAttachments.length + unsentFiles.length;
  const canSend = !disabled && !uploading && (content.trim().length > 0 || attachmentCount > 0);

  return (
    <div className="flex flex-col gap-2">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.rtf,.odt,.ods,.odp,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.bmp,.tif,.tiff,.zip"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Attachment chips: uploaded first, then the files not uploaded yet */}
      {attachmentCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingAttachments.map((att, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-alt border border-outline-subtle rounded-full text-xs text-on-surface max-w-[200px]"
            >
              <Paperclip size={11} className="shrink-0 text-on-surface-muted" />
              <span className="truncate">{att.name}</span>
              <span className="text-on-surface-muted shrink-0">({formatBytes(att.size)})</span>
              <button
                onClick={() => removeAttachment(i)}
                className="shrink-0 text-on-surface-muted hover:text-on-surface transition-colors"
                aria-label={`Remove ${att.name}`}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {unsentFiles.map((file, i) => (
            <Tooltip key={`unsent-${i}`} title="Not uploaded yet. It uploads when you send." enterDelay={300}>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-alt border border-outline-subtle rounded-full text-xs text-on-surface-muted max-w-[200px]">
                <Clock size={11} className="shrink-0 text-on-surface-muted" />
                <span className="truncate">{file.name}</span>
                <span className="text-on-surface-muted shrink-0">({formatBytes(file.size)})</span>
                <span className="sr-only">Not uploaded yet</span>
                <button
                  onClick={() => removeUnsentFile(i)}
                  className="shrink-0 text-on-surface-muted hover:text-on-surface transition-colors"
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={11} />
                </button>
              </div>
            </Tooltip>
          ))}
        </div>
      )}

      {uploading && <UploadProgressBar onCancel={cancellable ? cancelUpload : undefined} />}

      {/* Upload error */}
      <FieldError message={uploadError} />

      {/* Input row */}
      <div className="flex gap-2 items-end">
        <div ref={attachWrapRef} className="relative shrink-0">
          <Tooltip title="Attach files" enterDelay={300}>
            <span>
              <button aria-label="Attach files"
                type="button"
                onClick={handleAttachClick}
                disabled={disabled || uploading || attachmentCount >= MAX_ATTACHMENTS}
                aria-haspopup={!isClient}
                aria-expanded={!isClient ? sourceMenuOpen : undefined}
                className="flex items-center justify-center w-[44px] h-[44px] rounded-lg border border-input-border bg-input-bg text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Paperclip size={15} />
              </button>
            </span>
          </Tooltip>

          {/* Attach-source menu (firm members only) */}
          {!isClient && menuMounted && (
            <div
              className={`absolute bottom-[calc(100%+8px)] left-0 z-20 w-56 rounded-xl border border-outline-subtle bg-surface shadow-xl p-1 ${menuAnim(menuExiting)}`}
            >
              <button
                type="button"
                onClick={openDevicePicker}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer text-left"
              >
                <span className="shrink-0 w-6 h-6 rounded-md bg-surface-alt flex items-center justify-center text-on-surface-secondary">
                  <Upload size={13} strokeWidth={2.2} />
                </span>
                Upload from device
              </button>
              <button
                type="button"
                onClick={openFileManager}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer text-left"
              >
                <span className="shrink-0 w-6 h-6 rounded-md bg-surface-alt flex items-center justify-center text-on-surface-secondary">
                  <FolderOpen size={13} strokeWidth={2.2} />
                </span>
                Choose from file manager
              </button>
            </div>
          )}
        </div>
        <MentionTextarea
          aria-label="Message"
          textareaRef={textareaRef}
          value={content}
          onChange={setContent}
          onMentionsChange={setMentions}
          members={members}
          onEnter={handleSend}
          placeholder={placeholder || "Type a message..."}
          disabled={disabled || uploading}
          rows={1}
          className="block w-full px-4 py-2 bg-input-bg text-on-surface border border-input-border rounded-lg resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 placeholder:text-on-surface-muted styled-scrollbar"
          style={{ minHeight: '44px', maxHeight: '120px' }}
        />
        <Button
          onClick={handleSend}
          type="primary"
          size="medium"
          disabled={!canSend}
          className="h-[44px] rounded-lg shrink-0 md:min-w-[96px]"
        >
          {uploading ? 'Uploading...' : disabled ? 'Sending...' : 'Send'}
        </Button>
      </div>

      {/* File-manager picker (firm members only) */}
      {!isClient && (
        <MessageFilePicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          lawFirmId={lawFirmId}
          maxSelectable={Math.max(0, MAX_ATTACHMENTS - attachmentCount)}
          onConfirm={handleFilesFromManager}
        />
      )}
    </div>
  );
}
