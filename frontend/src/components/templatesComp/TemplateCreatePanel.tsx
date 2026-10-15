"use client";

import { useEffect, useRef, useState } from "react";
import { FilePlus2, FileUp } from "lucide-react";
import Spinner from "@/components/ui/Spinner";
import UploadStatusChip from "@/components/ui/UploadStatusChip";
import { templatesService } from "@/services/templates.service";
import { UploadCancelledError } from "@/lib/files/resumableUpload";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { TemplateWithHtml } from "@/types/template";
import {
  TEMPLATE_ACCEPT_ATTR,
  TEMPLATE_ACCEPTED_EXTENSIONS,
  isSupportedTemplateFile,
} from "./templateEditorDom";

interface TemplateCreatePanelProps {
  lawFirmId: string;
  /** Where a template created from here will be filed. */
  folderId: string | null;
  /**
   * `overlay` (the default) uploads the picked document as a Document Overlay
   * draft. `full-editor` uploads nothing here and hands the file to
   * `onDocumentPicked`, so the full editor imports it itself.
   */
  mode?: "overlay" | "full-editor";
  /** The picked document, in `full-editor` mode. */
  onDocumentPicked?: (file: File) => void;
  /**
   * The upload succeeded: a Document Overlay template row now exists (the
   * default outcome of picking a file, per the design's creation flow) and
   * the caller should open its editor. `sourceFile` is kept so "Use the full
   * editor instead" can hand the same bytes to `TemplateEditor` without
   * asking the user to pick the file a second time.
   */
  onOverlayCreated: (result: { templateId: string; template: TemplateWithHtml; sourceFile: File }) => void;
  /** The picked file isn't a format the editor can import. */
  onUnsupportedFile: (message: string) => void;
  /** The overlay upload itself failed (network, conversion, etc). */
  onUploadFailed: (message: string) => void;
  onCancel?: () => void;
  destinationLabel?: string;
}

/**
 * Starting a template, as the page's primary target.
 *
 * Every template begins as a document - the editor's first step is an upload, and
 * there is no blank start - so the page leads with the upload rather than with a
 * button in the header competing with the page title. Picking a file here uploads
 * it immediately as a Document Overlay template (the new default authoring mode:
 * see the overlay editor) rather than waiting for an explicit "Save", because the
 * overlay editor needs a real PDF to render as soon as it opens. "Use the full
 * editor instead", offered from that editor, is the only way back to the older
 * upload-then-build-in-place flow.
 *
 * The whole panel is the target: the button inside it is styling, not a second
 * control, and it takes a dropped file as readily as a click.
 */
export default function TemplateCreatePanel({
  lawFirmId,
  folderId,
  mode = "overlay",
  onDocumentPicked,
  onOverlayCreated,
  onUnsupportedFile,
  onUploadFailed,
  onCancel,
  destinationLabel,
}: TemplateCreatePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // dragenter/dragleave fire again for every child element the cursor crosses, so
  // the nesting depth is what says whether the pointer has really left the panel.
  const depthRef = useRef(0);

  const cancelUpload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    onCancel?.();
  };

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");

  const accept = async (file: File) => {
    if (!isSupportedTemplateFile(file)) {
      onUnsupportedFile(
        `${file.name} isn't a supported format. Use PDF, DOCX, DOC, ODT, RTF, or TXT.`
      );
      return;
    }

    if (mode === "full-editor") {
      onDocumentPicked?.(file);
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setUploading(true);
    try {
      const { templateId, template } = await templatesService.uploadOverlay(
        lawFirmId,
        file,
        undefined,
        folderId,
        { signal: abortController.signal }
      );
      if (!abortController.signal.aborted) {
        onOverlayCreated({ templateId, template, sourceFile: file });
      }
    } catch (err) {
      if (
        abortController.signal.aborted ||
        err instanceof UploadCancelledError ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }
      onUploadFailed(getErrorMessage(err, "Failed to upload document."));
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setUploading(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Create a template from a document"
      aria-disabled={uploading}
      onClick={() => { if (!uploading) inputRef.current?.click(); }}
      onKeyDown={(event) => {
        if (uploading) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(event) => {
        if (uploading || !isFileDrag(event)) return;
        depthRef.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!uploading && isFileDrag(event)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depthRef.current = 0;
        setDragging(false);
        if (uploading) return;
        const file = event.dataTransfer.files?.[0];
        if (file) void accept(file);
      }}
      className={`group flex flex-col gap-5 rounded-2xl border-2 border-dashed p-5 transition-colors sm:flex-row sm:items-center sm:justify-between sm:p-7 ${
        uploading ? "cursor-wait opacity-80" : "cursor-pointer"
      } ${
        dragging
          ? "border-accent-border-soft bg-accent-soft"
          : "border-accent-border-soft bg-accent-soft hover:border-accent-border-soft/60 hover:bg-accent-soft"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={TEMPLATE_ACCEPT_ATTR}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void accept(file);
          event.target.value = "";
        }}
      />

      <div className="flex items-center gap-4 sm:gap-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-emphasis transition-transform group-hover:scale-105 motion-reduce:transition-none sm:size-14">
          {uploading ? (
            <Spinner size={22} className="text-accent-emphasis" />
          ) : dragging ? (
            <FileUp className="size-6 sm:size-7" strokeWidth={2} />
          ) : (
            <FilePlus2 className="size-6 sm:size-7" strokeWidth={2} />
          )}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-on-surface sm:text-lg">
            {uploading ? "Uploading document…" : dragging ? "Drop to start a template" : "Turn a document into a template"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-on-surface-secondary sm:text-sm">
            {mode === "full-editor"
              ? "Open it in the full editor and place fields in its text, or keep a Word document as a merge-field DOCX."
              : "See it exactly as it prints, then pin fields on top of it wherever the blanks go."}
            {destinationLabel ? ` Saved to ${destinationLabel}.` : ""}
          </p>
          <p className="mt-1.5 text-[11px] uppercase tracking-wider text-on-surface-muted">
            {TEMPLATE_ACCEPTED_EXTENSIONS.map((ext) => ext.replace(".", "")).join(" · ")}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
        {uploading ? (
          <UploadStatusChip onCancel={cancelUpload} />
        ) : (
          <>
            <span className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3 text-sm font-semibold text-accent-foreground shadow-sm transition-colors group-hover:bg-accent-solid-hover dark:shadow-none">
              <FileUp size={17} strokeWidth={2.2} />
              New Template
            </span>
            <span className="text-center text-[11px] text-on-surface-muted sm:text-right">
              or drag one in
            </span>
          </>
        )}
      </div>
    </div>
  );
}
