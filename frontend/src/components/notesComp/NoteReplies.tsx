"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Pencil, Reply, Undo2, X } from "lucide-react";
import dayjs from "dayjs";
import StatusBadge from "@/components/ui/StatusBadge";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import TiptapEditor from "./TiptapEditor";
import NoteTaskModal, { NoteTaskFormValue } from "./NoteTaskModal";
import RetractReasonModal from "./RetractReasonModal";
import useNoteReplies from "@/hooks/notesHooks/useNoteReplies";
import useNoteLinks from "@/hooks/notesHooks/useNoteLinks";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import { useAuth } from "@/hooks/useAuth";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { formatTimeAgo } from "@/components/notificationComp/notificationUtils";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { NoteReply } from "@/types/note";

interface NoteRepliesProps {
  lawFirmId: string;
  parentType: 'matter' | 'task' | 'client';
  parentId: string;
  noteId: string;
  noteSubject?: string;
  replyCount: number;
  canReply: boolean;
  /** Create task from a reply - matter-only (uses the matter-only note-links feature). */
  canCreateTask: boolean;
  /** Runs once a task has been created from one of this note's replies. */
  onTaskCreated?: () => void;
}

function absoluteTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function replyDraftKey(noteId: string): string {
  return `noteReplyDraft:${noteId}`;
}

/** Reply indentation increases per depth up to this many levels; deeper replies stay
 *  at the same indent as the cap and rely on a "Replying to" label instead. */
const MAX_REPLY_INDENT_DEPTH = 5;

type ReplyTreeNode = NoteReply & { children: ReplyTreeNode[] };

/**
 * Groups the flat reply list (already fetched in one shot) into a tree by
 * `parentReplyId` (null/undefined = top-level, replying to the note itself).
 * The API returns replies oldest-first and `Map` preserves insertion order,
 * so each parent's children come out in the same created-at order as the
 * source list without a separate sort.
 */
function buildReplyTree(replies: NoteReply[]): ReplyTreeNode[] {
  const byId = new Map<string, ReplyTreeNode>();
  replies.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: ReplyTreeNode[] = [];
  byId.forEach((node) => {
    const parent = node.parentReplyId ? byId.get(node.parentReplyId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
}

/** Total replies in a subtree, for the "N replies hidden" summary shown when collapsed. */
function countReplies(nodes: ReplyTreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countReplies(n.children), 0);
}

/** Reads a reply left unsent on a previous visit to this note, if any. */
function loadReplyDraft(noteId: string): { html: string; mentions: string[] } {
  if (typeof window === 'undefined') return { html: "", mentions: [] };
  try {
    const saved = sessionStorage.getItem(replyDraftKey(noteId));
    if (!saved) return { html: "", mentions: [] };
    const parsed = JSON.parse(saved) as { html?: string; mentions?: string[] };
    return { html: parsed.html || "", mentions: parsed.mentions || [] };
  } catch {
    return { html: "", mentions: [] };
  }
}

/**
 * The reply thread under a note.
 *
 * Collapsed by default, so a page of ten notes doesn't unfold ten
 * conversations at once. Viewing the thread and composing a reply are
 * separate actions: opening the thread to read past replies must not also
 * drop the reader into an editor they didn't ask for, so "N replies" only
 * toggles the read-only list, and "Reply" is what opens the composer.
 * Replies are always internal: the note is the work product a client update
 * is drawn from, and this thread is the discussion about it, which never
 * inherits a note's visibility.
 */
export default function NoteReplies({
  lawFirmId, parentType, parentId, noteId, noteSubject, replyCount, canReply, canCreateTask, onTaskCreated,
}: NoteRepliesProps) {
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  // Which reply the composer is currently targeting: id null = replying to the
  // note itself (top-level). Cleared back to top-level whenever the composer closes.
  const [replyTo, setReplyTo] = useState<{ id: string | null; name: string | null }>({ id: null, name: null });
  const [draftHtml, setDraftHtml] = useState(() => loadReplyDraft(noteId).html);
  const [draftMentions, setDraftMentions] = useState<string[]>(() => loadReplyDraft(noteId).mentions);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editHtml, setEditHtml] = useState("");
  const [taskFromReply, setTaskFromReply] = useState<NoteReply | null>(null);
  // Closing clears the reply, so render the last one while the task dialog plays
  // its exit animation instead of unmounting it on the spot.
  const taskFromReplyShown = useLastOpenValue(taskFromReply !== null, taskFromReply);
  const [replyToRetract, setReplyToRetract] = useState<NoteReply | null>(null);
  const [retractReplyReason, setRetractReplyReason] = useState("");
  // Reply ids whose sub-thread is folded up (Reddit-style), so a long thread
  // can be tidied per-branch without affecting anyone else's view of it.
  const [collapsedReplyIds, setCollapsedReplyIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { user } = useAuth();
  const firmMembers = useFirmMembers(lawFirmId);
  const thread = useNoteReplies(lawFirmId, parentType, parentId, noteId, expanded);
  // Matter-only feature; `canCreateTask` is only ever true for matter notes,
  // so this stays inert (never invoked) for task/client notes.
  const links = useNoteLinks(lawFirmId, parentId);

  const stripHtml = (html: string) => {
    const tmp = document.createElement('DIV');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  };

  const hasDraftContent = !!stripHtml(draftHtml).trim();

  // Keep the draft in storage as it's typed, so collapsing the thread or
  // reloading never throws away an unsent reply. sessionStorage (not
  // localStorage): this is internal attorney commentary, so it should not
  // outlive the browser tab on a shared machine.
  useEffect(() => {
    try {
      if (hasDraftContent) {
        sessionStorage.setItem(replyDraftKey(noteId), JSON.stringify({ html: draftHtml, mentions: draftMentions }));
      } else {
        sessionStorage.removeItem(replyDraftKey(noteId));
      }
    } catch {
      // Ignore unavailable storage (e.g. private browsing quota).
    }
  }, [noteId, draftHtml, draftMentions, hasDraftContent]);

  const handlePostReply = async () => {
    const plain = stripHtml(draftHtml);
    if (!plain.trim()) {
      setError("Reply cannot be empty");
      return;
    }
    setError(null);
    try {
      await thread.addReply.mutateAsync({ content: plain, contentHtml: draftHtml, mentions: draftMentions, parentReplyId: replyTo.id });
      setDraftHtml("");
      setDraftMentions([]);
      setComposing(false);
      setReplyTo({ id: null, name: null });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add reply"));
    }
  };

  const toggleThread = () => {
    setExpanded((v) => {
      const next = !v;
      if (!next) {
        setComposing(false);
        setReplyTo({ id: null, name: null });
      }
      return next;
    });
  };

  const openComposer = () => {
    setExpanded(true);
    setReplyTo({ id: null, name: null });
    setComposing(true);
  };

  /** "Reply" on any reply in the thread, targeting the composer at that reply, at any depth. */
  const handleReplyTo = (node: NoteReply) => {
    setExpanded(true);
    setReplyTo({ id: node.id, name: node.createdByName || 'Unknown' });
    setComposing(true);
  };

  const handleSaveEdit = async (replyId: string) => {
    const plain = stripHtml(editHtml);
    if (!plain.trim()) {
      setError("Reply cannot be empty");
      return;
    }
    setError(null);
    try {
      await thread.updateReply.mutateAsync({ replyId, reply: { content: plain, contentHtml: editHtml } });
      setEditingReplyId(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update reply"));
    }
  };

  const handleCreateTaskFromReply = async (value: NoteTaskFormValue) => {
    if (!taskFromReply) return;
    await links.createTask.mutateAsync({ noteId, task: { ...value, replyId: taskFromReply.id } });
    setTaskFromReply(null);
    onTaskCreated?.();
  };

  const handleRetractReplyClick = (reply: NoteReply) => {
    setRetractReplyReason("");
    setReplyToRetract(reply);
  };

  const confirmRetractReply = async () => {
    if (!replyToRetract) return;
    setError(null);
    try {
      await thread.retractReply.mutateAsync({ replyId: replyToRetract.id, reason: retractReplyReason.trim() || undefined });
      setReplyToRetract(null);
      setRetractReplyReason("");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to retract reply"));
    }
  };

  const toggleCollapse = (replyId: string) => {
    setCollapsedReplyIds((prev) => {
      const next = new Set(prev);
      if (next.has(replyId)) next.delete(replyId);
      else next.add(replyId);
      return next;
    });
  };

  // Built client-side from the flat list fetched in one shot; no extra request per level.
  const replyTree = useMemo(() => buildReplyTree(thread.replies), [thread.replies]);

  /** The composer, rendered wherever `replyTo` currently points: inline under the
   *  reply it targets, or at the bottom of the thread when targeting the note itself. */
  const renderComposer = () => (
    <div className="space-y-2">
      {replyTo.id && (
        <div className="flex items-center gap-1.5 text-xs text-on-surface-muted">
          Replying to <span className="font-medium text-on-surface">{replyTo.name}</span>
          <button
            type="button"
            onClick={() => setReplyTo({ id: null, name: null })}
            className="inline-flex items-center gap-0.5 hover:text-on-surface cursor-pointer"
          >
            <X size={11} /> Reply to note instead
          </button>
        </div>
      )}
      <TiptapEditor
        content={draftHtml}
        onChange={setDraftHtml}
        placeholder="Reply... use @ to mention a colleague"
        mentionMembers={firmMembers}
        onMentionsChange={setDraftMentions}
      />
      <div className="flex gap-2">
        <Button type="primary" size="small" onClick={handlePostReply} loading={thread.addReply.isPending}>
          Post Reply
        </Button>
        <Button
          type="secondary"
          size="small"
          onClick={() => {
            setComposing(false);
            setReplyTo({ id: null, name: null });
            if (thread.replies.length === 0) setExpanded(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  /** Renders one reply and, recursively, its children: indenting up to the cap, then
   *  falling back to a "Replying to" label so deep threads stay legible. */
  const renderReplyNode = (node: ReplyTreeNode, depth: number, parentName?: string): React.ReactNode => {
    const isAuthor = !!user?.uid && node.createdBy === user.uid;
    const isEditing = editingReplyId === node.id;
    const overCap = depth > MAX_REPLY_INDENT_DEPTH;
    const isCollapsed = collapsedReplyIds.has(node.id);

    return (
      <div key={node.id} className="text-sm">
        {overCap && parentName && (
          <div className="mb-1 text-xs text-on-surface-muted italic">Replying to {parentName}</div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-on-surface-secondary">
          <span className="font-medium text-on-surface">{node.createdByName || 'Unknown'}</span>
          <span aria-hidden>·</span>
          <Tooltip title={absoluteTimestamp(node.createdAt)} enterDelay={300}>
            <span>{formatTimeAgo(node.createdAt)}</span>
          </Tooltip>
          {node.editedAt && !node.retractedAt && <span className="text-on-surface-muted">(edited)</span>}
          {node.retractedAt && <StatusBadge variant="danger">Retracted</StatusBadge>}
          {node.children.length > 0 && (
            <button
              type="button"
              onClick={() => toggleCollapse(node.id)}
              aria-label={isCollapsed ? "Expand replies" : "Collapse replies"}
              title={isCollapsed ? "Expand replies" : "Collapse replies"}
              className="ml-auto inline-flex items-center text-on-surface-muted hover:text-on-surface cursor-pointer"
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>

        {node.retractedAt && (
          <div className="mt-1 text-xs text-on-surface-muted">
            Retracted {dayjs(node.retractedAt).format('MMM D, YYYY')}
            {node.retractionReason && <>: {node.retractionReason}</>}
          </div>
        )}

        {isEditing ? (
          <div className="mt-1 space-y-2">
            <TiptapEditor content={editHtml} onChange={setEditHtml} placeholder="Edit your reply..." />
            <div className="flex gap-2">
              <Button type="primary" size="small" onClick={() => handleSaveEdit(node.id)} loading={thread.updateReply.isPending}>
                Save
              </Button>
              <Button type="secondary" size="small" onClick={() => setEditingReplyId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`mt-1.5 prose prose-sm max-w-none ${node.retractedAt ? 'text-on-surface-muted line-through opacity-70' : ''}`}
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(node.contentHtml || node.content) }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-on-surface-muted">
              {canReply && (
                <button
                  type="button"
                  onClick={() => handleReplyTo(node)}
                  className="inline-flex items-center gap-1 hover:text-on-surface cursor-pointer"
                >
                  <Reply size={11} /> Reply
                </button>
              )}
              {isAuthor && !node.retractedAt && (
                <>
                  <Tooltip
                    title={node.editedAt ? `Last edited ${absoluteTimestamp(node.editedAt)}` : ''}
                    enterDelay={300}
                  >
                    <button
                      type="button"
                      onClick={() => { setEditingReplyId(node.id); setEditHtml(node.contentHtml || node.content); }}
                      className="inline-flex items-center gap-1 hover:text-on-surface cursor-pointer"
                    >
                      <Pencil size={11} /> Edit
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={() => handleRetractReplyClick(node)}
                    className="inline-flex items-center gap-1 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                  >
                    <Undo2 size={11} /> Retract
                  </button>
                </>
              )}
              {canCreateTask && !node.retractedAt && (
                <button
                  type="button"
                  onClick={() => setTaskFromReply(node)}
                  className="hover:text-on-surface cursor-pointer"
                >
                  Create task
                </button>
              )}
            </div>
          </>
        )}

        {canReply && composing && replyTo.id === node.id && (
          <div className="mt-3">{renderComposer()}</div>
        )}

        {node.children.length > 0 && (
          isCollapsed ? (
            <button
              type="button"
              onClick={() => toggleCollapse(node.id)}
              className="mt-2 flex items-center gap-1.5 text-xs text-on-surface-muted hover:text-on-surface cursor-pointer"
            >
              <ChevronRight size={12} />
              {countReplies(node.children)} {countReplies(node.children) === 1 ? "reply" : "replies"} hidden
            </button>
          ) : depth < MAX_REPLY_INDENT_DEPTH ? (
            <div className="mt-4 flex items-stretch gap-3">
              <button
                type="button"
                onClick={() => toggleCollapse(node.id)}
                aria-label="Collapse replies"
                title="Collapse replies"
                className="group w-3 shrink-0 flex justify-center cursor-pointer"
              >
                <span className="w-0.5 rounded-full bg-outline-subtle group-hover:bg-on-surface-muted transition-colors" />
              </button>
              <div className="min-w-0 flex-1 space-y-4">
                {node.children.map((child) => renderReplyNode(child, depth + 1, node.createdByName || 'Unknown'))}
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-4">
              {node.children.map((child) => renderReplyNode(child, depth + 1, node.createdByName || 'Unknown'))}
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        {replyCount > 0 && (
          <button
            type="button"
            onClick={toggleThread}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-emphasis dark:text-accent-emphasis bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft rounded-md px-2 py-1 hover:bg-accent-soft dark:hover:bg-accent-soft transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <MessageSquare size={13} />
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            <ChevronDown
              size={13}
              className="transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
        )}
        {canReply && !composing && (
          <button
            type="button"
            onClick={openComposer}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary border border-outline rounded-md px-2 py-1 hover:border-input-border hover:text-on-surface transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Reply size={13} />
            Reply
          </button>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="mt-4 pl-4 border-l-2 border-outline-subtle space-y-4">
            {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}

            {canReply && composing && replyTo.id === null && renderComposer()}

            {thread.loading ? (
              <div className="text-xs text-on-surface-muted">Loading replies…</div>
            ) : (
              replyTree.map((node) => renderReplyNode(node, 0))
            )}
          </div>
        </div>
      </div>

      {canCreateTask && taskFromReplyShown && (
        <NoteTaskModal
          lawFirmId={lawFirmId}
          isOpen={taskFromReply !== null}
          onClose={() => setTaskFromReply(null)}
          onSubmit={handleCreateTaskFromReply}
          submitting={links.createTask.isPending}
          defaultTitle={noteSubject}
          defaultDescription={taskFromReplyShown.content.slice(0, 100)}
        />
      )}

      <RetractReasonModal
        isOpen={replyToRetract !== null}
        onClose={() => setReplyToRetract(null)}
        onConfirm={confirmRetractReply}
        title="Retract reply"
        message="Retracting keeps the reply and its history on the record. Only its author can retract it."
        reason={retractReplyReason}
        onReasonChange={setRetractReplyReason}
        placeholder="Why is this reply being retracted?"
        loading={thread.retractReply.isPending}
      />
    </div>
  );
}
