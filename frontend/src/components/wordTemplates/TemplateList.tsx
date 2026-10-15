"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  Clock,
  Download,
  Eye,
  FileText,
  Layers,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { wordTemplatesService } from "@/services/wordTemplates.service";
import type {
  WordTemplate as Template,
  WordTemplateFillDraft as TemplateFillDraft,
} from "@/types/wordTemplate";
// Only mounted when the user opens "Fill" ({fillTarget && ...}), so load its
// ~1.6k LOC on demand instead of shipping it in the template-list chunk.
const FillTemplateModal = dynamic(() => import("./FillTemplateModal"), { ssr: false });
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ActionIconButton from "@/components/ui/ActionIconButton";
import DocumentViewerModal from "@/components/ui/DocumentViewerModal";
import { AutoPager } from "@/components/ui/ListPager";
import Spinner from "@/components/ui/Spinner";
import Tooltip from "@/components/ui/Tooltip";
import usePagedRows from "@/hooks/usePagedRows";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { injectTemplatePreviewStyles } from "@/lib/wordTemplates/template-preview";
import { injectTemplateAssetSources } from "@/lib/wordTemplates/template-image-objects";
import { summarizeFields, type FieldSummary } from "./template-field-summary";
import {
  groupTemplatesByName,
  kindLabel,
  matchesTemplateSearch,
  type TemplateGroup,
  type TemplateSort,
} from "./template-library";
import {
  AutofillRing,
  FieldLegend,
  FieldList,
  FieldStrip,
  PaperThumb,
  TypeNote,
  useSeen,
} from "./template-card-parts";
import "./templates.css";

interface TemplateListProps {
  lawFirmId: string;
  /** Shown above the library: the switch between the three template versions. */
  versionToggle?: ReactNode;
  onNewTemplate: () => void;
  onEditTemplate: (templateId: string, fillDraft?: TemplateFillDraft) => void;
  initialFillTemplateId?: string;
  initialFillDraft?: TemplateFillDraft;
  // The server's DOCX to PDF converter is available: enables the PDF download
  // option and the preview for Word templates.
  converterEnabled?: boolean;
}

const createdTime = (t: Template) => (t.createdAt ? new Date(t.createdAt).getTime() : 0);

function shortDate(value: string | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

type CardHandlers = {
  viewingTemplateId: string | null;
  onFill: (t: Template) => void;
  onPreview: (t: Template) => void;
  onEdit: (id: string) => void;
  onDelete: (t: Template) => void;
  isSearching: boolean;
  query: string;
};

function TemplateActions({ template, h }: { template: Template; h: CardHandlers }) {
  const busyElsewhere = h.viewingTemplateId !== null && h.viewingTemplateId !== template.id;
  return (
    <>
      <Tooltip title="Preview" enterDelay={300}>
        <button
          type="button"
          className="tp-icon-btn"
          aria-label={`Preview ${template.name}`}
          disabled={busyElsewhere}
          onClick={() => h.onPreview(template)}
        >
          {h.viewingTemplateId === template.id ? <Spinner size={16} /> : <Eye aria-hidden />}
        </button>
      </Tooltip>
      <Tooltip title="Edit" enterDelay={300}>
        <button type="button" className="tp-icon-btn" aria-label={`Edit ${template.name}`} onClick={() => h.onEdit(template.id)}>
          <Pencil aria-hidden />
        </button>
      </Tooltip>
      <Tooltip title="Delete" enterDelay={300}>
        <button
          type="button"
          className="tp-icon-btn tp-icon-btn--danger"
          aria-label={`Delete ${template.name}`}
          onClick={() => h.onDelete(template)}
        >
          <Trash2 aria-hidden />
        </button>
      </Tooltip>
    </>
  );
}

function fieldMatches(summary: FieldSummary, query: string) {
  if (!query) return [];
  return summary.fields.filter((f) => [f.label, ...f.tags].some((v) => v.toLowerCase().includes(query)));
}

function TemplateCard({
  group,
  index,
  h,
  fieldsOpen,
  onToggleFields,
  stackOpen,
  onToggleStack,
}: {
  group: TemplateGroup;
  index: number;
  h: CardHandlers;
  fieldsOpen: boolean;
  onToggleFields: () => void;
  stackOpen: boolean;
  onToggleStack: () => void;
}) {
  const [ref, seen] = useSeen<HTMLElement>();
  const latest = group.versions[0];
  const summary = summarizeFields(latest.fields);
  const stack = group.versions.length > 1;
  const matches = h.isSearching ? fieldMatches(summary, h.query) : [];
  const created = shortDate(latest.createdAt);

  return (
    <article
      ref={ref}
      className={`tp-card ${seen ? "tp-in" : ""} ${stack ? "is-stack" : ""}`}
      style={{ "--i": `${Math.min(index, 12) * 0.04}s` } as CSSProperties}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--cx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--cy", `${e.clientY - r.top}px`);
      }}
    >
      <div className="tp-card-top">
        <span className="tp-card-kind tp-badge tp-badge--plain">{kindLabel(latest.type)}</span>
        {stack && <PaperThumb summary={summary} back />}
        <PaperThumb summary={summary} />
        <AutofillRing summary={summary} />
      </div>

      <div className="tp-card-actions-wrap">
        <div className="tp-card-actions">
          <TemplateActions template={latest} h={h} />
        </div>
      </div>

      <div className="tp-card-body">
        <div>
          <Tooltip title={group.name} enterDelay={300}>
            <h3 className="tp-card-name">{group.name}</h3>
          </Tooltip>
          <div className="tp-card-meta">
            {created && <span>{created}</span>}
            {summary.total > 0 && (
              <>
                {created && <i className="dot" aria-hidden />}
                <span>
                  {summary.total} field{summary.total === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>

        <FieldStrip summary={summary} />
        {summary.total > 0 && <FieldLegend summary={summary} />}
        <TypeNote summary={summary} />

        {matches.length > 0 && (
          <p className="tp-match">
            Matches field{matches.length === 1 ? "" : "s"}:
            {matches.slice(0, 3).map((m) => (
              <mark key={m.label}>{m.label}</mark>
            ))}
            {matches.length > 3 ? `+${matches.length - 3}` : null}
          </p>
        )}

        <FieldList
          id={`fields-${group.key}`}
          summary={summary}
          open={fieldsOpen}
          onToggle={onToggleFields}
          highlight={h.isSearching ? h.query : undefined}
        />

        {stack && stackOpen && (
          <div className="tp-versions" id={`versions-${group.key}`}>
            {group.versions.map((v, i) => {
              const vs = summarizeFields(v.fields);
              return (
                <div key={v.id} className="tp-version" style={{ "--i": `${i * 0.04}s` } as CSSProperties}>
                  <span>
                    <b>{shortDate(v.createdAt) ?? "Undated"}</b>
                    <small>
                      {i === 0 ? "Newest · " : ""}
                      {kindLabel(v.type)} · {vs.total} field{vs.total === 1 ? "" : "s"}
                    </small>
                  </span>
                  <span className="tp-version-actions">
                    <TemplateActions template={v} h={h} />
                  </span>
                  <button type="button" className="tp-btn tp-btn--ghost" style={{ height: 28 }} onClick={() => h.onFill(v)}>
                    Fill
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="tp-card-foot">
          <button type="button" className="tp-btn tp-btn--primary tp-btn--block" onClick={() => h.onFill(latest)}>
            <Download aria-hidden /> Fill &amp; Download
          </button>
          {stack && (
            <Tooltip title="Templates with the same name" enterDelay={300}>
              <button
                type="button"
                className="tp-btn tp-btn--ghost"
                aria-expanded={stackOpen}
                aria-controls={`versions-${group.key}`}
                aria-label={`${group.versions.length} templates named ${group.name}`}
                onClick={onToggleStack}
              >
                <Layers aria-hidden /> {group.versions.length}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </article>
  );
}

function TemplateRow({
  group,
  index,
  h,
  stackOpen,
  onToggleStack,
}: {
  group: TemplateGroup;
  index: number;
  h: CardHandlers;
  stackOpen: boolean;
  onToggleStack: () => void;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const rows = stackOpen ? group.versions : group.versions.slice(0, 1);
  return (
    <div ref={ref} className={seen ? "tp-in" : ""}>
      {rows.map((t, i) => {
        const s = summarizeFields(t.fields);
        return (
          <div key={t.id} className="tp-row" style={{ "--i": `${Math.min(index + i, 14) * 0.03}s` } as CSSProperties}>
            <div className="tp-row-name">
              <FileText aria-hidden />
              <Tooltip title={t.name} enterDelay={300}>
                <b>{i === 0 ? group.name : "↳ Older, same name"}</b>
              </Tooltip>
              {i === 0 && group.versions.length > 1 && (
                <button
                  type="button"
                  className="tp-badge"
                  style={{ border: 0, cursor: "pointer" }}
                  aria-expanded={stackOpen}
                  aria-label={`${group.versions.length} templates named ${group.name}`}
                  onClick={onToggleStack}
                >
                  <Layers size={12} aria-hidden /> {group.versions.length}
                </button>
              )}
              <span className="tp-row-type">{kindLabel(t.type)}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <FieldStrip summary={s} />
              <span className="tp-row-type">
                {s.total === 0 ? "No fields" : s.typeCount === 0 ? "All fields auto-fill" : `You type ${s.typeCount} of ${s.total}`}
              </span>
            </div>
            <span className="tp-row-type">
              {s.autoCount}/{s.total} auto
            </span>
            <span className="tp-row-type">{shortDate(t.createdAt) ?? "Undated"}</span>
            <div className="tp-row-actions">
              <TemplateActions template={t} h={h} />
              <button type="button" className="tp-btn tp-btn--primary" onClick={() => h.onFill(t)}>
                <Download aria-hidden /> Fill
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="tp-grid" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="tp-skel" style={{ height: 300 }} />
      ))}
    </div>
  );
}

type PreviewContent = { kind: "html" | "pdf"; url: string };

/**
 * The template as it will look filled. A web template's HTML runs in an
 * opaque-origin frame with only scripts allowed, so the reflow script that
 * shifts grown paragraphs can run while the markup cannot reach the app. A Word
 * template's converted PDF is our own file and opens in the browser's viewer,
 * which a sandbox would block.
 */
function TemplatePreviewDialog({
  content,
  name,
  onClose,
}: {
  content: PreviewContent | null;
  name: string;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <DocumentViewerModal presentation="template" isOpen={Boolean(content)} onClose={onClose} labelledBy={titleId}>
      <div className="flex shrink-0 items-center justify-between border-b border-outline px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-on-surface">
          {name ? `${name} Preview` : "Template Preview"}
        </h2>
        <ActionIconButton label="Close preview" onClick={onClose}>
          <X size={16} />
        </ActionIconButton>
      </div>
      <div className="min-h-0 flex-1">
        {content && (
          <iframe
            src={content.url}
            className="h-full w-full border-0"
            title="Template Preview"
            sandbox={content.kind === "html" ? "allow-scripts" : undefined}
          />
        )}
      </div>
    </DocumentViewerModal>
  );
}

// The template library: every template in one searchable list, as cards or rows.
export default function TemplateList({
  lawFirmId,
  versionToggle,
  onNewTemplate,
  onEditTemplate,
  initialFillTemplateId,
  initialFillDraft,
  converterEnabled = false,
}: TemplateListProps) {
  const queryClient = useQueryClient();
  const [fillTarget, setFillTarget] = useState<Template | null>(null);
  // The fill form keeps its template while it animates out.
  const fillRenderRef = useRef<Template | null>(null);
  if (fillTarget) fillRenderRef.current = fillTarget;
  const fillRender = fillTarget ?? fillRenderRef.current;
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The target stays on screen while the confirm dialog animates out.
  useResetAfterClose(deleteOpen, () => setDeleteTarget(null));
  const [deleting, setDeleting] = useState(false);
  const [viewingTemplateId, setViewingTemplateId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<PreviewContent | null>(null);
  const [previewTemplateName, setPreviewTemplateName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<TemplateSort>("recent");
  const [openFields, setOpenFields] = useState<string | null>(null);
  const [openStacks, setOpenStacks] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: templates = [], isLoading } = useQuery<Template[]>({
    queryKey: ["templates", lawFirmId],
    queryFn: () => wordTemplatesService.list(lawFirmId),
    enabled: !!lawFirmId,
  });

  const autoOpenedFillRef = useRef(false);
  useEffect(() => {
    if (!initialFillTemplateId || autoOpenedFillRef.current || isLoading) return;
    const t = templates.find((t) => t.id === initialFillTemplateId);
    if (t) {
      autoOpenedFillRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time auto-open driven by async-loaded query data (templates) once loading settles, guarded by a ref; not a pure prop sync
      setFillTarget(t);
    }
  }, [initialFillTemplateId, templates, isLoading]);

  const initialLoading = isLoading && templates.length === 0;
  const trimmedSearchQuery = searchQuery.trim();
  const normalizedSearchQuery = trimmedSearchQuery.toLowerCase();
  const isSearching = normalizedSearchQuery.length > 0;

  const shownTemplates = isSearching
    ? templates.filter((template) => matchesTemplateSearch(template, normalizedSearchQuery))
    : templates;

  // Firm-wide list that grows without bound, so it pages. Same-name templates
  // stack into one card, so the pager pages stacks; a new search or sort goes
  // back to page 1.
  const templateGroups = groupTemplatesByName(shownTemplates, sort);
  const templatePager = usePagedRows(templateGroups, 12, `${normalizedSearchQuery}\n${sort}`);

  // "/" focuses search from anywhere on the page (not while typing elsewhere).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Library-wide share of fields that auto-fill, and the three newest
  // templates for the header's paper fan.
  const libraryTotals = templates
    .map((t) => summarizeFields(t.fields))
    .reduce((acc, s) => ({ total: acc.total + s.total, auto: acc.auto + s.autoCount }), { total: 0, auto: 0 });
  const libraryAutoPct =
    libraryTotals.total > 0 ? Math.round((libraryTotals.auto / libraryTotals.total) * 100) : null;
  const heroSheets = [...templates]
    .sort((a, b) => createdTime(b) - createdTime(a))
    .slice(0, 3)
    .map((t) => summarizeFields(t.fields));
  while (heroSheets.length < 3) heroSheets.push(summarizeFields(["firm_name", "case_number"]));

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      await wordTemplatesService.delete(lawFirmId, deleteTarget.id);
      const deletedId = deleteTarget.id;
      setDeleteOpen(false);
      queryClient.setQueryData<Template[]>(
        ["templates", lawFirmId],
        (old) => old?.filter((t) => t.id !== deletedId) ?? []
      );
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete template."));
    } finally {
      setDeleting(false);
    }
  };

  const showPreview = (next: PreviewContent, name: string) => {
    setPreviewTemplateName(name);
    setPreviewContent((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return next;
    });
  };

  const handleViewTemplate = async (template: Template) => {
    setViewingTemplateId(template.id);
    setError(null);

    try {
      const fullTemplate = await wordTemplatesService.getById(lawFirmId, template.id);
      if (!fullTemplate.html) {
        // DOCX template: preview the real document rendered to PDF by the
        // server's converter. When the converter is off, preview is dormant.
        if (!converterEnabled) {
          setError("Preview is not available for DOCX templates.");
          return;
        }
        const pdf = await wordTemplatesService.previewPdf(lawFirmId, template.id);
        showPreview({ kind: "pdf", url: URL.createObjectURL(pdf) }, template.name);
        return;
      }
      const assetPreviewUrls = Object.fromEntries(
        (fullTemplate.assets ?? [])
          .filter((asset) => Boolean(asset.previewUrl))
          .map((asset) => [asset.id, asset.previewUrl as string])
      );
      const previewHtml = injectTemplatePreviewStyles(
        injectTemplateAssetSources(fullTemplate.html, assetPreviewUrls),
        `${template.name} Template`
      );
      const previewBlob = new Blob([previewHtml], { type: "text/html" });
      showPreview({ kind: "html", url: URL.createObjectURL(previewBlob) }, template.name);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to open template preview."));
    } finally {
      setViewingTemplateId((current) => (current === template.id ? null : current));
    }
  };

  const closeTemplatePreview = () => {
    setPreviewContent((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  };

  useEffect(() => {
    return () => {
      if (previewContent) {
        URL.revokeObjectURL(previewContent.url);
      }
    };
  }, [previewContent]);

  const cardHandlers: CardHandlers = {
    viewingTemplateId,
    onFill: (t) => setFillTarget(t),
    onPreview: handleViewTemplate,
    onEdit: (id) => onEditTemplate(id),
    onDelete: (t) => {
      setDeleteTarget(t);
      setDeleteOpen(true);
    },
    isSearching,
    query: normalizedSearchQuery,
  };

  const toggleStack = (key: string) =>
    setOpenStacks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const stackedCount = shownTemplates.length - templateGroups.length;

  return (
    <div className="tp">
      <div className="tp-wrap">
        {versionToggle && <div className="flex justify-end">{versionToggle}</div>}
        <header className="tp-hero">
          <div>
            <p className="tp-eyebrow">Document templates</p>
            <h1 className="tp-title">Templates</h1>
            <p className="tp-hero-sub">
              Pick a template, pick a matter, and the document fills itself in. You only type what the matter
              doesn&apos;t already know.
            </p>
            <div className="tp-hero-actions">
              <button type="button" className="tp-btn tp-btn--primary" onClick={() => onNewTemplate()}>
                <Plus aria-hidden /> New template
              </button>
            </div>
            {!initialLoading && (
              <div className="tp-hero-stats">
                <span>
                  <b>{templates.length}</b>template{templates.length === 1 ? "" : "s"}
                </span>
                {libraryAutoPct !== null && (
                  <Tooltip title="Share of all template fields that fill in from the matter, client, court, or firm" enterDelay={300}>
                    <span>
                      <b>{libraryAutoPct}%</b>of fields auto-fill
                    </span>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
          <div className="tp-fan" aria-hidden>
            {heroSheets.map((summary, i) => (
              <PaperThumb key={i} summary={summary} />
            ))}
          </div>
        </header>

        <div className="tp-bar">
          <div className="tp-search">
            <Search aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchQuery("");
              }}
              aria-label="Search templates"
              placeholder="Search templates or fields like “case number”"
            />
            <span className="tp-search-end">
              {isSearching ? (
                <button type="button" className="tp-icon-btn" aria-label="Clear search" onClick={() => setSearchQuery("")}>
                  <X aria-hidden />
                </button>
              ) : (
                <span className="tp-kbd" aria-hidden>
                  /
                </span>
              )}
            </span>
          </div>

          <div className="tp-seg" role="group" aria-label="Sort">
            <button type="button" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>
              <Clock aria-hidden /> Recent
            </button>
            <button type="button" aria-pressed={sort === "name"} onClick={() => setSort("name")}>
              <ArrowDownAZ aria-hidden /> A–Z
            </button>
          </div>
          <div className="tp-seg" role="group" aria-label="Layout">
            <Tooltip title="Grid" enterDelay={300}>
              <button type="button" aria-pressed={view === "grid"} aria-label="Grid" onClick={() => setView("grid")}>
                <LayoutGrid aria-hidden />
              </button>
            </Tooltip>
            <Tooltip title="List" enterDelay={300}>
              <button type="button" aria-pressed={view === "list"} aria-label="List" onClick={() => setView("list")}>
                <List aria-hidden />
              </button>
            </Tooltip>
          </div>

          {isSearching && (
            <p className="tp-bar-note" aria-live="polite">
              <b>{shownTemplates.length}</b> {shownTemplates.length === 1 ? "template matches" : "templates match"} “{trimmedSearchQuery}”.
            </p>
          )}
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        {initialLoading ? (
          <LibrarySkeleton />
        ) : isSearching && shownTemplates.length === 0 ? (
          <div className="tp-empty">
            <div className="tp-fan" aria-hidden>
              <PaperThumb summary={summarizeFields([])} />
            </div>
            <h3>Nothing matches “{trimmedSearchQuery}”</h3>
            <p>Try a template name or a field in plain words, like “judge”, “firm phone” or “hearing date”.</p>
            <button type="button" className="tp-btn tp-btn--ghost" onClick={() => setSearchQuery("")}>
              Clear search
            </button>
          </div>
        ) : templates.length === 0 ? (
          <div className="tp-empty">
            <div className="tp-fan" aria-hidden>
              <PaperThumb summary={summarizeFields(["firm_name", "case_number", "court_name"])} />
              <PaperThumb summary={summarizeFields(["client_name", "hearing_date"])} />
              <PaperThumb summary={summarizeFields(["firm_phone", "judge_name"])} />
            </div>
            <h3>Start your template library</h3>
            <p>
              Upload a Word document or fillable PDF. Names like “Case No.” become fields that fill themselves from a
              matter.
            </p>
            <button type="button" className="tp-btn tp-btn--primary" onClick={() => onNewTemplate()}>
              <Plus aria-hidden /> New template
            </button>
          </div>
        ) : (
          <section aria-labelledby="tp-templates-h">
            <div className="tp-section-head">
              <h2 id="tp-templates-h">{isSearching ? "Matching templates" : "All templates"}</h2>
              <span>
                {shownTemplates.length} template{shownTemplates.length === 1 ? "" : "s"}
                {stackedCount > 0 ? ` · ${stackedCount} stacked under a shared name` : ""}
              </span>
            </div>

            {view === "grid" ? (
              <div className="tp-grid">
                {templatePager.pagedRows.map((group, i) => (
                  <TemplateCard
                    key={group.key}
                    group={group}
                    index={i}
                    h={cardHandlers}
                    fieldsOpen={openFields === group.key}
                    onToggleFields={() => setOpenFields((cur) => (cur === group.key ? null : group.key))}
                    stackOpen={openStacks.has(group.key)}
                    onToggleStack={() => toggleStack(group.key)}
                  />
                ))}
              </div>
            ) : (
              <div className="tp-list">
                <div className="tp-list-head">
                  <span>Name</span>
                  <span>Fields</span>
                  <span>Auto-fill</span>
                  <span>Created</span>
                  <span style={{ textAlign: "right" }}>Actions</span>
                </div>
                {templatePager.pagedRows.map((group, i) => (
                  <TemplateRow
                    key={group.key}
                    group={group}
                    index={i}
                    h={cardHandlers}
                    stackOpen={openStacks.has(group.key)}
                    onToggleStack={() => toggleStack(group.key)}
                  />
                ))}
              </div>
            )}

            {templatePager.totalPages > 1 && (
              <div style={{ marginTop: 16 }}>
                <AutoPager pager={templatePager} />
              </div>
            )}
          </section>
        )}
      </div>

      {fillRender && (
        <FillTemplateModal
          open={Boolean(fillTarget)}
          template={fillRender}
          lawFirmId={lawFirmId}
          converterEnabled={converterEnabled}
          onClose={() => setFillTarget(null)}
          onEdit={(templateId, fillDraft) => {
            setFillTarget(null);
            onEditTemplate(templateId, fillDraft);
          }}
          initialValues={fillRender.id === initialFillTemplateId ? initialFillDraft?.values : undefined}
          initialRepeaterValues={fillRender.id === initialFillTemplateId ? initialFillDraft?.repeaterValues : undefined}
          initialSelectedCaseId={fillRender.id === initialFillTemplateId ? initialFillDraft?.selectedCaseId : undefined}
          initialSelectedClientId={fillRender.id === initialFillTemplateId ? initialFillDraft?.selectedClientId : undefined}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen={deleteOpen}
          title="Delete template"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmText="Delete"
          confirmType="danger"
          loading={deleting}
          onConfirm={handleDelete}
          onClose={() => setDeleteOpen(false)}
        />
      )}

      <TemplatePreviewDialog content={previewContent} name={previewTemplateName} onClose={closeTemplatePreview} />
    </div>
  );
}
