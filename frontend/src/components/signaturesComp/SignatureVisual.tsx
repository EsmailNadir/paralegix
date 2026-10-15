'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SignatureStyle } from '@/types/signature';
import { resolveSignatureStyle } from '@/types/signature';
import { calculateSignatureLayout } from './signatureLayout';

interface SignatureVisualProps {
  style?: SignatureStyle;
  dataUrl?: string;
  placeholderText?: string;
}

function toAbsoluteStyle(rect: { x: number; y: number; width: number; height: number }): CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

export default function SignatureVisual({ style, dataUrl, placeholderText }: SignatureVisualProps) {
  const variant = resolveSignatureStyle(style);
  // A callback ref, not a plain useRef: the container only renders (and the
  // ref only attaches) in the 'x-line'/dataUrl branches below, so a field
  // that starts in the plain style and is switched to 'x-line' later gets its
  // ref attached well after mount. A mount-only effect would miss that and
  // never observe the node, leaving the line/X unlaid-out forever.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });
  const [imageAspectRatio, setImageAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!containerEl) return;

    const updateSize = () => {
      const rect = containerEl.getBoundingClientRect();
      setBoxSize({ width: rect.width, height: rect.height });
    };

    updateSize();

    const observer = new ResizeObserver(() => updateSize());
    observer.observe(containerEl);

    return () => observer.disconnect();
  }, [containerEl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the measured image aspect ratio so it is re-measured when the image source changes
    setImageAspectRatio(null);
  }, [dataUrl]);

  const layout = useMemo(() => {
    if (boxSize.width <= 0 || boxSize.height <= 0) return null;

    return calculateSignatureLayout({
      boxWidth: boxSize.width,
      boxHeight: boxSize.height,
      imageAspectRatio: imageAspectRatio ?? 3,
      style: variant,
    });
  }, [boxSize.height, boxSize.width, imageAspectRatio, variant]);

  if (variant === 'x-line') {
    return (
      <div ref={setContainerEl} className="relative w-full h-full pointer-events-none select-none">
        {layout?.line ? (
          <div
            className="absolute bg-black/80"
            style={{
              left: `${layout.line.x}px`,
              top: `${layout.line.y}px`,
              width: `${layout.line.width}px`,
              height: `${layout.line.thickness}px`,
            }}
          />
        ) : null}
        {layout?.xMark ? (
          <span
            className="absolute font-serif font-semibold leading-none text-black/85 select-none"
            style={{
              left: `${layout.xMark.x}px`,
              top: `${layout.xMark.y}px`,
              fontSize: `${layout.xMark.fontSize}px`,
            }}
          >
            X
          </span>
        ) : null}
        <div className="absolute inset-0">
          {dataUrl && layout ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={dataUrl}
              alt="Signature"
              className="absolute object-contain"
              style={toAbsoluteStyle(layout.imageRect)}
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setImageAspectRatio(img.naturalWidth / img.naturalHeight);
                }
              }}
              draggable={false}
            />
          ) : placeholderText ? (
            <span className="absolute inset-x-2 top-[12%] text-center text-[10px] font-medium text-black/65">
              {placeholderText}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (dataUrl) {
    return (
      <div ref={setContainerEl} className="relative w-full h-full pointer-events-none select-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dataUrl}
          alt="Signature"
          className="absolute object-contain"
          style={layout ? toAbsoluteStyle(layout.imageRect) : undefined}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setImageAspectRatio(img.naturalWidth / img.naturalHeight);
            }
          }}
          draggable={false}
        />
      </div>
    );
  }

  if (placeholderText) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-medium text-current">{placeholderText}</span>
      </div>
    );
  }

  return null;
}
