"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import useFormFeedback from "@/hooks/useFormFeedback";

const STAGE_HEIGHT = 420;
const MIN_CROP_SIZE = 40;
const MAX_OUTPUT_DIMENSION = 1600;
const STAGE_BACKGROUND_STYLE = {
  backgroundColor: "#f6f8fc",
  backgroundImage: `
    linear-gradient(45deg, rgba(15, 23, 42, 0.04) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(15, 23, 42, 0.04) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(15, 23, 42, 0.04) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(15, 23, 42, 0.04) 75%)
  `,
  backgroundSize: "24px 24px",
  backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0px",
} as const;

interface LogoCropModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  fileName: string;
  loading?: boolean;
  error?: string | null;
  title?: string;
  description?: string;
  confirmText?: string;
  onClose: () => void;
  onConfirm: (file: File) => Promise<void> | void;
}

type Size = {
  width: number;
  height: number;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function describeCrop(rect: CropRect, scale: { scaleX: number; scaleY: number }): string {
  return `Left ${Math.round(rect.x * scale.scaleX)}, top ${Math.round(rect.y * scale.scaleY)}, width ${Math.round(rect.width * scale.scaleX)}, height ${Math.round(rect.height * scale.scaleY)} pixels`;
}

type Handle = "move" | "nw" | "ne" | "sw" | "se";

type DragState = {
  pointerId: number;
  mode: Handle;
  startX: number;
  startY: number;
  startRect: CropRect;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toPngFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return "law-firm-logo.png";
  const withoutExtension = trimmed.replace(/\.[^/.]+$/, "");
  return `${withoutExtension || "law-firm-logo"}.png`;
}

function normalizeRect(rect: CropRect, bounds: Size): CropRect {
  const width = clamp(rect.width, MIN_CROP_SIZE, bounds.width);
  const height = clamp(rect.height, MIN_CROP_SIZE, bounds.height);
  const x = clamp(rect.x, 0, Math.max(0, bounds.width - width));
  const y = clamp(rect.y, 0, Math.max(0, bounds.height - height));

  return { x, y, width, height };
}

function getResizedRect(handle: Exclude<Handle, "move">, startRect: CropRect, deltaX: number, deltaY: number, bounds: Size): CropRect {
  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.width;
  let bottom = startRect.y + startRect.height;

  if (handle.includes("w")) {
    left = clamp(startRect.x + deltaX, 0, right - MIN_CROP_SIZE);
  }
  if (handle.includes("e")) {
    right = clamp(startRect.x + startRect.width + deltaX, left + MIN_CROP_SIZE, bounds.width);
  }
  if (handle.includes("n")) {
    top = clamp(startRect.y + deltaY, 0, bottom - MIN_CROP_SIZE);
  }
  if (handle.includes("s")) {
    bottom = clamp(startRect.y + startRect.height + deltaY, top + MIN_CROP_SIZE, bounds.height);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export default function LogoCropModal({
  isOpen,
  imageSrc,
  fileName,
  loading = false,
  error,
  title = "Crop Law Firm Logo",
  description = "Drag the crop box or pull its corners to choose exactly what gets uploaded.",
  confirmText = "Crop & Upload",
  onClose,
  onConfirm,
}: LogoCropModalProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [naturalSize, setNaturalSize] = useState<Size>({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [needsInitialCrop, setNeedsInitialCrop] = useState(true);
  const [activeHandle, setActiveHandle] = useState<Handle | null>(null);
  const { errorMessage: localError, setErrorMessage: setLocalError, feedbackRef, feedbackId } = useFormFeedback();
  const keyboardHintId = useId();
  const [cropAnnouncement, setCropAnnouncement] = useState('');

  useEffect(() => {
    if (isOpen && error) feedbackRef.current?.focus();
  }, [error, isOpen, feedbackRef]);

  const requestClose = useCallback(() => {
    if (loading) return;
    onClose();
  }, [loading, onClose]);

  // Keep the last image rendered through the exit animation, after the parent
  // clears the `imageSrc` prop on close.
  const lastImageSrcRef = useRef<string | null>(null);
  if (imageSrc) lastImageSrcRef.current = imageSrc;
  const activeImageSrc = imageSrc ?? lastImageSrcRef.current;

  const imageDisplay = useMemo(() => {
    if (!naturalSize.width || !naturalSize.height || !stageSize.width || !stageSize.height) {
      return null;
    }

    const scale = Math.min(
      stageSize.width / naturalSize.width,
      stageSize.height / naturalSize.height,
    );

    const width = naturalSize.width * scale;
    const height = naturalSize.height * scale;

    return {
      x: (stageSize.width - width) / 2,
      y: (stageSize.height - height) / 2,
      width,
      height,
      scaleX: naturalSize.width / width,
      scaleY: naturalSize.height / height,
    };
  }, [naturalSize.height, naturalSize.width, stageSize.height, stageSize.width]);

  const measureStage = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;

    setStageSize({
      width: rect.width,
      height: rect.height,
    });
  }, []);

  const resetCrop = useCallback(() => {
    if (!imageDisplay) return;

    const width = Math.max(MIN_CROP_SIZE, imageDisplay.width * 0.72);
    const height = Math.max(MIN_CROP_SIZE, imageDisplay.height * 0.72);

    const next = {
      x: (imageDisplay.width - width) / 2,
      y: (imageDisplay.height - height) / 2,
      width,
      height,
    };
    setCropRect(next);
    setCropAnnouncement(describeCrop(next, imageDisplay));
  }, [imageDisplay]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const frame = requestAnimationFrame(measureStage);
    const resizeObserver = new ResizeObserver(measureStage);

    if (stageRef.current) {
      resizeObserver.observe(stageRef.current);
    }

    window.addEventListener("resize", measureStage);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureStage);
    };
  }, [isOpen, measureStage]);

  useEffect(() => {
    if (!isOpen) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets crop/measurement state when the source image or modal open state changes
    setNaturalSize({ width: 0, height: 0 });
    setCropRect(null);
    setNeedsInitialCrop(true);
    setActiveHandle(null);
    setLocalError('');
    setCropAnnouncement('');
  }, [imageSrc, isOpen, setLocalError]);

  useEffect(() => {
    if (!imageDisplay || !needsInitialCrop) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time crop initialization after the image display geometry is measured
    resetCrop();
    setNeedsInitialCrop(false);
  }, [imageDisplay, needsInitialCrop, resetCrop]);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
    setLocalError('');
  }, [setLocalError]);

  const finishDrag = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setActiveHandle(null);
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, mode: Handle) => {
      if (loading || !cropRect) return;

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      dragRef.current = {
        pointerId: event.pointerId,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startRect: cropRect,
      };
      setActiveHandle(mode);
    },
    [cropRect, loading],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !imageDisplay) return;

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;

      if (drag.mode === "move") {
        setCropRect(
          normalizeRect(
            {
              ...drag.startRect,
              x: drag.startRect.x + deltaX,
              y: drag.startRect.y + deltaY,
            },
            { width: imageDisplay.width, height: imageDisplay.height },
          ),
        );
        return;
      }

      setCropRect(
        getResizedRect(
          drag.mode,
          drag.startRect,
          deltaX,
          deltaY,
          { width: imageDisplay.width, height: imageDisplay.height },
        ),
      );
    },
    [imageDisplay],
  );

  const handleCropKeyDown = (event: React.KeyboardEvent<HTMLElement>, mode: Handle) => {
    if (loading || !cropRect || !imageDisplay) return;
    const step = event.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = { width: imageDisplay.width, height: imageDisplay.height };
    const next = mode === 'move'
      ? normalizeRect({ ...cropRect, x: cropRect.x + delta[0], y: cropRect.y + delta[1] }, bounds)
      : getResizedRect(mode, cropRect, delta[0], delta[1], bounds);
    setCropRect(next);
    setCropAnnouncement(describeCrop(next, imageDisplay));
  };

  const handleConfirm = useCallback(async () => {
    setLocalError('');
    if (!cropRect || !imageDisplay || !imageRef.current) {
      setLocalError("We couldn't prepare this image for cropping. Please try another image.");
      return;
    }

    const sourceX = Math.round(cropRect.x * imageDisplay.scaleX);
    const sourceY = Math.round(cropRect.y * imageDisplay.scaleY);
    const sourceWidth = Math.max(1, Math.round(cropRect.width * imageDisplay.scaleX));
    const sourceHeight = Math.max(1, Math.round(cropRect.height * imageDisplay.scaleY));

    const outputScale = Math.min(1, MAX_OUTPUT_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
    const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");

    if (!context) {
      setLocalError("Your browser couldn't create the cropped logo. Please try again.");
      return;
    }

    context.clearRect(0, 0, outputWidth, outputHeight);
    context.drawImage(
      imageRef.current,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight,
    );

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });

    if (!blob) {
      setLocalError("Your browser couldn't export the cropped logo. Please try again.");
      return;
    }

    // The status region reports the upload from here on, so drop the last
    // coordinates rather than repeat them once the upload settles.
    setCropAnnouncement('');
    await onConfirm(new File([blob], toPngFileName(fileName), { type: "image/png" }));
  }, [cropRect, fileName, imageDisplay, onConfirm, setLocalError]);

  if (!activeImageSrc) return null;

  return (
    <Modal
      isOpen={isOpen && !!imageSrc}
      onClose={requestClose}
      title={title}
      subtitle={description}
      closeIcon="✕"
      dismissible={!loading}
      size="4xl"
      height="none"
      className="overflow-hidden rounded-2xl border border-outline shadow-2xl"
      bodyClassName="px-6 py-5"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="primary" onClick={() => void handleConfirm()} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div ref={feedbackRef} id={feedbackId} tabIndex={-1}>
        <ErrorNotification error={localError || error || null} className="mb-4" />
      </div>
      <p role="status" className="sr-only">{loading ? "Uploading image" : cropAnnouncement}</p>

      <div
        ref={stageRef}
        className="relative mx-auto w-full overflow-hidden rounded-2xl border border-outline touch-none select-none"
        style={{ ...STAGE_BACKGROUND_STYLE, height: `${STAGE_HEIGHT}px` }}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event.pointerId)}
        onPointerCancel={(event) => finishDrag(event.pointerId)}
        onPointerLeave={(event) => finishDrag(event.pointerId)}
      >
        {imageDisplay && (
          <img
            ref={imageRef}
            src={activeImageSrc}
            alt={`${title} preview`}
            draggable={false}
            onLoad={handleImageLoad}
            onError={() => setLocalError("We couldn't load that image. Please choose another file.")}
            className="absolute select-none"
            style={{
              left: `${imageDisplay.x}px`,
              top: `${imageDisplay.y}px`,
              width: `${imageDisplay.width}px`,
              height: `${imageDisplay.height}px`,
            }}
          />
        )}

        {!imageDisplay && (
          <img
            ref={imageRef}
            src={activeImageSrc}
            alt={`${title} preview`}
            draggable={false}
            onLoad={handleImageLoad}
            onError={() => setLocalError("We couldn't load that image. Please choose another file.")}
            className="absolute inset-0 m-auto max-h-full max-w-full select-none opacity-0"
          />
        )}

        {imageDisplay && cropRect && (
          <>
            <div
              className="pointer-events-none absolute bg-white/68 dark:bg-slate-950/18"
              style={{
                left: `${imageDisplay.x}px`,
                top: `${imageDisplay.y}px`,
                width: `${imageDisplay.width}px`,
                height: `${cropRect.y}px`,
              }}
            />
            <div
              className="pointer-events-none absolute bg-white/68 dark:bg-slate-950/18"
              style={{
                left: `${imageDisplay.x}px`,
                top: `${imageDisplay.y + cropRect.y + cropRect.height}px`,
                width: `${imageDisplay.width}px`,
                height: `${imageDisplay.height - cropRect.y - cropRect.height}px`,
              }}
            />
            <div
              className="pointer-events-none absolute bg-white/68 dark:bg-slate-950/18"
              style={{
                left: `${imageDisplay.x}px`,
                top: `${imageDisplay.y + cropRect.y}px`,
                width: `${cropRect.x}px`,
                height: `${cropRect.height}px`,
              }}
            />
            <div
              className="pointer-events-none absolute bg-white/68 dark:bg-slate-950/18"
              style={{
                left: `${imageDisplay.x + cropRect.x + cropRect.width}px`,
                top: `${imageDisplay.y + cropRect.y}px`,
                width: `${imageDisplay.width - cropRect.x - cropRect.width}px`,
                height: `${cropRect.height}px`,
              }}
            />

            <div
              role="group"
              aria-label="Move crop"
              aria-describedby={keyboardHintId}
              tabIndex={loading ? -1 : 0}
              onKeyDown={(event) => { if (event.target === event.currentTarget) handleCropKeyDown(event, 'move'); }}
              className="absolute border-2 border-sky-500 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]"
              style={{
                left: `${imageDisplay.x + cropRect.x}px`,
                top: `${imageDisplay.y + cropRect.y}px`,
                width: `${cropRect.width}px`,
                height: `${cropRect.height}px`,
                cursor: activeHandle === "move" ? "grabbing" : "grab",
              }}
              onPointerDown={(event) => startDrag(event, "move")}
            >
              <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-sky-700/20" />
              <div className="pointer-events-none absolute inset-y-0 right-1/3 w-px bg-sky-700/20" />
              <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-sky-700/20" />
              <div className="pointer-events-none absolute inset-x-0 bottom-1/3 h-px bg-sky-700/20" />

              {[
                { key: "nw", label: 'top left', left: "-8px", top: "-8px", cursor: "nwse-resize" },
                { key: "ne", label: 'top right', right: "-8px", top: "-8px", cursor: "nesw-resize" },
                { key: "sw", label: 'bottom left', left: "-8px", bottom: "-8px", cursor: "nesw-resize" },
                { key: "se", label: 'bottom right', right: "-8px", bottom: "-8px", cursor: "nwse-resize" },
              ].map((handle) => (
                <button
                  key={handle.key}
                  type="button"
                  aria-label={`Resize crop ${handle.label}`}
                  aria-describedby={keyboardHintId}
                  disabled={loading}
                  className="absolute h-4 w-4 rounded-full border-2 border-sky-600 bg-white shadow-sm"
                  style={{
                    left: handle.left,
                    right: handle.right,
                    top: handle.top,
                    bottom: handle.bottom,
                    cursor: handle.cursor,
                  }}
                  onPointerDown={(event) => startDrag(event, handle.key as Exclude<Handle, "move">)}
                  onKeyDown={(event) => handleCropKeyDown(event, handle.key as Exclude<Handle, "move">)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-on-surface-secondary">
          Tip: drag inside the box to move it, or drag any corner to resize it.
        </p>
        <span id={keyboardHintId} className="sr-only">Focus the crop box or a corner and use arrow keys. Hold Shift for larger steps.</span>
        <Button
          type="secondary"
          size="small"
          disabled={loading || !imageDisplay}
          onClick={resetCrop}
        >
          Reset Crop
        </Button>
      </div>
    </Modal>
  );
}
