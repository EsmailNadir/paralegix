"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import PdfPreview from "./PdfPreview";
import Button from "@/components/ui/Button";
import ScrollArea from "@/components/ui/ScrollArea";
import ZoomControls from "@/components/ui/ZoomControls";
import { useDocumentZoom } from "@/hooks/useDocumentZoom";
import { useRefreshingReadUrl } from "@/hooks/useRefreshingReadUrl";
import { useDialog } from "@/hooks/useDialog";
import { useMountTransition, useResetAfterClose } from "@/hooks/useMountTransition";
import { backdropAnim, cardAnim } from "@/components/ui/transitionClasses";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatFileSize } from "@/lib/utils/format";
import { isBrowserRenderableImage, isHeicFormat } from '@/lib/files/imageTypes';

// Types the preview renders as plain text. Office documents also match some of
// these, so callers check `isOfficeDoc` first.
const isTextContentType = (contentType: string) =>
  contentType.startsWith('text/') ||
  contentType.includes('json') ||
  contentType.includes('xml') ||
  contentType.includes('csv') ||
  contentType.includes('javascript') ||
  contentType.includes('css') ||
  contentType.includes('html');

/**
 * Documents handed to Google's viewer, matched exactly. A substring match on
 * "doc" also caught types like `application/vnd.oasis.opendocument.graphics`,
 * which the viewer cannot render: it answers with the raw file instead, and
 * the browser downloads that under the name "gview".
 */
const OFFICE_VIEWER_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const OFFICE_VIEWER_EXTENSIONS = [
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
];

/**
 * Sandbox for the Google viewer iframe. It grants what the viewer needs to
 * run and deliberately omits `allow-downloads`, so a file the viewer cannot
 * render shows an empty frame rather than starting a "gview" download.
 */
const OFFICE_VIEWER_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/**
 * Above this a text-like file is not previewed. There is no ranged reader for
 * plain text the way there is for PDF, and a string this size in the DOM is a
 * frozen tab. The user gets the size and the download button instead.
 */
export const TEXT_PREVIEW_BYTES_LIMIT = 5 * 1024 * 1024;

interface DocumentPreviewOverlayProps {
  /** Drives the mount/exit animation and the dialog's accessibility wiring. */
  open: boolean;
  onClose: () => void;
  /** Rendered in the header and used as the dialog's accessible name. */
  name: string;
  contentType: string;
  /**
   * Already-resolved, ready-to-fetch url. Null while the caller is still
   * resolving one (a signed url mint, for example) - the overlay shows its own
   * loading state in that case rather than any content. This component never
   * resolves a url itself, so it works the same for an authenticated caller
   * (which mints a signed url) and the public share page (which already has one).
   */
  fileUrl: string | null;
  /**
   * True while the caller itself is still resolving `fileUrl`. Keeps the
   * loading spinner up before there is anything for this component to fetch.
   */
  resolving?: boolean;
  /**
   * Set when the caller's own url resolution failed. Shown the same way as an
   * error this component hits on its own (a failed PDF/text fetch, a broken
   * image, ...), and takes priority over any content while it stands.
   */
  loadError?: string | null;
  /** Secondary line under the filename in the header, e.g. a formatted size.
   *  Omit for a caller with no such metadata (the public share preview). */
  sizeLabel?: string;
  /**
   * The file's size in bytes, when the caller knows it. Decides whether a text
   * file is previewed at all. A PDF is always handed to pdf.js by url, which
   * reads page ranges at any size, so its size decides nothing and an absent
   * one (the public share preview has no size to give) is never probed for.
   */
  sizeBytes?: number;
  /**
   * Mints a fresh read url for the same document, reauthorizing as it does.
   *
   * A signed url lapses in minutes and a long document is read for longer, so
   * without this a large preview simply stops loading pages partway through.
   * Omit it where there is no session to reauthorize with, such as the public
   * share page.
   */
  onRefreshUrl?: () => Promise<string>;
  /**
   * Renders the header's Download button when supplied. The public share
   * preview passes it only for a link that permits downloading.
   */
  onDownload?: () => void;
}

/**
 * The large file-preview popup shared by `FilePreviewModal` (authenticated,
 * resolves its own signed url) and `PublicSharePreviewModal` (the public,
 * unauthenticated share-link page, which hands in an already-resolved url).
 * Owns the overlay chrome - header, zoom, content-type branching, loading and
 * error states - plus the dialog accessibility both call sites were missing:
 * `role="dialog"`, a focus trap, and Escape-to-close, via `useDialog`.
 */
export default function DocumentPreviewOverlay({
  open,
  onClose,
  name,
  contentType,
  fileUrl,
  resolving = false,
  loadError = null,
  sizeLabel,
  sizeBytes,
  onRefreshUrl,
  onDownload,
}: DocumentPreviewOverlayProps) {
  const { mounted, exiting } = useMountTransition(open, 100);
  const { dialogRef, titleId } = useDialog({ isOpen: open, onClose });
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom({ enabled: open });

  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The url pdf.js reads page ranges from. A PDF is never fetched whole here.
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  // The url pdf.js is reading is kept alive for as long as the document is open,
  // and a remint that turns out to point at different bytes is held back rather
  // than shown in place of the pages already on screen.
  const { readUrl: pdfReadUrl, replacedBy, showReplacement } = useRefreshingReadUrl({
    url: previewPdfUrl,
    enabled: open,
    refresh: onRefreshUrl,
  });

  const [convertedImageUrl, setConvertedImageUrl] = useState<string | null>(null);
  const [convertingHeic, setConvertingHeic] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, mounted]);

  const handleContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      zoomAreaProps.ref(el);
    },
    [zoomAreaProps],
  );

  const { displayWidth, displayHeight } = useMemo(() => {
    if (!naturalSize) {
      return { displayWidth: undefined, displayHeight: undefined };
    }
    const availableWidth = containerSize.width > 32 ? containerSize.width - 32 : 800;
    const availableHeight = containerSize.height > 32 ? containerSize.height - 32 : 600;

    const imgRatio = naturalSize.width / naturalSize.height;
    const containerRatio = availableWidth / availableHeight;

    let baseWidth: number;
    let baseHeight: number;

    if (imgRatio > containerRatio) {
      baseWidth = availableWidth;
      baseHeight = availableWidth / imgRatio;
    } else {
      baseHeight = availableHeight;
      baseWidth = availableHeight * imgRatio;
    }

    return {
      displayWidth: Math.round(baseWidth * (zoom / 100)),
      displayHeight: Math.round(baseHeight * (zoom / 100)),
    };
  }, [naturalSize, containerSize, zoom]);

  const type = contentType || '';
  const lowerName = name.toLowerCase();
  const isHeic = isHeicFormat(type, name);
  const isNativeImage = isBrowserRenderableImage(type, name);
  const isImage = isNativeImage || Boolean(convertedImageUrl);
  const isOfficeDoc =
    OFFICE_VIEWER_TYPES.has(type.toLowerCase().split(';')[0].trim()) ||
    OFFICE_VIEWER_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
  const isTextLike = !isOfficeDoc && isTextContentType(type);
  const canPreview =
    isImage || isHeic || type.includes('pdf') ||
    type.startsWith('video/') || type.startsWith('audio/') ||
    isTextLike || isOfficeDoc;
  // Zoom is offered only where it does something. Video, audio and Office docs
  // carry their own controls, while PDF, images and text can be zoomed from the header.
  const canZoom = isImage || isHeic || type.includes('pdf') || isTextLike;

  // Clean up any blob URL created by client-side conversion
  useEffect(() => {
    return () => {
      if (convertedImageUrl) {
        URL.revokeObjectURL(convertedImageUrl);
      }
    };
  }, [convertedImageUrl]);

  // The caller's own url resolution failed: surface it the same way a fetch
  // failure below does, and skip straight past the content-loading effect.
  useEffect(() => {
    if (loadError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirroring a prop the caller controls into local, dismissable error state
      setError(loadError);
      setContentLoading(false);
    }
  }, [loadError]);

  useEffect(() => {
    if (!open || !fileUrl) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting for a newly opened file is the teardown of the async load this effect starts
    setError(null);
    setPreviewPdfUrl(null);
    setPreviewText(null);
    setNaturalSize(null);
    if (convertedImageUrl) {
      URL.revokeObjectURL(convertedImageUrl);
      setConvertedImageUrl(null);
    }
    setConvertingHeic(false);
    resetZoom();

    (async () => {
      try {
        if (type.includes('pdf')) {
          // pdf.js opens the url itself and fetches page ranges, at any size;
          // `contentLoading` clears when it reports the load. The memoised
          // source in `PdfPreview` keeps a dev-only Strict Mode remount from
          // aborting that load.
          setContentLoading(true);
          setPreviewPdfUrl(fileUrl);
        } else if (isHeic && !isNativeImage) {
          setContentLoading(true);
          setConvertingHeic(true);
          const response = await fetch(fileUrl);
          if (!response.ok) throw new Error('Failed to load image for conversion');
          const blob = await response.blob();
          if (cancelled) return;
          const heic2any = (await import('heic2any')).default;
          const result = await heic2any({
            blob,
            toType: 'image/jpeg',
            quality: 0.85,
          });
          if (cancelled) return;
          const single = Array.isArray(result) ? result[0] : result;
          const objectUrl = URL.createObjectURL(single);
          setConvertedImageUrl(objectUrl);
          setConvertingHeic(false);
        } else if (isTextLike) {
          if (sizeBytes != null && sizeBytes > TEXT_PREVIEW_BYTES_LIMIT) {
            throw new Error(
              `This file is too large to preview (${formatFileSize(sizeBytes)}). Download it to read it.`,
            );
          }
          setContentLoading(true);
          const response = await fetch(fileUrl);
          if (!response.ok) throw new Error('Failed to load file content');
          const text = await response.text();
          if (cancelled) return;
          setPreviewText(text);
          setContentLoading(false);
        } else if (
          isImage ||
          type.startsWith('video/') ||
          type.startsWith('audio/') ||
          isOfficeDoc
        ) {
          // Images, video, audio and Office docs (rendered via Google's viewer)
          // all consume the url directly; `contentLoading` clears once the
          // element handed the url finishes decoding it.
          setContentLoading(true);
        }
        // Anything else is unsupported - `canPreview` already reflects that
        // and drives the "Preview Not Available" fallback below.
      } catch (err) {
        if (cancelled) return;
        setContentLoading(false);
        setConvertingHeic(false);
        setError(getErrorMessage(err, 'Failed to load preview'));
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetZoom is stable; re-running only on open/fileUrl/type is the point
  }, [open, fileUrl, type, isTextLike, isOfficeDoc, sizeBytes, isHeic, isNativeImage]);

  // Clear the loaded content once the exit animation finishes rather than the
  // instant `open` flips false, so the panel doesn't blank out before it
  // disappears.
  useResetAfterClose(open, () => {
    setContentLoading(false);
    setError(null);
    setPreviewPdfUrl(null);
    setPreviewText(null);
    setNaturalSize(null);
    if (convertedImageUrl) {
      URL.revokeObjectURL(convertedImageUrl);
      setConvertedImageUrl(null);
    }
    setConvertingHeic(false);
    resetZoom();
  }, 100);

  if (!mounted) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Only close if clicking directly on the backdrop (not on any child elements)
    if (e.target === e.currentTarget) {
      e.preventDefault();
      onClose();
    }
  };

  const officeViewerUrl = fileUrl
    ? `https://docs.google.com/gview?url=${encodeURIComponent(fileUrl)}&embedded=true`
    : null;

  const showSpinner = resolving || contentLoading || convertingHeic;
  const unsupportedMessage = type.startsWith('image/') && !isImage
    ? (onDownload
      ? 'This browser cannot display this image format. Click download to save the file.'
      : 'This browser cannot display this image format.')
    : (onDownload
      ? 'This file type cannot be previewed. Click download to save the file.'
      : 'This file type cannot be previewed here.');

  return (
    <div
      className={`fixed inset-0 backdrop-blur-sm bg-black/20 dark:bg-black/40 overflow-hidden z-50 flex items-center justify-center ${backdropAnim(exiting)}`}
      onClick={handleBackdropClick}
      onMouseDown={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative p-2 border w-[80vw] max-w-[80vw] h-[95vh] shadow-lg rounded-md bg-surface border-outline flex flex-col ${cardAnim(exiting)}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline bg-surface-alt rounded-t-md -mx-2 -mt-2 shrink-0">
          {/* Left: file info */}
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="flex-shrink-0 p-1.5 bg-surface rounded border border-outline">
              <svg className="h-4 w-4 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h3 id={titleId} className="text-sm font-semibold text-on-surface truncate">{name}</h3>
              {sizeLabel && <p className="text-xs text-on-surface-muted">{sizeLabel}</p>}
            </div>
          </div>

          {/* Center: zoom controls */}
          {canZoom && (
            <ZoomControls
              className="mx-2 shrink-0 sm:mx-4"
              zoom={zoom}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onReset={resetZoom}
            />
          )}

          {/* Right: download & close */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {onDownload && (
              <button
                onClick={(e) => { e.stopPropagation(); onDownload(); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline rounded-md hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="pt-3 flex-1 flex flex-col min-h-0">
          <ErrorNotification
            error={error}
            onClose={() => setError(null)}
            className="mb-4"
          />

          {/* Not an error: the pages on screen are still readable and still the
              ones this reader opened. It is a fact they have to be told before
              they act on what they are looking at, so it reads as a warning. */}
          {replacedBy && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="flex-1 text-xs text-amber-700 dark:text-amber-300">
                This document changed while you were reading it. You are still looking at the
                version you opened.
              </p>
              <Button type="secondary" size="small" onClick={showReplacement}>
                Load new version
              </Button>
            </div>
          )}

          {!error && (canPreview || resolving) && (
            <div className="relative flex-1 min-h-0">
              {showSpinner && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-surface/80 backdrop-blur-[1px]">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <LoadingSpinner />
                    <p className="text-sm text-on-surface-secondary">
                      {isOfficeDoc ? "Loading document preview..." : "Loading preview..."}
                    </p>
                  </div>
                </div>
              )}

              {fileUrl && canPreview && (
                <div
                  {...zoomAreaProps}
                  ref={handleContainerRef}
                  className={`flex-1 h-full overflow-hidden ${showSpinner ? 'pointer-events-none' : ''}`}
                >
                  {isImage && (
                    <ScrollArea className="h-full w-full" viewportClassName="flex">
                      <div className="min-w-full min-h-full flex p-4 m-auto">
                        {/* eslint-disable-next-line @next/next/no-img-element -- fileUrl is a short-lived signed GCS url next/image can't optimize */}
                        <img
                          src={convertedImageUrl || fileUrl}
                          alt={name}
                          width={displayWidth || undefined}
                          height={displayHeight || undefined}
                          style={{
                            width: displayWidth ? `${displayWidth}px` : undefined,
                            height: displayHeight ? `${displayHeight}px` : undefined,
                            maxWidth: naturalSize ? 'none' : '100%',
                            maxHeight: naturalSize ? 'none' : '100%',
                          }}
                          className="rounded-lg shadow-sm m-auto block select-none object-contain"
                          onLoad={(e) => {
                            const img = e.currentTarget;
                            setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
                            setContentLoading(false);
                          }}
                          onError={() => {
                            setContentLoading(false);
                            setError('Failed to load image');
                          }}
                        />
                      </div>
                    </ScrollArea>
                  )}

                  {type.includes('pdf') && pdfReadUrl && (
                    <PdfPreview
                      url={pdfReadUrl}
                      zoom={zoom}
                      onLoaded={() => setContentLoading(false)}
                      onError={(message) => {
                        setContentLoading(false);
                        setError(message);
                      }}
                    />
                  )}

                  {type.startsWith('video/') && (
                    <div className="flex justify-center h-full">
                      <video
                        controls
                        className="max-w-full max-h-full rounded-lg shadow-sm"
                        onLoadedData={() => setContentLoading(false)}
                        onError={() => {
                          setContentLoading(false);
                          setError('Failed to load video');
                        }}
                      >
                        <source src={fileUrl} type={type} />
                        Your browser does not support the video tag.
                      </video>
                    </div>
                  )}

                  {type.startsWith('audio/') && (
                    <div className="flex justify-center h-full">
                      <audio
                        controls
                        className="w-full max-w-2xl"
                        onLoadedData={() => setContentLoading(false)}
                        onError={() => {
                          setContentLoading(false);
                          setError('Failed to load audio');
                        }}
                      >
                        <source src={fileUrl} type={type} />
                        Your browser does not support the audio tag.
                      </audio>
                    </div>
                  )}

                  {isOfficeDoc && officeViewerUrl && (
                    <div className="w-full h-full">
                      <iframe
                        src={officeViewerUrl}
                        sandbox={OFFICE_VIEWER_SANDBOX}
                        className="w-full h-full border border-outline rounded-lg bg-surface"
                        title={name}
                        onLoad={() => setContentLoading(false)}
                      />
                    </div>
                  )}

                  {isTextLike && previewText != null && (
                    <ScrollArea className="h-full bg-surface-alt rounded-lg" viewportClassName="p-4">
                      {/* Zoom is the font size alone. It used to also carry a transform
                          scaling the same factor a second time, which rendered 200%
                          zoom at four times the size. */}
                      <pre
                        className="text-on-surface whitespace-pre-wrap"
                        style={{ fontSize: `${14 * (zoom / 100)}px` }}
                      >
                        {previewText}
                      </pre>
                    </ScrollArea>
                  )}
                </div>
              )}
            </div>
          )}

          {!error && !canPreview && !resolving && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <svg className="mx-auto h-12 w-12 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="mt-3 text-base font-semibold text-on-surface">Preview Not Available</h3>
              <p className="mt-1 text-sm text-on-surface-secondary max-w-sm">
                {unsupportedMessage}
              </p>
              {onDownload && (
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={onDownload}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-outline bg-surface-alt px-4 py-2 text-xs font-medium text-on-surface transition-[background-color,transform] hover:bg-surface-hover active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                  >
                    <Download size={14} />
                    <span>Download</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
