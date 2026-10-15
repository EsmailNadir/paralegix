"use client";

import {
  ChevronRight,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Home,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import type { Template, TemplateFolder } from "@/types/template";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListToolbar from "@/components/ui/ListToolbar";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import { FolderCard, TemplateRow } from "./TemplateItems";
import { buildFolderPath, groupFoldersByParent } from "./folderPaths";
import Button from "@/components/ui/Button";

// The templates here page at the same count as the flat library on the other tab,
// so the same set of documents never has two different page lengths. The folder
// grid pages at a multiple of its widest column count, so a page fills whole rows.
const TEMPLATES_PER_PAGE = 10;
const FOLDERS_PER_PAGE = 12;

interface FoldersTabProps {
  templates: Template[];
  folders: TemplateFolder[];
  /** True until both lists are in, since either can be what the level shows. */
  loading: boolean;
  /** The folder being browsed; null is the top level. */
  folderId: string | null;
  onNavigate: (folderId: string | null) => void;
  onCreateFolder: (parentFolderId: string | null) => void;
  onOpenFolderMenu: (event: React.MouseEvent, folder: TemplateFolder) => void;
  /** Id of the template whose preview is being fetched, if any. */
  previewLoadingId: string | null;
  onPreview: (template: Template) => void;
  onFill: (template: Template) => void;
  onOpenTemplateMenu: (event: React.MouseEvent, template: Template) => void;
}

/**
 * The library as folders, one level at a time.
 *
 * A level is two labelled blocks: the folders inside it, then the templates filed
 * directly in it - subfolders and templates as peers on one screen, which is what
 * browsing a folder means, without the permanent tree the page used to spend a
 * quarter of its width on. Both blocks carry the same heading shape, because a
 * list of templates appearing under a grid of folders with only one of the two
 * named reads as a continuation of the grid rather than a separate group.
 *
 * Folders are optional, so a firm that never made one gets this level without the
 * folder block at all: the whole library, with the toolbar's New folder button as
 * the only sign the feature exists.
 */
export default function FoldersTab({
  templates,
  folders,
  loading,
  folderId,
  onNavigate,
  onCreateFolder,
  onOpenFolderMenu,
  previewLoadingId,
  onPreview,
  onFill,
  onOpenTemplateMenu,
}: FoldersTabProps) {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParent = groupFoldersByParent(folders);

  const subfolders = childrenByParent.get(folderId) ?? [];
  const openFolderName = folderId ? folderById.get(folderId)?.name ?? "this folder" : null;
  // Newest first, so a template just added to this level is the first row rather
  // than wherever its name happens to fall. Names break ties, which is what the
  // rows with no creation date on them fall back to.
  const inFolder = templates
    .filter((template) => (template.folderId ?? null) === folderId)
    .sort((left, right) => {
      const byCreated = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
      if (byCreated !== 0) return byCreated;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  // Both blocks restart at the top when the level changes, since a different level
  // is a different set of folders and a different set of templates.
  const folderPager = usePagedRows(subfolders, FOLDERS_PER_PAGE, folderId ?? "");
  const pager = usePagedRows(inFolder, TEMPLATES_PER_PAGE, folderId ?? "");

  const describeContents = (folder: TemplateFolder) => {
    const childCount = childrenByParent.get(folder.id)?.length ?? 0;
    const templateCount = templates.filter(
      (template) => template.folderId === folder.id
    ).length;

    if (childCount === 0 && templateCount === 0) return "Empty folder";

    return [
      templateCount > 0
        ? `${templateCount} template${templateCount === 1 ? "" : "s"}`
        : null,
      childCount > 0 ? `${childCount} subfolder${childCount === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  // What the template block is showing, which changes with where the user is
  // standing: the qualifier is the answer to "why isn't the whole library here".
  const templatesHint = folderId
    ? subfolders.length > 0
      ? `Filed in ${openFolderName} itself, not in its subfolders.`
      : `Filed in ${openFolderName}.`
    : folders.length === 0
      ? "Every template the firm has. None are in a folder yet."
      : "Templates in no folder at all. The rest are inside the folders above.";

  if (loading && folders.length === 0 && templates.length === 0) {
    return <ListSkeleton rows={4} label="Loading folders" />;
  }

  if (folders.length === 0 && templates.length === 0) {
    return (
      <ListEmptyState
        icon={<FolderOpen size={40} />}
        title="Nothing in the library yet"
        message="Drop a document into the panel above to build the first template. Folders are optional, add them once there are enough templates to group by practice area, client, or matter type."
        action={
          <Button
            type="secondary"
            onClick={() => onCreateFolder(null)}
            icon={<FolderPlus size={15} />}
          >
            New folder
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <ListToolbar>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Breadcrumb
            path={buildFolderPath(folderById, folderId)}
            onNavigate={onNavigate}
          />
          <Button
            type="secondary"
            size="compact"
            onClick={() => onCreateFolder(folderId)}
            icon={<FolderPlus size={14} strokeWidth={2.2} />}
          >
            {folderId ? "New subfolder" : "New folder"}
          </Button>
        </div>
      </ListToolbar>

      {subfolders.length > 0 && (
        <section>
          <SectionLabel
            icon={FolderTree}
            label={folderId ? "Subfolders" : "Folders"}
            count={subfolders.length}
            hint="Open one to see what is filed inside."
          />
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {folderPager.pagedRows.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  subtitle={describeContents(folder)}
                  onOpen={() => onNavigate(folder.id)}
                  onOpenMenu={(event) => onOpenFolderMenu(event, folder)}
                />
              ))}
            </div>
            <AutoPager pager={folderPager} />
          </div>
        </section>
      )}

      <section>
        <SectionLabel
          icon={FileText}
          label="Templates"
          count={inFolder.length}
          hint={templatesHint}
        />

        {inFolder.length === 0 ? (
          <ListEmptyState
            compact
            title="Nothing here yet"
            message={
              subfolders.length > 0
                ? "Open a folder above to see what is in it."
                : "Move a template in from its menu on the All templates tab."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-outline bg-surface">
            <div className="divide-y divide-outline-subtle">
              {pager.pagedRows.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  subtitle={`${template.fields.length} field${
                    template.fields.length === 1 ? "" : "s"
                  }`}
                  highlight=""
                  previewLoading={previewLoadingId === template.id}
                  onPreview={() => onPreview(template)}
                  onFill={() => onFill(template)}
                  onOpenMenu={(event) => onOpenTemplateMenu(event, template)}
                />
              ))}
            </div>
            {pager.total > pager.rowsPerPage && (
              <div className="border-t border-outline-subtle px-4 py-2.5">
                <AutoPager pager={pager} />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The heading over one block of a folder level.
 *
 * The count says how much is in the block and the hint says what the block is
 * scoped to, both on the heading's own line - a qualifier stacked underneath sat
 * between the two blocks and read as belonging to neither.
 */
function SectionLabel({
  icon: Icon,
  label,
  count,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <h3 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-on-surface">
        <Icon size={14} strokeWidth={2} className="text-on-surface-muted" />
        {label}
        {count > 0 && (
          <span className="rounded-full bg-surface-alt px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-muted">
            {count}
          </span>
        )}
      </h3>
      <p className="min-w-0 text-xs text-on-surface-muted">{hint}</p>
    </div>
  );
}

/** The path to the open folder, collapsed in the middle when it runs long. */
function Breadcrumb({
  path,
  onNavigate,
}: {
  path: TemplateFolder[];
  onNavigate: (folderId: string | null) => void;
}) {
  // Only the last two folders are named once a path runs deep; the tooltip on the
  // ellipsis spells the whole path out.
  const collapsed = path.length > 3;
  const shown = collapsed ? path.slice(-2) : path;
  const crumbClass = (active: boolean) =>
    `cursor-pointer truncate rounded px-1 py-0.5 transition-colors ${
      active ? "font-semibold text-on-surface" : "hover:text-on-surface"
    }`;

  return (
    <nav
      aria-label="Folder path"
      className="flex min-w-0 flex-1 items-center gap-1 text-sm text-on-surface-muted"
    >
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className={`${crumbClass(path.length === 0)} inline-flex items-center gap-1.5`}
      >
        <Home size={14} className="shrink-0" />
        All folders
      </button>
      {collapsed && (
        <>
          <ChevronRight size={13} className="shrink-0" />
          <Tooltip title={path.map((folder) => folder.name).join(" / ")} enterDelay={300}>
            <span className="shrink-0 px-0.5">…</span>
          </Tooltip>
        </>
      )}
      {shown.map((folder, index) => (
        <span key={folder.id} className="flex min-w-0 items-center gap-1">
          <ChevronRight size={13} className="shrink-0" />
          <button
            type="button"
            onClick={() => onNavigate(folder.id)}
            className={crumbClass(index === shown.length - 1)}
          >
            {folder.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
