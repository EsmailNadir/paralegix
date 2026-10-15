"use client";

import { ChevronRight, Download, FileText, Folder, MoreVertical } from "lucide-react";
import type { Template, TemplateFolder } from "@/types/template";
import Spinner from "@/components/ui/Spinner";

/**
 * How folders and templates are drawn on the templates page.
 *
 * A template is the thing the page exists to produce, so it gets a roomy row.
 * It is a document, so it is drawn like one: the name at reading size, the placeholders
 * it will ask for, and one filled button for the thing anyone came to do. A
 * folder only appears on the Folders tab, where it is one card that opens a
 * level: its own contents are summarised on it rather than expanded in place,
 * because nothing on that tab needs two levels visible at once. Labels are
 * computed by the caller (which knows whether it is showing one folder or the
 * whole library) and handed down.
 */

export interface FolderCardProps {
  folder: TemplateFolder;
  /** Contents summary: "4 templates · 2 subfolders", or "Empty folder". */
  subtitle: string;
  onOpen: () => void;
  onOpenMenu: (event: React.MouseEvent) => void;
}

export interface TemplateItemProps {
  template: Template;
  /** Field/date summary, or the template's location when showing search results. */
  subtitle: string;
  /** Lowercased active search term; matching field chips are highlighted. */
  highlight: string;
  /** True while this template's preview is being fetched. */
  previewLoading: boolean;
  onPreview: () => void;
  onFill: () => void;
  onOpenMenu: (event: React.MouseEvent) => void;
}

const KEBAB_CLS =
  "shrink-0 cursor-pointer rounded-lg border border-input-border p-2 text-on-surface-muted transition-[background-color,border-color,color] hover:bg-surface-hover hover:text-on-surface";

const FILL_CLS =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent-solid px-3.5 py-2 text-xs font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100";

const CHIP_CLS = "rounded-md px-2 py-0.5 text-[11px]";

function TemplateGlyph({ loading }: { loading: boolean }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-emphasis dark:text-accent-emphasis">
      {loading ? <Spinner size={16} /> : <FileText size={18} strokeWidth={2} />}
    </span>
  );
}

function TypeBadge({ template }: { template: Template }) {
  if (template.type !== "docx" && template.type !== "overlay") return null;

  return (
    <span className="shrink-0 rounded border border-outline-subtle bg-surface-alt px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-secondary">
      {template.type === "docx" ? "Docx" : "Overlay"}
    </span>
  );
}

function Kebab({
  label,
  onOpenMenu,
}: {
  label: string;
  onOpenMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-item-menu-trigger
      onClick={(event) => {
        event.stopPropagation();
        onOpenMenu(event);
      }}
      className={KEBAB_CLS}
    >
      <MoreVertical size={16} />
    </button>
  );
}

/**
 * Field placeholders, most relevant first: one matching the active search is the
 * reason the template is on screen, so it is ordered ahead of the rest and shown
 * even when it would fall outside the cap.
 */
function orderedFields(fields: string[], highlight: string) {
  if (!highlight) return fields;

  return [...fields].sort((left, right) => {
    const leftMatch = left.toLowerCase().includes(highlight) ? 0 : 1;
    const rightMatch = right.toLowerCase().includes(highlight) ? 0 : 1;
    return leftMatch - rightMatch;
  });
}

function chipClass(field: string, highlight: string) {
  return `${CHIP_CLS} ${
    highlight && field.toLowerCase().includes(highlight)
      ? "bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis"
      : "bg-surface-alt text-on-surface-secondary"
  }`;
}

/** The placeholders on a row, where there is only one line to spend on them,
 * so they appear only once the viewport is wide enough to hold them. */
function InlineFieldChips({ fields, highlight }: { fields: string[]; highlight: string }) {
  const MAX_CHIPS = 3;

  if (fields.length === 0) return null;

  const ordered = orderedFields(fields, highlight);
  const shown = ordered.slice(0, MAX_CHIPS);
  const hiddenCount = ordered.length - shown.length;

  return (
    <div aria-hidden className="hidden shrink-0 items-center gap-1.5 xl:flex">
      {shown.map((field) => (
        <span key={field} className={`max-w-[9rem] truncate ${chipClass(field, highlight)}`}>
          {field}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span className="text-[11px] text-on-surface-muted">+{hiddenCount}</span>
      )}
    </div>
  );
}

/* --------------------------------- folders --------------------------------- */

/** One folder on the Folders tab: click it to open that level of the library. */
export function FolderCard({ folder, subtitle, onOpen, onOpenMenu }: FolderCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}: ${subtitle}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onOpenMenu}
      className="group flex min-w-0 cursor-pointer items-center gap-3.5 rounded-xl border border-outline bg-surface p-5 transition-colors hover:border-amber-400/70 hover:bg-surface-hover dark:hover:border-amber-500/50"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-500/12 text-amber-500 dark:text-amber-400">
        <Folder size={18} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-on-surface">{folder.name}</p>
        <p className="mt-0.5 truncate text-xs text-on-surface-muted">{subtitle}</p>
      </div>
      <ChevronRight
        size={16}
        className="shrink-0 text-on-surface-muted transition-colors group-hover:text-on-surface"
      />
      <Kebab label={`Actions for ${folder.name}`} onOpenMenu={onOpenMenu} />
    </div>
  );
}

/* -------------------------------- templates -------------------------------- */

export function TemplateRow({
  template,
  subtitle,
  highlight,
  previewLoading,
  onPreview,
  onFill,
  onOpenMenu,
}: TemplateItemProps) {
  return (
    <div
      onClick={previewLoading ? undefined : onPreview}
      onContextMenu={onOpenMenu}
      className={`flex items-center gap-3.5 px-4 py-3.5 transition-colors ${
        previewLoading ? "cursor-wait" : "cursor-pointer hover:bg-surface-hover"
      }`}
    >
      <TemplateGlyph loading={previewLoading} />
      <button
        type="button"
        disabled={previewLoading}
        onClick={(event) => {
          event.stopPropagation();
          onPreview();
        }}
        className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-wait"
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-on-surface">
            {template.name}
          </span>
          <TypeBadge template={template} />
        </span>
        <span className="mt-0.5 block truncate text-xs text-on-surface-muted">{subtitle}</span>
      </button>
      <InlineFieldChips fields={template.fields} highlight={highlight} />
      <button
        type="button"
        // The label collapses below `sm`, so the accessible name is spelled out
        // here rather than left to the visible text.
        aria-label={`Fill ${template.name}`}
        disabled={previewLoading}
        onClick={(event) => {
          event.stopPropagation();
          onFill();
        }}
        className={`${FILL_CLS} disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-accent-solid disabled:active:scale-100`}
      >
        <Download size={14} strokeWidth={2.4} />
        <span className="hidden sm:inline">Fill</span>
      </button>
      <Kebab label={`Actions for ${template.name}`} onOpenMenu={onOpenMenu} />
    </div>
  );
}
