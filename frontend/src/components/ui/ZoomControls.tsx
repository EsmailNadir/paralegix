'use client';

import { Minus, Plus } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import { MAX_ZOOM, MIN_ZOOM } from '@/hooks/useDocumentZoom';

interface ZoomControlsProps {
  /** Current zoom as a percentage (100 = fit width). */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  className?: string;
}

/**
 * The minus / percentage / plus control every document surface shows, paired
 * with `useDocumentZoom` so the buttons and the pinch/wheel/keyboard gestures
 * drive the same zoom.
 */
export default function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  className = '',
}: ZoomControlsProps) {
  // Roomier hit areas on phones, where a 14px icon in desktop padding is well
  // under a comfortable touch target.
  const buttonCls =
    'p-2.5 sm:p-1.5 rounded hover:bg-surface-hover text-on-surface-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer';

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <Tooltip title="Zoom out" enterDelay={300}>
        <span>
          <button
            type="button"
            onClick={onZoomOut}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className={buttonCls}
          >
            <Minus size={14} />
          </button>
        </span>
      </Tooltip>
      <Tooltip title="Reset zoom" enterDelay={300}>
        <button
          type="button"
          onClick={onReset}
          aria-label="Reset zoom"
          className="px-2 py-2 sm:py-1 rounded hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 min-w-[3.5rem] text-center cursor-pointer"
        >
          <span className="text-xs font-medium text-on-surface">{Math.round(zoom)}%</span>
        </button>
      </Tooltip>
      <Tooltip title="Zoom in" enterDelay={300}>
        <span>
          <button
            type="button"
            onClick={onZoomIn}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className={buttonCls}
          >
            <Plus size={14} />
          </button>
        </span>
      </Tooltip>
    </div>
  );
}
