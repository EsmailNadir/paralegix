"use client";

import { CheckSquare, Paperclip, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { useNavigation } from "@/contexts/NavigationContext";
import type { NoteLink } from "@/types/note";

interface NoteLinksRowProps {
  links: NoteLink[];
  lawFirmId: string;
  canUnlink: boolean;
  onUnlink: (link: NoteLink) => void;
}

/**
 * Tasks and documents connected to a note: created from it, or picked from an
 * existing list. Rendered under the note body whenever it has at least one
 * link; a link created from the note (rather than linked to an existing one)
 * carries the "Created from this note" or "Created from a reply" suffix.
 */
export default function NoteLinksRow({ links, lawFirmId, canUnlink, onUnlink }: NoteLinksRowProps) {
  const { navigate } = useNavigation();
  if (!links.length) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.map((link) => {
        const isTask = link.linkType === 'task';
        const label = isTask ? (link.taskTitle || 'Untitled task') : (link.fileName || 'Untitled document');
        const suffix = link.createdFromNote
          ? (link.replyId ? 'Created from a reply' : 'Created from this note')
          : null;
        return (
          <span
            key={link.id}
            className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full text-xs font-medium border border-outline bg-surface-alt text-on-surface-secondary"
          >
            <button
              type="button"
              onClick={() => isTask && navigate(`/lawfirm/${lawFirmId}/tasks/${link.taskId}`)}
              className={`inline-flex items-center gap-1 ${isTask ? 'cursor-pointer hover:text-on-surface' : ''}`}
              disabled={!isTask}
            >
              {isTask ? <CheckSquare size={12} /> : <Paperclip size={12} />}
              {label}
            </button>
            {suffix && <span className="text-on-surface-muted">· {suffix}</span>}
            {canUnlink && (
              <Tooltip title="Remove link" enterDelay={300}>
                <button
                  type="button"
                  aria-label="Remove link"
                  onClick={() => onUnlink(link)}
                  className="p-0.5 rounded-full hover:bg-surface-hover cursor-pointer"
                >
                  <X size={11} />
                </button>
              </Tooltip>
            )}
          </span>
        );
      })}
    </div>
  );
}
