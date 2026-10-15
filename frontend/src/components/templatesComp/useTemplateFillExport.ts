import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useMountTransition } from '@/hooks/useMountTransition';
import { templatesService, skippedImagesNotice } from '@/services/templates.service';
import filesService from '@/services/files.service';
import { scopeFromIds } from '@/lib/files/fileScope';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { buildFilledTemplateHtml } from './templateFill';
import type { SaveDestination } from './SaveToFilesModal';

interface FillExportOptions {
  lawFirmId: string;
  templateId?: string;
  templateName: string;
  initialFillValues?: Record<string, string>;
  initialRepeaterFillValues?: Record<string, Record<string, string>[]>;
  setError: Dispatch<SetStateAction<string | null>>;
  setImageNotice: Dispatch<SetStateAction<string | null>>;
}

/** Own download, conversion and cancellable filing operations for the fill preview. */
export function useTemplateFillExport({ lawFirmId, templateId, templateName, initialFillValues, initialRepeaterFillValues, setError, setImageNotice }: FillExportOptions) {
  // Fill-mode export state (Download + Save to Files buttons next to "Back to Fill")
  const [fillExporting, setFillExporting] = useState(false);
  const [fillUploading, setFillUploading] = useState(false);
  const [showFillFormats, setShowFillFormats] = useState(false);
  const { mounted: fillFormatsMounted, exiting: fillFormatsExiting } = useMountTransition(showFillFormats, 150);
  const [showFillSaveModal, setShowFillSaveModal] = useState(false);
  const fillFormatDropdownRef = useRef<HTMLDivElement>(null);
  const fillSaveAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    fillSaveAbortRef.current?.abort();
    fillSaveAbortRef.current = null;
  }, []);
  // Close fill-format dropdown on outside click
  useEffect(() => {
    if (!showFillFormats) return;
    const handleClick = (e: MouseEvent) => {
      if (fillFormatDropdownRef.current && !fillFormatDropdownRef.current.contains(e.target as Node)) {
        setShowFillFormats(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showFillFormats]);

  // ─── Fill-mode Download ───────────────────────────────────────
  const handleFillDownload = async (format: "pdf" | "docx" | "odt" | "rtf" | "txt" = "pdf") => {
    if (!templateId || !initialFillValues) return;
    setFillExporting(true);
    setError(null);
    try {
      const full = await templatesService.getById(lawFirmId, templateId);
      const html = full.html;
      if (!html) throw new Error("No HTML content found for this template.");

      const filledHtml = buildFilledTemplateHtml(html, initialFillValues, initialRepeaterFillValues ?? {});
      const { blob: pdfBlob, skippedImages } = await templatesService.renderPdf(lawFirmId, templateId, filledHtml, {
        fileName: templateName || full.name,
      });
      setImageNotice(skippedImages > 0 ? skippedImagesNotice(skippedImages) : null);

      let blob: Blob;
      if (format === "pdf") {
        blob = pdfBlob;
      } else {
        // The convert route requires a Firebase token; go through the
        // authenticated service instead of a bare fetch.
        const pdfFile = new File([pdfBlob], "document.pdf", { type: "application/pdf" });
        blob = await templatesService.convertToFormat(pdfFile, format);
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${templateName || full.name || "document"}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to download."));
    } finally {
      setFillExporting(false);
    }
  };

  /** Dismissing the dialog mid-save stops the save: nothing is filed. */
  const closeFillSaveModal = () => {
    fillSaveAbortRef.current?.abort();
    fillSaveAbortRef.current = null;
    setShowFillSaveModal(false);
  };

  const handleFillConfirmSave = async (destination: SaveDestination) => {
    if (!templateId || !initialFillValues) return;
    const controller = new AbortController();
    fillSaveAbortRef.current = controller;
    const { signal } = controller;
    setFillUploading(true);
    setError(null);
    try {
      const full = await templatesService.getById(lawFirmId, templateId);
      const html = full.html;
      if (!html) throw new Error("No HTML content found for this template.");

      const filledHtml = buildFilledTemplateHtml(html, initialFillValues, initialRepeaterFillValues ?? {});
      const { blob: pdfBlob, skippedImages } = await templatesService.renderPdf(lawFirmId, templateId, filledHtml, {
        fileName: destination.fileName.replace(/\.pdf$/i, ""),
        signal,
      });
      if (signal.aborted) return;
      setImageNotice(skippedImages > 0 ? skippedImagesNotice(skippedImages) : null);
      const file = new File([pdfBlob], destination.fileName, { type: "application/pdf" });

      await filesService.upload(
        lawFirmId,
        scopeFromIds({
          matterId: destination.scope === "matter" ? destination.matterId : null,
          taskId: destination.scope === "task" ? destination.taskId : null,
          clientId: destination.scope === "client" ? destination.clientId : null,
        }),
        [file],
        undefined,
        destination.folderId,
        signal
      );

      setShowFillSaveModal(false);
    } catch (err) {
      // Cancelled from the dialog or by leaving the editor, which the user
      // asked for rather than a failure to report.
      if (signal.aborted) return;
      setError(getErrorMessage(err, "Failed to save to files."));
    } finally {
      if (fillSaveAbortRef.current === controller) fillSaveAbortRef.current = null;
      setFillUploading(false);
    }
  };

  return { fillExporting, fillUploading, showFillFormats, setShowFillFormats, fillFormatsMounted, fillFormatsExiting, showFillSaveModal, setShowFillSaveModal, fillFormatDropdownRef, handleFillDownload, closeFillSaveModal, handleFillConfirmSave };
}
