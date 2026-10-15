'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * How many page canvases may exist at once, across every PDF viewer.
 *
 * A mounted canvas holds a rasterised bitmap costing width x height x 4 bytes
 * whatever the page contains, so mounting one per page made browser memory grow
 * with page count however the bytes arrived: a 1,000-page document built 1,000
 * of them. Five is the page being read plus two either side, which covers a fast
 * scroll without drawing ahead of where anyone is looking.
 */
export const MAX_RENDERED_CANVASES = 5;

interface PdfPageWindowOptions {
  /** Pages in the document; 0 before it has been parsed. */
  numPages: number;
  /**
   * Reports the page most in view, for a page indicator. Called only when that
   * page changes, so a caller may pass one that dispatches.
   */
  onVisiblePageChange?: (page: number) => void;
  /**
   * Identity of the document being read. When it changes the window reopens at
   * page 1, because the page the reader had reached means nothing in a different
   * document. A url reminted over the SAME object must NOT change this, or a
   * routine signature refresh throws the reader back to the top.
   */
  documentKey?: unknown;
}

export interface PdfPageWindow {
  /** Lowest page number that may hold a canvas right now. */
  first: number;
  /** Highest page number that may hold a canvas right now; 0 before the document loads. */
  last: number;
  /** Whether this page's canvas should be mounted at this moment. */
  isDrawn: (pageNumber: number) => boolean;
  /** The page most in view. */
  visiblePage: number;
  /**
   * Ref callback for a page's box. Returns a cleanup, which React 19 calls when
   * the box detaches, so nothing outlives the page it belongs to.
   */
  observePage: (node: Element | null, pageNumber: number) => (() => void) | void;
}

/**
 * The bounded window of pages a PDF viewer may rasterise, shared by all of them.
 *
 * Every viewer in the app stacks the whole document and needs the same three
 * things: which page the reader is on, which handful of pages around it may hold
 * a canvas, and a way to drop a canvas once its page is behind them. Each viewer
 * had grown its own answer, and the answers had drifted: one kept a `Set` of
 * every page ever visited and rasterised all of them for the life of the
 * document, which defers the cost of a long document without bounding it.
 *
 * Only the pixels are windowed. The caller still lays out a measured box for
 * every page, so the scrollbar, the page numbers, the scroll position and any
 * overlay anchored to a page are unchanged whether that page is drawn or not.
 */
export function usePdfPageWindow({
  numPages,
  onVisiblePageChange,
  documentKey,
}: PdfPageWindowOptions): PdfPageWindow {
  const [visiblePage, setVisiblePage] = useState(1);

  // Held in a ref because callers pass an inline arrow: rebuilding the observer
  // on every render would disconnect and re-observe every page of the document.
  const reportRef = useRef(onVisiblePageChange);
  reportRef.current = onVisiblePageChange;

  const observerRef = useRef<IntersectionObserver | null>(null);
  /** Which page each observed box belongs to. */
  const slotPages = useRef(new Map<Element, number>());
  /**
   * How much of each page is on screen. Only pages that currently intersect are
   * kept: a map that also remembered the ones left behind would grow with the
   * document, which is the shape of leak this hook exists to remove.
   */
  const visibleRatios = useRef(new Map<number, number>());
  /** The page last handed to `onVisiblePageChange`, so it is told only of changes.
   *  Starts at 0, which is no page, so the first report is not swallowed. */
  const lastReported = useRef(0);

  // Adjusting state during render rather than in an effect, so a new document's
  // first frame already opens at page 1 instead of showing the previous
  // document's window for a frame first.
  const [openedKey, setOpenedKey] = useState(documentKey);
  if (openedKey !== documentKey) {
    setOpenedKey(documentKey);
    setVisiblePage(1);
    lastReported.current = 0;
    visibleRatios.current.clear();
  }

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const ratios = visibleRatios.current;
    const slots = slotPages.current;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = slots.get(entry.target);
          if (page == null) continue;
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            ratios.set(page, entry.intersectionRatio);
          } else {
            ratios.delete(page);
          }
        }

        // The page showing most of itself wins, and a tie goes to the lower page
        // number so the window is centred on what the reader has reached rather
        // than on whichever entry happened to fire last.
        let best = 0;
        let bestRatio = 0;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio || (ratio === bestRatio && page < best)) {
            best = page;
            bestRatio = ratio;
          }
        }
        if (!best || best === lastReported.current) return;
        lastReported.current = best;
        setVisiblePage(best);
        reportRef.current?.(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    observerRef.current = observer;
    // Boxes registered before this effect ran (a document that parsed in the
    // same commit as its mount) still have to be picked up.
    for (const node of slots.keys()) observer.observe(node);

    return () => {
      observer.disconnect();
      observerRef.current = null;
      ratios.clear();
    };
  }, []);

  const observePage = useCallback((node: Element | null, pageNumber: number) => {
    if (!node) return;
    slotPages.current.set(node, pageNumber);
    observerRef.current?.observe(node);
    return () => {
      observerRef.current?.unobserve(node);
      slotPages.current.delete(node);
      visibleRatios.current.delete(pageNumber);
    };
  }, []);

  const { first, last } = useMemo(() => {
    if (numPages <= 0) return { first: 1, last: 0 };
    const size = Math.min(MAX_RENDERED_CANVASES, numPages);
    const overscan = Math.floor(size / 2);
    const first_ = Math.max(1, Math.min(visiblePage - overscan, numPages - size + 1));
    return { first: first_, last: first_ + size - 1 };
  }, [visiblePage, numPages]);

  const isDrawn = useCallback(
    (pageNumber: number) => pageNumber >= first && pageNumber <= last,
    [first, last],
  );

  return { first, last, isDrawn, visiblePage, observePage };
}
