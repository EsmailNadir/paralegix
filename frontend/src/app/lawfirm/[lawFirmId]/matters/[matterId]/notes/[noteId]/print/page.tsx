"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import mattersService from "@/services/matters.service";
import lawfirmService from "@/services/lawfirm.service";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import { formatHoursMinutes } from "@/lib/utils/format";
import { noteTypeMeta } from "@/constants/statusMeta";

/**
 * A print / export view of a single note.
 *
 * Carries what a record needs, not just the body: the matter it belongs to,
 * who wrote it and when, whether and how it was edited, its time entries and
 * links, and a retraction banner if it has one. Rendered inside
 * `NotePrintPreviewModal`'s iframe, whose own Print button drives
 * `window.print()` - this page itself stays passive so embedding it does not
 * pop the browser's print dialog on load.
 */
export default function NotePrintPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const matterId = (Array.isArray(params?.matterId) ? params.matterId[0] : params?.matterId) || "";
  const noteId = (Array.isArray(params?.noteId) ? params.noteId[0] : params?.noteId) || "";

  const noteQuery = useQuery({
    queryKey: ["note", lawFirmId, matterId, noteId],
    queryFn: () => mattersService.getNote(lawFirmId, matterId, noteId),
    enabled: !!lawFirmId && !!matterId && !!noteId,
  });
  const matterQuery = useQuery({
    queryKey: ["matter", lawFirmId, matterId],
    queryFn: () => mattersService.getMatterById(matterId, lawFirmId),
    enabled: !!lawFirmId && !!matterId,
  });
  const firmQuery = useQuery({
    queryKey: ["lawfirm", lawFirmId],
    queryFn: () => lawfirmService.getLawFirmById(lawFirmId),
    enabled: !!lawFirmId,
  });

  const note = noteQuery.data?.note;
  const ready = !noteQuery.isLoading && !matterQuery.isLoading && !firmQuery.isLoading && !!note;

  if (noteQuery.error) return <ErrorNotification error={noteQuery.error as Error} />;
  if (!ready || !note) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 print:p-0 text-sm text-on-surface">
      <div className="mb-6 pb-4 border-b border-outline-subtle">
        <div className="text-xs text-on-surface-muted uppercase tracking-wide">{firmQuery.data?.name}</div>
        <div className="text-lg font-semibold text-on-surface mt-1">
          {matterQuery.data?.name}
          {matterQuery.data?.matterNumber && (
            <span className="ml-2 text-on-surface-muted font-normal">#{matterQuery.data.matterNumber}</span>
          )}
        </div>
      </div>

      {note.retractedAt && (
        <div className="mb-4 p-3 rounded-md border border-red-300 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/20 dark:text-red-400">
          <div className="font-semibold">Retracted on {dayjs(note.retractedAt).format('MMM D, YYYY [at] h:mm A')}</div>
          {note.retractionReason && <div className="mt-1">{note.retractionReason}</div>}
        </div>
      )}

      <div className="mb-1 text-xs text-on-surface-muted">
        {noteTypeMeta(note.noteType).label} · {dayjs(note.noteDate || note.createdAt).format('MMM D, YYYY')}
      </div>
      {note.subject && <h1 className="text-xl font-semibold text-on-surface mb-2">{note.subject}</h1>}

      <div className="text-xs text-on-surface-muted mb-4">
        <div>By {note.createdByName || 'Unknown'} · Created {dayjs(note.createdAt).format('MMM D, YYYY [at] h:mm A')}</div>
        {note.editedAt && note.editedByName && (
          <div>Last edited by {note.editedByName} on {dayjs(note.editedAt).format('MMM D, YYYY [at] h:mm A')}</div>
        )}
      </div>

      <div
        className="prose prose-sm max-w-none mb-6"
        dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(note.contentHtml || note.content) }}
      />

      {!!note.links?.length && (
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted mb-1">Linked items</div>
          <ul className="list-disc list-inside">
            {note.links.map((link) => (
              <li key={link.id}>
                {link.linkType === 'task' ? (link.taskTitle || 'Untitled task') : (link.fileName || 'Untitled document')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!note.time?.entries.length && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted mb-1">
            Time recorded ({formatHoursMinutes(note.time.totalHours)} total)
          </div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-outline-subtle">
                <th className="py-1 pr-4 font-medium">Date</th>
                <th className="py-1 pr-4 font-medium">Hours</th>
                <th className="py-1 pr-4 font-medium">Activity</th>
                <th className="py-1 font-medium">Billable</th>
              </tr>
            </thead>
            <tbody>
              {note.time.entries.map((entry) => (
                <tr key={entry.id} className="border-b border-outline-subtle/50">
                  <td className="py-1 pr-4">{entry.entryDate ? dayjs(entry.entryDate).format('MMM D, YYYY') : 'N/A'}</td>
                  <td className="py-1 pr-4">{formatHoursMinutes(entry.hours)}</td>
                  <td className="py-1 pr-4">{entry.name || 'N/A'}</td>
                  <td className="py-1">{entry.billable ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
