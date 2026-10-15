"use client";

import { Briefcase } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import type { ConversationMatter } from "@/types/message";

interface ConversationMatterTagsProps {
  matters?: ConversationMatter[] | null;
  // How many chips to show before collapsing the rest into a "+N" counter.
  max?: number;
  className?: string;
}

// Small inline chips naming the matter(s) a conversation is linked to. Renders
// nothing when the thread isn't scoped to any matter (direct threads, or a group
// with no matter tag), so callers can drop it in unconditionally.
export default function ConversationMatterTags({ matters, max = 2, className = "" }: ConversationMatterTagsProps) {
  if (!matters || matters.length === 0) return null;
  const shown = matters.slice(0, max);
  const extra = matters.length - shown.length;

  return (
    <div className={`flex items-center gap-1 flex-wrap ${className}`}>
      {shown.map((m) => {
        // Prefer the matter number when set (compact + unique); fall back to the
        // name. The full name always rides along as a hover tooltip.
        const label = m.matterNumber || m.name || "Matter";
        return (
          <Tooltip key={m.id} title={m.name || m.matterNumber || ""} enterDelay={300}>
            {/* Capped so a numberless matter's name can use the row it sits in
                rather than clipping at a width narrower than the row, and never
                wider than that row on a narrow list. */}
            <span className="inline-flex items-center gap-1 max-w-[min(220px,100%)] overflow-hidden rounded-md bg-accent-soft text-accent-emphasis dark:text-accent-emphasis px-1.5 py-0.5 text-[10px] font-medium">
              <Briefcase size={10} className="shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          </Tooltip>
        );
      })}
      {extra > 0 && <span className="text-[10px] text-on-surface-muted">+{extra}</span>}
    </div>
  );
}
