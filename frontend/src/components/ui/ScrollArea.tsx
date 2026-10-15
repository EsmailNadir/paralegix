'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { startPointerDrag } from '@/lib/utils/pointerDrag';

/** Shortest a thumb may get, so a very long document still leaves something to grab. */
const MIN_THUMB = 28;

/**
 * Custom scrollbars exist because a platform drawing overlay scrollbars fades
 * them out and no CSS can hold them open. That only matters where scrolling is
 * pointer-driven: a touch screen scrolls by dragging the content itself and has
 * no use for a thumb, so it keeps its own native bars.
 */
const POINTER_QUERY = '(hover: hover) and (pointer: fine)';

const subscribeToPointer = (onChange: () => void) => {
  const query = window.matchMedia(POINTER_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

// Read through useSyncExternalStore rather than an effect, so the first client
// render already knows the answer and the server render doesn't guess.
const usePointerScrolling = () =>
  useSyncExternalStore(
    subscribeToPointer,
    () => window.matchMedia(POINTER_QUERY).matches,
    () => false,
  );

interface ScrollAreaProps {
  children: React.ReactNode;
  /** Classes for the outer box: layout, background, borders. */
  className?: string;
  /** Classes for the scrolling viewport. Padding belongs here, not on the box. */
  viewportClassName?: string;
  /**
   * Spread onto the viewport, for callers that need to reach the element that
   * actually scrolls - `useDocumentZoom`'s `zoomAreaProps`, for instance.
   */
  viewportProps?: {
    ref?: (el: HTMLElement | null) => void;
    style?: React.CSSProperties;
  };
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}

/**
 * A scrollable region whose scrollbars are always visible, drawn by this
 * component rather than the platform.
 *
 * The native bars are hidden while ours are shown, so the two never appear
 * together. Ours overlay the content instead of reserving a gutter, which keeps
 * them from changing the width the content is laid out against - the thing that
 * made zooming a document jump.
 */
export default function ScrollArea({
  children,
  className = '',
  viewportClassName = '',
  viewportProps,
  onClick,
  onPointerDown,
}: ScrollAreaProps) {
  const showBars = usePointerScrolling();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const verticalThumb = useRef<HTMLDivElement | null>(null);
  const horizontalThumb = useRef<HTMLDivElement | null>(null);
  const verticalTrack = useRef<HTMLDivElement | null>(null);
  const horizontalTrack = useRef<HTMLDivElement | null>(null);

  const externalRef = viewportProps?.ref;
  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      externalRef?.(el);
    },
    [externalRef],
  );

  // Thumb geometry is written straight to the DOM: a scroll event per frame that
  // re-rendered a document viewer through React would be far more work than
  // moving two elements.
  const sync = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;

    const place = (
      thumb: HTMLDivElement | null,
      track: HTMLDivElement | null,
      viewport: number,
      content: number,
      position: number,
      vertical: boolean,
    ) => {
      if (!thumb) return;
      const scrollable = content - viewport > 1;
      thumb.style.opacity = scrollable ? '1' : '0';
      if (track) {
        track.style.opacity = scrollable ? '1' : '0';
        track.style.pointerEvents = scrollable ? 'auto' : 'none';
      }
      if (!scrollable) return;

      const size = Math.max(MIN_THUMB, (viewport / content) * viewport);
      const travel = viewport - size;
      const distance = content - viewport;
      const offset = distance > 0 ? (position / distance) * travel : 0;

      if (vertical) {
        thumb.style.height = `${size}px`;
        thumb.style.transform = `translateY(${offset}px)`;
      } else {
        thumb.style.width = `${size}px`;
        thumb.style.transform = `translateX(${offset}px)`;
      }
    };

    place(verticalThumb.current, verticalTrack.current, el.clientHeight, el.scrollHeight, el.scrollTop, true);
    place(horizontalThumb.current, horizontalTrack.current, el.clientWidth, el.scrollWidth, el.scrollLeft, false);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!showBars || !el) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    schedule();
    el.addEventListener('scroll', schedule, { passive: true });

    const resize = new ResizeObserver(schedule);
    resize.observe(el);

    // The content can change size while the viewport doesn't - a zoom landing, a
    // PDF page finishing its render - and neither shows up as a scroll or a
    // resize of the viewport itself.
    const mutations = new MutationObserver(schedule);
    mutations.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'width', 'height'],
    });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [showBars, sync]);

  const dragThumb = useCallback((e: React.PointerEvent, vertical: boolean) => {
    const el = viewportRef.current;
    if (!el || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();

    const start = vertical ? e.clientY : e.clientX;
    const startScroll = vertical ? el.scrollTop : el.scrollLeft;
    const viewport = vertical ? el.clientHeight : el.clientWidth;
    const content = vertical ? el.scrollHeight : el.scrollWidth;
    const travel = viewport - Math.max(MIN_THUMB, (viewport / content) * viewport);
    const distance = content - viewport;

    startPointerDrag(e, {
      onMove: (move) => {
        if (travel <= 0) return;
        const moved = (vertical ? move.clientY : move.clientX) - start;
        const next = startScroll + (moved / travel) * distance;
        if (vertical) el.scrollTop = next;
        else el.scrollLeft = next;
      },
    });
  }, []);

  // Pressing the track jumps a screenful towards the press, the way a native
  // scrollbar does. Presses on the thumb never reach here - it stops them.
  const pageTowards = useCallback((e: React.PointerEvent, vertical: boolean) => {
    const el = viewportRef.current;
    if (!el) return;

    const track = e.currentTarget.getBoundingClientRect();
    const pressed = vertical ? e.clientY - track.top : e.clientX - track.left;
    const viewport = vertical ? el.clientHeight : el.clientWidth;
    const content = vertical ? el.scrollHeight : el.scrollWidth;
    const position = vertical ? el.scrollTop : el.scrollLeft;

    const size = Math.max(MIN_THUMB, (viewport / content) * viewport);
    const distance = content - viewport;
    const thumbStart = distance > 0 ? (position / distance) * (viewport - size) : 0;

    const step = viewport * 0.9 * (pressed < thumbStart ? -1 : 1);
    el.scrollTo({
      [vertical ? 'top' : 'left']: position + step,
      behavior: 'smooth',
    });
  }, []);

  const trackCls = 'absolute z-20 rounded-full bg-black/[0.04] dark:bg-white/[0.06]';
  // Coloured from the same tokens as the native scrollbars this replaces.
  const thumbCls =
    'absolute rounded-full bg-[var(--scrollbar-thumb)] hover:bg-[var(--scrollbar-thumb-hover)] transition-colors';

  return (
    <div className={`relative ${className}`}>
      <div
        {...viewportProps}
        ref={setViewport}
        onClick={onClick}
        onPointerDown={onPointerDown}
        className={`h-full w-full overflow-auto ${
          showBars ? 'scrollbar-hide' : 'styled-scrollbar'
        } ${viewportClassName}`}
      >
        {children}
      </div>

      {showBars && (
        <>
          <div
            ref={verticalTrack}
            aria-hidden
            className={`${trackCls} top-0 right-0 bottom-0 w-2.5 transition-opacity duration-150`}
            style={{ opacity: 0, pointerEvents: 'none' }}
            onPointerDown={(e) => pageTowards(e, true)}
          >
            <div
              ref={verticalThumb}
              className={`${thumbCls} left-[2px] right-[2px] top-0 touch-none cursor-default transition-opacity duration-150`}
              style={{ opacity: 0 }}
              onPointerDown={(e) => dragThumb(e, true)}
            />
          </div>

          <div
            ref={horizontalTrack}
            aria-hidden
            className={`${trackCls} bottom-0 left-0 right-2.5 h-2.5 transition-opacity duration-150`}
            style={{ opacity: 0, pointerEvents: 'none' }}
            onPointerDown={(e) => pageTowards(e, false)}
          >
            <div
              ref={horizontalThumb}
              className={`${thumbCls} top-[2px] bottom-[2px] left-0 touch-none cursor-default transition-opacity duration-150`}
              style={{ opacity: 0 }}
              onPointerDown={(e) => dragThumb(e, false)}
            />
          </div>
        </>
      )}
    </div>
  );
}
