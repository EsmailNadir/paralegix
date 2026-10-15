"use client";

import { useCallback, useRef, useState } from "react";
import type { PlacementDraft, RepeaterDraft } from "./templateOverlayTypes";

export interface LayoutSnapshot {
  placements: PlacementDraft[];
  repeaters: RepeaterDraft[];
}

/** Deeper than anyone will step back through in one sitting, and shallow
 *  enough that a long session never holds hundreds of copies of the layout. */
const MAX_DEPTH = 100;

/** Two checkpoints with the same key inside this window collapse into one:
 *  a run of arrow-key nudges, or the color picker firing on every pixel of
 *  a drag, reads as one edit and should undo as one. */
const COALESCE_MS = 800;

/**
 * Undo and redo for the overlay canvas: box adds, moves, resizes, deletes,
 * style changes and repeater settings. Typing inside a text box is left to
 * the browser's own undo, since the contentEditable owns that history and
 * fighting it would revert the box under the caret.
 *
 * The caller takes a checkpoint BEFORE applying a change, and hands back the
 * current layout on every render so a checkpoint always copies what is on
 * screen. Restoring goes through the caller too, because placements live in
 * a reducer and repeaters in their own state, and both have to change in one
 * step for the canvas to stay consistent.
 */
export function useOverlayLayoutHistory(current: LayoutSnapshot, restore: (snapshot: LayoutSnapshot) => void) {
  const pastRef = useRef<LayoutSnapshot[]>([]);
  const futureRef = useRef<LayoutSnapshot[]>([]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const lastRef = useRef<{ key: string; at: number } | null>(null);
  // Bumped on every stack change so the toolbar's disabled state re-renders.
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const checkpoint = useCallback((coalesceKey?: string) => {
    const now = Date.now();
    if (coalesceKey && lastRef.current?.key === coalesceKey && now - lastRef.current.at < COALESCE_MS) {
      lastRef.current = { key: coalesceKey, at: now };
      return;
    }
    lastRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    pastRef.current.push(currentRef.current);
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    futureRef.current = [];
    bump();
  }, []);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.push(currentRef.current);
    lastRef.current = null;
    restore(previous);
    bump();
  }, [restore]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(currentRef.current);
    lastRef.current = null;
    restore(next);
    bump();
  }, [restore]);

  /** Forgets everything: the layout was just loaded or saved, and stepping
   *  back past that point would undo into a state the server never held. */
  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastRef.current = null;
    bump();
  }, []);

  return {
    checkpoint,
    undo,
    redo,
    reset,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
