"use client";

import { useId, useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import dayjs from "dayjs";
import { FileText, ChevronDown, Plus, Pencil, Trash2 } from "lucide-react";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from "@/components/ui/ListPager";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import useEntityNotesPage from "@/hooks/useEntityNotesPage";
import type { NoteTimeFilter, NoteTimeEntry, NoteTimeSummary, NoteLink } from "@/types/note";
import { useResetAfterClose, useLastOpenValue } from "@/hooks/useMountTransition";
import TiptapEditor from "./TiptapEditor";
import NoteAttachments, { Attachment } from "./NoteAttachments";
import NoteTimePanel from "./NoteTimePanel";
import NoteTimeEntryModal, { NoteTimeEntryFormValue } from "./NoteTimeEntryModal";
import NoteActionsMenu from "./NoteActionsMenu";
import NoteLinksRow from "./NoteLinksRow";
import NoteReplies from "./NoteReplies";
import RetractReasonModal from "./RetractReasonModal";
import NoteVersionHistoryModal from "./NoteVersionHistoryModal";
import NotePrintPreviewModal from "./NotePrintPreviewModal";
import useNoteLinks from "@/hooks/notesHooks/useNoteLinks";
import useNoteTypes from "@/hooks/notesHooks/useNoteTypes";
import useNoteTemplates from "@/hooks/notesHooks/useNoteTemplates";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import StatusBadge from "@/components/ui/StatusBadge";
import TagChip from "@/components/ui/TagChip";
import { NOTE_TYPE_ORDER, STATUS_VARIANTS, resolveNoteTypeMeta } from "@/constants/statusMeta";
import { NOTE_TEMPLATES, getTemplate } from "@/config/noteTemplates";
import QuickAddDropdown from "./QuickAddDropdown";
import FilesService from "@/services/files.service";
import { uploadJobKey } from "@/contexts/FileUploadContext";
import { useUploadJob } from "@/hooks/fileHooks/useUploadJob";
import { UploadFailures, UploadInProgress } from "@/components/filesComp/UploadStatus";
import NoteTypeColorPicker from "./NoteTypeColorPicker";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import FieldLabel from "@/components/ui/FieldLabel";

/** The time tabs, in the order they are drawn. */
const TIME_FILTER_TABS: { value: NoteTimeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'with-time', label: 'With Time' },
  { value: 'without-time', label: 'Missing time' },
];

/** Which server-supplied count each tab shows. */
const TIME_FILTER_COUNT_KEYS: Record<NoteTimeFilter, 'all' | 'withTime' | 'withoutTime'> = {
  'all': 'all',
  'with-time': 'withTime',
  'without-time': 'withoutTime',
};

interface NotesSectionProps {
  lawFirmId: string;
  parentType: 'matter' | 'task' | 'client';
  parentId: string;
  onAddNote?: (noteData: {
    content: string;
    contentHtml: string;
    subject?: string;
    noteType?: string;
    /** The date the work happened. Defaults server-side to today. */
    noteDate?: string;
    mentions?: string[];
    attachments?: Attachment[];
    /** Set only by "Save & Add Time"; Save sends none. */
    timeEntries?: NoteTimeEntryFormValue[];
  }) => Promise<{ note?: { id: string } } | void>;
  onUpdateNote?: (noteId: string, noteData: {
    content: string;
    contentHtml: string;
    subject?: string;
    noteType?: string;
    noteDate?: string;
    attachments?: Attachment[];
  }) => Promise<void>;
  /** Retracted, never deleted - the note and its history stay on the record. */
  onDeleteNote?: (noteId: string, reason?: string) => Promise<void>;
  onAddTimeEntry?: (noteId: string, entry: NoteTimeEntryFormValue) => Promise<void>;
  onUpdateTimeEntry?: (noteId: string, timeEntryId: string, entry: NoteTimeEntryFormValue) => Promise<void>;
  onRemoveTimeEntry?: (noteId: string, timeEntryId: string) => Promise<void>;
  onSetPinned?: (noteId: string, pinned: boolean) => Promise<void>;
  /**
   * Linked-company id -> name, for the "why is this here" badge on a note
   * pulled in from a company the viewed client is linked to. Only meaningful
   * for `parentType === 'client'` (a matter/task note's `parentId` is its
   * matter/task, not a client, so it is never checked against this map);
   * matter and task callers can leave it unset.
   */
  companyNames?: Map<string, string>;
  /**
   * Called after a task is created from a note or from one of its replies.
   * A page that keeps its own list of the parent's tasks uses it to reload
   * that list, since the panel only invalidates the shared query cache.
   */
  onTaskCreated?: () => void;
}

interface NoteEntry {
  id: string;
  date: string;
  content: string;
  contentHtml?: string;
  tags: string[];
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt?: string;
  editedBy?: string;
  editedByName?: string;
  editedAt?: string;
  subject?: string;
  noteType?: string;
  attachments?: Attachment[];
  time?: NoteTimeSummary;
  links?: NoteLink[];
  pinnedAt?: string | null;
  replyCount?: number;
  retractedAt?: string | null;
  retractionReason?: string | null;
  parentId: string;
}

export default function NotesSection({
  lawFirmId,
  parentType,
  parentId,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onAddTimeEntry,
  onUpdateTimeEntry,
  onRemoveTimeEntry,
  onSetPinned,
  companyNames,
  onTaskCreated,
}: NotesSectionProps) {
  const fieldIds = useId();

  // Links (create/link task, link document), client updates, and print
  // stay matter-only - matter-specific infrastructure (matter_note_links,
  // client updates, and the print view) that tasks/clients
  // don't have. Everything else (rich content, time entries, pinning,
  // retraction, versioning, replies) is the same feature across all three.
  const isMatter = parentType === 'matter';
  // A note deep link (?note=<id>, e.g. from Copy Link or the activity feed).
  // Passed into the notes page as a jump target so the server can resolve
  // which page actually holds it, rather than only scrolling to it when it
  // happens to already be on the page in front of the reader.
  const searchParams = useSearchParams();
  const deepLinkNoteId = searchParams.get('note');

  // One server page of notes, plus the filter state that selects it. The notes
  // are NOT passed in: an entity accumulates notes for its whole life, so the
  // panel reads its own window rather than being handed the full history by the
  // page around it.
  const notesPage = useEntityNotesPage(
    lawFirmId, parentType, parentId, true, deepLinkNoteId || undefined,
  );
  const notes = notesPage.notes;
  // Links (create/link task, link document) only exist for matter notes; the
  // hook is still safe to call for task notes, it just goes unused there.
  const noteLinks = useNoteLinks(lawFirmId, parentId);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newNoteContentHtml, setNewNoteContentHtml] = useState("");
  const [newNoteMentions, setNewNoteMentions] = useState<string[]>([]);
  const [newNoteType, setNewNoteType] = useState("general");
  const firmMembers = useFirmMembers(lawFirmId);
  const { noteTypes: customNoteTypes, noteTypeColors, createNoteType, updateNoteTypeColor } = useNoteTypes(lawFirmId);
  const { noteTemplates: customNoteTemplates, createNoteTemplate } = useNoteTemplates(lawFirmId);
  const scrolledToDeepLinkRef = useRef(false);
  const [newNoteAttachments, setNewNoteAttachments] = useState<Attachment[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("blank");

  // Subject field for new notes
  const [newNoteSubject, setNewNoteSubject] = useState("");
  // The date the work happened, separate from when the note was saved. Defaults
  // to today; a note written up after the fact can still file under the day it
  // describes.
  const [newNoteDate, setNewNoteDate] = useState(() => dayjs().format('YYYY-MM-DD'));

  // Subject field for editing notes
  const [editNoteSubject, setEditNoteSubject] = useState("");
  const [editNoteContentHtml, setEditNoteContentHtml] = useState("");
  const [editNoteType, setEditNoteType] = useState("general");
  const [editNoteAttachments, setEditNoteAttachments] = useState<Attachment[]>([]);
  const [editNoteDate, setEditNoteDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [versionHistoryNoteId, setVersionHistoryNoteId] = useState<string | null>(null);
  const [printPreviewNoteId, setPrintPreviewNoteId] = useState<string | null>(null);
  const [retractReason, setRetractReason] = useState("");

  // The compose form's "Save" split button: primary Save, or a chevron menu
  // with "Save & Add Time" that opens the time modal against the note just
  // created.
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [saveMenuPos, setSaveMenuPos] = useState<{ anchorTop: number; anchorBottom: number; right: number } | null>(null);

  // One modal serves both adding and editing a time entry, targeted at
  // whichever note (and, for edits, which entry) it was opened against.
  const [timeModalNoteId, setTimeModalNoteId] = useState<string | null>(null);
  const [timeModalEntry, setTimeModalEntry] = useState<NoteTimeEntry | null>(null);
  const [timeModalSubmitting, setTimeModalSubmitting] = useState(false);
  const timeModalOpen = timeModalNoteId !== null;

  // Delete/retract confirmation state
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const [deletingNote, setDeletingNote] = useState(false);
  // Remove-time-entry confirmation: needs both ids, since a note can carry
  // more than one entry now.
  const [timeEntryToRemove, setTimeEntryToRemove] = useState<{ noteId: string; timeEntryId: string } | null>(null);
  const [removingTimeEntry, setRemovingTimeEntry] = useState(false);

  const canAddNotes = !!onAddNote;
  const canEditNotes = !!onUpdateNote;
  const canDeleteNotes = !!onDeleteNote;
  // Not matter-gated: whether time entries are available depends only on
  // whether the parent page found a billing context to hand handlers for
  // (e.g. a task with neither a matter nor a linked client gets none).
  const canAddTimeEntries = !!onAddTimeEntry;
  const canEditTimeEntries = !!onUpdateTimeEntry;
  const canRemoveTimeEntries = !!onRemoveTimeEntry;

  // Convert existing notes to new format
  const noteEntries: NoteEntry[] = useMemo(() => {
    return notes.map(note => {
      const date = dayjs(note.noteDate || note.createdAt).format('YYYY-MM-DD');

      // Extract tags from content (look for #tag patterns)
      const tagMatches = note.content.match(/#\w+/g) || [];
      const tags = tagMatches.map(tag => tag.substring(1));

      return {
        id: note.id,
        date,
        content: note.content,
        contentHtml: note.contentHtml,
        tags,
        createdBy: note.createdBy,
        createdByName: note.createdByName,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        editedBy: note.editedBy,
        editedByName: note.editedByName,
        editedAt: note.editedAt,
        subject: note.subject,
        noteType: note.noteType || 'general',
        attachments: note.attachments,
        time: note.time,
        links: note.links,
        pinnedAt: note.pinnedAt,
        replyCount: note.replyCount,
        retractedAt: note.retractedAt,
        retractionReason: note.retractionReason,
        parentId: note.parentId,
      };
    });
  }, [notes]);

  useEffect(() => {
    if (!deepLinkNoteId || scrolledToDeepLinkRef.current) return;
    const match = noteEntries.some((n) => n.id === deepLinkNoteId);
    if (!match) return;
    const el = document.getElementById(`note-${deepLinkNoteId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      scrolledToDeepLinkRef.current = true;
    }
  }, [deepLinkNoteId, noteEntries]);

  // Sourced from the server, so the dropdown offers every tag the entity has ever
  // used rather than only the ones on the page in front of the reader - a tag
  // filter that can only select what is already visible filters nothing.
  const allTags = notesPage.tags;

  const tagOptions = useMemo(
    () => [{ value: "", label: "All Tags" }, ...allTags.map((tag) => ({ value: tag, label: `#${tag}` }))],
    [allTags],
  );

  // Firm-custom types (added via the composer's quick-add) are appended after
  // the built-ins everywhere the type list is offered. `customNoteTypes` can
  // also contain rows that only override a built-in type's color (same
  // backend table) - those carry a built-in's own value, so they colour the
  // matching built-in option below rather than appending a duplicate one.
  const noteTypeOptions = useMemo(() => {
    const customTypesOnly = customNoteTypes.filter((t) => !(NOTE_TYPE_ORDER as readonly string[]).includes(t.value));
    return [
      ...NOTE_TYPE_ORDER.map((value) => {
        const { label, variant } = resolveNoteTypeMeta(value, noteTypeColors);
        return { value, label, dotClassName: STATUS_VARIANTS[variant].dot };
      }),
      ...customTypesOnly.map((t) => {
        const { variant } = resolveNoteTypeMeta(t.value, noteTypeColors);
        return { value: t.value, label: t.label, dotClassName: STATUS_VARIANTS[variant].dot };
      }),
    ];
  }, [customNoteTypes, noteTypeColors]);

  const noteTypeFilterOptions = useMemo(
    () => [{ value: "all", label: "All Types" }, ...noteTypeOptions],
    [noteTypeOptions],
  );

  const templateOptions = useMemo(
    () => [
      ...NOTE_TEMPLATES.map((template) => ({ value: template.id, label: template.label })),
      ...customNoteTemplates.map((t) => ({ value: t.id, label: t.label })),
    ],
    [customNoteTemplates],
  );

  // The search, tag, type, time filters, and ordering (pinned first, then
  // note date, then created date) are all applied by the server, so
  // `noteEntries` is already in the right order - re-sorting here would
  // discard the pinned-first ordering the backend computed. Filtering in the
  // browser would only narrow the rows already on screen, so searching from
  // page 3 would silently miss every match above it.
  const sortedNoteEntries = noteEntries;

  // Distinguishes "this entity has no notes" from "your filters excluded them
  // all", which are the same empty list but need opposite advice.
  const hasActiveFilters = Boolean(
    notesPage.search.trim() || notesPage.tag || notesPage.noteType !== 'all' || notesPage.timeFilter !== 'all'
  );

  // Template selection handler. Custom (firm-added) templates use a UUID id,
  // which never collides with a built-in's slug id, so checking custom first
  // is safe.
  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);
    const customTemplate = customNoteTemplates.find((t) => t.id === templateId);
    if (customTemplate) {
      setNewNoteSubject(customTemplate.subject);
      setNewNoteContentHtml(customTemplate.contentHtml);
      setNewNoteType(customTemplate.noteType);
      return;
    }
    const template = getTemplate(templateId);
    if (template) {
      setNewNoteSubject(template.subject);
      setNewNoteContentHtml(template.content);
      setNewNoteType(template.noteType);
    }
  };

  // Strip HTML for plain text version
  const stripHtml = (html: string): string => {
    const tmp = document.createElement('DIV');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  };

  const resetComposeForm = () => {
    setIsAddingNew(false);
    setNewNoteContentHtml("");
    setNewNoteMentions([]);
    setNewNoteSubject("");
    setNewNoteType("general");
    setNewNoteAttachments([]);
    setSelectedTemplate("blank");
    setNewNoteDate(dayjs().format('YYYY-MM-DD'));
  };

  /** A saved note sorts to the top, so the list goes back to page 1 to show it. */
  const finishAdd = (noteIdForTime: string | null) => {
    notesPage.setPage(1);
    notesPage.refresh();
    resetComposeForm();
    if (noteIdForTime) {
      setTimeModalNoteId(noteIdForTime);
      setTimeModalEntry(null);
    }
  };

  const finishEdit = () => {
    notesPage.refresh();
    setEditingNote(null);
    setEditNoteContentHtml("");
    setEditNoteSubject("");
    setEditNoteType("general");
    setEditNoteAttachments([]);
  };

  // A note's new attachments upload the way the file manager uploads: one job,
  // held above the page, with the bar, its cancel and an account of what failed.
  // The note is written inside the same job once the files land, so leaving the
  // panel mid-upload still saves it. The ref says what the job is saving, for
  // the panel that started it; a panel mounting mid-upload only refreshes.
  const parentIds = parentType === 'matter'
    ? { matterId: parentId }
    : parentType === 'task' ? { taskId: parentId } : { clientId: parentId };
  const pendingSaveRef = useRef<{ kind: 'add' | 'edit'; thenAddTime: boolean; noteId: string | null } | null>(null);
  const [attachmentFailures, setAttachmentFailures] = useState<Array<{ name: string; error: string }>>([]);
  const noteUpload = useUploadJob({
    jobKey: uploadJobKey(lawFirmId, parentIds, "note"),
    onDone: (response) => {
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      setSubmitting(false);
      setAttachmentFailures(response.failures || []);
      if (pending?.kind === 'add') finishAdd(pending.thenAddTime ? pending.noteId : null);
      else if (pending?.kind === 'edit') finishEdit();
      else notesPage.refresh();
    },
    onFailed: (message) => {
      pendingSaveRef.current = null;
      setSubmitting(false);
      setError(message);
    },
    onCancelled: () => {
      pendingSaveRef.current = null;
      setSubmitting(false);
    },
  });

  /**
   * Save a note whose draft carries new files: upload them, then write the note
   * with what landed. Answers false when there is nothing to upload, so the
   * caller writes the note directly.
   *
   * A file that fails does not hold the note back. The note is saved with the
   * rest and the failures are named, so nothing the author wrote is lost and
   * nothing is uploaded twice. Before the write, the draft's files are swapped
   * for their uploaded copies, so if the write itself fails, trying again sends
   * only the files that never landed.
   */
  const saveWithUploads = (
    attachments: Attachment[],
    kind: 'add' | 'edit',
    thenAddTime: boolean,
    setDraftAttachments: (attachments: Attachment[]) => void,
    save: (attachments: Attachment[]) => Promise<{ note?: { id: string } } | void>,
  ): boolean => {
    const files = attachments.filter((a) => a.file).map((a) => a.file as File);
    if (files.length === 0) return false;
    const kept = attachments.filter((a) => !a.file);
    pendingSaveRef.current = { kind, thenAddTime, noteId: null };
    noteUpload.start(files, async (signal, onFinalizing) => {
      const response = await FilesService.uploadNoteAttachmentFiles(lawFirmId, parentIds, files, signal, onFinalizing);
      const uploaded: Attachment[] = response.files.map((file) => ({
        id: file.fileId,
        name: file.name,
        size: file.size,
        type: file.contentType || 'application/octet-stream',
        url: file.signedUrl,
        objectPath: file.objectPath,
      }));
      // A failure names its file by position in `files`, since two picked files
      // can share a name; the name is the fallback for one that carries none.
      const failures = response.failures || [];
      const failedAt = new Set(failures.map((f) => f.index).filter((i): i is number => i !== undefined));
      const failedNames = new Set(failures.filter((f) => f.index === undefined).map((f) => f.name));
      setDraftAttachments([
        ...kept,
        ...uploaded,
        ...attachments
          .filter((a) => a.file)
          .filter((a, i) => failedAt.has(i) || failedNames.has(a.file!.name)),
      ]);
      const result = await save([...kept, ...uploaded]);
      if (pendingSaveRef.current) pendingSaveRef.current.noteId = result?.note?.id ?? null;
      return response;
    });
    return true;
  };

  /**
   * Save the note, then either stop (Save) or open the time modal against the
   * note just created (Save & Add Time). Both buttons share this one submit
   * path so they can never diverge on validation or on what gets sent.
   */
  const handleSubmitNote = async (thenAddTime: boolean) => {
    if (!onAddNote) return;

    const plainContent = stripHtml(newNoteContentHtml);
    if (!plainContent.trim()) {
      setError("Note content cannot be empty");
      return;
    }

    setSubmitting(true);
    setError(null);
    setAttachmentFailures([]);
    setSaveMenuOpen(false);

    const save = (attachments: Attachment[]) => onAddNote({
      content: plainContent,
      contentHtml: newNoteContentHtml,
      subject: newNoteSubject || undefined,
      noteType: newNoteType,
      noteDate: newNoteDate || undefined,
      mentions: newNoteMentions,
      attachments,
    });
    if (saveWithUploads(newNoteAttachments, 'add', thenAddTime, setNewNoteAttachments, save)) return;

    try {
      const result = await save(newNoteAttachments);
      finishAdd(thenAddTime ? result?.note?.id ?? null : null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add note"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditNote = async () => {
    if (!editingNote || !onUpdateNote) return;

    const plainContent = stripHtml(editNoteContentHtml);

    if (!plainContent.trim()) {
      setError("Note content cannot be empty");
      return;
    }

    setSubmitting(true);
    setError(null);
    setAttachmentFailures([]);

    const noteId = editingNote;
    const save = async (attachments: Attachment[]) => {
      await onUpdateNote(noteId, {
        content: plainContent,
        contentHtml: editNoteContentHtml,
        subject: editNoteSubject || undefined,
        noteType: editNoteType,
        noteDate: editNoteDate || undefined,
        attachments,
      });
    };
    if (saveWithUploads(editNoteAttachments, 'edit', false, setEditNoteAttachments, save)) return;

    try {
      await save(editNoteAttachments);
      finishEdit();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update note"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteNote = (noteId: string) => {
    if (!onDeleteNote) return;
    setRetractReason("");
    setNoteToDelete(noteId);
  };

  const confirmDeleteNote = async () => {
    if (!noteToDelete || !onDeleteNote) return;
    setError(null);
    setDeletingNote(true);
    try {
      await onDeleteNote(noteToDelete, retractReason.trim() || undefined);
      notesPage.refresh();
      setNoteToDelete(null);
      setRetractReason("");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to retract note"));
    } finally {
      setDeletingNote(false);
    }
  };

  const startEditing = (note: NoteEntry) => {
    if (!canEditNotes) return;
    setEditingNote(note.id);
    setEditNoteContentHtml(note.contentHtml || note.content);
    setEditNoteSubject(note.subject || "");
    setEditNoteType(note.noteType || "general");
    setEditNoteAttachments(note.attachments || []);
    setEditNoteDate(note.date);
  };

  const cancelEditing = () => {
    setEditingNote(null);
    setEditNoteContentHtml("");
    setEditNoteSubject("");
    setEditNoteType("general");
    setEditNoteAttachments([]);
    setEditNoteDate(dayjs().format('YYYY-MM-DD'));
  };

  const cancelAdding = () => {
    resetComposeForm();
  };

  const openAddTimeModal = (noteId: string) => {
    if (!canAddTimeEntries) return;
    setTimeModalNoteId(noteId);
    setTimeModalEntry(null);
  };

  const openEditTimeModal = (noteId: string, entry: NoteTimeEntry) => {
    if (!canEditTimeEntries || !entry.editable) return;
    setTimeModalNoteId(noteId);
    setTimeModalEntry(entry);
  };

  const closeTimeModal = () => {
    setTimeModalNoteId(null);
  };

  useResetAfterClose(timeModalOpen, () => {
    setTimeModalEntry(null);
    setTimeModalSubmitting(false);
  });

  const handleTimeModalSubmit = async (value: NoteTimeEntryFormValue) => {
    if (!timeModalNoteId) return;
    setTimeModalSubmitting(true);
    try {
      if (timeModalEntry) {
        if (!onUpdateTimeEntry) return;
        await onUpdateTimeEntry(timeModalNoteId, timeModalEntry.id, value);
      } else {
        if (!onAddTimeEntry) return;
        await onAddTimeEntry(timeModalNoteId, value);
      }
      notesPage.refresh();
      closeTimeModal();
    } finally {
      setTimeModalSubmitting(false);
    }
  };

  const handleRemoveTimeEntry = (noteId: string, entry: NoteTimeEntry) => {
    if (!onRemoveTimeEntry || !entry.editable) return;
    setTimeEntryToRemove({ noteId, timeEntryId: entry.id });
  };

  const confirmRemoveTimeEntry = async () => {
    if (!timeEntryToRemove || !onRemoveTimeEntry) return;
    setError(null);
    setRemovingTimeEntry(true);
    try {
      await onRemoveTimeEntry(timeEntryToRemove.noteId, timeEntryToRemove.timeEntryId);
      notesPage.refresh();
      setTimeEntryToRemove(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove time entry"));
    } finally {
      setRemovingTimeEntry(false);
    }
  };

  const handleTogglePin = async (noteId: string, pinned: boolean) => {
    if (!onSetPinned) return;
    setError(null);
    try {
      await onSetPinned(noteId, pinned);
      notesPage.refresh();
    } catch (err) {
      setError(getErrorMessage(err, pinned ? "Failed to pin note" : "Failed to unpin note"));
    }
  };

  /**
   * Toggle one checklist item's checked state directly from the note display,
   * without opening Edit. `itemIndex` is that item's position among every
   * `taskList` `<li>` in the note (document order), found by walking the same
   * rendered content the reader clicked in - cheaper than re-parsing the
   * editor's node structure, and the two always agree on ordering.
   */
  const handleToggleChecklistItem = async (note: NoteEntry, itemIndex: number) => {
    if (!onUpdateNote) return;
    const container = document.createElement('div');
    container.innerHTML = note.contentHtml || note.content;
    const item = container.querySelectorAll('ul[data-type="taskList"] li')[itemIndex];
    if (!item) return;

    const nowChecked = item.getAttribute('data-checked') !== 'true';
    item.setAttribute('data-checked', String(nowChecked));
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (nowChecked) checkbox?.setAttribute('checked', 'checked');
    else checkbox?.removeAttribute('checked');

    const contentHtml = container.innerHTML;
    try {
      await onUpdateNote(note.id, {
        content: stripHtml(contentHtml),
        contentHtml,
        subject: note.subject,
        noteType: note.noteType,
        noteDate: note.date,
        attachments: note.attachments,
      });
      notesPage.refresh();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update checklist item"));
    }
  };

  /** Event delegation: only checkboxes inside a note's own checklist trigger a toggle. */
  const handleNoteContentClick = (note: NoteEntry) => (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
    const item = target.closest('li');
    if (!item) return;
    const allItems = Array.from(e.currentTarget.querySelectorAll('ul[data-type="taskList"] li'));
    const itemIndex = allItems.indexOf(item);
    if (itemIndex === -1) return;
    e.preventDefault();
    handleToggleChecklistItem(note, itemIndex);
  };

  const handlePrintNote = (noteId: string) => {
    setPrintPreviewNoteId(noteId);
  };

  const timeModalEntryForForm = useMemo(() => {
    if (!timeModalNoteId) return { activityName: undefined, description: undefined, date: undefined };
    const note = noteEntries.find((n) => n.id === timeModalNoteId);
    return {
      activityName: note?.subject,
      description: note?.content?.slice(0, 100),
      date: dayjs().format('YYYY-MM-DD'),
    };
  }, [timeModalNoteId, noteEntries]);

  const versionHistoryNoteRaw = useMemo(
    () => noteEntries.find((n) => n.id === versionHistoryNoteId) || null,
    [versionHistoryNoteId, noteEntries],
  );
  const versionHistoryNote = useLastOpenValue(!!versionHistoryNoteId, versionHistoryNoteRaw);

  return (
    <>
    <div className="bg-surface rounded-lg shadow-sm border border-outline">
      <div className="p-4 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
          <h2 className="text-xl font-semibold text-on-surface">Notes ({notesPage.counts.all})</h2>
          {canAddNotes && (
            <Button
              size="compact"
              onClick={() => setIsAddingNew(true)}
              icon={<Plus size={14} strokeWidth={2.2} />}
              className="w-full sm:w-auto"
            >
              Add Note
            </Button>
          )}
        </div>

        {/* `error` is this panel's own write failures; notesPage.error is the READ
            failing. Without the second, a 500 on the notes list fell through to
            the empty state and told a lawyer the matter has no notes, whose
            obvious next action is to write the note again. MatterEventsTab
            already combines the two the same way. */}
        <ErrorNotification error={error || notesPage.error} className="mb-4" />
        {noteUpload.uploading && (
          <div className="mb-4">
            <UploadInProgress finalizing={noteUpload.finalizing} onCancel={noteUpload.cancel} />
          </div>
        )}
        {attachmentFailures.length > 0 && (
          <div className="mb-4">
            <UploadFailures
              failures={attachmentFailures}
              summary={`${attachmentFailures.length} attachment${attachmentFailures.length === 1 ? '' : 's'} could not be uploaded, so the note was saved without ${attachmentFailures.length === 1 ? 'it' : 'them'}.`}
            />
          </div>
        )}

        <div className="mb-6 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-3">
            <input
              type="text"
              value={notesPage.search}
              onChange={(e) => notesPage.setSearch(e.target.value)}
              placeholder="Search notes..."
                  className={`${INPUT_CLS} min-w-0 flex-1`}
            />
            {allTags.length > 0 && (
              <Dropdown
                value={notesPage.tag}
                onChange={notesPage.setTag}
                options={tagOptions}
                className="w-full sm:w-auto sm:min-w-[180px]"
                buttonClassName="border-input-border bg-input-bg"
              />
            )}
          </div>
        </div>

        {/* Filter Tabs - Stack on mobile to avoid cutoff, horizontal pills on desktop */}
        <div className="mb-6">
          <div className="flex flex-col gap-2 md:flex-row md:gap-1 md:p-1 md:bg-surface-alt md:rounded-lg md:w-fit">
            {TIME_FILTER_TABS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => notesPage.setTimeFilter(value)}
                className={`w-full md:w-auto px-4 py-2.5 md:py-2 text-sm font-medium rounded-lg md:rounded-md transition-colors cursor-pointer text-left md:text-center ${
                  notesPage.timeFilter === value
                    ? 'bg-surface-alt md:bg-surface text-on-surface shadow-sm border border-outline md:border-transparent'
                    : 'text-on-surface-secondary hover:text-on-surface border border-transparent md:border-transparent'
                }`}
              >
                {label}
                <span className="ml-1.5 text-xs text-on-surface-secondary">
                  ({notesPage.counts[TIME_FILTER_COUNT_KEYS[value]]})
                </span>
              </button>
            ))}
          </div>

          {/* Note Type Filter, with the "still working" line beside it. Search,
              tag, time and type all re-read from the server while the current
              notes stay on screen, so without this the list looks unchanged. */}
          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center">
            <Dropdown
              value={notesPage.noteType}
              onChange={notesPage.setNoteType}
              options={noteTypeFilterOptions}
              className="w-full md:w-auto md:min-w-[200px]"
              buttonClassName="border-input-border bg-input-bg"
            />
            {/* Stacked under the filter on mobile, so the slot is reserved: the
                line then fills space that was already there instead of pushing
                the notes down when it appears. */}
            <div className="flex h-5 items-center md:h-auto">
              <ListBusyIndicator busy={notesPage.fetching && !notesPage.loading && !pagerPending} />
            </div>
          </div>
        </div>

        {isAddingNew && canAddNotes && (
          <div className="mb-6 p-4 md:p-5 border border-outline rounded-lg bg-surface-alt min-w-0">
            <div className="space-y-4">
              {/* Subject and Date */}
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="flex-1 min-w-0">
                  <FieldLabel htmlFor={`${fieldIds}-newnotesubject`}>
                    Subject <span className="text-on-surface-muted">(optional)</span>
                  </FieldLabel>
                  <input
                    id={`${fieldIds}-newnotesubject`}
                    type="text"
                    value={newNoteSubject}
                    onChange={(e) => setNewNoteSubject(e.target.value)}
                    placeholder="Brief title for this note..."
                      className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>
                <div className="md:w-48">
                  <FieldLabel id={`${fieldIds}-date-label`}>Date</FieldLabel>
                  <DatePicker
                    ariaLabelledBy={`${fieldIds}-date-label`}
                    value={newNoteDate}
                    onChange={setNewNoteDate}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Template and Type Selection */}
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="flex-1 min-w-0">
                  <QuickAddDropdown
                    label="Template"
                    value={selectedTemplate}
                    onChange={handleTemplateSelect}
                    options={templateOptions}
                    buttonClassName="border-input-border bg-input-bg"
                    quickAddTooltip="Save the current draft as a template"
                    quickAddPlaceholder="e.g. Settlement Letter"
                    quickAddButtonLabel="Save as Template"
                    onQuickAdd={async (label) => {
                      const result = await createNoteTemplate({
                        label,
                        noteType: newNoteType,
                        subject: newNoteSubject,
                        contentHtml: newNoteContentHtml,
                      });
                      return result.noteTemplate.id;
                    }}
                  />
                </div>
                <div className="flex-1">
                  <QuickAddDropdown
                    label="Note Type"
                    value={newNoteType}
                    onChange={setNewNoteType}
                    options={noteTypeOptions}
                    buttonClassName="border-input-border bg-input-bg"
                    quickAddTooltip="Add a custom note type"
                    quickAddPlaceholder="e.g. Deposition"
                    quickAddButtonLabel="Create & Select"
                    onQuickAdd={async (label) => {
                      const result = await createNoteType(label);
                      return result.noteType.value;
                    }}
                    trailingAction={
                      <NoteTypeColorPicker
                        value={resolveNoteTypeMeta(newNoteType, noteTypeColors).variant}
                        onChange={(variant) => updateNoteTypeColor(newNoteType, variant)}
                      />
                    }
                  />
                </div>
              </div>

              {/* Content - Tiptap Editor */}
              <div>
                <FieldLabel>
                  Note Content <span aria-hidden="true">*</span>
                </FieldLabel>
                <TiptapEditor
                  content={newNoteContentHtml}
                  onChange={setNewNoteContentHtml}
                  placeholder="Start typing your note... use @ to mention a colleague"
                  mentionMembers={firmMembers}
                  onMentionsChange={setNewNoteMentions}
                />
              </div>

              {/* Attachments */}
              <NoteAttachments
                attachments={newNoteAttachments}
                onChange={setNewNoteAttachments}
                lawFirmId={lawFirmId}
                matterId={parentType === 'matter' ? parentId : undefined}
              />

              <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
                <div className="flex w-full sm:w-auto">
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => handleSubmitNote(false)}
                    loading={submitting || noteUpload.uploading}
                    className={`w-full sm:w-auto ${canAddTimeEntries ? 'rounded-r-none' : ''}`}
                  >
                    Save Note
                  </Button>
                  {canAddTimeEntries && (
                    <>
                      <button
                        type="button"
                        data-item-menu-trigger
                        aria-label="More save options"
                        onClick={(e) => {
                          if (saveMenuOpen) { setSaveMenuOpen(false); return; }
                          setSaveMenuPos(menuPositionFromEvent(e));
                          setSaveMenuOpen(true);
                        }}
                        disabled={submitting}
                        className="flex items-center justify-center px-2 py-1.5 rounded-r-md rounded-l-none border border-l border-accent-border-soft bg-accent-solid text-accent-foreground shadow-sm dark:shadow-none hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring dark:focus-visible:ring-focus-ring disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                      <ItemActionMenu
                        open={saveMenuOpen}
                        anchorTop={saveMenuPos?.anchorTop ?? 0}
                        anchorBottom={saveMenuPos?.anchorBottom ?? 0}
                        right={saveMenuPos?.right ?? 0}
                        onClose={() => setSaveMenuOpen(false)}
                        actions={[
                          { key: 'save-and-time', label: 'Save & Add Time', onClick: () => handleSubmitNote(true) },
                        ]}
                      />
                    </>
                  )}
                </div>
                <Button
                  type="secondary"
                  size="small"
                  onClick={cancelAdding}
                  className="w-full sm:w-auto"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* An empty list and a failed read look identical from here, so the
            empty state is withheld when the read failed. Claiming "No notes yet"
            after a 500 tells a lawyer the matter has none, and the obvious next
            action is to write the note again. The banner above says what
            actually happened. */}
        {notesPage.loading && sortedNoteEntries.length === 0 ? (
          <ListSkeleton rows={4} label="Loading notes" />
        ) : sortedNoteEntries.length === 0 && !notesPage.error ? (
          <ListEmptyState
            compact
            icon={<FileText size={32} />}
            title={hasActiveFilters ? 'No notes match your filters' : 'No notes yet'}
            message={
              hasActiveFilters
                ? 'Try a different search term, tag or type.'
                : 'Add your first note above.'
            }
          />
        ) : (
          <div className="space-y-4 min-w-0">
            {sortedNoteEntries.map((note) => {
              // A note pulled in from a linked company (parentType 'client' only,
              // matter/task notes never widen) isn't this client's own record to
              // mutate: every write path (update/retract/pin/add-time) is scoped
              // server-side to the person's own client id, not the widened set
              // this list reads from, so it would 404. Keep it view-only here.
              const isCompanyNote = parentType === 'client' && !!companyNames?.get(note.parentId);
              const canEditThisNote = canEditNotes && !isCompanyNote;
              const canDeleteThisNote = canDeleteNotes && !isCompanyNote;
              const canPinThisNote = !!onSetPinned && !isCompanyNote;
              const canAddTimeToThisNote = canAddTimeEntries && !isCompanyNote;
              const canEditThisNoteTime = canEditTimeEntries && !isCompanyNote;
              const canRemoveThisNoteTime = canRemoveTimeEntries && !isCompanyNote;
              return (
              <div
                key={note.id}
                id={`note-${note.id}`}
                className={`relative border rounded-lg p-4 bg-surface min-w-0 overflow-hidden transition-colors ${
                  deepLinkNoteId === note.id ? 'border-accent-control-ring ring-2 ring-focus-ring' : 'border-outline-subtle'
                }`}
              >
                {editingNote === note.id ? (
                  <div className="space-y-3">
                    {/* Subject and Date for Editing */}
                    <div className="flex flex-col gap-4 md:flex-row">
                      <div className="flex-1 min-w-0">
                        <FieldLabel htmlFor={`${fieldIds}-editnotesubject`}>
                          Subject <span className="text-on-surface-muted">(optional)</span>
                        </FieldLabel>
                        <input
                          id={`${fieldIds}-editnotesubject`}
                          type="text"
                          value={editNoteSubject}
                          onChange={(e) => setEditNoteSubject(e.target.value)}
                          placeholder="Brief title for this note..."
                className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        />
                      </div>
                      <div className="md:w-48">
                        <FieldLabel id={`${fieldIds}-date-2-label`}>Date</FieldLabel>
                        <DatePicker
                          ariaLabelledBy={`${fieldIds}-date-2-label`}
                          value={editNoteDate}
                          onChange={setEditNoteDate}
                          className="w-full"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                    <div className="flex gap-4">
                      <div className="flex-1">
                        <FieldLabel>Note Type</FieldLabel>
                        <div className="flex items-stretch gap-2">
                          <div className="flex-1 min-w-0">
                            <Dropdown
                              portal
                              value={editNoteType}
                              onChange={setEditNoteType}
                              options={noteTypeOptions}
                              buttonClassName="border-input-border bg-input-bg"
                            />
                          </div>
                          <NoteTypeColorPicker
                            value={resolveNoteTypeMeta(editNoteType, noteTypeColors).variant}
                            onChange={(variant) => updateNoteTypeColor(editNoteType, variant)}
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <FieldLabel>
                        Note Content <span aria-hidden="true">*</span>
                      </FieldLabel>
                      <TiptapEditor
                        content={editNoteContentHtml}
                        onChange={setEditNoteContentHtml}
                        placeholder="Start typing your note..."
                      />
                    </div>

                    <NoteAttachments
                      attachments={editNoteAttachments}
                      onChange={setEditNoteAttachments}
                      lawFirmId={lawFirmId}
                      matterId={parentType === 'matter' ? parentId : undefined}
                    />

                    <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
                      <Button
                        type="primary"
                        size="small"
                        onClick={handleEditNote}
                        loading={submitting || noteUpload.uploading}
                        className="w-full sm:w-auto"
                      >
                        Save
                      </Button>
                      <Button
                        type="secondary"
                        size="small"
                        onClick={cancelEditing}
                        className="w-full sm:w-auto"
                      >
                        Cancel
                      </Button>
                    </div>
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0">
                    {/* Action Buttons - Stacked full-width on mobile, horizontal top-right on desktop.
                        Always rendered: NoteActionsMenu's Copy Link is available regardless of
                        any edit/delete/time permission. */}
                    <div className="flex flex-col gap-2 mb-4 md:absolute md:top-3 md:right-3 md:flex-row md:mb-0 md:flex-nowrap">
                      {canEditThisNote && !note.retractedAt && (
                        <Button
                          type="primary"
                          size="small"
                          onClick={() => startEditing(note)}
                          className="w-full md:w-auto justify-center"
                          icon={<Pencil size={16} />}
                        >
                          Edit
                        </Button>
                      )}
                      {canDeleteThisNote && !note.retractedAt && (
                        <Button
                          type="danger"
                          size="small"
                          onClick={() => handleDeleteNote(note.id)}
                          className="w-full md:w-auto justify-center"
                          icon={<Trash2 size={16} />}
                        >
                          Retract
                        </Button>
                      )}
                      <NoteActionsMenu
                        lawFirmId={lawFirmId}
                        parentType={parentType}
                        parentId={parentId}
                        noteId={note.id}
                        noteSubject={note.subject}
                        noteExcerpt={note.content?.slice(0, 100)}
                        noteContent={note.content}
                        pinned={!!note.pinnedAt}
                        canPin={canPinThisNote}
                        canAddTime={canAddTimeToThisNote}
                        canLink={isMatter}
                        canPrint={isMatter}
                        onAddTime={() => openAddTimeModal(note.id)}
                        onTogglePin={() => handleTogglePin(note.id, !note.pinnedAt)}
                        onPrint={() => handlePrintNote(note.id)}
                        onTaskCreated={onTaskCreated}
                      />
                    </div>

                    {/* Note Type Badge */}
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      {!!note.pinnedAt && (
                        <StatusBadge variant="neutral">Pinned</StatusBadge>
                      )}
                      <StatusBadge variant={resolveNoteTypeMeta(note.noteType, noteTypeColors).variant}>
                        {resolveNoteTypeMeta(note.noteType, noteTypeColors).label}
                      </StatusBadge>
                      {note.retractedAt && (
                        <StatusBadge variant="danger">Retracted</StatusBadge>
                      )}
                      {parentType === 'client' && companyNames?.get(note.parentId) && (
                        <TagChip label={companyNames.get(note.parentId)!} />
                      )}
                    </div>

                    {note.retractedAt && (
                      <div className="mb-2 text-xs text-on-surface-muted">
                        Retracted {dayjs(note.retractedAt).format('MMM D, YYYY')}
                        {note.retractionReason && <>: {note.retractionReason}</>}
                      </div>
                    )}

                    {/* Subject · Like Clio's subject column but displayed as a title */}
                    {note.subject && (
                      <h4 className={`text-base font-semibold mb-2 pr-0 md:pr-48 break-words ${note.retractedAt ? 'text-on-surface-muted line-through' : 'text-on-surface'}`}>
                        {note.subject}
                      </h4>
                    )}

                    {/* Note Content */}
                    <div
                      className={`note-content text-sm break-words ${note.subject ? '' : 'pr-0 md:pr-48'} prose prose-sm max-w-none prose-p:break-words prose-li:break-words [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full ${note.retractedAt ? 'text-on-surface-muted line-through opacity-70' : 'text-on-surface'} ${canEditThisNote && !note.retractedAt ? 'checklist-interactive' : ''}`}
                      style={{ lineHeight: '1.5' }}
                      onClick={canEditThisNote && !note.retractedAt ? handleNoteContentClick(note) : undefined}
                      dangerouslySetInnerHTML={{
                        __html: sanitizeRichHtml(note.contentHtml || note.content)
                      }}
                    />

                    {/* Attachments */}
                    {note.attachments && note.attachments.length > 0 && (
                      <div className="mt-3 min-w-0">
                        <NoteAttachments
                          attachments={note.attachments}
                          onChange={() => {}}
                          readOnly
                          lawFirmId={lawFirmId}
                          matterId={parentType === 'matter' ? parentId : undefined}
                        />
                      </div>
                    )}

                    {/* Time entries: totals, billing status, and one row per entry.
                        Renders nothing itself when the note has none. */}
                    <NoteTimePanel
                      time={note.time}
                      canEditTime={canEditThisNoteTime && !note.retractedAt}
                      canRemoveTime={canRemoveThisNoteTime && !note.retractedAt}
                      onEditTime={(entry) => openEditTimeModal(note.id, entry)}
                      onRemoveTime={(entry) => handleRemoveTimeEntry(note.id, entry)}
                    />

                    {isMatter && !!note.links?.length && (
                      <NoteLinksRow
                        links={note.links}
                        lawFirmId={lawFirmId}
                        canUnlink={isMatter}
                        onUnlink={(link) => {
                          void noteLinks.unlink.mutateAsync({ noteId: note.id, linkId: link.id });
                        }}
                      />
                    )}

                    {note.tags.length > 0 && (
                      <div className="mt-3 flex gap-1 flex-wrap">
                        {note.tags.map(tag => (
                          <span
                            key={tag}
                            className="inline-block bg-blue-100 dark:bg-blue-500/15 text-blue-800 dark:text-blue-300 text-xs px-2 py-1 rounded"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 text-xs text-on-surface-secondary">
                      <div>
                        By {note.createdByName || 'Unknown'} • {dayjs(note.createdAt).format('MMM D, YYYY [at] h:mm A')}
                      </div>
                      {note.editedAt && note.editedByName && (
                        <div className="mt-1">
                          Edited by {note.editedByName} • {dayjs(note.editedAt).isValid() ? dayjs(note.editedAt).format('MMM D, YYYY [at] h:mm A') : 'Unknown date'}
                          {' '}·{' '}
                          <button
                            type="button"
                            onClick={() => setVersionHistoryNoteId(note.id)}
                            className="text-accent-emphasis hover:underline cursor-pointer"
                          >
                            View history
                          </button>
                        </div>
                      )}
                    </div>

                    <NoteReplies
                      lawFirmId={lawFirmId}
                      parentType={parentType}
                      parentId={parentId}
                      noteId={note.id}
                      noteSubject={note.subject}
                      replyCount={note.replyCount || 0}
                      canReply={canEditThisNote && !note.retractedAt}
                      // Create-task-from-reply is matter-only (uses the matter-only note-links feature).
                      canCreateTask={isMatter && canEditThisNote && !note.retractedAt}
                      onTaskCreated={onTaskCreated}
                    />
                  </div>
                )}
              </div>
              );
            })}

            {pagerWillRender(notesPage.total) && (
              <ListPager
                page={notesPage.page}
                totalPages={notesPage.totalPages}
                total={notesPage.total}
                rowsPerPage={notesPage.rowsPerPage}
                onPageChange={notesPage.setPage}
                busy={notesPage.fetching}
                serverPaged
                onPendingChange={setPagerPending}
                rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
                onRowsPerPageChange={notesPage.setRowsPerPage}
              />
            )}
          </div>
        )}
      </div>
    </div>

    <NoteTimeEntryModal
      isOpen={timeModalOpen}
      onClose={closeTimeModal}
      onSubmit={handleTimeModalSubmit}
      submitting={timeModalSubmitting}
      entry={timeModalEntry}
      defaultActivityName={timeModalEntryForForm.activityName}
      defaultDescription={timeModalEntryForForm.description}
      defaultDate={timeModalEntryForForm.date}
    />

    {versionHistoryNote && (
      <NoteVersionHistoryModal
        isOpen={!!versionHistoryNoteId}
        onClose={() => setVersionHistoryNoteId(null)}
        lawFirmId={lawFirmId}
        parentType={parentType}
        parentId={parentId}
        noteId={versionHistoryNote.id}
        current={{
          content: versionHistoryNote.content,
          contentHtml: versionHistoryNote.contentHtml,
          editedByName: versionHistoryNote.editedByName,
          editedAt: versionHistoryNote.editedAt,
          createdByName: versionHistoryNote.createdByName,
          createdAt: versionHistoryNote.createdAt,
        }}
      />
    )}

    <NotePrintPreviewModal
      isOpen={!!printPreviewNoteId}
      lawFirmId={lawFirmId}
      matterId={parentId}
      noteId={printPreviewNoteId}
      onClose={() => setPrintPreviewNoteId(null)}
    />

    <RetractReasonModal
      isOpen={noteToDelete !== null}
      onClose={() => setNoteToDelete(null)}
      onConfirm={confirmDeleteNote}
      title="Retract note"
      message="Retracting keeps the note and its history on the record. Time already recorded is not affected. Only its author or a firm admin can retract it."
      reason={retractReason}
      onReasonChange={setRetractReason}
      placeholder="Why is this note being retracted?"
      loading={deletingNote}
    />

    <ConfirmModal
      isOpen={timeEntryToRemove !== null}
      onClose={() => setTimeEntryToRemove(null)}
      onConfirm={confirmRemoveTimeEntry}
      title="Remove time entry"
      message="Are you sure you want to remove this time entry? This cannot be undone."
      confirmText="Remove"
      loading={removingTimeEntry}
    />
    </>
  );
}
