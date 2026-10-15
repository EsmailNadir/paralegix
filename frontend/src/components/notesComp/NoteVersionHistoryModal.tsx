"use client";

import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import Modal from "@/components/ui/Modal";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import mattersService from "@/services/matters.service";
import tasksService from "@/services/tasks.service";
import clientsService from "@/services/clients.service";

interface NoteVersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  lawFirmId: string;
  parentType: 'matter' | 'task' | 'client';
  parentId: string;
  noteId: string;
  /** The note as it stands right now, shown as the first, current entry. */
  current: { content: string; contentHtml?: string; editedByName?: string; editedAt?: string; createdByName?: string; createdAt: string };
}

/**
 * A note's full version history, newest first, current version on top.
 *
 * No diff view: a note is prose, and a word-level diff of prose is harder to
 * read than the two versions side by side. Each entry shows the complete text
 * as it stood at that point.
 */
export default function NoteVersionHistoryModal({
  isOpen, onClose, lawFirmId, parentType, parentId, noteId, current,
}: NoteVersionHistoryModalProps) {
  const query = useQuery({
    queryKey: ["noteVersions", parentType, lawFirmId, parentId, noteId],
    queryFn: () => {
      if (parentType === 'task') return tasksService.listTaskNoteVersions(lawFirmId, parentId, noteId);
      if (parentType === 'client') return clientsService.listClientNoteVersions(lawFirmId, parentId, noteId);
      return mattersService.listNoteVersions(lawFirmId, parentId, noteId);
    },
    enabled: isOpen,
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Note History" size="2xl" lockScroll bodyClassName={null}>
      <div className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
        {query.error && <ErrorNotification error={query.error as Error} />}
        {query.isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : (
          <>
            <div className="border border-outline rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-accent-emphasis">Current</span>
                <span className="text-xs text-on-surface-muted">
                  {current.editedByName
                    ? `Edited by ${current.editedByName} on ${dayjs(current.editedAt).format('MMM D, YYYY [at] h:mm A')}`
                    : `By ${current.createdByName || 'Unknown'} on ${dayjs(current.createdAt).format('MMM D, YYYY [at] h:mm A')}`}
                </span>
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(current.contentHtml || current.content) }}
              />
            </div>

            {(query.data?.versions || []).map((version) => (
              <div key={version.id} className="border border-outline-subtle rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Version {version.version}</span>
                  <span className="text-xs text-on-surface-muted">
                    Edited by {version.editedByName || 'Unknown'} on {dayjs(version.createdAt).format('MMM D, YYYY [at] h:mm A')}
                  </span>
                </div>
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(version.contentHtml || version.content) }}
                />
              </div>
            ))}

            {!query.isLoading && !(query.data?.versions || []).length && (
              <p className="text-sm text-on-surface-muted">This note has not been edited.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
