'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

export const MIN_ZOOM = 25;
export const MAX_ZOOM = 500;
export const ZOOM_STEP = 25;

const clamp = (zoom: number) => Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)));

interface UseDocumentZoomOptions {
  /** Listeners bind only while the surface is on screen. */
  enabled?: boolean;
}

/**
 * Zoom state for a document surface, plus the three gestures every one of them
 * answers to: pinch on a touch screen, Ctrl/Cmd + wheel (which is also what a
 * trackpad pinch reports), and Ctrl/Cmd with `+`, `-` or `0`.
 *
 * Spread `zoomAreaProps` onto the scrollable element that holds the document.
 * The wheel and touch listeners are attached to that element natively rather
 * than through React props, because React registers both as passive at the
 * root, where `preventDefault` cannot stop the browser from zooming the whole
 * page instead of the document.
 */
export function useDocumentZoom({ enabled = true }: UseDocumentZoomOptions = {}) {
  const [zoom, setZoom] = useState(100);
  const [area, setArea] = useState<HTMLElement | null>(null);

  const zoomIn = useCallback(() => setZoom((z) => clamp(z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => clamp(z - ZOOM_STEP)), []);
  const resetZoom = useCallback(() => setZoom(100), []);

  useEffect(() => {
    if (!enabled || !area) return;

    // Distance between the two fingers at the last pinch sample; null whenever
    // fewer than two fingers are down.
    let pinchSpread: number | null = null;

    const spread = (touches: TouchList) =>
      Math.hypot(
        touches[1].clientX - touches[0].clientX,
        touches[1].clientY - touches[0].clientY,
      );

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Exponential, so a trackpad's stream of small deltas accumulates smoothly
      // while a mouse wheel's single large delta still lands a visible step.
      setZoom((z) => clamp(z * Math.exp(-e.deltaY / 300)));
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinchSpread = spread(e.touches);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchSpread === null) return;
      e.preventDefault();
      const next = spread(e.touches);
      if (pinchSpread > 0) {
        const ratio = next / pinchSpread;
        setZoom((z) => clamp(z * ratio));
      }
      pinchSpread = next;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchSpread = null;
    };

    // Safari drives pinch through its own non-standard gesture events as well as
    // touch events, and will zoom the whole page from them even where touch-action
    // and a cancelled touchmove would otherwise have stopped it.
    const onGesture = (e: Event) => e.preventDefault();

    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('touchstart', onTouchStart, { passive: false });
    area.addEventListener('touchmove', onTouchMove, { passive: false });
    area.addEventListener('touchend', onTouchEnd);
    area.addEventListener('touchcancel', onTouchEnd);
    area.addEventListener('gesturestart', onGesture, { passive: false });
    area.addEventListener('gesturechange', onGesture, { passive: false });

    return () => {
      area.removeEventListener('wheel', onWheel);
      area.removeEventListener('touchstart', onTouchStart);
      area.removeEventListener('touchmove', onTouchMove);
      area.removeEventListener('touchend', onTouchEnd);
      area.removeEventListener('touchcancel', onTouchEnd);
      area.removeEventListener('gesturestart', onGesture);
      area.removeEventListener('gesturechange', onGesture);
    };
  }, [enabled, area]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, zoomIn, zoomOut, resetZoom]);

  const areaRef = useCallback((el: HTMLElement | null) => setArea(el), []);

  const zoomAreaProps = useMemo(
    () => ({
      ref: areaRef,
      // Stops the browser from claiming a two-finger gesture as its own page
      // zoom; one-finger panning still scrolls the document.
      style: { touchAction: 'pan-x pan-y' } as const,
    }),
    [areaRef],
  );

  return { zoom, setZoom, zoomIn, zoomOut, resetZoom, zoomAreaProps };
}

/**
 * The zoom a PDF canvas should be *rendered* at, trailing the live zoom until
 * the gesture driving it stops.
 *
 * react-pdf keys its canvas on the render scale, so any change to a page's
 * rendered width tears the old canvas down and mounts an unsized one in its
 * place for a frame or two. Re-rendering once a gesture settles instead of once
 * per wheel tick is the difference between a single crisp re-render and a
 * strobe. Callers cover the gap by CSS-scaling what is already on screen from
 * this zoom to the live one.
 */
export function useSettledZoom(zoom: number, delay = 180) {
  const [settled, setSettled] = useState(zoom);

  useEffect(() => {
    if (zoom === settled) return;
    const timer = setTimeout(() => setSettled(zoom), delay);
    return () => clearTimeout(timer);
  }, [zoom, settled, delay]);

  return settled;
}

export default useDocumentZoom;
