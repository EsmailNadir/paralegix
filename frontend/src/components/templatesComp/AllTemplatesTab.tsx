"use client";

import { useState } from "react";
import { FileText, Folder, Search, SlidersHorizontal } from "lucide-react";
import type { Template, TemplateFolder } from "@/types/template";
import Dropdown from "@/components/ui/Dropdown";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListToolbar from "@/components/ui/ListToolbar";
import { AutoPager } from "@/components/ui/ListPager";
import SearchInput from "@/components/ui/SearchInput";
import usePagedRows from "@/hooks/usePagedRows";
import { TemplateRow } from "./TemplateItems";
import { folderPathLabel, isFolderWithin } from "./folderPaths";
import Button from "@/components/ui/Button";

type SortKey = "name-asc" | "name-desc" | "newest" | "oldest";

/**
 * Which folder the list is narrowed to: a folder id, `"all"` for every template,
 * or `"none"` for the ones filed in no folder at all.
 */
type FolderFilter = string;

const PER_PAGE = 10;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
];

interface AllTemplatesTabProps {
  templates: Template[];
  folders: TemplateFolder[];
  loading: boolean;
  /** Id of the template whose preview is being fetched, if any. */
  previewLoadingId: string | null;
  onPreview: (template: Template) => void;
  onFill: (template: Template) => void;
  onOpenMenu: (event: React.MouseEvent, template: Template) => void;
}

/**
 * Every template the firm has, as one flat searchable set.
 *
 * The Folders tab is for going to a template whose location is known; this one is
 * for finding a template when it isn't. Everything the firm has is in one list,
 * searchable by name, placeholder, or folder, so nothing is hidden behind
 * navigation. The folder becomes a filter in the toolbar and a line on each item
 * rather than the way through the library.
 */
export default function AllTemplatesTab({
  templates,
  folders,
  loading,
  previewLoadingId,
  onPreview,
  onFill,
  onOpenMenu,
}: AllTemplatesTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  // The library is read newest first by default: the template someone is looking
  // for right after making it is the one at the top.
  const [sort, setSort] = useState<SortKey>("newest");

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));

  // A folder deleted elsewhere would otherwise leave the filter pinned to an id
  // nothing matches, showing an empty library with no visible reason.
  const activeFolderFilter: FolderFilter =
    folderFilter === "all" || folderFilter === "none" || folderById.has(folderFilter)
      ? folderFilter
      : "all";

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const isFiltered = isSearching || activeFolderFilter !== "all";

  const matches = templates.filter((template) => {
    if (activeFolderFilter === "none" && template.folderId) return false;
    if (
      activeFolderFilter !== "all" &&
      activeFolderFilter !== "none" &&
      // Filtering by a folder includes everything filed beneath it, which is what
      // picking a branch of the library is understood to mean.
      !isFolderWithin(folderById, template.folderId, activeFolderFilter)
    ) {
      return false;
    }
    if (!isSearching) return true;

    return [
      template.name,
      ...template.fields,
      template.folderId ? folderPathLabel(folderById, template.folderId) : "",
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  const byName = (left: Template, right: Template) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

  const sorted = [...matches].sort((left, right) => {
    switch (sort) {
      case "name-asc":
        return byName(left, right);
      case "name-desc":
        return byName(right, left);
      case "oldest":
        return (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || byName(left, right);
      default:
        return (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || byName(left, right);
    }
  });

  // The view mode is deliberately not part of the scope: rows and cards draw the
  // same rows at the same count, so swapping between them is a change of shape,
  // not of list, and should leave the reader on the page they were reading.
  const pageScope = `${normalizedQuery}|${activeFolderFilter}|${sort}`;
  const pager = usePagedRows(sorted, PER_PAGE, pageScope);

  const subtitle = (template: Template) => {
    const fieldLabel = `${template.fields.length} field${template.fields.length === 1 ? "" : "s"}`;
    const dateLabel = template.createdAt
      ? new Date(template.createdAt).toLocaleDateString()
      : null;

    return [
      template.folderId ? folderPathLabel(folderById, template.folderId) : null,
      fieldLabel,
      dateLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const itemProps = (template: Template) => ({
    template,
    subtitle: subtitle(template),
    highlight: normalizedQuery,
    previewLoading: previewLoadingId === template.id,
    onPreview: () => onPreview(template),
    onFill: () => onFill(template),
    onOpenMenu: (event: React.MouseEvent) => onOpenMenu(event, template),
  });

  const folderOptions = [
    { value: "all", label: "All folders" },
    { value: "none", label: "No folder" },
    ...folders
      .map((folder) => ({ value: folder.id, label: folderPathLabel(folderById, folder.id) }))
      .sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
      ),
  ];

  if (loading && templates.length === 0) {
    return <ContentSkeleton />;
  }

  if (templates.length === 0) {
    return (
      <ListEmptyState
        icon={<FileText size={40} />}
        title="No templates yet"
        message="Drop a document into the panel above (engagement letter, retainer agreement, standard motion) and mark the parts that change as named placeholders."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ListToolbar>
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
          <SearchInput
            size="sm"
            className="min-w-0 flex-1 2xl:min-w-64"
            placeholder="Search by name, placeholder, or folder..."
            aria-label="Search templates"
            value={searchQuery}
            onChange={(next) => setSearchQuery(next)}
            onClear={() => setSearchQuery("")}
            showClear={isSearching}
          />

          <div className="flex flex-wrap items-center gap-2 2xl:shrink-0">
            {/* Only firms that actually made folders get a folder control. */}
            {folders.length > 0 && (
              <Dropdown
                value={activeFolderFilter}
                onChange={setFolderFilter}
                options={folderOptions}
                ariaLabel="Filter by folder"
                leading={<Folder size={14} className="text-on-surface-muted" />}
                className="w-48"
              />
            )}
            {sorted.length > 0 && (
              <Dropdown
                value={sort}
                onChange={(value) => setSort(value as SortKey)}
                options={SORT_OPTIONS}
                ariaLabel="Sort templates"
                leading={<SlidersHorizontal size={14} className="text-on-surface-muted" />}
                className="w-44"
              />
            )}
          </div>
        </div>

        {isFiltered && (
          <p className="mt-2.5 text-xs text-on-surface-muted">
            {sorted.length} of {templates.length} template
            {templates.length === 1 ? "" : "s"}
            {isSearching && (
              <>
                {" "}
                matching{" "}
                <span className="font-medium text-on-surface">“{searchQuery.trim()}”</span>
              </>
            )}
            {activeFolderFilter === "none"
              ? " filed outside every folder"
              : activeFolderFilter !== "all"
                ? ` in ${folderPathLabel(folderById, activeFolderFilter)}`
                : ""}
          </p>
        )}
      </ListToolbar>

      {sorted.length === 0 ? (
        <ListEmptyState
          compact
          icon={<Search size={36} />}
          title="No templates match"
          message="Try a different name or placeholder, or widen the folder filter."
          action={
            <Button
              type="secondary"
              onClick={() => {
                setSearchQuery("");
                setFolderFilter("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-outline bg-surface">
          <div className="divide-y divide-outline-subtle">
            {pager.pagedRows.map((template) => (
              <TemplateRow key={template.id} {...itemProps(template)} />
            ))}
          </div>
          {pager.total > pager.rowsPerPage && (
            <div className="border-t border-outline-subtle px-4 py-2.5">
              <AutoPager pager={pager} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ContentSkeleton() {
  return (
    <div
      className="divide-y divide-outline-subtle overflow-hidden rounded-xl border border-outline bg-surface"
      aria-hidden="true"
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-surface-alt animate-pulse" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded bg-surface-alt animate-pulse" />
            <div className="h-2.5 w-1/5 rounded bg-surface-alt animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
