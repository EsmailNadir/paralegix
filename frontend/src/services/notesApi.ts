import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { ApiError } from '@/lib/utils/apiErrors';
import { authenticatedHeaders } from './base.service';
import { applyNotesPageParams } from '@/lib/utils/listQuery';
import type { Note, NotesPageParams, NotesPageResult, NoteVersion, NoteReply } from '@/types/note';
import filesService from '@/services/files.service';
import { track } from "@/lib/analytics/analytics";

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

async function authHeaders(extra: Record<string, string> = {}) {
  return authenticatedHeaders(extra);
}

export interface NoteAttachmentInput {
  id: string; name: string; size: number; type: string; file?: File; url?: string;
}
export interface NoteAttachment {
  id: string; name: string; size: number; type: string; url: string;
}
export interface TimeEntryInput {
  timeSpent: number;
  timeEntryDate?: string;
  activityName?: string;
  activityDescription?: string;
  isBillable?: boolean;
}

/**
 * The note-CRUD surface for one parent entity type (matter/task/client),
 * hitting `.../<parentUrlSegment>/:parentId/notes...`.
 *
 * Matter, task, and client notes are the same feature on the backend
 * (`backend/src/shared/notes/`); this is that same sharing on the frontend
 * side of the wire, so `matters.service.ts`/`tasks.service.ts`/
 * `clients.service.ts` each just instantiate this once rather than
 * reimplementing ~15 near-identical methods.
 */
export function createNotesApi(
  parentUrlSegment: 'matters' | 'tasks' | 'clients',
  parentIdField: 'matterId' | 'taskId' | 'clientId',
) {
  const base = (lawFirmId: string, parentId: string) =>
    `${API_ROOT}/lawfirms/${encodeURIComponent(lawFirmId)}/${parentUrlSegment}/${encodeURIComponent(parentId)}`;

  /**
   * Upload a note's attachments straight to storage.
   *
   * This used to POST them to the API as multipart, which held ten files at a
   * hundred megabytes each in the container before the handler ran. The files
   * service owns the three-step upload now, so there is one implementation of
   * it rather than one per attachment kind.
   */
  async function uploadNoteAttachments(lawFirmId: string, parentId: string, files: File[]): Promise<NoteAttachment[]> {
    const uploaded = await filesService.uploadNoteAttachments(
      lawFirmId, { [parentIdField]: parentId }, files,
    );
    return uploaded as unknown as NoteAttachment[];
  }

  /** Uploads any attachments carrying a raw `File`, and merges in already-uploaded ones (which carry a `url` instead). */
  async function resolveAttachments(
    lawFirmId: string, parentId: string, attachments?: NoteAttachmentInput[],
  ): Promise<NoteAttachment[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined;
    const filesToUpload = attachments.filter((a) => a.file).map((a) => a.file!);
    const uploaded = filesToUpload.length ? await uploadNoteAttachments(lawFirmId, parentId, filesToUpload) : [];
    const existing = attachments
      .filter((a) => a.url && !a.file)
      .map((a) => ({ id: a.id, name: a.name, size: a.size, type: a.type, url: a.url! }));
    const merged = [...uploaded, ...existing];
    return merged.length ? merged : undefined;
  }

  async function listNotes(lawFirmId: string, parentId: string, params: NotesPageParams = {}): Promise<NotesPageResult> {
    const url = new URL(`${base(lawFirmId, parentId)}/notes`);
    applyNotesPageParams(url, params);
    const response = await apiFetch(url.toString(), { headers: await authHeaders() });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to load notes');
    return {
      notes: Array.isArray(body.notes) ? body.notes : [],
      totalNotes: body.totalNotes ?? 0,
      counts: {
        all: body.counts?.all ?? 0,
        withTime: body.counts?.withTime ?? 0,
        withoutTime: body.counts?.withoutTime ?? 0,
      },
      tags: Array.isArray(body.tags) ? body.tags : [],
      resolvedPage: body.resolvedPage ?? null,
    };
  }

  async function getNoteDetail(lawFirmId: string, parentId: string, noteId: string): Promise<{ note: Note }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}`, { headers: await authHeaders() });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to load note');
    return body as { note: Note };
  }

  async function addNote(lawFirmId: string, parentId: string, noteData: {
    content: string;
    contentHtml: string;
    subject?: string;
    noteType?: string;
    /** The date the work happened. Defaults server-side to today. */
    noteDate?: string;
    mentions?: string[];
    attachments?: NoteAttachmentInput[];
    /** Save sends none; Save & Add Time sends one; the panel can send several. */
    timeEntries?: TimeEntryInput[];
  }): Promise<{ note: Note }> {
    const uploadedAttachments = await resolveAttachments(lawFirmId, parentId, noteData.attachments);
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        content: noteData.content,
        contentHtml: noteData.contentHtml,
        subject: noteData.subject,
        noteType: noteData.noteType || 'general',
        noteDate: noteData.noteDate,
        mentions: noteData.mentions,
        attachments: uploadedAttachments,
        timeEntries: noteData.timeEntries && noteData.timeEntries.length > 0 ? noteData.timeEntries : undefined,
      }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    track("note_created", {
      parent_type: parentUrlSegment,
      attachment_count: uploadedAttachments?.length ?? 0,
      time_entry_count: noteData.timeEntries?.length ?? 0,
    });
    return body as { note: Note };
  }

  async function updateNote(lawFirmId: string, parentId: string, noteId: string, noteData: {
    content: string;
    contentHtml: string;
    subject?: string;
    noteType?: string;
    noteDate?: string;
    attachments?: NoteAttachmentInput[];
  }): Promise<{ note: Note }> {
    const uploadedAttachments = await resolveAttachments(lawFirmId, parentId, noteData.attachments);
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        content: noteData.content,
        contentHtml: noteData.contentHtml,
        subject: noteData.subject,
        noteType: noteData.noteType,
        noteDate: noteData.noteDate,
        attachments: uploadedAttachments,
      }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { note: Note };
  }

  /** Retract a note. The note and its time entries are kept, not deleted. */
  async function retractNote(lawFirmId: string, parentId: string, noteId: string, reason?: string): Promise<{ message: string; note: Note }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ reason }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { message: string; note: Note };
  }

  async function addNoteTimeEntry(lawFirmId: string, parentId: string, noteId: string, entry: TimeEntryInput): Promise<{ note: Note }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/time`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(entry),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to add time');
    return body as { note: Note };
  }

  async function updateNoteTimeEntry(
    lawFirmId: string, parentId: string, noteId: string, timeEntryId: string, entry: TimeEntryInput,
  ): Promise<{ note: Note }> {
    const response = await apiFetch(
      `${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/time/${encodeURIComponent(timeEntryId)}`,
      {
        method: 'PUT',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(entry),
      },
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to update time');
    return body as { note: Note };
  }

  async function removeNoteTimeEntry(lawFirmId: string, parentId: string, noteId: string, timeEntryId: string): Promise<{ note: Note }> {
    const response = await apiFetch(
      `${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/time/${encodeURIComponent(timeEntryId)}`,
      { method: 'DELETE', headers: await authHeaders() },
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to remove time');
    return body as { note: Note };
  }

  async function setNotePinned(lawFirmId: string, parentId: string, noteId: string, pinned: boolean): Promise<{ note: Note }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/pin`, {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ pinned }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to update pin');
    return body as { note: Note };
  }

  async function listNoteVersions(lawFirmId: string, parentId: string, noteId: string): Promise<{ versions: NoteVersion[] }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/versions`, {
      headers: await authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to load version history');
    return body as { versions: NoteVersion[] };
  }

  async function listNoteReplies(lawFirmId: string, parentId: string, noteId: string): Promise<{ replies: NoteReply[] }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/replies`, {
      headers: await authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to load replies');
    return body as { replies: NoteReply[] };
  }

  async function addNoteReply(lawFirmId: string, parentId: string, noteId: string, reply: {
    content: string; contentHtml?: string; mentions?: string[]; attachments?: NoteAttachmentInput[];
    /** Null/undefined replies to the note itself; otherwise the reply being replied to. */
    parentReplyId?: string | null;
  }): Promise<{ reply: NoteReply }> {
    const uploadedAttachments = await resolveAttachments(lawFirmId, parentId, reply.attachments);
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/replies`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        content: reply.content, contentHtml: reply.contentHtml, mentions: reply.mentions, attachments: uploadedAttachments,
        parentReplyId: reply.parentReplyId ?? undefined,
      }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to add reply');
    return body as { reply: NoteReply };
  }

  async function updateNoteReply(lawFirmId: string, parentId: string, noteId: string, replyId: string, reply: {
    content: string; contentHtml?: string; attachments?: NoteAttachmentInput[];
  }): Promise<{ reply: NoteReply }> {
    const uploadedAttachments = await resolveAttachments(lawFirmId, parentId, reply.attachments);
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/replies/${encodeURIComponent(replyId)}`, {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content: reply.content, contentHtml: reply.contentHtml, attachments: uploadedAttachments }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to update reply');
    return body as { reply: NoteReply };
  }

  async function retractNoteReply(lawFirmId: string, parentId: string, noteId: string, replyId: string, reason?: string): Promise<{ message: string; reply: NoteReply }> {
    const response = await apiFetch(`${base(lawFirmId, parentId)}/notes/${encodeURIComponent(noteId)}/replies/${encodeURIComponent(replyId)}`, {
      method: 'DELETE',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ reason }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to retract reply');
    return body as { message: string; reply: NoteReply };
  }

  return {
    uploadNoteAttachments,
    listNotes,
    getNoteDetail,
    addNote,
    updateNote,
    retractNote,
    addNoteTimeEntry,
    updateNoteTimeEntry,
    removeNoteTimeEntry,
    setNotePinned,
    listNoteVersions,
    listNoteReplies,
    addNoteReply,
    updateNoteReply,
    retractNoteReply,
  };
}
