"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { templatesService } from "@/services/templates.service";
import type { Template } from "@/types/template";
import { injectTemplatePreviewStyles } from "./templatePreview";
import { injectTemplateAssetSources } from "./templateImageObjects";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/**
 * What a template is previewed from, which depends on how it stores its
 * content: an HTML template renders its own markup, while DOCX and Document
 * Overlay templates are documents and are previewed as the PDF the server
 * renders them to.
 */
export type TemplatePreviewContent =
  | { kind: "html"; url: string }
  | { kind: "pdf"; url: string };

/**
 * Only the HTML branch holds a blob URL, and it has to be handed back.
 *
 * The PDF branch holds a storage link instead. Nothing in the tab owns it, so
 * there is nothing to revoke: it simply expires.
 */
function releasePreview(content: TemplatePreviewContent | null, delayMs = 0) {
  if (content?.kind !== "html") return;
  const { url } = content;
  if (delayMs > 0) window.setTimeout(() => URL.revokeObjectURL(url), delayMs);
  else URL.revokeObjectURL(url);
}

async function loadHtmlPreview(
  lawFirmId: string,
  template: Template
): Promise<TemplatePreviewContent> {
  const fullTemplate = await templatesService.getById(lawFirmId, template.id);
  if (!fullTemplate.html) {
    throw new Error("This template has no content to preview.");
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

  return {
    kind: "html",
    url: URL.createObjectURL(new Blob([previewHtml], { type: "text/html" })),
  };
}

async function loadPdfPreview(
  lawFirmId: string,
  template: Template
): Promise<TemplatePreviewContent> {
  // The link, not the bytes. `PdfPreview` gives pdf.js the url so it reads the
  // byte ranges of the pages on screen. A long template used to arrive whole
  // before its first page could be drawn.
  const link = await templatesService.previewPdf(lawFirmId, template.id);
  return { kind: "pdf", url: link.url };
}

/**
 * Loads what a template is previewed from: a blob URL an iframe can show for
 * HTML templates, or a storage link to the PDF for the document-backed ones.
 *
 * A blob URL is revoked on a delay when the preview closes, so the iframe keeps
 * rendering its content while the dialog animates out, and again on unmount so a
 * preview left open when the page changes doesn't leak.
 */
export default function useTemplatePreview(
  lawFirmId: string,
  onError: (message: string) => void
) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [content, setContent] = useState<TemplatePreviewContent | null>(null);
  const [name, setName] = useState("");

  // Retains the content/name through the close animation, after they are cleared.
  const retainedRef = useRef({ content, name });
  if (content) retainedRef.current = { content, name };

  // Guards against out-of-order responses: clicking template A then quickly
  // template B starts two fetches, and a slow A response arriving after B's
  // would otherwise overwrite the preview the user is already looking at.
  // Only the most recently requested id is allowed to commit its result.
  const requestIdRef = useRef<string | null>(null);

  const open = useCallback(
    async (template: Template) => {
      requestIdRef.current = template.id;
      setLoadingId(template.id);

      try {
        const next = (template.type ?? "html") === "html"
          ? await loadHtmlPreview(lawFirmId, template)
          : await loadPdfPreview(lawFirmId, template);

        if (requestIdRef.current !== template.id) {
          releasePreview(next);
          return;
        }

        setName(template.name);
        setContent((current) => {
          releasePreview(current);
          return next;
        });
      } catch (err) {
        if (requestIdRef.current === template.id) {
          onError(getErrorMessage(err, "Failed to open template preview."));
        }
      } finally {
        setLoadingId((current) => (current === template.id ? null : current));
      }
    },
    [lawFirmId, onError]
  );

  const close = useCallback(() => {
    requestIdRef.current = null;
    setContent((current) => {
      releasePreview(current, 250);
      return null;
    });
    setName("");
  }, []);

  // Tracked in a ref so the unmount cleanup can release the live content without
  // re-running (and releasing too early) on every content change. The close and
  // replace paths above release their own.
  const contentRef = useRef<TemplatePreviewContent | null>(content);
  contentRef.current = content;
  useEffect(
    () => () => {
      releasePreview(contentRef.current);
    },
    []
  );

  return {
    /** Id of the template whose preview is being fetched, if any. */
    loadingId,
    isOpen: Boolean(content),
    /** Survives the close animation, unlike `isOpen`. */
    shownContent: content ?? retainedRef.current.content,
    shownName: content ? name : retainedRef.current.name,
    open,
    close,
  };
}
