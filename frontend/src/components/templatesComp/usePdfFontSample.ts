"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { pageFromPoint } from "@/components/signaturesComp/pdfPointerPage";
import {
  readPageTextRuns,
  runsAtPoint,
  runsUnderBoxes,
  summarizeRuns,
  type FontSample,
  type PercentBox,
  type PdfTextRun,
} from "@/lib/pdfFontSampling";

export type PdfFontSampleState = {
  /** The font behind the current selection, with every property the selection
   *  disagrees on left null. Null when nothing is selected. */
  sample: FontSample | null;
  /** The page the selection landed on, so only that page draws highlights. */
  page: number | null;
  /** The boxes of the runs the readout is describing. */
  highlights: PercentBox[];
  /** Pass to `PDFPageViewer`'s `onDocumentProxy`. */
  setDocument: (pdf: PDFDocumentProxy) => void;
};

const NO_HIGHLIGHTS: PercentBox[] = [];

/** How long an incomplete read (a page whose fonts pdf.js had not loaded yet)
 *  is reused before the page is read again. Long enough that a selection drag
 *  does not re-walk the page every frame, short enough that the readout
 *  corrects itself as soon as the reader pauses. */
const INCOMPLETE_CACHE_MS = 1500;

type CachedRuns = { runs: PdfTextRun[]; complete: boolean; readAt: number };

/**
 * The font under the reader's text selection, or under a click, in a
 * `PDFPageViewer`.
 *
 * Works entirely in geometry: the selection's client rectangles (or the
 * clicked point) are converted to page percentages and intersected against
 * the page's text runs. Pairing the text-layer spans to pdf.js items by DOM
 * order would be shorter, but pdf.js decides per release which items get a
 * span and where line-break elements go, so that pairing silently drifts by
 * one on an upgrade. Geometry does not.
 *
 * `enabled` should be false whenever the viewer's text layer is off. Nothing
 * new can be sampled then, but the last readout is kept: the reader samples
 * a line in Select mode precisely so they can draw a matching box in Field
 * mode next, and the highlight left on the page says what the readout is
 * still describing. The next sample, or a click on blank page, replaces it.
 */
export function usePdfFontSample(enabled: boolean): PdfFontSampleState {
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const runsRef = useRef(new Map<number, CachedRuns>());
  const requestRef = useRef(0);
  const [sample, setSample] = useState<FontSample | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [highlights, setHighlights] = useState<PercentBox[]>(NO_HIGHLIGHTS);

  const setDocument = useCallback((pdf: PDFDocumentProxy) => {
    documentRef.current = pdf;
    // The cache is keyed by page number, which the next document starts over
    // from 1, so it cannot survive a new document.
    runsRef.current = new Map();
  }, []);

  const clear = useCallback(() => {
    setSample(null);
    setPage(null);
    setHighlights(NO_HIGHLIGHTS);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const runsForPage = async (pageNumber: number): Promise<PdfTextRun[]> => {
      const cached = runsRef.current.get(pageNumber);
      if (cached && (cached.complete || Date.now() - cached.readAt < INCOMPLETE_CACHE_MS)) {
        return cached.runs;
      }
      const pdf = documentRef.current;
      if (!pdf) return [];
      let runs: PdfTextRun[];
      try {
        runs = await readPageTextRuns(await pdf.getPage(pageNumber));
      } catch {
        // A page that will not give up its text (a broken embedded font, or a
        // worker that went away with the document) has nothing to sample. It
        // is cached as empty so the failure is not retried on every tick.
        runs = [];
      }
      // A run read before pdf.js registered its font carries the generic
      // fallback family. That is still the best available answer right now,
      // but not one worth keeping: the page is read again once it has painted.
      runsRef.current.set(pageNumber, {
        runs,
        complete: runs.every((run) => run.faceKnown),
        readAt: Date.now(),
      });
      return runs;
    };

    const publish = (pageNumber: number, covered: PdfTextRun[]) => {
      const next = summarizeRuns(covered);
      if (!next) {
        clear();
        return;
      }
      setSample(next);
      setPage(pageNumber);
      setHighlights(covered.map((run) => ({
        xPercent: run.xPercent,
        yPercent: run.yPercent,
        widthPercent: run.widthPercent,
        heightPercent: run.heightPercent,
      })));
    };

    const readSelection = async () => {
      // Every pass claims a token. A pass that has to wait for a page's text
      // checks it again afterwards and drops its result if the selection has
      // moved on in the meantime.
      const token = ++requestRef.current;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      // Text selected inside a placed box (a text box being typed into) is the
      // reader's own words, not the document's. Sampling the PDF text that
      // happens to sit underneath would describe a font nobody selected.
      const anchor = selection.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      if (anchorElement?.closest("[data-annotation]")) return;

      const rects = Array.from(selection.getRangeAt(0).getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) return;

      // A selection that runs across a page break is sampled on the page it
      // started on. Reporting one page of a two-page selection is wrong, but a
      // selection that long is mixed in practice, so the readout blanks anyway.
      const first = rects[0];
      const hit = pageFromPoint(first.left + first.width / 2, first.top + first.height / 2);
      if (!hit) return;

      const runs = await runsForPage(hit.pageNumber);
      if (token !== requestRef.current) return;

      const pageRect = hit.element.getBoundingClientRect();
      const boxes: PercentBox[] = rects
        .filter((rect) => rect.top < pageRect.bottom && rect.bottom > pageRect.top)
        .map((rect) => ({
          xPercent: ((rect.left - pageRect.left) / pageRect.width) * 100,
          yPercent: ((rect.top - pageRect.top) / pageRect.height) * 100,
          widthPercent: (rect.width / pageRect.width) * 100,
          heightPercent: (rect.height / pageRect.height) * 100,
        }));

      publish(hit.pageNumber, runsUnderBoxes(runs, boxes));
    };

    const readClick = async (clientX: number, clientY: number) => {
      const token = ++requestRef.current;
      const hit = pageFromPoint(clientX, clientY);
      if (!hit) return;

      const runs = await runsForPage(hit.pageNumber);
      if (token !== requestRef.current) return;

      const pageRect = hit.element.getBoundingClientRect();
      const point = {
        xPercent: ((clientX - pageRect.left) / pageRect.width) * 100,
        yPercent: ((clientY - pageRect.top) / pageRect.height) * 100,
      };
      // A click on blank page is the reader dismissing the readout; a click
      // on a line replaces it with that line's font.
      publish(hit.pageNumber, runsAtPoint(runs, point));
    };

    // `selectionchange` fires on every pointer move of a drag. Coalescing to one
    // pass per frame keeps a drag across a dense page from re-rendering the
    // editor and all of its placements dozens of times a second. It is also why
    // the pass below is scheduled rather than run inline: an effect that sets
    // state synchronously cascades a second render on every mode change.
    let frame = 0;
    const scheduleSelection = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void readSelection();
      });
    };

    // A click samples the line under the pointer. It is read on pointerup,
    // once the browser has settled whether the gesture selected anything: a
    // drag that did leaves a selection, which the selection pass above owns.
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-pdf-page]") || target.closest("[data-annotation]")) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) return;
      void readClick(event.clientX, event.clientY);
    };

    document.addEventListener("selectionchange", scheduleSelection);
    document.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.removeEventListener("selectionchange", scheduleSelection);
      document.removeEventListener("pointerup", handlePointerUp);
      if (frame) cancelAnimationFrame(frame);
      // Anything still waiting on a page belongs to a listener that is gone.
      requestRef.current += 1;
    };
  }, [enabled, clear]);

  return { sample, page, highlights, setDocument };
}
