"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  Calendar,
  CheckSquare,
  ImageIcon,
  MousePointer2,
  PenLine,
  Plus,
  Repeat,
  Save,
  TextCursorInput,
  Trash2,
  Type,
} from "lucide-react";
import PDFPageViewer from "@/components/signaturesComp/PDFPageViewer";
import { usePdfFontSample } from "./usePdfFontSample";
import ScrollArea from "@/components/ui/ScrollArea";
import ZoomControls from "@/components/ui/ZoomControls";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import Spinner from "@/components/ui/Spinner";
import { useDocumentZoom } from "@/hooks/useDocumentZoom";
import { templatesService } from "@/services/templates.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type {
  TemplateFieldPlacement,
  TemplateFieldPlacementInput,
  TemplateFieldPlacementType,
  TemplateOverlayRepeaterInput,
  TemplateRepeater,
  TemplateRichTextBlock,
  TemplateWithHtml,
} from "@/types/template";
import PlaceholderModal from "./PlaceholderModal";
import TemplateSaveLayoutModal from "./TemplateSaveLayoutModal";
import TemplateOverlayFieldBox, { type OverlayTextBoxHandle } from "./TemplateOverlayFieldBox";
import TemplateOverlayFormattingBar from "./TemplateOverlayFormattingBar";
import {
  clampPlacementBox,
  defaultPlacementSize,
  DEFAULT_PLACEMENT_STYLE,
  initialTextboxContent,
  richTextPlainLabel,
  duplicatePlacement,
  fitPlacementToPage,
  genPlacementId,
  NUDGE_STEP_LARGE_PERCENT,
  NUDGE_STEP_PERCENT,
  nudgePlacement,
  placementReducer,
  repeaterAnchor,
  splitLongRichTextRuns,
  type PlacementDraft,
  type PlacementStyleDraft,
  type RepeaterDraft,
} from "./templateOverlayTypes";
import { useOverlayLayoutHistory, type LayoutSnapshot } from "./useOverlayLayoutHistory";

const NEW_REPEATER = "__new__";

/** Fixed number of rows a repeater fits on its anchor page before the fill
 *  path continues it onto a copy of that page. Not user-configurable: three
 *  is enough for the canvas to show "this repeats" without cluttering the
 *  preview, and the actual row count at fill time is unlimited regardless
 *  of this number (see FillTemplateModal's "Add Row"). */
const DEFAULT_ROWS_PER_PAGE = 3;

const TYPE_OPTIONS: { type: TemplateFieldPlacementType; label: string; icon: typeof Type }[] = [
  { type: "text", label: "Text", icon: Type },
  { type: "date", label: "Date", icon: Calendar },
  { type: "checkbox", label: "Checkbox", icon: CheckSquare },
];

// A repeater column can additionally be a rich text box (mixed bold/italic/
// color, bullets, inline field chips, see TemplateOverlayFieldBox.tsx),
// unlike a standalone placement, which already has its own dedicated
// "Text box" tool and instant-edit flow; offering it again in Field mode's
// type picker too would just be a second, redundant path to the same thing.
const REPEATER_TYPE_OPTIONS: typeof TYPE_OPTIONS = [
  ...TYPE_OPTIONS,
  { type: "textbox", label: "Text box", icon: TextCursorInput },
];

type EditorMode = "select" | "field" | "repeater" | "textbox" | "image";

interface PendingBox {
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  /** The confirmed `repeaterName` this box will be saved under, or null for
   *  a standalone field, or for the first column of a brand-new repeater
   *  whose name the picker modal itself collects (see isNewRepeater). */
  repeaterKey: string | null;
  /** True only for a brand-new repeater's first column: the picker modal
   *  shows an editable "Repeater name" field instead of a read-only
   *  "Repeater: X" badge, and its typed value becomes both the new
   *  repeater's name and the prefix stripped off the modal's dotted return
   *  value to recover the bare column name `overlayFill.service.ts` looks
   *  values up by. */
  isNewRepeater: boolean;
}

/** Where a new image placement will land once a file has been picked from
 *  the OS dialog. Can't be a repeater column, so this carries no repeater
 *  key unlike `PendingBox`. */
interface PendingSimpleBox {
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

function toPlacementDraft(p: TemplateFieldPlacement): PlacementDraft {
  return {
    id: p.id,
    fieldName: p.fieldName,
    fieldType: p.fieldType,
    page: p.page,
    xPercent: p.xPercent,
    yPercent: p.yPercent,
    widthPercent: p.widthPercent,
    heightPercent: p.heightPercent,
    repeaterName: p.repeaterName,
    repeaterRowIndex: p.repeaterRowIndex,
    sortOrder: p.sortOrder,
    textContent: p.textContent ?? null,
    richText: p.richText ?? null,
    imageObjectPath: p.imageObjectPath ?? null,
    imageMimeType: p.imageMimeType ?? null,
    imagePreviewUrl: p.imagePreviewUrl ?? null,
    fontSize: p.fontSize ?? null,
    fontFamily: p.fontFamily ?? DEFAULT_PLACEMENT_STYLE.fontFamily,
    bold: p.bold ?? false,
    italic: p.italic ?? false,
    color: p.color ?? DEFAULT_PLACEMENT_STYLE.color,
    textAlign: p.textAlign ?? DEFAULT_PLACEMENT_STYLE.textAlign,
    bulletList: p.bulletList ?? false,
  };
}

/** A short, human-meaningful auto-name for a static (textbox/image)
 *  placement: these never appear in the "Fields:" merge-field strip, so the
 *  name is only ever seen in the box's own selected-toolbar label. */
function autoFieldName(prefix: string, source: string) {
  const trimmed = source.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 40) : prefix;
}

/** The longest text a text box can save with, the server's own limit. */
const TEXT_BOX_MAX_CHARS = 2000;

/** Whether a text box holds anything to print: non-blank text, or at least
 *  one field chip, matching the server's check for a 'textbox' placement. */
function textBoxHasContent(p: PlacementDraft) {
  return Boolean(p.richText?.some((block) => block.runs.some((run) => run.fieldName || run.text.trim())));
}

function uniqueOrdered(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

interface TemplateOverlayEditorProps {
  lawFirmId: string;
  /** An overlay template's row exists from the moment its source file is
   *  uploaded (`upload-overlay` creates it so the editor has something to
   *  render), unlike html/docx which stay unsaved until Save, so this is
   *  always known, never optional the way `TemplateEditor`'s is. */
  templateId: string;
  onSaved: () => void;
  onBack: () => void;
  onReady?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Offered only right after upload, before anything has been saved: bails
   *  out of the overlay flow into the existing full-editor creation path
   *  with the same uploaded file. Absent when reopening an already-saved
   *  overlay template, since there is nothing left to bail out of. */
  onUseFullEditor?: () => void;
}

/**
 * Document Overlay authoring: a real PDF rendered read-only via
 * `PDFPageViewer`, with field and repeater-column boxes placed on top of it
 * as page-relative percentages. Adapts `signaturesComp/PDFPageViewer` +
 * `SignatureFieldPlacer`'s drag/resize/select mechanics for a different kind
 * of box (a merge field instead of a signer's field), and reuses
 * `PlaceholderModal` for naming one exactly as `TemplateEditor` does for its
 * placeholder chips.
 */
export default function TemplateOverlayEditor({
  lawFirmId,
  templateId,
  onSaved,
  onBack,
  onReady,
  onDirtyChange,
  onUseFullEditor,
}: TemplateOverlayEditorProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`, which the toolbar's actions share: a failed load
  // leaves no canvas and no toolbar, so it is the whole screen's state.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<TemplateWithHtml | null>(null);
  const [pdfFile, setPdfFile] = useState<{ url: string; bytes: Uint8Array } | null>(null);

  const [state, dispatch] = useReducer(placementReducer, { placements: [], selectedId: null });
  const [repeaters, setRepeaters] = useState<RepeaterDraft[]>([]);
  // The last-saved fields/repeaters, exactly as `TemplateEditor`'s own used-
  // fields strip reads `templates.fields`/`templates.repeaters` rather than
  // re-deriving from live content. Overlay's placements are only ever
  // authoritative server-side once saved, so this starts empty and is
  // refreshed from each save response.
  const [savedFields, setSavedFields] = useState<string[]>([]);
  const [savedRepeaters, setSavedRepeaters] = useState<TemplateRepeater[]>([]);

  const [dirty, setDirty] = useState(false);
  const markDirty = useCallback(() => setDirty(true), []);

  const restoreSnapshot = useCallback((snapshot: LayoutSnapshot) => {
    dispatch({ type: "REPLACE_ALL", placements: snapshot.placements });
    setRepeaters(snapshot.repeaters);
    markDirty();
  }, [markDirty]);
  const history = useOverlayLayoutHistory({ placements: state.placements, repeaters }, restoreSnapshot);
  const { checkpoint, reset: resetHistory } = history;

  // The size the selected box's text really renders at, reported by the box
  // itself (it owns the fit), keyed by id so a stale report from a box that
  // is no longer selected is never shown against another one.
  const [fitted, setFitted] = useState<{ id: string; size: number | null } | null>(null);

  const [mode, setMode] = useState<EditorMode>("select");
  // The viewer only draws a text layer in Select mode, so there is nothing to
  // sample in any of the drawing modes and a readout left over from the last
  // one would be describing text the reader can no longer highlight.
  const fontSample = usePdfFontSample(mode === "select");
  const [fieldType, setFieldType] = useState<TemplateFieldPlacementType>("text");
  const [repeaterTarget, setRepeaterTarget] = useState<string>(NEW_REPEATER);
  const [deleteRepeaterTarget, setDeleteRepeaterTarget] = useState<string | null>(null);
  const [confirmBailOpen, setConfirmBailOpen] = useState(false);

  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Every mounted box registers its imperative handle here by id (a plain
  // ref callback per box, not one shared ref conditionally handed to
  // whichever is selected: React doesn't guarantee attach/detach ordering
  // across sibling elements, so looking the active id up in a persistent map
  // is the only way that's safe against the previously-selected box's
  // detach running AFTER the newly-selected one's attach). The persistent
  // top toolbar reads the SELECTED box's handle through it to route bold/
  // italic/color/bullet at whatever's currently focused inside that box.
  const boxHandlesRef = useRef<Map<string, OverlayTextBoxHandle>>(new Map());
  const getEditingBoxHandle = useCallback(
    () => (state.selectedId ? boxHandlesRef.current.get(state.selectedId) ?? null : null),
    [state.selectedId]
  );
  const [richFormat, setRichFormat] = useState<{ bold: boolean; italic: boolean; color: string; bulletActive: boolean } | null>(null);

  const [saveModalOpen, setSaveModalOpen] = useState(false);

  // Image: `pendingImageBox` holds the drawn position for a NEW placement
  // while the file dialog is open; `replaceImageTargetId` holds an existing
  // placement's id when swapping its image instead. The hidden <input> is
  // shared by both flows since only one can be in progress at a time.
  const [pendingImageBox, setPendingImageBox] = useState<PendingSimpleBox | null>(null);
  const [replaceImageTargetId, setReplaceImageTargetId] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom();

  // Clears the full-screen "opening editor" overlay the host shows while
  // this mounts; this component's own `loading` spinner takes over from
  // there, the same split `TemplateEditor` uses.
  useEffect(() => { onReady?.(); }, [onReady]);

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  // Reports only on an actual dirty transition, through the ref, so a new
  // `onDirtyChange` identity from a host re-render cannot re-push this
  // component's local `dirty` back up. The host clears its own flag to leave
  // the editor, and re-pushing `true` after that would make it think there is
  // still unsaved work and re-ask the discard question forever.
  useEffect(() => { onDirtyChangeRef.current?.(dirty); }, [dirty]);

  // Leaving the editor (by any exit, including "Use the full editor
  // instead") cannot leave the host still guarding against work that is no
  // longer on screen, matching `TemplateEditor`'s own cleanup for the same
  // reason: without this, a dirty overlay session that bails into a fresh
  // `TemplateEditor` would carry a stale "unsaved changes" flag into it.
  useEffect(() => () => { onDirtyChangeRef.current?.(false); }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch effect: sets loading/error state from an async load of the template and its placements
    setLoading(true);
    setError(null);
    setLoadError(null);

    (async () => {
      try {
        const [full, placements] = await Promise.all([
          templatesService.getById(lawFirmId, templateId),
          templatesService.listPlacements(lawFirmId, templateId),
        ]);
        if (cancelled) return;
        if (!full.overlayPdfUrl) {
          throw new Error("This template has no overlay document to render.");
        }

        // Fetched as bytes rather than handed to react-pdf as the signed URL
        // directly, matching PDFPageViewer's own documented reason: pdf.js
        // renders reliably from bytes it holds, and a blob/network source of
        // its own is what React Strict Mode's dev double-mount can abort.
        const res = await fetch(full.overlayPdfUrl);
        if (!res.ok) throw new Error("Failed to load the overlay document.");
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        setTemplate(full);
        setPdfFile({ url: full.overlayPdfUrl, bytes: new Uint8Array(buffer) });
        // fitPlacementToPage trims any box an older save left running off
        // the page, which the server would now refuse on the next save.
        dispatch({
          type: "REPLACE_ALL",
          placements: placements.map((placement) => fitPlacementToPage(toPlacementDraft(placement))),
        });
        setRepeaters(
          (full.repeaters ?? []).map((r) => ({
            name: r.name,
            rowHeightPercent: r.rowHeightPercent ?? 6,
            rowCount: r.rowCount ?? 1,
          }))
        );
        setSavedFields(full.fields ?? []);
        setSavedRepeaters(full.repeaters ?? []);
        setDirty(false);
        resetHistory();
      } catch (err) {
        if (!cancelled) setLoadError(getErrorMessage(err, "Failed to load the overlay document."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [lawFirmId, templateId, resetHistory, loadAttempt]);

  const handlePageClick = useCallback(
    (page: number, xPercent: number, yPercent: number, widthPercent?: number, heightPercent?: number) => {
      if (mode === "select") return;

      if (mode === "textbox") {
        const size = defaultPlacementSize("textbox");
        const box = clampPlacementBox(xPercent, yPercent, widthPercent ?? size.widthPercent, heightPercent ?? size.heightPercent);
        const id = genPlacementId();
        checkpoint();
        dispatch({
          type: "ADD",
          placement: {
            id,
            fieldName: "Text",
            fieldType: "textbox",
            page,
            xPercent: box.xPercent,
            yPercent: box.yPercent,
            widthPercent: box.widthPercent,
            heightPercent: box.heightPercent,
            repeaterName: null,
            repeaterRowIndex: null,
            sortOrder: state.placements.length,
            textContent: null,
            richText: initialTextboxContent(DEFAULT_PLACEMENT_STYLE),
            imageObjectPath: null,
            imageMimeType: null,
            imagePreviewUrl: null,
            ...DEFAULT_PLACEMENT_STYLE,
          },
        });
        // Placing a text box immediately selects it (unlike every other ADD,
        // which leaves nothing selected): its whole point is "place it and
        // type into it", and TemplateOverlayFieldBox renders a selected,
        // empty textbox as a focused, ready-to-type textarea.
        dispatch({ type: "SELECT", id });
        markDirty();
        return;
      }

      if (mode === "image") {
        const size = defaultPlacementSize("image");
        const box = clampPlacementBox(xPercent, yPercent, widthPercent ?? size.widthPercent, heightPercent ?? size.heightPercent);
        setPendingImageBox({ page, ...box });
        // Triggered from inside the same synchronous user gesture (the click
        // that reached PDFPageViewer's pointer handler), so the browser still
        // treats this as user-initiated and opens the native file dialog.
        imageInputRef.current?.click();
        return;
      }

      const size = defaultPlacementSize(fieldType);
      const box = clampPlacementBox(xPercent, yPercent, widthPercent ?? size.widthPercent, heightPercent ?? size.heightPercent);

      if (mode === "field") {
        setPendingBox({ page, ...box, repeaterKey: null, isNewRepeater: false });
        setPickerOpen(true);
        return;
      }

      // mode === "repeater"
      if (repeaterTarget === NEW_REPEATER) {
        setPendingBox({ page, ...box, repeaterKey: null, isNewRepeater: true });
      } else {
        // The target repeater's row height may already be smaller than this
        // field type's default box height (e.g. shrunk by an earlier column,
        // see updateRepeater's auto-shrink), so a new column drawn at the
        // default height would stick out past its own row and overlap the
        // one below it.
        const targetRowHeight = repeaters.find((r) => r.name === repeaterTarget)?.rowHeightPercent;
        const clampedBox = targetRowHeight != null && box.heightPercent > targetRowHeight
          ? { ...box, heightPercent: targetRowHeight }
          : box;
        setPendingBox({ page, ...clampedBox, repeaterKey: repeaterTarget, isNewRepeater: false });
      }
      setPickerOpen(true);
    },
    [mode, fieldType, repeaterTarget, repeaters, state.placements.length, markDirty, checkpoint]
  );

  // Naming a brand-new repeater happens in the same modal as naming its
  // first column (an editable field above "Field ID", see PlaceholderModal's
  // `newRepeater` prop) rather than a separate "New repeater: N column(s)
  // drawn..." bar shown afterward: one step instead of two, and no window
  // where a placement's repeaterName points at an unconfirmed draft.
  const handlePickerInsert = useCallback(
    (rawName: string, newRepeaterName?: string) => {
      if (!pendingBox) return;

      if (pendingBox.isNewRepeater) {
        const name = (newRepeaterName ?? "").trim();
        if (!name) return;
        if (repeaters.some((r) => r.name === name)) {
          setError(`A repeater named "${name}" already exists.`);
          setPendingBox(null);
          setPickerOpen(false);
          return;
        }
        const fieldName = rawName.slice(name.length + 1);
        const id = genPlacementId();
        checkpoint();
        dispatch({
          type: "ADD",
          placement: {
            id,
            fieldName,
            fieldType,
            page: pendingBox.page,
            xPercent: pendingBox.xPercent,
            yPercent: pendingBox.yPercent,
            widthPercent: pendingBox.widthPercent,
            heightPercent: pendingBox.heightPercent,
            repeaterName: name,
            repeaterRowIndex: 0,
            sortOrder: state.placements.length,
            textContent: null,
            richText: fieldType === "textbox" ? initialTextboxContent(DEFAULT_PLACEMENT_STYLE) : null,
            imageObjectPath: null,
            imageMimeType: null,
            imagePreviewUrl: null,
            ...DEFAULT_PLACEMENT_STYLE,
          },
        });
        setRepeaters((prev) => [
          ...prev,
          { name, rowHeightPercent: Math.round(pendingBox.heightPercent * 100) / 100, rowCount: DEFAULT_ROWS_PER_PAGE },
        ]);
        setRepeaterTarget(name);
        // A repeater's textbox column is edited in place (rich content, not a
        // Field ID), so placing one drops straight into typing, matching the
        // standalone Text box tool's own instant-edit flow.
        if (fieldType === "textbox") dispatch({ type: "SELECT", id });
        markDirty();
        setPendingBox(null);
        setPickerOpen(false);
        return;
      }

      const fieldName = pendingBox.repeaterKey
        ? rawName.slice(pendingBox.repeaterKey.length + 1)
        : rawName;

      // Two columns of the same repeater sharing a fieldName isn't rejected
      // anywhere downstream: the backend dedupes a repeater's `fields` list
      // by name, so both boxes would silently resolve to the same value at
      // fill time instead of the two independent ones a user typing the same
      // name twice by mistake almost certainly meant to place.
      if (pendingBox.repeaterKey) {
        const duplicate = state.placements.some(
          (p) => p.repeaterName === pendingBox.repeaterKey && p.fieldName === fieldName
        );
        if (duplicate) {
          setError(`This repeater already has a column named "${fieldName}". Draw the column again with a different name.`);
          setPendingBox(null);
          setPickerOpen(false);
          return;
        }
      }

      const id = genPlacementId();
      checkpoint();
      dispatch({
        type: "ADD",
        placement: {
          id,
          fieldName,
          fieldType,
          page: pendingBox.page,
          xPercent: pendingBox.xPercent,
          yPercent: pendingBox.yPercent,
          widthPercent: pendingBox.widthPercent,
          heightPercent: pendingBox.heightPercent,
          repeaterName: pendingBox.repeaterKey,
          repeaterRowIndex: pendingBox.repeaterKey ? 0 : null,
          sortOrder: state.placements.length,
          textContent: null,
          richText: fieldType === "textbox" ? initialTextboxContent(DEFAULT_PLACEMENT_STYLE) : null,
          imageObjectPath: null,
          imageMimeType: null,
          imagePreviewUrl: null,
          ...DEFAULT_PLACEMENT_STYLE,
        },
      });
      // A repeater's textbox column is edited in place (rich content, not a
      // Field ID), so placing one drops straight into typing, matching the
      // standalone Text box tool's own instant-edit flow.
      if (fieldType === "textbox" && pendingBox.repeaterKey) dispatch({ type: "SELECT", id });
      markDirty();
      setPendingBox(null);
      setPickerOpen(false);
    },
    [pendingBox, fieldType, state.placements, repeaters, markDirty, checkpoint]
  );

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPendingBox(null);
  }, []);

  const handleRichTextChange = useCallback(
    (id: string, richText: TemplateRichTextBlock[]) => {
      dispatch({ type: "SET_RICH_TEXT", id, richText });
      markDirty();
    },
    [markDirty]
  );

  // ── image ───────────────────────────────────────────────────────────

  const handleImageFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      // Reset so picking the same file again still fires onChange.
      e.target.value = "";
      const box = pendingImageBox;
      const targetId = replaceImageTargetId;
      setPendingImageBox(null);
      setReplaceImageTargetId(null);
      if (!file || (!box && !targetId)) return;

      setImageUploading(true);
      try {
        const uploaded = await templatesService.uploadPlacementImage(lawFirmId, templateId, file);
        checkpoint();
        if (targetId) {
          dispatch({
            type: "SET_IMAGE",
            id: targetId,
            imageObjectPath: uploaded.imageObjectPath,
            imageMimeType: uploaded.imageMimeType,
            imagePreviewUrl: uploaded.imagePreviewUrl,
          });
        } else if (box) {
          dispatch({
            type: "ADD",
            placement: {
              id: genPlacementId(),
              fieldName: autoFieldName("Image", file.name.replace(/\.[^.]+$/, "")),
              fieldType: "image",
              page: box.page,
              xPercent: box.xPercent,
              yPercent: box.yPercent,
              widthPercent: box.widthPercent,
              heightPercent: box.heightPercent,
              repeaterName: null,
              repeaterRowIndex: null,
              sortOrder: state.placements.length,
              textContent: null,
              richText: null,
              imageObjectPath: uploaded.imageObjectPath,
              imageMimeType: uploaded.imageMimeType,
              imagePreviewUrl: uploaded.imagePreviewUrl,
              ...DEFAULT_PLACEMENT_STYLE,
            },
          });
        }
        markDirty();
      } catch (err) {
        setError(getErrorMessage(err, "Failed to upload the image."));
      } finally {
        setImageUploading(false);
      }
    },
    [pendingImageBox, replaceImageTargetId, lawFirmId, templateId, state.placements.length, markDirty, checkpoint]
  );

  const handleReplaceImage = useCallback((placementId: string) => {
    setReplaceImageTargetId(placementId);
    imageInputRef.current?.click();
  }, []);

  // A repeater with no columns left fails the backend's save validation, so
  // dropping the last column of a named repeater drops the repeater entry
  // too, the moment it happens, not deferred to save time.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derives repeaters from live placements so a column deleted elsewhere in the same render still drops its now-empty repeater
    setRepeaters((prev) => prev.filter((r) => state.placements.some((p) => p.repeaterName === r.name)));
  }, [state.placements]);

  // A column taller than its repeater's row height overlaps the row below it
  // (row height is the vertical gap between rows, not derived from column
  // height). updateRepeater() enforces this live when the row height itself
  // changes, but a column added later at its field type's default height can
  // still end up taller than an already-set row height, and a layout saved
  // before that guard existed can load with the same mismatch. Repair both by
  // shrinking any offending column down to its row's height whenever the
  // repeater list or the placements change.
  useEffect(() => {
    for (const r of repeaters) {
      const oversized = state.placements.filter((p) => p.repeaterName === r.name && p.heightPercent > r.rowHeightPercent);
      oversized.forEach((p) => dispatch({ type: "RESIZE", id: p.id, widthPercent: p.widthPercent, heightPercent: r.rowHeightPercent }));
    }
  }, [repeaters, state.placements]);

  const updateRepeater = (name: string, changes: Partial<RepeaterDraft>) => {
    // Coalesced: the row-height spinner fires once per step, and a run of
    // steps is one edit to step back over.
    checkpoint(`repeater:${name}`);
    setRepeaters((prev) => prev.map((r) => (r.name === name ? { ...r, ...changes } : r)));
    // Row height is spacing between rows, not the columns' own height. Those
    // are two independent numbers, so shrinking one to bring rows closer
    // together did nothing to the boxes themselves, which just started
    // overlapping the row below once it moved closer than their own height.
    // Bringing a column's height down to fit is the only way "closer" doesn't
    // also mean "overlapping"; only ever shrinks, never grows one back out to
    // a size the user may have deliberately chosen for other reasons.
    if (changes.rowHeightPercent != null) {
      const cap = changes.rowHeightPercent;
      state.placements
        .filter((p) => p.repeaterName === name && p.heightPercent > cap)
        .forEach((p) => dispatch({ type: "RESIZE", id: p.id, widthPercent: p.widthPercent, heightPercent: cap }));
    }
    markDirty();
  };

  // Guide rows: always DEFAULT_ROWS_PER_PAGE evenly-spaced translucent
  // previews of the authored row below it, recomputed from the live
  // placements so moving or resizing a column updates them immediately.
  // A row that would spill past the anchor page's bottom edge is not
  // previewed here: the fill path continues it onto a copy of the page,
  // which this editor has no reason to synthesize while authoring.
  const guideBoxesByPage = useMemo(() => {
    const map = new Map<number, { key: string; placement: PlacementDraft }[]>();
    for (const r of repeaters) {
      const anchor = repeaterAnchor(state.placements, r.name);
      if (!anchor) continue;
      const columns = state.placements.filter((p) => p.repeaterName === r.name);
      const maxHeight = Math.max(...columns.map((c) => c.heightPercent));
      for (let i = 1; i < DEFAULT_ROWS_PER_PAGE; i += 1) {
        const yPercent = anchor.anchorYPercent + i * r.rowHeightPercent;
        if (yPercent + maxHeight > 100) break;
        const list = map.get(anchor.anchorPage) ?? [];
        for (const col of columns) {
          list.push({ key: `${col.id}_guide_${i}`, placement: { ...col, id: `${col.id}_guide_${i}`, yPercent } });
        }
        map.set(anchor.anchorPage, list);
      }
    }
    return map;
  }, [repeaters, state.placements]);

  // "Save layout" is validated up front and, only once it would actually
  // succeed, hands off to TemplateSaveLayoutModal to confirm (or change) the
  // template's name before the real save runs, so a doomed save never pops
  // the modal just to fail behind it.
  const handleSaveClick = () => {
    setError(null);

    const confirmedNames = new Set(repeaters.map((r) => r.name));
    if (state.placements.some((p) => p.repeaterName && !confirmedNames.has(p.repeaterName))) {
      setError("Finish naming the repeater you are drawing (or cancel it) before saving.");
      return;
    }
    if (state.placements.length === 0) {
      setError("Place at least one field before saving.");
      return;
    }
    // The server refuses the whole layout over one bad text box, so the box
    // is picked out here instead, the same rule its save validation applies.
    const emptyTextBox = state.placements.find((p) => p.fieldType === "textbox" && !textBoxHasContent(p));
    if (emptyTextBox) {
      dispatch({ type: "SELECT", id: emptyTextBox.id });
      setError("This text box is empty. Type something into it or delete it before saving.");
      return;
    }
    const longTextBox = state.placements.find((p) => p.fieldType === "textbox" && richTextPlainLabel(p.richText ?? []).length > TEXT_BOX_MAX_CHARS);
    if (longTextBox) {
      dispatch({ type: "SELECT", id: longTextBox.id });
      setError(`This text box has more than ${TEXT_BOX_MAX_CHARS.toLocaleString("en-US")} characters. Shorten it before saving.`);
      return;
    }

    setSaveModalOpen(true);
  };

  const handleConfirmSave = async (name: string) => {
    setError(null);
    setSaving(true);
    try {
      if (name !== template?.name) {
        await templatesService.renameTemplate(lawFirmId, templateId, name);
        setTemplate((prev) => (prev ? { ...prev, name } : prev));
      }

      const placementsPayload: TemplateFieldPlacementInput[] = state.placements.map((p, index) => ({
        fieldName: p.fieldName,
        fieldType: p.fieldType,
        page: p.page,
        xPercent: p.xPercent,
        yPercent: p.yPercent,
        widthPercent: p.widthPercent,
        heightPercent: p.heightPercent,
        repeaterName: p.repeaterName,
        repeaterRowIndex: p.repeaterName ? 0 : null,
        sortOrder: index,
        textContent: p.fieldType === "textbox" ? null : p.textContent,
        richText: p.richText ? splitLongRichTextRuns(p.richText) : p.richText,
        imageObjectPath: p.imageObjectPath,
        imageMimeType: p.imageMimeType,
        fontSize: p.fontSize,
        fontFamily: p.fontFamily,
        bold: p.bold,
        italic: p.italic,
        color: p.color,
        textAlign: p.textAlign,
        bulletList: p.fieldType === "textbox" ? false : p.bulletList,
      }));
      const repeatersPayload: TemplateOverlayRepeaterInput[] = repeaters.map((r) => {
        const anchor = repeaterAnchor(state.placements, r.name);
        return {
          name: r.name,
          anchorPage: anchor?.anchorPage ?? 1,
          anchorYPercent: anchor?.anchorYPercent ?? 0,
          rowHeightPercent: r.rowHeightPercent,
          rowCount: r.rowCount,
        };
      });

      const result = await templatesService.savePlacements(lawFirmId, templateId, {
        placements: placementsPayload,
        repeaters: repeatersPayload,
      });

      dispatch({ type: "REPLACE_ALL", placements: result.placements.map(toPlacementDraft) });
      setRepeaters(result.repeaters.map((r) => ({
        name: r.name,
        rowHeightPercent: r.rowHeightPercent ?? 6,
        rowCount: r.rowCount ?? 1,
      })));
      // The server derives the fillable list (it also counts the field chips
      // inside text boxes); the placement-only derivation is a fallback for
      // a response without it.
      setSavedFields(result.fields ?? uniqueOrdered(
        result.placements
          .filter((p) => !p.repeaterName && p.fieldType !== "textbox" && p.fieldType !== "image")
          .map((p) => p.fieldName)
      ));
      setSavedRepeaters(result.repeaters);
      setDirty(false);
      resetHistory();
      setSaveModalOpen(false);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save the document layout."));
    } finally {
      setSaving(false);
    }
  };

  const handleUseFullEditorClick = () => {
    if (state.placements.length > 0) { setConfirmBailOpen(true); return; }
    onUseFullEditor?.();
  };

  const selectedPlacement = state.selectedId
    ? state.placements.find((p) => p.id === state.selectedId) ?? null
    : null;
  const selectedStyle: PlacementStyleDraft | null =
    selectedPlacement
    && (selectedPlacement.fieldType === "text" || selectedPlacement.fieldType === "date" || selectedPlacement.fieldType === "textbox")
      ? selectedPlacement
      : null;
  const richEditingSelected = Boolean(selectedPlacement && selectedPlacement.fieldType === "textbox");

  const handleSelectedStyleChange = useCallback(
    (style: Partial<PlacementStyleDraft>) => {
      if (!state.selectedId) return;
      // Coalesced: the color picker reports every pixel of a drag as a change.
      checkpoint(`style:${state.selectedId}`);
      dispatch({ type: "SET_STYLE", id: state.selectedId, style });
      markDirty();
    },
    [state.selectedId, markDirty, checkpoint]
  );

  // Sets the selected box to the font read off the document. A property the
  // sample is mixed on (null) is left as it was. Weight and slant are only
  // applied as whole-box style; a text box being edited carries them per run,
  // and the reader sets those with the bold and italic buttons.
  const handleMatchSample = useCallback(() => {
    const sample = fontSample.sample;
    if (!sample || !selectedStyle) return;
    const next: Partial<PlacementStyleDraft> = {};
    if (sample.family) next.fontFamily = sample.family;
    if (sample.sizePt != null) next.fontSize = sample.sizePt;
    if (!richEditingSelected) {
      if (sample.bold != null) next.bold = sample.bold;
      if (sample.italic != null) next.italic = sample.italic;
    }
    if (Object.keys(next).length === 0) return;
    handleSelectedStyleChange(next);
  }, [fontSample.sample, selectedStyle, richEditingSelected, handleSelectedStyleChange]);

  const deleteSelected = useCallback(() => {
    if (!state.selectedId) return;
    checkpoint();
    dispatch({ type: "DELETE", id: state.selectedId });
    markDirty();
  }, [state.selectedId, checkpoint, markDirty]);

  const duplicateSelected = useCallback(() => {
    const selected = state.placements.find((p) => p.id === state.selectedId);
    if (!selected) return;
    if (selected.repeaterName) {
      setError("A repeater column cannot be duplicated: draw a new column and give it its own name.");
      return;
    }
    const copy = duplicatePlacement(selected, state.placements.length);
    checkpoint();
    dispatch({ type: "ADD", placement: copy });
    dispatch({ type: "SELECT", id: copy.id });
    markDirty();
  }, [state.placements, state.selectedId, checkpoint, markDirty]);

  const nudgeSelected = useCallback((dx: number, dy: number) => {
    const selected = state.placements.find((p) => p.id === state.selectedId);
    if (!selected) return;
    // Coalesced: holding an arrow key is one move, not one per repeat.
    checkpoint(`nudge:${selected.id}`);
    const next = nudgePlacement(selected, dx, dy);
    dispatch({ type: "MOVE", id: selected.id, xPercent: next.xPercent, yPercent: next.yPercent });
    markDirty();
  }, [state.placements, state.selectedId, checkpoint, markDirty]);

  // Keyboard editing of the canvas. Nothing here fires while the reader is
  // typing somewhere (an input, the row-height spinner, a text box's own
  // editable content) or while a dialog is open: those own their keys, and
  // Backspace inside a text box must delete a character, not the box.
  const modalOpen = pickerOpen || saveModalOpen || confirmBailOpen || Boolean(deleteRepeaterTarget);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalOpen) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || target.closest('[contenteditable="true"]') || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) history.redo(); else history.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        history.redo();
        return;
      }
      if (meta && event.key.toLowerCase() === "d") {
        if (!state.selectedId) return;
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (meta || event.altKey) return;

      if (event.key === "Escape") {
        if (state.selectedId) dispatch({ type: "SELECT", id: null });
        return;
      }
      if (!state.selectedId) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
        return;
      }
      const step = event.shiftKey ? NUDGE_STEP_LARGE_PERCENT : NUDGE_STEP_PERCENT;
      const nudge: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const delta = nudge[event.key];
      if (!delta) return;
      event.preventDefault();
      nudgeSelected(delta[0], delta[1]);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, state.selectedId, history, duplicateSelected, deleteSelected, nudgeSelected]);

  // A textbox column's own OTHER already-drawn sibling columns in the same
  // repeater (text/date/checkbox only: those are the only ones with a
  // single flat per-row value; another rich textbox column has no value of
  // its own to reference, only its own runs), offered by the "+ Field"
  // popover ahead of the global auto-fill catalog. Same set savePlacements
  // computes into repeaters[].fields server-side.
  const siblingFieldNamesFor = useCallback(
    (p: PlacementDraft) =>
      p.repeaterName
        ? state.placements
            .filter((sibling) =>
              sibling.repeaterName === p.repeaterName
              && sibling.id !== p.id
              && (sibling.fieldType === "text" || sibling.fieldType === "date" || sibling.fieldType === "checkbox"))
            .map((sibling) => sibling.fieldName)
        : [],
    [state.placements]
  );

  const richEditing = richEditingSelected;
  const handleRichPrepare = useCallback(() => {
    getEditingBoxHandle()?.saveSelection();
  }, [getEditingBoxHandle]);
  const handleRichCommand = useCallback(
    (command: "bold" | "italic" | "foreColor" | "bullet", value?: string) => {
      const handle = getEditingBoxHandle();
      if (!handle) return;
      if (command === "bullet") handle.toggleBullet();
      else handle.runCommand(command, value);
      setRichFormat(handle.getSelectionFormat());
      markDirty();
    },
    [getEditingBoxHandle, markDirty]
  );

  const toolButtonCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
      active ? "bg-accent-solid text-accent-foreground border-accent-solid" : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
    }`;

  // "Text box" is only ever an offered type pill in Repeater mode (Field
  // mode's picker can't show or clear it), so leaving it selected while
  // switching to a mode that can't represent it would silently draw a
  // mismatched box next time; reset to the default instead.
  const handleSetMode = (next: EditorMode) => {
    if (next !== "repeater" && fieldType === "textbox") setFieldType("text");
    setMode(next);
  };

  return (
    <div className="h-screen bg-page overflow-hidden flex flex-col">
      <div className="p-4 pl-5 md:p-6 w-full max-w-[1600px] mx-auto min-w-0 flex flex-col gap-y-4 flex-1 overflow-hidden">
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={32} className="text-accent-emphasis" />
          </div>
        )}

        {!loading && (
          <>
            {loadError && !pdfFile && (
              <>
                <div className="flex items-center">
                  <button type="button" onClick={onBack} className={`shrink-0 ${toolButtonCls(false)}`}>
                    <ArrowLeft size={13} /> Back
                  </button>
                </div>
                <ErrorNotification error={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
              </>
            )}

            <ErrorNotification error={error} onClose={() => setError(null)} />

            {pdfFile && (
              <div className="rounded-lg border border-outline overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="border-b border-outline bg-white dark:bg-surface-alt shadow-sm shrink-0">
                  <div className="px-3 py-2 border-b border-outline/70">
                    <div className="flex h-9 items-center gap-2 flex-nowrap overflow-x-auto overflow-y-hidden styled-scrollbar">
                      <button type="button" onClick={onBack} className={`shrink-0 ${toolButtonCls(false)}`}>
                        <ArrowLeft size={13} /> Back
                      </button>
                      <div className="h-5 w-px bg-outline shrink-0" />
                      <span
                        title={template?.name}
                        className="shrink-0 text-sm font-semibold text-on-surface truncate max-w-[220px] px-2 py-0.5 rounded-md bg-surface-alt"
                      >
                        {template?.name}
                      </span>

                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        {onUseFullEditor && (
                          <button type="button" onClick={handleUseFullEditorClick} className={toolButtonCls(false)}>
                            <PenLine size={13} /> Use the full editor
                            <span className="inline-flex items-center rounded-full bg-accent-soft dark:bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent-emphasis">
                              Beta
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleSaveClick}
                          disabled={saving}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          <Save size={13} />
                          Save layout
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* The mode buttons are always present, so this row always has real
                      content at a constant height; the type pills and repeater
                      dropdown just add to it when relevant instead of it ever being
                      the only thing here, so there's nothing to collapse to. */}
                  <div className="px-3 py-2 border-b border-outline/70">
                    <div className="flex h-9 items-center gap-2 flex-nowrap overflow-x-auto overflow-y-hidden styled-scrollbar">
                      <button type="button" onClick={() => handleSetMode("select")} className={`shrink-0 ${toolButtonCls(mode === "select")}`}>
                        <MousePointer2 size={13} /> Select
                      </button>
                      <button type="button" onClick={() => handleSetMode("field")} className={`shrink-0 ${toolButtonCls(mode === "field")}`}>
                        <Plus size={13} /> Field
                      </button>
                      <button type="button" onClick={() => handleSetMode("repeater")} className={`shrink-0 ${toolButtonCls(mode === "repeater")}`}>
                        <Repeat size={13} /> Repeater
                      </button>
                      <button type="button" onClick={() => handleSetMode("textbox")} className={`shrink-0 ${toolButtonCls(mode === "textbox")}`}>
                        <TextCursorInput size={13} /> Text box
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSetMode("image")}
                        disabled={imageUploading}
                        className={`shrink-0 ${toolButtonCls(mode === "image")} disabled:opacity-50`}
                      >
                        {imageUploading ? <Spinner size={13} /> : <ImageIcon size={13} />} Image
                      </button>

                      {(mode === "field" || mode === "repeater") && (
                        <>
                          <div className="h-5 w-px bg-outline shrink-0" />
                          <div className="flex items-center rounded-lg bg-surface-alt p-1 gap-0.5 shrink-0">
                            {(mode === "repeater" ? REPEATER_TYPE_OPTIONS : TYPE_OPTIONS).map((option) => {
                              const Icon = option.icon;
                              const active = fieldType === option.type;
                              return (
                                <button
                                  key={option.type}
                                  type="button"
                                  onClick={() => setFieldType(option.type)}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-[background-color,border-color,color] cursor-pointer ${
                                    active
                                      ? "bg-accent-solid text-accent-foreground border-accent-solid shadow-sm"
                                      : "bg-surface border-outline-subtle text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover hover:border-outline"
                                  }`}
                                >
                                  <Icon size={13} /> {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Always present (like the mode row above it) so selecting a
                      styleable placement doesn't shift the canvas below it; every
                      control just disables itself when nothing applicable is
                      selected. Mirrors the full HTML editor's own persistent
                      TemplateFormattingToolbar row rather than a per-box popover. */}
                  <div className="px-3 py-2 border-b border-outline/70">
                    <TemplateOverlayFormattingBar
                      style={selectedStyle}
                      onChange={handleSelectedStyleChange}
                      richEditing={richEditing}
                      richFormat={richFormat ?? undefined}
                      onRichCommand={handleRichCommand}
                      onRichPrepare={handleRichPrepare}
                      sample={fontSample.sample}
                      sampleHint={mode === "select"}
                      onMatchSample={handleMatchSample}
                      fittedSize={fitted && fitted.id === state.selectedId ? fitted.size : null}
                      onUndo={history.undo}
                      onRedo={history.redo}
                      canUndo={history.canUndo}
                      canRedo={history.canRedo}
                    />
                  </div>

                  {repeaters.length > 0 && (
                    <div className="border-b border-outline/70 px-3 py-2 bg-surface-alt/40 space-y-2">
                      {/* Each repeater's name chip doubles as its selector: no
                          separate dropdown to pick which repeater a new column
                          drawn in Repeater mode attaches to, just click the one
                          you want active (highlighted) before drawing. */}
                      {repeaters.map((r) => {
                        const columns = state.placements.filter((p) => p.repeaterName === r.name);
                        const active = repeaterTarget === r.name;
                        return (
                          <div key={r.name} className="flex items-center gap-2 flex-wrap text-xs">
                            <button
                              type="button"
                              onClick={() => setRepeaterTarget(r.name)}
                              aria-pressed={active}
                              title="Draw new columns into this repeater"
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium border transition-colors cursor-pointer ${
                                active
                                  ? "bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200 border-violet-400 dark:border-violet-600 ring-1 ring-violet-400/50"
                                  : "bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800 hover:bg-violet-100 dark:hover:bg-violet-900/40"
                              }`}
                            >
                              <Repeat size={11} /> {r.name}
                            </button>
                            <span className="text-on-surface-muted">
                              {columns.length} column{columns.length !== 1 ? "s" : ""}
                            </span>
                            <label className="flex items-center gap-1 text-on-surface-muted">
                              Row height %
                              <input
                                type="number"
                                min={1}
                                max={50}
                                step={0.5}
                                value={r.rowHeightPercent}
                                onChange={(e) => updateRepeater(r.name, { rowHeightPercent: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })}
                                className="w-16 rounded-md border border-input-border bg-input-bg text-on-surface px-1.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => setDeleteRepeaterTarget(r.name)}
                              aria-label={`Delete repeater ${r.name}`}
                              className="p-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        );
                      })}

                      <button
                        type="button"
                        onClick={() => setRepeaterTarget(NEW_REPEATER)}
                        aria-pressed={repeaterTarget === NEW_REPEATER}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border border-dashed transition-colors cursor-pointer ${
                          repeaterTarget === NEW_REPEATER
                            ? "border-violet-400 dark:border-violet-600 text-violet-700 dark:text-violet-300 bg-violet-500/5"
                            : "border-outline text-on-surface-muted hover:bg-surface-hover hover:text-on-surface"
                        }`}
                      >
                        <Plus size={11} /> New repeater
                      </button>
                    </div>
                  )}

                  {savedFields.length > 0 && (
                    <div className="border-b border-outline px-3 py-1.5 bg-surface flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-on-surface-muted">Fields:</span>
                      {savedFields.map((n) => (
                        <span key={n} className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-xs font-medium">
                          {"{" + n + "}"}
                        </span>
                      ))}
                    </div>
                  )}
                  {savedRepeaters.length > 0 && (
                    <div className="border-b border-outline px-3 py-1.5 bg-surface flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-on-surface-muted">Repeaters:</span>
                      {savedRepeaters.map((r) => (
                        <span key={r.name} className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-xs font-medium">
                          ↻ {r.name}{r.fields.length > 0 ? ` (${r.fields.join(", ")})` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-on-surface-muted">
                      {state.placements.length} field{state.placements.length !== 1 ? "s" : ""} placed
                    </span>
                    {totalPages > 1 && (
                      <>
                        <div className="h-4 w-px bg-outline-subtle" />
                        <span className="text-xs tabular-nums text-on-surface-muted">Page {currentPage} of {totalPages}</span>
                      </>
                    )}
                    <div className="ml-auto">
                      <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                    </div>
                  </div>
                </div>

                <ScrollArea
                  viewportProps={zoomAreaProps}
                  className="flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-900"
                  viewportClassName="p-6"
                  onPointerDown={(e) => {
                    // Decided by where the PRESS started, not where release
                    // ends up: a `click`-based check here would deselect a
                    // field whenever holding it moved the pointer past a page
                    // edge or otherwise made press/release land on different
                    // elements (browsers don't reliably fire `click`, or fire
                    // it against a stale target, once press and release
                    // disagree). A field box's own pointerdown handler always
                    // stops propagation before it would reach here, so any
                    // pointerdown that does reach here started on blank space:
                    // the page background (inside `[data-pdf-page]`) or the
                    // margin around it.
                    if (state.selectedId && !(e.target as HTMLElement).closest('[data-annotation="field"]')) {
                      dispatch({ type: "SELECT", id: null });
                    }
                  }}
                >
                  <PDFPageViewer
                    file={pdfFile}
                    mode={mode === "select" ? "select" : "text"}
                    zoom={zoom}
                    onDocumentLoad={setTotalPages}
                    onDocumentProxy={fontSample.setDocument}
                    onVisiblePageChange={setCurrentPage}
                    onPageClick={handlePageClick}
                  >
                    {(page, pageWidth, pageHeight, pagePointSize) => (
                      <>
                        {/* Under the placement boxes (which take z-10, or z-20
                            when selected), so marking what the readout is
                            describing never hides a field the reader placed. */}
                        {fontSample.page === page && fontSample.highlights.map((box, index) => (
                          <div
                            key={index}
                            aria-hidden
                            className="pointer-events-none absolute z-0 rounded-sm border border-accent-control-ring bg-accent-solid/10"
                            style={{
                              left: (box.xPercent / 100) * pageWidth,
                              top: (box.yPercent / 100) * pageHeight,
                              width: (box.widthPercent / 100) * pageWidth,
                              height: (box.heightPercent / 100) * pageHeight,
                            }}
                          />
                        ))}
                        {state.placements.filter((p) => p.page === page).map((p) => (
                          <TemplateOverlayFieldBox
                            key={p.id}
                            ref={(instance) => {
                              if (instance) boxHandlesRef.current.set(p.id, instance);
                              else boxHandlesRef.current.delete(p.id);
                            }}
                            placement={p}
                            isSelected={state.selectedId === p.id}
                            pageWidth={pageWidth}
                            pageHeight={pageHeight}
                            pagePointSize={pagePointSize}
                            siblingFieldNames={siblingFieldNamesFor(p)}
                            onSelect={() => dispatch({ type: "SELECT", id: p.id })}
                            onMove={(x, y) => { dispatch({ type: "MOVE", id: p.id, xPercent: x, yPercent: y }); markDirty(); }}
                            onMoveToPage={(pg, x, y) => { dispatch({ type: "MOVE_TO_PAGE", id: p.id, page: pg, xPercent: x, yPercent: y }); markDirty(); }}
                            onResize={(w, h) => { dispatch({ type: "RESIZE", id: p.id, widthPercent: w, heightPercent: h }); markDirty(); }}
                            onTypeChange={(t) => { checkpoint(); dispatch({ type: "SET_TYPE", id: p.id, fieldType: t }); markDirty(); }}
                            onRichTextChange={(richText) => handleRichTextChange(p.id, richText)}
                            onFormatChange={setRichFormat}
                            onReplaceImage={() => handleReplaceImage(p.id)}
                            onDelete={() => { checkpoint(); dispatch({ type: "DELETE", id: p.id }); markDirty(); }}
                            onFittedSizeChange={(size) => setFitted((prev) => (prev?.id === p.id && prev.size === size ? prev : { id: p.id, size }))}
                            onInteractionStart={() => checkpoint()}
                          />
                        ))}
                        {(guideBoxesByPage.get(page) ?? []).map((guide) => (
                          <TemplateOverlayFieldBox
                            key={guide.key}
                            placement={guide.placement}
                            isGuide
                            isSelected={false}
                            pageWidth={pageWidth}
                            pageHeight={pageHeight}
                          />
                        ))}
                      </>
                    )}
                  </PDFPageViewer>
                </ScrollArea>
              </div>
            )}
          </>
        )}
      </div>

      <PlaceholderModal
        open={pickerOpen}
        onClose={closePicker}
        onInsert={handlePickerInsert}
        repeaterPrefix={pendingBox?.isNewRepeater ? null : (pendingBox?.repeaterKey ?? null)}
        newRepeater={pendingBox?.isNewRepeater ?? false}
      />

      <TemplateSaveLayoutModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        onConfirm={handleConfirmSave}
        initialName={template?.name ?? ""}
        saving={saving}
        fieldCount={state.placements.length}
        repeaterCount={repeaters.length}
      />

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={handleImageFileSelected}
      />

      <ConfirmModal
        isOpen={Boolean(deleteRepeaterTarget)}
        onClose={() => setDeleteRepeaterTarget(null)}
        onConfirm={() => {
          if (deleteRepeaterTarget) {
            checkpoint();
            dispatch({ type: "DELETE_REPEATER", repeaterName: deleteRepeaterTarget });
            markDirty();
            // The repeater picker was otherwise left pointed at a name that no
            // longer exists in `repeaters` (it renders as a blank "Select…"
            // once its option disappears), which sent the next column drawn
            // straight into that dead repeaterName instead of NEW_REPEATER,
            // skipping the naming banner and orphaning the column: nothing
            // in `repeaters` state ever picks it back up.
            if (repeaterTarget === deleteRepeaterTarget) setRepeaterTarget(NEW_REPEATER);
          }
          setDeleteRepeaterTarget(null);
        }}
        title="Delete repeater?"
        message={`This removes "${deleteRepeaterTarget ?? ""}" and all of its column boxes from the document. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
      />

      <ConfirmModal
        isOpen={confirmBailOpen}
        onClose={() => setConfirmBailOpen(false)}
        onConfirm={() => { setConfirmBailOpen(false); onUseFullEditor?.(); }}
        title="Switch to the full editor?"
        message="Fields you've placed but haven't saved yet will be lost. The document itself isn't discarded, though: you can come back to it with Back, as long as you haven't saved a template in the full editor yet."
        confirmText="Switch editors"
        confirmType="danger"
      />
    </div>
  );
}
