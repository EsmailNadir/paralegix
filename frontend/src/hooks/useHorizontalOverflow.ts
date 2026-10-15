'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks whether a horizontally scrolling strip has content hidden off either
 * end, and drives the controls that reach it.
 *
 * Strips here hide their scrollbar - an 8px bar is most of the height of a chip
 * row, and reserving it knocks the row's contents out of line with whatever
 * labels it - so overflow is invisible unless something says it is there. The
 * arrows and edge fades a caller draws from `overflow` are that something.
 *
 * Width changes are observed rather than passed in as dependencies, so a strip
 * re-measures when its content changes without the caller having to enumerate
 * everything that could change it.
 */
export default function useHorizontalOverflow<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft < maxScroll - 1 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();

    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);

    // The viewport's own size, and the content's, both decide whether anything
    // is hidden; a MutationObserver covers items being added or relabelled.
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [measure]);

  /** Page toward one end, by most of a viewport but never a trivial nudge. */
  const scrollStep = useCallback((direction: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  }, []);

  /** Map a vertical wheel onto the strip - most mice have no horizontal axis. */
  const onWheel = useCallback((event: React.WheelEvent) => {
    if (event.deltaY !== 0) ref.current?.scrollBy({ left: event.deltaY });
  }, []);

  return { ref, overflow, scrollStep, onWheel };
}
