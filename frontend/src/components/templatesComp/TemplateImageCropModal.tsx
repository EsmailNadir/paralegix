"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import type { TemplateImageCropRect } from "./templateImageObjects";

const STAGE_HEIGHT = 420;
const MIN_CROP_SIZE = 20;
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

type Size = {
  width: number;
  height: number;
};

type DisplayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Handle = "move" | "nw" | "ne" | "sw" | "se";

type DragState = {
  pointerId: number;
  mode: Handle;
  startX: number;
  startY: number;
  startRect: DisplayRect;
};

interface TemplateImageCropModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  imageName: string;
  initialCrop: TemplateImageCropRect | null;
  onClose: () => void;
  onConfirm: (crop: TemplateImageCropRect) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRect(rect: DisplayRect, bounds: Size): DisplayRect {
  const width = clamp(rect.width, MIN_CROP_SIZE, bounds.width);
  const height = clamp(rect.height, MIN_CROP_SIZE, bounds.height);
  const x = clamp(rect.x, 0, Math.max(0, bounds.width - width));
  const y = clamp(rect.y, 0, Math.max(0, bounds.height - height));
  return { x, y, width, height };
}

function getResizedRect(handle: Exclude<Handle, "move">, startRect: DisplayRect, deltaX: number, deltaY: number, bounds: Size): DisplayRect {
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

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export default function TemplateImageCropModal({
  isOpen,
  imageSrc,
  imageName,
  initialCrop,
  onClose,
  onConfirm,
}: TemplateImageCropModalProps) {
  // Retain the last shown source/name so the card does not blank out during the
  // exit animation when the parent clears its crop target on close.
  const retainedRef = useRef({ imageSrc, imageName });
  if (isOpen) {
    retainedRef.current = { imageSrc, imageName };
  }
  const shownImageSrc = isOpen ? imageSrc : retainedRef.current.imageSrc;
  const shownImageName = isOpen ? imageName : retainedRef.current.imageName;

  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [naturalSize, setNaturalSize] = useState<Size>({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState<DisplayRect | null>(null);
  const [needsInitialCrop, setNeedsInitialCrop] = useState(true);

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
  }, [naturalSize, stageSize]);

  const measureStage = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setStageSize({ width: rect.width, height: rect.height });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const frame = requestAnimationFrame(measureStage);
    const resizeObserver = new ResizeObserver(measureStage);
    if (stageRef.current) resizeObserver.observe(stageRef.current);
    window.addEventListener("resize", measureStage);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureStage);
    };
  }, [isOpen, measureStage]);

  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets image measurement and crop state when the source image changes so it is re-measured
    setNaturalSize({ width: 0, height: 0 });
    setCropRect(null);
    setNeedsInitialCrop(true);
  }, [imageSrc, isOpen]);

  useEffect(() => {
    if (!imageDisplay || !needsInitialCrop) return;

    if (initialCrop && naturalSize.width > 0 && naturalSize.height > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- computes the initial crop rectangle from DOM-measured image display scale
      setCropRect({
        x: initialCrop.x / imageDisplay.scaleX,
        y: initialCrop.y / imageDisplay.scaleY,
        width: initialCrop.width / imageDisplay.scaleX,
        height: initialCrop.height / imageDisplay.scaleY,
      });
    } else {
      const width = Math.max(MIN_CROP_SIZE, imageDisplay.width * 0.72);
      const height = Math.max(MIN_CROP_SIZE, imageDisplay.height * 0.72);
      setCropRect({
        x: (imageDisplay.width - width) / 2,
        y: (imageDisplay.height - height) / 2,
        width,
        height,
      });
    }
    setNeedsInitialCrop(false);
  }, [imageDisplay, initialCrop, naturalSize, needsInitialCrop]);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
  }, []);

  const finishDrag = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
  }, []);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>, mode: Handle) => {
    if (!cropRect) return;
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
  }, [cropRect]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !imageDisplay) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const bounds = { width: imageDisplay.width, height: imageDisplay.height };

    setCropRect(() => {
      if (drag.mode === "move") {
        return normalizeRect({
          ...drag.startRect,
          x: drag.startRect.x + deltaX,
          y: drag.startRect.y + deltaY,
        }, bounds);
      }

      return normalizeRect(
        getResizedRect(drag.mode, drag.startRect, deltaX, deltaY, bounds),
        bounds,
      );
    });
  }, [imageDisplay]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishDrag(event.pointerId);
  }, [finishDrag]);

  const handleConfirm = useCallback(() => {
    if (!cropRect || !imageDisplay) return;

    onConfirm({
      x: Math.round(cropRect.x * imageDisplay.scaleX),
      y: Math.round(cropRect.y * imageDisplay.scaleY),
      width: Math.max(1, Math.round(cropRect.width * imageDisplay.scaleX)),
      height: Math.max(1, Math.round(cropRect.height * imageDisplay.scaleY)),
    });
  }, [cropRect, imageDisplay, onConfirm]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Crop Image"
      subtitle={`Adjust the visible crop for ${shownImageName || "this image"} without changing the original asset.`}
      closeIcon={<X size={18} />}
      size="4xl"
      className="rounded-xl border border-outline shadow-2xl overflow-hidden"
      bodyClassName={null}
      footer={
        <>
          <Button type="secondary" size="medium" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!cropRect}>
            Apply Crop
          </Button>
        </>
      }
    >
        <div className="px-5 py-5">
          <div
            ref={stageRef}
            className="relative overflow-hidden rounded-xl border border-outline"
            style={{ ...STAGE_BACKGROUND_STYLE, height: STAGE_HEIGHT }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {shownImageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imageRef}
                src={shownImageSrc}
                alt="Image crop preview"
                onLoad={handleImageLoad}
                className="absolute select-none"
                draggable={false}
                style={{
                  left: `${imageDisplay?.x ?? 0}px`,
                  top: `${imageDisplay?.y ?? 0}px`,
                  width: `${imageDisplay?.width ?? 0}px`,
                  height: `${imageDisplay?.height ?? 0}px`,
                }}
              />
            ) : null}

            {imageDisplay && cropRect ? (
              <>
                <div className="absolute bg-black/35" style={{ left: imageDisplay.x, top: imageDisplay.y, width: imageDisplay.width, height: cropRect.y }} />
                <div className="absolute bg-black/35" style={{ left: imageDisplay.x, top: imageDisplay.y + cropRect.y + cropRect.height, width: imageDisplay.width, height: imageDisplay.height - cropRect.y - cropRect.height }} />
                <div className="absolute bg-black/35" style={{ left: imageDisplay.x, top: imageDisplay.y + cropRect.y, width: cropRect.x, height: cropRect.height }} />
                <div className="absolute bg-black/35" style={{ left: imageDisplay.x + cropRect.x + cropRect.width, top: imageDisplay.y + cropRect.y, width: imageDisplay.width - cropRect.x - cropRect.width, height: cropRect.height }} />

                <div
                  className="absolute border-2 border-accent-control-ring shadow-[0_0_0_9999px_rgba(15,23,42,0.08)]"
                  style={{
                    left: `${imageDisplay.x + cropRect.x}px`,
                    top: `${imageDisplay.y + cropRect.y}px`,
                    width: `${cropRect.width}px`,
                    height: `${cropRect.height}px`,
                  }}
                  onPointerDown={(event) => startDrag(event, "move")}
                >
                  {[
                    { key: "nw", className: "-left-2 -top-2 cursor-nwse-resize" },
                    { key: "ne", className: "-right-2 -top-2 cursor-nesw-resize" },
                    { key: "sw", className: "-left-2 -bottom-2 cursor-nesw-resize" },
                    { key: "se", className: "-right-2 -bottom-2 cursor-nwse-resize" },
                  ].map((handle) => (
                    <button
                      key={handle.key}
                      type="button"
                      aria-label={`Resize crop ${handle.key}`}
                      onPointerDown={(event) => startDrag(event, handle.key as Exclude<Handle, "move">)}
                      className={`absolute h-4 w-4 rounded-full border-2 border-white bg-blue-500 shadow ${handle.className}`}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
    </Modal>
  );
}
