"use client";

import { useState, useRef, useEffect, useId } from 'react';
import ErrorNotification from '@/components/ErrorNotification';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { Paperclip, Check, CheckCheck, Clock, AlertCircle, Pencil, Trash2 } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import LinkifiedText from '@/components/ui/LinkifiedText';
import { Avatar } from '@/components/ui/Avatar';
import RowActionMenu from '@/components/ui/RowActionMenu';
import ConfirmModal from '@/components/ui/ConfirmModal';
import type { Message, MessageAttachment } from '@/types';
import { isBrowserRenderableImage } from '@/lib/files/imageTypes';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function isRenderableImage(attachment: MessageAttachment): boolean {
  return isBrowserRenderableImage(attachment.mimeType, attachment.name);
}

function AttachmentPreview({ attachment, isOwn, onLoad, onOpen }: { attachment: MessageAttachment; isOwn: boolean; onLoad?: () => void; onOpen?: (attachment: MessageAttachment) => void }) {
  if (isRenderableImage(attachment)) {
    return (
      <button type="button" onClick={() => onOpen?.(attachment)} className="block mt-2 cursor-pointer">
        {/* eslint-disable-next-line @next/next/no-img-element -- attachment.url is a short-lived signed GCS URL, re-signed per read, so next/image's optimizer cannot serve it */}
        <img
          src={attachment.url}
          alt={attachment.name}
          loading="lazy"
          // Notify the thread so it can re-assert its scroll position once the
          // image has expanded to its real height (avoids opening mid-picture).
          onLoad={onLoad}
          className="max-w-[200px] rounded-lg hover:opacity-90 transition-opacity"
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen?.(attachment)}
      className={`mt-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-left ${
        isOwn
          ? 'bg-white/20 hover:bg-white/30 text-white'
          : 'bg-black/10 hover:bg-black/15 text-on-surface'
      }`}
    >
      <Paperclip size={13} className="shrink-0" />
      <span className="truncate max-w-[150px]">{attachment.name}</span>
      <span className={`shrink-0 ${isOwn ? 'text-blue-100' : 'text-on-surface-muted'}`}>
        {formatBytes(attachment.size)}
      </span>
    </button>
  );
}

/**
 * Renders message text with clickable links (markdown `[text](url)` and bare
 * URLs), in the bubble's own link colour.
 */
function RichMessageContent({ content, isOwn }: { content: string; isOwn: boolean }) {
  const linkClass = isOwn
    ? 'underline underline-offset-2 text-accent-foreground hover:text-accent-foreground/80'
    : 'underline underline-offset-2 text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover';
  return <LinkifiedText text={content} linkClassName={linkClass} />;
}

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showSenderName?: boolean;
  // Renders the sender's avatar (received messages only). Shown once per grouped
  // run, on the LAST bubble, so the avatar sits at the bottom of the group.
  showAvatar?: boolean;
  showTimestamp?: boolean;
  // Fired when an inline image attachment finishes loading, so the thread can
  // correct its scroll position for the late height change.
  onAttachmentLoad?: () => void;
  // Opens an attachment in the in-app preview modal (images, PDFs, docs, …)
  // instead of a new browser tab.
  onOpenAttachment?: (attachment: MessageAttachment) => void;
  // Edit/delete the caller's OWN message. Provided only when the viewer may manage
  // their messages; each rejects (throws) on failure so the bubble can stay in its
  // editing state. Absent for received messages and for the client's read-only views.
  onEdit?: (messageId: string, content: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
}

export default function MessageBubble({
  message,
  isOwn,
  showSenderName = false,
  showAvatar = false,
  showTimestamp = true,
  onAttachmentLoad,
  onOpenAttachment,
  onEdit,
  onDelete,
}: MessageBubbleProps) {
  const isDeleted = message.deleted === true;
  const isEdited = !isDeleted && message.editedAt != null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState({ message: '' });
  const errorRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!actionError.message || saving || deleting) return;
    if (editing) editRef.current?.focus();
    else errorRef.current?.focus();
  }, [actionError, editing, saving, deleting]);

  // Managing the message is offered only for the viewer's own, still-live,
  // successfully-sent messages. Editing needs text content (attachment-only
  // messages can be deleted but there is nothing to edit); delete needs the real
  // server id (optimistic sends carry a temp id and aren't yet on the server).
  const isRealMessage = !message.messageId.startsWith('temp-') && message.status !== 'sending' && message.status !== 'failed';
  // Editing and deleting are only allowed within 30 minutes of sending (matches
  // the backend limit); the backend rejects anything later, so hide the actions
  // once the window lapses.
  const MODIFY_WINDOW_MS = 30 * 60 * 1000;
  const withinModifyWindow = message.createdAt
    ? Date.now() - new Date(message.createdAt).getTime() <= MODIFY_WINDOW_MS
    : true;
  const canEdit = isOwn && !isDeleted && isRealMessage && !!onEdit && !!message.content.trim() && withinModifyWindow;
  const canDelete = isOwn && !isDeleted && isRealMessage && !!onDelete && withinModifyWindow;
  const showActions = (canEdit || canDelete) && !editing;

  useEffect(() => {
    if (editing && editRef.current) {
      const el = editRef.current;
      el.focus();
      // Place the caret at the end of the existing text.
      el.setSelectionRange(el.value.length, el.value.length);
      // The editor is taller than the bubble it replaces, so on the last message
      // its Cancel/Save row would otherwise be clipped at the bottom of the
      // scrolling thread (flush against the compose bar). Bring the whole editor
      // into view so it sits fully above the input area.
      requestAnimationFrame(() => {
        editContainerRef.current?.scrollIntoView({ block: 'nearest' });
      });
    }
  }, [editing]);

  const startEdit = () => {
    setActionError({ message: '' });
    setDraft(message.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setActionError({ message: '' });
    setEditing(false);
    setDraft(message.content);
  };

  const saveEdit = async () => {
    if (!onEdit) return;
    const next = draft.trim();
    if (!next) return; // an edit can't blank a text message (delete it instead)
    if (next === message.content.trim()) { setEditing(false); return; }
    try {
      setSaving(true);
      setActionError({ message: '' });
      await onEdit(message.messageId, next);
      setEditing(false);
    } catch (err) {
      setActionError({ message: getErrorMessage(err, 'Failed to edit message') });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    try {
      setDeleting(true);
      setActionError({ message: '' });
      await onDelete(message.messageId);
      setConfirmingDelete(false);
    } catch (err) {
      setActionError({ message: getErrorMessage(err, 'Failed to delete message') });
    } finally {
      setDeleting(false);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  const formatTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const timestampLabel = formatTime(message.createdAt);

  // Delivery/read receipt for the sender's own messages (direct threads).
  // WhatsApp-style: a single check once the message is stored, upgrading to a
  // double check when the OTHER party has read it. "Seen" keys off the recipient's
  // read cursor - a firm send is seen once the client reads it (readByClient), a
  // client send once the firm does (readByFirm) - not the viewer-centric `read`
  // flag, which is always true for one's own sends. Group threads have no single
  // recipient, so they stay at the "Sent" check.
  const seenByRecipient =
    message.senderType === 'firm_member'
      ? message.readByClient === true
      : message.readByFirm === true;

  const getReceipt = (): { node: React.ReactNode; label: string } | null => {
    if (message.status === 'sending') {
      return { node: <Clock size={13} className="text-white/70" />, label: 'Sending…' };
    }
    if (message.status === 'failed') {
      return { node: <AlertCircle size={14} className="text-red-200" />, label: 'Not sent' };
    }
    if (seenByRecipient) {
      const at = message.readAt ? formatTime(message.readAt) : null;
      return {
        node: <CheckCheck size={15} className="text-sky-300" />,
        label: at ? `Read at ${at}` : 'Read',
      };
    }
    return {
      node: <Check size={14} className="text-white/60" />,
      label: timestampLabel ? `Sent at ${timestampLabel}` : 'Sent',
    };
  };

  const receipt = getReceipt();

  // Deleted messages render as a muted tombstone in place of the bubble. The row
  // is retained (a legal record) and still occupies its slot in the thread. For
  // received messages the sender's avatar + name are kept (shown once per grouped
  // run: avatar on the last bubble, name on the first) so it stays clear whose
  // message was removed. Own deleted messages stay right-aligned with no avatar,
  // matching the viewer's own live messages.
  if (isDeleted) {
    return (
      <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
        {!isOwn && (
          <div className="mr-2 shrink-0 self-end">
            {showAvatar ? (
              <Avatar
                size="sm"
                photoUrl={message.senderPhotoUrl}
                name={message.senderName}
                fit={message.sentAsFirm ? 'contain' : 'cover'}
              />
            ) : (
              <div className="h-8 w-8" aria-hidden="true" />
            )}
          </div>
        )}
        <div className={`min-w-0 flex flex-col ${isOwn ? 'items-end max-w-[75%]' : 'items-start flex-1'}`}>
          {!isOwn && showSenderName && (
            <div className="max-w-full text-xs font-medium text-on-surface-secondary mb-1 px-1 break-words leading-snug">
              {message.senderName}
            </div>
          )}
          <div className="px-4 py-2.5 rounded-2xl border border-dashed border-outline-subtle bg-surface-alt">
            <span className="flex items-center gap-1.5 text-xs italic text-on-surface-muted">
              <Trash2 size={13} className="shrink-0" />
              This message was deleted
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex items-center gap-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      {/* Own-message action menu (edit / delete). Sits to the LEFT of the bubble
          and appears on hover (or while its menu is open). Hidden while editing. */}
      {isOwn && showActions && (
        <div className="self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
          <RowActionMenu
            ariaLabel="Message actions"
            actions={[
              ...(canEdit ? [{ label: 'Edit', icon: <Pencil size={15} />, onClick: startEdit }] : []),
              ...(canDelete ? [{ label: 'Delete', icon: <Trash2 size={15} />, onClick: () => { setActionError({ message: '' }); setConfirmingDelete(true); }, danger: true }] : []),
            ]}
          />
        </div>
      )}

      {/* Sender avatar for received messages, shown once per grouped run on the
          last bubble (self-end pins it to the bottom of the group); a spacer
          keeps the other bubbles aligned under it. */}
      {!isOwn && (
        <div className="mr-2 shrink-0 self-end">
          {showAvatar ? (
            // A "sent as firm" message shows the firm logo as its avatar; logos are
            // usually wide wordmarks, so contain-fit them (never crop in half).
            <Avatar
              size="sm"
              photoUrl={message.senderPhotoUrl}
              name={message.senderName}
              fit={message.sentAsFirm ? 'contain' : 'cover'}
            />
          ) : (
            <div className="h-8 w-8" aria-hidden="true" />
          )}
        </div>
      )}
      {/* Received column takes the full remaining row width so a long sender name
          (e.g. a firm name shown for a "send as firm" message) can lay out on one
          line and wrap cleanly only when truly long; the bubble itself keeps a
          sensible cap so it doesn't stretch edge-to-edge. Own messages stay capped. */}
      <div className={`min-w-0 flex flex-col ${isOwn ? 'items-end max-w-[75%]' : 'items-start flex-1'}`}>
        {!isOwn && showSenderName && (
          <div className="max-w-full text-xs font-medium text-on-surface-secondary mb-1 px-1 break-words leading-snug">
            {message.senderName}
          </div>
        )}

        {editing ? (
          // Inline editor: replaces the bubble while the sender revises the text.
          // Enter saves, Shift+Enter inserts a newline, Escape cancels.
          <div ref={editContainerRef} className={`relative z-10 w-full max-w-[420px] rounded-2xl border border-outline bg-surface p-2 shadow-lg ${isOwn ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
            <textarea
              ref={editRef}
              aria-label="Edit message"
              aria-describedby={actionError.message ? errorId : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleEditKeyDown}
              rows={Math.min(6, Math.max(2, draft.split('\n').length))}
              className="w-full resize-none rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            {actionError.message && <div id={errorId}><ErrorNotification error={actionError.message} onClose={() => { setActionError({ message: '' }); editRef.current?.focus(); }} /></div>}
            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface border border-outline-subtle text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving || !draft.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-on-surface-muted text-right">Enter to save, Shift + Enter for new line.</p>
          </div>
        ) : (
        <div
          className={`px-4 py-2.5 ${
            isOwn
              ? 'bg-accent-solid text-accent-foreground rounded-2xl rounded-br-sm'
              : 'max-w-[85%] bg-message-bubble-received text-on-surface rounded-2xl rounded-bl-sm border border-outline-subtle'
          }`}
        >
          {message.content && (
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed">
              <RichMessageContent content={message.content} isOwn={isOwn} />
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-col">
              {message.attachments.map((att, i) => (
                <AttachmentPreview key={i} attachment={att} isOwn={isOwn} onLoad={onAttachmentLoad} onOpen={onOpenAttachment} />
              ))}
            </div>
          )}
          {/* Grouped (non-last) bubbles hide the timestamp row; still mark an edit. */}
          {isEdited && !showTimestamp && (
            <div className={`mt-1 text-[10px] italic ${isOwn ? 'text-blue-200' : 'text-on-surface-muted'} ${isOwn ? 'text-right' : 'text-left'}`}>
              edited
            </div>
          )}
          {showTimestamp && (
            <div className={`flex items-center gap-1.5 mt-1.5 ${isOwn ? 'justify-end' : 'justify-start'}`}>
              {isEdited && (
                <span className={`text-[10px] italic ${isOwn ? 'text-blue-200' : 'text-on-surface-muted'}`}>
                  edited
                </span>
              )}
              {timestampLabel && (
                <span className={`text-[10px] ${isOwn ? 'text-blue-200' : 'text-on-surface-muted'}`}>
                  {timestampLabel}
                </span>
              )}
              {isOwn && receipt && (
                <Tooltip title={receipt.label} enterDelay={300} placement="top">
                  <span className="inline-flex items-center leading-none cursor-default">
                    {receipt.node}
                  </span>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {onDelete && (
        <ConfirmModal
          isOpen={confirmingDelete}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={confirmDelete}
          title="Delete message"
          message="This message will be removed from the conversation. This cannot be undone."
          confirmText="Delete"
          confirmType="danger"
          loading={deleting}
          extra={actionError.message && <div ref={errorRef} tabIndex={-1}><ErrorNotification error={actionError.message} onClose={() => {
            const buttons = errorRef.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
            setActionError({ message: '' });
            buttons?.[buttons.length - 1]?.focus();
          }} /></div>}
        />
      )}
    </div>
  );
}
